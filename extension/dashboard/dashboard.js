// Vinted AI — dashboard (extension page): overview, library, agent, settings.
import * as store from '../lib/storage.js';

const { esc, icon } = window.VAI;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const eur = (n) => (n == null || n === '' ? '–' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n));
const date = (t) => (t ? new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) : '–');
const STATUS_CHIP = { draft: '', listed: 'accent', sold: 'success', archived: '' };
const CONDITIONS = ['', 'Neuf avec étiquette', 'Neuf sans étiquette', 'Très bon état', 'Bon état', 'Satisfaisant'];
const DOMAINS = ['fr', 'be', 'es', 'it', 'de', 'nl', 'pl', 'pt', 'lu', 'at', 'co.uk', 'com', 'cz', 'lt', 'se', 'fi', 'dk', 'ie', 'sk', 'hu', 'ro', 'gr', 'hr'].map((d) => `www.vinted.${d}`);

const paintIcons = (root = document) => $$('[data-icon]', root).forEach((el) => !el.firstChild && (el.innerHTML = icon(el.dataset.icon)));
paintIcons();

// ---------- theme ----------
const themeBtn = $('#theme');
const applyTheme = (t) => {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  themeBtn.textContent = { light: 'Thème : clair', dark: 'Thème : sombre' }[t] || 'Thème : auto';
};
let theme = localStorage.getItem('vai-theme') || '';
applyTheme(theme);
themeBtn.onclick = () => {
  theme = { '': 'light', light: 'dark', dark: '' }[theme];
  localStorage.setItem('vai-theme', theme);
  applyTheme(theme);
};

// ---------- router ----------
const pages = { overview: renderOverview, library: renderLibrary, agent: renderAgent, settings: renderSettings };
function route() {
  const name = pages[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  $$('[data-page]').forEach((s) => (s.hidden = s.dataset.page !== name));
  $$('[data-route]').forEach((a) => a.classList.toggle('on', a.dataset.route === name));
  pages[name]();
}
window.addEventListener('hashchange', () => {
  $('#drawer').classList.remove('open');
  $('#drawer').hidden = $('#scrim').hidden = true;
  route();
});
chrome.storage.onChanged.addListener((c) => {
  // Refresh when the panel/agent changes the library — but never under an open editor.
  if (c.library && $('#drawer').hidden && ['overview', 'library', ''].includes(location.hash.slice(1))) route();
});

// ---------- overview ----------
async function renderOverview() {
  const [items, settings] = await Promise.all([store.listItems(), store.getSettings()]);
  $('#setup-banner').hidden = !!settings.apiKey || settings.provider === 'custom';
  const days = +$('#range').value;
  const since = days ? Date.now() - days * 86400000 : 0;
  const inRange = items.filter((i) => i.status !== 'sold' || (i.soldAt || 0) >= since);
  const s = store.computeStats([...inRange, ...(await store.listSalesArchive()).filter((i) => (i.soldAt || 0) >= since)], settings.feePercent);

  const kpis = [
    ['Chiffre d\'affaires', eur(s.revenue), `${s.sold} vente(s)`],
    ['Bénéfice', eur(s.profit), 'CA − coûts − frais'],
    ['Panier moyen', eur(s.avgBasket), ''],
    ['Délai de vente', s.avgDaysToSell == null ? '–' : `${s.avgDaysToSell} j`, 'moyenne'],
    ['En vente', String(s.listed), `stock ${eur(s.stockValue)}`],
    ['Taux d\'écoulement', `${s.sellThrough} %`, `${s.drafts} brouillon(s)`],
  ];
  $('#kpis').innerHTML = kpis.map(([k, v, sub]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');

  const all = await store.statsItems(); // includes sales of deleted items: a sale is never lost
  const soldAll = all.filter((i) => i.status === 'sold' && i.soldAt);
  const sold = soldAll.filter((i) => i.soldAt >= since);
  drawCumulative(sold);
  drawWeekly(sold, days || 365);
  drawHeatmap(sold);
  drawPublishHours(all.filter((i) => i.listedAt || (i.status !== 'draft' && i.createdAt)));
  drawDelay(sold);
  drawStatus(items);
  drawSales(sold);
  drawNotes(items);
  window.VAI.send('backup:info').then((b) => {
    $('#backup-line').textContent = b ? `Sauvegarde automatique : ${b.n} article(s) le ${new Date(b.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} (synchronisée avec ton compte Chrome). Tes ventes restent même si tu supprimes un article.` : '';
  }).catch(() => {});
  const max = s.topBrands[0]?.[1] || 1;
  $('#brands').innerHTML = s.topBrands.length
    ? s.topBrands.map(([b, v]) => `<div class="brand-row" data-tip="${esc(b)} : ${eur(v)}"><span>${esc(b)}</span><div class="track"><div class="fill" style="width:${(v / max) * 100}%"></div></div><span class="num">${eur(v)}</span></div>`).join('')
    : '<p class="muted small">Pas encore de ventes avec une marque renseignée.</p>';

  const stale = items.filter((i) => i.status === 'listed' && Date.now() - (i.listedAt || i.createdAt) > 21 * 86400000).sort((a, b) => (a.listedAt || a.createdAt) - (b.listedAt || b.createdAt));
  $('#stale').innerHTML = stale.length
    ? stale.slice(0, 10).map((i) => `<div class="stale-row">${thumb(i)}<div class="grow"><span class="sku">${esc(i.sku)}</span> ${esc(i.title || '')}<div class="muted small">${Math.floor((Date.now() - (i.listedAt || i.createdAt)) / 86400000)} jours · ${eur(i.price)} → conseillé ${eur(i.price ? Math.floor(i.price * 0.88) : null)}</div></div><button class="btn sm" data-relist="${i.id}">${icon('refresh', 12)} Republier</button><button class="btn sm ghost" data-open="${i.id}">Ouvrir</button></div>`).join('')
    : '<p class="muted small">Rien à relancer. 👌</p>';
  $$('[data-relist]').forEach((b) => (b.onclick = () => window.VAI.send('relist', { ref: b.dataset.relist })));
  $$('[data-open]', $('#stale')).forEach((b) => (b.onclick = () => openDrawer(items.find((i) => i.id === b.dataset.open))));
}
$('#range').onchange = renderOverview;

// ---------- charts (plain SVG, one accent hue, hover tooltip on every mark) ----------
const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const dow = (t) => (new Date(t).getDay() + 6) % 7;
const hour = (t) => new Date(t).getHours();
const when = (t) => new Date(t).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const saleValue = (i) => i.soldPrice ?? i.price ?? 0;
const emptyChart = (el, msg) => (($(el).innerHTML = `<p class="muted small empty-chart">${msg}</p>`), true);
// Bar with rounded data-end, square at the baseline.
const barPath = (x, y, w, h, r = 4) => {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};
const niceMax = (v) => {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1)));
  return Math.ceil(v / p) * p || 1;
};

// One tooltip for every chart: any element with data-tip.
const tip = document.createElement('div');
tip.className = 'tip';
tip.hidden = true;
document.body.appendChild(tip);
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) return (tip.hidden = true);
  tip.textContent = t.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8);
  tip.style.transform = `translate(${x}px, ${e.clientY - tip.offsetHeight - 10}px)`;
});

function drawCumulative(sold) {
  const pts = [...sold].sort((a, b) => a.soldAt - b.soldAt);
  $('#cum-total').textContent = pts.length ? `${eur(pts.reduce((a, i) => a + saleValue(i), 0))} · ${pts.length} vente(s)` : '';
  if (!pts.length) return emptyChart('#chart-cum', 'Ta première vente apparaîtra ici.');
  const W = 600, H = 200, pad = { l: 44, r: 12, t: 12, b: 24 };
  const t0 = Math.min(pts[0].soldAt, Date.now() - 7 * 86400000), t1 = Date.now();
  let acc = 0;
  const series = [{ t: t0, v: 0 }, ...pts.map((i) => ({ t: i.soldAt, v: (acc += saleValue(i)), i }))];
  series.push({ t: t1, v: acc });
  const top = niceMax(acc);
  const x = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  // Step line: revenue jumps at each sale.
  let d = `M${x(series[0].t)},${y(0)}`;
  for (let k = 1; k < series.length; k++) d += `H${x(series[k].t)}V${y(series[k].v)}`;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chiffre d'affaires cumulé">`;
  for (const f of [0, 0.5, 1]) svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(top * f)}" y2="${y(top * f)}"/><text x="${pad.l - 6}" y="${y(top * f) + 4}" text-anchor="end">${eur(top * f)}</text>`;
  svg += `<path class="area" d="${d}V${y(0)}Z"/><path class="line" d="${d}"/>`;
  for (const p of series.filter((p) => p.i)) svg += `<circle class="dot" cx="${x(p.t)}" cy="${y(p.v)}" r="4" data-tip="${esc(`${when(p.t)} · ${p.i.title || p.i.sku} · +${eur(saleValue(p.i))} → ${eur(p.v)}`)}"/>`;
  svg += `<text x="${pad.l}" y="${H - 6}">${date(t0)}</text><text x="${W - pad.r}" y="${H - 6}" text-anchor="end">aujourd'hui</text>`;
  $('#chart-cum').innerHTML = svg + '</svg>';
}

function drawWeekly(sold, days) {
  const weeks = Math.min(52, Math.max(4, Math.ceil(days / 7)));
  const start = startOfWeek(Date.now()) - (weeks - 1) * 7 * 86400000;
  const buckets = Array.from({ length: weeks }, (_, i) => ({ t: start + i * 7 * 86400000, v: 0, n: 0 }));
  for (const i of sold) {
    const idx = Math.floor((i.soldAt - start) / (7 * 86400000));
    if (idx >= 0 && idx < weeks) {
      buckets[idx].v += saleValue(i);
      buckets[idx].n++;
    }
  }
  const W = 600, H = 200, pad = { l: 44, r: 8, t: 12, b: 24 };
  const top = niceMax(Math.max(10, ...buckets.map((b) => b.v)));
  const bw = (W - pad.l - pad.r) / weeks;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chiffre d'affaires par semaine">`;
  for (const f of [0, 0.5, 1]) svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(top * f)}" y2="${y(top * f)}"/><text x="${pad.l - 6}" y="${y(top * f) + 4}" text-anchor="end">${eur(top * f)}</text>`;
  buckets.forEach((b, i) => {
    const bx = pad.l + i * bw + 1;
    // Hit target = the whole column, so empty weeks are hoverable too.
    svg += `<rect class="hit" x="${bx}" y="${pad.t}" width="${bw - 2}" height="${H - pad.t - pad.b}" data-tip="Semaine du ${date(b.t)} : ${eur(b.v)} · ${b.n} vente(s)"/>`;
    svg += `<path class="bar" d="${barPath(bx + bw * 0.12, y(b.v), bw * 0.76 - 2, y(0) - y(b.v))}" data-tip="Semaine du ${date(b.t)} : ${eur(b.v)} · ${b.n} vente(s)"/>`;
    if (i % Math.ceil(weeks / 8) === 0) svg += `<text x="${bx + bw / 2}" y="${H - 6}" text-anchor="middle">${date(b.t)}</text>`;
  });
  $('#chart').innerHTML = svg + '</svg>';
  $('#chart-total').textContent = `${eur(buckets.reduce((a, b) => a + b.v, 0))} sur ${weeks} semaines`;
}

function drawHeatmap(sold) {
  if (!sold.length) return emptyChart('#chart-heat', 'Les jours et heures de tes ventes s’afficheront ici.');
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const i of sold) grid[dow(i.soldAt)][hour(i.soldAt)]++;
  const max = Math.max(...grid.flat());
  const W = 600, cell = 20, gap = 2, l = 34, t = 4;
  const H = t + 7 * (cell + gap) + 20;
  const cw = (W - l - 4) / 24;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ventes par jour et heure">`;
  grid.forEach((row, d) => {
    svg += `<text x="${l - 6}" y="${t + d * (cell + gap) + cell / 2 + 4}" text-anchor="end">${DAYS[d]}</text>`;
    row.forEach((n, h) => {
      const op = n ? 0.25 + 0.75 * (n / max) : 1;
      svg += `<rect class="${n ? 'heat' : 'heat-0'}" x="${l + h * cw}" y="${t + d * (cell + gap)}" width="${cw - gap}" height="${cell}" rx="3" style="opacity:${op}" data-tip="${DAYS[d]} ${h} h–${h + 1} h : ${n} vente(s)"/>`;
    });
  });
  for (const h of [0, 6, 12, 18, 23]) svg += `<text x="${l + h * cw + cw / 2}" y="${H - 4}" text-anchor="middle">${h} h</text>`;
  $('#chart-heat').innerHTML = svg + '</svg>';
}

function drawPublishHours(listed) {
  const pubAt = (i) => i.listedAt || i.createdAt;
  if (!listed.length) {
    $('#pub-note').textContent = '';
    return emptyChart('#chart-pub', 'Publie des articles : je te montrerai les heures qui vendent le mieux.');
  }
  const hrs = Array.from({ length: 24 }, () => ({ n: 0, sold: 0 }));
  for (const i of listed) {
    const h = hrs[hour(pubAt(i))];
    h.n++;
    if (i.status === 'sold') h.sold++;
  }
  const best = hrs.map((h, k) => ({ k, rate: h.sold / (h.n || 1), n: h.n })).filter((h) => h.n >= 2).sort((a, b) => b.rate - a.rate)[0];
  $('#pub-note').textContent = best && best.rate > 0 ? `meilleur créneau : ${best.k} h (${Math.round(best.rate * 100)} % vendus)` : 'articles publiés par heure';
  const W = 600, H = 200, pad = { l: 28, r: 8, t: 12, b: 24 };
  const top = niceMax(Math.max(2, ...hrs.map((h) => h.n)));
  const bw = (W - pad.l - pad.r) / 24;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Articles publiés par heure, dont vendus">`;
  for (const f of [0, 1]) svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(top * f)}" y2="${y(top * f)}"/><text x="${pad.l - 6}" y="${y(top * f) + 4}" text-anchor="end">${Math.round(top * f)}</text>`;
  hrs.forEach((h, k) => {
    const bx = pad.l + k * bw + bw * 0.14, w = bw * 0.72;
    const tipText = `Publiés à ${k} h : ${h.n} · vendus ${h.sold}${h.n ? ` (${Math.round((h.sold / h.n) * 100)} %)` : ''}`;
    svg += `<rect class="hit" x="${pad.l + k * bw}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" data-tip="${tipText}"/>`;
    // Stacked: sold at the base, the rest above, with a 2px surface gap between.
    if (h.n - h.sold > 0) svg += `<path class="bar soft" d="${barPath(bx, y(h.n), w, y(h.sold) - y(h.n) - (h.sold ? 2 : 0))}" data-tip="${tipText}"/>`;
    if (h.sold) svg += `<path class="bar" d="${h.n - h.sold > 0 ? `M${bx},${y(0)}V${y(h.sold)}H${bx + w}V${y(0)}Z` : barPath(bx, y(h.sold), w, y(0) - y(h.sold))}" data-tip="${tipText}"/>`;
    if (k % 3 === 0) svg += `<text x="${pad.l + k * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${k} h</text>`;
  });
  $('#chart-pub').innerHTML = svg + '</svg><div class="legend"><span><i class="sw"></i>vendus</span><span><i class="sw soft"></i>pas encore vendus</span></div>';
}

function drawDelay(sold) {
  const withDelay = sold.filter((i) => i.listedAt || i.createdAt);
  if (!withDelay.length) return emptyChart('#chart-delay', 'Aucune vente sur la période.');
  const B = [['< 1 j', 1], ['1–3 j', 3], ['3–7 j', 7], ['1–2 sem.', 14], ['2–4 sem.', 30], ['> 1 mois', Infinity]];
  const counts = B.map(() => 0);
  for (const i of withDelay) {
    const d = (i.soldAt - (i.listedAt || i.createdAt)) / 86400000;
    counts[B.findIndex(([, lim]) => d < lim)]++;
  }
  const max = Math.max(...counts);
  $('#chart-delay').innerHTML = B.map(([label], k) => `<div class="hbar" data-tip="${label} : ${counts[k]} vente(s)"><span>${label}</span><div class="track"><div class="fill" style="width:${(counts[k] / max) * 100}%"></div></div><span class="num">${counts[k]}</span></div>`).join('');
}

function drawStatus(items) {
  const S = [['listed', 'En vente', 'st-listed'], ['sold', 'Vendus', 'st-sold'], ['draft', 'Brouillons', 'st-draft'], ['archived', 'Archivés', 'st-archived']];
  const counts = S.map(([k]) => items.filter((i) => i.status === k).length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return emptyChart('#chart-status', 'Ta bibliothèque est vide.');
  const R = 60, r = 40, C = 70;
  let a0 = -Math.PI / 2, svg = `<svg viewBox="0 0 140 140" class="donut" role="img" aria-label="Articles par statut">`;
  S.forEach(([, label, cls], k) => {
    if (!counts[k]) return;
    const a1 = a0 + (counts[k] / total) * Math.PI * 2 - (counts[k] === total ? 0.0001 : 0);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, a) => `${C + rad * Math.cos(a)},${C + rad * Math.sin(a)}`;
    svg += `<path class="${cls}" d="M${p(R, a0)}A${R},${R} 0 ${large} 1 ${p(R, a1)}L${p(r, a1)}A${r},${r} 0 ${large} 0 ${p(r, a0)}Z" data-tip="${label} : ${counts[k]} (${Math.round((counts[k] / total) * 100)} %)"/>`;
    a0 = a1;
  });
  svg += `<text x="70" y="68" text-anchor="middle" class="donut-v">${total}</text><text x="70" y="84" text-anchor="middle">articles</text></svg>`;
  $('#chart-status').innerHTML = `<div class="donut-wrap">${svg}<div class="legend col">${S.map(([, label, cls], k) => `<span><i class="sw ${cls}"></i>${label} <b class="num">${counts[k]}</b></span>`).join('')}</div></div>`;
}

function drawSales(sold) {
  const last = [...sold].sort((a, b) => b.soldAt - a.soldAt).slice(0, 8);
  $('#sales').innerHTML = last.length
    ? last.map((i) => {
        const d = i.listedAt || i.createdAt ? Math.max(0, Math.round((i.soldAt - (i.listedAt || i.createdAt)) / 86400000)) : null;
        const margin = i.cost != null ? saleValue(i) - i.cost : null;
        return `<div class="sale-row"><span class="sku">${esc(i.sku || '')}</span><div class="grow"><div class="ellipsis">${esc(i.title || '')}</div><div class="muted small">${when(i.soldAt)}${d != null ? ` · vendu en ${d} j` : ''}${i.deletedAt ? ' · supprimé de la bibliothèque' : ''}</div></div><div class="r"><div class="num">${eur(saleValue(i))}</div>${margin != null ? `<div class="small ${margin >= 0 ? 'pos' : 'neg'} num">${margin >= 0 ? '+' : ''}${eur(margin)}</div>` : ''}</div></div>`;
      }).join('')
    : '<p class="muted small">Quand tu marques un article « Vendu », la vente est enregistrée ici avec sa date et son heure.</p>';
}

function drawNotes(items) {
  const withNotes = items.filter((i) => i.notes?.trim()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 8);
  $('#notes').innerHTML = withNotes.length
    ? withNotes.map((i) => `<div class="note-row" data-open="${i.id}"><span class="sku">${esc(i.sku)}</span><div class="grow"><div class="ellipsis">${esc(i.notes)}</div><div class="muted small">${esc(i.title || '')} · ${date(i.updatedAt)}</div></div></div>`).join('')
    : '<p class="muted small">Ajoute des notes à tes articles (emplacement, défaut, acheteur…) : elles s’afficheront ici.</p>';
  $$('[data-open]', $('#notes')).forEach((el) => (el.onclick = () => openDrawer(items.find((i) => i.id === el.dataset.open))));
}
const startOfWeek = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
};
const thumb = (i) => (i.photos?.[0] ? `<img src="${i.photos[0]}" alt="">` : `<div class="ph">${icon('tag', 14)}</div>`);

// ---------- library ----------
let libState = { status: '', q: '', sort: 'updatedAt', dir: -1 };
async function renderLibrary() {
  const items = await store.listItems();
  const q = libState.q.toLowerCase();
  const rows = items
    .filter((i) => (!libState.status || i.status === libState.status) && (!q || [i.sku, i.title, i.brand, i.size, i.notes, i.location, i.buyer, (i.tags || []).join(' ')].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => {
      const av = a[libState.sort] ?? '', bv = b[libState.sort] ?? '';
      return (av > bv ? 1 : av < bv ? -1 : 0) * libState.dir;
    });
  $('#table tbody').innerHTML = rows
    .map((i) => {
      const margin = i.status === 'sold' && i.soldPrice != null ? i.soldPrice - (i.cost || 0) : null;
      return `<tr data-id="${i.id}">
        <td>${thumb(i)}</td>
        <td><span class="sku">${esc(i.sku)}</span></td>
        <td><div class="title">${esc(i.title || 'Sans titre')}</div><div class="sub">${esc([i.brand, i.size, i.location && '📦 ' + i.location].filter(Boolean).join(' · '))}</div></td>
        <td><span class="chip ${STATUS_CHIP[i.status]}">${store.STATUSES[i.status]}</span></td>
        <td class="r">${eur(i.price)}</td><td class="r">${eur(i.cost)}</td><td class="r">${eur(i.soldPrice)}</td>
        <td class="r ${margin == null ? '' : margin >= 0 ? 'pos' : 'neg'}">${margin == null ? '–' : eur(margin)}</td>
        <td class="r muted">${date(i.updatedAt)}</td></tr>`;
    })
    .join('');
  $('#empty').hidden = rows.length > 0;
  $$('#table tbody tr').forEach((tr) => (tr.onclick = () => openDrawer(items.find((i) => i.id === tr.dataset.id))));
}
$('#q').oninput = (e) => ((libState.q = e.target.value), renderLibrary());
$$('#status-filter button').forEach((b) => (b.onclick = () => {
  libState.status = b.dataset.s;
  $$('#status-filter button').forEach((x) => x.classList.toggle('on', x === b));
  renderLibrary();
}));
$$('#table th[data-sort]').forEach((th) => (th.onclick = () => {
  libState.dir = libState.sort === th.dataset.sort ? -libState.dir : 1;
  libState.sort = th.dataset.sort;
  renderLibrary();
}));
$('#new-item').onclick = async () => openDrawer(await store.createItem({ title: '' }));

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#export-json').onclick = async () => download(`vinted-ai-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await store.exportAll()), 'application/json');
$('#export-csv').onclick = async () => {
  const cols = ['sku', 'title', 'brand', 'size', 'condition', 'status', 'price', 'cost', 'soldPrice', 'buyer', 'location', 'notes', 'vintedUrl'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const items = await store.listItems();
  download('vinted-ai.csv', '﻿' + [cols.join(';'), ...items.map((i) => cols.map((c) => cell(i[c])).join(';'))].join('\n'), 'text/csv');
};
$('#import').onchange = async (e) => {
  try {
    const n = await store.importAll(JSON.parse(await e.target.files[0].text()));
    alert(`Import OK — ${n} articles dans la bibliothèque.`);
    renderLibrary();
  } catch (err) {
    alert('Import impossible : ' + err.message);
  }
  e.target.value = '';
};

// ---------- drawer ----------
function openDrawer(item) {
  if (!item) return;
  const d = $('#drawer');
  let photos = [...(item.photos || [])];
  const field = (k, label, type = 'text', extra = '') => `<div><label class="label" for="f-${k}">${label}</label><input class="input ${type === 'number' ? 'num' : ''}" id="f-${k}" data-k="${k}" type="${type}" step="0.01" value="${esc(item[k] ?? '')}" ${extra}></div>`;
  d.innerHTML = `
    <div class="head"><div class="sku-host"></div><button class="icon-btn" data-act="close" aria-label="Fermer">${icon('x')}</button></div>
    <p class="small sku-msg" hidden></p>
    <p class="muted small">Écris ce numéro sur le sachet de l'article : quand il est vendu, tu le retrouves en une seconde.</p>
    <div class="photos">${''}</div>
    <label class="label" for="f-title">Titre</label><input class="input" id="f-title" data-k="title" value="${esc(item.title || '')}">
    <label class="label" for="f-description">Description</label><textarea class="textarea" id="f-description" data-k="description" rows="7">${esc(item.description || '')}</textarea>
    <div class="grid-2">
      <div><label class="label" for="f-status">Statut</label><select class="select" id="f-status" data-k="status">${Object.entries(store.STATUSES).map(([k, v]) => `<option value="${k}" ${k === item.status ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div><label class="label" for="f-condition">État</label><select class="select" id="f-condition" data-k="condition">${CONDITIONS.map((c) => `<option ${c === (item.condition || '') ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      ${field('brand', 'Marque')}${field('size', 'Taille')}
      ${field('color', 'Couleur')}${field('material', 'Matière')}
      ${field('price', 'Prix affiché (€)', 'number')}${field('cost', "Prix d'achat (€)", 'number')}
      ${field('soldPrice', 'Vendu à (€)', 'number')}${field('buyer', 'Acheteur')}
      ${field('location', 'Emplacement (bac, étagère…)')}${field('vintedId', 'ID article Vinted')}
    </div>
    <label class="label" for="f-tags">Mots-clés</label><input class="input" id="f-tags" data-k="tags" value="${esc((item.tags || []).join(', '))}">
    <label class="label" for="f-notes">Notes</label><textarea class="textarea" id="f-notes" data-k="notes" rows="3">${esc(item.notes || '')}</textarea>
    <div class="timeline">${(item.history || []).map((h) => `${new Date(h.at).toLocaleString('fr-FR')} — ${h.event === 'renumbered' ? `numéro → ${esc(h.to)}` : store.STATUSES[h.event] || 'créé'}`).join('<br>')}</div>
    <div class="foot">
      <button class="btn primary" data-act="save">${icon('save', 14)} Enregistrer</button>
      <button class="btn" data-act="relist" title="Ouvre Vinted avec un formulaire pré-rempli">${icon('refresh', 14)} Republier</button>
      ${item.vintedUrl ? `<a class="btn ghost" href="${esc(item.vintedUrl)}" target="_blank" rel="noopener">${icon('external', 14)} Vinted</a>` : ''}
      <button class="btn ghost danger" data-act="delete" style="margin-left:auto">${icon('trash', 14)}</button>
    </div>`;
  const drawPhotos = () => {
    $('.photos', d).innerHTML =
      photos.map((p, i) => `<div class="photo"><img src="${p}" alt=""><button data-i="${i}" aria-label="Retirer">×</button></div>`).join('') +
      (photos.length < 8 ? `<label class="add-photo" title="Ajouter des photos">${icon('plus')}<input type="file" accept="image/*" multiple hidden></label>` : '');
    $$('.photo button', d).forEach((b) => (b.onclick = () => (photos.splice(+b.dataset.i, 1), drawPhotos())));
    const input = $('.add-photo input', d);
    if (input) input.onchange = async () => {
      for (const f of [...input.files].slice(0, 8 - photos.length)) photos.push(await window.VAI.fileToDataUrl(f, 480));
      drawPhotos();
    };
  };
  drawPhotos();
  drawNumber(d, item);
  const close = () => {
    d.classList.remove('open');
    $('#scrim').hidden = true;
    setTimeout(() => (d.hidden = true), 280);
  };
  $('[data-act=close]', d).onclick = close;
  $('#scrim').onclick = close;
  d.onkeydown = (e) => e.key === 'Escape' && close();
  $('[data-act=save]', d).onclick = async () => {
    const patch = { photos };
    $$('[data-k]', d).forEach((el) => (patch[el.dataset.k] = el.value));
    await store.updateItem(item.id, patch);
    close();
    route();
  };
  $('[data-act=relist]', d).onclick = () => window.VAI.send('relist', { ref: item.id });
  $('[data-act=delete]', d).onclick = async () => {
    if (!confirm(`Supprimer ${item.sku} ?`)) return;
    await store.deleteItem(item.id);
    close();
    route();
  };
  d.hidden = false;
  $('#scrim').hidden = false;
  requestAnimationFrame(() => d.classList.add('open'));
  $('#f-title', d).focus();
}

// Number editor in the drawer: "#0003 ✎" → input; if taken, offer to swap.
function drawNumber(d, item) {
  const host = $('.sku-host', d);
  const msg = $('.sku-msg', d);
  const show = () => {
    if (item.status === 'sold') {
      host.innerHTML = `<span class="sku sold">${esc(item.sku)}</span>${item.formerSku ? `<span class="muted small"> ancien n° ${esc(item.formerSku)} — sachet libre</span>` : ''}`;
      return;
    }
    host.innerHTML = `<button class="sku-btn" title="Changer le numéro"><span class="sku">${esc(item.sku)}</span>${icon('wand', 14)}</button>`;
    $('.sku-btn', host).onclick = edit;
  };
  const edit = () => {
    host.innerHTML = `<form class="sku-edit"><span class="sku">#</span><input class="input num" inputmode="numeric" maxlength="5" aria-label="Nouveau numéro" value="${store.skuNumber(item.sku)}"><button class="btn primary sm">OK</button><button class="btn ghost sm" type="button">Annuler</button></form>`;
    const input = $('input', host);
    input.select();
    $('button[type=button]', host).onclick = () => ((msg.hidden = true), show());
    $('form', host).onsubmit = (e) => (e.preventDefault(), apply(input.value, false));
  };
  const apply = async (n, swap) => {
    try {
      const r = await store.setItemNumber(item.id, n, { swap });
      item.sku = r.item.sku;
      msg.hidden = !r.swappedWith;
      if (r.swappedWith) msg.textContent = `Numéros échangés : l'autre article est maintenant ${r.swappedWith.sku}.`;
      show();
      renderLibrary();
    } catch (err) {
      msg.hidden = false;
      msg.textContent = err.message + ' ';
      if (err.code === 'SKU_TAKEN') {
        const b = document.createElement('button');
        b.className = 'btn sm';
        b.textContent = 'Échanger les numéros';
        b.onclick = () => apply(n, true);
        msg.appendChild(b);
      }
    }
  };
  show();
}

// ---------- agent ----------
let chat = null;
function renderAgent() {
  if (chat) return;
  chat = new window.VAI.Chat({
    root: $('#chat-root'),
    chatId: 'dashboard',
    suggestions: ['Analyse mes ventes et donne 3 actions', 'Quels articles relancer cette semaine ?', 'Prix du marché pour un jean Levi\'s 501 W32', 'Tendances vintage qui se vendent en ce moment'],
  });
}

// ---------- settings ----------
async function renderSettings() {
  const s = await store.getSettings();
  const form = $('#settings-form');
  $('#provider').innerHTML = Object.entries(store.PROVIDERS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  $('#vintedDomain').innerHTML = DOMAINS.map((d) => `<option>${d}</option>`).join('');
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!s[el.name];
    else el.value = s[el.name] ?? '';
  }
  const keyLink = () => {
    const p = store.PROVIDERS[$('#provider').value];
    $('#key-link').href = p.keyUrl || '#';
    $('#key-link').hidden = !p.keyUrl;
  };
  keyLink();
  $('#provider').onchange = () => {
    const p = store.PROVIDERS[$('#provider').value];
    $('#baseUrl').value = p.baseUrl;
    $('#chatModel').value = p.chatModel;
    $('#visionModel').value = p.visionModel;
    keyLink();
  };
}

function readSettingsForm() {
  const patch = {};
  for (const el of $('#settings-form').elements) {
    if (!el.name) continue;
    patch[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value || 0 : el.value.trim();
  }
  return patch;
}

// Hosts outside the manifest (custom/local endpoints) need a runtime permission.
async function ensureHostPermission(baseUrl) {
  try {
    const origin = new URL(baseUrl).origin + '/*';
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

$('#settings-form').onsubmit = async (e) => {
  e.preventDefault();
  const patch = readSettingsForm();
  const out = $('#save-out');
  if (!(await ensureHostPermission(patch.baseUrl))) {
    out.className = 'small ko';
    out.textContent = 'Permission refusée pour cette URL.';
    return;
  }
  await store.saveSettings(patch);
  out.className = 'small ok';
  out.textContent = 'Enregistré ✓';
  setTimeout(() => (out.textContent = ''), 2500);
};

$('#test').onclick = async () => {
  const out = $('#test-out');
  out.className = 'small muted';
  out.textContent = 'Test…';
  await ensureHostPermission($('#baseUrl').value);
  await store.saveSettings(readSettingsForm());
  try {
    const r = await window.VAI.send('llm:test');
    out.className = 'small ok';
    out.textContent = `Connecté ✓ (${String(r.reply).slice(0, 30)})`;
  } catch (err) {
    out.className = 'small ko';
    out.textContent = err.message;
  }
};

$('#load-models').onclick = async () => {
  const out = $('#test-out');
  await ensureHostPermission($('#baseUrl').value);
  await store.saveSettings(readSettingsForm());
  try {
    const models = await window.VAI.send('models:list');
    $('#models').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
    out.className = 'small ok';
    out.textContent = `${models.length} modèles disponibles — clique dans un champ modèle pour choisir.`;
  } catch (err) {
    out.className = 'small ko';
    out.textContent = err.message;
  }
};

$('#web-perm').onclick = async () => {
  const ok = await chrome.permissions.request({ origins: ['https://*/*'] });
  $('#perm-out').textContent = ok ? "Autorisé : l'agent peut lire les pages web." : 'Refusé.';
};

route();
