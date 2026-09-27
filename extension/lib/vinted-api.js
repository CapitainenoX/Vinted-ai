// Vinted AI — comparable-listing search + price stats.
// Since Sept 2026 the catalogue lives on api.vinted.<tld>/svc-catalogue/items behind a bearer token:
// the `access_token_web` cookie Vinted hands to every visitor (HttpOnly → read with chrome.cookies).
// The old www.vinted.<tld>/api/v2/catalog/items is kept as a last resort.

export function summarizeCatalog(json, domain) {
  const raw = json?.items || [];
  const items = raw.map((i) => {
    const box = i.item_box || {};
    const [boxSize, boxCondition] = String(box.second_line || '').split(' · ');
    const photo = i.photo || i.photos?.[0];
    const url = i.url || i.path || `/items/${i.id}`;
    return {
      id: i.id,
      title: i.title,
      price: toNumber(i.price?.amount ?? i.price),
      currency: i.price?.currency_code || null,
      total: toNumber(i.total_item_price?.amount ?? i.total_item_price),
      brand: i.brand_title || box.first_line || null,
      size: i.size_title || boxSize || null,
      condition: i.status || boxCondition || null,
      favourites: i.favourite_count ?? null,
      views: i.view_count ?? null,
      url: /^https?:/.test(url) ? url : `https://${domain}${url.startsWith('/') ? '' : '/'}${url}`,
      photo: photo?.url || photo?.thumbnails?.[0]?.url || null,
    };
  });
  return { count: json?.pagination?.total_entries ?? items.length, stats: priceStats(items.map((i) => i.price)), items };
}

export function priceStats(prices) {
  const p = prices.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!p.length) return null;
  const q = (f) => p[Math.min(p.length - 1, Math.floor(f * (p.length - 1) + 0.5))];
  const mean = p.reduce((a, b) => a + b, 0) / p.length;
  return { n: p.length, min: p[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: p[p.length - 1], mean: Math.round(mean * 100) / 100 };
}

const toNumber = (v) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

export const apiHost = (domain) => domain.replace(/^www\./, 'api.');

// The new endpoint rejects blank params with 400, so only set what has a value.
function catalogParams({ query, order = 'relevance', price_from, price_to, limit = 30 }) {
  const params = new URLSearchParams({ search_text: query, per_page: String(Math.min(limit || 30, 96)), page: '1', order: order || 'relevance' });
  if (price_from) params.set('price_from', price_from);
  if (price_to) params.set('price_to', price_to);
  return params;
}

export const catalogUrl = (domain, args) => `https://${apiHost(domain)}/svc-catalogue/items?${catalogParams(args)}`;
export const legacyCatalogUrl = (domain, args) => `https://${domain}/api/v2/catalog/items?${catalogParams(args)}`;

async function readToken(domain) {
  const c = await chrome.cookies.get({ url: `https://${domain}/`, name: 'access_token_web' }).catch(() => null);
  return c?.value || null;
}

// Vinted sets the anonymous token on any page load; fetching one refreshes the cookie jar.
export async function getToken(domain, { refresh = false } = {}) {
  if (!refresh) {
    const t = await readToken(domain);
    if (t) return t;
  }
  await fetch(`https://${domain}/catalog`, { method: 'HEAD', credentials: 'include' }).catch(() => {});
  return readToken(domain);
}

async function fetchCatalog(domain, args, token) {
  return fetch(catalogUrl(domain, args), {
    credentials: 'include',
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

export async function searchFromWorker(domain, args) {
  let res = await fetchCatalog(domain, args, await getToken(domain));
  if (res.status === 401 || res.status === 403) res = await fetchCatalog(domain, args, await getToken(domain, { refresh: true }));
  if (res.ok) return summarizeCatalog(await res.json(), domain);
  const legacy = await fetch(legacyCatalogUrl(domain, args), { credentials: 'include', headers: { Accept: 'application/json' } }).catch(() => null);
  if (legacy?.ok) return summarizeCatalog(await legacy.json(), domain);
  throw new Error(`API Vinted ${res.status} — ouvre un onglet ${domain}, connecte-toi et réessaie.`);
}
