// Vinted AI — service worker: message router, agent loop, listing pipeline.

import * as store from './lib/storage.js';
import { chatCompletion, listModels, parseJson } from './lib/llm.js';
import { agentSystemPrompt, listingPrompt, auditPrompt } from './lib/prompts.js';
import { TOOL_DEFS, runTool, searchVinted, analyzePhotos, askTab } from './lib/tools.js';

const MAX_STEPS = 8;
const TOOL_RESULT_CHARS = 7000;

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
  'library:export': () => store.exportAll(),
  'library:import': ({ data }) => store.importAll(data),
  'library:stats': async () => store.computeStats(await store.listItems(), (await store.getSettings()).feePercent),
  // Map of vintedId -> { sku, id, status, notes } for badge injection on Vinted pages.
  'library:index': async () => {
    const index = {};
    for (const i of await store.listItems()) if (i.vintedId) index[i.vintedId] = { sku: i.sku, id: i.id, status: i.status, notes: i.notes || '' };
    return index;
  },

  'chat:get': ({ id }) => store.getChat(id),
  'chat:clear': ({ id }) => store.saveChat(id, []),

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
    controller = new AbortController();
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
      emit({ type: 'done' });
    }
  });
  port.onDisconnect.addListener(() => controller?.abort());
});

async function runAgent({ chatId, text, images = [], pageContext }, { tabId, emit, signal }) {
  const settings = await store.getSettings();
  const ctx = { settings, tabId, emit };
  const history = await store.getChat(chatId);

  let userContent = text;
  if (images.length) {
    emit({ type: 'tool', name: 'analyze_photos', args: { photos: images.length } });
    const vision = await analyzePhotos(ctx, null, images);
    emit({ type: 'tool_result', name: 'analyze_photos', summary: summarize('analyze_photos', vision) });
    userContent += `\n\n[Analyse des ${images.length} photo(s) jointe(s)]\n${JSON.stringify(vision)}`;
  }

  const messages = [
    { role: 'system', content: agentSystemPrompt(settings, { page: pageContext }) },
    ...history.map(({ role, content }) => ({ role, content })),
    { role: 'user', content: userContent },
  ];
  history.push({ role: 'user', content: userContent, display: text, images: images.length });

  for (let step = 0; step < MAX_STEPS; step++) {
    const { message } = await chatCompletion(settings, { model: settings.chatModel, messages, tools: TOOL_DEFS, signal, temperature: 0.4 });
    const calls = message.tool_calls || [];
    messages.push({ role: 'assistant', content: message.content || '', ...(calls.length ? { tool_calls: calls } : {}) });

    if (!calls.length) {
      const answer = message.content?.trim() || '(pas de réponse)';
      history.push({ role: 'assistant', content: answer });
      await store.saveChat(chatId, history);
      emit({ type: 'final', text: answer });
      return;
    }
    if (message.content) emit({ type: 'thinking', text: message.content });

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}') || {};
      } catch {}
      emit({ type: 'tool', name, args });
      let result;
      try {
        result = await runTool(name, args, ctx);
        emit({ type: 'tool_result', name, summary: summarize(name, result) });
      } catch (e) {
        result = { error: e.message };
        emit({ type: 'tool_result', name, summary: '⚠ ' + e.message, error: true });
      }
      let content = JSON.stringify(result);
      if (content.length > TOOL_RESULT_CHARS) content = content.slice(0, TOOL_RESULT_CHARS) + '…(tronqué)';
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  const msg = "J'ai atteint la limite d'étapes. Reformule ou découpe la demande.";
  history.push({ role: 'assistant', content: msg });
  await store.saveChat(chatId, history);
  emit({ type: 'final', text: msg });
}

function summarize(name, r) {
  if (!r) return 'ok';
  switch (name) {
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

async function fetchAsDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image ${res.status}`);
  const blob = await res.blob();
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}`;
}
