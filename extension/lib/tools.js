// Vinted AI — agent tools: JSON-schema definitions + executors.
// Page tools are delegated to the Vinted tab's content script; the rest run in the worker.

import * as store from './storage.js';
import { webSearch, fetchUrl } from './web.js';
import { searchFromWorker } from './vinted-api.js';
import { chatCompletion, parseJson } from './llm.js';
import { VISION_PROMPT } from './prompts.js';

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

const LISTING_PROPS = {
  title: str('Titre optimisé'),
  description: str('Description complète'),
  brand: str('Marque'),
  size: str('Taille'),
  condition: str('État Vinted'),
  color: str('Couleur'),
  material: str('Matière'),
  category: str('Catégorie suggérée'),
  price: num('Prix conseillé en euros'),
  price_fast: num('Prix pour vendre vite'),
  price_max: num('Prix ambitieux'),
  price_reasoning: str('1 phrase : sur quoi repose le prix'),
  tags: { type: 'array', items: { type: 'string' }, description: 'Mots-clés' },
};

export const TOOL_DEFS = [
  fn('search_vinted', 'Annonces Vinted comparables + stats de prix. Affiche les résultats au vendeur en cartes.', {
    query: str('marque + type + modèle'),
    order: { type: 'string', enum: ['relevance', 'price_low_to_high', 'price_high_to_low', 'newest_first'] },
    price_from: num('Prix min'),
    price_to: num('Prix max'),
    limit: num('max 60, défaut 30'),
  }, ['query']),
  fn('open_page', 'Ouvre une page Vinted dans un onglet : un article (item_id) ou une recherche (search).', {
    item_id: str('id de l\'article'),
    search: str('texte de recherche'),
    order: { type: 'string', enum: ['relevance', 'price_low_to_high', 'price_high_to_low', 'newest_first'] },
  }),
  fn('web_search', 'Recherche web (prix neuf, référence, cote).', { query: str('Requête') }, ['query']),
  fn('fetch_url', 'Texte d\'une page web.', { url: str('URL') }, ['url']),
  fn('read_page', 'Lit la page Vinted ouverte (formulaire, fiche, conversation).'),
  fn('analyze_photos', 'Analyse vision des photos de l\'annonce ouverte.', { focus: str('point à examiner') }),
  fn('propose_listing', 'Affiche une annonce complète (champs applicables un par un).', LISTING_PROPS, ['title', 'description']),
  fn('propose_edits', 'Propose des modifications champ par champ, acceptées une par une.', {
    summary: str('1 phrase'),
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['title', 'description', 'price', 'brand', 'size', 'condition', 'color', 'material', 'category'] },
          value: str('valeur finale complète'),
          reason: str('pourquoi, court'),
        },
        required: ['field', 'value'],
      },
    },
  }, ['edits']),
  fn('propose_price', 'Affiche 3 prix cliquables.', { price: num('conseillé'), price_fast: num('vendre vite'), price_max: num('ambitieux'), reasoning: str('base du prix') }, ['price']),
  fn('fill_form', 'Remplit le formulaire Vinted (seulement si demandé explicitement).', LISTING_PROPS),
  fn('library_search', 'Cherche dans la bibliothèque du vendeur.', { query: str('#0012, titre, marque, note…'), status: { type: 'string', enum: ['', 'draft', 'listed', 'sold', 'archived'] } }),
  fn('library_save', 'Ajoute un article à la bibliothèque.', { ...LISTING_PROPS, cost: num('prix d\'achat'), notes: str('notes'), status: { type: 'string', enum: ['draft', 'listed', 'sold', 'archived'] } }, ['title']),
  fn('library_update', 'Modifie un article (notes, statut, prix, soldPrice, numéro via number…).', {
    ref: str('#0012 ou id'),
    patch: { type: 'object', description: 'title, price, cost, notes, status, soldPrice, buyer, location…' },
    number: num('nouveau numéro (optionnel)'),
  }, ['ref']),
  fn('library_stats', 'Stats de ventes (CA, bénéfice, délai, top marques, heures).'),
  fn('relist_item', 'Republie un article de la bibliothèque (nouveau formulaire pré-rempli).', { ref: str('#0012 ou id') }, ['ref']),
];

// ctx: { settings, tabId, emit(event) }
export async function runTool(name, args, ctx) {
  switch (name) {
    case 'search_vinted':
      return compactSearch(await searchVinted(args, ctx, { card: true }));
    case 'web_search':
      return webSearch(args.query, ctx.settings);
    case 'fetch_url':
      return fetchUrl(args.url);
    case 'open_page':
      return openPage(args, ctx);
    case 'read_page':
      return askTab(ctx, { type: 'read_page' });
    case 'analyze_photos':
      return analyzePhotos(ctx, args.focus);
    case 'propose_listing':
      ctx.emit({ type: 'card', card: { kind: 'listing', ...args } });
      return { ok: true, note: 'Annonce affichée : le vendeur applique chaque champ séparément ou sauve en bibliothèque.' };
    case 'propose_edits': {
      const edits = (Array.isArray(args.edits) ? args.edits : []).filter((e) => e?.field && e.value != null && e.value !== '');
      if (!edits.length) throw new Error('Aucune modification valide (field + value requis).');
      ctx.emit({ type: 'card', card: { kind: 'edits', summary: args.summary || '', edits } });
      return { ok: true, note: `${edits.length} modification(s) affichée(s) : le vendeur les accepte une par une. Ne les répète pas dans ta réponse.` };
    }
    case 'propose_price':
      if (!Number.isFinite(+args.price)) throw new Error('price requis');
      ctx.emit({ type: 'card', card: { kind: 'price', ...args } });
      return { ok: true, note: 'Options de prix affichées avec boutons Appliquer.' };
    case 'fill_form':
      return askTab(ctx, { type: 'fill_form', fields: args });
    case 'library_search': {
      const items = await store.searchItems(args);
      return { count: items.length, items: items.slice(0, 25).map(slim) };
    }
    case 'library_save': {
      const item = await store.createItem(args);
      ctx.emit({ type: 'library_changed' });
      return { ok: true, sku: item.sku, id: item.id };
    }
    case 'library_update': {
      let item = Object.keys(args.patch || {}).length ? await store.updateItem(args.ref, args.patch) : await store.getItem(args.ref);
      if (!item) throw new Error(`Article ${args.ref} introuvable`);
      if (args.number != null) item = (await store.setItemNumber(item.id, args.number, { swap: true })).item;
      ctx.emit({ type: 'library_changed' });
      return { ok: true, item: slim(item) };
    }
    case 'library_stats':
      return store.computeStats(await store.statsItems(), ctx.settings.feePercent);
    case 'relist_item':
      return relist(args.ref, ctx.settings);
    default:
      throw new Error(`Outil inconnu : ${name}`);
  }
}

const slim = ({ photos, history, description, ...rest }) => ({ ...rest, description: (description || '').slice(0, 200), photos: photos?.length || 0 });

// ---------- helpers ----------
export async function askTab(ctx, message) {
  const tabId = ctx.tabId ?? (await findVintedTab(ctx.settings));
  if (tabId == null) throw new Error('Aucun onglet Vinted ouvert. Ouvre Vinted dans un onglet.');
  const res = await chrome.tabs.sendMessage(tabId, message);
  if (res?.error) throw new Error(res.error);
  return res;
}

export async function findVintedTab(settings) {
  const tabs = await chrome.tabs.query({ url: `https://${settings.vintedDomain}/*` });
  return tabs[0]?.id ?? null;
}

// Full results (listing pipeline + audit). With card: true, also shows them to the seller in the chat.
export async function searchVinted(args, ctx, { card = false } = {}) {
  const domain = ctx.settings.vintedDomain;
  let r;
  try {
    r = await searchFromWorker(domain, { ...args, limit: Math.min(args.limit || 30, 60) });
  } catch (e) {
    throw new Error(`Recherche Vinted impossible (${e.message}). Utilise web_search avec "site:${domain}" en secours.`);
  }
  // Deal = priced at or under 70 % of the median of the results.
  const median = r.stats?.median;
  const items = r.items.map((i) => ({ ...i, deal: !!(median && i.price && i.price <= median * 0.7) }));
  if (card) ctx.emit?.({ type: 'card', card: { kind: 'results', query: args.query, count: r.count, stats: r.stats, items: items.slice(0, 12) } });
  return { ...r, items };
}

// What the model sees: stats + a short sample with short keys (tokens are the bottleneck on free tiers).
const compactSearch = (r) => ({
  count: r.count,
  stats: r.stats,
  items: r.items.slice(0, 12).map((i) => ({ id: i.id, t: i.title, p: i.price, b: i.brand, s: i.size, c: i.condition, fav: i.favourites, ...(i.deal ? { deal: true } : {}) })),
  note: 'Résultats affichés au vendeur en cartes. id → open_page(item_id).',
});

async function openPage({ item_id, search, order }, ctx) {
  const domain = ctx.settings.vintedDomain;
  let url;
  if (item_id && /^\d+$/.test(String(item_id))) url = `https://${domain}/items/${item_id}`;
  else if (search) url = `https://${domain}/catalog?${new URLSearchParams({ search_text: search, ...(order ? { order } : {}) })}`;
  else throw new Error('item_id ou search requis');
  await chrome.tabs.create({ url, active: true });
  return { ok: true, opened: url };
}

export async function analyzePhotos(ctx, focus, photos) {
  const imgs = photos || (await askTab(ctx, { type: 'get_photos', max: 3 })).photos;
  if (!imgs?.length) throw new Error('Aucune photo trouvée. Ajoute des photos à l\'annonce ou glisse-les dans le panel.');
  const content = [
    { type: 'text', text: VISION_PROMPT + (focus ? `\nPriorité : ${focus}` : '') },
    ...imgs.slice(0, 3).map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
  const { message } = await chatCompletion(ctx.settings, {
    model: ctx.settings.visionModel || ctx.settings.chatModel,
    messages: [{ role: 'user', content }],
    json: true,
    temperature: 0.2,
    maxTokens: 1200,
  });
  return parseJson(message.content);
}

async function relist(ref, settings) {
  const item = await store.getItem(ref);
  if (!item) throw new Error(`Article ${ref} introuvable`);
  await chrome.storage.local.set({ pendingFill: { itemId: item.id, at: Date.now() } });
  await chrome.tabs.create({ url: `https://${settings.vintedDomain}/items/new` });
  return { ok: true, note: `Formulaire ouvert pour ${item.sku}. Le panel propose "Appliquer" (texte + photos).` };
}
