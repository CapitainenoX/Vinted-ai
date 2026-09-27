// Vinted AI — web search + page reading from the service worker.
// No DOMParser in a service worker, so HTML is handled with small regex helpers.

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();

export async function webSearch(query, settings, max = 6) {
  if (settings.tavilyKey) {
    try {
      return await tavily(query, settings.tavilyKey, max);
    } catch (e) {
      console.warn('Tavily failed, falling back to free search', e);
    }
  }
  const errors = [];
  for (const engine of [duckduckgo, duckduckgoLite]) {
    try {
      const r = await engine(query, max);
      if (r.results.length) return r;
      errors.push(`${engine.name} : 0 résultat`);
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(`Recherche web indisponible (${errors.join(' ; ')}). Ajoute une clé Tavily gratuite dans Paramètres.`);
}

async function tavily(query, key, max) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: max, search_depth: 'basic', include_answer: true }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = await res.json();
  return {
    answer: data.answer || null,
    results: (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: (r.content || '').slice(0, 300) })),
  };
}

// DuckDuckGo answers 403 to any request carrying `Origin: chrome-extension://…`;
// background.js strips that header with a declarativeNetRequest session rule.
async function duckduckgo(query, max) {
  const params = new URLSearchParams({ q: query, kl: 'fr-fr' });
  const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();
  const results = [];
  const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = blockRe.exec(html)) && results.length < max) {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    results.push({ title: decode(m[2]), url, snippet: decode(m[3] || '') });
  }
  if (!results.length && /anomaly|captcha/i.test(html)) throw new Error('DuckDuckGo captcha');
  return { answer: null, results };
}

async function duckduckgoLite(query, max) {
  const params = new URLSearchParams({ q: query, kl: 'fr-fr' });
  const res = await fetch(`https://lite.duckduckgo.com/lite/?${params}`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`DuckDuckGo Lite ${res.status}`);
  const html = await res.text();
  const results = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>)?/g;
  let m;
  while ((m = re.exec(html)) && results.length < max) {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:/.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    results.push({ title: decode(m[2]), url, snippet: decode(m[3] || '') });
  }
  return { answer: null, results };
}

export async function fetchUrl(url, maxChars = 6000) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL invalide');
  // Only fetch hosts the extension may reach; ask for the permission otherwise.
  const res = await fetch(url, { redirect: 'follow' }).catch(() => {
    throw new Error("Impossible d'ouvrir cette page (permission ou réseau).");
  });
  if (!res.ok) throw new Error(`Page inaccessible (${res.status})`);
  const type = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (type.includes('json')) return { url, title: '', text: raw.slice(0, maxChars) };
  const title = decode((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const metaDesc = decode((raw.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i) || [])[1] || '');
  const body = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|footer|header|svg|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h\d|tr|br)>/gi, '\n');
  const text = decode(body.replace(/\n/g, ' ¶ ')).replace(/( ¶ )+/g, '\n');
  return { url, title, text: (metaDesc ? metaDesc + '\n' : '') + text.slice(0, maxChars) };
}
