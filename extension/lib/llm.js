// Vinted AI — OpenAI-compatible chat client (Groq, OpenRouter, OpenAI, Mistral, Ollama…).
// Non-streaming on purpose: Groq answers fast and tool-calling is simpler to parse whole.

const MAX_RETRIES = 3;

export async function chatCompletion(settings, { model, messages, tools, json = false, temperature = 0.5, maxTokens = 2048, signal }) {
  if (!settings.apiKey && settings.provider !== 'custom') {
    throw new Error("Aucune clé API. Ouvre le dashboard → Paramètres pour ajouter ta clé (Groq est gratuit).");
  }
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (json) body.response_format = { type: 'json_object' };

  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  if (settings.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/capitainenox/vinted-ai';
    headers['X-Title'] = 'Vinted AI';
  }

  const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (res.ok) {
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('Réponse vide du modèle');
      return { message: msg, usage: data.usage };
    }
    const text = await res.text().catch(() => '');
    lastErr = new Error(describeError(res.status, text, model));
    // Some models reject response_format / tools: retry once without.
    if (res.status === 400 && json && /response_format|json/i.test(text)) {
      delete body.response_format;
      continue;
    }
    if (res.status !== 429 && res.status < 500) break;
    const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(wait, 20000)));
  }
  throw lastErr;
}

function describeError(status, text, model) {
  let detail = text;
  try {
    detail = JSON.parse(text).error?.message || text;
  } catch {}
  detail = String(detail).slice(0, 300);
  if (status === 401) return 'Clé API refusée (401). Vérifie-la dans Paramètres.';
  if (status === 404) return `Modèle "${model}" introuvable (404). Choisis-en un autre dans Paramètres. ${detail}`;
  if (status === 429) return 'Limite de requêtes atteinte (429). Réessaie dans un instant.';
  return `Erreur API ${status} : ${detail}`;
}

export async function listModels(settings) {
  const headers = settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {};
  const res = await fetch(settings.baseUrl.replace(/\/+$/, '') + '/models', { headers });
  if (!res.ok) throw new Error(describeError(res.status, await res.text(), ''));
  const data = await res.json();
  return (data.data || []).map((m) => m.id).sort();
}

// Extracts a JSON object from a model answer (handles ```json fences and stray text).
export function parseJson(text) {
  if (!text) throw new Error('Réponse vide');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Le modèle n’a pas renvoyé de JSON');
  return JSON.parse(raw.slice(start, end + 1));
}
