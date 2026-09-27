// Vinted AI — OpenAI-compatible chat client (Groq, OpenRouter, OpenAI, Mistral, Ollama…).
// Non-streaming on purpose: Groq answers fast and tool-calling is simpler to parse whole.

const MAX_RETRIES = 3;
const TIMEOUT_MS = 90000;

// onRetry(text): optional progress callback so the UI never sits silent while we wait out a rate limit.
export async function chatCompletion(settings, { model, messages, tools, json = false, temperature = 0.5, maxTokens = 2048, signal, onRetry }) {
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
    // A stalled provider must not freeze the chat: every request gets its own timeout.
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const both = signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal || timeout;
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: both });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (timeout.aborted) {
        lastErr = new Error(`Le modèle n'a pas répondu en ${TIMEOUT_MS / 1000} s.`);
        onRetry?.('Le modèle ne répond pas, nouvel essai…');
        continue;
      }
      throw new Error(`Impossible de joindre l'API (${e.message}).`);
    }
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
    // Groq: the model produced a malformed tool call. Retry once colder, then without tools (plain answer).
    if (res.status === 400 && /tool_use_failed|failed to call a function|tool call validation/i.test(text) && body.tools) {
      if (body.temperature > 0.2) body.temperature = 0.2;
      else {
        delete body.tools;
        delete body.tool_choice;
      }
      onRetry?.('Appel d\'outil mal formé, nouvel essai…');
      continue;
    }
    if (res.status === 413 || /request too large|context_length|maximum context|too many tokens/i.test(text)) {
      const err = new Error(describeError(res.status, text, model));
      err.code = 'TOO_LARGE';
      throw err;
    }
    if (res.status !== 429 && res.status < 500) break;
    if (attempt === MAX_RETRIES) break;
    const wait = Math.min(Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** attempt, 20000);
    onRetry?.(res.status === 429 ? `Limite de requêtes du fournisseur : nouvel essai dans ${Math.ceil(wait / 1000)} s…` : `Erreur ${res.status} du fournisseur, nouvel essai…`);
    await new Promise((r, reject) => {
      const t = setTimeout(r, wait);
      signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('Aborted', 'AbortError'))), { once: true });
    });
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
  if (status === 429) return 'Limite de requêtes atteinte (429). Attends une minute ou démarre une nouvelle conversation (moins de texte à envoyer).';
  if (status === 413) return 'Conversation trop longue pour le modèle (413). Démarre une nouvelle conversation.';
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
