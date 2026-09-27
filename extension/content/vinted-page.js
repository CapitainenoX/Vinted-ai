// Vinted AI — everything that touches Vinted's DOM: page detection, reading/filling the listing
// form, collecting photos, same-origin API calls and #SKU badges on item links.
// Vinted's markup is not a public API: every selector has fallbacks (ids, data-testid, labels).
(() => {
  const VAI = (globalThis.VAI = globalThis.VAI || {});
  const PANEL_HOST = 'vinted-ai-root';

  // ---------- page detection ----------
  VAI.pageType = () => {
    const p = location.pathname;
    if (/\/items\/new/.test(p) || /\/items\/\d+[^/]*\/edit/.test(p)) return 'form';
    if (/\/items\/\d+/.test(p)) return 'item';
    if (/\/inbox/.test(p)) return 'inbox';
    if (/\/member\//.test(p)) return 'profile';
    if (/\/catalog|search_text=/.test(location.href)) return 'catalog';
    return 'other';
  };
  VAI.currentItemId = () => (location.pathname.match(/\/items\/(\d+)/) || [])[1] || null;

  // ---------- form fields ----------
  // Each field: candidate selectors, then label keywords (fr/en/…) as fallback.
  const FIELDS = {
    title: { sel: ['#title', 'input[name="title"]', '[data-testid="title--input"]', '[data-testid*="title"] input'], labels: ['titre', 'title', 'título', 'titolo', 'titel'] },
    description: { sel: ['#description', 'textarea[name="description"]', '[data-testid="description--input"]', '[data-testid*="description"] textarea'], labels: ['décris', 'description', 'describe'] },
    price: { sel: ['#price', 'input[name="price"]', '[data-testid="price-input--input"]', '[data-testid*="price"] input'], labels: ['prix', 'price', 'precio', 'prezzo', 'preis'] },
    brand: { sel: ['#brand', 'input[name="brand"]', '[data-testid*="brand"] input'], labels: ['marque', 'brand', 'marca', 'marke'], select: true },
    size: { sel: ['#size', 'input[name="size"]', '[data-testid*="size"] input'], labels: ['taille', 'size', 'talla', 'taglia', 'größe'], select: true },
    condition: { sel: ['#condition', 'input[name="condition"]', '[data-testid*="condition"] input', '[data-testid*="status"] input'], labels: ['état', 'condition', 'estado', 'condizioni', 'zustand'], select: true },
    color: { sel: ['#color', 'input[name="color"]', '[data-testid*="color"] input'], labels: ['couleur', 'colour', 'color', 'farbe'], select: true },
    material: { sel: ['#material', 'input[name="material"]', '[data-testid*="material"] input'], labels: ['matière', 'material', 'materiale'], select: true },
    category: { sel: ['#category', 'input[name="category"]', '[data-testid*="catalog"] input', '[data-testid*="category"] input'], labels: ['catégorie', 'category', 'categoría'], select: true },
  };

  const notInPanel = (el) => el && !el.closest?.('#' + PANEL_HOST);
  const visible = (el) => el && el.offsetParent !== null;

  function findField(key) {
    const def = FIELDS[key];
    for (const s of def.sel) {
      const el = document.querySelector(s);
      if (el && notInPanel(el)) return el;
    }
    for (const label of document.querySelectorAll('label')) {
      const t = label.textContent.trim().toLowerCase();
      if (!def.labels.some((l) => t.startsWith(l))) continue;
      const el = (label.htmlFor && document.getElementById(label.htmlFor)) || label.parentElement?.querySelector('input,textarea');
      if (el && notInPanel(el)) return el;
    }
    return null;
  }

  VAI.readForm = () => {
    const form = {};
    for (const key of Object.keys(FIELDS)) {
      const el = findField(key);
      if (el) form[key] = (el.value || '').trim();
    }
    return form;
  };

  // Price → plain number "24.00": no currency sign, no thousands separator, dot decimal.
  // Accepts "24", "24,5 €", "$19.99", "1 299,00", "EUR 30"…
  VAI.parsePrice = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const m = String(v ?? '').replace(/(\d)[\s\u00a0\u202f'.,](?=\d{3}\b)/g, '$1').match(/\d+(?:[.,]\d{1,2})?/);
    return m ? parseFloat(m[0].replace(',', '.')) : null;
  };
  VAI.formatPrice = (v) => {
    const n = VAI.parsePrice(v);
    return n != null && n > 0 ? n.toFixed(2) : null;
  };

  // The form's filled fields, cleaned for the library (price as a number, empty fields dropped).
  VAI.readFormData = () => {
    const out = {};
    for (const [k, v] of Object.entries(VAI.readForm())) {
      if (!v) continue;
      if (k === 'price') {
        const n = VAI.parsePrice(v);
        if (n != null) out.price = n;
      } else out[k] = v;
    }
    return out;
  };

  // React ignores .value assignments: use the native setter then fire input/change.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

  // Dropdown fields: open, type to filter, click the closest option. Best-effort by design.
  async function pickOption(el, value) {
    el.scrollIntoView({ block: 'center' });
    el.focus();
    el.click();
    await sleep(250);
    if (!el.readOnly) {
      setNativeValue(el, value);
      await sleep(700);
    }
    const target = norm(value);
    const candidates = [...document.querySelectorAll('[role="option"], [role="listbox"] li, [data-testid*="dropdown"] li, [data-testid*="-row"], .web_ui__Cell__cell')]
      .filter((o) => notInPanel(o) && visible(o) && o.textContent.trim());
    let best = null;
    let bestScore = 0;
    for (const o of candidates) {
      const t = norm(o.querySelector('[class*="title"], [class*="Title"]')?.textContent || o.textContent);
      const score = t === target ? 3 : t.startsWith(target) ? 2 : t.includes(target) || target.includes(t) ? 1 : 0;
      if (score > bestScore) [best, bestScore] = [o, score];
    }
    if (best) {
      (best.querySelector('button, [role="button"], input') || best).click();
      await sleep(250);
      return true;
    }
    document.body.click(); // close the dropdown
    return false;
  }

  VAI.fillForm = async (fields) => {
    const filled = [];
    const skipped = [];
    for (const key of ['title', 'description', 'price', 'brand', 'size', 'condition', 'color', 'material']) {
      let value = fields[key];
      if (value == null || value === '') continue;
      if (key === 'price') {
        value = VAI.formatPrice(value);
        if (!value) {
          skipped.push(`price ("${fields.price}" n'est pas un prix)`);
          continue;
        }
      }
      const el = findField(key);
      if (!el) {
        skipped.push(`${key} (champ introuvable)`);
        continue;
      }
      try {
        if (FIELDS[key].select) {
          (await pickOption(el, String(value))) ? filled.push(key) : skipped.push(`${key} ("${value}" non trouvé dans la liste)`);
        } else {
          setNativeValue(el, String(value));
          filled.push(key);
        }
      } catch (e) {
        skipped.push(`${key} (${e.message})`);
      }
    }
    return { filled, skipped };
  };

  // Upload photos from data URLs into Vinted's file input (used when relisting).
  VAI.uploadPhotos = async (dataUrls) => {
    const input = [...document.querySelectorAll('input[type="file"]')].find(notInPanel);
    if (!input || !dataUrls?.length) return false;
    const dt = new DataTransfer();
    for (const [i, url] of dataUrls.entries()) {
      const blob = await (await fetch(url)).blob();
      dt.items.add(new File([blob], `photo-${i + 1}.jpg`, { type: blob.type || 'image/jpeg' }));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  // ---------- photos ----------
  function pagePhotoUrls() {
    const type = VAI.pageType();
    const urls = [];
    if (type === 'item') {
      document.querySelectorAll('meta[property="og:image"]').forEach((m) => urls.push(m.content));
      document.querySelectorAll('[data-testid*="item-photo"] img, .item-photos img, figure img').forEach((i) => urls.push(i.currentSrc || i.src));
    } else {
      document.querySelectorAll('img').forEach((i) => {
        if (!notInPanel(i)) return;
        const src = i.currentSrc || i.src;
        const big = (i.naturalWidth || i.width) >= 80;
        if (big && (/^blob:|^data:image/.test(src) || (/vinted\.net/.test(src) && i.closest('form, [data-testid*="photo"], [class*="photo" i]')))) urls.push(src);
      });
    }
    return [...new Set(urls.filter(Boolean))];
  }

  VAI.getPhotos = async (max = 3, size = 1024) => {
    const out = [];
    for (const src of pagePhotoUrls().slice(0, max)) {
      try {
        out.push(/^https?:/.test(src) ? await VAI.toDataUrl((await VAI.send('photos:fetch', { urls: [src] }))[0], size) : await VAI.toDataUrl(src, size));
      } catch (e) {
        console.warn('[Vinted AI] photo skipped', e);
      }
    }
    return out;
  };
  VAI.currentThumbs = () => VAI.getPhotos(4, 320);
  VAI.photoSignature = () => pagePhotoUrls().join('|');

  // ---------- item page ----------
  VAI.readItemPage = () => {
    const meta = (p) => document.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.content || '';
    const details = {};
    document.querySelectorAll('[itemprop], [data-testid^="item-attributes"] div, .details-list__item').forEach((el) => {
      const k = el.getAttribute('itemprop') || el.querySelector('[class*="title"]')?.textContent;
      const v = el.getAttribute('content') || el.querySelector('[class*="value"]')?.textContent || el.textContent;
      if (k && v && k.length < 40) details[k.trim()] = v.trim().slice(0, 120);
    });
    const desc = document.querySelector('[itemprop="description"], [data-testid*="description"]')?.innerText || meta('og:description');
    return {
      id: VAI.currentItemId(),
      url: location.href.split('?')[0],
      title: meta('og:title') || document.title,
      description: (desc || '').slice(0, 3000),
      price: meta('product:price:amount') || document.querySelector('[data-testid*="price"]')?.textContent?.trim() || '',
      details,
    };
  };

  // ---------- inbox conversation: item, other member, messages ----------
  VAI.currentConversationId = () => (location.pathname.match(/\/inbox\/(\d+)/) || [])[1] || null;

  const MESSAGE_SEL = [
    '[data-testid*="conversation-message"]', '[data-testid*="message-bubble"]', '[data-testid*="message-row"]',
    '[class*="MessageBubble"]', '[class*="message-bubble"]', '[class*="Message__bubble"]', '[class*="message__body"]',
  ];
  const INPUT_SEL = ['[data-testid*="message-input"] textarea', 'textarea[name*="message" i]', 'textarea[placeholder]', '[contenteditable="true"][role="textbox"]'];

  function conversationRoot() {
    return document.querySelector('[data-testid*="conversation"]:not([data-testid*="list"]), [class*="Conversation__"], main') || document.body;
  }

  // Mine vs theirs: explicit markers first, then the bubble's side of the thread (sent messages sit on the right).
  function messageAuthor(el, box) {
    const marker = `${el.className} ${el.getAttribute('data-testid') || ''} ${el.parentElement?.className || ''}`.toLowerCase();
    if (/\b(own|mine|sent|outgoing|right|is-current-user|me)\b/.test(marker)) return 'me';
    if (/\b(their|received|incoming|left|other)\b/.test(marker)) return 'them';
    const r = el.getBoundingClientRect();
    if (!r.width || !box.width) return 'unknown';
    return r.left + r.width / 2 > box.left + box.width / 2 ? 'me' : 'them';
  }

  VAI.readConversation = () => {
    const root = conversationRoot();
    const box = root.getBoundingClientRect();
    const inPanel = (el) => el.closest('#' + PANEL_HOST);
    // Item: the listing the conversation is about (header card / link).
    const itemLink = [...root.querySelectorAll('a[href*="/items/"]')].find((a) => !inPanel(a) && /\/items\/\d+/.test(a.getAttribute('href')));
    const itemId = itemLink?.getAttribute('href').match(/\/items\/(\d+)/)?.[1] || null;
    const itemCard = itemLink?.closest('[data-testid*="item"], [class*="Item"], [class*="item"]') || itemLink;
    const cardText = (itemCard?.innerText || '').split('\n').map((t) => t.trim()).filter(Boolean);
    const priceLine = cardText.find((t) => /\d[\d\s.,]*\s?(€|eur|\$|£|zł|kč)/i.test(t));
    const itemTitle = itemLink?.getAttribute('title') || itemLink?.querySelector('img')?.alt || cardText.find((t) => t !== priceLine && t.length > 3) || '';
    // Other member: first profile link in the thread that isn't mine (header/nav excluded).
    const member = [...root.querySelectorAll('a[href*="/member/"]')].find((a) => !inPanel(a) && !a.closest('header, nav'));
    const memberLogin = (member?.innerText || member?.getAttribute('title') || '').trim().split('\n')[0] || (member?.getAttribute('href').match(/\/member\/\d+-([^/?#]+)/)?.[1] ?? '');
    // Messages
    let bubbles = [];
    for (const sel of MESSAGE_SEL) {
      bubbles = [...root.querySelectorAll(sel)].filter((el) => !inPanel(el) && el.innerText.trim());
      if (bubbles.length) break;
    }
    // Keep the innermost matches only (selectors can match both a row and its bubble).
    bubbles = bubbles.filter((el) => !bubbles.some((o) => o !== el && el.contains(o)));
    const messages = bubbles.slice(-30).map((el) => ({ from: messageAuthor(el, box), text: el.innerText.trim().slice(0, 600) }));
    return {
      conversationId: VAI.currentConversationId(),
      item: itemId ? { id: itemId, title: itemTitle.slice(0, 120), price: priceLine || '', url: `${location.origin}/items/${itemId}` } : null,
      member: memberLogin ? { login: memberLogin.slice(0, 60), id: member.getAttribute('href').match(/\/member\/(\d+)/)?.[1] || null } : null,
      messages,
      // Fallback for unknown markup: the thread as plain text (the model can still follow it).
      rawText: messages.length ? '' : (root.innerText || '').slice(-2500),
    };
  };

  // Puts a draft in Vinted's message box. Never sends: the seller reads it and presses Send.
  VAI.insertMessage = (text) => {
    let el = null;
    for (const sel of INPUT_SEL) {
      el = [...document.querySelectorAll(sel)].find((e) => !e.closest('#' + PANEL_HOST));
      if (el) break;
    }
    if (!el) return false;
    el.focus();
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else setNativeValue(el, text);
    return true;
  };

  // ---------- member profile: is it mine + the listings shown on it ----------
  VAI.currentMemberId = () => (location.pathname.match(/\/member\/(\d+)/) || [])[1] || null;
  // The logged-in account's own profile link lives in the header (avatar / menu).
  VAI.headerMemberId = () => {
    for (const a of document.querySelectorAll('header a[href*="/member/"], nav a[href*="/member/"], [data-testid*="header"] a[href*="/member/"]')) {
      const m = a.getAttribute('href').match(/\/member\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  };
  VAI.readProfileItems = () => {
    const main = document.querySelector('main') || document.body;
    const byId = new Map();
    for (const a of main.querySelectorAll('a[href*="/items/"]')) {
      if (a.closest('#' + PANEL_HOST + ', header, nav')) continue;
      const id = a.getAttribute('href').match(/\/items\/(\d+)/)?.[1];
      if (!id || byId.has(id)) continue;
      const card = a.closest('[data-testid*="item"], [class*="ItemBox"], [class*="item-box"], [class*="feed-grid__item"], li, article') || a.parentElement;
      const text = (card?.innerText || '').split('\n').map((t) => t.trim()).filter(Boolean);
      const img = card?.querySelector('img');
      const priceLine = text.find((t) => /\d[\d\s.,]*\s?(€|eur|\$|£|zł|kč)/i.test(t)) || '';
      byId.set(id, {
        id,
        url: `${location.origin}/items/${id}`,
        title: (a.getAttribute('title') || img?.alt || text.find((t) => t !== priceLine && t.length > 2) || `Article ${id}`).split(',')[0].slice(0, 100),
        price: VAI.parsePrice(priceLine),
        photo: img?.currentSrc || img?.src || null,
        sold: /\b(vendu|sold|verkauft|vendido|venduto)\b/i.test(text.join(' ')),
      });
    }
    return [...byId.values()];
  };

  // ---------- is this item page MY listing? ----------
  // Vinted shows different controls to the owner (edit / delete / bump / mark as reserved)
  // than to a buyer (buy / make an offer / message). We score both, then fall back on the
  // seller's member id learned from a page we already know is ours.
  const OWNER_RE = /modifier l.annonce|supprimer|marquer comme (réservé|vendu)|booster|mettre en avant|edit listing|delete|mark as (reserved|sold)|bump|bearbeiten|editar|modifica/i;
  const BUYER_RE = /^(acheter|faire une offre|envoyer un message|buy now|make an offer|message|kaufen|comprar|acquista)/i;

  function sellerMemberId() {
    const main = document.querySelector('main') || document.body;
    for (const a of main.querySelectorAll('a[href*="/member/"]')) {
      if (a.closest('header, nav, #' + PANEL_HOST)) continue;
      const m = a.getAttribute('href').match(/\/member\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  VAI.detectOwnership = async () => {
    const id = VAI.currentItemId();
    if (!id) return { own: false, reason: 'pas une fiche article', confident: false };
    const { ownOverrides = {} } = await chrome.storage.local.get('ownOverrides');
    if (id in ownOverrides) return { own: ownOverrides[id], reason: 'choix manuel', confident: true };

    const linked = await VAI.send('library:get', { ref: id }).catch(() => null);
    if (linked?.vintedId === id) return { own: true, reason: 'dans ta bibliothèque', confident: true, linked };

    // Header/nav/footer hold site-wide links ("Messages", "Vendre"…): only look at the page body.
    const controls = [...document.querySelectorAll('button, a[role="button"], a[href]')].filter((el) => notInPanel(el) && !el.closest('header, nav, footer'));
    const editLink = document.querySelector(`a[href*="/items/${id}/edit"]`);
    const ownerHit = editLink || controls.find((el) => OWNER_RE.test(el.textContent.trim()));
    const buyerHit = controls.find((el) => BUYER_RE.test(el.textContent.trim()));
    const seller = sellerMemberId();
    const settings = await VAI.send('settings:get').catch(() => ({}));

    if (ownerHit && !buyerHit) {
      // Learn who "I" am, so the next pages can be recognised even if the buttons change.
      if (seller && settings.myMemberId !== seller) VAI.send('settings:save', { patch: { myMemberId: seller } }).catch(() => {});
      return { own: true, reason: 'boutons vendeur détectés', confident: true };
    }
    if (buyerHit && !ownerHit) return { own: false, reason: 'boutons acheteur détectés', confident: true };
    if (seller && settings.myMemberId) return { own: seller === settings.myMemberId, reason: 'vendeur reconnu', confident: true };
    return { own: false, reason: 'non déterminé', confident: false };
  };

  VAI.setOwnOverride = async (own) => {
    const id = VAI.currentItemId();
    const { ownOverrides = {} } = await chrome.storage.local.get('ownOverrides');
    ownOverrides[id] = own;
    await chrome.storage.local.set({ ownOverrides });
  };

  // ---------- messages from the background (agent tools) ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const run = {
      read_page: async () => {
        const type = VAI.pageType();
        const base = { pageType: type, url: location.href };
        if (type === 'form') return { ...base, form: VAI.readForm(), photos: pagePhotoUrls().length };
        if (type === 'item') {
          const o = await VAI.detectOwnership();
          return { ...base, isMyListing: o.own, ownershipReason: o.reason, item: VAI.readItemPage(), photos: pagePhotoUrls().length };
        }
        if (type === 'inbox' && VAI.currentConversationId()) return { ...base, conversation: VAI.readConversation() };
        return { ...base, title: document.title, text: document.body.innerText.slice(0, 3000) };
      },
      fill_form: async () => {
        if (VAI.pageType() !== 'form') throw new Error("Ouvre le formulaire d'annonce Vinted (Vendre) pour que je le remplisse.");
        return VAI.fillForm(msg.fields);
      },
      get_photos: async () => ({ photos: await VAI.getPhotos(msg.max || 3) }),
      vinted_fetch: async () => {
        const res = await fetch(msg.url, { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`API Vinted ${res.status}`);
        return res.json();
      },
    }[msg?.type];
    if (!run) return false;
    run().then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  });

  // ---------- #SKU badges on every link to one of my items ----------
  let index = {};
  VAI.refreshIndex = async () => {
    index = await VAI.send('library:index').catch(() => ({}));
    document.querySelectorAll('.vai-badge').forEach((b) => b.remove());
    document.querySelectorAll('[data-vai-badged]').forEach((a) => a.removeAttribute('data-vai-badged'));
    badge();
    return index;
  };
  VAI.indexEntry = (id) => index[id] || null;

  function badge() {
    if (!Object.keys(index).length) return;
    for (const a of document.querySelectorAll('a[href*="/items/"]:not([data-vai-badged])')) {
      a.setAttribute('data-vai-badged', '1');
      // Only real listing links (/items/123-slug), not /items/123/edit, /items/new…
      const id = (a.getAttribute('href').match(/\/items\/(\d+)(?:-[^/?#]*)?(?:[?#].*)?$/) || [])[1];
      const entry = id && index[id];
      if (!entry || !notInPanel(a)) continue;
      const b = document.createElement('span');
      b.className = 'vai-badge';
      b.textContent = entry.sku;
      b.title = entry.notes ? `Vinted AI · ${entry.sku}\n${entry.notes}` : `Vinted AI · ${entry.sku}`;
      b.style.cssText = 'position:absolute;top:6px;left:6px;z-index:5;background:#0f766e;color:#fff;font:700 11px/1 ui-monospace,monospace;padding:4px 6px;border-radius:6px;pointer-events:none;box-shadow:0 1px 4px rgb(0 0 0/.25)';
      const host = a.querySelector('img')?.parentElement || a;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.appendChild(b);
    }
  }

  let t = null;
  new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(badge, 400);
  }).observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.library) VAI.refreshIndex();
  });
  VAI.refreshIndex();
})();
