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
    fill_form: 'Remplissage du formulaire',
    library_search: 'Bibliothèque',
    library_save: 'Ajout en bibliothèque',
    library_update: 'Mise à jour bibliothèque',
    library_stats: 'Statistiques',
    relist_item: 'Republication',
  };

  const PROPOSAL_FIELDS = [
    ['title', 'Titre'], ['price', 'Prix'], ['brand', 'Marque'], ['size', 'Taille'], ['condition', 'État'],
    ['color', 'Couleur'], ['material', 'Matière'], ['category', 'Catégorie'], ['description', 'Description'],
  ];

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
      for (const m of history) this.addMessage(m.role, m.role === 'user' ? (m.display ?? m.content) + (m.images ? `  📷×${m.images}` : '') : m.content);
      this.scroll();
    }

    renderEmpty() {
      this.log.innerHTML = `<div class="chat-empty">
        <div style="color:var(--accent)">${icon('sparkles', 22)}</div>
        <p><strong>Ton agent Vinted.</strong><br>Annonces depuis les photos, prix du marché, audit, stats, bibliothèque.</p>
        <div class="suggest">${this.suggestions.map((s) => `<button class="btn sm">${esc(s)}</button>`).join('')}</div>
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

    addProposal(listing) {
      const el = document.createElement('div');
      el.className = 'card proposal fade-up';
      el.innerHTML =
        `<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px"><span class="chip accent">${icon('sparkles', 12)} Annonce proposée</span></div>` +
        PROPOSAL_FIELDS.filter(([k]) => listing[k] != null && listing[k] !== '')
          .map(([k, label]) => `<div class="field"><b>${label}</b><div>${esc(k === 'price' ? listing[k] + ' €' : listing[k])}</div></div>`)
          .join('') +
        (listing.tags?.length ? `<div class="field"><b>Mots-clés</b><div>${listing.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join(' ')}</div></div>` : '') +
        `<div class="actions">
          ${this.canApply ? `<button class="btn primary sm" data-act="apply">${icon('wand', 14)} Appliquer</button>` : ''}
          <button class="btn sm" data-act="save">${icon('save', 14)} Sauver en bibliothèque</button>
          <button class="btn sm ghost" data-act="copy">${icon('copy', 14)} Copier</button>
        </div>`;
      el.querySelector('[data-act=apply]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const r = await VAI.applyListing?.(listing);
          btn.innerHTML = `${icon('check', 14)} ${r?.filled?.length ?? 0} champ(s) rempli(s)`;
        } catch (err) {
          btn.textContent = err.message;
        }
      });
      el.querySelector('[data-act=save]').onclick = async (e) => {
        const btn = e.currentTarget;
        const item = await VAI.send('library:create', { data: { ...listing, photos: (await VAI.currentThumbs?.()) || [] } });
        btn.innerHTML = `${icon('check', 14)} Sauvé ${esc(item.sku)}`;
        btn.disabled = true;
      };
      el.querySelector('[data-act=copy]').onclick = (e) => {
        navigator.clipboard.writeText(`${listing.title}\n\n${listing.description}`);
        e.currentTarget.innerHTML = `${icon('check', 14)} Copié`;
      };
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

    async clear() {
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
      const port = (this.port = chrome.runtime.connect({ name: 'chat' }));
      port.onMessage.addListener((e) => {
        if (e.type === 'tool') pending = this.addToolLine(e.name, e.args);
        else if (e.type === 'tool_result' && pending) {
          pending.querySelector('.spinner').outerHTML = e.error ? icon('x', 12) : icon('check', 12);
          if (e.error) pending.classList.add('err');
          if (e.summary) pending.insertAdjacentHTML('beforeend', `<span> — ${esc(e.summary)}</span>`);
          pending = null;
        } else if (e.type === 'proposal') this.addProposal(e.listing);
        else if (e.type === 'library_changed') this.root.dispatchEvent(new CustomEvent('library-changed', { bubbles: true }));
        else if (e.type === 'final') this.addMessage('assistant', e.text);
        else if (e.type === 'error') this.addMessage('error', e.error);
        else if (e.type === 'done') {
          this.setBusy(false);
          port.disconnect();
        }
      });
      port.onDisconnect.addListener(() => this.setBusy(false));
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
