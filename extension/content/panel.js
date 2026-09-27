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
    </aside>
    <div class="toast" role="status" hidden></div>`;
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
    if (t === 'inbox' && VAI.currentConversationId()) {
      const c = VAI.readConversation();
      return `conversation Vinted${c.member?.login ? ` avec @${c.member.login}` : ''}${c.item ? ` à propos de "${c.item.title}" (article ${c.item.id})` : ''} — utilise read_page pour lire les messages`;
    }
    if (t === 'item') return `fiche article ${VAI.currentItemId()} (${location.pathname}) — ${ownership?.own ? "c'est l'annonce du vendeur (la sienne)" : "annonce d'un autre vendeur"}`;
    return `${PAGE_LABEL[t]} (${location.pathname})`;
  }

  // ---------- chat ----------
  function initChat() {
    chat = new VAI.Chat({
      root: $('[data-view=chat]'),
      chatId: 'panel',
      canApply: true,
      getPageContext: pageContext,
      suggestions: () =>
        VAI.pageType() === 'form'
          ? ['Rédige mon annonce depuis les photos', 'Quel prix pour vendre en 1 semaine ?', "Qu'est-ce qui manque à mon annonce ?"]
          : VAI.pageType() === 'item'
            ? ownership?.own
              ? ['Optimise mon annonce', 'Comment la faire remonter ?', 'Mon prix est-il bon ?']
              : ['Bonne affaire à revendre ?', 'Que fait-il mieux que moi ?', 'Prix du marché pour cet article']
            : VAI.pageType() === 'inbox'
              ? ['Propose 3 réponses à ce client', 'Ce client est-il sérieux ?', 'Quelle offre accepter ?']
              : ['Mes stats de ventes', 'Quelles marques se vendent le mieux ?', 'Mes articles en vente depuis longtemps'],
    });
    $('[data-view=chat]').addEventListener('library-changed', () => VAI.refreshIndex());
  }
  VAI.applyListing = (listing) => VAI.fillForm(listing);

  // ---------- agent edits, accepted one by one ----------
  // On the form: applied straight away. On my own item page: queued per item, applied on its edit form.
  const FILLABLE = ['title', 'description', 'price', 'brand', 'size', 'condition', 'color', 'material'];
  const EDIT_LABELS = { title: 'titre', description: 'description', price: 'prix', brand: 'marque', size: 'taille', condition: 'état', color: 'couleur', material: 'matière' };
  VAI.applyMode = () => (VAI.pageType() === 'form' ? 'fill' : VAI.pageType() === 'item' && ownership?.own ? 'queue' : null);
  VAI.applyEdit = async (field, value) => {
    if (!FILLABLE.includes(field)) return null; // e.g. category: copied, chosen by hand
    const mode = VAI.applyMode();
    if (mode === 'fill') {
      const r = await VAI.fillForm({ [field]: value });
      return r.filled.length ? { status: 'applied' } : { status: 'failed', message: r.skipped[0] || 'Champ introuvable' };
    }
    if (mode === 'queue') {
      const id = VAI.currentItemId();
      const all = await getAccepted();
      all[id] = { fields: { ...(all[id]?.fields || {}), [field]: value }, at: Date.now() };
      await chrome.storage.local.set({ acceptedEdits: all });
      drawAccepted(root.querySelector('.accepted-edits'));
      return { status: 'queued' };
    }
    return null;
  };
  const getAccepted = async () => {
    const { acceptedEdits = {} } = await chrome.storage.local.get('acceptedEdits');
    // Drop anything older than 7 days.
    for (const [k, v] of Object.entries(acceptedEdits)) if (Date.now() - v.at > 7 * 864e5) delete acceptedEdits[k];
    return acceptedEdits;
  };
  const clearAccepted = async (id) => {
    const all = await getAccepted();
    delete all[id];
    await chrome.storage.local.set({ acceptedEdits: all });
  };

  // Item page: "N modifications acceptées → Modifier sur Vinted". Edit form: "Appliquer les N modifications".
  async function drawAccepted(el) {
    if (!el) return;
    const id = VAI.currentItemId();
    const fields = (await getAccepted())[id]?.fields;
    const keys = Object.keys(fields || {});
    if (!keys.length) return (el.innerHTML = '');
    const list = keys.map((k) => EDIT_LABELS[k] || k).join(', ');
    if (VAI.pageType() === 'form') {
      el.innerHTML = `<div class="card accent-card fade-up">
        <strong>${keys.length} modification(s) acceptée(s) dans l'agent</strong>
        <p class="small">${esc(list)}</p>
        <div class="actions"><button class="btn primary sm" data-act="apply-accepted">${icon('wand', 12)} Appliquer au formulaire</button>
        <button class="btn sm ghost" data-act="drop-accepted">Oublier</button></div><p class="small muted report"></p></div>`;
      el.querySelector('[data-act=drop-accepted]').onclick = async () => (await clearAccepted(id), (el.innerHTML = ''));
      el.querySelector('[data-act=apply-accepted]').onclick = (e) =>
        busy(e.currentTarget, async () => {
          const r = await VAI.fillForm(fields);
          await clearAccepted(id);
          el.querySelector('.report').textContent = `Rempli : ${r.filled.map((k) => EDIT_LABELS[k] || k).join(', ') || 'rien'}${r.skipped.length ? ' · À faire : ' + r.skipped.join(', ') : ''}. Vérifie puis enregistre sur Vinted.`;
        });
    } else {
      el.innerHTML = `<div class="card accent-card fade-up">
        <strong>${keys.length} modification(s) acceptée(s)</strong>
        <p class="small">${esc(list)} — elles seront appliquées sur le formulaire de modification.</p>
        <div class="actions"><a class="btn primary sm" href="${esc(location.origin)}/items/${esc(id)}/edit">${icon('external', 12)} Modifier sur Vinted</a>
        <button class="btn sm ghost" data-act="drop-accepted">Oublier</button></div></div>`;
      el.querySelector('[data-act=drop-accepted]').onclick = async () => (await clearAccepted(id), (el.innerHTML = ''));
    }
  }

  // ---------- listing tab ----------
  let lastResult = null;
  let extraPhotos = [];
  let photoWatch = null;

  async function renderListing() {
    const view = $('[data-view=listing]');
    const type = VAI.pageType();
    if (type === 'item') return renderItemPage(view);
    if (type === 'inbox') return renderInbox(view);
    if (type !== 'form') {
      view.innerHTML = `<div class="pad"><div class="card">
        <p><strong>Ouvre "Vendre"</strong> pour générer une annonce depuis tes photos, ou une fiche article pour l'auditer.</p>
        <p class="muted">Tu peux aussi glisser des photos dans l'onglet Agent n'importe où.</p>
        <button class="btn primary" data-act="sell">${icon('plus', 14)} Nouvelle annonce</button></div></div>`;
      view.querySelector('[data-act=sell]').onclick = () => (location.href = `${location.origin}/items/new`);
      return;
    }
    view.innerHTML = `<div class="pad">
      <div class="accepted-edits"></div>
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
    drawAccepted(view.querySelector('.accepted-edits'));
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
        // What's really on the Vinted form wins over the generated text (the seller may have edited it).
        const item = await send('library:create', { data: { ...read(), ...VAI.readFormData(), photos: await VAI.getPhotos(4, 320) } });
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

  // ---------- number editor (#0001) — shared by the item page and the library tab ----------
  // Renders "#0003 ✎"; click → inline input. If the number is taken, offers to swap.
  function numberEditor(host, item, onChange) {
    const draw = () => {
      host.innerHTML = `<button class="sku-btn" title="Changer le numéro"><span class="sku big">${esc(item.sku)}</span>${icon('wand', 12)}</button>`;
      host.querySelector('.sku-btn').onclick = edit;
    };
    const edit = () => {
      host.innerHTML = `<form class="sku-edit"><span class="sku">#</span><input class="input num" inputmode="numeric" maxlength="5" value="${esc(String(parseInt(item.sku.slice(1), 10)))}" aria-label="Nouveau numéro">
        <button class="btn primary sm" type="submit">${icon('check', 12)}</button><button class="btn ghost sm" type="button" data-act="cancel">${icon('x', 12)}</button></form><p class="small sku-msg"></p>`;
      const input = host.querySelector('input');
      input.focus();
      input.select();
      host.querySelector('[data-act=cancel]').onclick = draw;
      host.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        await apply(input.value, false);
      };
    };
    const apply = async (number, swap) => {
      const msg = host.querySelector('.sku-msg');
      try {
        const r = await send('library:setNumber', { ref: item.id, number, swap });
        if (r.conflict) {
          msg.innerHTML = `${esc(r.message)} <button class="btn sm" data-act="swap">Échanger les numéros</button>`;
          msg.querySelector('[data-act=swap]').onclick = () => apply(number, true);
          return;
        }
        Object.assign(item, r.item);
        draw();
        VAI.refreshIndex();
        onChange?.(r);
      } catch (err) {
        msg.textContent = err.message;
      }
    };
    draw();
  }

  // ---------- item page: menu adapts to "my listing" vs "someone else's" ----------
  let ownership = null;

  function statusFields(item) {
    return `<div class="grid2">
      <div><span class="label">Statut</span><select class="select" data-k="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === item.status ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div><span class="label">Vendu à (€)</span><input class="input num" data-k="soldPrice" value="${esc(item.soldPrice ?? '')}" inputmode="decimal"></div>
      <div><span class="label">Coût d'achat</span><input class="input num" data-k="cost" value="${esc(item.cost ?? '')}" inputmode="decimal"></div>
      <div><span class="label">Emplacement</span><input class="input" data-k="location" value="${esc(item.location ?? '')}" placeholder="Bac A, étagère 2…"></div>
    </div>
    <span class="label">Notes</span><textarea class="textarea" data-k="notes" rows="3">${esc(item.notes || '')}</textarea>`;
  }

  async function renderItemPage(view) {
    const id = VAI.currentItemId();
    const info = VAI.readItemPage();
    view.innerHTML = '<div class="pad"><span class="spinner"></span></div>';
    ownership = await VAI.detectOwnership();
    const own = ownership.own;
    const linked = ownership.linked || (id ? await send('library:get', { ref: id }).catch(() => null) : null);
    const nextNumber = linked ? null : await send('library:nextNumber').catch(() => null);
    const priceNum = parseFloat(String(info.price).replace(/[^\d,.]/g, '').replace(',', '.'));

    const ownerBar = `<div class="owner-bar ${own ? 'mine' : ''}">
      <span class="chip ${own ? 'accent' : ''}">${own ? `${icon('tag', 12)} Mon annonce` : `${icon('search', 12)} Annonce d'un autre vendeur`}</span>
      <span class="small muted">${esc(ownership.reason)}</span>
      <button class="btn ghost sm" data-act="flip">${own ? 'Pas la mienne ?' : "C'est la mienne ?"}</button>
    </div>
    ${ownership.confident ? '' : `<div class="card ask-owner"><strong>C'est ton annonce ?</strong><div class="actions"><button class="btn primary sm" data-own="1">Oui, c'est la mienne</button><button class="btn sm" data-own="0">Non</button></div></div>`}`;

    const mine = linked
      ? `<div class="card">
          <div class="row-between"><div class="sku-host"></div><span class="chip ${STATUS_CHIP[linked.status]}">${STATUS[linked.status]}</span></div>
          <p class="small">${esc(linked.title || '')}</p>
          ${statusFields(linked)}
          <div class="actions"><button class="btn primary sm" data-act="save-link">${icon('save', 12)} Enregistrer</button><span class="small muted saved"></span></div>
        </div>`
      : `<div class="card">
          <strong>Pas encore dans ta bibliothèque</strong>
          <p class="small">Ajoute-la : elle recevra le numéro <span class="sku">${esc(nextNumber || '')}</span> (modifiable) à écrire sur le sachet.</p>
          <div class="actions"><button class="btn primary sm" data-act="link">${icon('link', 12)} Ajouter à ma bibliothèque</button></div>
        </div>`;

    const myTools = `<div class="card">
        <strong>Booster mon annonce</strong>
        <div class="tool-grid">
          <button class="btn sm" data-act="audit">${icon('target', 12)} Optimiser (audit)</button>
          <button class="btn sm" data-ask="Ma annonce stagne : comment la faire remonter ? Donne un plan concret (baisse de prix, republication, photos, titre, horaire).">${icon('refresh', 12)} Faire remonter</button>
          <button class="btn sm" data-ask="Mon prix est-il bien placé face aux annonces comparables ? Donne le prix pour vendre en 7 jours.">${icon('tag', 12)} Vérifier mon prix</button>
          <button class="btn sm" data-act="favorites">${icon('chat', 12)} Messages aux favoris</button>
          ${linked ? `<button class="btn sm" data-act="relist">${icon('plus', 12)} Republier</button>` : ''}
          <a class="btn sm ghost" href="${esc(location.origin)}/items/${esc(id)}/edit">${icon('external', 12)} Modifier sur Vinted</a>
        </div>
      </div>`;

    const theirTools = `<div class="card">
        <strong>Analyser ce concurrent</strong>
        <p class="small muted">${esc(info.title)}${Number.isFinite(priceNum) ? ` · <span class="num">${priceNum} €</span>` : ''}</p>
        <div class="tool-grid">
          <button class="btn sm" data-act="audit">${icon('target', 12)} Position marché</button>
          <button class="btn sm" data-ask="Est-ce une bonne affaire à acheter pour revendre ? Donne le prix de revente probable, la marge, et le prix d'achat max à proposer.">${icon('tag', 12)} Bonne affaire à revendre ?</button>
          <button class="btn sm" data-ask="Qu'est-ce que cette annonce fait mieux ou moins bien que les miennes ? Compare avec ma bibliothèque et donne 3 choses à copier.">${icon('book', 12)} Comparer à mes annonces</button>
          <button class="btn sm" data-ask="Rédige une offre polie et efficace à envoyer à ce vendeur pour négocier le prix.">${icon('chat', 12)} Message de négociation</button>
        </div>
      </div>
      <div class="card">
        <strong>Tu l'as acheté ?</strong>
        <p class="small">Ajoute-le à ta bibliothèque comme article à revendre (coût = ${Number.isFinite(priceNum) ? priceNum + ' €' : 'prix payé'}) avec le numéro <span class="sku">${esc(nextNumber || '')}</span>.</p>
        <div class="actions"><button class="btn sm" data-act="bought">${icon('plus', 12)} Ajouter comme achat</button><span class="small muted bought-msg"></span></div>
      </div>`;

    view.innerHTML = `<div class="pad stack">${ownerBar}${own ? '<div class="accepted-edits"></div>' + mine + myTools : theirTools}<div class="result"></div></div>`;
    if (linked && own) numberEditor(view.querySelector('.sku-host'), linked);
    if (own) drawAccepted(view.querySelector('.accepted-edits'));

    const rerender = () => renderItemPage(view);
    view.querySelector('[data-act=flip]').onclick = async () => {
      await VAI.setOwnOverride(!own);
      rerender();
    };
    view.querySelectorAll('[data-own]').forEach((b) => (b.onclick = async () => {
      await VAI.setOwnOverride(b.dataset.own === '1');
      rerender();
    }));
    view.querySelector('[data-act=link]')?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        await send('library:create', {
          data: { title: info.title, description: info.description, price: Number.isFinite(priceNum) ? priceNum : null, vintedId: id, vintedUrl: info.url, status: 'listed', photos: await VAI.getPhotos(3, 320) },
        });
        await VAI.refreshIndex();
        rerender();
      }),
    );
    view.querySelector('[data-act=bought]')?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const item = await send('library:create', {
          data: { title: info.title, description: info.description, cost: Number.isFinite(priceNum) ? priceNum : null, status: 'draft', notes: `Acheté sur Vinted : ${info.url}`, photos: await VAI.getPhotos(3, 320) },
        });
        view.querySelector('.bought-msg').innerHTML = `Ajouté <span class="sku">${esc(item.sku)}</span> ✓`;
      }),
    );
    view.querySelector('[data-act=save-link]')?.addEventListener('click', async () => {
      const patch = {};
      view.querySelectorAll('[data-k]').forEach((el) => (patch[el.dataset.k] = el.value));
      await send('library:update', { ref: linked.id, patch });
      view.querySelector('.saved').textContent = 'Enregistré ✓';
      VAI.refreshIndex();
    });
    view.querySelector('[data-act=relist]')?.addEventListener('click', () => send('relist', { ref: linked.id }));
    view.querySelector('[data-act=favorites]')?.addEventListener('click', (e) =>
      busy(e.currentTarget, () =>
        messageStudio(view.querySelector('.result'), {
          mode: 'favorites',
          item: { id, title: info.title, price: info.price },
          title: 'Messages aux favoris',
          hint: 'Sur Vinted : ouvre l’article → « Favoris » ou l’offre aux intéressés, puis colle le message.',
        }),
      ),
    );
    view.querySelector('[data-act=audit]').onclick = (e) =>
      audit(e.currentTarget, view, { title: info.title, description: info.description, price: info.price, ...info.details, isMyListing: own });
    view.querySelectorAll('[data-ask]').forEach((b) => (b.onclick = () => {
      show('chat');
      chat.submit(b.dataset.ask);
    }));
  }

  // ---------- messages: 3 suggestions for a conversation or an item's favourites ----------
  const REPLY_KIND = { reply: 'Répondre', follow_up: 'Relancer', offer: 'Offre', bundle: 'Lot', custom: 'Message' };
  const QUICK_ASKS = ["Accepte l'offre", 'Contre-offre raisonnable', 'Refuse poliment', "Dis que j'envoie demain", 'Propose un lot'];
  const suggestionCache = new Map(); // conversation + last message → result (no new tokens when reopening)

  // Renders the instruction box + 3 editable drafts into `el`. opts: { mode, conversation?, item?, title, hint? }
  async function messageStudio(el, opts, { auto = true } = {}) {
    el.innerHTML = `<div class="card studio fade-up">
      <div class="row-between"><strong>${esc(opts.title)}</strong><span class="small muted studio-state"></span></div>
      <p class="small muted studio-summary"></p>
      <span class="label">Ce que tu veux dire (optionnel)</span>
      <textarea class="textarea instruction" rows="2" placeholder="Ex : accepte 18 €, envoi demain, reste ferme sur le prix…"></textarea>
      <div class="chips">${(opts.mode === 'favorites' ? ['-15 % pour 48 h', 'Relance courte', 'Lot -20 %'] : QUICK_ASKS).map((q) => `<button class="chip-btn" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <div class="actions"><button class="btn primary sm" data-act="gen">${icon('sparkles', 12)} Proposer 3 messages</button></div>
      <div class="suggestions"></div>
      ${opts.hint ? `<p class="small muted">${esc(opts.hint)}</p>` : ''}
    </div>`;
    const box = el.querySelector('.studio');
    const instr = box.querySelector('.instruction');
    const list = box.querySelector('.suggestions');
    const canInsert = VAI.pageType() === 'inbox';
    const draw = (res) => {
      box.querySelector('.studio-summary').textContent = [res.summary, res.intent && `Client : ${res.intent}`].filter(Boolean).join(' · ');
      box.querySelector('.studio-state').innerHTML = res.libItem ? `<span class="sku">${esc(res.libItem.sku)}</span>` : '';
      list.innerHTML = res.replies
        .map(
          (r, i) => `<div class="suggestion" data-i="${i}">
            <div class="row-between"><span class="chip ${r.kind === 'offer' ? 'accent' : ''}">${esc(REPLY_KIND[r.kind] || 'Message')}</span><span class="small muted">${esc(r.label)}${r.price != null ? ` · <span class="num">${esc(r.price)} €</span>` : ''}</span></div>
            <textarea class="textarea" rows="3" aria-label="Message ${i + 1}">${esc(r.text)}</textarea>
            <div class="actions">
              ${canInsert ? `<button class="btn primary sm" data-act="insert">${icon('send', 12)} Mettre dans la réponse</button>` : ''}
              <button class="btn sm ${canInsert ? 'ghost' : 'primary'}" data-act="copy">${icon('copy', 12)} Copier</button>
              <span class="small muted done"></span>
            </div>
          </div>`,
        )
        .join('');
      list.querySelectorAll('.suggestion').forEach((sEl) => {
        const text = () => sEl.querySelector('textarea').value;
        const done = (t) => (sEl.querySelector('.done').textContent = t);
        sEl.querySelector('[data-act=insert]')?.addEventListener('click', () =>
          done(VAI.insertMessage(text()) ? 'Dans la zone de message ✓ — relis puis envoie' : 'Zone de message introuvable : utilise Copier'),
        );
        sEl.querySelector('[data-act=copy]').onclick = async () => {
          await navigator.clipboard.writeText(text());
          done('Copié ✓');
        };
      });
    };
    const generate = async (btn) => {
      const instruction = instr.value.trim();
      // Re-read the thread: new messages may have arrived since the panel opened.
      const conversation = opts.mode === 'reply' ? VAI.readConversation() : null;
      const key = `${opts.mode}|${conversation?.conversationId || opts.item?.id}|${conversation?.messages.at(-1)?.text || ''}|${instruction}`;
      const run = async () => {
        const res = suggestionCache.get(key) || (await send('messages:suggest', { mode: opts.mode, conversation, item: opts.item || null, instruction }));
        suggestionCache.set(key, res);
        draw(res);
      };
      list.innerHTML = '<p class="small muted"><span class="spinner"></span> Rédaction de 3 messages…</p>';
      try {
        await (btn ? busy(btn, run) : run());
      } catch (e) {
        list.innerHTML = errorCard(e.message);
      }
    };
    box.querySelector('[data-act=gen]').onclick = (e) => generate(e.currentTarget);
    box.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => {
      instr.value = b.dataset.q;
      generate(box.querySelector('[data-act=gen]'));
    }));
    instr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        generate(box.querySelector('[data-act=gen]'));
      }
    });
    if (auto) await generate();
  }

  async function renderInbox(view) {
    if (!VAI.currentConversationId()) {
      view.innerHTML = `<div class="pad"><div class="card"><strong>Ouvre une conversation</strong>
        <p class="small muted">Je détecte l'article et le client, et je te propose 3 messages : réponse, relance, offre.</p></div></div>`;
      return;
    }
    const conv = VAI.readConversation();
    view.innerHTML = `<div class="pad stack">
      <div class="card conv-head">
        <div class="row-between"><strong>${conv.member?.login ? `@${esc(conv.member.login)}` : 'Conversation'}</strong>
          <button class="btn ghost sm" data-act="reread" title="Relire la conversation">${icon('refresh', 12)} Relire</button></div>
        ${conv.item ? `<p class="small">${icon('tag', 12)} <a href="${esc(conv.item.url)}">${esc(conv.item.title || 'Article ' + conv.item.id)}</a>${conv.item.price ? ` · <span class="num">${esc(conv.item.price)}</span>` : ''}</p>` : '<p class="small muted">Article non détecté dans la conversation.</p>'}
        <p class="small muted">${conv.messages.length ? `${conv.messages.length} message(s) lu(s)` : 'Messages lus en texte brut'}${conv.messages.at(-1) ? ` · dernier : ${conv.messages.at(-1).from === 'me' ? 'toi' : 'le client'}` : ''}</p>
      </div>
      <div class="studio-host"></div>
    </div>`;
    view.querySelector('[data-act=reread]').onclick = () => renderInbox(view);
    await messageStudio(view.querySelector('.studio-host'), { mode: 'reply', title: '3 messages pour ce client' });
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
      <div class="sku-host"></div>
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
    numberEditor(edit.querySelector('.sku-host'), item, () => (el.querySelector('.item-row .sku').textContent = item.sku));
    edit.querySelector('[data-act=save]').onclick = async (e) => {
      const patch = {};
      edit.querySelectorAll('[data-k]').forEach((f) => (patch[f.dataset.k] = f.value));
      Object.assign(item, await send('library:update', { ref: item.id, patch }));
      e.currentTarget.innerHTML = `${icon('check', 12)} OK`;
    };
    edit.querySelector('[data-act=relist]').onclick = () => send('relist', { ref: item.id });
    edit.querySelector('[data-act=fill]')?.addEventListener('click', () => VAI.fillForm(item));
  }

  // The agent's apply buttons need to know whether this item is mine, even if the Annonce tab was never opened.
  function detectOwnershipQuietly() {
    if (VAI.pageType() !== 'item') return;
    VAI.detectOwnership().then((o) => (ownership ??= o)).catch(() => {});
  }

  let toastTimer = null;
  function toast(html) {
    const t = $('.toast');
    t.innerHTML = html;
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => (t.hidden = true), 250);
    }, 4000);
  }

  // ---------- save to the library when the seller saves the form on Vinted ----------
  // Vinted's buttons: "Ajouter" (new), "Enregistrer (les modifications)" (edit), "Enregistrer le brouillon"… fr/en + a few locales.
  const SAVE_BTN = /^(ajouter|publier|mettre en vente|enregistrer|sauvegarder|valider|upload|add|publish|save|list( item)?|hinzufügen|speichern|subir|guardar|pubblica|carica|salva)\b/i;
  const NOT_SAVE = /photo|image|vid[eé]o|marque|brand|taille|size|couleur|colou?r|mati[eè]re|cat[ée]gorie|favori|panier|lot|filtre|recherch|search/i;
  const DRAFT_BTN = /brouillon|draft|entwurf|borrador|bozza/i;
  // sessionStorage survives Vinted's redirect to the new listing (same tab, same origin).
  // Every save on the same form updates the same library item; the link to the new listing is made within 2 min.
  const CAPTURE_KEY = 'vai-captured';
  const readCaptured = () => {
    try {
      return JSON.parse(sessionStorage.getItem(CAPTURE_KEY) || 'null');
    } catch {
      return null;
    }
  };
  const writeCaptured = (c) => {
    try {
      sessionStorage.setItem(CAPTURE_KEY, JSON.stringify(c));
    } catch {}
  };
  let lastCapture = 0;

  async function captureForm(draft) {
    if (VAI.pageType() !== 'form' || Date.now() - lastCapture < 1500) return;
    const form = VAI.readFormData(); // read now, before Vinted resets or leaves the form
    if (!form.title) return; // nothing worth saving (or fields not found)
    lastCapture = Date.now();
    const settings = await send('settings:get').catch(() => null);
    if (settings && settings.autoSaveOnPublish === false) return;
    const editId = VAI.currentItemId();
    const prev = readCaptured();
    const data = {
      ...form,
      status: draft ? 'draft' : 'listed',
      ...(editId ? { vintedId: editId, vintedUrl: `${location.origin}/items/${editId}` } : {}),
    };
    const itemId = (prev?.path === location.pathname && prev.itemId) || pendingItem?.id || null;
    const { item, created } = await send('library:captureForm', { data, itemId });
    writeCaptured({ itemId: item.id, at: Date.now(), path: location.pathname, linked: !!editId || draft });
    toast(`${icon('check', 14)} ${created ? 'Ajouté' : 'Mis à jour'} dans ta bibliothèque <span class="sku">${esc(item.sku)}</span>${created ? ' — note ce numéro sur le sachet.' : ''}`);
    // Photos last: the page may already be navigating away.
    const photos = await VAI.getPhotos(4, 320).catch(() => []);
    if (photos.length) send('library:update', { ref: item.id, patch: { photos } }).catch(() => {});
  }

  // Capture phase: runs before Vinted's own handler clears or leaves the form.
  document.addEventListener(
    'click',
    (e) => {
      if (VAI.pageType() !== 'form' || e.composedPath().includes(host)) return;
      const btn = e.target.closest?.('button, [role="button"], input[type="submit"]');
      if (!btn) return;
      if (btn.closest('header, nav, [role="search"], [role="dialog"], [role="listbox"]')) return; // search bar, dropdowns, modals
      const label = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const testid = btn.getAttribute('data-testid') || '';
      if (label.length > 40 || NOT_SAVE.test(label + ' ' + testid)) return;
      if (SAVE_BTN.test(label) || /save|submit|upload-form|publish/i.test(testid)) captureForm(DRAFT_BTN.test(label + ' ' + testid)).catch(() => {});
    },
    true,
  );

  // After "Ajouter", Vinted opens the new listing: attach its id to the saved item.
  async function linkCapturedListing() {
    const c = readCaptured();
    const id = VAI.currentItemId();
    if (!c || c.linked || Date.now() - c.at > 120000 || VAI.pageType() !== 'item' || !id) return;
    writeCaptured({ ...c, linked: true });
    const item = await send('library:update', { ref: c.itemId, patch: { vintedId: id, vintedUrl: `${location.origin}/items/${id}`, status: 'listed' } }).catch(() => null);
    if (item) {
      toast(`${icon('link', 14)} Annonce liée à <span class="sku">${esc(item.sku)}</span>`);
      VAI.refreshIndex?.();
    }
  }

  // ---------- page-aware boot ----------
  function updatePageChip() {
    $('.page-chip').textContent = PAGE_LABEL[VAI.pageType()];
    const inbox = VAI.pageType() === 'inbox';
    $('[data-tab=listing]').innerHTML = `${icon(inbox ? 'chat' : 'wand', 14)} ${inbox ? 'Messages' : 'Annonce'}`;
  }
  updatePageChip();

  async function boot() {
    const settings = await send('settings:get').catch(() => null);
    if (VAI.pageType() === 'form') {
      pendingItem = await send('pendingFill:take').catch(() => null);
      const accepted = VAI.currentItemId() && (await getAccepted())[VAI.currentItemId()];
      if (pendingItem || accepted || settings?.panelOpenOnForm) open('listing');
    }
    detectOwnershipQuietly();
    linkCapturedListing();
  }
  boot();

  // Vinted is a SPA: watch URL changes and refresh the active view.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    lastResult = null;
    extraPhotos = [];
    ownership = null;
    detectOwnershipQuietly();
    linkCapturedListing();
    updatePageChip();
    if (panel.classList.contains('open') && current !== 'chat') show(current);
  }, 800);
})();
