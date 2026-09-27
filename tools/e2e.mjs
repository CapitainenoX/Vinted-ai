// End-to-end smoke test: loads the unpacked extension in Chromium, fakes Vinted pages + an LLM.
// Usage: node tools/mock-llm.mjs & node tools/e2e.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(execSync('npm root -g').toString().trim() + '/playwright'); }

const ext = path.resolve('extension');
const shots = path.resolve(process.env.SHOTS || 'test-results');
fs.mkdirSync(shots, { recursive: true });
const fixture = (f) => fs.readFileSync(path.resolve('tools/fixtures', f), 'utf8');
const png = fs.readFileSync(path.resolve('extension/icons/icon128.png'));
const catalog = { items: [
  { id: 1, title: 'Sweat Nike Club gris', price: { amount: '25.0', currency_code: 'EUR' }, brand_title: 'Nike', size_title: 'M', favourite_count: 12, path: '/items/1' },
  { id: 2, title: 'Hoodie Nike M', price: { amount: '20.0' }, brand_title: 'Nike', favourite_count: 3, path: '/items/2' },
  { id: 3, title: 'Sweat Nike vintage', price: '30.0', brand_title: 'Nike', favourite_count: 30, path: '/items/3' },
], pagination: { total_entries: 3 } };

const ctx = await pw.chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1360, height: 860 },
});
const errors = [];
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = sw.url().split('/')[2];
for (let i = 0; i < 50 && !(await sw.evaluate(() => !!globalThis.chrome?.storage)); i++) await new Promise((r) => setTimeout(r, 100));
await sw.evaluate(() => chrome.storage.local.set({ settings: { provider: 'custom', baseUrl: 'http://localhost:8787/v1', apiKey: 'test', chatModel: 'mock-chat', visionModel: 'mock-vision', vintedDomain: 'www.vinted.fr', panelOpenOnForm: true, nextSku: 1 } }));

await ctx.route('https://www.vinted.fr/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname.startsWith('/api/v2/catalog/items')) return route.fulfill({ json: catalog });
  if (u.pathname === '/items/new') return route.fulfill({ contentType: 'text/html', body: fixture('form.html') });
  if (u.pathname.startsWith('/items/555')) return route.fulfill({ contentType: 'text/html', body: fixture('item.html') });
  if (u.pathname.endsWith('.jpg')) return route.fulfill({ contentType: 'image/png', body: png });
  return route.fulfill({ contentType: 'text/html', body: '<h1>home</h1>' });
});

const check = (cond, label) => { console.log(`${cond ? '✔' : '✘'} ${label}`); if (!cond) process.exitCode = 1; };

// 1. Listing generation on the form page
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message + ' @ ' + e.stack));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto('https://www.vinted.fr/items/new');
const panel = page.locator('#vinted-ai-root');
await panel.locator('.panel.open').waitFor({ timeout: 8000 });
check(true, 'panel auto-opens on the sell form');
await panel.locator('.photos .thumb').first().waitFor({ timeout: 8000 });
check(true, 'page photo detected (blob: preview)');
await panel.locator('[data-act=generate]').click();
await panel.locator('[data-k=title]').waitFor({ timeout: 15000 });
check((await panel.locator('[data-k=title]').inputValue()).includes('Nike'), 'listing generated from photos');
check((await panel.locator('.result').textContent()).includes('médiane'), 'market price stats shown');
await page.screenshot({ path: `${shots}/1-generate.png` });
await panel.locator('.result [data-act=apply]').click();
await page.waitForFunction(() => document.getElementById('brand').dataset.picked, null, { timeout: 8000 }).catch(() => {});
const form = await page.evaluate(() => ({ title: title.value, desc: description.value, price: price.value, brand: brand.value, react: window.reactLike }));
check(form.title === 'Sweat à capuche Nike Club gris M' && form.react.title === form.title, 'apply → title filled (React input event fired)');
check(form.desc.includes('#nike') && form.price === '24', 'apply → description + price filled');
check(form.brand === 'Nike', 'apply → brand dropdown option picked');
await panel.locator('.result [data-act=save]').click();
await panel.locator('.apply-report .sku').waitFor();
check((await panel.locator('.apply-report .sku').textContent()) === '#0001', 'saved to library as #0001');
await panel.locator('[data-act=audit]').first().click();
await panel.locator('.result .improve').first().waitFor({ timeout: 15000 });
check(true, 'audit rendered');

// 2. Agent chat with tools
await panel.locator('[data-tab=chat]').click();
await panel.locator('.chat textarea').fill('Quel prix pour ce sweat ?');
await panel.locator('.chat textarea').press('Enter');
await panel.locator('.msg.assistant').last().waitFor({ timeout: 20000 });
check((await panel.locator('.tool-line').count()) >= 2, 'agent called tools (search_vinted, propose_listing)');
check(await panel.locator('.proposal').count() === 1, 'proposal card rendered');
check((await panel.locator('.msg.assistant h4').textContent()).includes('Prix'), 'markdown answer rendered');
await page.screenshot({ path: `${shots}/2-chat.png` });

// 3. Item page: link to library + SKU badge
const item = await ctx.newPage();
item.on('pageerror', (e) => errors.push(e.message));
await item.goto('https://www.vinted.fr/items/555-sweat-nike');
const p2 = item.locator('#vinted-ai-root');
await p2.locator('.launcher').click();
await p2.locator('[data-act=link]').click();
await p2.locator('.sku.big').waitFor({ timeout: 8000 });
check((await p2.locator('.sku.big').textContent()) === '#0002', 'item page linked as #0002');
await item.locator('.vai-badge').waitFor({ timeout: 5000 });
check((await item.locator('.vai-badge').textContent()) === '#0002', 'SKU badge injected on item link');
await p2.locator('[data-k=notes]').fill('Bac B — taché manche gauche');
await p2.locator('[data-act=save-link]').click();
await item.screenshot({ path: `${shots}/3-item.png` });

// 4. Dashboard
const dash = await ctx.newPage();
dash.on('pageerror', (e) => errors.push(e.message + ' @ ' + e.stack));
await sw.evaluate(async () => {
  const { library } = await chrome.storage.local.get('library');
  const day = 86400000;
  library.forEach((i) => Object.assign(i, i.sku === '#0001' ? { status: 'sold', soldPrice: 26, cost: 6, soldAt: Date.now() - 3 * day, listedAt: Date.now() - 10 * day, brand: 'Nike' } : { status: 'listed', listedAt: Date.now() - 30 * day }));
  await chrome.storage.local.set({ library });
});
await dash.goto(`chrome-extension://${id}/dashboard/dashboard.html#overview`);
await dash.locator('.kpi').first().waitFor();
check((await dash.locator('#kpis').textContent()).includes('26'), 'dashboard KPIs computed');
check(await dash.locator('.chart .bar').count() > 0, 'weekly chart drawn');
check(await dash.locator('#stale .stale-row').count() === 1, 'stale listing suggested for relist');
await dash.screenshot({ path: `${shots}/4-overview.png` });
await dash.goto(`chrome-extension://${id}/dashboard/dashboard.html#library`);
await dash.locator('#table tbody tr').first().waitFor();
check(await dash.locator('#table tbody tr').count() === 2, 'library table lists 2 items');
await dash.locator('#table tbody tr', { hasText: '#0002' }).click();
await dash.locator('#drawer.open').waitFor();
check((await dash.locator('#f-notes').inputValue()).includes('Bac B'), 'notes persisted from Vinted panel');
await dash.screenshot({ path: `${shots}/5-library.png` });
await dash.keyboard.press('Escape');
await dash.goto(`chrome-extension://${id}/dashboard/dashboard.html#settings`);
// (buttons trigger a host-permission prompt for custom URLs, which headless can't answer: call the same messages)
check((await dash.evaluate(() => VAI.send('models:list'))).length === 2, 'settings: models listed');
check((await dash.evaluate(() => VAI.send('llm:test'))).reply === 'OK', 'settings: connection test');
await dash.screenshot({ path: `${shots}/6-settings.png` });
await dash.emulateMedia({ colorScheme: 'dark' });
await dash.goto(`chrome-extension://${id}/dashboard/dashboard.html#overview`);
await dash.locator('.kpi').first().waitFor();
await dash.screenshot({ path: `${shots}/7-overview-dark.png` });

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
await ctx.close();
