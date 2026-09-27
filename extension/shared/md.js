// Vinted AI — tiny safe markdown renderer (escape first, then a few inline/block rules).
// Supports: headings, **bold**, *italic*, ~~strike~~, `code`, links, lists, tables, > quotes, --- rules.
(() => {
  const VAI = (globalThis.VAI = globalThis.VAI || {});
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Input is already escaped: links only accept http(s) URLs without quotes.
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));

  VAI.md = (text) => {
    const lines = esc(text).split('\n');
    let html = '';
    let block = null; // 'ul' | 'ol' | 'table' | 'quote'
    const close = () => {
      if (block === 'table') html += '</tbody></table></div>';
      else if (block === 'quote') html += '</blockquote>';
      else if (block) html += `</${block}>`;
      block = null;
    };
    const open = (b, tag) => {
      if (block !== b) {
        close();
        html += tag;
        block = b;
      }
    };
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      let m;
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // separator row
        const isHeader = block !== 'table' && /^\s*\|[\s:|-]+\|\s*$/.test(lines[k + 1] || '');
        if (block !== 'table') {
          close();
          html += '<div class="md-table"><table>';
          if (isHeader) html += `<thead><tr>${cells(line).map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
          html += '<tbody>';
          block = 'table';
          if (isHeader) continue;
        }
        html += `<tr>${cells(line).map((c) => `<td>${c}</td>`).join('')}</tr>`;
      } else if ((m = line.match(/^\s*[-*•]\s+(.*)/)) && !HR.test(line)) {
        open('ul', '<ul>');
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
        open('ol', '<ol>');
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^\s*&gt;\s?(.*)/))) {
        open('quote', '<blockquote>');
        html += `<p>${inline(m[1])}</p>`;
      } else if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
        close();
        const h = Math.min(m[1].length + 2, 6);
        html += `<h${h}>${inline(m[2])}</h${h}>`;
      } else if (HR.test(line)) {
        close();
        html += '<hr>';
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
