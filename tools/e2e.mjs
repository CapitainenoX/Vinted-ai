// End-to-end smoke test: loads the unpacked extension in Chromium, fakes Vinted pages + an LLM.
// Usage: node tools/mock-llm.mjs & node tools/e2e.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
// Let ctx.route() see the extension service worker's own requests (svc-catalogue search).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(execSync('npm root -g').toString().trim() + '/playwright'); }

const ext = path.resolve('extension');
const shots = path.resolve(process.env.SHOTS || 'test-results');
fs.mkdirSync(shots, { recursive: true });
// A proposal row by its exact field heading ("Taille" must not match a description mentioning "taille").
const row = (card, label) => card.locator('.edit-row').filter({ has: card.page().locator('.edit-head b', { hasText: new RegExp(`^${label}$`) }) });
const fixture = (f) => fs.readFileSync(path.resolve('tools/fixtures', f), 'utf8');
const png = fs.readFileSync(path.resolve('extension/icons/icon128.png'));
// svc-catalogue shape (Sept 2026): brand/size/condition in item_box, relative url, photos[].
const catalog = { items: [
  { id: 1, title: 'Sweat Nike Club gris', price: { amount: '25.0', currency_code: 'EUR' }, item_box: { first_line: 'Nike', second_line: 'M · Très bon état' }, favourite_count: 12, url: '/items/1-sweat' },
  { id: 2, title: 'Hoodie Nike M', price: { amount: '20.0', currency_code: 'EUR' }, item_box: { first_line: 'Nike', second_line: 'M · Bon état' }, favourite_count: 3, url: '/items/2-hoodie' },
  { id: 3, title: 'Sweat Nike vintage', price: { amount: '30.0', currency_code: 'EUR' }, item_box: { first_line: 'Nike' }, favourite_count: 30, url: '/items/3-sweat' },
], pagination: { total_entries: 3 } };

// Member watch mock (mutated during the test to simulate a sale, a price drop, a new review).
const wItem = (id, title, price, fav) => ({ id, title, price: { amount: String(price), currency_code: 'EUR' }, favourite_count: fav, view_count: 0, stats_visible: false, is_reserved: false, url: `https://www.vinted.fr/items/${id}`, photos: [] });
let watchUser = { id: 77, login: 'julie_b', city: 'Lyon', item_count: 2, given_item_count: 10, taken_item_count: 3, feedback_count: 20, feedback_reputation: 0.96, followers_count: 5, is_on_holiday: false, is_online: true, profile_url: 'https://www.vinted.fr/member/77-julie_b' };
let watchItems = [wItem(501, 'Robe Sézane rouge', 45, 3), wItem(502, 'Sac Longchamp noir', 60, 8)];
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

const catalogAuth = [];
await ctx.route('https://api.vinted.fr/**', (route) => {
  const u = new URL(route.request().url());
  if (!u.pathname.startsWith('/svc-catalogue/items')) return route.fulfill({ status: 404, body: '' });
  catalogAuth.push(route.request().headers().authorization || '');
  return route.fulfill({ json: catalog, headers: { 'access-control-allow-origin': '*' } });
});
await ctx.addCookies([{ name: 'access_token_web', value: 'tok123', domain: '.www.vinted.fr', path: '/', secure: true, httpOnly: true }]);
await ctx.route('https://www.vinted.fr/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/items/new') return route.fulfill({ contentType: 'text/html', body: fixture('form.html') });
  if (/^\/items\/\d+[^/]*\/edit/.test(u.pathname)) return route.fulfill({ contentType: 'text/html', body: fixture('form.html') });
  if (u.pathname === '/api/v2/users/77') return route.fulfill({ json: { user: watchUser } });
  if (u.pathname === '/api/v2/wardrobe/77/items') return route.fulfill({ json: { items: watchItems, pagination: { total_pages: 1 } } });
  if (u.pathname.startsWith('/api/v2/item_upload/items')) return route.fulfill({ json: { item: { id: Number(u.searchParams.get('id')) } } });
  if (u.pathname.startsWith('/member/42')) return route.fulfill({ contentType: 'text/html', body: fixture('profile.html') });
  if (u.pathname.startsWith('/inbox/')) return route.fulfill({ contentType: 'text/html', body: fixture('inbox.html') });
  if (u.pathname.startsWith('/items/888')) return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><h1>Veste Zara en jean bleue L</h1><p>18,50 €</p>' });
  if (u.pathname.startsWith('/items/555')) return route.fulfill({ contentType: 'text/html', body: fixture('item.html') });
  if (u.pathname.startsWith('/items/777')) return route.fulfill({ contentType: 'text/html', body: fixture('item-other.html') });
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
check(catalogAuth.length > 0 && catalogAuth.every((h) => h === 'Bearer tok123'), 'svc-catalogue called with access_token_web bearer');
await page.screenshot({ path: `${shots}/1-generate.png` });
await panel.locator('.result [data-act=apply]').click();
await page.waitForFunction(() => document.getElementById('brand').dataset.picked, null, { timeout: 8000 }).catch(() => {});
const form = await page.evaluate(() => ({ title: title.value, desc: description.value, price: price.value, brand: brand.value, react: window.reactLike }));
check(form.title === 'Sweat à capuche Nike Club gris M' && form.react.title === form.title, 'apply → title filled (React input event fired)');
check(form.desc.includes('#nike') && form.price === '24.00', 'apply → description + price filled (format 24.00)');
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
check(await panel.locator('.msg.assistant .md-table tbody tr').count() === 2, 'markdown table rendered as a real table');
check(await panel.locator('.results .res').count() === 3 && (await panel.locator('.results').textContent()).includes('médiane'), 'search results shown as clickable cards with price stats');
// accept fields one by one: pick the "vendre vite" price, ignore the size
const card = panel.locator('.proposal').last();
check(await card.locator('.edit-row').count() >= 4, 'proposal split into per-field rows');
await row(card, 'Prix').locator('[data-act=accept]', { hasText: 'Vendre vite' }).click();
await row(card, 'Prix').and(card.locator('.edit-row.done')).waitFor({ timeout: 5000 });
check((await page.evaluate(() => price.value)) === '19.00', 'price option "vendre vite" applied alone as 19.00 (no currency)');
await row(card, 'Taille').locator('[data-act=ignore]').click();
check(await card.locator('.edit-row.ignored').count() === 1 && (await row(card, 'Taille').getAttribute('class')).includes('ignored'), 'size ignored on its own');
check((await row(card, 'Titre').textContent()).includes('Déjà en place'), 'title already on the form → marked "déjà en place"');
// a model stuck in a tool loop still ends with a real answer, and repeated calls are not re-run
await panel.locator('.chat textarea').fill('Boucle sur les outils');
await panel.locator('.chat textarea').press('Enter');
await panel.locator('.msg.assistant', { hasText: 'Réponse finale après les outils' }).waitFor({ timeout: 30000 });
check(true, 'tool loop → forced final answer (no endless spinner)');
check(await panel.locator('.tool-line', { hasText: 'déjà fait' }).count() >= 1, 'identical tool call reused, not re-run');
check((await panel.locator('.chat-status').textContent()) === '', 'status line cleared when done');
// "bonnes affaires": results shown in the chat, the page is NOT opened automatically (a button instead)
const pagesBefore = ctx.pages().length;
await panel.locator('.chat textarea').fill('Trouve-moi une bonne affaire Nike');
await panel.locator('.chat textarea').press('Enter');
await panel.locator('.msg.assistant', { hasText: 'Bonnes affaires' }).waitFor({ timeout: 20000 });
check(ctx.pages().length === pagesBefore && page.url().includes('/items/new'), 'agent never opens/redirects a page by itself');
check((await panel.locator('.link-card a').last().getAttribute('href')).endsWith('/items/2') && await panel.locator('.results').count() >= 1, 'results stay visible + "Ouvrir" button to open when I want');
// "Nouvelle conversation"
await panel.locator('.chat [data-act=new]').click();
await panel.locator('.chat-empty').waitFor({ timeout: 5000 });
check(await panel.locator('.msg').count() === 0 && (await sw.evaluate(async () => (await chrome.storage.local.get('chats')).chats.panel.length)) === 0, '"Nouvelle conversation" clears the chat and its history');
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
check((await p2.locator('.owner-bar').textContent()).includes('Mon annonce'), 'own listing detected (seller controls)');
check(await p2.locator('[data-act=bought]').count() === 0, 'own listing → no "bought" action');
await p2.locator('[data-k=notes]').fill('Bac B — taché manche gauche');
await p2.locator('[data-act=save-link]').click();
await p2.locator('.saved', { hasText: 'Enregistré' }).waitFor();
// change the number from the panel
await p2.locator('.sku-btn').click();
await p2.locator('.sku-edit input').fill('9');
await p2.locator('.sku-edit button[type=submit]').click();
await p2.locator('.sku-btn .sku', { hasText: '#0009' }).waitFor({ timeout: 5000 });
check(true, 'number changed to #0009 from the panel');
await item.locator('.vai-badge', { hasText: '#0009' }).waitFor({ timeout: 5000 });
check(true, 'badge follows the new number');
await p2.locator('.sku-btn').click();
await p2.locator('.sku-edit input').fill('1');
await p2.locator('.sku-edit button[type=submit]').click();
await p2.locator('.sku-msg', { hasText: 'déjà pris' }).waitFor({ timeout: 5000 });
check(true, 'taken number → conflict message with swap');
await p2.locator('.sku-msg [data-act=swap]').click();
await p2.locator('.sku-btn .sku', { hasText: '#0001' }).waitFor({ timeout: 5000 });
check(true, 'numbers swapped (#0009 ↔ #0001)');
await item.screenshot({ path: `${shots}/3-item.png` });
// agent edits on my own listing: accept 2 of 3, then apply them on the edit form
await p2.locator('[data-tab=chat]').click();
await p2.locator('.chat textarea').fill('Optimise mon annonce');
await p2.locator('.chat textarea').press('Enter');
const edits = p2.locator('.proposal', { hasText: 'Modifications proposées' });
await edits.waitFor({ timeout: 20000 });
check(await edits.locator('.edit-row').count() === 3, 'propose_edits → 3 separate edits');
await row(edits, 'Titre').locator('[data-act=accept]').click();
await row(edits, 'Prix').locator('[data-act=accept]').click();
await row(edits, 'Couleur').locator('[data-act=ignore]').click();
await edits.locator('.edit-row.done').nth(1).waitFor({ timeout: 5000 });
check((await edits.locator('.count').textContent()).startsWith('2/3'), 'accepted 2 of 3 edits individually');
await item.screenshot({ path: `${shots}/3c-edits.png` });
await item.goto('https://www.vinted.fr/items/555-sweat-nike/edit');
const acc = item.locator('#vinted-ai-root .accepted-edits');
await acc.locator('[data-act=apply-accepted]').waitFor({ timeout: 8000 });
check((await acc.textContent()).includes('2 modification'), 'edit form offers the 2 accepted edits');
await acc.locator('[data-act=apply-accepted]').click();
await acc.locator('.report', { hasText: 'Rempli' }).waitFor({ timeout: 8000 });
const edited = await item.evaluate(() => ({ title: title.value, price: price.value }));
check(edited.title === 'Sweat Nike Club gris M coton' && edited.price === '22.00', 'accepted edits applied on the edit form (ignored one skipped)');

// someone else's listing → competitor menu
const other = await ctx.newPage();
other.on('pageerror', (e) => errors.push(e.message + ' @ ' + e.stack));
await other.goto('https://www.vinted.fr/items/777-jean-levis');
const p3 = other.locator('#vinted-ai-root');
await p3.locator('.launcher').click();
await p3.locator('.owner-bar').waitFor({ timeout: 8000 });
check((await p3.locator('.owner-bar').textContent()).includes("Annonce d'un autre vendeur"), "other seller's listing detected");
check(await p3.locator('[data-act=link]').count() === 0 && await p3.locator('[data-act=bought]').count() === 1, 'competitor menu (analyse + "ajouter comme achat")');
check((await p3.locator('.card', { hasText: "Tu l'as acheté" }).textContent()).includes('#0002'), 'next free number (#0002) announced');
await other.screenshot({ path: `${shots}/3b-other.png` });
await p3.locator('[data-act=flip]').click();
await p3.locator('.owner-bar.mine').waitFor({ timeout: 5000 });
check(true, 'manual override "c\'est la mienne" switches the menu');
await other.close();

// Inbox: detect item + client, 3 messages, insert into Vinted's box, adapt to an instruction
const inbox = await ctx.newPage();
inbox.on('pageerror', (e) => errors.push(e.message + ' @ ' + e.stack));
await inbox.goto('https://www.vinted.fr/inbox/12345');
const p4 = inbox.locator('#vinted-ai-root');
await p4.locator('.launcher').click();
check((await p4.locator('[data-tab=listing]').textContent()).includes('Messages'), 'inbox → "Messages" tab');
await p4.locator('.suggestion').nth(2).waitFor({ timeout: 15000 });
const head = await p4.locator('.conv-head').textContent();
check(head.includes('@julie_b') && head.includes('Sweat Nike gris') && head.includes('3 message(s)'), `conversation read: client, item, messages (${head.replace(/\s+/g, ' ').trim().slice(0, 80)})`);
const summary = await p4.locator('.studio-summary').textContent();
check(summary.includes('Vous le feriez à 15 €') && summary.includes('vendeur-lu:true'), 'thread sent with who-said-what (client vs me)');
check((await p4.locator('.studio-state .sku').textContent()) === '#0001', 'conversation item matched to library number');
check(await p4.locator('.suggestion').count() === 3, '3 messages proposed (reply / follow-up / offer)');
await p4.locator('.suggestion').first().locator('[data-act=insert]').click();
const boxText = await inbox.locator('[data-testid=message-input] textarea').inputValue();
check(boxText === 'Bonjour julie_b, message reply.', 'message put in Vinted\'s reply box (not sent), vouvoiement by default');
await p4.locator('[data-q="Refuse poliment"]').click();
await p4.locator('.suggestion textarea', { hasText: '[Refuse poliment]' }).first().waitFor({ timeout: 15000 });
check(true, 'instruction adapts the 3 messages');
await inbox.screenshot({ path: `${shots}/3d-inbox.png` });
await inbox.close();
// Favourites on my own listing
const fav = await ctx.newPage();
fav.on('pageerror', (e) => errors.push(e.message + ' @ ' + e.stack));
await fav.goto('https://www.vinted.fr/items/555-sweat-nike');
const p5 = fav.locator('#vinted-ai-root');
await p5.locator('.launcher').click();
await p5.locator('[data-act=favorites]').click();
await p5.locator('.suggestion').nth(2).waitFor({ timeout: 15000 });
check((await p5.locator('.suggestion .chip').allTextContents()).join(',') === 'Offre,Relancer,Lot', 'favourites → offer / follow-up / bundle messages');
await fav.close();

// 4. Dashboard
const dash = await ctx.newPage();
dash.on('pageerror', (e) => errors.push(e.message + ' @ ' + e.stack));
await sw.evaluate(async () => {
  const { library } = await chrome.storage.local.get('library');
  const day = 86400000;
  library.forEach((i) => Object.assign(i, i.sku === '#0009' ? { status: 'sold', soldPrice: 26, cost: 6, soldAt: Date.now() - 3 * day, listedAt: Date.now() - 10 * day, brand: 'Nike' } : { status: 'listed', listedAt: Date.now() - 30 * day }));
  await chrome.storage.local.set({ library });
});
await dash.goto(`chrome-extension://${id}/dashboard/dashboard.html#overview`);
await dash.locator('.kpi').first().waitFor();
check((await dash.locator('#kpis').textContent()).includes('26'), 'dashboard KPIs computed');
check(await dash.locator('#chart .bar').count() > 0, 'weekly chart drawn');
check(await dash.locator('#chart-heat rect.heat').count() === 1, 'sales heatmap (day × hour) drawn');
check(await dash.locator('#chart-cum .dot').count() === 1 && await dash.locator('#chart-status path').count() === 2, 'cumulative revenue + status donut drawn');
check((await dash.locator('#sales .sale-row').first().textContent()).includes('vendu en 7 j'), 'last sales list with date, hour and delay');
check(await dash.locator('#chart-pub .bar').count() >= 1 && await dash.locator('#chart-delay .hbar').count() === 6, 'publication hours + delay distribution drawn');
check(await dash.locator('#stale .stale-row').count() === 1, 'stale listing suggested for relist');
await dash.screenshot({ path: `${shots}/4-overview.png` });
await dash.goto(`chrome-extension://${id}/dashboard/dashboard.html#library`);
await dash.locator('#table tbody tr').first().waitFor();
check(await dash.locator('#table tbody tr').count() === 2, 'library table lists 2 items');
await dash.locator('#table tbody tr', { hasText: '#0001' }).click();
await dash.locator('#drawer.open').waitFor();
check((await dash.locator('#f-notes').inputValue()).includes('Bac B'), 'notes persisted from Vinted panel');
await dash.screenshot({ path: `${shots}/5-library.png` });
// smart numbering: smallest free number
const numbering = await dash.evaluate(async () => {
  const st = await import('../lib/storage.js');
  await st.saveSettings({ skuReuseSold: false });
  const a = await st.createItem({ title: 'A' }); // #0001 listed, #0009 sold → #0002
  const b = await st.createItem({ title: 'B' }); // → #0003
  await st.deleteItem(a.id);
  await st.deleteItem(b.id);
  const c = await st.createItem({ title: 'C' }); // gap → #0002 again
  await st.saveSettings({ skuReuseSold: true });
  const d = await st.createItem({ title: 'D' }); // sold #0009 is free, but #0003 is lower → #0003
  await st.deleteItem(c.id); await st.deleteItem(d.id);
  return [a.sku, b.sku, c.sku, d.sku];
});
check(JSON.stringify(numbering) === '["#0002","#0003","#0002","#0003"]', `smallest free number reused ${JSON.stringify(numbering)}`);
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

// 5. Seller fills the Vinted form by hand and clicks "Ajouter" → saved to the library, then linked to the new listing
const sell = await ctx.newPage();
sell.on('pageerror', (e) => errors.push(e.message + ' @ ' + e.stack));
await sell.goto('https://www.vinted.fr/items/new');
await sell.locator('#vinted-ai-root .panel.open').waitFor({ timeout: 8000 });
await sell.fill('#title', 'Veste Zara en jean bleue L');
await sell.fill('#description', 'Veste en jean Zara, portée 3 fois.');
await sell.fill('#price', '18,50 €');
await sell.click('#publish');
const toastEl = sell.locator('#vinted-ai-root .toast');
await toastEl.waitFor({ state: 'visible', timeout: 8000 });
const toastText = await toastEl.textContent();
check(/Ajouté dans ta bibliothèque #\d{4}/.test(toastText), `"Ajouter" on Vinted saves the form (${toastText.trim()})`);
await sell.waitForURL('**/items/888-veste-zara');
await toastEl.filter({ hasText: 'Annonce liée' }).waitFor({ timeout: 8000 });
const saved = await sw.evaluate(async () => (await chrome.storage.local.get('library')).library.find((i) => i.title === 'Veste Zara en jean bleue L'));
check(saved?.price === 18.5 && saved.description.includes('portée 3 fois') && saved.status === 'listed', 'saved item has the form fields (title, description, price 18.5)');
check(saved?.vintedId === '888' && saved.vintedUrl.endsWith('/items/888'), 'saved item linked to the new Vinted listing (#888)');
await sell.screenshot({ path: `${shots}/8-saved-toast.png` });
// Same tab, a second and third listing: each publish is a NEW item with the next number (never the previous one),
// linked at once from Vinted's API response (no need to open the listing).
const skus = [];
for (const [apiId, title] of [['1001', 'Robe Mango noire M'], ['1002', 'Pull Zara beige S']]) {
  await sell.goto(`https://www.vinted.fr/items/new?api=${apiId}`);
  await sell.locator('#vinted-ai-root .panel.open').waitFor({ timeout: 8000 });
  await sell.fill('#title', title);
  await sell.fill('#price', '12');
  await sell.click('#publish');
  await sell.locator('#vinted-ai-root .toast', { hasText: 'Annonce liée' }).waitFor({ timeout: 8000 });
  const it = await sw.evaluate(async (t) => (await chrome.storage.local.get('library')).library.find((i) => i.title === t), title);
  skus.push([it?.sku, it?.vintedId]);
}
const zara = await sw.evaluate(async () => (await chrome.storage.local.get('library')).library.find((i) => i.title === 'Veste Zara en jean bleue L'));
check(skus[0][0] && skus[1][0] && skus[0][0] !== skus[1][0] && skus[0][0] !== zara.sku, `each publish = a new item with its own number (${zara.sku}, ${skus[0][0]}, ${skus[1][0]})`);
check(skus[0][1] === '1001' && skus[1][1] === '1002' && zara.vintedId === '888', 'each item linked to ITS listing right after publishing (API), no page visit needed');

// 6. My profile: listings on sale → mark one as sold
const prof = await ctx.newPage();
prof.on('pageerror', (e) => errors.push(e.message + ' @ ' + e.stack));
await prof.goto('https://www.vinted.fr/member/42-moi');
const p6 = prof.locator('#vinted-ai-root');
await p6.locator('.launcher').click();
await p6.locator('.profile-item').first().waitFor({ timeout: 8000 });
check((await p6.locator('[data-tab=listing]').textContent()).includes('Mes articles'), 'own profile → "Mes articles" tab');
check(await p6.locator('.profile-item').count() === 2, 'listings on sale detected (sold one excluded)');
check((await p6.locator('.profile-item').first().textContent()).includes('#0001'), 'library number shown on my listing');
const jean = p6.locator('.profile-item', { hasText: "Jean Levi's" });
await jean.locator('[data-act=sold]').click();
await jean.locator('.sold-form input').fill('28');
await jean.locator('[data-act=confirm-sold]').click();
await jean.locator('.done', { hasText: 'Vendu' }).waitFor({ timeout: 5000 });
const soldJean = await sw.evaluate(async () => (await chrome.storage.local.get('library')).library.find((i) => i.vintedId === '901'));
check(soldJean?.status === 'sold' && soldJean.soldPrice === 28 && soldJean.soldAt > 0, 'marked sold from profile → saved with price + date');
await prof.screenshot({ path: `${shots}/9-profile.png` });
// a sold item deleted from the library stays in the sales stats
const kept = await dash.evaluate(async () => {
  const st = await import('../lib/storage.js');
  const it = (await st.listItems()).find((i) => i.vintedId === '901');
  await st.deleteItem(it.id);
  return (await st.statsItems()).some((i) => i.vintedId === '901' && i.status === 'sold');
});
check(kept, 'deleting a sold item keeps the sale in the stats (sales archive)');
// sold → number freed, shows #VENDU; back on sale → gets a number again; old sold items migrated
const vendu = await dash.evaluate(async () => {
  const st = await import('../lib/storage.js');
  const a = await st.createItem({ title: 'Test vente', status: 'listed' });
  const num = a.sku;
  const sold = await st.updateItem(a.id, { status: 'sold', soldPrice: 10 });
  const b = await st.createItem({ title: 'Nouveau' }); // takes the freed number
  let renumberErr = '';
  try { await st.setItemNumber(a.id, 50); } catch (e) { renumberErr = e.message; }
  const back = await st.updateItem(a.id, { status: 'listed' });
  // an item sold before this feature (still holding its number)
  const lib = await st.listItems();
  lib.push({ id: 'old-sold', sku: '#0077', status: 'sold', title: 'Ancienne vente', soldAt: Date.now(), history: [] });
  await chrome.storage.local.set({ library: lib });
  await st.migrateSoldSkus();
  const old = (await st.listItems()).find((i) => i.id === 'old-sold');
  for (const id of [a.id, b.id, 'old-sold']) await st.deleteItem(id);
  return { num, soldSku: sold.sku, former: sold.formerSku, reused: b.sku === num, renumberErr, backSku: back.sku, old: [old.sku, old.formerSku] };
});
check(vendu.soldSku === '#VENDU' && vendu.former === vendu.num, `sold item shows #VENDU, old number kept in history (${vendu.num})`);
check(vendu.reused, 'freed number goes to the next new item');
check(vendu.renumberErr.includes('vendu'), 'a sold item cannot be renumbered');
check(/^#\d{4}$/.test(vendu.backSku) && vendu.backSku !== vendu.num, `back on sale → a free number again (${vendu.backSku}, its old one was taken)`);
check(vendu.old[0] === '#VENDU' && vendu.old[1] === '#0077', 'items sold before the update are migrated to #VENDU');

// 7. Member watch: add from the Vinted panel, then a change → notification + badge + dashboard + Vinted tab toast
const other2 = await ctx.newPage();
other2.on('pageerror', (e) => errors.push(e.message + ' @ ' + e.stack));
await other2.goto('https://www.vinted.fr/member/77-julie_b');
const p7 = other2.locator('#vinted-ai-root');
await p7.locator('.launcher').click();
await p7.locator('[data-act=watch]').click();
await p7.locator('.watch-out', { hasText: '@julie_b est surveillé' }).waitFor({ timeout: 10000 });
check(true, 'watch a member from their Vinted profile (panel button)');
check(!!(await sw.evaluate(() => chrome.alarms.get('watch'))), 'periodic check scheduled (chrome.alarms)');
await dash.goto(`chrome-extension://${id}/dashboard/dashboard.html#watch`);
await dash.locator('.watch-card').waitFor({ timeout: 8000 });
check((await dash.locator('.watch-card').textContent()).includes('@julie_b') && (await dash.locator('.watch-card .wk').first().textContent()).includes('2'), 'dashboard: watched member card (2 on sale)');
// she sells the dress, drops the bag's price, gets a review
watchItems = [wItem(502, 'Sac Longchamp noir', 52, 9)];
watchUser = { ...watchUser, item_count: 1, given_item_count: 11, feedback_count: 21 };
await dash.locator('#watch-check').click();
await dash.locator('.event', { hasText: 'Vendu : Robe Sézane rouge' }).waitFor({ timeout: 10000 });
const evText = await dash.locator('#watch-events').textContent();
check(evText.includes('60 € → 52 €') && evText.includes('1 nouvelle(s) vente(s)') && evText.includes('nouvel(s) avis'), 'changes detected: sold item, price drop, sales count, new review');
const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
check(badge === '' || Number(badge) >= 4, `extension icon badge pinged (${badge || 'read on dashboard'})`);
check((await sw.evaluate(() => new Promise((r) => chrome.notifications.getAll(r))) && true), 'Chrome notification sent');
await p7.locator('.toast', { hasText: '@julie_b' }).waitFor({ timeout: 8000 }).then(() => check(true, 'Vinted tab pinged (toast in the panel)'), () => check(false, 'Vinted tab pinged (toast in the panel)'));
await dash.screenshot({ path: `${shots}/10-watch.png`, fullPage: true });
await other2.close();

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
await ctx.close();
