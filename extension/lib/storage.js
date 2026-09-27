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
  nextSku: 1,
};

const K = { settings: 'settings', library: 'library', chats: 'chats' };

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

export async function listItems() {
  return get(K.library, []);
}

export async function getItem(ref) {
  const items = await listItems();
  return items.find((i) => matchRef(i, ref)) || null;
}

function matchRef(item, ref) {
  if (!ref) return false;
  const r = String(ref).trim();
  const norm = r.startsWith('#') ? r : '#' + r.padStart(4, '0');
  return item.id === r || item.sku === r || item.sku === norm || String(item.vintedId || '') === r;
}

const ITEM_FIELDS = [
  'title', 'description', 'brand', 'size', 'condition', 'color', 'material', 'category', 'tags',
  'price', 'cost', 'photos', 'status', 'vintedId', 'vintedUrl', 'notes', 'soldPrice', 'soldAt',
  'buyer', 'listedAt', 'location',
];

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
  const now = Date.now();
  const item = {
    id: crypto.randomUUID(),
    sku: formatSku(settings.nextSku),
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
  const items = await listItems();
  items.unshift(item);
  await set(K.library, items);
  await saveSettings({ nextSku: settings.nextSku + 1 });
  return item;
}

export async function updateItem(ref, patch) {
  const items = await listItems();
  const idx = items.findIndex((i) => matchRef(i, ref));
  if (idx < 0) throw new Error(`Article introuvable : ${ref}`);
  const prev = items[idx];
  const next = { ...prev, ...clean(patch), updatedAt: Date.now() };
  if (next.status !== prev.status) {
    next.history = [...(prev.history || []), { at: Date.now(), event: next.status }];
    if (next.status === 'sold' && !next.soldAt) next.soldAt = Date.now();
    if (next.status === 'listed' && !next.listedAt) next.listedAt = Date.now();
  }
  items[idx] = next;
  await set(K.library, items);
  return next;
}

export async function deleteItem(ref) {
  const items = await listItems();
  await set(K.library, items.filter((i) => !matchRef(i, ref)));
}

export async function searchItems({ query = '', status = '' } = {}) {
  const q = query.toLowerCase().trim();
  return (await listItems()).filter((i) => {
    if (status && i.status !== status) return false;
    if (!q) return true;
    return [i.sku, i.title, i.brand, i.size, i.notes, i.vintedId, (i.tags || []).join(' ')]
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
  const { apiKey, tavilyKey, ...safeSettings } = await getSettings(); // never export secrets
  return { app: 'vinted-ai', version: 1, exportedAt: new Date().toISOString(), settings: safeSettings, library: await listItems() };
}
export async function importAll(data) {
  if (!data || data.app !== 'vinted-ai' || !Array.isArray(data.library)) throw new Error('Fichier non reconnu');
  const current = await listItems();
  const byId = new Map(current.map((i) => [i.id, i]));
  for (const it of data.library) if (it && it.id && it.sku) byId.set(it.id, it);
  const merged = [...byId.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  await set(K.library, merged);
  const maxSku = merged.reduce((m, i) => Math.max(m, parseInt(String(i.sku).slice(1), 10) || 0), 0);
  const s = await getSettings();
  if (s.nextSku <= maxSku) await saveSettings({ nextSku: maxSku + 1 });
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
