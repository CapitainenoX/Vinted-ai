// Vinted AI — comparable-listing search + price stats.
// Primary path: the content script on a Vinted tab calls the catalog API same-origin (session cookies).
// Fallback: the service worker calls it directly (works when the browser already has Vinted cookies).

export function summarizeCatalog(json, domain) {
  const raw = json?.items || [];
  const items = raw.map((i) => ({
    id: i.id,
    title: i.title,
    price: toNumber(i.price?.amount ?? i.price),
    total: toNumber(i.total_item_price?.amount ?? i.total_item_price),
    brand: i.brand_title || null,
    size: i.size_title || null,
    condition: i.status || null,
    favourites: i.favourite_count ?? null,
    views: i.view_count ?? null,
    url: i.url || (i.path ? `https://${domain}${i.path}` : `https://${domain}/items/${i.id}`),
    photo: i.photo?.url || i.photo?.thumbnails?.[0]?.url || null,
  }));
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

export function catalogUrl(domain, { query, order = 'relevance', price_from, price_to, limit = 30 }) {
  const params = new URLSearchParams({ search_text: query, per_page: String(Math.min(limit, 96)), page: '1', order });
  if (price_from) params.set('price_from', price_from);
  if (price_to) params.set('price_to', price_to);
  return `https://${domain}/api/v2/catalog/items?${params}`;
}

export async function searchFromWorker(domain, args) {
  const res = await fetch(catalogUrl(domain, args), { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`API Vinted ${res.status} — ouvre un onglet ${domain} et réessaie.`);
  return summarizeCatalog(await res.json(), domain);
}
