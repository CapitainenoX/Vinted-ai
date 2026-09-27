// Vinted AI — service worker: message router, agent loop, listing pipeline.

import * as store from './lib/storage.js';
import { chatCompletion, listModels, parseJson } from './lib/llm.js';
import { agentSystemPrompt, listingPrompt, auditPrompt, messagesPrompt } from './lib/prompts.js';
import { TOOL_DEFS, runTool, searchVinted, analyzePhotos, askTab } from './lib/tools.js';

const MAX_STEPS = 8;
const TOOL_RESULT_CHARS = 4000; // latest tool results
const OLD_TOOL_CHARS = 1200; // earlier tool results in the same turn (free tiers count every token again at each step)
const HISTORY_MESSAGES = 10; // past messages sent to the model
const TOOL_TIMEOUT_MS = { analyze_photos: 90000, default: 30000 };

// ---------- one-shot messages ----------
const handlers = {
  'settings:get': () => store.getSettings(),
  'settings:save': ({ patch }) => store.saveSettings(patch),
  'models:list': async () => listModels(await store.getSettings()),
  'llm:test': async () => {
    const s = await store.getSettings();
    const { message } = await chatCompletion(s, { model: s.chatModel, messages: [{ role: 'user', content: 'Réponds juste "OK".' }], maxTokens: 20 });
    return { reply: message.content };
  },

  'library:list': () => store.listItems(),
  'library:get': ({ ref }) => store.getItem(ref),
  'library:create': ({ data }) => store.createItem(data),
  'library:update': ({ ref, patch }) => store.updateItem(ref, patch),
  'library:delete': ({ ref }) => store.deleteItem(ref),
  // Returns { conflict } instead of throwing so the UI can offer a swap.
  'library:setNumber': async ({ ref, number, swap }) => {
    try {
      return await store.setItemNumber(ref, number, { swap });
    } catch (e) {
      if (e.code === 'SKU_TAKEN') return { conflict: e.holder, message: e.message };
      throw e;
    }
  },
  'library:nextNumber': async () => store.formatSku(store.nextFreeNumber(await store.listItems(), (await store.getSettings()).skuReuseSold)),
  // Vinted form saved/published: update the matching library item (same capture, relisted item, or vintedId), else create one.
  // Seller-owned fields (notes, cost, location, status once sold) are never overwritten.
  'library:captureForm': async ({ data, itemId }) => {
    const items = await store.listItems();
    const existing = items.find((i) => i.id === itemId) || (data.vintedId && items.find((i) => String(i.vintedId) === String(data.vintedId))) || null;
    if (existing) {
      const patch = { ...data };
      if (existing.status === 'sold' || existing.status === 'archived') delete patch.status;
      if (!patch.photos?.length) delete patch.photos;
      return { item: await store.updateItem(existing.id, patch), created: false };
    }
    return { item: await store.createItem(data), created: true };
  },
  'library:export': () => store.exportAll(),
  'library:import': ({ data }) => store.importAll(data),
  'library:stats': async () => store.computeStats(await store.statsItems(), (await store.getSettings()).feePercent),
  'backup:info': () => store.backupInfo(),
  // Map of vintedId -> { sku, id, status, notes } for badge injection on Vinted pages.
  'library:index': async () => {
    const index = {};
    for (const i of await store.listItems()) if (i.vintedId) index[i.vintedId] = { sku: i.sku, id: i.id, status: i.status, notes: i.notes || '' };
    return index;
  },

  'chat:get': ({ id }) => store.getChat(id),
  'chat:clear': ({ id }) => store.saveChat(id, []),

  'messages:suggest': (msg) => suggestMessages(msg),
  'listing:generate': (msg, sender) => generateListing(msg, sender.tab?.id),
  'listing:audit': (msg, sender) => auditListing(msg, sender.tab?.id),
  'photos:fetch': ({ urls }) => Promise.all(urls.map(fetchAsDataUrl)),

  'pendingFill:take': async () => {
    const { pendingFill } = await chrome.storage.local.get('pendingFill');
    if (!pendingFill || Date.now() - pendingFill.at > 10 * 60 * 1000) return null;
    await chrome.storage.local.remove('pendingFill');
    return store.getItem(pendingFill.itemId);
  },
  'relist': async ({ ref }) => runTool('relist_item', { ref }, { settings: await store.getSettings(), emit() {} }),
  'dashboard:open': ({ hash = '' }) => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') + hash }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true; // async response
});

// DuckDuckGo rejects requests carrying `Origin: chrome-extension://…` (403). Strip it for the worker's own requests.
// Session rules survive worker restarts but not a browser restart, so (re)install them on every worker start.
chrome.declarativeNetRequest
  ?.updateSessionRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        condition: { requestDomains: ['html.duckduckgo.com', 'lite.duckduckgo.com'], tabIds: [-1], resourceTypes: ['xmlhttprequest'] },
      },
    ],
  })
  .catch((e) => console.warn('DNR rule failed', e));

// Library safety net: mirror to chrome.storage.sync (debounced), restore it if local data is ever empty.
let backupTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.library || changes.salesArchive)) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => store.backupToSync().catch((e) => console.warn('backup', e)), 3000);
});
store.restoreFromSyncIfEmpty().then(() => store.migrateSoldSkus()).catch(() => {});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#settings') });
});

// ---------- agent chat (long-lived port keeps the worker alive while it thinks) ----------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'chat') return;
  let controller = null;
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'stop') return controller?.abort();
    if (msg.type !== 'send') return;
    controller?.abort(); // a new message replaces a run still going
    controller = new AbortController();
    // MV3 stops an idle worker after ~30 s: an extension API call every 20 s keeps it alive during long LLM waits.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    const emit = (e) => {
      try {
        port.postMessage(e);
      } catch {}
    };
    try {
      await runAgent(msg, { tabId: port.sender?.tab?.id ?? null, emit, signal: controller.signal });
    } catch (e) {
      emit({ type: 'error', error: e.name === 'AbortError' ? 'Arrêté.' : e.message });
    } finally {
      clearInterval(keepAlive);
      emit({ type: 'done' });
    }
  });
  port.onDisconnect.addListener(() => controller?.abort());
});

async function runAgent({ chatId, text, images = [], pageContext }, { tabId, emit, signal }) {
  const settings = await store.getSettings();
  // Keep the cards (listing / edits / price) with the answer so they survive a panel reload.
  const cards = [];
  const ctx = { settings, tabId, emit: (e) => (e.type === 'card' && cards.push(e.card), emit(e)) };
  const history = await store.getChat(chatId);
  const status = (t) => emit({ type: 'status', text: t });

  let userContent = text;
  if (images.length) {
    emit({ type: 'tool', name: 'analyze_photos', args: { photos: images.length } });
    try {
      const vision = await withTimeout(analyzePhotos(ctx, null, images), TOOL_TIMEOUT_MS.analyze_photos, 'analyze_photos');
      emit({ type: 'tool_result', name: 'analyze_photos', summary: summarize('analyze_photos', vision) });
      userContent += `\n\n[Analyse des ${images.length} photo(s) jointe(s)]\n${JSON.stringify(vision)}`;
    } catch (e) {
      emit({ type: 'tool_result', name: 'analyze_photos', summary: '⚠ ' + e.message, error: true });
      userContent += `\n\n[${images.length} photo(s) jointe(s), analyse impossible : ${e.message}]`;
    }
  }

  const messages = [
    { role: 'system', content: agentSystemPrompt(settings, { page: pageContext }) },
    ...history.slice(-HISTORY_MESSAGES).map(({ role, content }) => ({ role, content: String(content || '').slice(0, 2500) })),
    { role: 'user', content: userContent },
  ];
  history.push({ role: 'user', content: userContent, display: text, images: images.length });

  const llm = (opts) => chatCompletion(settings, { model: settings.chatModel, messages, signal, temperature: 0.4, maxTokens: 1500, onRetry: status, ...opts });
  const finish = async (answer) => {
    history.push({ role: 'assistant', content: answer, ...(cards.length ? { cards } : {}) });
    await store.saveChat(chatId, history);
    emit({ type: 'final', text: answer });
  };
  // Last word without tools: always end on a real answer built from what the tools returned.
  const forceAnswer = async (why) => {
    status('Rédaction de la réponse…');
    messages.push({ role: 'user', content: `${why} Réponds maintenant au vendeur avec les informations déjà obtenues, sans appeler d'outil.` });
    const { message } = await llm({});
    return message.content?.trim() || "Je n'ai pas réussi à formuler de réponse. Reformule ta demande ou démarre une nouvelle conversation.";
  };

  const seen = new Map(); // identical tool calls in one turn → reuse the first result (stops loops)
  for (let step = 0; step < MAX_STEPS; step++) {
    let message;
    try {
      ({ message } = await llm({ tools: TOOL_DEFS }));
    } catch (e) {
      if (e.code !== 'TOO_LARGE') throw e;
      // Too much context: keep the system prompt + this turn only, with short tool results, and try once more.
      status('Conversation trop longue : je résume et je réessaie…');
      const start = messages.findLastIndex((m) => m.role === 'user' && m.content === userContent);
      messages.splice(1, Math.max(0, start - 1));
      shrinkToolResults(messages, 0, 600);
      ({ message } = await llm({ tools: TOOL_DEFS }));
    }
    const calls = message.tool_calls || [];
    messages.push({ role: 'assistant', content: message.content || '', ...(calls.length ? { tool_calls: calls } : {}) });

    if (!calls.length) {
      const answer = message.content?.trim();
      return finish(answer || (await forceAnswer('Ta dernière réponse était vide.')));
    }
    if (message.content) emit({ type: 'thinking', text: message.content });

    shrinkToolResults(messages, messages.length - 1, OLD_TOOL_CHARS);
    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}') || {};
      } catch {}
      emit({ type: 'tool', name, args });
      const key = name + JSON.stringify(args);
      let result;
      try {
        if (seen.has(key)) {
          result = { note: 'Outil déjà appelé avec ces arguments : utilise le résultat précédent, ne le rappelle pas.' };
          emit({ type: 'tool_result', name, summary: 'déjà fait' });
        } else {
          result = await withTimeout(runTool(name, args, ctx), TOOL_TIMEOUT_MS[name] || TOOL_TIMEOUT_MS.default, name);
          seen.set(key, true);
          emit({ type: 'tool_result', name, summary: summarize(name, result) });
        }
      } catch (e) {
        if (signal.aborted) throw e;
        result = { error: e.message };
        emit({ type: 'tool_result', name, summary: '⚠ ' + e.message, error: true });
      }
      let content = JSON.stringify(result) ?? 'null';
      if (content.length > TOOL_RESULT_CHARS) content = content.slice(0, TOOL_RESULT_CHARS) + '…(tronqué)';
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  return finish(await forceAnswer("Tu as utilisé toutes tes étapes d'outils."));
}

// Tool results older than `before` are cut down: the model already used them, re-sending them costs tokens.
function shrinkToolResults(messages, before, max) {
  for (let i = 0; i < before; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.content.length > max) m.content = m.content.slice(0, max) + '…(résumé)';
  }
}

function withTimeout(promise, ms, name) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => (t = setTimeout(() => reject(new Error(`${name} : pas de réponse après ${ms / 1000} s`)), ms))),
  ]).finally(() => clearTimeout(t));
}

function summarize(name, r) {
  if (!r) return 'ok';
  switch (name) {
    case 'open_page':
      return 'page ouverte';
    case 'search_vinted':
      return r.stats ? `${r.count} annonces · médiane ${r.stats.median} € (${r.stats.min}–${r.stats.max} €)` : `${r.count} annonces, pas de prix`;
    case 'web_search':
      return `${r.results?.length || 0} résultats`;
    case 'analyze_photos':
      return [r.brand, r.item_type, r.size_label, r.condition_guess].filter(Boolean).join(' · ') || 'analysé';
    case 'library_search':
      return `${r.count} article(s)`;
    case 'library_save':
      return `ajouté ${r.sku}`;
    case 'read_page':
      return r.pageType || 'lu';
    case 'propose_edits':
      return `${r.note?.match(/^\d+/)?.[0] || ''} modification(s) proposée(s)`;
    case 'fill_form':
      return r.filled ? `${r.filled.length} champ(s) rempli(s)` : 'ok';
    default:
      return 'ok';
  }
}

// ---------- listing pipeline: photos → vision → comparables → copywriting ----------
async function generateListing({ photos, form = {}, hint = '' }, tabId) {
  const settings = await store.getSettings();
  const ctx = { settings, tabId, emit() {} };
  const vision = await analyzePhotos(ctx, hint, photos?.length ? photos : undefined);
  const query = [form.brand || vision.brand, vision.item_type, vision.model].filter(Boolean).join(' ') || vision.search_query;
  let comps = null;
  if (query) comps = await searchVinted({ query, limit: 40 }, ctx).catch(() => null);
  const { message } = await chatCompletion(settings, {
    model: settings.chatModel,
    messages: [
      { role: 'system', content: agentSystemPrompt(settings) },
      { role: 'user', content: listingPrompt({ vision, comps, form, userHint: hint, settings }) },
    ],
    json: true,
    temperature: 0.4,
    maxTokens: 2500,
  });
  const listing = parseJson(message.content);
  return { listing, vision, comps: comps && { count: comps.count, stats: comps.stats, query, items: comps.items.slice(0, 6) } };
}

async function auditListing({ form }, tabId) {
  const settings = await store.getSettings();
  const ctx = { settings, tabId, emit() {} };
  const page = form || (await askTab(ctx, { type: 'read_page' })).form;
  const query = [page.brand, page.title].filter(Boolean).join(' ').split(/\s+/).slice(0, 6).join(' ');
  const comps = query ? await searchVinted({ query, limit: 40 }, ctx).catch(() => null) : null;
  const vision = await analyzePhotos(ctx).catch(() => null);
  const { message } = await chatCompletion(settings, {
    model: settings.chatModel,
    messages: [
      { role: 'system', content: agentSystemPrompt(settings) },
      { role: 'user', content: auditPrompt({ form: page, comps, vision }) },
    ],
    json: true,
    temperature: 0.3,
    maxTokens: 2000,
  });
  return { audit: parseJson(message.content), comps: comps && { count: comps.count, stats: comps.stats } };
}

// 3 ready-to-send messages for a conversation (reply / follow-up / offer) or for an item's favourites.
async function suggestMessages({ mode = 'reply', conversation = null, item = null, instruction = '' }) {
  const settings = await store.getSettings();
  const target = item || conversation?.item || null;
  const libItem = target?.id ? (await store.listItems()).find((i) => String(i.vintedId) === String(target.id)) || null : null;
  const { message } = await chatCompletion(settings, {
    model: settings.chatModel,
    messages: [{ role: 'user', content: messagesPrompt({ mode, conversation, item: target, libItem, instruction: String(instruction || '').slice(0, 500), settings }) }],
    json: true,
    temperature: 0.5,
    maxTokens: 900,
  });
  const out = parseJson(message.content);
  const replies = (Array.isArray(out.replies) ? out.replies : [])
    .filter((r) => r?.text)
    .slice(0, 3)
    .map((r) => ({
      kind: String(r.kind || 'custom'),
      label: String(r.label || 'Message').slice(0, 40),
      text: String(r.text).slice(0, 1500),
      price: r.price != null && Number.isFinite(+r.price) ? +r.price : null,
    }));
  if (!replies.length) throw new Error("Le modèle n'a pas proposé de message. Réessaie.");
  return { summary: out.summary || '', intent: out.buyer_intent || null, replies, libItem: libItem && { sku: libItem.sku, id: libItem.id, status: libItem.status } };
}

async function fetchAsDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image ${res.status}`);
  const blob = await res.blob();
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}`;
}
