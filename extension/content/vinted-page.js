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
      if (key === 'price') value = String(value).replace('.', ',').replace(/[^\d,]/g, '');
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

  // ---------- messages from the background (agent tools) ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const run = {
      read_page: async () => {
        const type = VAI.pageType();
        const base = { pageType: type, url: location.href };
        if (type === 'form') return { ...base, form: VAI.readForm(), photos: pagePhotoUrls().length };
        if (type === 'item') return { ...base, item: VAI.readItemPage(), photos: pagePhotoUrls().length };
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
      const id = (a.getAttribute('href').match(/\/items\/(\d+)/) || [])[1];
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
