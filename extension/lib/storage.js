// Vinted AI — persistence layer (chrome.storage.local).
// Shared by the background worker, the dashboard and the popup (ES module).
// Content scripts never touch storage directly: they go through the background.

export const PROVIDERS = {
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    chatModel: 'openai/gpt-oss-120b',
    visionModel: 'qwen/qwen3.8-27b',
    keyUrl: 'https://console.groq.com/keys',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatModel: 'openai/gpt-oss-120b',
    visionModel: 'google/gemini-2.5-flash',
    keyUrl: 'https://openrouter.ai/keys',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    chatModel: 'gpt-4.1-mini',
    visionModel: 'gpt-4.1-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    chatModel: 'mistral-medium-latest',
    visionModel: 'mistral-medium-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  custom: {
    label: 'Personnalisé (compatible OpenAI)',
    baseUrl: 'http://localhost:11434/v1',
    chatModel: '',
    visionModel: '',
    keyUrl: '',
  },
};

export const DEFAULT_SETTINGS = {
  provider: 'groq',
  baseUrl: PROVIDERS.groq.baseUrl,
  apiKey: '',
  chatModel: PROVIDERS.groq.chatModel,
  visionModel: PROVIDERS.groq.visionModel,
  tavilyKey: '', // optional: better web search than DuckDuckGo
  vintedDomain: 'www.vinted.fr',
  language: 'fr',
  sellerProfile: '', // free text: style, niche, shipping habits… injected in the system prompt
  feePercent: 0, // seller fees kept for profit calc (Vinted charges buyers, so 0 by default)
  panelOpenOnForm: true,
  // Save the form's fields to the library when the seller clicks Vinted's Add / Save button.
  autoSaveOnPublish: true,
  watchInterval: 15, // minutes between member-watch checks
  watchNotify: true,
  messageTone: 'vous', // buyer messages: 'vous' (default) or 'tu'
  // Numbers of sold/archived items go back to the pool (their bag is free again).
  skuReuseSold: true,
  // Learned Vinted member id of the seller, used to recognise "my" listings.
  myMemberId: null,
};

const K = { settings: 'settings', library: 'library', chats: 'chats', salesArchive: 'salesArchive' };

const get = async (key, fallback) => (await chrome.storage.local.get(key))[key] ?? fallback;
const set = (key, value) => chrome.storage.local.set({ [key]: value });

// ---------- settings ----------
export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await get(K.settings, {})) };
}
export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await set(K.settings, next);
  return next;
}

// ---------- library ----------
// Item shape (all optional except id/sku):
// { id, sku, title, description, brand, size, condition, color, material, category,
//   tags[], price, cost, photos[] (small data URLs), status: 'draft'|'listed'|'sold'|'archived',
//   vintedId, vintedUrl, notes, soldPrice, soldAt, buyer, createdAt, updatedAt, listedAt, history[] }
export const STATUSES = { draft: 'Brouillon', listed: 'En vente', sold: 'Vendu', archived: 'Archivé' };

export const formatSku = (n) => '#' + String(n).padStart(4, '0');
// A sold item gives its number back (its bag is free) and shows #VENDU; the old number stays in history (formerSku).
export const SOLD_SKU = '#VENDU';
export const skuNumber = (sku) => parseInt(String(sku ?? '').replace(/\D/g, ''), 10) || null;
const isActive = (i) => i.status === 'draft' || i.status === 'listed';

// A number is taken by any item still in the library — or only by active ones
// (draft / listed) when sold numbers are reused.
function takenNumbers(items, reuseSold, exceptId) {
  const taken = new Set();
  for (const i of items) if (i.id !== exceptId && (!reuseSold || isActive(i))) taken.add(skuNumber(i.sku));
  return taken;
}

// Smallest free number: delete #0001 and #0002, the next item is #0001 again.
export function nextFreeNumber(items, reuseSold = true) {
  const taken = takenNumbers(items, reuseSold);
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

export async function listItems() {
  return get(K.library, []);
}

// One-time fix for items sold before #VENDU existed: free their numbers.
export async function migrateSoldSkus() {
  const items = await listItems();
  let changed = 0;
  for (const i of items) {
    if (i.status !== 'sold' || i.sku === SOLD_SKU) continue;
    i.formerSku = i.sku;
    i.sku = SOLD_SKU;
    i.history = [...(i.history || []), { at: Date.now(), event: 'number_freed', from: i.formerSku }];
    changed++;
  }
  if (changed) await set(K.library, items);
  const archive = await listSalesArchive();
  if (archive.some((i) => i.sku !== SOLD_SKU)) await set(K.salesArchive, archive.map((i) => (i.sku === SOLD_SKU ? i : { ...i, formerSku: i.formerSku || i.sku, sku: SOLD_SKU })));
  return changed;
}

// Several items can share a number (a sold one and the active one that reused it):
// resolve to the active item first, then the most recent.
function findIndexByRef(items, ref) {
  if (!ref) return -1;
  const r = String(ref).trim();
  const byId = items.findIndex((i) => i.id === r || (i.vintedId && String(i.vintedId) === r));
  if (byId >= 0) return byId;
  const n = /^#?\d{1,6}$/.test(r) ? skuNumber(r) : null;
  if (n == null) return -1;
  const matches = items.map((it, idx) => [it, idx]).filter(([it]) => skuNumber(it.sku) === n);
  if (!matches.length) return -1;
  matches.sort(([a], [b]) => (isActive(b) - isActive(a)) || (b.createdAt || 0) - (a.createdAt || 0));
  return matches[0][1];
}

export async function getItem(ref) {
  const items = await listItems();
  return items[findIndexByRef(items, ref)] || null;
}

const ITEM_FIELDS = [
  'title', 'description', 'brand', 'size', 'condition', 'color', 'material', 'category', 'tags',
  'price', 'cost', 'photos', 'status', 'vintedId', 'vintedUrl', 'notes', 'soldPrice', 'soldAt',
  'buyer', 'listedAt', 'location',
];
// Note: sku / formerSku are managed here (createItem, updateItem, setItemNumber), never taken from a patch.

function clean(patch) {
  const out = {};
  for (const k of ITEM_FIELDS) if (patch[k] !== undefined) out[k] = patch[k];
  for (const k of ['price', 'cost', 'soldPrice']) {
    if (out[k] === '' || out[k] === null) out[k] = null;
    else if (out[k] !== undefined) {
      const n = parseFloat(String(out[k]).replace(',', '.'));
      out[k] = Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
    }
  }
  if (typeof out.tags === 'string') out.tags = out.tags.split(/[,\s]+/).filter(Boolean);
  if (out.status && !STATUSES[out.status]) delete out.status;
  // Links are rendered as <a href>: only accept real https URLs (agent input can be prompt-injected).
  if (out.vintedUrl !== undefined && !/^https:\/\/[^\s"'<>]+$/.test(String(out.vintedUrl))) out.vintedUrl = null;
  if (out.vintedId !== undefined) out.vintedId = String(out.vintedId || '').replace(/\D/g, '') || null;
  return out;
}

export async function createItem(data) {
  const settings = await getSettings();
  const items = await listItems();
  const now = Date.now();
  const item = {
    id: crypto.randomUUID(),
    sku: data.status === 'sold' ? SOLD_SKU : formatSku(nextFreeNumber(items, settings.skuReuseSold)),
    status: 'draft',
    tags: [],
    photos: [],
    history: [{ at: now, event: 'created' }],
    createdAt: now,
    updatedAt: now,
    ...clean(data),
  };
  if (item.status === 'sold' && !item.soldAt) item.soldAt = now;
  if (item.status === 'listed' && !item.listedAt) item.listedAt = now;
  items.unshift(item);
  await set(K.library, items);
  return item;
}

export async function updateItem(ref, patch) {
  const items = await listItems();
  const idx = findIndexByRef(items, ref);
  if (idx < 0) throw new Error(`Article introuvable : ${ref}`);
  const prev = items[idx];
  const next = { ...prev, ...clean(patch), updatedAt: Date.now() };
  if (next.status !== prev.status) {
    next.history = [...(prev.history || []), { at: Date.now(), event: next.status }];
    if (next.status === 'sold' && !next.soldAt) next.soldAt = Date.now();
    if (next.status === 'listed' && !next.listedAt) next.listedAt = Date.now();
    if (next.status === 'sold' && prev.sku !== SOLD_SKU) {
      next.formerSku = prev.sku;
      next.sku = SOLD_SKU;
      next.history.push({ at: Date.now(), event: 'number_freed', from: prev.sku });
    } else if (prev.status === 'sold' && next.status !== 'sold') {
      // Back on sale / draft: take its old number again if still free, else the smallest free one.
      const others = items.filter((i) => i.id !== prev.id);
      const settings = await getSettings();
      const taken = takenNumbers(others, settings.skuReuseSold);
      const old = skuNumber(prev.formerSku);
      next.sku = formatSku(old && !taken.has(old) ? old : nextFreeNumber(others, settings.skuReuseSold));
    }
  }
  items[idx] = next;
  await set(K.library, items);
  return next;
}

export async function deleteItem(ref) {
  const items = await listItems();
  const idx = findIndexByRef(items, ref);
  if (idx < 0) return;
  // A sale is history: deleting the item frees its number but the sale stays in the stats.
  if (items[idx].status === 'sold') {
    const { photos, history, ...sale } = items[idx];
    await set(K.salesArchive, [...(await listSalesArchive()), { ...sale, deletedAt: Date.now() }]);
  }
  items.splice(idx, 1);
  await set(K.library, items);
}

export const listSalesArchive = () => get(K.salesArchive, []);
// Everything the stats need: current items + sales of deleted items.
export async function statsItems() {
  return [...(await listItems()), ...(await listSalesArchive())];
}

// ---------- backup mirror in chrome.storage.sync (compact, no photos) ----------
// Restores the library if local storage is ever emptied (profile reset, reinstall from the same folder).
const SYNC_CHUNK = 7000;
const slimForSync = (i) => ({
  id: i.id, sku: i.sku, formerSku: i.formerSku, title: (i.title || '').slice(0, 70), brand: i.brand, size: i.size, status: i.status,
  price: i.price, cost: i.cost, soldPrice: i.soldPrice, soldAt: i.soldAt, listedAt: i.listedAt, createdAt: i.createdAt,
  vintedId: i.vintedId, notes: (i.notes || '').slice(0, 120), location: i.location, deletedAt: i.deletedAt,
});
export async function backupToSync() {
  if (!chrome.storage.sync) return;
  const all = [...(await listItems()), ...(await listSalesArchive())].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  let json = JSON.stringify(all.map(slimForSync));
  // chrome.storage.sync holds ~100 KB: keep the most recent items if the library is bigger.
  while (json.length > 90000 && all.length) {
    all.pop();
    json = JSON.stringify(all.map(slimForSync));
  }
  const chunks = {};
  for (let i = 0; i * SYNC_CHUNK < json.length; i++) chunks[`bk${i}`] = json.slice(i * SYNC_CHUNK, (i + 1) * SYNC_CHUNK);
  const old = await chrome.storage.sync.get(null);
  const stale = Object.keys(old).filter((k) => /^bk\d+$/.test(k) && !(k in chunks));
  if (stale.length) await chrome.storage.sync.remove(stale);
  await chrome.storage.sync.set({ ...chunks, bkMeta: { at: Date.now(), n: all.length, chunks: Object.keys(chunks).length } });
}
export async function restoreFromSyncIfEmpty() {
  if (!chrome.storage.sync || (await listItems()).length || (await listSalesArchive()).length) return 0;
  const data = await chrome.storage.sync.get(null);
  if (!data.bkMeta) return 0;
  let json = '';
  for (let i = 0; i < data.bkMeta.chunks; i++) json += data[`bk${i}`] || '';
  const all = JSON.parse(json || '[]');
  await set(K.library, all.filter((i) => !i.deletedAt).map((i) => ({ tags: [], photos: [], history: [{ at: Date.now(), event: 'restored' }], ...i })));
  await set(K.salesArchive, all.filter((i) => i.deletedAt));
  return all.length;
}
export async function backupInfo() {
  const { bkMeta } = chrome.storage.sync ? await chrome.storage.sync.get('bkMeta') : {};
  return bkMeta || null;
}

// Change an item's number. If another active item holds it: error, or swap numbers when asked.
export async function setItemNumber(ref, number, { swap = false } = {}) {
  const n = skuNumber(number);
  if (!n || n > 99999) throw new Error('Numéro invalide (1 à 99999).');
  const [items, settings] = await Promise.all([listItems(), getSettings()]);
  const idx = findIndexByRef(items, ref);
  if (idx < 0) throw new Error(`Article introuvable : ${ref}`);
  const item = items[idx];
  if (item.status === 'sold') throw new Error("Un article vendu n'a plus de numéro (#VENDU) : son sachet est libre.");
  const holder = items.find((i) => i.id !== item.id && skuNumber(i.sku) === n && (!settings.skuReuseSold || isActive(i)));
  if (holder && !swap) {
    const err = new Error(`${formatSku(n)} est déjà pris par « ${holder.title || 'sans titre'} ».`);
    err.code = 'SKU_TAKEN';
    err.holder = { id: holder.id, sku: holder.sku, title: holder.title };
    throw err;
  }
  const now = Date.now();
  if (holder) {
    holder.sku = item.sku;
    holder.updatedAt = now;
    holder.history = [...(holder.history || []), { at: now, event: 'renumbered', to: holder.sku }];
  }
  const from = item.sku;
  item.sku = formatSku(n);
  item.updatedAt = now;
  item.history = [...(item.history || []), { at: now, event: 'renumbered', from, to: item.sku }];
  await set(K.library, items);
  return { item, swappedWith: holder ? { id: holder.id, sku: holder.sku } : null };
}

export async function searchItems({ query = '', status = '' } = {}) {
  const q = query.toLowerCase().trim();
  return (await listItems()).filter((i) => {
    if (status && i.status !== status) return false;
    if (!q) return true;
    return [i.sku, skuNumber(i.sku), i.title, i.brand, i.size, i.notes, i.location, i.vintedId, (i.tags || []).join(' ')]
      .join(' ')
      .toLowerCase()
      .includes(q);
  });
}

// ---------- chats (one history per context: "panel" / "dashboard") ----------
export async function getChat(id) {
  return (await get(K.chats, {}))[id] || [];
}
export async function saveChat(id, messages) {
  const chats = await get(K.chats, {});
  chats[id] = messages.slice(-40);
  await set(K.chats, chats);
}

// ---------- export / import ----------
export async function exportAll() {
  const { apiKey, tavilyKey, myMemberId, ...safeSettings } = await getSettings(); // never export secrets
  return { app: 'vinted-ai', version: 1, exportedAt: new Date().toISOString(), settings: safeSettings, library: await listItems(), salesArchive: await listSalesArchive() };
}
export async function importAll(data) {
  if (!data || data.app !== 'vinted-ai' || !Array.isArray(data.library)) throw new Error('Fichier non reconnu');
  const current = await listItems();
  const byId = new Map(current.map((i) => [i.id, i]));
  for (const it of data.library) if (it && it.id && it.sku) byId.set(it.id, it);
  const merged = [...byId.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  await set(K.library, merged);
  if (Array.isArray(data.salesArchive)) {
    const arch = new Map((await listSalesArchive()).map((i) => [i.id, i]));
    for (const it of data.salesArchive) if (it?.id) arch.set(it.id, it);
    await set(K.salesArchive, [...arch.values()]);
  }
  await migrateSoldSkus();
  return merged.length;
}

// ---------- stats (dashboard + agent) ----------
export function computeStats(items, feePercent = 0) {
  const sold = items.filter((i) => i.status === 'sold');
  const listed = items.filter((i) => i.status === 'listed');
  const revenue = sold.reduce((s, i) => s + (i.soldPrice ?? i.price ?? 0), 0);
  const costs = sold.reduce((s, i) => s + (i.cost ?? 0), 0);
  const fees = revenue * (feePercent / 100);
  const days = sold
    .filter((i) => i.soldAt && (i.listedAt || i.createdAt))
    .map((i) => (i.soldAt - (i.listedAt || i.createdAt)) / 86400000);
  const avgDays = days.length ? days.reduce((a, b) => a + b, 0) / days.length : null;
  const stockValue = listed.reduce((s, i) => s + (i.price ?? 0), 0);
  const brands = {};
  for (const i of sold) if (i.brand) brands[i.brand] = (brands[i.brand] || 0) + (i.soldPrice ?? i.price ?? 0);
  return {
    total: items.length,
    drafts: items.filter((i) => i.status === 'draft').length,
    listed: listed.length,
    sold: sold.length,
    revenue: round(revenue),
    profit: round(revenue - costs - fees),
    avgBasket: sold.length ? round(revenue / sold.length) : 0,
    avgDaysToSell: avgDays === null ? null : Math.round(avgDays * 10) / 10,
    stockValue: round(stockValue),
    sellThrough: listed.length + sold.length ? Math.round((sold.length / (listed.length + sold.length)) * 100) : 0,
    topBrands: Object.entries(brands).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}
const round = (n) => Math.round(n * 100) / 100;
