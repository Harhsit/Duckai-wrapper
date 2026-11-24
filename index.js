const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { solveChallenge, USER_AGENT } = require('./challenge');

const app = express();

// 🌐 FULLY OPEN CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));
app.use(express.json({ limit: '10mb' }));

// 🔑 API KEY SETUP
// Master key (optional): set DUCK_AI_API_KEY in the environment.
// The old hardcoded fallback key has been REMOVED — there is no
// built-in key in the code anymore. If no master key is set,
// generated keys (below) still work on their own.
const MASTER_API_KEY = process.env.DUCK_AI_API_KEY || null;

// 🔓 KEYLESS CHAT (optional, personal deployments only)
// Set ALLOW_KEYLESS_CHAT=true in the environment to make the API key
// OPTIONAL on POST /api/chat (and the homepage AI Chat, which uses the
// same endpoint): requests with NO key at all are then accepted, like
// a private wrapper that only needs its server address. Requests WITH
// a valid master/generated key keep working exactly as before in both
// modes. A request that presents an INVALID (wrong or revoked) key is
// still rejected with 401 even in keyless mode — remove the key header
// entirely to chat keyless. Default (unset / anything but "true"):
// key REQUIRED, exactly as before — safe default for public deploys.
// ⚠️ SECURITY: with keyless chat ON, anyone who knows the server
// address can use it. Only enable this on a personal deployment.
const ALLOW_KEYLESS_CHAT = String(process.env.ALLOW_KEYLESS_CHAT || '').trim().toLowerCase() === 'true';

// 🔐 ADMIN LOGIN (gates API-key MANAGEMENT only — not /api/chat)
// Exactly ONE fixed admin account. The username comes from
// ADMIN_USERNAME (default "admin"; not a secret). The password
// comes ONLY from the ADMIN_PASSWORD environment variable — it is
// never written in code. If ADMIN_PASSWORD is not set, the gate
// fails CLOSED: key management returns 503 and login is impossible.
// Sessions are random tokens in an httpOnly cookie, kept in an
// in-memory Map (a server restart logs the admin out).
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const ADMIN_COOKIE = 'admin_session';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const adminSessions = new Map(); // token -> expiresAt (ms epoch)
// Simple brute-force hygiene: after 5 failed logins from one IP,
// that IP is locked out of the login endpoint for 5 minutes.
const adminLoginFails = new Map(); // ip -> { count, lockedUntil }
const ADMIN_MAX_FAILS = 5;
const ADMIN_LOCKOUT_MS = 5 * 60 * 1000;

// Constant-time string compare that never throws on length mismatch:
// both sides are hashed to fixed-length digests first.
function safeEqual(a, b) {
    const da = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
    const db = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
    return crypto.timingSafeEqual(da, db);
}

function parseCookies(req) {
    const out = {};
    const raw = req.headers && req.headers.cookie;
    if (!raw) return out;
    for (const part of String(raw).split(';')) {
        const idx = part.indexOf('=');
        if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return out;
}

function adminSessionToken(req) {
    return parseCookies(req)[ADMIN_COOKIE] || null;
}

function hasAdminSession(req) {
    const token = adminSessionToken(req);
    if (!token) return false;
    const expiresAt = adminSessions.get(token);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) { adminSessions.delete(token); return false; }
    return true;
}

// Middleware for the /api/keys management endpoints.
function requireAdmin(req, res, next) {
    if (!ADMIN_PASSWORD) {
        return res.status(503).json({
            status: "error",
            message: "Admin password not configured on the server"
        });
    }
    if (!hasAdminSession(req)) {
        return res.status(401).json({
            status: "error",
            message: "Admin login required"
        });
    }
    return next();
}

app.post('/api/admin/login', async (req, res) => {
    if (!ADMIN_PASSWORD) {
        return res.status(503).json({
            status: "error",
            message: "Admin password not configured on the server"
        });
    }
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    const fail = adminLoginFails.get(ip);
    if (fail && fail.lockedUntil && Date.now() < fail.lockedUntil) {
        return res.status(429).json({
            status: "error",
            message: "Too many failed login attempts. Try again in a few minutes."
        });
    }
    const { username, password } = req.body || {};
    // Check both fields with constant-time compares, regardless of
    // which one is wrong, and answer with one generic message.
    const userOk = safeEqual(username || '', ADMIN_USERNAME);
    const passOk = safeEqual(password || '', ADMIN_PASSWORD);
    if (!userOk || !passOk) {
        const rec = fail || { count: 0, lockedUntil: 0 };
        rec.count += 1;
        if (rec.count >= ADMIN_MAX_FAILS) {
            rec.lockedUntil = Date.now() + ADMIN_LOCKOUT_MS;
            rec.count = 0;
        }
        adminLoginFails.set(ip, rec);
        await new Promise(r => setTimeout(r, 300)); // small delay vs brute force
        return res.status(401).json({
            status: "error",
            message: "Invalid username or password"
        });
    }
    adminLoginFails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
    res.setHeader('Set-Cookie',
        `${ADMIN_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`);
    return res.json({ status: "success", username: ADMIN_USERNAME });
});

app.post('/api/admin/logout', (req, res) => {
    const token = adminSessionToken(req);
    if (token) adminSessions.delete(token);
    res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    return res.json({ status: "success" });
});

app.get('/api/admin/status', (req, res) => {
    const loggedIn = hasAdminSession(req);
    return res.json({
        status: "success",
        logged_in: loggedIn,
        admin_configured: !!ADMIN_PASSWORD,
        ...(loggedIn ? { username: ADMIN_USERNAME } : {})
    });
});

// 🔑 FIXED (MASTER) API KEY — admin-session ONLY.
// Returns the master key from the DUCK_AI_API_KEY environment
// variable so the admin can see/copy it from the dashboard after
// logging in (e.g. on Vercel, where the key lives in Settings →
// Environment Variables and therefore survives redeploys, unlike
// generated keys stored in keys.json). Protected by requireAdmin:
// no admin session → 401 "Admin login required" (503 if no admin
// password is configured), exactly like the key-management
// endpoints. The key is NEVER sent anywhere else: it is not in
// the dashboard page source, the homepage, or any public endpoint
// — the dashboard fetches it from here only after admin login.
// If no master key is configured, returns { configured: false }
// and no key material at all.
app.get('/api/admin/master-key', requireAdmin, (req, res) => {
    if (!MASTER_API_KEY) {
        return res.json({ status: "success", configured: false });
    }
    return res.json({
        status: "success",
        configured: true,
        api_key: MASTER_API_KEY,
        masked_key: '...' + MASTER_API_KEY.slice(-4),
        last4: MASTER_API_KEY.slice(-4)
    });
});

// 🗝️ GENERATED API KEYS (OpenAI-style)
// Keys are created from the dashboard (/dashboard) or POST /api/keys.
// Only a SHA-256 hash of each key is stored in keys.json — never the
// plaintext key. The full key is shown exactly once, at creation.
const KEYS_FILE = path.join(__dirname, 'keys.json');
const KEY_PREFIX = 'duck-';

function hashKey(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function loadKeys() {
    try {
        const raw = fs.readFileSync(KEYS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function saveKeys(keys) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

function generateApiKey() {
    return KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function maskKeyRecord(rec) {
    return {
        id: rec.id,
        label: rec.label,
        masked_key: KEY_PREFIX + '...' + (rec.last4 || '????'),
        created_at: rec.created_at,
        last_used_at: rec.last_used_at || null,
        revoked: !!rec.revoked
    };
}

function createKeyRecord(label) {
    const fullKey = generateApiKey();
    const rec = {
        id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex'),
        label: String(label || 'Untitled key').slice(0, 100),
        hash: hashKey(fullKey),
        last4: fullKey.slice(-4),
        created_at: new Date().toISOString(),
        last_used_at: null,
        revoked: false
    };
    const keys = loadKeys();
    keys.push(rec);
    saveKeys(keys);
    return { fullKey, rec };
}

// 🤖 SUPPORTED MODELS LIST — current free lineup on duck.ai
// (verified live against GET /duckchat/v1/models, Nov 2026)
const SUPPORTED_MODELS = [
    { id: 'gpt-5.4-mini', name: 'OpenAI GPT-5.4 Mini', tag: 'Default & Fastest' },
    { id: 'gpt-6-luna', name: 'OpenAI GPT-6 Luna', tag: 'Latest' },
    { id: 'tinfoil/gpt-oss-120b', name: 'OpenAI OSS 120B (Tinfoil)', tag: 'Open Source' },
    { id: 'claude-haiku-5-5', name: 'Anthropic Claude Haiku 5.5', tag: 'Smart' },
    { id: 'tinfoil/gemma4-31b', name: 'Google Gemma 4 31B (Tinfoil)', tag: 'Open Weights' },
    { id: 'mistral-small-2603', name: 'Mistral Small 2603', tag: 'Efficient' }
];

// 🔁 Legacy model IDs from the old version of this wrapper -> current IDs.
// The old IDs now return 404 ERR_MODEL_UNAVAILABLE from DuckDuckGo.
const MODEL_ALIASES = {
    'gpt-4o-mini': 'gpt-5.4-mini',
    'gpt-5-mini': 'gpt-5.4-mini',
    'gpt-oss-120b': 'tinfoil/gpt-oss-120b',
    'claude-4.5-haiku': 'claude-haiku-5-5',
    'claude-4-5-haiku': 'claude-haiku-5-5',
    'llama-4-scout': 'tinfoil/gemma4-31b',
    'mistral-small-3-24b': 'mistral-small-2603'
};

function resolveModel(model) {
    const requested = model || 'gpt-5.4-mini';
    return MODEL_ALIASES[requested] || requested;
}

// 🖼️ IMAGE INPUT (vision) — verified live, Nov 2026.
// How the Duck AI web app sends an attached image (found in the
// duck.ai bundle's sendable-message construction, then proven live):
// the user message's `content` becomes an ARRAY of parts —
//   [{type:"text", text:"<message>"},
//    {type:"image", mimeType:"image/png", image:"data:image/png;base64,..."}]
// — and the request carries `canUploadFiles: true`. The `image`
// field must be a full DATA URL (raw base64 alone is rejected
// upstream with 400, as are OpenAI-style image_url parts).
// Proof: a synthetic 64×64 PNG, left half green / right half yellow,
// asked "what color is each half?" — gpt-5.4-mini answered green /
// yellow; a red-top/blue-bottom PNG got exact answers from
// claude-haiku-5-5 and tinfoil/gemma4-31b. mistral-small-2603
// (supportsImageUpload: false in the live models list) → upstream 400.
const IMAGE_INPUT_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // per image, decoded
const MAX_IMAGES_PER_MESSAGE = 4;
// Models known (live flags / live tests) to accept image input,
// used when the live models list is unavailable.
const STATIC_VISION_MODELS = new Set([
    'gpt-5.4-mini', 'gpt-6-luna', 'claude-haiku-5-5', 'tinfoil/gemma4-31b'
]);
const liveVisionModelIds = new Set();
const liveNoVisionModelIds = new Set();

// 🎨 IMAGE CREATION — TESTED evidence only (verified live, Nov 2026).
// DuckAI's GPT models run a GenerateImage tool inside the chat stream
// and return a real generated picture; the other free models were
// asked and refused in text (no GenerateImage tool). Only models
// actually tested end-to-end are listed here. The subscription-only
// models (gpt-5.6-terra/sol, claude-sonnet-5-5, claude-opus-5-5)
// cannot be used from a free account, so they are deliberately NOT
// in this map: /api/models reports image_creation: null for them,
// with an explanatory note, rather than claiming either way.
const IMAGE_CREATION_TESTED = {
    'gpt-5.4-mini': true,
    'gpt-6-luna': true,
    'claude-haiku-5-5': false,
    'mistral-small-2603': false,
    'tinfoil/gpt-oss-120b': false,
    'tinfoil/gemma4-31b': false
};
const IMAGE_CREATION_SUBSCRIPTION_NOTE = 'Subscription model — not tested on a free account';

// Build the per-model `capabilities` object for GET /api/models.
//   chat:           every listed model can chat (subscription ones
//                   only with a paid Duck AI plan, see `available`).
//   image_input:    from the live supportsImageUpload flag when the
//                   live list is in hand; otherwise the verified
//                   static vision set above.
//   image_creation: TESTED evidence only (IMAGE_CREATION_TESTED);
//                   null when untested (e.g. subscription models).
function buildCapabilities(modelId, liveUploadFlag, available) {
    const hasTested = Object.prototype.hasOwnProperty.call(IMAGE_CREATION_TESTED, modelId);
    return {
        capabilities: {
            chat: true,
            image_input: typeof liveUploadFlag === 'boolean'
                ? liveUploadFlag
                : STATIC_VISION_MODELS.has(modelId),
            image_creation: hasTested ? IMAGE_CREATION_TESTED[modelId] : null
        },
        image_creation_note: hasTested
            ? null
            : (available === false
                ? IMAGE_CREATION_SUBSCRIPTION_NOTE
                : 'Not tested yet')
    };
}

function imageMagicOk(buf, mime) {
    if (mime === 'image/png') return buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (mime === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (mime === 'image/webp') return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    if (mime === 'image/gif') return buf.length > 3 && buf.toString('ascii', 0, 3) === 'GIF';
    return false;
}

// Normalise the caller's image input into upstream image parts.
// Accepted caller shapes (all JSON; no multipart):
//   { "image":  "data:image/png;base64,...." }
//   { "image":  { "data_url": "data:..." } }  or { "base64": "...", "mimeType": "image/png" }
//   { "images": [ <any of the above>, ... ] }
// Returns { parts: [{type:'image', mimeType, image}], error: null|string }
function parseImageInput(body) {
    let rawList = [];
    if (body && body.image != null) rawList = [body.image];
    if (body && body.images != null) {
        if (!Array.isArray(body.images)) return { parts: null, error: '"images" must be an array.' };
        rawList = rawList.concat(body.images);
    }
    if (!rawList.length) return { parts: [], error: null };
    if (rawList.length > MAX_IMAGES_PER_MESSAGE) {
        return { parts: null, error: `Too many images: max ${MAX_IMAGES_PER_MESSAGE} per message.` };
    }
    const parts = [];
    for (const item of rawList) {
        let dataUrl = null, mime = null, b64 = null;
        if (typeof item === 'string') {
            if (item.startsWith('data:')) dataUrl = item;
            else return { parts: null, error: 'Image string must be a data URL: "data:image/png;base64,....". Raw base64 needs an object: {"base64": "...", "mimeType": "image/png"}.' };
        } else if (item && typeof item === 'object') {
            if (typeof item.data_url === 'string') dataUrl = item.data_url;
            else if (typeof item.dataUrl === 'string') dataUrl = item.dataUrl;
            else if (typeof item.image === 'string' && item.image.startsWith('data:')) dataUrl = item.image;
            else if (typeof item.base64 === 'string') { b64 = item.base64; mime = item.mimeType || item.mime_type || null; }
            else return { parts: null, error: 'Image object must carry "data_url" (a data URL) or "base64" + "mimeType".' };
        } else {
            return { parts: null, error: 'Each image must be a data URL string or an object with data_url / base64.' };
        }
        if (dataUrl) {
            const m = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
            if (!m) return { parts: null, error: 'Malformed image data URL — expected "data:image/<type>;base64,<data>".' };
            mime = m[1].toLowerCase();
            b64 = m[2].replace(/\s+/g, '');
        }
        if (!mime || !IMAGE_INPUT_MIMES.includes(mime)) {
            return { parts: null, error: `Unsupported image type "${mime || 'unknown'}". Use one of: ${IMAGE_INPUT_MIMES.join(', ')}.` };
        }
        if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) {
            return { parts: null, error: 'Image data is not valid base64.' };
        }
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length) return { parts: null, error: 'Image data is empty.' };
        if (buf.length > MAX_IMAGE_BYTES) {
            return { parts: null, error: `Image too large: ${(buf.length / 1048576).toFixed(1)} MB (max ${MAX_IMAGE_BYTES / 1048576} MB per image).` };
        }
        if (!imageMagicOk(buf, mime)) {
            return { parts: null, error: `Image bytes do not look like ${mime} (file signature mismatch).` };
        }
        parts.push({ type: 'image', mimeType: mime, image: `data:${mime};base64,${buf.toString('base64')}` });
    }
    return { parts, error: null };
}

function modelSupportsImageInput(modelId) {
    if (liveVisionModelIds.has(modelId)) return true;
    if (liveNoVisionModelIds.has(modelId)) return false;
    if (liveModelsCache) return false; // live list loaded and model not flagged for upload
    return STATIC_VISION_MODELS.has(modelId);
}

function isSupportedModel(modelId) {
    return SUPPORTED_MODELS.some(m => m.id === modelId) ||
        liveAvailableModelIds.has(modelId);
}

// 🌐 LIVE MODELS LIST — what Duck AI actually offers right now.
// GET https://duckduckgo.com/duckchat/v1/models answers a plain GET
// (verified live, Nov 2026: HTTP 200, no challenge/token needed) with
// every model on Duck AI, including subscription-only ones. We fetch
// it for GET /api/models (cached a few minutes) and fall back to the
// static SUPPORTED_MODELS list above if the fetch ever fails.
// Note: the live list also contains models a free Duck AI account
// cannot use (entityHasAccess: false, e.g. Plus/Pro models). Those
// are shown on the dashboard for completeness, marked as such, but
// only models Duck AI grants access to are accepted for chat.
const LIVE_MODELS_URL = 'https://duckduckgo.com/duckchat/v1/models';
const PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', mistral: 'Mistral', tinfoil: 'Tinfoil' };
let liveModelsCache = null; // { at: <ms epoch>, models: [...] }
const LIVE_MODELS_CACHE_MS = 5 * 60 * 1000;
const liveAvailableModelIds = new Set();

async function fetchLiveModels() {
    if (liveModelsCache && (Date.now() - liveModelsCache.at) < LIVE_MODELS_CACHE_MS) {
        return liveModelsCache.models;
    }
    const res = await fetch(LIVE_MODELS_URL, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`live models endpoint HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.models) || !data.models.length) {
        throw new Error('live models endpoint returned no models');
    }
    const models = data.models.map(m => {
        const available = m.entityHasAccess !== false;
        const providerName = PROVIDER_NAMES[m.provider] || m.provider || '';
        let tag;
        if (!available) tag = 'Duck AI subscription (Plus/Pro)';
        else if (m.label === 'EVERYDAY_USE') tag = 'Everyday use';
        else if (m.label === 'USES_LIMITS_FASTER') tag = 'Fast — uses limits faster';
        else tag = providerName;
        const rawName = m.name || m.id;
        return {
            id: m.id,
            name: (providerName && !rawName.toLowerCase().startsWith(providerName.toLowerCase()))
                ? providerName + ' ' + rawName : rawName,
            tag,
            provider: m.provider || null,
            access_tier: Array.isArray(m.accessTier) ? m.accessTier : [],
            available,
            // Image capabilities, straight from the live Duck AI flags
            // (verified Nov 2026): only models whose supportedTools list
            // contains "GenerateImage" can actually return generated
            // images (free tier: the OpenAI GPT models). supportsImageUpload
            // drives image *input* validation — see parseImageInput.
            image_generation: Array.isArray(m.supportedTools) && m.supportedTools.includes('GenerateImage'),
            supports_image_upload: !!m.supportsImageUpload,
            // Curated per-model capabilities for callers/dashboards:
            // image_input follows the live supportsImageUpload flag,
            // image_creation follows TESTED evidence only (null +
            // image_creation_note for untested/subscription models).
            ...buildCapabilities(m.id, !!m.supportsImageUpload, available)
        };
    });
    liveAvailableModelIds.clear();
    models.filter(m => m.available).forEach(m => liveAvailableModelIds.add(m.id));
    liveVisionModelIds.clear();
    liveNoVisionModelIds.clear();
    models.forEach(m => {
        if (m.supports_image_upload) liveVisionModelIds.add(m.id);
        else liveNoVisionModelIds.add(m.id);
    });
    liveModelsCache = { at: Date.now(), models };
    return models;
}

// Live list if fetchable, otherwise the static fallback list
// (all static entries are access-granted models).
async function getModelsForDisplay() {
    try {
        const models = await fetchLiveModels();
        return { models, source: 'live' };
    } catch (e) {
        console.warn('Live models fetch failed, using static list:', e.message);
        return {
            models: SUPPORTED_MODELS.map(m => ({
                ...m,
                provider: null,
                access_tier: [],
                available: true,
                // Static fallbacks consistent with the live shape:
                // creation from tested evidence, input from the
                // verified static vision set.
                image_generation: IMAGE_CREATION_TESTED[m.id] === true,
                supports_image_upload: STATIC_VISION_MODELS.has(m.id),
                ...buildCapabilities(m.id, undefined, true)
            })),
            source: 'static-fallback'
        };
    }
}

// 🛡️ API KEY VALIDATION MIDDLEWARE
// Accepts (Bearer token or x-api-key header):
//  (a) the master key from DUCK_AI_API_KEY, if set, and
//  (b) any non-revoked generated key (matched by SHA-256 hash).
// If ALLOW_KEYLESS_CHAT=true (see above), a request with NO key at
// all is also accepted (req.apiKeyType = 'keyless'); a request that
// presents an invalid key is still 401 in both modes.
const validateApiKey = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const customKeyHeader = req.headers['x-api-key'];
    let userKey = "";

    if (authHeader && authHeader.startsWith('Bearer ')) {
        userKey = authHeader.split(' ')[1].trim();
    } else if (customKeyHeader) {
        userKey = String(customKeyHeader).trim();
    }

    if (!userKey) {
        if (ALLOW_KEYLESS_CHAT) {
            req.apiKeyType = 'keyless';
            return next();
        }
        return res.status(401).json({
            status: "error",
            message: "Unauthorized! Bhai galat ya missing API Key hai."
        });
    }

    // (a) Master key
    if (MASTER_API_KEY && userKey === MASTER_API_KEY) {
        req.apiKeyType = 'master';
        return next();
    }

    // (b) Generated keys — compare by hash, never plaintext
    const presentedHash = hashKey(userKey);
    const keys = loadKeys();
    const rec = keys.find(k => !k.revoked && k.hash === presentedHash);
    if (rec) {
        rec.last_used_at = new Date().toISOString();
        try { saveKeys(keys); } catch (e) {}
        req.apiKeyType = 'generated';
        req.apiKeyId = rec.id;
        return next();
    }

    return res.status(401).json({
        status: "error",
        message: "Unauthorized! Bhai galat ya missing API Key hai."
    });
};

// 🔑 API KEY MANAGEMENT ENDPOINTS
// Protected by the ADMIN LOGIN above (single fixed admin account,
// session cookie). Without a valid admin session these return 401.
// POST /api/chat is NOT gated by the admin login — end users call
// it with their generated API keys as before.

// Create a new key — full key is returned ONCE here, never again.
app.post('/api/keys', requireAdmin, (req, res) => {
    const label = (req.body && req.body.label) || 'Untitled key';
    const { fullKey, rec } = createKeyRecord(label);
    return res.status(201).json({
        status: "success",
        id: rec.id,
        label: rec.label,
        created_at: rec.created_at,
        api_key: fullKey,
        message: "Save this key now — it will not be shown again."
    });
});

// List keys — masked only (prefix + last 4). No full keys, no hashes.
app.get('/api/keys', requireAdmin, (req, res) => {
    return res.json({ status: "success", keys: loadKeys().map(maskKeyRecord) });
});

// Revoke a key (DELETE, or POST .../revoke) — it stops working at once.
function revokeKey(req, res) {
    const keys = loadKeys();
    const rec = keys.find(k => k.id === req.params.id);
    if (!rec) {
        return res.status(404).json({ status: "error", message: "Key not found." });
    }
    rec.revoked = true;
    saveKeys(keys);
    return res.json({ status: "success", ...maskKeyRecord(rec) });
}
app.delete('/api/keys/:id', requireAdmin, revokeKey);
app.post('/api/keys/:id/revoke', requireAdmin, revokeKey);

// 🤖 AVAILABLE MODELS
// Public list (no API key required) so external sites/apps and the
// dashboard dropdown can discover which models they may request in
// POST /api/chat via the "model" field. The wrapper forwards the
// chosen model to DuckAI, and /api/chat replies with model_used.
app.get('/api/models', async (req, res) => {
    const { models, source } = await getModelsForDisplay();
    return res.json({
        status: "success",
        source, // "live" = fetched from DuckDuckGo just now / from cache; "static-fallback" = built-in list
        default_model: 'gpt-5.4-mini',
        models,
        aliases: MODEL_ALIASES,
        usage: 'Send {"message": "...", "model": "<id>"} to POST /api/chat. The response\'s model_used confirms which model DuckAI answered with. Models with "available": false are listed on Duck AI but need a Duck AI subscription and cannot be used for chat from a free account. Images out: ask for a picture in your message (or send "generateImage": true) with a model whose "image_generation" is true — any images DuckAI returns come back in the response\'s "images" array (generated ones as b64_image + data_url). Images in: attach an image by adding "image": "data:image/png;base64,..." (or "images": [ ... ], max 4, 5 MB each, png/jpeg/webp/gif) with a model whose "supports_image_upload" is true — DuckAI will see the image and answer about it. Each model also carries "capabilities": {"chat": true, "image_input": <bool>, "image_creation": <bool|null>} — image_input comes from Duck AI\'s live supportsImageUpload flag, image_creation from end-to-end tested evidence only; null means untested (see "image_creation_note", e.g. subscription-only models that cannot be tried on a free account).'
    });
});

// 📄 HOME ROUTE
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Duck AI Gateway</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color:#1a1a1a; margin:0; min-height:100vh; background: linear-gradient(135deg, #dbeafe 0%, #e0e7ff 35%, #ede9fe 65%, #fce7f3 100%); background-attachment: fixed; }
  .wrap { max-width: 760px; margin: 40px auto; padding: 0 16px; }
  .topnav { position: sticky; top: 12px; z-index: 50; display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 14px; margin-bottom:20px; background: rgba(255,255,255,0.55); backdrop-filter: blur(18px) saturate(160%); -webkit-backdrop-filter: blur(18px) saturate(160%); border:1px solid rgba(255,255,255,0.6); border-radius:999px; box-shadow: 0 8px 32px rgba(31,38,135,0.12); }
  .topnav .brand { font-weight:700; font-size:16px; margin-right:auto; white-space:nowrap; }
  .navlink { color:#111; text-decoration:none; font-size:14.5px; padding:9px 14px; border-radius:999px; border:1px solid transparent; }
  .navlink:hover { background: rgba(255,255,255,0.7); }
  .navlink.active { background:#111; color:#fff; }
  .card { background: rgba(255,255,255,0.72); backdrop-filter: blur(14px) saturate(150%); -webkit-backdrop-filter: blur(14px) saturate(150%); border:1px solid rgba(255,255,255,0.65); border-radius:12px; padding:20px; margin-bottom:20px; box-shadow: 0 8px 32px rgba(31,38,135,0.08); }
  h1 { font-size: 24px; margin: 0 0 8px; }
  p { line-height:1.55; font-size:14.5px; }
  button { padding:10px 16px; border:0; border-radius:8px; background:#111; color:#fff; cursor:pointer; font-size:15px; }
  button:disabled { opacity:.5; }
  .viewbtn { background: rgba(255,255,255,0.6); color:#111; border:1px solid rgba(120,120,160,0.35); border-radius:999px; padding:9px 14px; font-size:14.5px; }
  .viewbtn.active { background:#111; color:#fff; border-color:#111; }
  label.field { display:block; font-size:13.5px; color:#444; margin:10px 0 4px; }
  .hint { font-size:13px; color:#555; margin:6px 0 0; line-height:1.5; }
  input[type=password] { width:100%; padding:10px; border:1px solid #ccd; border-radius:8px; font-size:15px; box-sizing:border-box; background: rgba(255,255,255,0.92); }
  select { width:100%; padding:10px; border:1px solid #ccd; border-radius:8px; font-size:15px; box-sizing:border-box; background:#fff; }
  textarea { padding:10px; border:1px solid #ccd; border-radius:8px; font-size:15px; box-sizing:border-box; font-family:inherit; background: rgba(255,255,255,0.92); resize:none; }
  #chatThread { display:flex; flex-direction:column; gap:10px; min-height:220px; max-height:520px; overflow-y:auto; padding:8px 2px; }
  .empty { text-align:center; color:#777; font-size:15px; padding:42px 12px; line-height:1.6; }
  .msg { max-width:82%; padding:10px 14px; border-radius:16px; font-size:14.5px; line-height:1.55; white-space:pre-wrap; word-break:break-word; box-shadow: 0 4px 16px rgba(31,38,135,0.08); }
  .msg.user { align-self:flex-end; background: rgba(17,17,17,0.88); color:#fff; border-bottom-right-radius:6px; }
  .msg.ai { align-self:flex-start; background: rgba(255,255,255,0.78); border:1px solid rgba(255,255,255,0.65); backdrop-filter: blur(12px) saturate(150%); -webkit-backdrop-filter: blur(12px) saturate(150%); border-bottom-left-radius:6px; }
  .msg .model { display:block; font-size:11.5px; font-weight:600; letter-spacing:.02em; color:#8a8aa3; margin-bottom:4px; }
  .msg img { display:block; max-width:100%; height:auto; border-radius:10px; margin-top:8px; }
  .msg.user img { margin:0 0 8px; }
  .msg.notice { align-self:center; max-width:94%; background:#fff1f1; border:1px solid #e5b4b4; color:#7a1010; font-size:13.5px; border-radius:10px; text-align:center; white-space:normal; }
  .tdots span { display:inline-block; width:6px; height:6px; margin-right:3px; border-radius:50%; background:#888; animation: tblink 1.2s infinite; }
  .tdots span:nth-child(2) { animation-delay:.2s; }
  .tdots span:nth-child(3) { animation-delay:.4s; }
  @keyframes tblink { 0%, 80%, 100% { opacity:.25; } 40% { opacity:1; } }
  .composer { display:flex; gap:8px; align-items:flex-end; margin-top:12px; }
  .composer textarea { flex:1; }
  .attachbtn { display:inline-flex; align-items:center; justify-content:center; width:41px; height:41px; flex:none; border-radius:999px; background: rgba(255,255,255,0.6); border:1px solid rgba(120,120,160,0.35); cursor:pointer; font-size:17px; }
  .attachbtn:hover { background: rgba(255,255,255,0.85); }
  .chiprow { margin-top:10px; }
  .chip { display:inline-flex; align-items:center; gap:8px; background: rgba(255,255,255,0.85); border:1px solid rgba(120,120,160,0.35); border-radius:999px; padding:4px 6px 4px 4px; font-size:12.5px; }
  .chip img { width:28px; height:28px; object-fit:cover; border-radius:999px; display:block; }
  .chip button { background:#fff; color:#111; border:1px solid #999; padding:2px 9px; font-size:12px; border-radius:999px; }
</style>
</head>
<body>
<div class="wrap">
  <nav class="topnav">
    <span class="brand">🦆 Duck AI — API Keys</span>
    <button class="viewbtn active" type="button" id="viewBtnHome">Home</button>
    <button class="viewbtn" type="button" id="viewBtnChat">💬 AI Chat</button>
    <a class="navlink" href="/dashboard">Create API Key</a>
    <a class="navlink" href="/dashboard#howto">How to Use</a>
  </nav>

  <div id="viewHome">
  <div class="card">
    <h1>🦆 Duck AI Gateway is Live bhai!</h1>
    <p>Use POST /api/chat to connect.</p>
    <p><a href="/dashboard">Open the API Key Dashboard &rarr;</a> — create your own API key, like on OpenAI.</p>
    <p><a href="/dashboard#howto">Read the how-to instructions &rarr;</a> — models, examples, image creation and image input.</p>
    <p><a href="#chat" id="chatTeaser">Chat with Duck AI right here &rarr;</a> — pick a model and ask anything, no code needed.</p>
  </div>
  </div><!-- /viewHome -->

  <div id="viewChat" style="display:none;">
  <div class="card">
    <h1>💬 Chat with Duck AI</h1>
    <label class="field" for="chatKey">Your API key${ALLOW_KEYLESS_CHAT ? ' (optional on this server)' : ''}</label>
    <input type="password" id="chatKey" placeholder="duck-..." autocomplete="off">
    <p class="hint">${ALLOW_KEYLESS_CHAT ? 'This is a personal (keyless) deployment — the API key is <b>optional</b>: just pick a model and chat, no key needed. If you have a key you can still paste it; it is kept in this page\'s memory only, never saved.' : 'Paste your API key — create one free in the <a href="/dashboard">Create API Key tab</a>. The key is kept in this page\'s memory only, never saved.'}</p>
    <label class="field" for="chatModel">AI model — DuckAI will answer with the model you pick here</label>
    <select id="chatModel"></select>
    <div id="chatThread">
      <div class="empty" id="chatEmpty">Ask me anything…<br><span style="font-size:13px;">${ALLOW_KEYLESS_CHAT ? 'Pick a model and say hello — no API key needed on this server.' : 'Paste your key above, pick a model, and say hello.'}</span></div>
    </div>
    <div id="chatChip" class="chiprow" style="display:none;">
      <span class="chip"><img id="chatChipImg" alt=""><span id="chatChipName">image</span><button type="button" id="chatChipRemove">✕ Remove</button></span>
    </div>
    <div class="composer">
      <label class="attachbtn" for="chatFile" title="Attach an image">📎</label>
      <input type="file" id="chatFile" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none;">
      <textarea id="chatInput" rows="1" placeholder="Type a message… (Enter to send, Shift+Enter for a new line)"></textarea>
      <button id="chatSend" type="button">Send</button>
    </div>
  </div>
  </div><!-- /viewChat -->
</div>
<script>
function showView(which) {
  var chat = which === 'chat';
  document.getElementById('viewHome').style.display = chat ? 'none' : '';
  document.getElementById('viewChat').style.display = chat ? '' : 'none';
  document.getElementById('viewBtnHome').classList.toggle('active', !chat);
  document.getElementById('viewBtnChat').classList.toggle('active', chat);
  try { history.replaceState(null, '', chat ? '#chat' : window.location.pathname); } catch(e) {}
}
function applyHash() { showView(window.location.hash === '#chat' ? 'chat' : 'home'); }
document.getElementById('viewBtnHome').addEventListener('click', function(){ showView('home'); });
document.getElementById('viewBtnChat').addEventListener('click', function(){ showView('chat'); });
window.addEventListener('hashchange', applyHash);

var chatImageDataUrl = null;
function chatThreadEl(){ return document.getElementById('chatThread'); }
function scrollChat(){ var t = chatThreadEl(); t.scrollTop = t.scrollHeight; }
function hideEmpty(){ var e = document.getElementById('chatEmpty'); if (e) e.style.display = 'none'; }
function addUserBubble(text, imgUrl) {
  hideEmpty();
  var d = document.createElement('div');
  d.className = 'msg user';
  if (imgUrl) { var im = document.createElement('img'); im.src = imgUrl; im.alt = 'Attached image'; d.appendChild(im); }
  if (text) { var t = document.createElement('div'); t.textContent = text; d.appendChild(t); }
  chatThreadEl().appendChild(d); scrollChat();
}
function addAiBubble(text, modelUsed, images) {
  hideEmpty();
  var d = document.createElement('div');
  d.className = 'msg ai';
  var m = document.createElement('span');
  m.className = 'model';
  m.textContent = modelUsed || 'Duck AI';
  d.appendChild(m);
  if (text) { var t = document.createElement('div'); t.textContent = text; d.appendChild(t); }
  (images || []).forEach(function(img) {
    var src = img && (img.data_url || img.url);
    if (!src) return;
    var im = document.createElement('img');
    im.src = src; im.alt = (img && img.alt) || 'Image from Duck AI';
    d.appendChild(im);
  });
  chatThreadEl().appendChild(d); scrollChat();
}
function addNotice(text) {
  hideEmpty();
  var d = document.createElement('div');
  d.className = 'msg notice';
  d.textContent = text;
  chatThreadEl().appendChild(d); scrollChat();
}
function addTyping() {
  hideEmpty();
  var d = document.createElement('div');
  d.className = 'msg ai'; d.id = 'chatTyping';
  d.innerHTML = '<span class="model">Duck AI</span><span class="tdots"><span></span><span></span><span></span></span> thinking…';
  chatThreadEl().appendChild(d); scrollChat();
}
function removeTyping() { var t = document.getElementById('chatTyping'); if (t) t.remove(); }
function clearChatImage() {
  chatImageDataUrl = null;
  document.getElementById('chatFile').value = '';
  document.getElementById('chatChip').style.display = 'none';
}
document.getElementById('chatFile').addEventListener('change', function(e) {
  var f = e.target.files && e.target.files[0];
  if (!f) return;
  var r = new FileReader();
  r.onload = function() {
    chatImageDataUrl = r.result;
    document.getElementById('chatChipImg').src = r.result;
    document.getElementById('chatChipName').textContent = f.name || 'image';
    document.getElementById('chatChip').style.display = '';
  };
  r.readAsDataURL(f);
});
document.getElementById('chatChipRemove').addEventListener('click', clearChatImage);
async function loadChatModels() {
  var sel = document.getElementById('chatModel');
  function fill(models, def) {
    sel.innerHTML = '';
    models.forEach(function(m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = (m.name || m.id) + ' (' + m.id + ')';
      sel.appendChild(o);
    });
    if (def) sel.value = def;
  }
  fill([{ id: 'gpt-5.4-mini', name: 'OpenAI GPT-5.4 Mini' }], 'gpt-5.4-mini');
  try {
    var r = await fetch('/api/models');
    var data = await r.json();
    if (data && Array.isArray(data.models)) {
      var usable = data.models.filter(function(m){ return m.available !== false; });
      if (usable.length) fill(usable, data.default_model || usable[0].id);
    }
  } catch(e) {}
}
var KEYLESS_CHAT = ${ALLOW_KEYLESS_CHAT ? 'true' : 'false'};
async function sendChat() {
  var key = document.getElementById('chatKey').value.trim();
  var input = document.getElementById('chatInput');
  var message = input.value.trim();
  var btn = document.getElementById('chatSend');
  if (!key && !KEYLESS_CHAT) { addNotice('⚠️ Paste your API key first — create one free in the Create API Key tab (Dashboard).'); document.getElementById('chatKey').focus(); return; }
  if (!message && !chatImageDataUrl) return;
  var model = document.getElementById('chatModel').value || 'gpt-5.4-mini';
  var img = chatImageDataUrl;
  addUserBubble(message, img);
  input.value = '';
  clearChatImage();
  btn.disabled = true;
  addTyping();
  try {
    var payload = { message: message || 'Describe this image.', model: model };
    if (img) payload.image = img;
    var chatHeaders = { 'Content-Type': 'application/json' };
    if (key) chatHeaders['Authorization'] = 'Bearer ' + key;
    var r = await fetch('/api/chat', { method: 'POST', headers: chatHeaders, body: JSON.stringify(payload) });
    var data = await r.json().catch(function(){ return {}; });
    removeTyping();
    if (r.ok) {
      addAiBubble(data.reply || '', data.model_used || model, Array.isArray(data.images) ? data.images : []);
    } else if (r.status === 401) {
      addNotice('❌ 401 — that API key was rejected (wrong key, or revoked). Check the key and try again.');
    } else {
      addNotice('❌ HTTP ' + r.status + ' — ' + (data.message || 'request failed'));
    }
  } catch(e) {
    removeTyping();
    addNotice('❌ Could not reach the server: ' + e.message);
  }
  btn.disabled = false;
  input.focus();
}
document.getElementById('chatSend').addEventListener('click', sendChat);
document.getElementById('chatInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
applyHash();
loadChatModels();
</script>
</body>
</html>`);
});

// 🖥️ API KEY DASHBOARD
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// 💬 MAIN CHAT API ENDPOINT
// Current DuckDuckGo flow (see challenge.js):
//   1. Solve a fresh x-vqd-hash-1 JavaScript challenge per attempt.
//   2. POST /duckchat/v1/chat with the solved token in `x-vqd-hash-1`
//      (the old `x-vqd-4` header is gone). The body must also carry
//      `canUseTools` and `reasoningEffort`, otherwise DuckDuckGo
//      returns 400 ERR_BAD_REQUEST.
//   3. Some challenge "flavors" are still rejected with
//      418 ERR_CHALLENGE, so re-solve and retry a few times.
app.post('/api/chat', validateApiKey, async (req, res) => {
    const { message, model } = req.body || {};

    if (!message || typeof message !== 'string') {
        return res.status(400).json({
            status: "error",
            message: "Bhai, 'message' field daalna compulsory hai!"
        });
    }

    // 🖼️ Image input (optional): "image" (data URL) or "images" [...]
    const parsedImages = parseImageInput(req.body || {});
    if (parsedImages.error) {
        return res.status(400).json({ status: "error", message: `Bad image input: ${parsedImages.error}` });
    }
    const imageParts = parsedImages.parts;

    const requestedModel = model || 'gpt-5.4-mini';
    const selectedModel = resolveModel(requestedModel);

    // Refresh the live access-granted model set (cached) so a model
    // Duck AI newly makes available works without a code change.
    // Subscription-only live models (available: false) stay rejected.
    try { await getModelsForDisplay(); } catch (e) {}

    // Unknown model: fail fast with a clear 400 listing valid choices,
    // instead of sending it upstream and failing obscurely.
    if (!isSupportedModel(selectedModel)) {
        return res.status(400).json({
            status: "error",
            message: `Unknown model: ${requestedModel}. Choose one of the valid models (or a known alias).`,
            valid_models: [...new Set([...SUPPORTED_MODELS.map(m => m.id), ...liveAvailableModelIds])],
            aliases: MODEL_ALIASES
        });
    }
    // Image attached but the chosen model can't see images (per the
    // live Duck AI flags): fail clearly instead of an upstream 400.
    if (imageParts.length && !modelSupportsImageInput(selectedModel)) {
        return res.status(400).json({
            status: "error",
            message: `Model ${selectedModel} does not accept image input on Duck AI. Attach images with a vision-capable model instead.`,
            vision_models: [...new Set([...(liveVisionModelIds.size ? liveVisionModelIds : STATIC_VISION_MODELS)].filter(id => isSupportedModel(id)))]
        });
    }
    const canUseTools = typeof (req.body && req.body.canUseTools) === 'boolean' ? req.body.canUseTools : false;
    const reasoningEffort = (req.body && req.body.reasoningEffort) || 'none';
    // 🖼️ Optional: { "generateImage": true } asks DuckAI to generate an
    // image for this message. Verified live (Nov 2026): with a model
    // whose supportedTools include "GenerateImage" (free tier: the
    // OpenAI GPT models, e.g. gpt-5.4-mini, gpt-6-luna), DuckAI runs
    // its GenerateImage tool and the stream carries the picture as
    // base64 JPEG in a ui-component chunk (data.b64Image) — even
    // without this flag, a prompt like "Generate an image of ..."
    // triggers it. This flag additionally sends the same forcing
    // fields the Duck AI web app uses (canDelegateImageGeneration +
    // metadata.toolChoice.GenerateImage), which upstream accepts.
    // Models without the GenerateImage tool (e.g. claude-haiku-5-5)
    // simply answer in text and say they can't generate images.
    const wantImage = !!(req.body && (req.body.generateImage === true || req.body.image === true));

    const MAX_ATTEMPTS = 8;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            // 🔥 STEP 1: Solve a fresh challenge for this attempt
            const { token } = await solveChallenge();

            // 🔥 STEP 2: Chat request with the solved token
            const chatResponse = await fetch('https://duckduckgo.com/duckchat/v1/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-vqd-hash-1': token,
                    'User-Agent': USER_AGENT,
                    'Accept': 'text/event-stream',
                    'Origin': 'https://duckduckgo.com',
                    'Referer': 'https://duckduckgo.com/',
                    'Cache-Control': 'no-cache'
                },
                body: JSON.stringify({
                    model: selectedModel,
                    // With images attached, content becomes the parts
                    // array the Duck AI web app sends (see parseImageInput
                    // notes); text-only keeps the original string shape.
                    messages: [{
                        role: 'user',
                        content: imageParts.length
                            ? [{ type: 'text', text: message }, ...imageParts]
                            : message
                    }],
                    canUseTools,
                    reasoningEffort,
                    ...(imageParts.length ? { canUploadFiles: true } : {}),
                    ...(wantImage ? {
                        canDelegateImageGeneration: true,
                        metadata: { toolChoice: { GenerateImage: true } }
                    } : {})
                })
            });

            if (!chatResponse.ok) {
                const errText = await chatResponse.text();
                // 418 = this challenge flavor was rejected, 429 = rate
                // limited: both are worth a re-solve + retry.
                if ((chatResponse.status === 418 || chatResponse.status === 429) && attempt < MAX_ATTEMPTS) {
                    lastError = new Error(`DuckDuckGo Chat Error: ${chatResponse.status} - ${errText.slice(0, 150)}`);
                    console.warn(`Attempt ${attempt}: HTTP ${chatResponse.status}, re-solving challenge...`);
                    await new Promise(r => setTimeout(r, 600 * attempt));
                    continue;
                }
                throw new Error(`DuckDuckGo Chat Error: ${chatResponse.status} - ${errText.slice(0, 300)}`);
            }

            const rawText = await chatResponse.text();
            const lines = rawText.split('\n');
            let fullReply = '';

            // 🖼️ IMAGE PASS-THROUGH
            // DuckAI does not put images in `message`. A generated image
            // arrives (verified live, Nov 2026) as streamed chunks like:
            //   {role:"ui-component", name:"generate-image",
            //    data:{type:"image-title", title:"Drawing a red cat..."}}
            //   {role:"ui-component", name:"generate-image",
            //    data:{status:"success", b64Image:"<base64 JPEG>",
            //          format:"jpeg", width:1024, height:1024,
            //          imageModelDisplayName:"GPT Image 2.5"}}
            // The old parser dropped all of that. Collect it into an
            // `images` array instead, plus any image URLs / markdown
            // images found anywhere else in the stream.
            const images = [];
            const seenImageKeys = new Set();
            const imageTitles = {}; // ui-component id -> title
            const toolsUsed = new Set();
            const pushImage = (img) => {
                const key = img.url || (img.b64_image ? img.b64_image.slice(0, 64) + ':' + img.b64_image.length : null);
                if (!key || seenImageKeys.has(key)) return;
                seenImageKeys.add(key);
                images.push(img);
            };
            const IMAGE_URL_RE = /https?:\/\/[^\s"'()<>\\]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'()<>\\]*)?/gi;
            const scanForImageUrls = (value, alt) => {
                if (typeof value !== 'string') return;
                const found = value.match(IMAGE_URL_RE);
                if (found) found.forEach(u => pushImage({ type: 'url', url: u, alt: alt || null }));
            };

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data: ')) {
                    const chunkText = trimmed.slice(6).trim();
                    if (chunkText === '[DONE]' || chunkText === '') continue;

                    try {
                        const parsedChunk = JSON.parse(chunkText);
                        if (parsedChunk.message) {
                            fullReply += parsedChunk.message;
                        }
                        if (parsedChunk.toolName) toolsUsed.add(parsedChunk.toolName);

                        const d = parsedChunk.data;
                        if (d && typeof d === 'object') {
                            // Generated image title arrives before the image itself
                            if (d.type === 'image-title' && d.title && parsedChunk.id) {
                                imageTitles[parsedChunk.id] = d.title;
                            }
                            // The generated image itself: base64 in data.b64Image
                            if (typeof d.b64Image === 'string' && d.b64Image.length > 100) {
                                const format = (d.format || 'jpeg').toLowerCase();
                                pushImage({
                                    type: 'generated',
                                    format,
                                    width: d.width || null,
                                    height: d.height || null,
                                    alt: (parsedChunk.id && imageTitles[parsedChunk.id]) || null,
                                    image_model: d.imageModelDisplayName || null,
                                    b64_image: d.b64Image,
                                    data_url: `data:image/${format};base64,${d.b64Image}`
                                });
                            }
                            // Any other image-shaped payload: {url|image|src: ...}
                            for (const f of ['url', 'image', 'imageUrl', 'image_url', 'src']) {
                                if (typeof d[f] === 'string' && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(d[f])) {
                                    pushImage({ type: 'url', url: d[f], alt: d.alt || d.title || null });
                                }
                            }
                            scanForImageUrls(d.url, d.alt || d.title);
                        }
                        // Markdown images / plain image URLs inside text chunks
                        scanForImageUrls(parsedChunk.message, null);
                    } catch (e) {}
                }
            }

            // Markdown images embedded in the assembled reply text
            const mdImgRe = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
            let mdMatch;
            while ((mdMatch = mdImgRe.exec(fullReply)) !== null) {
                pushImage({ type: 'url', url: mdMatch[2], alt: mdMatch[1] || null });
            }

            return res.json({
                status: "success",
                model_used: selectedModel,
                requested_model: requestedModel,
                // How many images the caller attached to this message (input side)
                input_images: imageParts.length,
                reply: fullReply.trim(),
                // New (additive, backward compatible): generated/returned
                // images, if DuckAI produced any. Generated images carry
                // both `b64_image` (raw base64) and `data_url`
                // (ready to use as an <img src>). Empty array otherwise.
                images,
                tools_used: [...toolsUsed]
            });

        } catch (error) {
            lastError = error;
            // Network/socket errors to DuckDuckGo also happen transiently;
            // retry them with a fresh challenge like challenge failures.
            if (attempt < MAX_ATTEMPTS && /fetch failed|socket|ECONN|ETIMEDOUT/i.test(error.message || '')) {
                console.warn(`Attempt ${attempt}: network error (${error.message}), retrying...`);
                await new Promise(r => setTimeout(r, 600 * attempt));
                continue;
            }
            if (attempt < MAX_ATTEMPTS && /challenge/i.test(error.message || '')) {
                console.warn(`Attempt ${attempt}: challenge error (${error.message}), retrying...`);
                await new Promise(r => setTimeout(r, 600 * attempt));
                continue;
            }
            break;
        }
    }

    console.error('Final API Error:', lastError);
    return res.status(500).json({
        status: "error",
        message: "Backend me dikkat aayi hai bhai!",
        details: lastError ? lastError.message : 'unknown error'
    });
});

app.use((req, res) => {
    res.status(404).json({ status: "error", message: "Route nahi mila!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;
