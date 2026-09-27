# Vinted AI — notes for agents

- Chrome MV3 extension, vanilla JS, **no build step**. Load `extension/` unpacked.
- Background (`background.js`, ES module) owns all network calls (LLM, web, image fetch) and the agent loop (port `chat`).
- Content scripts are classic scripts sharing the `globalThis.VAI` namespace; load order is in `manifest.json`.
- `shared/chat-ui.js`, `md.js`, `icons.js`, `tokens.css` are used by both the Vinted panel and the dashboard.
- UI tokens + style contract live only in `shared/tokens.css`. New color = new token there.
- Vinted DOM selectors live in `content/vinted-page.js` (`FIELDS`); always keep fallbacks.
- Verify with `node tools/mock-llm.mjs & node tools/e2e.mjs` (must stay all ✔).

## Never
- Never put API keys anywhere but `chrome.storage.local`; never include them in exports.
- Never render model/agent output with innerHTML without `VAI.esc` / `VAI.md`.
