// Vinted AI — member watch: periodic snapshot of a member (profile + wardrobe), diff, events, notifications.
// Endpoints (verified): www.vinted.<tld>/api/v2/users/{id} and /api/v2/wardrobe/{id}/items,
// with Accept: application/json + the anonymous access_token_web bearer (same token as the catalogue).
import { getToken } from './vinted-api.js';

const K = { watches: 'watches', events: 'watchEvents' };
const MAX_EVENTS = 300;
const MAX_HISTORY = 400;
const get = async (k, d) => (await chrome.storage.local.get(k))[k] ?? d;
const set = (k, v) => chrome.storage.local.set({ [k]: v });

export const listWatches = () => get(K.watches, []);
export const listEvents = () => get(K.events, []);

// "https://www.vinted.fr/member/13909279-login", "13909279" → { memberId, domain }
export function parseMember(input, fallbackDomain) {
  const s = String(input || '').trim();
  const url = s.match(/^https?:\/\/(www\.vinted\.[a-z.]{2,6})\/member\/(\d+)/i);
  if (url) return { domain: url[1].toLowerCase(), memberId: url[2] };
  const id = s.match(/^(?:\/?member\/)?(\d{3,12})\b/);
  if (id) return { domain: fallbackDomain, memberId: id[1] };
  throw new Error('Colle l’URL d’un profil Vinted (…/member/123456) ou son numéro.');
}

async function api(domain, path) {
  let token = await getToken(domain);
  const call = (t) => fetch(`https://${domain}${path}`, { credentials: 'include', headers: { Accept: 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) } });
  let res = await call(token);
  if (res.status === 401 || res.status === 403) res = await call((token = await getToken(domain, { refresh: true })));
  if (!res.ok) throw new Error(`Vinted ${res.status}`);
  return res.json();
}

const num = (v) => {
  const n = parseFloat(String(v?.amount ?? v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// Compact snapshot: only what we compare and display.
export async function fetchMember(domain, memberId) {
  const { user } = await api(domain, `/api/v2/users/${memberId}`);
  const items = {};
  for (let page = 1; page <= 5; page++) {
    const w = await api(domain, `/api/v2/wardrobe/${memberId}/items?page=${page}&per_page=96&order=newest_first`);
    for (const i of w.items || []) {
      if (i.is_draft || i.is_hidden) continue;
      items[i.id] = {
        t: String(i.title || '').slice(0, 100),
        p: num(i.price),
        fav: i.favourite_count ?? 0,
        v: i.stats_visible === false ? null : (i.view_count ?? null),
        r: !!i.is_reserved,
        c: !!i.is_closed,
        b: i.brand || null,
        s: i.size || null,
        ph: i.photos?.[0]?.thumbnails?.find((t) => t.type === 'thumb150x210')?.url || i.photos?.[0]?.url || i.photo?.url || null,
        u: i.url || `https://${domain}${i.path || `/items/${i.id}`}`,
      };
    }
    if (!w.pagination || page >= (w.pagination.total_pages || 1)) break;
  }
  return {
    user: {
      login: user.login,
      city: user.city || null,
      photo: user.photo?.thumbnails?.[0]?.url || user.photo?.url || null,
      onSale: user.item_count ?? Object.keys(items).length,
      sold: user.given_item_count ?? null,
      bought: user.taken_item_count ?? null,
      feedback: user.feedback_count ?? 0,
      rating: user.feedback_reputation != null ? Math.round(user.feedback_reputation * 50) / 10 : null, // /5
      followers: user.followers_count ?? 0,
      holiday: !!user.is_on_holiday,
      online: !!user.is_online,
      lastLogin: user.last_loged_on_ts ? Date.parse(user.last_loged_on_ts) || null : null,
      url: user.profile_url || `https://${domain}/member/${memberId}`,
    },
    items,
  };
}

// What changed between two snapshots → human events (French).
export function diff(prev, next) {
  const ev = [];
  if (!prev) return ev;
  const P = prev.user, N = next.user;
  const e = (type, text, extra = {}) => ev.push({ type, text, ...extra });
  const soldDelta = N.sold != null && P.sold != null ? N.sold - P.sold : 0;
  for (const [id, it] of Object.entries(prev.items)) {
    const now = next.items[id];
    if (!now) e(soldDelta > 0 ? 'sold' : 'gone', `${soldDelta > 0 ? 'Vendu' : 'Retiré ou vendu'} : ${it.t}${it.p != null ? ` (${it.p} €)` : ''}`, { itemId: id, url: it.u, photo: it.ph });
    else {
      if (now.p != null && it.p != null && now.p !== it.p) e('price', `Prix ${now.p < it.p ? 'baissé' : 'monté'} : ${it.t} — ${it.p} € → ${now.p} €`, { itemId: id, url: now.u, photo: now.ph });
      if (now.r && !it.r) e('reserved', `Réservé : ${it.t}`, { itemId: id, url: now.u, photo: now.ph });
      if (now.fav > it.fav) e('favs', `+${now.fav - it.fav} favori(s) : ${it.t} (${now.fav} ♥)`, { itemId: id, url: now.u, photo: now.ph, quiet: true });
      if (now.v != null && it.v != null && now.v - it.v >= 10) e('views', `+${now.v - it.v} vues : ${it.t}`, { itemId: id, url: now.u, quiet: true });
    }
  }
  for (const [id, it] of Object.entries(next.items)) if (!prev.items[id]) e('new', `Nouvel article : ${it.t}${it.p != null ? ` (${it.p} €)` : ''}`, { itemId: id, url: it.u, photo: it.ph });
  if (soldDelta > 0) e('sales', `${soldDelta} nouvelle(s) vente(s) — ${N.sold} au total`);
  if (N.feedback > P.feedback) e('feedback', `${N.feedback - P.feedback} nouvel(s) avis — ${N.feedback} au total${N.rating != null ? `, ${N.rating}/5` : ''}`);
  if (N.followers !== P.followers) e('followers', `Abonnés : ${P.followers} → ${N.followers}`, { quiet: true });
  if (N.holiday !== P.holiday) e('holiday', N.holiday ? 'Passé en mode vacances' : 'Revenu de vacances');
  return ev;
}

export async function addWatch(input, settings) {
  const { domain, memberId } = parseMember(input, settings.vintedDomain);
  const watches = await listWatches();
  if (watches.some((w) => w.memberId === memberId)) throw new Error('Ce membre est déjà surveillé.');
  const snap = await fetchMember(domain, memberId);
  const w = { memberId, domain, login: snap.user.login, addedAt: Date.now(), lastCheck: Date.now(), lastError: null, snapshot: snap, history: [point(snap)] };
  await set(K.watches, [w, ...watches]);
  return w;
}

export async function removeWatch(memberId) {
  await set(K.watches, (await listWatches()).filter((w) => w.memberId !== memberId));
}

const point = (snap) => ({
  at: Date.now(),
  onSale: Object.keys(snap.items).length,
  sold: snap.user.sold,
  favs: Object.values(snap.items).reduce((a, i) => a + (i.fav || 0), 0),
  feedback: snap.user.feedback,
  followers: snap.user.followers,
});

// Check every watched member (or one). Returns the new events.
export async function checkWatches(onlyId = null) {
  const watches = await listWatches();
  const fresh = [];
  for (const w of watches) {
    if (onlyId && w.memberId !== onlyId) continue;
    try {
      const snap = await fetchMember(w.domain, w.memberId);
      const events = diff(w.snapshot, snap).map((e) => ({ ...e, id: crypto.randomUUID(), at: Date.now(), memberId: w.memberId, login: snap.user.login, read: false }));
      fresh.push(...events);
      const last = w.history.at(-1);
      const p = point(snap);
      // Keep a point when something moved, or at most one per hour otherwise.
      if (!last || events.length || p.at - last.at > 3600000) w.history = [...w.history, p].slice(-MAX_HISTORY);
      Object.assign(w, { snapshot: snap, login: snap.user.login, lastCheck: Date.now(), lastError: null });
    } catch (e) {
      Object.assign(w, { lastCheck: Date.now(), lastError: e.message });
    }
    if (!onlyId) await new Promise((r) => setTimeout(r, 1200)); // gentle with Vinted
  }
  // Re-read before writing: the list may have changed while we were fetching.
  const current = await listWatches();
  await set(K.watches, current.map((c) => watches.find((w) => w.memberId === c.memberId) || c));
  if (fresh.length) await set(K.events, [...fresh.reverse(), ...(await listEvents())].slice(0, MAX_EVENTS));
  return fresh;
}

export async function markEventsRead() {
  await set(K.events, (await listEvents()).map((e) => ({ ...e, read: true })));
}
export const unreadCount = async () => (await listEvents()).filter((e) => !e.read && !e.quiet).length;
