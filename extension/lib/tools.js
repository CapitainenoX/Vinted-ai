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
  tags: { type: 'array', items: { type: 'string' }, description: 'Mots-clés' },
};

export const TOOL_DEFS = [
  fn('search_vinted', 'Cherche des annonces comparables sur Vinted et renvoie les stats de prix (min, p25, médiane, p75, max) + les annonces.', {
    query: str('Requête (marque + type + modèle)'),
    order: { type: 'string', enum: ['relevance', 'price_low_to_high', 'price_high_to_low', 'newest_first'] },
    price_from: num('Prix min'),
    price_to: num('Prix max'),
    limit: num('Nombre de résultats (max 96, défaut 30)'),
  }, ['query']),
  fn('web_search', 'Recherche web (prix neuf, référence, tendances, cote d\'une marque).', { query: str('Requête') }, ['query']),
  fn('fetch_url', 'Lit le texte d\'une page web.', { url: str('URL complète') }, ['url']),
  fn('read_page', 'Lit la page Vinted ouverte : type de page, champs du formulaire d\'annonce, ou infos de la fiche article.'),
  fn('analyze_photos', 'Analyse les photos de l\'annonce en cours (formulaire ou fiche article) avec un modèle vision : marque, étiquette, taille, matière, défauts.', {
    focus: str('Point à examiner en priorité (optionnel)'),
  }),
  fn('propose_listing', 'Présente une annonce complète au vendeur avec des boutons Appliquer / Sauver en bibliothèque. À utiliser dès qu\'une annonce est rédigée.', LISTING_PROPS, ['title', 'description']),
  fn('fill_form', 'Remplit directement le formulaire d\'annonce Vinted ouvert (seulement si le vendeur le demande).', LISTING_PROPS),
  fn('library_search', 'Cherche dans la bibliothèque du vendeur.', {
    query: str('Texte libre : numéro (#0012), titre, marque, note…'),
    status: { type: 'string', enum: ['', 'draft', 'listed', 'sold', 'archived'] },
  }),
  fn('library_save', 'Ajoute un article à la bibliothèque (un numéro #XXXX est attribué).', {
    ...LISTING_PROPS,
    cost: num('Prix d\'achat'),
    notes: str('Notes'),
    status: { type: 'string', enum: ['draft', 'listed', 'sold', 'archived'] },
  }, ['title']),
  fn('library_update', 'Modifie un article de la bibliothèque (notes, statut, prix de vente, acheteur…).', {
    ref: str('Numéro (#0012) ou id'),
    patch: { type: 'object', description: 'Champs à modifier : title, description, price, cost, notes, status, soldPrice, buyer, location, tags…' },
  }, ['ref', 'patch']),
  fn('library_set_number', 'Change le numéro (#XXXX) d\'un article. swap=true échange avec l\'article qui a déjà ce numéro.', {
    ref: str('Numéro actuel (#0012) ou id'),
    number: num('Nouveau numéro'),
    swap: { type: 'boolean', description: 'Échanger si le numéro est déjà pris' },
  }, ['ref', 'number']),
  fn('library_stats', 'Statistiques de ventes : CA, bénéfice, délai moyen de vente, top marques.'),
  fn('relist_item', 'Republie un article de la bibliothèque : ouvre un nouveau formulaire Vinted pré-rempli.', { ref: str('Numéro (#0012) ou id') }, ['ref']),
];

// ctx: { settings, tabId, emit(event) }
export async function runTool(name, args, ctx) {
  switch (name) {
    case 'search_vinted':
      return searchVinted(args, ctx);
    case 'web_search':
      return webSearch(args.query, ctx.settings);
    case 'fetch_url':
      return fetchUrl(args.url);
    case 'read_page':
      return askTab(ctx, { type: 'read_page' });
    case 'analyze_photos':
      return analyzePhotos(ctx, args.focus);
    case 'propose_listing':
      ctx.emit({ type: 'proposal', listing: args });
      return { ok: true, note: 'Annonce affichée au vendeur avec les boutons Appliquer / Sauver.' };
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
      const item = await store.updateItem(args.ref, args.patch || {});
      ctx.emit({ type: 'library_changed' });
      return { ok: true, item: slim(item) };
    }
    case 'library_set_number': {
      const r = await store.setItemNumber(args.ref, args.number, { swap: !!args.swap });
      ctx.emit({ type: 'library_changed' });
      return { ok: true, sku: r.item.sku, swappedWith: r.swappedWith };
    }
    case 'library_stats':
      return store.computeStats(await store.listItems(), ctx.settings.feePercent);
    case 'relist_item':
      return relist(args.ref, ctx.settings);
    default:
      throw new Error(`Outil inconnu : ${name}`);
  }
}

const slim = ({ photos, history, ...rest }) => ({ ...rest, photos: photos?.length || 0 });

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

export async function searchVinted(args, ctx) {
  const domain = ctx.settings.vintedDomain;
  try {
    return trimSearch(await searchFromWorker(domain, args));
  } catch (e) {
    throw new Error(`Recherche Vinted impossible (${e.message}). Utilise web_search avec "site:${domain}" en secours.`);
  }
}

// Keep tool results short: the model only needs a sample, the stats carry the signal.
const trimSearch = (r) => ({ ...r, items: r.items.slice(0, 20).map(({ photo, total, ...i }) => i) });

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
