// Renders the extension icons (PNG) from an inline SVG with Playwright's Chromium.
// Usage: node tools/make-icons.mjs   (needs the `playwright` package, local or global)
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(execSync('npm root -g').toString().trim() + '/playwright'); }

const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="30" fill="#0f766e"/>
  <g transform="translate(22 22) scale(3.5)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" fill="#fff"/>
  </g></svg>`;

const browser = await pw.chromium.launch();
const page = await browser.newPage();
for (const s of [16, 48, 128]) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<body style="margin:0;background:transparent">${svg(s)}</body>`);
  await page.screenshot({ path: `extension/icons/icon${s}.png`, omitBackground: true });
}
await browser.close();
console.log('icons ok');
