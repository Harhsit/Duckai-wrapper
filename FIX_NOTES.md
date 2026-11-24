# Fix notes — Duckai-wrapper vs. current DuckDuckGo Duck AI API

## What was broken
1. The old code expected `GET /duckchat/v1/status` to return an `x-vqd-4`
   token header. It no longer does (verified live): the response is 200 with
   **no** `x-vqd-4`, only `x-vqd-hash-1` — a base64-encoded, obfuscated
   JavaScript anti-bot challenge. The old code therefore always failed the
   handshake and returned 500.
2. The old model IDs are retired. `gpt-4o-mini` now returns
   `404 ERR_MODEL_UNAVAILABLE` from the chat endpoint.
3. A bare `{ model, messages }` chat body is no longer accepted: it returns
   `400 ERR_BAD_REQUEST`. The body must also carry `canUseTools` and
   `reasoningEffort`.

## The current flow (implemented here)
1. `GET https://duckduckgo.com/duckchat/v1/status` with `x-vqd-accept: 1`
   → take the `x-vqd-hash-1` challenge script (base64 JS).
2. Run the script in Node's `vm` with a stubbed browser environment
   (`challenge.js`): navigator, a `#jsa` iframe + CSP-meta document,
   DOM class prototype chains (Element/HTMLElement/HTMLDivElement/...),
   a non-Array `NodeList`, native globals on `window`
   (`parseInt`, `Object`, ...), `[object Window]` via Symbol.toStringTag,
   accessor `self`/`top`, `getComputedStyle`, etc. The script returns
   `{ server_hashes, client_hashes, signals, meta }`.
3. Build the solved token: SHA-256 (base64) each `client_hashes` entry,
   keep `server_hashes`/`signals`, set `meta.origin`, `meta.stack`,
   `meta.duration`, then base64-encode the JSON. Send it as the
   `x-vqd-hash-1` header — there is no `x-vqd-4` anymore.
4. `POST /duckchat/v1/chat` with
   `{ model, messages, canUseTools, reasoningEffort }` and assemble the
   SSE reply from the `message` fields, as before.

## Retry behaviour
The challenge script rotates between several "flavors"; the stubbed
environment does not yet pass every flavor, and rejected flavors return
`418 ERR_CHALLENGE` (occasionally `429`). `POST /api/chat` therefore
re-solves a fresh challenge and retries up to 8 attempts (also on
transient network/socket errors). In testing, success typically came on
attempts 1–5.

## Model aliases
Legacy IDs are mapped to the current free lineup (verified live against
`GET /duckchat/v1/models`):
`gpt-4o-mini`/`gpt-5-mini` → `gpt-5.4-mini`, `gpt-oss-120b` →
`tinfoil/gpt-oss-120b`, `claude-4.5-haiku` → `claude-haiku-5-5`,
`llama-4-scout` → `tinfoil/gemma4-31b`, `mistral-small-3-24b` →
`mistral-small-2603`. The response now includes both `model_used`
(actual upstream model) and `requested_model`.

## Files changed
- `challenge.js` — **new**: challenge solver (Node builtins only, no new
  dependencies).
- `index.js` — uses the solver, new chat body/headers, retry loop,
  updated `SUPPORTED_MODELS`, legacy alias map.
- `FIX_NOTES.md` — this file.
- `package.json` / `vercel.json` — unchanged.

## Update — API key dashboard (OpenAI-style keys)
- `dashboard.html` — **new**: key dashboard served at `GET /dashboard`
  (home page links to it): create a key with a label, copy it (shown
  only once), list keys masked, revoke a key.
- `index.js` — multi-key auth: `POST /api/keys`, `GET /api/keys`,
  `DELETE /api/keys/:id` (or `POST /api/keys/:id/revoke`). Generated
  keys (`duck-` + `crypto.randomBytes`) are stored in `keys.json` as
  SHA-256 hashes only, never plaintext. `validateApiKey` accepts the
  `DUCK_AI_API_KEY` master key (if set) **or** any non-revoked
  generated key. The hardcoded fallback key has been **removed**.
- `.gitignore` — **new**: `keys.json`, `.env`, `node_modules/`.
- `DASHBOARD_NOTES.md` — **new**: full documentation and test results.
- ⚠️ The dashboard/`/api/keys` endpoints have no login yet — put them
  behind an admin login/password before any public deployment.

## Test results (local, DUCK_AI_API_KEY=testkey123, port 3100)
- `GET /` → 200, gateway page.
- `POST /api/chat` without a key → 401, as before.
- `POST /api/chat` with the key, message "Say hello in exactly one short
  sentence.", model `gpt-4o-mini` → 200
  `{"status":"success","model_used":"gpt-5.4-mini","requested_model":"gpt-4o-mini","reply":"Hello."}`
- Repeated twice more (x-api-key header; default model) → 200, reply
  "Hello!" both times.

## Known limitations
- Upstream anti-bot checks rotate; if DuckDuckGo ships a new challenge
  flavor, the 418 rate may rise until `challenge.js` stubs are extended.
- Per-IP rate limits (429) apply, especially from datacenter IPs.
- ~~The API key setup still includes a hardcoded fallback~~ — fixed in
  the dashboard update: the fallback has been removed from `index.js`.
  Use the `DUCK_AI_API_KEY` environment variable for a master key, or
  generated keys from the dashboard.
- The key dashboard has no login yet (see `DASHBOARD_NOTES.md`), and
  `keys.json` is a local file — on serverless hosts it may not persist,
  so move the store to a database for a durable public deployment.
