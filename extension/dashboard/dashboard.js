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
  const s = store.computeStats(inRange, settings.feePercent);

  const kpis = [
    ['Chiffre d\'affaires', eur(s.revenue), `${s.sold} vente(s)`],
    ['Bénéfice', eur(s.profit), 'CA − coûts − frais'],
    ['Panier moyen', eur(s.avgBasket), ''],
    ['Délai de vente', s.avgDaysToSell == null ? '–' : `${s.avgDaysToSell} j`, 'moyenne'],
    ['En vente', String(s.listed), `stock ${eur(s.stockValue)}`],
    ['Taux d\'écoulement', `${s.sellThrough} %`, `${s.drafts} brouillon(s)`],
  ];
  $('#kpis').innerHTML = kpis.map(([k, v, sub]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');

  drawWeekly(items.filter((i) => i.status === 'sold' && i.soldAt), days || 365);
  const max = s.topBrands[0]?.[1] || 1;
  $('#brands').innerHTML = s.topBrands.length
    ? s.topBrands.map(([b, v]) => `<div class="brand-row"><span>${esc(b)}</span><div class="track"><div class="fill" style="width:${(v / max) * 100}%"></div></div><span class="num">${eur(v)}</span></div>`).join('')
    : '<p class="muted small">Pas encore de ventes avec une marque renseignée.</p>';

  const stale = items.filter((i) => i.status === 'listed' && Date.now() - (i.listedAt || i.createdAt) > 21 * 86400000).sort((a, b) => (a.listedAt || a.createdAt) - (b.listedAt || b.createdAt));
  $('#stale').innerHTML = stale.length
    ? stale.slice(0, 10).map((i) => `<div class="stale-row">${thumb(i)}<div class="grow"><span class="sku">${esc(i.sku)}</span> ${esc(i.title || '')}<div class="muted small">${Math.floor((Date.now() - (i.listedAt || i.createdAt)) / 86400000)} jours · ${eur(i.price)} → conseillé ${eur(i.price ? Math.floor(i.price * 0.88) : null)}</div></div><button class="btn sm" data-relist="${i.id}">${icon('refresh', 12)} Republier</button><button class="btn sm ghost" data-open="${i.id}">Ouvrir</button></div>`).join('')
    : '<p class="muted small">Rien à relancer. 👌</p>';
  $$('[data-relist]').forEach((b) => (b.onclick = () => window.VAI.send('relist', { ref: b.dataset.relist })));
  $$('[data-open]', $('#stale')).forEach((b) => (b.onclick = () => openDrawer(items.find((i) => i.id === b.dataset.open))));
}
$('#range').onchange = renderOverview;

function drawWeekly(sold, days) {
  const weeks = Math.min(52, Math.max(4, Math.ceil(days / 7)));
  const start = startOfWeek(Date.now()) - (weeks - 1) * 7 * 86400000;
  const buckets = Array.from({ length: weeks }, (_, i) => ({ t: start + i * 7 * 86400000, v: 0, n: 0 }));
  for (const i of sold) {
    const idx = Math.floor((i.soldAt - start) / (7 * 86400000));
    if (idx >= 0 && idx < weeks) {
      buckets[idx].v += i.soldPrice ?? i.price ?? 0;
      buckets[idx].n++;
    }
  }
  const W = 600, H = 200, pad = { l: 36, r: 8, t: 10, b: 22 };
  const max = Math.max(10, ...buckets.map((b) => b.v));
  const nice = Math.ceil(max / 10) * 10;
  const bw = (W - pad.l - pad.r) / weeks;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / nice);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chiffre d'affaires par semaine">`;
  for (const f of [0, 0.5, 1]) svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(nice * f)}" y2="${y(nice * f)}"/><text x="${pad.l - 6}" y="${y(nice * f) + 4}" text-anchor="end">${Math.round(nice * f)}€</text>`;
  buckets.forEach((b, i) => {
    const h = y(0) - y(b.v);
    svg += `<rect class="bar" x="${pad.l + i * bw + bw * 0.15}" y="${y(b.v)}" width="${bw * 0.7}" height="${Math.max(h, b.v ? 2 : 0)}" rx="2"><title>Semaine du ${date(b.t)} : ${eur(b.v)} (${b.n} vente${b.n > 1 ? 's' : ''})</title></rect>`;
    if (i % Math.ceil(weeks / 8) === 0) svg += `<text x="${pad.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${date(b.t)}</text>`;
  });
  $('#chart').className = 'chart';
  $('#chart').innerHTML = svg + '</svg>';
  const total = buckets.reduce((a, b) => a + b.v, 0);
  $('#chart-total').textContent = `${eur(total)} sur ${weeks} semaines`;
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
    <div class="head"><span class="sku">${esc(item.sku)}</span><button class="icon-btn" data-act="close" aria-label="Fermer">${icon('x')}</button></div>
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
    <div class="timeline">${(item.history || []).map((h) => `${new Date(h.at).toLocaleString('fr-FR')} — ${store.STATUSES[h.event] || 'créé'}`).join('<br>')}</div>
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

// ---------- agent ----------
let chat = null;
function renderAgent() {
  if (chat) return;
  chat = new window.VAI.Chat({
    root: $('#chat-root'),
    chatId: 'dashboard',
    suggestions: ['Analyse mes ventes et donne 3 actions', 'Quels articles relancer cette semaine ?', 'Prix du marché pour un jean Levi\'s 501 W32', 'Tendances vintage qui se vendent en ce moment'],
  });
  $('#chat-clear').onclick = () => chat.clear();
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
