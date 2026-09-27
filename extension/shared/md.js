// Vinted AI — tiny safe markdown renderer (escape first, then a few inline/block rules).
(() => {
  const VAI = (globalThis.VAI = globalThis.VAI || {});
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  VAI.md = (text) => {
    const lines = esc(text).split('\n');
    let html = '';
    let list = null;
    const close = () => {
      if (list) html += `</${list}>`;
      list = null;
    };
    for (const line of lines) {
      let m;
      if ((m = line.match(/^\s*[-*•]\s+(.*)/))) {
        if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; }
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
        if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; }
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
        close();
        html += `<h${Math.min(m[1].length + 2, 6)}>${inline(m[2])}</h${Math.min(m[1].length + 2, 6)}>`;
      } else if (/^\s*\|.*\|\s*$/.test(line)) {
        close();
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // table separator row
        html += `<div class="md-row">${line.trim().slice(1, -1).split('|').map((c) => `<span>${inline(c.trim())}</span>`).join('')}</div>`;
      } else if (!line.trim()) {
        close();
      } else {
        close();
        html += `<p>${inline(line)}</p>`;
      }
    }
    close();
    return html;
  };
  VAI.esc = esc;
})();
