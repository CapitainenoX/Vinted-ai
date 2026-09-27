// Mock OpenAI-compatible server for end-to-end tests (no API key needed).
import http from 'node:http';

const vision = { item_type: 'sweat à capuche', brand: 'Nike', brand_evidence: 'logo brodé', model: 'Club', size_label: 'M', gender: 'homme', colors: ['gris'], material: 'coton (probable)', condition_guess: 'Très bon état', defects: [], labels_text: 'NIKE M', photo_feedback: ['Ajoute une photo de l’étiquette'], search_query: 'sweat nike club' };
const listing = { title: 'Sweat à capuche Nike Club gris M', description: 'Sweat Nike Club gris, taille M.\n\nTrès bon état, aucun défaut.\n\n#nike #sweat #hoodie', brand: 'Nike', size: 'M', condition: 'Très bon état', color: 'Gris', material: 'Coton', category: 'Hommes > Vêtements > Sweats', price: 24, price_fast: 19, price_max: 29, price_reasoning: 'Médiane 25 € sur 3 annonces', tags: ['nike', 'hoodie'], missing: ['mesures'], score: 84, tips: ['Publie le dimanche soir'] };
const audit = { score: 62, verdict: 'Titre trop vague.', price_position: 'dans le marché', missing: ['taille dans le titre'], improvements: [{ field: 'title', issue: 'pas de marque', fix: 'Sweat Nike Club gris M' }], better_title: 'Sweat Nike Club gris M', keywords_to_add: ['hoodie'] };

let calls = 0;
const reply = (message) => ({ choices: [{ message }], usage: {} });
const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + ++calls, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-chat' }, { id: 'mock-vision' }] }));
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = JSON.parse(body);
    const last = b.messages.at(-1);
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    let out;
    if (Array.isArray(last.content) && last.content.some((c) => c.type === 'image_url')) out = reply({ role: 'assistant', content: JSON.stringify(vision) });
    else if (text.includes('Audite cette annonce Vinted')) out = reply({ role: 'assistant', content: JSON.stringify(audit) });
    else if (text.includes('Tu écris les messages Vinted')) {
      // Echo what the prompt contained so the e2e can check the thread was read (and who said what).
      const lastClient = [...text.matchAll(/CLIENT : (.*)/g)].at(-1)?.[1] || '';
      const consigne = (text.match(/Consigne du vendeur[^:]*: (.*)/) || [])[1] || '';
      const fav = text.includes("mis l'article en favori");
      const kinds = fav ? ['offer', 'follow_up', 'bundle'] : ['reply', 'follow_up', 'offer'];
      out = reply({ role: 'assistant', content: JSON.stringify({
        summary: fav ? 'Article en favori' : `Dernier message client : ${lastClient}`,
        buyer_intent: `vendeur-lu:${/MOI : Oui toujours/.test(text)}`,
        replies: kinds.map((k, i) => ({ kind: k, label: `Option ${i + 1}`, text: `${consigne ? `[${consigne}] ` : ''}Bonjour julie_b, message ${k}.${/VOUVOIEMENT obligatoire/.test(text) ? '' : ' (tu)'}`, price: k === 'offer' ? 19 : null })),
      }) });
    }
    else if (text.includes("Rédige l'annonce Vinted optimale")) out = reply({ role: 'assistant', content: '```json\n' + JSON.stringify(listing) + '\n```' });
    else if (b.tools) {
      const toolMsgs = b.messages.filter((m) => m.role === 'tool').length;
      const ask = b.messages.filter((m) => m.role === 'user').at(-1).content;
      if (/bonne affaire/i.test(ask)) {
        out = toolMsgs === 0 ? reply(call('search_vinted', { query: 'nike', order: 'price_low_to_high' }))
          : toolMsgs === 1 ? reply(call('open_page', { item_id: '2' }))
          : reply({ role: 'assistant', content: '## Bonnes affaires\n- Hoodie Nike M à 20 €' });
      } else if (ask.includes('Boucle')) {
        out = reply(call('search_vinted', { query: 'boucle' })); // a model that never stops calling tools
      } else if (ask.includes('Optimise')) {
        out = toolMsgs
          ? reply({ role: 'assistant', content: '3 modifications proposées : accepte celles qui te conviennent.' })
          : reply(call('propose_edits', { summary: 'Titre plus cherché, prix dans la médiane.', edits: [
            { field: 'title', value: 'Sweat Nike Club gris M coton', reason: '+ matière, mot-clé cherché' },
            { field: 'price', value: '22', reason: 'Médiane 25 €' },
            { field: 'color', value: 'Gris chiné' },
          ] }));
      } else if (last.role === 'user') out = reply(call('search_vinted', { query: 'sweat nike club' }));
      else if (toolMsgs === 1) out = reply(call('propose_listing', { title: listing.title, description: listing.description, price: 24, price_fast: 19, price_max: 29, price_reasoning: 'Médiane 25 € sur 3 annonces', brand: 'Nike', size: 'M' }));
      else out = reply({ role: 'assistant', content: '## Prix conseillé\n- **24 €** (médiane du marché)\n- Rapide : 19 €\n\n| Option | Prix |\n|---|---|\n| Rapide | 19 € |\n| Conseillé | 24 € |' });
    } else if (text.includes('Réponds maintenant')) out = reply({ role: 'assistant', content: 'Réponse finale après les outils.' });
    else out = reply({ role: 'assistant', content: 'OK' });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out));
  });
}).listen(8787, () => console.log('mock llm on 8787'));
