// Vinted AI — chat UI shared by the Vinted panel (content script) and the dashboard.
(() => {
  const VAI = (globalThis.VAI = globalThis.VAI || {});
  const { esc, icon, md } = VAI;

  // One-shot message to the background; resolves data or throws the error text.
  VAI.send = (type, payload = {}) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('Pas de réponse (extension rechargée ? Rafraîchis la page).'));
        res.ok ? resolve(res.data) : reject(new Error(res.error));
      });
    });

  // Resize any image source to a JPEG data URL (keeps vision payloads small).
  VAI.toDataUrl = (src, max = 1024, quality = 0.82) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        try {
          resolve(c.toDataURL('image/jpeg', quality));
        } catch (e) {
          reject(e); // tainted canvas
        }
      };
      img.onerror = () => reject(new Error('Image illisible'));
      img.src = src;
    });

  VAI.fileToDataUrl = (file, max) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => VAI.toDataUrl(r.result, max).then(resolve, reject);
      r.onerror = reject;
      r.readAsDataURL(file);
    });

  const TOOL_LABELS = {
    search_vinted: 'Recherche sur Vinted',
    web_search: 'Recherche web',
    fetch_url: 'Lecture de page',
    read_page: 'Lecture de la page Vinted',
    analyze_photos: 'Analyse des photos',
    propose_listing: "Préparation de l'annonce",
    propose_edits: 'Modifications proposées',
    open_page: 'Ouverture de la page',
    propose_price: 'Prix proposé',
    fill_form: 'Remplissage du formulaire',
    library_search: 'Bibliothèque',
    library_save: 'Ajout en bibliothèque',
    library_update: 'Mise à jour bibliothèque',
    library_stats: 'Statistiques',
    relist_item: 'Republication',
  };

  const FIELD_LABELS = {
    title: 'Titre', price: 'Prix', brand: 'Marque', size: 'Taille', condition: 'État',
    color: 'Couleur', material: 'Matière', category: 'Catégorie', description: 'Description',
  };
  const LISTING_ORDER = ['title', 'price', 'brand', 'size', 'condition', 'color', 'material', 'category', 'description'];
  const sameValue = (a, b) => String(a ?? '').replace(',', '.').trim().toLowerCase() === String(b ?? '').replace(',', '.').trim().toLowerCase();
  const fmtPrice = (v) => `${String(v).replace('.', ',')} €`;

  // Every card (listing / edits / price) becomes a list of rows the seller accepts one by one.
  // A row: { field, value, reason?, choices?: [{ label, value }] } — choices are used for prices.
  function cardRows(card) {
    const priceChoices = (c) =>
      [['Conseillé', c.price], ['Vendre vite', c.price_fast], ['Ambitieux', c.price_max]]
        .filter(([, v]) => Number.isFinite(parseFloat(v)))
        .map(([label, v]) => ({ label, value: parseFloat(v) }));
    if (card.kind === 'price') return [{ field: 'price', value: card.price, reason: card.reasoning, choices: priceChoices(card) }];
    if (card.kind === 'edits') {
      return card.edits.map((e) => (e.field === 'price' ? { ...e, value: parseFloat(String(e.value).replace(',', '.')) || e.value } : e));
    }
    return LISTING_ORDER.filter((k) => card[k] != null && card[k] !== '').map((k) =>
      k === 'price' ? { field: k, value: card.price, reason: card.price_reasoning, choices: priceChoices(card) } : { field: k, value: card[k] },
    );
  }
  const CARD_HEAD = {
    listing: ['sparkles', 'Annonce proposée'],
    edits: ['wand', 'Modifications proposées'],
    price: ['target', 'Prix proposé'],
  };

  class Chat {
    constructor({ root, chatId, suggestions = [], getPageContext = () => null, canApply = false }) {
      Object.assign(this, { root, chatId, suggestions, getPageContext, canApply });
      this.images = [];
      this.busy = false;
      this.render();
      this.load();
    }

    render() {
      this.root.innerHTML = `
        <div class="chat">
          <div class="chat-bar">
            <span class="small muted chat-status" aria-live="polite"></span>
            <button class="btn sm ghost" data-act="new" title="Efface l'historique : l'agent repart de zéro (plus rapide, moins de limites)">${icon('plus', 12)} Nouvelle conversation</button>
          </div>
          <div class="chat-log" role="log" aria-live="polite"></div>
          <div class="chat-input">
            <div class="thumbs"></div>
            <div class="row">
              <button class="icon-btn" data-act="attach" title="Joindre des photos (ou coller / glisser)">${icon('image')}</button>
              <textarea rows="1" placeholder="Demande à l'agent…  (Maj+Entrée = ligne)" aria-label="Message"></textarea>
              <button class="btn primary" data-act="send" aria-label="Envoyer">${icon('send')}</button>
            </div>
            <input type="file" accept="image/*" multiple hidden>
          </div>
        </div>`;
      this.log = this.root.querySelector('.chat-log');
      this.ta = this.root.querySelector('textarea');
      this.sendBtn = this.root.querySelector('[data-act=send]');
      this.file = this.root.querySelector('input[type=file]');
      this.thumbs = this.root.querySelector('.thumbs');

      this.sendBtn.onclick = () => (this.busy ? this.stop() : this.submit());
      this.statusEl = this.root.querySelector('.chat-status');
      this.root.querySelector('[data-act=new]').onclick = () => this.clear();
      this.root.querySelector('[data-act=attach]').onclick = () => this.file.click();
      this.file.onchange = () => this.addFiles([...this.file.files]).then(() => (this.file.value = ''));
      this.ta.addEventListener('keydown', (e) => {
        e.stopPropagation(); // keep Vinted's keyboard shortcuts out of the way
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.submit();
        }
      });
      this.ta.addEventListener('input', () => {
        this.ta.style.height = 'auto';
        this.ta.style.height = Math.min(this.ta.scrollHeight, 140) + 'px';
      });
      this.ta.addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
        if (files.length) {
          e.preventDefault();
          this.addFiles(files);
        }
      });
      this.root.addEventListener('dragover', (e) => e.preventDefault());
      this.root.addEventListener('drop', (e) => {
        e.preventDefault();
        this.addFiles([...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/')));
      });
    }

    async load() {
      const history = await VAI.send('chat:get', { id: this.chatId }).catch(() => []);
      this.log.innerHTML = '';
      if (!history.length) return this.renderEmpty();
      for (const m of history) {
        for (const c of m.cards || []) this.addCard(c);
        this.addMessage(m.role, m.role === 'user' ? (m.display ?? m.content) + (m.images ? `  📷×${m.images}` : '') : m.content);
      }
      this.scroll();
    }

    renderEmpty() {
      this.log.innerHTML = `<div class="chat-empty">
        <div style="color:var(--accent)">${icon('sparkles', 22)}</div>
        <p><strong>Ton agent Vinted.</strong><br>Annonces depuis les photos, prix du marché, audit, stats, bibliothèque.</p>
        <div class="suggest">${(typeof this.suggestions === 'function' ? this.suggestions() : this.suggestions).map((s) => `<button class="btn sm">${esc(s)}</button>`).join('')}</div>
      </div>`;
      this.log.querySelectorAll('.suggest button').forEach((b) => (b.onclick = () => this.submit(b.textContent)));
    }

    async addFiles(files) {
      for (const f of files.slice(0, 3 - this.images.length)) this.images.push(await VAI.fileToDataUrl(f));
      this.renderThumbs();
    }
    addImages(urls) {
      this.images = [...this.images, ...urls].slice(0, 3);
      this.renderThumbs();
    }
    renderThumbs() {
      this.thumbs.innerHTML = this.images.map((src, i) => `<div class="thumb"><img src="${src}" alt=""><button data-i="${i}" aria-label="Retirer">×</button></div>`).join('');
      this.thumbs.querySelectorAll('button').forEach((b) => (b.onclick = () => { this.images.splice(+b.dataset.i, 1); this.renderThumbs(); }));
    }

    addMessage(role, text) {
      this.log.querySelector('.chat-empty')?.remove();
      const el = document.createElement('div');
      el.className = `msg ${role} fade-up`;
      if (role === 'assistant') el.innerHTML = md(text);
      else el.textContent = text;
      this.log.appendChild(el);
      this.scroll();
      return el;
    }

    addToolLine(name, args) {
      const el = document.createElement('div');
      el.className = 'tool-line fade-up';
      const detail = args?.query || args?.url || args?.ref || '';
      el.innerHTML = `<span class="spinner"></span><span>${esc(TOOL_LABELS[name] || name)}${detail ? ` · <em>${esc(String(detail).slice(0, 60))}</em>` : ''}</span>`;
      this.log.appendChild(el);
      this.scroll();
      return el;
    }

    // Apply mode comes from the host page: 'fill' (form open), 'queue' (own item page → applied on its edit form),
    // or null (dashboard / other pages → copy to clipboard).
    applyMode() {
      return this.canApply ? VAI.applyMode?.() || null : null;
    }

    addCard(card) {
      if (card.kind === 'results') return this.addResults(card);
      if (card.kind === 'link') return this.addLink(card);
      const rows = cardRows(card);
      const mode = this.applyMode();
      const current = mode === 'fill' ? VAI.readForm?.() || {} : {};
      const verb = mode === 'fill' ? 'Appliquer' : mode === 'queue' ? 'Accepter' : 'Copier';
      const [headIcon, headText] = CARD_HEAD[card.kind] || CARD_HEAD.listing;
      const el = document.createElement('div');
      el.className = 'card proposal fade-up';
      const rowHtml = (r, i) => {
        const old = current[r.field];
        const value = r.field === 'price' ? fmtPrice(r.value) : String(r.value);
        const showOld = old && !sameValue(old, r.value);
        return `<div class="edit-row" data-i="${i}">
          <div class="edit-head"><b>${esc(FIELD_LABELS[r.field] || r.field)}</b><span class="edit-state"></span></div>
          ${showOld ? `<div class="edit-old">${esc(r.field === 'price' ? fmtPrice(old) : old)}</div>` : ''}
          ${r.choices?.length > 1 ? '' : `<div class="edit-new">${esc(value)}</div>`}
          ${r.reason ? `<div class="edit-why">${esc(r.reason)}</div>` : ''}
          <div class="edit-actions">
            ${
              r.choices?.length > 1
                ? r.choices.map((c, j) => `<button class="btn sm ${j ? '' : 'primary'}" data-act="accept" data-v="${j}">${esc(c.label)} · ${esc(fmtPrice(c.value))}</button>`).join('')
                : `<button class="btn sm primary" data-act="accept">${icon(mode ? 'check' : 'copy', 12)} ${verb}</button>`
            }
            <button class="btn sm ghost" data-act="ignore">${icon('x', 12)} Ignorer</button>
          </div>
          <p class="small edit-msg"></p>
        </div>`;
      };
      el.innerHTML =
        `<div class="row-between card-head"><span class="chip accent">${icon(headIcon, 12)} ${headText}</span><span class="small muted count"></span></div>` +
        (card.summary ? `<p class="small">${esc(card.summary)}</p>` : '') +
        rows.map(rowHtml).join('') +
        (card.tags?.length ? `<div class="field"><b>Mots-clés</b><div>${card.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join(' ')}</div></div>` : '') +
        `<div class="actions">
          ${mode && rows.length > 1 ? `<button class="btn sm" data-act="accept-rest">${icon('check', 14)} ${verb} le reste</button>` : ''}
          ${card.kind === 'listing' ? `<button class="btn sm" data-act="save">${icon('save', 14)} Sauver en bibliothèque</button>` : ''}
          ${card.kind === 'listing' ? `<button class="btn sm ghost" data-act="copy">${icon('copy', 14)} Copier</button>` : ''}
        </div>`;

      const state = rows.map(() => null); // null | 'done' | 'ignored'
      const updateCount = () => {
        const done = state.filter((s) => s === 'done').length;
        el.querySelector('.count').textContent = rows.length > 1 || done ? `${done}/${rows.length} ${mode === 'fill' ? 'appliqué(s)' : 'accepté(s)'}` : '';
        const rest = el.querySelector('[data-act=accept-rest]');
        if (rest) rest.hidden = state.every(Boolean);
      };
      const settle = (i, status, text) => {
        const rowEl = el.querySelector(`.edit-row[data-i="${i}"]`);
        state[i] = status;
        rowEl.classList.toggle('done', status === 'done');
        rowEl.classList.toggle('ignored', status === 'ignored');
        rowEl.querySelector('.edit-state').innerHTML = status === 'done' ? `${icon('check', 12)} ${esc(text)}` : status === 'ignored' ? 'Ignoré' : '';
        rowEl.querySelectorAll('.edit-actions button').forEach((b) => (b.disabled = !!status));
        updateCount();
      };
      const accept = async (i, value) => {
        const r = rows[i];
        const rowEl = el.querySelector(`.edit-row[data-i="${i}"]`);
        const msg = rowEl.querySelector('.edit-msg');
        msg.textContent = '';
        rowEl.querySelectorAll('.edit-actions button').forEach((b) => (b.disabled = true));
        try {
          const res = mode ? await VAI.applyEdit?.(r.field, value) : null;
          if (res?.status === 'applied') return settle(i, 'done', r.field === 'price' ? `Appliqué ${fmtPrice(value)}` : 'Appliqué');
          if (res?.status === 'queued') return settle(i, 'done', 'Accepté');
          if (res?.status === 'failed') throw new Error(res.message);
          await navigator.clipboard.writeText(String(value));
          settle(i, 'done', 'Copié');
        } catch (err) {
          msg.textContent = err.message || String(err);
          rowEl.querySelectorAll('.edit-actions button').forEach((b) => (b.disabled = false));
        }
      };
      el.querySelectorAll('.edit-row').forEach((rowEl) => {
        const i = +rowEl.dataset.i;
        rowEl.querySelectorAll('[data-act=accept]').forEach((b) => {
          b.onclick = () => accept(i, b.dataset.v != null ? rows[i].choices[+b.dataset.v].value : rows[i].value);
        });
        rowEl.querySelector('[data-act=ignore]').onclick = () => settle(i, 'ignored');
      });
      el.querySelector('[data-act=accept-rest]')?.addEventListener('click', async () => {
        for (const [i, r] of rows.entries()) if (!state[i]) await accept(i, r.value);
      });
      el.querySelector('[data-act=save]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const { kind, ...listing } = card;
        const form = VAI.pageType?.() === 'form' ? VAI.readFormData?.() || {} : {};
        const item = await VAI.send('library:create', { data: { ...listing, ...form, photos: (await VAI.currentThumbs?.()) || [] } });
        btn.innerHTML = `${icon('check', 14)} Sauvé ${esc(item.sku)}`;
      });
      el.querySelector('[data-act=copy]')?.addEventListener('click', (e) => {
        navigator.clipboard.writeText(`${card.title}\n\n${card.description || ''}`);
        e.currentTarget.innerHTML = `${icon('check', 14)} Copié`;
      });
      // Already on the form → nothing to accept (price options stay open: the seller may still want another one).
      rows.forEach((r, i) => !(r.choices?.length > 1) && current[r.field] && sameValue(current[r.field], r.value) && settle(i, 'done', 'Déjà en place'));
      updateCount();
      this.log.querySelector('.chat-empty')?.remove();
      this.log.appendChild(el);
      this.scroll();
    }

    addLink(card) {
      if (!/^https:\/\/[^\s"'<>]+$/.test(card.url || '')) return;
      const el = document.createElement('div');
      el.className = 'card link-card fade-up';
      el.innerHTML = `<span class="small">${icon('external', 12)} ${esc(card.label || 'Page Vinted')}</span><a class="btn primary sm" href="${esc(card.url)}" target="_blank" rel="noopener">Ouvrir</a>`;
      this.log.querySelector('.chat-empty')?.remove();
      this.log.appendChild(el);
      this.scroll();
    }

    // Vinted search results as clickable mini cards (photo, price, deal flag).
    addResults(card) {
      const safe = (u) => (/^https:\/\/[^\s"'<>]+$/.test(u || '') ? u : null);
      const st = card.stats;
      const el = document.createElement('div');
      el.className = 'card results fade-up';
      el.innerHTML =
        `<div class="row-between card-head"><span class="chip accent">${icon('search', 12)} ${esc(card.query || 'Recherche')}</span><span class="small muted">${esc(card.count ?? card.items.length)} annonces</span></div>` +
        (st ? `<p class="small muted">Prix : min <b>${esc(st.min)} €</b> · médiane <b>${esc(st.median)} €</b> · max <b>${esc(st.max)} €</b></p>` : '') +
        `<div class="res-grid">${card.items
          .map((i) => {
            const url = safe(i.url);
            const photo = safe(i.photo);
            return `<a class="res" ${url ? `href="${esc(url)}" target="_blank" rel="noopener"` : ''} title="${esc(i.title)}">
              ${photo ? `<img src="${esc(photo)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
              ${i.deal ? '<span class="deal">Bonne affaire</span>' : ''}
              <span class="res-p num">${esc(i.price ?? '?')} €</span>
              <span class="res-t">${esc(i.title || '')}</span>
              <span class="res-m">${esc([i.brand, i.size].filter(Boolean).join(' · '))}${i.favourites ? ` · ♥ ${esc(i.favourites)}` : ''}</span>
            </a>`;
          })
          .join('')}</div>`;
      this.log.querySelector('.chat-empty')?.remove();
      this.log.appendChild(el);
      this.scroll();
    }

    scroll() {
      this.log.scrollTop = this.log.scrollHeight;
    }

    setBusy(b) {
      this.busy = b;
      this.sendBtn.innerHTML = b ? icon('stop') : icon('send');
      this.sendBtn.setAttribute('aria-label', b ? 'Arrêter' : 'Envoyer');
    }

    stop() {
      this.port?.postMessage({ type: 'stop' });
    }

    setStatus(text) {
      this.statusEl.textContent = text || '';
    }

    async clear() {
      if (this.busy) {
        const port = this.port;
        this.port = null;
        port?.postMessage({ type: 'stop' });
        port?.disconnect();
        this.setBusy(false);
      }
      this.setStatus('');
      await VAI.send('chat:clear', { id: this.chatId });
      this.log.innerHTML = '';
      this.renderEmpty();
    }

    submit(textArg) {
      const text = (textArg ?? this.ta.value).trim();
      if ((!text && !this.images.length) || this.busy) return;
      const images = this.images;
      this.images = [];
      this.renderThumbs();
      this.ta.value = '';
      this.ta.style.height = 'auto';
      this.addMessage('user', (text || 'Analyse ces photos et rédige l’annonce.') + (images.length ? `  📷×${images.length}` : ''));
      this.setBusy(true);

      let pending = null;
      let finished = false;
      const port = (this.port = chrome.runtime.connect({ name: 'chat' }));
      this.setStatus('L’agent réfléchit…');
      port.onMessage.addListener((e) => {
        if (e.type === 'status') return this.setStatus(e.text);
        if (e.type === 'tool') {
          pending = this.addToolLine(e.name, e.args);
          this.setStatus('L’agent utilise ses outils…');
        }
        else if (e.type === 'tool_result' && pending) {
          pending.querySelector('.spinner').outerHTML = e.error ? icon('x', 12) : icon('check', 12);
          if (e.error) pending.classList.add('err');
          if (e.summary) pending.insertAdjacentHTML('beforeend', `<span> — ${esc(e.summary)}</span>`);
          pending = null;
        } else if (e.type === 'card') this.addCard(e.card);
        else if (e.type === 'library_changed') this.root.dispatchEvent(new CustomEvent('library-changed', { bubbles: true }));
        else if (e.type === 'final') this.addMessage('assistant', e.text);
        else if (e.type === 'error') this.addMessage('error', e.error);
        else if (e.type === 'done') {
          finished = true;
          this.setBusy(false);
          this.setStatus('');
          port.disconnect();
        }
      });
      // Worker restarted / extension reloaded mid-answer: say so instead of spinning forever.
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return; // replaced by "Nouvelle conversation"
        if (!finished) {
          pending?.querySelector('.spinner')?.remove();
          this.addMessage('error', 'Connexion à l’agent perdue. Renvoie ton message (ou recharge la page si l’extension a été mise à jour).');
        }
        this.setBusy(false);
        this.setStatus('');
      });
      port.postMessage({
        type: 'send',
        chatId: this.chatId,
        text: text || 'Analyse ces photos et rédige l’annonce complète, avec le prix basé sur les annonces comparables.',
        images,
        pageContext: this.getPageContext(),
      });
    }
  }

  VAI.Chat = Chat;
})();
