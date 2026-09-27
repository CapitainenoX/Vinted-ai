// Vinted AI — floating panel injected on Vinted (Shadow DOM so Vinted's CSS can't leak in).
(() => {
  const VAI = globalThis.VAI;
  const { esc, icon, send } = VAI;
  if (document.getElementById('vinted-ai-root')) return;

  const STATUS = { draft: 'Brouillon', listed: 'En vente', sold: 'Vendu', archived: 'Archivé' };
  const STATUS_CHIP = { draft: '', listed: 'accent', sold: 'success', archived: '' };
  const CONDITIONS = ['Neuf avec étiquette', 'Neuf sans étiquette', 'Très bon état', 'Bon état', 'Satisfaisant'];

  // ---------- mount ----------
  const host = document.createElement('div');
  host.id = 'vinted-ai-root';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;inset:auto 0 0 auto;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <link rel="stylesheet" href="${chrome.runtime.getURL('shared/tokens.css')}">
    <link rel="stylesheet" href="${chrome.runtime.getURL('content/panel.css')}">
    <button class="launcher" aria-label="Ouvrir Vinted AI" title="Vinted AI (Alt+V)">${icon('sparkles', 20)}</button>
    <aside class="panel" role="dialog" aria-label="Vinted AI" hidden>
      <header>
        <div class="brand">${icon('sparkles', 16)}<span>Vinted AI</span><span class="chip page-chip"></span></div>
        <div class="head-actions">
          <button class="icon-btn" data-act="clear" title="Nouvelle conversation">${icon('refresh')}</button>
          <button class="icon-btn" data-act="dashboard" title="Ouvrir le dashboard">${icon('chart')}</button>
          <button class="icon-btn" data-act="close" title="Fermer (Échap)">${icon('x')}</button>
        </div>
      </header>
      <nav class="tabs" role="tablist">
        <button role="tab" data-tab="listing">${icon('wand', 14)} Annonce</button>
        <button role="tab" data-tab="chat">${icon('chat', 14)} Agent</button>
        <button role="tab" data-tab="library">${icon('book', 14)} Bibliothèque</button>
      </nav>
      <section class="view" data-view="listing"></section>
      <section class="view" data-view="chat"></section>
      <section class="view" data-view="library"></section>
    </aside>`;
  document.documentElement.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const panel = $('.panel');
  const launcher = $('.launcher');
  let chat = null;
  let current = 'listing';

  // ---------- open / close / tabs ----------
  function open(tab) {
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('open'));
    launcher.classList.add('hidden');
    show(tab || current);
  }
  function close() {
    panel.classList.remove('open');
    launcher.classList.remove('hidden');
    setTimeout(() => !panel.classList.contains('open') && (panel.hidden = true), 280);
  }
  function show(tab) {
    current = tab;
    root.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
    root.querySelectorAll('.view').forEach((v) => (v.hidden = v.dataset.view !== tab));
    if (tab === 'chat' && !chat) initChat();
    if (tab === 'listing') renderListing();
    if (tab === 'library') renderLibrary();
  }
  launcher.onclick = () => open();
  root.querySelectorAll('[role=tab]').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  $('[data-act=close]').onclick = close;
  $('[data-act=dashboard]').onclick = () => send('dashboard:open', {});
  $('[data-act=clear]').onclick = () => chat?.clear();
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyV') panel.classList.contains('open') ? close() : open();
    if (e.key === 'Escape' && panel.classList.contains('open') && e.composedPath().includes(host)) close();
  });
  // Keystrokes inside the panel must not reach Vinted's handlers.
  panel.addEventListener('keydown', (e) => e.stopPropagation());

  const PAGE_LABEL = { form: 'Formulaire', item: 'Fiche article', inbox: 'Messages', profile: 'Profil', catalog: 'Catalogue', other: 'Vinted' };
  function pageContext() {
    const t = VAI.pageType();
    if (t === 'form') return `formulaire de création/édition d'annonce (${location.pathname})`;
    if (t === 'item') return `fiche article ${VAI.currentItemId()} (${location.pathname})`;
    return `${PAGE_LABEL[t]} (${location.pathname})`;
  }

  // ---------- chat ----------
  function initChat() {
    chat = new VAI.Chat({
      root: $('[data-view=chat]'),
      chatId: 'panel',
      canApply: true,
      getPageContext: pageContext,
      suggestions:
        VAI.pageType() === 'form'
          ? ['Rédige mon annonce depuis les photos', 'Quel prix pour vendre en 1 semaine ?', "Qu'est-ce qui manque à mon annonce ?"]
          : VAI.pageType() === 'item'
            ? ['Audite cette annonce', 'Ce prix est-il bon ?', 'Comment la faire remonter ?']
            : ['Mes stats de ventes', 'Quelles marques se vendent le mieux ?', 'Mes articles en vente depuis longtemps'],
    });
    $('[data-view=chat]').addEventListener('library-changed', () => VAI.refreshIndex());
  }
  VAI.applyListing = (listing) => VAI.fillForm(listing);

  // ---------- listing tab ----------
  let lastResult = null;
  let extraPhotos = [];
  let photoWatch = null;

  async function renderListing() {
    const view = $('[data-view=listing]');
    const type = VAI.pageType();
    if (type === 'item') return renderItemPage(view);
    if (type !== 'form') {
      view.innerHTML = `<div class="pad"><div class="card">
        <p><strong>Ouvre "Vendre"</strong> pour générer une annonce depuis tes photos, ou une fiche article pour l'auditer.</p>
        <p class="muted">Tu peux aussi glisser des photos dans l'onglet Agent n'importe où.</p>
        <button class="btn primary" data-act="sell">${icon('plus', 14)} Nouvelle annonce</button></div></div>`;
      view.querySelector('[data-act=sell]').onclick = () => (location.href = `${location.origin}/items/new`);
      return;
    }
    view.innerHTML = `<div class="pad">
      <div class="pending"></div>
      <div class="card">
        <div class="row-between"><strong>Photos de l'annonce</strong><button class="btn sm ghost" data-act="rescan">${icon('refresh', 12)} Rescanner</button></div>
        <div class="thumbs photos" style="margin-top:8px"></div>
        <label class="drop">${icon('upload', 14)} Ajouter / glisser des photos<input type="file" accept="image/*" multiple hidden></label>
        <span class="label">Infos en plus (optionnel)</span>
        <textarea class="textarea hint" rows="2" placeholder="Ex : taille M mais taille petit, porté 2 fois, acheté 80 €"></textarea>
        <div class="actions">
          <button class="btn primary" data-act="generate">${icon('sparkles', 14)} Générer l'annonce</button>
          <button class="btn" data-act="audit">${icon('target', 14)} Auditer</button>
        </div>
      </div>
      <div class="result"></div>
    </div>`;
    const photosEl = view.querySelector('.photos');
    const drawPhotos = async () => {
      photosEl.innerHTML = '<span class="spinner"></span>';
      const photos = [...(await VAI.getPhotos(3, 240)), ...extraPhotos].slice(0, 6);
      photosEl.innerHTML = photos.length ? photos.map((p) => `<div class="thumb"><img src="${p}" alt=""></div>`).join('') : '<span class="muted small">Aucune photo détectée — ajoute-les sur Vinted ou ici.</span>';
    };
    drawPhotos();
    view.querySelector('[data-act=rescan]').onclick = drawPhotos;
    // Photos are usually uploaded after the panel opens: redraw when the page's set changes.
    clearInterval(photoWatch);
    let sig = VAI.photoSignature();
    photoWatch = setInterval(() => {
      if (!view.isConnected || view.hidden || !panel.classList.contains('open')) return;
      const next = VAI.photoSignature();
      if (next !== sig) {
        sig = next;
        drawPhotos();
      }
    }, 1500);
    const fileInput = view.querySelector('.drop input');
    fileInput.onchange = async () => {
      for (const f of [...fileInput.files].slice(0, 3)) extraPhotos.push(await VAI.fileToDataUrl(f));
      extraPhotos = extraPhotos.slice(-3);
      drawPhotos();
    };
    const drop = view.querySelector('.drop');
    drop.ondragover = (e) => e.preventDefault();
    drop.ondrop = async (e) => {
      e.preventDefault();
      for (const f of [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')).slice(0, 3)) extraPhotos.push(await VAI.fileToDataUrl(f));
      extraPhotos = extraPhotos.slice(-3);
      drawPhotos();
    };

    view.querySelector('[data-act=generate]').onclick = (e) => generate(e.currentTarget, view);
    view.querySelector('[data-act=audit]').onclick = (e) => audit(e.currentTarget, view);
    if (lastResult) drawResult(view.querySelector('.result'), lastResult);
    renderPending(view.querySelector('.pending'));
  }

  async function busy(btn, fn) {
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> En cours…';
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.innerHTML = html;
    }
  }

  const errorCard = (msg) => `<div class="card error">${icon('x', 14)} ${esc(msg)}</div>`;

  async function generate(btn, view) {
    const out = view.querySelector('.result');
    out.innerHTML = '<p class="muted small">Analyse des photos → prix du marché → rédaction…</p>';
    await busy(btn, async () => {
      try {
        const pagePhotos = await VAI.getPhotos(3);
        const photos = [...pagePhotos, ...extraPhotos].slice(0, 3);
        if (!photos.length) throw new Error('Ajoute au moins une photo.');
        lastResult = await send('listing:generate', { photos, form: VAI.readForm(), hint: view.querySelector('.hint').value });
        drawResult(out, lastResult);
      } catch (e) {
        out.innerHTML = errorCard(e.message);
      }
    });
  }

  function drawResult(out, { listing: l, comps, vision }) {
    const f = (k, label, type = 'input') =>
      `<span class="label">${label}${k === 'title' ? ` <span class="count num">${(l.title || '').length}/100</span>` : ''}</span>` +
      (type === 'textarea'
        ? `<textarea class="textarea" data-k="${k}" rows="9">${esc(l[k] ?? '')}</textarea>`
        : type === 'condition'
          ? `<select class="select" data-k="${k}">${CONDITIONS.map((c) => `<option ${c === l[k] ? 'selected' : ''}>${c}</option>`).join('')}</select>`
          : `<input class="input" data-k="${k}" value="${esc(l[k] ?? '')}">`);
    out.innerHTML = `<div class="card fade-up">
      <div class="row-between"><strong>Annonce générée</strong>${l.score ? `<span class="chip ${l.score >= 80 ? 'success' : l.score >= 60 ? 'warn' : 'danger'} num">${l.score}/100</span>` : ''}</div>
      ${f('title', 'Titre')}
      ${f('description', 'Description', 'textarea')}
      <span class="label">Prix</span>
      <div class="price-row">
        <input class="input num" data-k="price" value="${esc(l.price ?? '')}" inputmode="decimal">
        ${l.price_fast ? `<button class="chip" data-price="${l.price_fast}">Rapide ${l.price_fast} €</button>` : ''}
        ${l.price_max ? `<button class="chip" data-price="${l.price_max}">Max ${l.price_max} €</button>` : ''}
      </div>
      ${l.price_reasoning ? `<p class="muted small">${esc(l.price_reasoning)}</p>` : ''}
      ${comps?.stats ? `<p class="small muted num">Marché : ${comps.count} annonces « ${esc(comps.query)} » · médiane <strong>${comps.stats.median} €</strong> · ${comps.stats.p25}–${comps.stats.p75} €</p>` : ''}
      <div class="grid2">
        <div>${f('brand', 'Marque')}</div><div>${f('size', 'Taille')}</div>
        <div>${f('condition', 'État', 'condition')}</div><div>${f('color', 'Couleur')}</div>
        <div>${f('material', 'Matière')}</div><div>${f('category', 'Catégorie')}</div>
      </div>
      ${l.tags?.length ? `<span class="label">Mots-clés</span><div class="tags">${l.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      ${l.missing?.length ? `<span class="label">À vérifier</span><ul class="list">${l.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
      ${l.tips?.length ? `<span class="label">Conseils</span><ul class="list">${l.tips.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
      ${vision?.defects?.length ? `<p class="small warn">Défauts vus : ${esc(vision.defects.join(', '))}</p>` : ''}
      <span class="label">Prix d'achat (pour ton bénéfice)</span>
      <input class="input num" data-k="cost" placeholder="optionnel" inputmode="decimal">
      <div class="actions sticky">
        <button class="btn primary" data-act="apply">${icon('wand', 14)} Appliquer au formulaire</button>
        <button class="btn" data-act="save">${icon('save', 14)} Bibliothèque</button>
        <button class="icon-btn" data-act="copy" title="Copier titre + description">${icon('copy')}</button>
      </div>
      <p class="small apply-report muted"></p>
    </div>`;
    const read = () => {
      const data = { ...l };
      out.querySelectorAll('[data-k]').forEach((el) => (data[el.dataset.k] = el.value));
      return data;
    };
    out.querySelector('[data-k=title]').oninput = (e) => (out.querySelector('.count').textContent = `${e.target.value.length}/100`);
    out.querySelectorAll('[data-price]').forEach((b) => (b.onclick = () => (out.querySelector('[data-k=price]').value = b.dataset.price)));
    out.querySelector('[data-act=apply]').onclick = (e) =>
      busy(e.currentTarget, async () => {
        const r = await VAI.fillForm(read());
        const report = out.querySelector('.apply-report');
        if (report) report.innerHTML =
          `${icon('check', 12)} Rempli : ${r.filled.join(', ') || 'rien'}` + (r.skipped.length ? `<br>À faire à la main : ${esc(r.skipped.join(' · '))}` : '');
      });
    out.querySelector('[data-act=save]').onclick = (e) =>
      busy(e.currentTarget, async () => {
        const item = await send('library:create', { data: { ...read(), photos: await VAI.getPhotos(4, 320) } });
        const report = out.querySelector('.apply-report');
        if (report) report.innerHTML = `${icon('check', 12)} Sauvé <span class="sku">${esc(item.sku)}</span> — note ce numéro sur le sachet de l'article.`;
      });
    out.querySelector('[data-act=copy]').onclick = () => {
      const d = read();
      navigator.clipboard.writeText(`${d.title}\n\n${d.description}`);
    };
  }

  async function audit(btn, view, form) {
    const out = view.querySelector('.result');
    await busy(btn, async () => {
      try {
        const { audit: a, comps } = await send('listing:audit', { form: form || VAI.readForm() });
        out.innerHTML = `<div class="card fade-up">
          <div class="row-between"><strong>Audit</strong><span class="chip ${a.score >= 80 ? 'success' : a.score >= 60 ? 'warn' : 'danger'} num">${a.score}/100</span></div>
          <p>${esc(a.verdict || '')}</p>
          ${comps?.stats ? `<p class="small muted num">Prix ${esc(a.price_position || '')} · médiane marché ${comps.stats.median} € sur ${comps.count} annonces</p>` : ''}
          ${a.missing?.length ? `<span class="label">Il manque</span><ul class="list">${a.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
          ${(a.improvements || []).map((i) => `<div class="improve"><span class="chip">${esc(i.field)}</span> ${esc(i.issue)}<div class="fix">${esc(i.fix)}</div></div>`).join('')}
          ${a.better_title ? `<span class="label">Titre conseillé</span><div class="copyable">${esc(a.better_title)}</div>` : ''}
          ${a.keywords_to_add?.length ? `<span class="label">Mots-clés à ajouter</span><div class="tags">${a.keywords_to_add.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
          ${VAI.pageType() === 'form' && a.better_title ? `<div class="actions"><button class="btn primary sm" data-act="use-title">${icon('wand', 12)} Appliquer le titre</button></div>` : ''}
        </div>`;
        out.querySelector('[data-act=use-title]')?.addEventListener('click', () => VAI.fillForm({ title: a.better_title }));
      } catch (e) {
        out.innerHTML = errorCard(e.message);
      }
    });
  }

  // Relist flow: an item from the library waits to be applied on a fresh form.
  let pendingItem = null;
  async function renderPending(el) {
    if (!pendingItem) return;
    el.innerHTML = `<div class="card accent-card fade-up">
      <strong>Republier <span class="sku">${esc(pendingItem.sku)}</span></strong>
      <p class="small">${esc(pendingItem.title || '')}</p>
      <div class="actions"><button class="btn primary sm" data-act="apply-pending">${icon('wand', 12)} Appliquer texte + photos</button>
      <button class="btn sm ghost" data-act="dismiss">Ignorer</button></div><p class="small muted report"></p></div>`;
    el.querySelector('[data-act=dismiss]').onclick = () => ((pendingItem = null), (el.innerHTML = ''));
    el.querySelector('[data-act=apply-pending]').onclick = (e) =>
      busy(e.currentTarget, async () => {
        const photosOk = await VAI.uploadPhotos(pendingItem.photos).catch(() => false);
        await new Promise((r) => setTimeout(r, 800));
        const r = await VAI.fillForm(pendingItem);
        el.querySelector('.report').textContent = `Rempli : ${r.filled.join(', ') || 'rien'}${photosOk ? ' + photos' : ' (ajoute les photos à la main)'}${r.skipped.length ? ' · À faire : ' + r.skipped.join(', ') : ''}`;
      });
  }

  // ---------- item page: link to library, notes, audit ----------
  async function renderItemPage(view) {
    const id = VAI.currentItemId();
    const info = VAI.readItemPage();
    const linked = id ? await send('library:get', { ref: id }).catch(() => null) : null;
    view.innerHTML = `<div class="pad">
      <div class="card">
        ${linked
          ? `<div class="row-between"><span class="sku big">${esc(linked.sku)}</span><span class="chip ${STATUS_CHIP[linked.status]}">${STATUS[linked.status]}</span></div>
             <p class="small">${esc(linked.title || '')}</p>
             <div class="grid2">
               <div><span class="label">Statut</span><select class="select" data-k="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === linked.status ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
               <div><span class="label">Vendu à (€)</span><input class="input num" data-k="soldPrice" value="${esc(linked.soldPrice ?? '')}" inputmode="decimal"></div>
               <div><span class="label">Coût d'achat</span><input class="input num" data-k="cost" value="${esc(linked.cost ?? '')}" inputmode="decimal"></div>
               <div><span class="label">Emplacement</span><input class="input" data-k="location" value="${esc(linked.location ?? '')}" placeholder="Bac A, étagère 2…"></div>
             </div>
             <span class="label">Notes</span><textarea class="textarea" data-k="notes" rows="3">${esc(linked.notes || '')}</textarea>
             <div class="actions"><button class="btn primary sm" data-act="save-link">${icon('save', 12)} Enregistrer</button><span class="small muted saved"></span></div>`
          : `<strong>Cet article n'est pas dans ta bibliothèque</strong>
             <p class="small muted">${esc(info.title)}</p>
             <p class="small">Lie-le pour lui donner un numéro (#0001…), l'annoter et le retrouver quand il est vendu.</p>
             <div class="actions"><button class="btn primary sm" data-act="link">${icon('link', 12)} Lier à ma bibliothèque</button></div>`}
      </div>
      <div class="card" style="margin-top:10px">
        <strong>Analyse de l'annonce</strong>
        <p class="small muted">Compare à la concurrence : prix, mots-clés, ce qui manque.</p>
        <div class="actions"><button class="btn sm" data-act="audit">${icon('target', 12)} Auditer cette annonce</button>
        <button class="btn sm ghost" data-act="ask">${icon('chat', 12)} Demander à l'agent</button></div>
      </div>
      <div class="result"></div></div>`;

    view.querySelector('[data-act=link]')?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const price = parseFloat(String(info.price).replace(/[^\d,.]/g, '').replace(',', '.'));
        await send('library:create', {
          data: { title: info.title, description: info.description, price: Number.isFinite(price) ? price : null, vintedId: id, vintedUrl: info.url, status: 'listed', photos: await VAI.getPhotos(3, 320) },
        });
        await VAI.refreshIndex();
        renderItemPage(view);
      }),
    );
    view.querySelector('[data-act=save-link]')?.addEventListener('click', async () => {
      const patch = {};
      view.querySelectorAll('[data-k]').forEach((el) => (patch[el.dataset.k] = el.value));
      await send('library:update', { ref: linked.id, patch });
      view.querySelector('.saved').textContent = 'Enregistré ✓';
      VAI.refreshIndex();
    });
    view.querySelector('[data-act=audit]').onclick = (e) =>
      audit(e.currentTarget, view, { title: info.title, description: info.description, price: info.price, ...info.details });
    view.querySelector('[data-act=ask]').onclick = () => {
      show('chat');
      chat.submit('Audite cette annonce face à la concurrence et dis-moi comment la faire remonter.');
    };
  }

  // ---------- library tab ----------
  async function renderLibrary() {
    const view = $('[data-view=library]');
    view.innerHTML = `<div class="pad">
      <div class="search"><span>${icon('search', 14)}</span><input class="input" placeholder="#0012, marque, note…" aria-label="Rechercher"></div>
      <div class="filters">${['', 'draft', 'listed', 'sold'].map((s) => `<button class="chip ${s === '' ? 'accent' : ''}" data-s="${s}">${s ? STATUS[s] : 'Tous'}</button>`).join('')}</div>
      <div class="items"></div></div>`;
    const items = await send('library:list').catch(() => []);
    let status = '';
    const list = view.querySelector('.items');
    const draw = () => {
      const q = view.querySelector('.search input').value.toLowerCase();
      const rows = items.filter((i) => (!status || i.status === status) && (!q || [i.sku, i.title, i.brand, i.notes, i.location].join(' ').toLowerCase().includes(q)));
      list.innerHTML = rows.length
        ? rows.slice(0, 100).map((i) => `
          <div class="item" data-id="${i.id}">
            <div class="item-row" tabindex="0">
              ${i.photos?.[0] ? `<img src="${i.photos[0]}" alt="">` : `<div class="ph">${icon('tag', 14)}</div>`}
              <div class="grow"><div><span class="sku">${esc(i.sku)}</span> <span class="chip ${STATUS_CHIP[i.status]}">${STATUS[i.status]}</span></div>
              <div class="t">${esc(i.title || 'Sans titre')}</div></div>
              <div class="num price">${i.status === 'sold' && i.soldPrice != null ? i.soldPrice : (i.price ?? '–')} €</div>
            </div>
          </div>`).join('')
        : `<p class="muted small center">Rien ici. Génère une annonce puis "Bibliothèque", ou lie une fiche article.</p>`;
      list.querySelectorAll('.item-row').forEach((row) => {
        row.onclick = () => toggleItem(row.parentElement, items.find((x) => x.id === row.parentElement.dataset.id));
        row.onkeydown = (e) => e.key === 'Enter' && row.click();
      });
    };
    view.querySelector('.search input').oninput = draw;
    view.querySelectorAll('.filters .chip').forEach((b) => (b.onclick = () => {
      status = b.dataset.s;
      view.querySelectorAll('.filters .chip').forEach((x) => x.classList.toggle('accent', x === b));
      draw();
    }));
    draw();
  }

  function toggleItem(el, item) {
    const existing = el.querySelector('.item-edit');
    if (existing) return existing.remove();
    el.insertAdjacentHTML('beforeend', `<div class="item-edit fade-up">
      <div class="grid2">
        <div><span class="label">Statut</span><select class="select" data-k="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === item.status ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div><span class="label">Vendu à (€)</span><input class="input num" data-k="soldPrice" value="${esc(item.soldPrice ?? '')}"></div>
        <div><span class="label">Emplacement</span><input class="input" data-k="location" value="${esc(item.location ?? '')}"></div>
        <div><span class="label">Acheteur</span><input class="input" data-k="buyer" value="${esc(item.buyer ?? '')}"></div>
      </div>
      <span class="label">Notes</span><textarea class="textarea" data-k="notes" rows="2">${esc(item.notes || '')}</textarea>
      <div class="actions">
        <button class="btn primary sm" data-act="save">${icon('save', 12)} Enregistrer</button>
        <button class="btn sm" data-act="relist" title="Ouvre un nouveau formulaire pré-rempli">${icon('refresh', 12)} Republier</button>
        ${item.vintedUrl ? `<a class="btn sm ghost" href="${esc(item.vintedUrl)}">${icon('external', 12)} Voir</a>` : ''}
        ${VAI.pageType() === 'form' ? `<button class="btn sm ghost" data-act="fill">${icon('wand', 12)} Remplir ici</button>` : ''}
      </div></div>`);
    const edit = el.querySelector('.item-edit');
    edit.querySelector('[data-act=save]').onclick = async (e) => {
      const patch = {};
      edit.querySelectorAll('[data-k]').forEach((f) => (patch[f.dataset.k] = f.value));
      Object.assign(item, await send('library:update', { ref: item.id, patch }));
      e.currentTarget.innerHTML = `${icon('check', 12)} OK`;
    };
    edit.querySelector('[data-act=relist]').onclick = () => send('relist', { ref: item.id });
    edit.querySelector('[data-act=fill]')?.addEventListener('click', () => VAI.fillForm(item));
  }

  // ---------- page-aware boot ----------
  function updatePageChip() {
    $('.page-chip').textContent = PAGE_LABEL[VAI.pageType()];
  }
  updatePageChip();

  async function boot() {
    const settings = await send('settings:get').catch(() => null);
    if (VAI.pageType() === 'form') {
      pendingItem = await send('pendingFill:take').catch(() => null);
      if (pendingItem || settings?.panelOpenOnForm) open('listing');
    }
  }
  boot();

  // Vinted is a SPA: watch URL changes and refresh the active view.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    lastResult = null;
    extraPhotos = [];
    updatePageChip();
    if (panel.classList.contains('open') && current !== 'chat') show(current);
  }, 800);
})();
