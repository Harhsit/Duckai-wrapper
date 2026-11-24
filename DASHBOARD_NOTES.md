# API Key Dashboard — notes

Added on top of the fixed wrapper so it works like OpenAI's API key
system: anyone who can open the dashboard can create their own key and
use it in their sites/apps to call `POST /api/chat`.

## Admin login gate for key management (added Nov 2026)

User ask: when someone goes to create an API key, the site must
first ask for the admin username and password. There is exactly
ONE fixed admin account.

### Design (server-side, in `index.js`)
- Credentials are checked **on the server only**. Username from
  env `ADMIN_USERNAME` (default `admin`; not a secret). Password
  from env **`ADMIN_PASSWORD`** — set it in the server's
  environment (e.g. `.env` / host config); it is **never written
  in code, this file, or anywhere in the repo**.
- **Fail closed**: if `ADMIN_PASSWORD` is not set, key management
  returns `503 {"status":"error","message":"Admin password not
  configured on the server"}` and login is impossible.
- Endpoints:
  - `POST /api/admin/login` `{username, password}` → on success
    `200` + an httpOnly session cookie (`admin_session`, random
    32-byte token, in-memory Map, 12 h expiry); wrong username or
    password → `401` with one generic message. Both fields are
    compared with `crypto.timingSafeEqual` over SHA-256 digests
    (length-safe). Brute-force hygiene: 300 ms delay on failure,
    and after 5 failed attempts an IP is locked out of login for
    5 minutes (`429`).
  - `POST /api/admin/logout` — clears the session + cookie.
  - `GET /api/admin/status` → `{logged_in: bool, admin_configured: bool}`.
- **Protected** by the admin session (`401 {"status":"error",
  "message":"Admin login required"}` without one):
  `POST /api/keys`, `GET /api/keys`, `DELETE /api/keys/:id`,
  `POST /api/keys/:id/revoke`.
- **Not gated** (unchanged): `POST /api/chat` with API keys (end
  users + the homepage AI Chat), `GET /api/models`, `GET /`,
  `GET /dashboard`. Sessions are in-memory: a server restart logs
  the admin out.

### Dashboard UI (Create API Key tab)
- Before login, the Create + Your keys cards are hidden behind a
  liquid-glass **"🔐 Admin login"** panel (username + password
  fields, Login button, inline error area). On success the panel
  is replaced by the create form + keys list, with a small
  "🔐 Logged in as admin · Logout" bar. On page load the page
  checks `GET /api/admin/status`, so a refresh keeps the session.
  Any `401` from create/list/revoke returns the page to the login
  panel ("session ended" message). The security-note footer now
  states that key management is protected by the admin login.
- The dashboard Test-your-key box and the homepage AI Chat keep
  using API keys exactly as before — no admin login needed there.

### Test results (local, ports 3199/3200, DUCK_AI_API_KEY=testkey123,
ADMIN_USERNAME + ADMIN_PASSWORD set via environment for the test)
- No session: `POST /api/keys` → **401**, `GET /api/keys` → **401**,
  `POST /api/keys/:id/revoke` → **401**; `GET /api/admin/status`
  → `logged_in: false`.
- Login with wrong password → **401**; wrong username → **401**
  (same generic message).
- Login with the correct admin credentials → **200**, session
  cookie set; status → `logged_in: true`.
- With session: `POST /api/keys` → **201** (key masked
  `duck-...A3bQ`), `GET /api/keys` → **200**, `DELETE
  /api/keys/:id` → **200** `revoked: true`, and a second key
  revoked via `POST /api/keys/:id/revoke` → **200**.
- Regression: `POST /api/chat` with the created key (before
  revoke) → **200**, reply "Hello.", `model_used: gpt-5.4-mini`;
  after revoke the same key → **401**. `GET /api/models` → **200**;
  `GET /` → **200**; `GET /dashboard` → **200** and contains the
  admin login panel.
- After `POST /api/admin/logout` → `POST /api/keys` → **401**.
- Fail-closed instance started **without** `ADMIN_PASSWORD`:
  `POST /api/keys` → **503**, `POST /api/admin/login` → **503**
  ("Admin password not configured on the server"), while
  `GET /api/models` still → **200**.
- Puppeteer: dashboard Create tab shows the login panel first
  (admin area hidden); logging in with the test credentials
  reveals the create form and the keys list. PASS.
- Test keys cleaned up (`keys.json` removed), servers stopped.

## Tab switch + liquid-glass top nav (added Nov 2026)

User ask: the dashboard's default view should have a switch between
"Create new API key" and the "How to" instructions — then extended:
a navigation panel on top of the screen, liquid glass UI, on both
pages.

### Dashboard (`dashboard.html`)
- **Sticky liquid-glass top nav** (`.topnav`, first element on the
  page, `position: sticky; top: 12px`): pill-shaped, translucent
  white (`rgba(255,255,255,0.55)`), `backdrop-filter: blur(18px)
  saturate(160%)`, light border, soft shadow. It carries the brand
  "🦆 Duck AI — API Keys", a **Home** link (`/`), and the two tab
  buttons that drive the switch: **🔑 Create API Key** and
  **📖 How to Use — Instructions** (active tab = dark pill).
- **Two tab panels** (existing cards wrapped, no ids/JS renamed):
  - `#tabCreate` (default): "Create a new key" card + "Your keys" card.
  - `#tabHowto` (hidden on load): "How to use your API key" card +
    "Images" card + "Test your key" card.
  - The header card and the security-note footer stay visible under
    both tabs. Switching is instant client-side show/hide via
    `showTab()` — no reload, single page, no new routes.
- **Deep links / hash**: `showTab()` updates the URL hash with
  `history.replaceState` (`#keys` / `#howto`, no scroll jump), and
  `applyHash()` runs on load + `hashchange`: `/dashboard#howto`
  opens the Instructions tab, `#keys` or no hash opens Create.
- **Correction (Nov 2026)**: a third "Test your key" dashboard tab
  was briefly added and then reverted at the user's clarification —
  the dashboard keeps exactly these two tabs, with the "Test your
  key" card inside Instructions. The third tab the user wanted is
  the **💬 AI Chat** tab on the **home page** instead (see the
  home-page section below).
- **Liquid glass theme**: the page background is now a soft fixed
  gradient (pale blue → indigo → violet → pink tints) so the glass
  has something to blur; cards got a light glass treatment
  (`rgba(255,255,255,0.72)` + `blur(14px) saturate(150%)` + light
  border + soft shadow). Code blocks, tables and inputs stay
  (near-)opaque so all text stays crisp and legible.
- Cross-tab behaviour verified: creating a key on the Create tab
  still fills the code examples and pre-fills the test box on the
  Instructions tab; models table, model dropdowns, copy buttons,
  image attach in the test box all keep working (hidden elements
  are populated exactly as before).

### Home page (`GET /`, inline HTML in `index.js`)
- Was a bare one-line `res.send`; now a small full page with the
  **same** glass top nav (brand + links: **Home** `/`,
  **Create API Key** `/dashboard`, **How to Use**
  `/dashboard#howto`), the same gradient background, and the
  original gateway message in a glass card (plus a second link to
  the instructions deep link).

### Test results (local, DUCK_AI_API_KEY=testkey123, port 3145)
- `GET /` → **200** (2,269 bytes): contains `.topnav`,
  `backdrop-filter`, and the three nav links.
- `GET /dashboard` → **200** (36,853 bytes): contains the glass
  nav, both tab buttons/panels, and the `applyHash`/`#howto`/`#keys`
  JS. `node --check index.js` passes.
- Key endpoints unaffected: `POST /api/keys` → key masked
  `duck-...WzKI`, listed by `GET /api/keys`; `GET /api/models` →
  200 live.
- Puppeteer DOM test: default load → Create visible / How-to
  hidden, Create button active. In-browser key creation → masked
  `duck-...11p8`, row appears in "Your keys". Clicking
  **How to Use** → panels swap, hash becomes `#howto`, active pill
  moves, test box is pre-filled with the just-created key, the JS
  example contains the key, models table renders 11 rows, test-box
  model dropdown has 6 models, image attach input present.
  Clicking back → hash `#keys`. Fresh loads: `/dashboard#howto`
  opens Instructions, `/dashboard#keys` opens Create. Computed
  style on both pages' nav: `backdrop-filter: blur(18px)
  saturate(1.6)`; dashboard nav computed `position: sticky`.
- Test keys cleaned up (`keys.json` removed), server stopped.

## Home page 💬 AI Chat tab + Create view full liquid glass (Nov 2026)

User clarification: the third tab belongs on the **home page**
(main homepage, `GET /`), not the dashboard — "when user is on
home, then user can chat with AI and select the models, a good UI,
a fully liquid glass UI." Plus: "Also make the create new API key
page fully liquid glass."

### Home page (`GET /`, inline HTML in `index.js`)
- Glass nav now has four items: **Home** and **💬 AI Chat** are
  in-page view tabs (`.viewbtn` pills, active = dark pill);
  **Create API Key** (`/dashboard`) and **How to Use**
  (`/dashboard#howto`) remain outbound links. `showView()` /
  `applyHash()` switch views client-side: `#chat` opens the chat
  view, anything else opens the welcome view; switching updates
  the hash via `history.replaceState`. The welcome/gateway card
  is unchanged (plus a "Chat with Duck AI right here" teaser link).
- **Chat view** (`#viewChat`), ChatGPT/Claude-style, liquid glass
  to match (gradient bg, glass card/bubbles with backdrop blur):
  - Password-style **API key field** at the top; the key is used
    as the Bearer token for `POST /api/chat` and kept in page
    memory only (never localStorage/cookies — verified). Hint
    links to the Create API Key tab on the dashboard.
  - **Model selector** populated from `GET /api/models`
    (available models only, default = `default_model`).
  - **Thread**: user bubbles right (dark glass), AI bubbles left
    (white glass) with the answering model (`model_used`) shown
    subtly on each AI bubble; friendly empty state
    ("Ask me anything…"); animated typing/"thinking" indicator;
    errors (401 wrong key, other HTTP, network) appear as clear
    in-thread notices.
  - **Composer**: textarea + Send button, Enter sends
    (Shift+Enter = newline). 📎 attach button sends an image as
    the `image` data-URL field (same as the dashboard test box),
    with a preview chip + remove. Generated images in a response
    (`images[].data_url`) render inside the AI bubble.
  - Each send is a single `POST /api/chat` `{message, model,
    image?}` — the on-page thread is visual history only; the
    wrapper API stays single-message.

### Dashboard Create API Key view — fully liquid glass
Applied through the dashboard's shared CSS (Instructions inherits
the same glass, nothing breaks):
- **Cards**: stronger glass — `rgba(255,255,255,0.55)`,
  `blur(20px) saturate(170%)`, bright 1px glass edge + inset top
  highlight, layered soft shadow, 16px rounding.
- **Background**: the linear gradient is enriched with three soft
  radial glows (blue / violet / pink) so the blur refracts
  "liquid" colour.
- **Label input**: translucent glass (`rgba(255,255,255,0.5)` +
  `blur(10px) saturate(140%)`, light border, inset highlight);
  text stays dark/crisp.
- **Buttons**: primary buttons (Create key, Copy key, …) get a
  glossy dark-glass gradient with an inset top highlight; tab
  pills get glass blur/highlight, active pill matches the glossy
  dark look. **Revoke** keeps its red outline, glass-tinted.
- **New-key box**: soft amber glass (`rgba(255,243,190,0.55)` +
  blur/saturate) instead of flat yellow.
- **Keys table**: glass rows — translucent header/row
  backgrounds, soft `rgba` dividers; masked key text stays crisp.
  Code/example blocks elsewhere stay (near-)opaque for legibility.

### Test results (local, DUCK_AI_API_KEY=testkey123, port 3187)
- `GET /` → **200** (13,477 bytes): glass nav with 💬 AI Chat tab,
  `#viewHome`/`#viewChat`, chat markup (`#chatThread`, `#chatKey`,
  `#chatModel`, `#chatInput`, `#chatSend`, `#chatFile`); no
  leftover `/dashboard#test` link.
- `GET /dashboard` → **200**: exactly **2** tab pills, no
  `#tabTest`/`#tabBtnTest`, "Test your key" card inside
  `#tabHowto` (dashboard Test-tab change fully reverted).
- Puppeteer (24/24 PASS): home default = welcome view; clicking
  💬 AI Chat swaps views, hash `#chat`, empty state shows; model
  dropdown loads 6 models, default `gpt-5.4-mini`; sending
  "Say hello in exactly one short sentence." with the master key
  → user bubble + AI bubble "**Hello!**" labelled
  `gpt-5.4-mini`, typing indicator removed, key absent from
  localStorage/cookies; switching back to Home works; fresh load
  `/#chat` opens the chat view directly.
- Computed styles on the dashboard Create view: card
  `backdrop-filter: blur(20px) saturate(1.7)`, background
  `rgba(255, 255, 255, 0.55)`; label input `blur(10px)
  saturate(1.4)` on `rgba(255, 255, 255, 0.5)`; nav
  `blur(18px) saturate(1.6)`. Screenshots of both the Create view
  and the home chat view render cleanly, no layout breakage.
- No test keys created (chat used the master key); server stopped.

## Dashboard
- `GET /dashboard` — simple HTML page (served by Express from
  `dashboard.html`, no build step, no new dependencies). The home page
  `GET /` links to it.
- On the page a visitor can: type a label and create a key, copy the
  new key (with a "shown only once" warning), see existing keys masked,
  and revoke a key.

## "How to use your API key" section (dashboard)
Added to `dashboard.html` so a user who just created a key can see how
to link it to their own website, app, or server:

- **Steps card ("How to use your API key")** explains, in simple steps:
  1. The base URL is this server's own origin, shown dynamically from
     `window.location.origin` (never hardcoded localhost) — when the
     wrapper is deployed, the page and examples show the deployed
     address automatically.
  2. The endpoint: `POST {base}/api/chat`.
  3. Send the key as `Authorization: Bearer YOUR_API_KEY` or
     `x-api-key: YOUR_API_KEY`, with `Content-Type: application/json`
     and body `{"message": "...", "model": "gpt-4o-mini"}` — noting
     `model` is optional, old names like `gpt-4o-mini` are aliases for
     current models, and omitting it uses the default model.
  4. The JSON response shape:
     `{"status": "success", "model_used": "...", "requested_model": "...", "reply": "..."}`
     (and `401` for a wrong/revoked key).
- **Copyable code examples**, each with a Copy button, each built with
  the dynamic base URL and a `YOUR_API_KEY` placeholder:
  - **cURL** (terminal / any server)
  - **JavaScript `fetch()`** for a website — with a clear warning box:
    do not expose the key in public frontend code (anyone can view the
    page source and steal it); call from your backend instead.
  - **Node.js server-side** example (key read from an env var) — the
    recommended way for a real website.
  - **Python `requests`** example.
  - When a key has just been created on the page, all examples are
    automatically filled in with that new key (and the test box below
    is pre-filled) — in the page only; the key is not stored by the
    page and is gone on reload.
- **"Test your key" box**: paste a key, type a message, click
  "Send test message" — the page calls `POST /api/chat` from the
  browser and shows the reply (with HTTP status and model used), or
  the 401/error if the key is wrong or revoked. This is the "link
  test" proving the key + server connection works.

Existing create/list/revoke functionality is unchanged in shape
(it is now behind the admin login — see "Admin login gate" above —
and the footer security note was updated accordingly).

### Test results for the how-to section (local, DUCK_AI_API_KEY=testkey123, port 3110)
- `GET /dashboard` → 200, `text/html`, 13,976 bytes; the served page
  contains the "How to use your API key" section, all four example
  blocks (cURL / JS fetch / Node / Python), the dynamic
  `window.location.origin` base URL, the frontend-key warning, and
  the "Test your key" box.
- `POST /api/keys {"label":"How-to test key"}` → 201, new key masked
  `duck-...K338`.
- `POST /api/chat` with that generated key in the **exact cURL shape
  shown in the examples** (`Authorization: Bearer <key>`, JSON body
  `{"message":"Say hello in exactly one short sentence.","model":"gpt-4o-mini"}`)
  → 200 `{"status":"success","model_used":"gpt-5.4-mini","requested_model":"gpt-4o-mini","reply":"Hello!"}`
- The same request in the **fetch shape** shown on the page (Node
  fetch) → 200, reply "Hello!".
- `POST /api/chat` with a wrong key → 401.
- The test key was cleaned up afterwards (`keys.json` removed), so
  the key store starts fresh on first real use, as before.

## Choosing / changing the AI model (per request, from the external side)
An external user/app chooses the model on **every request** — nothing
has to change on the server:

- Set the `"model"` field in the JSON body of `POST /api/chat`, e.g.
  `{"message": "Hello", "model": "claude-haiku-5-5"}`.
- The wrapper resolves aliases, forwards that model to DuckAI, and
  DuckAI answers with it. The response's `model_used` confirms the
  model that actually answered; `requested_model` echoes what was sent.
- Omitting `model` uses the default (`gpt-5.4-mini`). Old ids remain
  aliases (e.g. `gpt-4o-mini` → `gpt-5.4-mini`).
- An **unknown model now returns `400`** with a clear message plus
  `valid_models` and `aliases` in the JSON — instead of failing
  obscurely upstream.

### `GET /api/models`
- **No API key required** (chosen so external apps and the dashboard
  can discover models without a key).
- Returns `200` JSON: `{ status, default_model, models, aliases, usage }`
  where `models` is `[{id, name, tag}, …]`:
  `gpt-5.4-mini`, `gpt-6-luna`, `tinfoil/gpt-oss-120b`,
  `claude-haiku-5-5`, `tinfoil/gemma4-31b`, `mistral-small-2603`.

### Dashboard model selection
- A **"Change the AI model — from your own site or app"** part in the
  how-to section explains the flow above in simple steps, with a
  **model dropdown** (`#modelSelect`) populated from `GET /api/models`
  (with a built-in fallback list if that fetch fails).
- **Changing the dropdown rewrites the `model` in ALL code examples**
  on the page — cURL, JavaScript `fetch()`, Node.js, and Python
  `requests` — as well as the sample request body.
- The **"Test your key" box has its own model dropdown** (`#testModel`,
  kept in sync with the main one). The selected model is sent in the
  test request, and the result shows both `requested_model` and
  `model_used`, so the user sees DuckAI answered with the model they
  picked.

## How model changing works + all Duck AI models (dashboard instructions)
Added to the how-to area of `dashboard.html`, in the "Change the AI
model" part:

- **"How model changing works — step by step"**: a numbered 6-step flow
  in the instructions — (1) the user/app picks a model and puts it in
  the `"model"` field of `POST /api/chat`, (2) the request reaches this
  wrapper server with their API key (checked first), (3) the server
  validates the model and converts aliases (e.g. `gpt-4o-mini` →
  `gpt-5.4-mini`), unknown → `400` with the valid list, (4) the server
  forwards the message + that model to DuckAI/DuckDuckGo, (5) DuckAI
  answers using that model, (6) the response's `model_used` confirms
  which model actually answered — changing the model in the next
  request changes the answering model, no server restart/redeploy.
- **"Available models on Duck AI" table** (`#modelsTable`): shows
  EVERY model — model id (the exact string to send), display name,
  notes/tag, and status (Available / Subscription). It is populated
  dynamically from `GET /api/models`; a static fallback list renders
  first / if that fetch fails.
- **"Old model names (aliases)" table** (`#aliasesTable`): every
  alias → current model, also populated from `GET /api/models`.
- The model dropdowns (examples + test box) are populated only with
  models Duck AI grants access to (`available !== false`), so a
  copied example always names a model that can actually answer.

### `GET /api/models` is now LIVE-fed
- The handler now fetches `GET https://duckduckgo.com/duckchat/v1/models`
  — verified live (Nov 2026): a **plain GET returns 200**, no
  challenge/token needed — caches the result for 5 minutes, and falls
  back to the static `SUPPORTED_MODELS` list on any error. The
  response gains a `source` field: `"live"` or `"static-fallback"`.
- The live Duck AI list currently has **10 models**. The 6 static
  entries are exactly the access-granted (`entityHasAccess: true`)
  ones; the live list adds 4 subscription-only models
  (`entityHasAccess: false`): `gpt-5.6-terra`, `gpt-5.6-sol`,
  `claude-sonnet-5-5`, `claude-opus-5-5`. Those are displayed in the
  table marked "Subscription" but are **not** accepted for chat from a
  free account (they get the `400` valid-models reply). Chat validation
  also refreshes the live access-granted set, so a newly freed model
  works without a code change.
- Display names come from the live data (provider + live name, no
  duplication); the live name for `mistral-small-2603` is currently
  "Mistral Small 4" and for `gpt-5.4-mini` it is "GPT-5.4 mini".

### Test results for this addition (local, DUCK_AI_API_KEY=testkey123, port 3120)
- Direct live check: `GET https://duckduckgo.com/duckchat/v1/models`
  (plain, UA, and `x-vqd-accept` variants) → **200** each time,
  10 models (listed in the report).
- `GET /api/models` → **200**, `"source": "live"`, all 10 models with
  `available` flags (6 true, 4 false) + aliases.
- `GET /dashboard` → **200**, 21,633 bytes; served page contains the
  "How model changing works — step by step" flow, the "Available
  models on Duck AI" section, `#modelsTable`/`#aliasesTable` and the
  render functions. Dashboard script and `index.js` pass `node --check`.
- `POST /api/keys {"label":"Models page test key"}` → **201**, key
  masked `duck-...4RdA`.
- `POST /api/chat` with that key, model `gpt-5.4-mini` (taken from the
  displayed list), "Say hello in exactly one short sentence." →
  **200** `{"status":"success","model_used":"gpt-5.4-mini","requested_model":"gpt-5.4-mini","reply":"Hello!"}`
- `POST /api/chat` with subscription-only model `gpt-5.6-sol` →
  **400** with the valid-models list (by design — free account).
- Test keys cleaned up (`keys.json` removed), server stopped.

### Test results for model changing (local, DUCK_AI_API_KEY=testkey123, port 3115)
- `GET /api/models` → **200**, listed all 6 models + alias map,
  `default_model: gpt-5.4-mini`.
- `GET /dashboard` → **200**, 17,967 bytes; served page contains the
  "Change the AI model" section and both dropdowns (`modelSelect`,
  `testModel`). Dashboard script passes `node --check`.
- `POST /api/keys {"label":"Model test key"}` → **201**, key masked
  `duck-...HAxw`.
- Model A — `POST /api/chat` with that key, model `gpt-5.4-mini`,
  "Say hello in exactly one short sentence." → **200**,
  `requested_model: gpt-5.4-mini`, `model_used: gpt-5.4-mini`,
  reply: **"Hello."**
- Model B — same key, same message, model changed from the external
  side to `claude-haiku-5-5` → **200**,
  `requested_model: claude-haiku-5-5`, `model_used: claude-haiku-5-5`
  (different from A), reply: **"Hello, it's nice to meet you, and I'm
  happy to help with whatever you have in mind today."**
- Alias spot-check — model `gpt-4o-mini` → **200** (resolves to
  `gpt-5.4-mini`).
- Unknown model `not-a-real-model` → **400** with the clear error
  message, `valid_models` list, and `aliases` map.
- Test keys cleaned up afterwards (`keys.json` removed), server stopped.

## Endpoints
- `GET /api/models` — public (no key), lists available models + aliases (see above).
- `POST /api/keys` — body `{"label": "My site"}` → `201` with
  `{ id, label, created_at, api_key }`. The `api_key` in this response
  is the **only time the full key is ever shown**.
- `GET /api/keys` — lists keys masked (`duck-...` + last 4) with label,
  created_at, last_used_at and revoked status. No full keys, no hashes.
- `DELETE /api/keys/:id` — revokes that key (also
  `POST /api/keys/:id/revoke`). A revoked key gets `401` on `/api/chat`
  immediately.

## Key format & storage
- Format: `duck-` + 32 cryptographically random bytes (base64url),
  generated with Node's `crypto.randomBytes`.
- Storage: `keys.json` in the project folder (created at runtime,
  listed in `.gitignore` together with `.env` and `node_modules/`).
  Each record stores only: `id`, `label`, SHA-256 `hash` of the key,
  `last4`, `created_at`, `last_used_at`, `revoked`.
  **Plaintext keys are never stored** (verified in testing).

## Auth changes (`POST /api/chat`)
`validateApiKey` (Bearer token or `x-api-key` header) now accepts:
1. The master key from the `DUCK_AI_API_KEY` environment variable, if
   set, **and**
2. Any non-revoked generated key (the presented key is hashed and
   compared with the stored hashes; `last_used_at` is updated).

The old hardcoded fallback key from the original repo has been
**removed** from `index.js`. If no master key env var is set,
generated keys still work on their own.

All existing behaviour is unchanged: challenge solving, model aliases,
retry loop, and the `/api/chat` request/response shape.

## ⚠️ Security notes — read before deploying publicly
Key management is now protected by the single admin login (see
"Admin login gate" above) — set `ADMIN_PASSWORD` in the server
environment before deploying, or key management stays disabled
(503, fail closed). The dashboard page itself and `POST /api/chat`
remain reachable without the admin login by design: chat callers
authenticate with their own API keys. A full multi-user account
system was intentionally not built.

Note also: on serverless hosts (e.g. Vercel) the local `keys.json`
file may not persist between invocations — for a durable public
deployment, move the key store to a real database/file store.

## Test results (local, DUCK_AI_API_KEY=testkey123, port 3107)
- `GET /` → 200, now links to `/dashboard`.
- `GET /dashboard` → 200, `text/html`, title "Duck AI — API Keys".
- `POST /api/keys {"label":"Test site key"}` → 201, returned a full
  `duck-...` key once (masked `duck-...9jg0` in notes), and `keys.json`
  contained only its SHA-256 hash — no plaintext.
- `GET /api/keys` → 200, key listed masked as `duck-...9jg0`, active.
- `POST /api/chat` with a wrong key → 401.
- `POST /api/chat` with the **new generated key**, message "Say hello
  in exactly one short sentence.", model `gpt-4o-mini` → 200
  `{"status":"success","model_used":"gpt-5.4-mini","requested_model":"gpt-4o-mini","reply":"Hello!"}`
  and `last_used_at` was recorded.
- `DELETE /api/keys/:id` → 200, `revoked: true`; the same generated
  key then got **401** on `/api/chat`.
- `POST /api/chat` with the master key (`DUCK_AI_API_KEY`) → 200,
  reply "Hello!" — master key still works.
- The test key store was cleaned up after testing, so `keys.json`
  starts fresh on first real use.

## Images (added Nov 2026 — investigated live, then implemented)

### What DuckAI upstream actually returns (evidence)
Prompt "Generate an image of a red cat sitting on a chair" to
`POST /duckchat/v1/chat` (model `gpt-5.4-mini`) does NOT return text.
The stream contains only tool/ui chunks (no `message` chunks):
- `{role:"ui-component", name:"generate-image", data:{type:"image-title", title:"Drawing a red cat on chair"}}`
- `{role:"tool-invocation", toolName:"GenerateImage", toolArguments:"{imageGenPrompt: ..., imageToUse: 'none'}", state:"call"}`
- `{role:"tool-invocation", state:"result", result:"Image generated successfully."}`
- `{role:"ui-component", name:"generate-image", data:{status:"success", b64Image:"<base64 JPEG, ~290k chars>", format:"jpeg", width:1024, height:1024, imageModelDisplayName:"GPT Image 2.5", generationDurationMs, moderationToken}}`

Facts verified live:
- Image generation works with `canUseTools` true AND false — asking
  for a picture in the prompt is enough. It also works when the
  wrapper sends `"generateImage": true`, which adds the web app's
  forcing fields (`canDelegateImageGeneration: true`,
  `metadata.toolChoice.GenerateImage: true`) — upstream accepts them.
- Live `GET /duckchat/v1/models`: `supportedTools` includes
  `GenerateImage` only for the OpenAI GPT models (free access:
  `gpt-5.4-mini`, `gpt-6-luna`) and the subscription Claude
  Sonnet/Opus models. `claude-haiku-5-5`, `mistral-small-2603`,
  `tinfoil/*` do NOT have it. Claude Haiku, asked for an image,
  replies in text: "I can't generate images, since I only work
  with text here…" / "I'm a text-based model…".
- "Show me images of the Eiffel Tower" does NOT generate/fetch
  pictures — GPT runs `WebSearch` and answers in text with web-page
  citation sources (role:"source" chunks), not image URLs.
- Image INPUT: live models flag `supportsImageUpload: true` and
  `supportedFileTypes: ["application/pdf"]` for most models, and
  third-party clients describe content-part / file-upload flows used
  by the Duck AI web UI. But the two plausible server-side content
  shapes tried here (OpenAI-style `image_url` parts; `{type:"image"}`
  blocks) were both rejected upstream with `400 ERR_BAD_REQUEST`.
  No clear working server-side image-input path was found, so this
  wrapper does NOT accept image input — do not invent one.

### What the wrapper now does
- The stream parser collects images into a new `images` array in
  the `POST /api/chat` response (additive, backward compatible):
  generated images as `{type:"generated", format, width, height,
  alt (the generation title), image_model, b64_image, data_url}`
  where `data_url` is `data:image/<format>;base64,...`, ready for
  an `<img src>`. Image URLs / markdown `![](url)` images found in
  the stream are added as `{type:"url", url, alt}`. Deduplicated.
  The response also gains `tools_used` (e.g. `["GenerateImage"]`).
- IMPORTANT for callers: when DuckAI returns only an image, `reply`
  is `""` — always check `images` as well as `reply`.
- `GET /api/models` entries now also carry `image_generation`
  (from the live `supportedTools`) and `supports_image_upload` flags.
- Dashboard: new "Images" card explaining the above (how to request
  an image, which models, the response shape, and the image-input
  limitation), and the Test box now renders returned images under
  the reply (and treats an image-only reply as success).

### Test results (local, port 3125, master key + a generated key)
- Text sanity: "Say hello…" → 200, `reply:"Hello!"`, `images:[]`.
- Image prompt, master key, `gpt-5.4-mini` → 200,
  `tools_used:["GenerateImage"]`, `images:[{type:"generated",
  format:"jpeg", width:1024, height:1024, alt:"Drawing a red cat
  on a chair, cozy indoor scene", image_model:"GPT Image 2.5",
  b64_image length 291,496}]`; the base64 decoded to 218,622 bytes
  with JPEG magic `ffd8ff` — a real image, through the wrapper.
- `"generateImage": true`, model `gpt-6-luna`, prompt "A lighthouse
  at sunset, waves crashing" → 200, 1 generated JPEG 1024×1024.
- Same flow with a dashboard-generated key (masked `duck-...X0fI`)
  → 200, 1 generated JPEG; key revoked afterwards, wrong key → 401.
- Claude Haiku image prompt → 200, `images:[]`, text refusal
  (upstream limitation, correctly passed through).
- Test keys cleaned up (`keys.json` removed), server stopped.

## Image INPUT (vision) — added Nov 2026, supersedes the "not found" note above

### How duck.ai's web app sends an attached image (found + proven)
The earlier probe failed because it tried the wrong shapes
(OpenAI-style `image_url` parts and `{type:"image", image:<raw
base64>}` — both upstream `400 ERR_BAD_REQUEST`). The real shape
was found in the duck.ai web bundle's sendable-message code and
then proven live: the user message's `content` becomes an ARRAY
of parts and the request carries `canUploadFiles: true`:

```json
{ "model": "gpt-5.4-mini", "canUploadFiles": true,
  "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "What colors are in this image?" },
    { "type": "image", "mimeType": "image/png",
      "image": "data:image/png;base64,...." } ] }],
  "canUseTools": false, "reasoningEffort": "none" }
```

The `image` field must be a full DATA URL. (The web app downsizes
images and sends PNG/WebP data URLs; there is no separate
files/upload endpoint in this flow.)

### Proving tests (direct upstream, before wrapping)
Synthetic PNGs with known content:
- 64×64, left GREEN / right YELLOW → gpt-5.4-mini: "Left: neon
  green. Right: yellow-green." ✔
- 64×64, top RED / bottom BLUE → claude-haiku-5-5: "The top half
  is red and the bottom half is blue." ✔ ; tinfoil/gemma4-31b ✔
- mistral-small-2603 → upstream 400 (its live flags say
  supportsImageUpload: false) ✔ consistent
- gpt-6-luna anomaly: on the green/yellow image it twice answered
  "yellow/yellow" (wrong), although its flags claim upload
  support. Vision quality varies by model — gpt-5.4-mini, Claude
  Haiku and Gemma were accurate in every wrapper test below.

### Wrapper API (backward compatible; text-only unchanged)
`POST /api/chat` additionally accepts:
- `"image": "data:image/png;base64,...."` — one image, or
- `"images": [ <data URL or {"data_url": "..."} or
  {"base64": "...", "mimeType": "image/png"}>, ... ]` — max 4
JSON only (no multipart). Limits: PNG/JPEG/WebP/GIF, max 5 MB per
image decoded; base64, data-URL format and file signature are
validated — bad input gets a clear `400` (e.g. "Image bytes do
not look like image/png"). Models that don't accept images get a
clear local `400` listing `vision_models`. The response gains
`"input_images": <count>`. Dashboard test box has an attach
button with preview, and the Images card documents JS / Node /
Python / cURL usage.

### Test results through the wrapper (port 3126)
Test image: 256×256 PNG, LEFT half pure red, RIGHT half pure blue.
- gpt-5.4-mini → "Left: red. Right: blue." ✔
- claude-haiku-5-5 → "The left half is red and the right half is
  blue…" ✔ ; tinfoil/gemma4-31b → ✔ correct
- `images: [same, same]` → "You attached 2 images. They show red
  and blue." ✔ (count + content both seen)
- Dashboard-generated key (masked `duck-...5UHA`) + image →
  correct answer; key revoked and test store cleaned up after.
- Bad data URL / non-PNG bytes → 400 with reason; mistral +
  image → 400 with vision_models list; text-only chat → 200
  "Hello!" with `input_images: 0`; image generation regression →
  still returns 1 generated JPEG 1024×1024.
- One honesty note: on the tiny 64×64 red-top/blue-bottom PNG,
  gpt-5.4-mini once inverted top/bottom (Claude, same payload,
  was correct). At 256×256 all three models were correct.

## Image creation models in the list + how-to (added Nov 2026)

User ask: "add image creation models also and in how to instruction"
— (1) the models list must show WHICH models can create images, and
(2) the how-to instructions must cover image creation properly.

### `GET /api/models` — new per-model `capabilities` (additive only)
Each model entry now also carries:
```json
"capabilities": { "chat": true, "image_input": <bool>, "image_creation": <bool|null> },
"image_creation_note": <string|null>
```
How each value is decided:
- `chat`: always `true` (subscription models still need a paid plan —
  see the existing `available` flag).
- `image_input`: from the **live** Duck AI `supportsImageUpload`
  flag when the live list is fetched (it is, normally); in the
  static-fallback list it comes from the verified static vision set
  (`gpt-5.4-mini`, `gpt-6-luna`, `claude-haiku-5-5`,
  `tinfoil/gemma4-31b`). Live check at build time: upload = true for
  all except `mistral-small-2603` and `tinfoil/gpt-oss-120b`.
- `image_creation`: **tested evidence only** — `true` for
  `gpt-5.4-mini` and `gpt-6-luna` (both generated real images
  end-to-end through this wrapper), `false` for `claude-haiku-5-5`,
  `mistral-small-2603`, `tinfoil/gpt-oss-120b`, `tinfoil/gemma4-31b`
  (asked, and refused / have no GenerateImage tool). For the 4
  subscription-only models it is **`null`** with
  `image_creation_note: "Subscription model — not tested on a free
  account"` — no claim either way (the subscription GPTs are OpenAI
  GPT family, noted as such on the dashboard, but unverified here).
  The older raw fields (`image_generation` from the live
  `supportedTools` flag, `supports_image_upload`) are unchanged, and
  the `usage` string now documents `capabilities` too. The static
  fallback list carries the same shape, consistent with the above.

### Dashboard
- **Models table** gained a **Capabilities** column, rendered from
  the `/api/models` data (with the raw flags as fallback): each row
  shows `Chat: Yes`, `Image input (send images): Yes/No`, and
  `Image creation: Yes/No` — or the untested note text for the
  subscription models. The built-in fallback model list carries the
  same capability values. The intro paragraph above the table
  explains the column.
- **New "Image creation — ask DuckAI to make a picture" subsection**
  in the Images card, teaching: the image creation models by name/id
  (`gpt-5.4-mini`, `gpt-6-luna`; subscription GPTs noted as untested),
  how to ask (a message asking for a picture, or `"generateImage":
  true` with a GPT model), that other models (Claude/Mistral/Tinfoil)
  only answer in text saying they can't, and what comes back (the
  `images` array — put `images[0].data_url` straight into an
  `<img src>`; the text `reply` may be empty for an image-only
  response). It includes **copyable examples with Copy buttons** for
  image creation in JavaScript (fetch), Node.js (saves the JPEG from
  `b64_image`), Python (requests) and cURL — all built by
  `buildExamples()` with the dynamic base URL and the page's key
  placeholder/fill-in, with the model fixed to `gpt-5.4-mini` on
  purpose (creation only works with the creation models). The
  existing image-input instructions/examples are unchanged, now
  under their own "Image input" heading.

### Test results (local, DUCK_AI_API_KEY=testkey123, port 3131)
- `GET /api/models` → **200**, `"source": "live"`, 10 models, every
  entry with `capabilities` + `image_creation_note`. Free models:
  `gpt-5.4-mini` {chat ✓, input ✓, creation ✓}, `gpt-6-luna`
  {✓, ✓, ✓}, `claude-haiku-5-5` {✓, ✓, ✗}, `tinfoil/gemma4-31b`
  {✓, ✓, ✗}, `mistral-small-2603` {✓, ✗, ✗}, `tinfoil/gpt-oss-120b`
  {✓, ✗, ✗}. Subscription models (`gpt-5.6-terra`, `gpt-5.6-sol`,
  `claude-sonnet-5-5`, `claude-opus-5-5`): creation `null` + the
  subscription note; input from the live flag (true for all four).
- `GET /dashboard` → **200**, 33,972 bytes; served page contains the
  capabilities renderer, the "Image creation — ask DuckAI to make a
  picture" subsection, and all four creation example blocks
  (`exImgJs` / `exImgNode` / `exImgPython` / `exImgCurl`).
  Dashboard script and `index.js` pass `node --check`.
- Regression — `POST /api/keys {"label":"Image creation caps test"}`
  → key masked `duck-...VWLE`; `POST /api/chat` with that key,
  `{"message":"Generate an image of a simple yellow star on a white
  background","model":"gpt-5.4-mini","generateImage":true}` →
  **200**, `model_used: gpt-5.4-mini`, `tools_used: ["GenerateImage"]`,
  `images` length **1**: `{type:"generated", format:"jpeg",
  width:1024, height:1024, image_model:"GPT Image 2.5",
  alt:"Drawing a yellow five-pointed star"}`, `data_url` starts
  with `data:image`, `reply: ""` (image-only, as documented).
- Test keys cleaned up (`keys.json` removed), server stopped.

## Keyless chat — `ALLOW_KEYLESS_CHAT` (personal deployments)

Added for Harshit's personal deployment pattern (like his music
wrapper on Render): only he uses the deployment, his app knows only
the server address, and if the host wipes `keys.json` on restart the
chat must keep working with no key at all.

### The setting
- **Env var: `ALLOW_KEYLESS_CHAT`** — keyless mode is ON only when it
  is set to exactly `true` (case-insensitive). Unset, or any other
  value, means OFF.
- **ON:** `POST /api/chat` accepts requests with **no API key at all**
  (no `Authorization` / `x-api-key` header) and returns a real DuckAI
  reply (`req.apiKeyType = 'keyless'`). Image input and image
  creation go through the same endpoint, so they work keyless too.
  Requests **with** a valid master or generated key work exactly as
  before. The homepage AI Chat also works without a key in this mode:
  the page is rendered with `KEYLESS_CHAT = true`, the key field is
  labelled optional, and no key header is sent when the field is
  empty.
- **OFF (default):** behaviour is unchanged — no key = 401, wrong
  key = 401. The public repo stays safe by default; keyless is
  strictly opt-in per deployment.
- **Invalid key in keyless mode — decision: still 401.** If a request
  *presents* a key that is wrong or revoked, it is rejected even in
  keyless mode; keyless applies only when no key is sent at all.
  Rationale: a wrong/revoked credential should fail loudly instead of
  silently downgrading to anonymous access — an app using a revoked
  key would otherwise never notice. To chat keyless, remove the key
  header entirely.
- **`/api/models`:** unchanged — it was already public (no key
  required) so external apps can discover models; no keyless logic
  was needed there.
- **Key management is NOT affected:** creating / listing / revoking
  keys still requires the single admin login in both modes.

### Enable it on Render
In the Render service → **Environment**, add:
- `ALLOW_KEYLESS_CHAT` = `true`
- `ADMIN_USERNAME` = `admin` (optional; this is the default)
- `ADMIN_PASSWORD` = your admin password (required for key management)
- `DUCK_AI_API_KEY` = a master key (optional)

Redeploy / restart the service after setting it. Because keyless
chat does not depend on stored keys, a restart that wipes
`keys.json` no longer breaks chat — generated keys created before
the wipe stop working (their hashes are gone), but keyless chat and
the master key keep working.

### ⚠️ Security note
With `ALLOW_KEYLESS_CHAT=true`, **anyone who knows the server
address can use the deployment** — there is no per-user gate on
chat. That is fine for a personal deployment only the owner uses
(Harshit's case: his own Android app calling his own Render
address). Do **not** enable it on a deployment you share publicly
unless you accept that anyone can use it (and use up the upstream
DuckAI goodwill/rate limits through your server).

### Test results (local, throwaway env values only;
### ADMIN_USERNAME=admin, ADMIN_PASSWORD=<throwaway>,
### DUCK_AI_API_KEY=<throwaway master key>)
Two instances from this folder: A on port 3241 with
`ALLOW_KEYLESS_CHAT=true`, B on port 3242 with it unset (default).

- A `GET /` → **200** (page rendered with `KEYLESS_CHAT = true`);
  B `GET /` → **200** (`KEYLESS_CHAT = false`);
  A and B `GET /dashboard` → **200**.
- A — key created via admin login (masked `duck-...1_Rw`) for the
  with-key tests below.
- **Keyless ON, NO key**, `{"message":"Say hello in exactly one
  short sentence."}` → **200**, reply **"Hello!"**,
  `model_used: gpt-5.4-mini`.
- **Keyless ON, NO key, `"model":"gpt-6-luna"`** → **200**, reply
  "Hello!", **`model_used: gpt-6-luna`** (model selection works
  keyless).
- **Keyless ON, valid generated key** → **200**, reply "Hello!",
  `model_used: gpt-5.4-mini` (keys still work in keyless mode).
- Keyless ON, **invalid** key (`Bearer duck-totally-wrong-key`) →
  **401** (the documented decision above).
- **Keyless OFF (default), NO key** → **401** "missing API Key".
- **Keyless OFF, valid generated key** → **200**, reply "Hello!",
  `model_used: gpt-5.4-mini`.
- A `GET /api/models` with no key → **200**, `"source": "live"`
  (unchanged public behaviour).
- Test key / `keys.json` removed and both servers stopped after
  the tests.
