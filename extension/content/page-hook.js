// Vinted AI — runs in the PAGE's world (not the isolated content-script world) at document_start.
// Vinted's form saves through its own API; this reads the saved item's id from that response so the
// extension can link the library item immediately, without waiting for the seller to open the listing.
// It only reads responses of item save calls and only posts {id, draft} back to the content script.
(() => {
  if (window.__vaiHook) return;
  window.__vaiHook = true;
  const SAVE_URL = /\/api\/v\d+\/item_upload\/(items|drafts)(\/\d+)?(\?|$)/;
  const report = (url, method, body) => {
    try {
      if (!SAVE_URL.test(url) || !/^(POST|PUT|PATCH)$/i.test(method || 'GET')) return;
      const data = typeof body === 'string' ? JSON.parse(body) : body;
      const draft = /\/drafts/.test(url) || !!data?.draft;
      const id = data?.item?.id ?? data?.draft?.id ?? data?.id;
      if (id && /^\d+$/.test(String(id))) window.postMessage({ source: 'vai-hook', type: 'item-saved', id: String(id), draft }, location.origin);
    } catch {}
  };
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = init?.method || (typeof input === 'object' && input?.method) || 'GET';
      if (SAVE_URL.test(url)) res.clone().text().then((t) => report(url, method, t), () => {});
    } catch {}
    return res;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__vai = { method, url: String(url) };
    return open.apply(this, arguments);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (this.__vai && SAVE_URL.test(this.__vai.url)) {
      this.addEventListener('load', () => {
        try {
          report(this.__vai.url, this.__vai.method, this.responseType === 'json' ? this.response : this.responseText);
        } catch {}
      });
    }
    return send.apply(this, arguments);
  };
})();
