// challenge.js — solver for DuckDuckGo's current x-vqd-hash-1 challenge.
//
// How the current flow works (verified live, Nov 2026):
//   1. GET https://duckduckgo.com/duckchat/v1/status with header
//      `x-vqd-accept: 1` no longer returns an `x-vqd-4` token. It returns
//      `x-vqd-hash-1`: a base64-encoded, obfuscated async JavaScript function.
//   2. That function fingerprints the browser environment (navigator,
//      an iframe/CSP check via document.querySelector('#jsa'), DOM class
//      prototype chains, NodeList, native-function toString checks, ...)
//      and returns { server_hashes, client_hashes, signals, meta }.
//      The exact checks rotate between several "flavors" of the script.
//   3. The solved token sent to the chat endpoint is: take the returned
//      object, replace each client_hash with its SHA-256 (base64), set
//      meta.origin / meta.stack / meta.duration, JSON-encode and base64 it,
//      and send it as the `x-vqd-hash-1` header (no x-vqd-4 any more).
//
// This module runs the challenge in Node's `vm` with a stubbed browser
// environment (below). Some challenge flavors still produce fingerprints
// the server rejects (HTTP 418 ERR_CHALLENGE) — callers should re-solve
// and retry, which is what index.js does.

const vm = require('vm');
const crypto = require('crypto');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ORIGIN = 'https://duckduckgo.com';

function sha256Base64(text) {
  return crypto.createHash('sha256').update(String(text)).digest('base64');
}

// --- DOM class hierarchy (challenge flavors check prototype chains, e.g.
//     HTMLDivElement.prototype instanceof HTMLElement, and that
//     document.querySelectorAll('*') returns a non-Array NodeList) ---
class NodeList {
  constructor(items = []) {
    const vals = [...items];
    for (let i = 0; i < vals.length; i++) this[i] = vals[i];
    this.length = vals.length;
  }
  item(i) { return this[i] ?? null; }
  forEach(fn) { for (let i = 0; i < this.length; i++) fn(this[i], i, this); }
  *[Symbol.iterator]() { for (let i = 0; i < this.length; i++) yield this[i]; }
}

class Element {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this._kids = [];
    this.attributes = {};
    this.style = { cssText: '', display: 'block', getPropertyValue: () => '' };
    this.srcdoc = '';
    this.src = '';
    this.textContent = '';
    this._innerHTML = '';
    this.offsetWidth = 100; this.offsetHeight = 100;
    this.clientWidth = 100; this.clientHeight = 100;
    this.scrollWidth = 100; this.scrollHeight = 100;
    this.parentNode = null;
    this.ownerDocument = null;
    if (this.tagName === 'IFRAME') this.sandbox = 'allow-scripts allow-same-origin';
  }
  get children() {
    const self = this;
    return { get length() { return self._kids.length; }, item(i) { return self._kids[i] ?? null; } };
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v); this._kids = []; }
  getAttribute(name) {
    if (name === 'sandbox' && this.tagName === 'IFRAME') return 'allow-scripts allow-same-origin';
    if (name === 'content') return "default-src 'none'; script-src 'unsafe-inline';";
    return this.attributes[name] ?? null;
  }
  setAttribute(name, v) { this.attributes[name] = String(v); }
  hasAttribute(name) { return name in this.attributes; }
  appendChild(child) { this._kids.push(child); if (child) child.parentNode = this; return child; }
  removeChild(child) {
    const i = this._kids.indexOf(child);
    if (i >= 0) this._kids.splice(i, 1);
    return child;
  }
  querySelector(sel) { const r = walkTree(this, sel); return r[0] ?? null; }
  querySelectorAll(sel) { return new NodeList(walkTree(this, sel)); }
  getBoundingClientRect() {
    return { width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100, x: 0, y: 0, toJSON() { return {}; } };
  }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  blur() {}
  cloneNode() { return new Element(this.tagName.toLowerCase()); }
}
class HTMLElement extends Element {}
class HTMLDivElement extends HTMLElement { constructor() { super('div'); } }
class HTMLIFrameElement extends HTMLElement { constructor() { super('iframe'); } }
class HTMLScriptElement extends HTMLElement { constructor() { super('script'); } }
class HTMLMetaElement extends HTMLElement { constructor() { super('meta'); } }

function matchesSelector(el, sel) {
  const s = String(sel).trim();
  if (s === '*') return true;
  if (s.startsWith('#')) return !!(el.attributes && el.attributes.id === s.slice(1));
  if (s.startsWith('meta')) return el.tagName === 'META';
  return !!(el.tagName && el.tagName.toLowerCase() === s.toLowerCase());
}
function walkTree(root, sel, out = []) {
  for (const child of root._kids || []) {
    if (!child || !child.tagName) continue;
    if (matchesSelector(child, sel)) out.push(child);
    walkTree(child, sel, out);
  }
  return out;
}

const STANDARD_GLOBALS = {
  Object, Array, Promise, JSON, Math, Date, String, Number, Boolean, RegExp,
  Map, Set, WeakMap, WeakSet, Proxy, Symbol, Error, TypeError, RangeError,
  ReferenceError, SyntaxError, EvalError, URIError, AggregateError,
  parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  BigInt, ArrayBuffer, DataView,
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array,
};

function elementFor(tag, doc, navigatorObj) {
  const t = String(tag || 'div').toLowerCase();
  let el;
  if (t === 'div') el = new HTMLDivElement();
  else if (t === 'iframe') el = new HTMLIFrameElement();
  else if (t === 'script') el = new HTMLScriptElement();
  else if (t === 'meta') el = new HTMLMetaElement();
  else el = new Element(t);
  el.ownerDocument = doc || null;
  if (t === 'iframe') {
    const cw = makeWindow(false, navigatorObj);
    el.contentWindow = cw;
    el.contentDocument = cw.document;
  }
  return el;
}

function makeDocument(winRef, navigatorObj) {
  const doc = {
    createElement(tag) { return elementFor(tag, doc, navigatorObj); },
    createTextNode(t) { return { text: String(t), nodeType: 3 }; },
    createComment() { return { nodeType: 8 }; },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) {
      if (String(sel).trim() === '#jsa') {
        const el = elementFor('iframe', doc, navigatorObj);
        el.attributes.id = 'jsa';
        return el;
      }
      const found = walkTree(doc.documentElement, sel);
      if (found.length) return found[0];
      if (String(sel).startsWith('meta')) return elementFor('meta', doc, navigatorObj);
      return null;
    },
    querySelectorAll(sel) { return new NodeList(walkTree(doc.documentElement, sel)); },
    getElementById(id) {
      const found = walkTree(doc.documentElement, '#' + id);
      return found[0] ?? null;
    },
    cookie: '', title: '', referrer: '',
    URL: 'https://duckduckgo.com/', domain: 'duckduckgo.com',
    readyState: 'complete', visibilityState: 'visible', hidden: false,
    location: null, defaultView: null,
  };
  const html = new Element('html');
  const head = new Element('head');
  const body = new Element('body');
  html._kids.push(head, body);
  head.parentNode = html; body.parentNode = html;
  doc.documentElement = html; doc.head = head; doc.body = body;
  doc.all = new NodeList([html, head, body]);
  return doc;
}

function makeWindow(isTop, sharedNavigator) {
  const navigatorObj = sharedNavigator || {
    userAgent: USER_AGENT, webdriver: false,
    language: 'en-US', languages: ['en-US', 'en'], platform: 'Win32',
    vendor: 'Google Inc.', vendorSub: '', productSub: '20030107',
    appCodeName: 'Mozilla', appName: 'Netscape', appVersion: USER_AGENT,
    product: 'Gecko', hardwareConcurrency: 8, maxTouchPoints: 0,
    cookieEnabled: true, onLine: true, doNotTrack: null,
    javaEnabled: () => false, mimeTypes: { length: 0 }, plugins: { length: 0 },
  };
  const win = { ...STANDARD_GLOBALS };
  win.navigator = navigatorObj;
  win.location = {
    href: isTop ? 'https://duckduckgo.com/' : 'about:srcdoc',
    origin: isTop ? 'https://duckduckgo.com' : 'null',
    protocol: isTop ? 'https:' : 'about:',
    host: isTop ? 'duckduckgo.com' : '', hostname: isTop ? 'duckduckgo.com' : '',
    pathname: isTop ? '/' : 'srcdoc', search: '', hash: '',
  };
  win.document = makeDocument(win, navigatorObj);
  win.document.location = win.location;
  win.document.defaultView = win;
  win.getComputedStyle = () => ({
    getPropertyValue: (n) => (n === 'display' ? 'block' : ''),
    display: 'block', width: '100px', height: '100px', cssText: '', length: 0,
  });
  win.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
  win.performance = { now: () => (Date.now() % 100000) + Math.random(), timing: { navigationStart: Date.now() - 1000 }, timeOrigin: Date.now() - 1000 };
  win.innerWidth = 1920; win.innerHeight = 1080; win.outerWidth = 1920; win.outerHeight = 1080; win.devicePixelRatio = 1;
  win.Element = Element; win.HTMLElement = HTMLElement;
  win.HTMLDivElement = HTMLDivElement; win.HTMLIFrameElement = HTMLIFrameElement;
  win.HTMLScriptElement = HTMLScriptElement; win.NodeList = NodeList;
  win.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
  win.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');
  win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
  win.setInterval = setInterval; win.clearInterval = clearInterval;
  win.requestAnimationFrame = (fn) => { if (fn) fn(0); return 0; };
  win.cancelAnimationFrame = () => {};
  win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  win.console = console;
  win.__DDG_BE_VERSION__ = 'x';
  win.__DDG_FE_CHAT_HASH__ = 'x';
  win.Window = function Window() {};
  try { win[Symbol.toStringTag] = 'Window'; } catch (e) {}
  // Browsers expose self/window/top as accessor properties; at least one
  // challenge flavor reads the `self` getter on an iframe's contentWindow.
  Object.defineProperty(win, 'self', { get() { return win; }, enumerable: true, configurable: true });
  Object.defineProperty(win, 'window', { get() { return win; }, enumerable: true, configurable: true });
  Object.defineProperty(win, 'top', { get() { return win; }, enumerable: true, configurable: true });
  Object.defineProperty(win, 'parent', { get() { return win; }, enumerable: true, configurable: true });
  return win;
}

// Fetch a fresh challenge and solve it. Returns { token, rawClientHashes }.
async function solveChallenge() {
  const res = await fetch(`${ORIGIN}/duckchat/v1/status`, {
    method: 'GET',
    headers: {
      'x-vqd-accept': '1',
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (res.status !== 200) throw new Error(`status endpoint HTTP ${res.status}`);
  const challengeB64 = res.headers.get('x-vqd-hash-1');
  if (!challengeB64) throw new Error('status endpoint returned no x-vqd-hash-1 challenge header');
  const jsCode = Buffer.from(challengeB64, 'base64').toString('utf8');

  const topWin = makeWindow(true, null);
  const sandbox = {
    ...STANDARD_GLOBALS,
    window: topWin,
    document: topWin.document,
    navigator: topWin.navigator,
    location: topWin.location,
    Element, HTMLElement, HTMLDivElement, HTMLIFrameElement, HTMLScriptElement, NodeList,
    getComputedStyle: topWin.getComputedStyle,
    screen: topWin.screen,
    performance: topWin.performance,
    matchMedia: topWin.matchMedia,
    requestAnimationFrame: topWin.requestAnimationFrame,
    btoa: topWin.btoa, atob: topWin.atob,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
    __DDG_BE_VERSION__: 'x', __DDG_FE_CHAT_HASH__: 'x',
  };
  Object.defineProperty(sandbox, 'self', { get() { return topWin; } });
  Object.defineProperty(sandbox, 'top', { get() { return topWin; } });
  vm.createContext(sandbox);

  const started = Date.now();
  const result = await vm.runInContext(jsCode, sandbox, { timeout: 5000 });
  if (!result || !Array.isArray(result.client_hashes)) {
    throw new Error('challenge script did not return client_hashes');
  }
  const out = {};
  for (const k of Object.keys(result)) {
    if (k !== 'client_hashes' && k !== 'meta') out[k] = result[k];
  }
  out.client_hashes = result.client_hashes.map((v) => sha256Base64(String(v)));
  out.meta = {
    ...(result.meta || {}),
    origin: ORIGIN,
    stack: 'Error\n    at l (https://duck.ai/dist/duckai-dist/entry.duckai.js:2:1)',
    duration: String(Math.max(Date.now() - started, 4)),
  };
  return {
    token: Buffer.from(JSON.stringify(out), 'utf8').toString('base64'),
    rawClientHashes: result.client_hashes,
  };
}

module.exports = { solveChallenge, USER_AGENT, ORIGIN };
