import { getSettings, listItems, computeStats } from '../lib/storage.js';

const [settings, items] = await Promise.all([getSettings(), listItems()]);
const s = computeStats(items, settings.feePercent);
document.getElementById('top').innerHTML = `${globalThis.VAI.icon('sparkles', 18)} Vinted AI`;
document.getElementById('warn').hidden = !!settings.apiKey || settings.provider === 'custom';
document.getElementById('stats').innerHTML = [
  [s.listed, 'en vente'],
  [s.sold, 'vendus'],
  [`${Math.round(s.profit)} €`, 'bénéfice'],
].map(([v, k]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
document.getElementById('sell').onclick = () => chrome.tabs.create({ url: `https://${settings.vintedDomain}/items/new` });
document.getElementById('dash').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
