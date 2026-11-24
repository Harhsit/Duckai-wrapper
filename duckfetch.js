// duckfetch.js — the ONLY way this wrapper talks to DuckDuckGo.
//
// Why this exists (Nov 2026): the same code worked locally but failed
// on hosted deployments in two different ways — Vercel got HTTP 418
// ERR_BN_LIMIT from DuckDuckGo, and Render hung ~112s and then failed
// with a bare "fetch failed". Both are about the ROUTE/IP DuckDuckGo
// sees, and the bare errors gave no clue which step failed. This
// helper adds, for every DuckDuckGo request:
//
//  1. PROXY SUPPORT — set DUCK_PROXY (or HTTPS_PROXY) in the server
//     environment to a proxy URL, e.g.
//       DUCK_PROXY=http://user:pass@host:port
//       DUCK_PROXY=socks5://host:port   (http/https proxies are the
//                                        well-tested path)
//     All DuckDuckGo requests (challenge status, models, chat) then
//     go through that proxy, so DuckDuckGo sees the proxy's IP
//     instead of the hosting provider's datacenter IP. Use a
//     residential proxy to get past datacenter-IP limits. The proxy
//     credentials are NEVER logged (masked in log lines) and never
//     sent anywhere except the proxy itself.
//  2. TIMEOUTS — every fetch is aborted after DUCK_FETCH_TIMEOUT_MS
//     (default 20000 ms), so one stuck connection can no longer hang
//     a chat request for minutes.
//  3. STEP LOGGING — every request logs one line:
//       [duck] step=chat POST https://duckduckgo.com/... -> 200 in 1234ms (proxy: off)
//     and failures log the step, duration, error name/message and
//     the underlying cause code (e.g. UND_ERR_CONNECT_TIMEOUT,
//     ECONNRESET), so server logs (Render/Vercel) show exactly WHICH
//     step fails and why.

let ProxyAgent = null;
let undiciFetch = null;
try { ({ ProxyAgent, fetch: undiciFetch } = require('undici')); } catch (e) { /* handled below */ }

// IMPORTANT: always use undici's OWN fetch together with its
// ProxyAgent. Node's built-in fetch is a DIFFERENT undici version
// bundled inside Node, and handing it a dispatcher built by the npm
// undici package fails on some Node versions with
//   UND_ERR_INVALID_ARG "invalid onError method"
// (seen live on Render, Nov 2026). Pairing the npm package's fetch
// with its own ProxyAgent keeps the versions matched everywhere.

const RAW_PROXY = String(process.env.DUCK_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '').trim();
const TIMEOUT_MS = (() => {
    const n = parseInt(process.env.DUCK_FETCH_TIMEOUT_MS || '', 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 1000), 120000) : 20000;
})();

let dispatcher = undefined;
let proxyState = 'off';
let maskedProxy = '';
if (RAW_PROXY) {
    try {
        const u = new URL(RAW_PROXY);
        maskedProxy = u.protocol + '//' + (u.username ? u.username + ':***@' : '') + u.host;
    } catch (e) { maskedProxy = '(unparseable proxy URL)'; }
    if (ProxyAgent) {
        try {
            dispatcher = new ProxyAgent(RAW_PROXY);
            proxyState = 'on';
        } catch (e) {
            console.error(`[duck] DUCK_PROXY could not be used (${e.message}) — continuing WITHOUT proxy`);
        }
    } else {
        console.error('[duck] DUCK_PROXY is set but the "undici" package is not installed — continuing WITHOUT proxy. Run: npm install');
    }
}

console.log(`[duck] DuckDuckGo route: proxy ${proxyState}${proxyState === 'on' ? ' via ' + maskedProxy : ''}, per-fetch timeout ${TIMEOUT_MS}ms`);

function describeCause(err) {
    const parts = [];
    let cur = err;
    for (let depth = 0; cur && depth < 4; depth++) {
        const bits = [cur.name, cur.code, cur.message].filter(Boolean).join(' ');
        if (bits) parts.push(bits);
        cur = cur.cause;
    }
    return parts.join(' | caused by: ');
}

// fetch() for DuckDuckGo endpoints only. `step` names the stage
// ('challenge-status', 'models', 'chat') for logs and error messages.
async function duckFetch(url, options = {}, step = 'fetch') {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const method = (options.method || 'GET').toUpperCase();
    const doFetch = undiciFetch || fetch;
    try {
        const res = await doFetch(url, {
            ...options,
            ...(dispatcher ? { dispatcher } : {}),
            signal: controller.signal,
        });
        console.log(`[duck] step=${step} ${method} ${url} -> ${res.status} in ${Date.now() - started}ms (proxy: ${proxyState})`);
        return res;
    } catch (err) {
        const ms = Date.now() - started;
        const timedOut = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
        const why = timedOut ? `timed out after ${TIMEOUT_MS}ms` : describeCause(err);
        console.error(`[duck] step=${step} ${method} ${url} FAILED in ${ms}ms (proxy: ${proxyState}): ${why}`);
        // Keep the words "fetch failed" + the step in the message so
        // existing retry logic in index.js recognises network errors,
        // and the final API error tells the caller which step failed.
        throw new Error(`fetch failed at DuckDuckGo step "${step}": ${why}`);
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { duckFetch, PROXY_ENABLED: proxyState === 'on', TIMEOUT_MS };
