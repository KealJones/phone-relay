
const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...h } });

const INSTRUCTIONS = "Drives a real browser tab on Keal's phone (mobile Safari) through a relay. The phone opens the harness page, which has a full-screen 'stage' iframe. Typical flow: list_devices -> set_html (write a test page) or open_url -> run_js / snapshot / click / type / screenshot -> get_logs. run_js code is the body of an async function; `return` a JSON-able value. You see snapshots, not live video. If the phone locks or Safari is backgrounded the device goes offline until it is foregrounded again. An unexpected page reload after heavy work usually means iOS killed the tab for memory; get_logs flags it.";

const DEV = { type: 'string', description: 'Device id or name from list_devices. Defaults to the most recently active online device.' };
const TGT = { type: 'string', enum: ['auto', 'page', 'frame'], description: '"frame" = the stage iframe (content from set_html/open_url); "page" = the host page itself. "auto" (default) = frame if it holds a same-origin document, else page.' };
const TMO = { type: 'number', description: 'Max ms to wait for the phone (default 30000, max 280000).' };

const TOOLS = [
  { name: 'list_devices', description: 'List phones/tabs connected to the relay (online and recently offline).', inputSchema: { type: 'object', properties: {} } },
  { name: 'device_info', description: 'Real device capabilities: UA, screen, DPR, cores, storage quota, crossOriginIsolated, WebGPU adapter features/limits/info, WebGL renderer.', inputSchema: { type: 'object', properties: { device: DEV, timeout_ms: TMO } } },
  { name: 'run_js', description: 'Run JavaScript on the phone. `code` is the body of an async function: use await freely and `return` a value (JSON-serialized; DOM nodes, typed arrays, Maps and errors are summarized). In scope: `frame` (stage iframe element), `fwin` (its window), `page` (top window). Runs in the target window\'s realm. Note WebGPU objects like adapter.limits need fields copied into a plain object.', inputSchema: { type: 'object', properties: { code: { type: 'string' }, target: TGT, device: DEV, timeout_ms: TMO }, required: ['code'] } },
  { name: 'snapshot', description: 'Text view of the page: title, url, viewport, scroll, visible text, and a numbered list of interactive elements (refs) usable with click/type. Refs reset on each snapshot.', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'Limit to this subtree' }, max_chars: { type: 'number', description: 'Max text chars (default 6000)' }, max_elements: { type: 'number', description: 'Max interactive elements (default 150)' }, target: TGT, device: DEV, timeout_ms: TMO } } },
  { name: 'click', description: 'Tap an element by snapshot ref, CSS selector, visible text, or viewport x/y. Fires pointer/mouse events then click().', inputSchema: { type: 'object', properties: { ref: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string', description: 'Match a link/button containing this text' }, x: { type: 'number' }, y: { type: 'number' }, settle_ms: { type: 'number', description: 'Wait after clicking (default 300)' }, target: TGT, device: DEV, timeout_ms: TMO } } },
  { name: 'type', description: 'Set the value of an input/textarea/select/contenteditable (works with React-controlled inputs) and fire input/change. Optional submit.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, ref: { type: 'number' }, selector: { type: 'string' }, clear: { type: 'boolean', description: 'Replace existing value (default true); false appends' }, submit: { type: 'boolean' }, target: TGT, device: DEV, timeout_ms: TMO }, required: ['text'] } },
  { name: 'screenshot', description: 'Approximate screenshot rendered on the phone with html2canvas (viewport by default). WebGL/WebGPU canvases may come out blank; for those, use run_js with canvas.toDataURL.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, full_page: { type: 'boolean' }, max_width: { type: 'number', description: 'Output width cap in px (default 480)' }, quality: { type: 'number', description: 'JPEG quality 0-1 (default 0.7)' }, target: TGT, device: DEV, timeout_ms: TMO } } },
  { name: 'set_html', description: 'Load an HTML document you write into the stage iframe (srcdoc, same-origin, so run_js/snapshot can reach it). Console output and errors from it are captured from the first line. Use it to build test pages (WebGPU, wasm, model loading, layout).', inputSchema: { type: 'object', properties: { html: { type: 'string' }, wait_ms: { type: 'number', description: 'Max wait for load (default 15000)' }, device: DEV, timeout_ms: TMO }, required: ['html'] } },
  { name: 'open_url', description: 'Load a URL in the stage iframe. Cross-origin pages are visible on the phone but not readable (and many sites refuse framing). top:true navigates the whole tab instead, which drops the connection unless the destination also loads agent.js.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, top: { type: 'boolean' }, wait_ms: { type: 'number' }, device: DEV, timeout_ms: TMO }, required: ['url'] } },
  { name: 'reload', description: 'Reload the phone tab (it reconnects on its own in a few seconds).', inputSchema: { type: 'object', properties: { device: DEV } } },
  { name: 'say', description: 'Show a message card over the phone page (Keal keeps the tab in front, so this is how to talk to him mid-test). Optional quick-reply buttons; he can also type a reply. His replies arrive in get_logs with src "keal".', inputSchema: { type: 'object', properties: { text: { type: 'string' }, buttons: { type: 'array', items: { type: 'string' } }, device: DEV, timeout_ms: TMO }, required: ['text'] } },
  { name: 'get_logs', description: 'Console output, uncaught errors, rejections and lifecycle notes captured on the phone (page and stage). Use `since` with the returned lastSeq to get only new entries.', inputSchema: { type: 'object', properties: { since: { type: 'number' }, limit: { type: 'number', description: 'default 200' }, clear: { type: 'boolean' }, device: DEV } } },
];
const FORWARD = new Set(['say', 'device_info', 'run_js', 'snapshot', 'click', 'type', 'screenshot', 'set_html', 'open_url', 'reload']);

async function rpc(m, hub) {
  if (m == null || m.id === undefined || m.id === null) return null;
  const ok = result => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': return ok({ protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'phone-relay', version: '1.0.0' }, instructions: INSTRUCTIONS });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'resources/list': return ok({ resources: [] });
    case 'prompts/list': return ok({ prompts: [] });
    case 'tools/call': {
      const p = m.params || {};
      try {
        const r = await hub.fetch('https://hub/call', { method: 'POST', body: JSON.stringify({ name: p.name, args: p.arguments || {} }) });
        return ok(await r.json());
      } catch (e) { return ok({ content: [{ type: 'text', text: 'relay error: ' + e.message }], isError: true }); }
    }
    default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found: ' + m.method } };
  }
}

async function handleMcp(req, hub) {
  let body;
  try { body = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400); }
  const batch = Array.isArray(body);
  const out = [];
  for (const m of (batch ? body : [body])) { const r = await rpc(m, hub); if (r) out.push(r); }
  if (!out.length) return new Response(null, { status: 202 });
  return json(batch ? out : out[0]);
}

function harnessHtml(key) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Phone Relay</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--mut:#8a8a8a;--bar:#f2f2f2}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#eee;--bar:#161616}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px -apple-system,system-ui,sans-serif}
body{display:flex;flex-direction:column}
#bar{display:flex;align-items:center;gap:8px;padding:calc(env(safe-area-inset-top) + 6px) 12px 6px;background:var(--bar);font-size:12px}
#dot{width:9px;height:9px;border-radius:50%;background:#999;flex:none}
#dot.online{background:#2ecc71}#dot.connecting{background:#f1c40f}#dot.offline{background:#e74c3c}
#nm{color:var(--mut)}
#wake{margin-left:auto;font:inherit;padding:4px 10px;border-radius:12px;border:1px solid var(--mut);background:none;color:inherit}
#idle{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--mut);text-align:center;padding:24px}
#idle b{color:var(--fg);font-size:16px}
#pr-stage{display:none;flex:1;width:100%;border:0;background:#fff}
</style></head><body>
<div id="bar"><span id="dot"></span><span id="st">connecting…</span><span id="nm"></span><button id="wake">Keep awake</button></div>
<div id="idle"><b>Waiting for Claude</b><span>Keep this tab in front. Tap “Keep awake” so the screen doesn’t lock.</span></div>
<iframe id="pr-stage" allow="fullscreen; autoplay; clipboard-read; clipboard-write; cross-origin-isolated"></iframe>
<script>
(function(){
  var q = new URLSearchParams(location.search);
  window.__prStatus = function(s, name){
    document.getElementById('dot').className = s;
    document.getElementById('st').textContent = s === 'online' ? 'connected' : s === 'connecting' ? 'connecting…' : 'offline, retrying';
    document.getElementById('nm').textContent = name || '';
  };
  var want = false, b = document.getElementById('wake');
  async function grab(){
    try { var l = await navigator.wakeLock.request('screen'); b.textContent = 'Awake ✓'; l.addEventListener('release', function(){ b.textContent = 'Keep awake'; }); }
    catch (e) { b.textContent = 'Wake lock n/a'; }
  }
  b.onclick = function(){ want = true; grab(); };
  document.addEventListener('visibilitychange', function(){ if (want && document.visibilityState === 'visible') grab(); });
  var s = document.createElement('script');
  s.src = '/agent.js?k=${key}&name=' + encodeURIComponent(q.get('name') || '');
  document.body.appendChild(s);
})();
</script></body></html>`;
}

function agentMain() {
  if (window.__phoneRelay) return; window.__phoneRelay = true;
  const me = document.currentScript;
  const src = new URL(me.src);
  const K = src.searchParams.get('k');
  const ORIGIN = src.origin;
  const guessName = () => { const u = navigator.userAgent; if (/iPhone/.test(u)) return 'iPhone Safari'; if (/iPad/.test(u)) return 'iPad Safari'; if (/Android/.test(u)) return 'Android'; return 'Desktop browser'; };
  const NAME = src.searchParams.get('name') || guessName();
  let id;
  try { id = localStorage.getItem('pr-id'); if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); localStorage.setItem('pr-id', id); } }
  catch (e) { id = 'anon-' + Math.random().toString(36).slice(2); }
  let tab;
  try { tab = sessionStorage.getItem('pr-tab'); if (!tab) { tab = Math.random().toString(36).slice(2, 6); sessionStorage.setItem('pr-tab', tab); } }
  catch (e) { tab = Math.random().toString(36).slice(2, 6); }
  id = id + '-' + tab;

  let badge;
  function status(s) {
    if (window.__prStatus) return window.__prStatus(s, NAME);
    if (!badge) { badge = document.createElement('div'); badge.style.cssText = 'position:fixed;right:8px;bottom:8px;width:10px;height:10px;border-radius:50%;z-index:2147483647;pointer-events:none;box-shadow:0 0 0 2px rgba(0,0,0,.25)'; (document.body || document.documentElement).appendChild(badge); }
    badge.style.background = s === 'online' ? '#2ecc71' : s === 'connecting' ? '#f1c40f' : '#e74c3c';
  }

  // ---- logging
  const q = []; let ft = null;
  function fmt(x) {
    if (typeof x === 'string') return x;
    if (x === undefined) return 'undefined';
    if (x && (x.stack || x.message) && x.name) return String(x.stack || (x.name + ': ' + x.message));
    try { const s = JSON.stringify(safe(x)); return s === undefined ? String(x) : s; } catch (e) { return String(x); }
  }
  function push(level, srcTag, args) {
    q.push({ t: Date.now(), level, src: srcTag, msg: args.map(fmt).join(' ').slice(0, 4000) });
    if (q.length > 500) q.splice(0, q.length - 500);
    if (!ft) ft = setTimeout(flush, 250);
  }
  function flush() {
    ft = null;
    if (!q.length || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'log', entries: q.splice(0, q.length) }));
  }
  function hookWindow(w, tag) {
    try { if (w.__prHooked) return; w.__prHooked = true; } catch (e) { return; }
    for (const lv of ['log', 'info', 'warn', 'error', 'debug']) {
      const orig = w.console[lv];
      w.console[lv] = function (...a) { try { push(lv, tag, a); } catch (e) {} return orig.apply(this, a); };
    }
    w.addEventListener('error', e => push('error', tag, ['Uncaught ' + ((e.error && e.error.stack) || e.message) + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : '')]));
    w.addEventListener('unhandledrejection', e => push('error', tag, ['Unhandled rejection:', e.reason]));
  }
  hookWindow(window, 'page');
  window.__prHook = w => hookWindow(w, 'frame');

  // lifecycle / crash hint
  try {
    const nav = (performance.getEntriesByType('navigation')[0] || {}).type || 'unknown';
    const expected = sessionStorage.getItem('pr-expect-reload'); sessionStorage.removeItem('pr-expect-reload');
    push('info', 'agent', ['agent started (navigation: ' + nav + ')']);
    if (nav === 'reload' && !expected) push('warn', 'agent', ['page reloaded without a reload command; if heavy work was running, iOS probably killed the tab (memory)']);
  } catch (e) {}
  addEventListener('pagehide', () => push('info', 'agent', ['pagehide']));

  // ---- serialization
  function safe(v) {
    if (v === undefined) return undefined;
    const seen = new WeakSet();
    const tag = x => Object.prototype.toString.call(x);
    const s = JSON.stringify(v, function (k, x) {
      if (typeof x === 'bigint') return x.toString() + 'n';
      if (typeof x === 'function') return '[function ' + (x.name || 'anonymous') + ']';
      if (typeof x === 'symbol') return x.toString();
      if (x && typeof x === 'object') {
        if (typeof x.nodeType === 'number' && typeof x.nodeName === 'string') return x.outerHTML ? x.outerHTML.slice(0, 600) : String(x.nodeName);
        if (typeof x.message === 'string' && typeof x.name === 'string' && 'stack' in x) return { name: x.name, message: x.message, stack: String(x.stack || '').split('\n').slice(0, 6).join('\n') };
        if (ArrayBuffer.isView(x)) return { type: x.constructor.name, length: x.length != null ? x.length : x.byteLength, head: x.slice ? Array.from(x.slice(0, 16), n => typeof n === 'bigint' ? n.toString() : n) : [] };
        if (tag(x) === '[object ArrayBuffer]') return { type: 'ArrayBuffer', byteLength: x.byteLength };
        if (tag(x) === '[object Map]') return { Map: Array.from(x.entries()) };
        if (tag(x) === '[object Set]') return { Set: Array.from(x) };
        if (seen.has(x)) return '[circular]';
        seen.add(x);
      }
      return x;
    });
    return s === undefined ? undefined : JSON.parse(s);
  }

  // ---- stage + targets
  function stage() {
    let st = document.getElementById('pr-stage');
    if (!st) { st = document.createElement('iframe'); st.id = 'pr-stage'; st.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483646;background:#fff'; document.body.appendChild(st); }
    st.style.display = 'block';
    const idle = document.getElementById('idle'); if (idle) idle.style.display = 'none';
    return st;
  }
  function ctx(target) {
    const st = document.getElementById('pr-stage');
    let fwin = null;
    try { if (st && st.contentDocument && st.contentWindow.location.href !== 'about:blank') fwin = st.contentWindow; } catch (e) {}
    if (target === 'frame') { if (!fwin) throw new Error('stage iframe is empty or cross-origin'); return { win: fwin, doc: fwin.document, frame: st }; }
    if (target === 'page' || !fwin) return { win: window, doc: document, frame: st };
    return { win: fwin, doc: fwin.document, frame: st };
  }
  const describe = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' "' + String(el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40) + '"';
  function find(c, a) {
    let el = null;
    if (a.ref != null) el = c.doc.querySelector('[data-pr="' + a.ref + '"]');
    else if (a.selector) el = c.doc.querySelector(a.selector);
    else if (a.text) { const t = a.text.toLowerCase(); el = Array.from(c.doc.querySelectorAll('a,button,[role=button],[role=link],[role=tab],input[type=submit],input[type=button],label,summary')).find(e => String(e.innerText || e.value || '').trim().toLowerCase().includes(t)); }
    if (!el) throw new Error('element not found' + (a.ref != null ? ' (refs reset on each snapshot; take a fresh one)' : ''));
    return el;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function basicInfo() {
    const n = navigator;
    return { ua: n.userAgent, platform: n.platform, language: n.language, screen: [screen.width, screen.height], viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, hardwareConcurrency: n.hardwareConcurrency, deviceMemory: n.deviceMemory, crossOriginIsolated: self.crossOriginIsolated, secureContext: self.isSecureContext, standalone: n.standalone, href: location.href };
  }
  let h2c = null;
  function loadH2C() {
    return h2c || (h2c = new Promise((res, rej) => {
      const s = document.createElement('script'); s.crossOrigin = 'anonymous';
      s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
      s.onload = () => res(window.html2canvas); s.onerror = () => { h2c = null; rej(new Error('could not load html2canvas')); };
      document.head.appendChild(s);
    }));
  }

  // CSP without 'unsafe-eval' (Squiggle): load the code as a script from the relay's /run.js instead ('self' on the mirror).
  function viaScript(c, code) {
    return new Promise((res, rej) => {
      const rid = 'r' + Math.random().toString(36).slice(2);
      const s = c.doc.createElement('script');
      s.src = ORIGIN + '/run.js?k=' + encodeURIComponent(K) + '&id=' + rid + '&c=' + encodeURIComponent(code);
      s.onload = () => { s.remove(); const reg = c.win.__prRun || {}; const fn = reg[rid]; delete reg[rid]; fn ? res(fn) : rej(new Error('code did not load (syntax error? see get_logs)')); };
      s.onerror = () => { s.remove(); rej(new Error('the page blocked /run.js (its CSP)')); };
      (c.doc.head || c.doc.documentElement).appendChild(s);
    });
  }
  // Messages from Claude drawn over the page, so Keal can keep the tab in front. Replies land in get_logs (src "keal").
  let sayBox = null;
  function say(text, buttons) {
    if (!sayBox || !sayBox.isConnected) {
      sayBox = document.createElement('div');
      sayBox.style.cssText = 'position:fixed;left:8px;right:8px;top:calc(env(safe-area-inset-top) + 8px);z-index:2147483647;display:flex;flex-direction:column;gap:6px;pointer-events:none;font:15px/1.35 -apple-system,system-ui,sans-serif';
      document.documentElement.appendChild(sayBox);
    }
    const card = document.createElement('div');
    card.setAttribute('role', 'alert');
    card.style.cssText = 'pointer-events:auto;background:#1e2433;color:#fff;border-radius:14px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.4)';
    const p = document.createElement('div');
    p.style.whiteSpace = 'pre-wrap';
    p.textContent = 'Claude: ' + text;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center';
    const bs = 'font:inherit;padding:6px 12px;border-radius:10px;border:0;background:#4f7cff;color:#fff';
    const reply = (v) => { push('info', 'keal', [v]); card.remove(); };
    for (const b of (buttons || [])) { const x = document.createElement('button'); x.textContent = b; x.style.cssText = bs; x.onclick = () => reply(b); row.appendChild(x); }
    const inp = document.createElement('input');
    inp.placeholder = 'Reply to Claude…';
    inp.style.cssText = 'flex:1;min-width:120px;font:16px -apple-system,system-ui,sans-serif;padding:6px 10px;border-radius:10px;border:0;color:#111;background:#fff';
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); reply(inp.value.trim()); } };   // keep the host page's key handlers out of it
    for (const ev of ['keyup', 'keypress', 'input', 'click', 'pointerdown', 'touchstart']) card.addEventListener(ev, (e) => e.stopPropagation());
    const x = document.createElement('button');
    x.textContent = '✕'; x.setAttribute('aria-label', 'Dismiss');
    x.style.cssText = bs + ';background:#444';
    x.onclick = () => card.remove();
    row.append(inp, x);
    card.append(p, row);
    sayBox.appendChild(card);
    try { navigator.vibrate && navigator.vibrate(80); } catch (e) {}
  }
  window.__prSay = say;
  const CMDS = {
    async say(a) { say(String(a.text || ''), a.buttons); return 'shown on the phone; replies show up in get_logs as src "keal"'; },
    async device_info() {
      const info = basicInfo(); const n = navigator;
      try { const est = await n.storage.estimate(); info.storage = { quotaMB: Math.round(est.quota / 1048576), usageMB: Math.round(est.usage / 1048576) }; } catch (e) {}
      if (performance.memory) info.jsHeap = { usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576), limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576) };
      if (n.gpu) {
        try {
          const ad = await n.gpu.requestAdapter();
          if (!ad) info.webgpu = 'navigator.gpu exists but requestAdapter() returned null';
          else {
            const lim = {}; for (const k in ad.limits) lim[k] = ad.limits[k];
            const inf = ad.info || {};
            info.webgpu = { features: Array.from(ad.features), limits: lim, info: { vendor: inf.vendor, architecture: inf.architecture, device: inf.device, description: inf.description }, isFallbackAdapter: ad.isFallbackAdapter };
          }
        } catch (e) { info.webgpu = 'error: ' + e.message; }
      } else info.webgpu = 'not available (navigator.gpu undefined)';
      try {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (gl) { const d = gl.getExtension('WEBGL_debug_renderer_info'); info.webgl2 = { renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) }; }
      } catch (e) {}
      return info;
    },
    async run_js(a) {
      const c = ctx(a.target);
      let f;
      try { const AF = c.win.eval('(async function(){}).constructor'); f = new AF('frame', 'fwin', 'page', a.code); }
      catch (e) { if (!/unsafe-eval|EvalError|Content Security Policy/i.test(String(e && e.name) + ' ' + String(e && e.message))) throw e; f = await viaScript(c, a.code); }
      return await f.call(c.win, c.frame || null, c.frame ? c.frame.contentWindow : null, window);
    },
    async snapshot(a) {
      const c = ctx(a.target); const { win, doc } = c;
      const root = a.selector ? doc.querySelector(a.selector) : doc.body;
      if (!root) throw new Error('no element for ' + a.selector);
      doc.querySelectorAll('[data-pr]').forEach(e => e.removeAttribute('data-pr'));
      const els = root.querySelectorAll('a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[onclick],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])');
      const items = []; let n = 0; const maxE = a.max_elements || 150;
      for (const el of els) {
        const r = el.getBoundingClientRect(); if (!r.width && !r.height) continue;
        const cs = win.getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const ref = ++n; el.setAttribute('data-pr', ref);
        const label = String(el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        items.push({ ref, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || el.getAttribute('role') || undefined, label, href: el.getAttribute('href') || undefined, inView: r.bottom > 0 && r.top < win.innerHeight, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
        if (items.length >= maxE) break;
      }
      const max = a.max_chars || 6000;
      const text = String(root.innerText || '').replace(/\n{3,}/g, '\n\n');
      return { title: doc.title, url: win.location.href, viewport: [win.innerWidth, win.innerHeight], scroll: [Math.round(win.scrollX), Math.round(win.scrollY)], docHeight: doc.documentElement.scrollHeight, text: text.length > max ? text.slice(0, max) + '\n…[' + (text.length - max) + ' more chars]' : text, interactive: items };
    },
    async click(a) {
      const c = ctx(a.target); const W = c.win;
      const byPoint = a.x != null && a.y != null;
      const el = byPoint ? c.doc.elementFromPoint(a.x, a.y) : find(c, a);
      if (!el) throw new Error('nothing at that point');
      if (!byPoint) el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const x = byPoint ? a.x : r.left + r.width / 2, y = byPoint ? a.y : r.top + r.height / 2;
      const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
      const pe = (t) => { try { el.dispatchEvent(new W.PointerEvent(t, Object.assign({ pointerType: 'touch', isPrimary: true, pointerId: 1 }, o))); } catch (e) {} };
      pe('pointerdown'); el.dispatchEvent(new W.MouseEvent('mousedown', o));
      pe('pointerup'); el.dispatchEvent(new W.MouseEvent('mouseup', o));
      try { el.focus && el.focus({ preventScroll: true }); } catch (e) {}
      if (typeof el.click === 'function') el.click(); else el.dispatchEvent(new W.MouseEvent('click', o));
      await sleep(a.settle_ms != null ? a.settle_ms : 300);
      return { clicked: describe(el), at: [Math.round(x), Math.round(y)] };
    },
    async type(a) {
      const c = ctx(a.target); const W = c.win;
      const el = a.ref != null || a.selector ? find(c, a) : c.doc.activeElement;
      if (!el || el === c.doc.body) throw new Error('no target element (pass ref or selector)');
      try { el.focus(); } catch (e) {}
      const append = a.clear === false;
      if (el.isContentEditable) el.textContent = append ? el.textContent + a.text : a.text;
      else {
        const proto = el.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? W.HTMLSelectElement.prototype : W.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, append ? el.value + a.text : a.text);
      }
      el.dispatchEvent(new W.Event('input', { bubbles: true }));
      el.dispatchEvent(new W.Event('change', { bubbles: true }));
      if (a.submit) {
        if (el.form && el.form.requestSubmit) el.form.requestSubmit();
        else { el.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); el.dispatchEvent(new W.KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true })); }
        await sleep(300);
      }
      return { typed: a.text.length, into: describe(el) };
    },
    async screenshot(a) {
      const c = ctx(a.target); const H = await loadH2C();
      const el = a.selector ? c.doc.querySelector(a.selector) : c.doc.documentElement;
      if (!el) throw new Error('no element for ' + a.selector);
      const vw = c.win.innerWidth, vh = c.win.innerHeight;
      const scale = Math.min(1, (a.max_width || 480) / vw);
      const opts = { scale, useCORS: true, logging: false, windowWidth: vw, windowHeight: vh };
      if (!a.selector) {
        if (a.full_page) Object.assign(opts, { x: 0, y: 0, width: vw, height: Math.min(c.doc.documentElement.scrollHeight, 5000) });
        else Object.assign(opts, { x: c.win.scrollX, y: c.win.scrollY, width: vw, height: vh });
      }
      const canvas = await H(el, opts);
      return { __image: canvas.toDataURL('image/jpeg', a.quality || 0.7).split(',')[1], mime: 'image/jpeg' };
    },
    async set_html(a) {
      const st = stage(); const t0 = performance.now();
      const hook = '<script>try{parent.__prHook(window)}catch(e){}<\/script>';
      let html = String(a.html || '');
      html = /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^(\s*<!doctype[^>]*>)/i, '$1' + hook) : hook + html;
      st.removeAttribute('src');
      const loaded = await new Promise(res => { st.onload = () => res(true); st.srcdoc = html; setTimeout(() => res(false), a.wait_ms || 15000); });
      return { loaded, ms: Math.round(performance.now() - t0) };
    },
    async open_url(a) {
      if (a.top) { try { sessionStorage.setItem('pr-expect-reload', '1'); } catch (e) {} setTimeout(() => { location.href = a.url; }, 50); return { navigating: a.url, note: 'whole tab navigates; the connection drops unless the destination loads agent.js' }; }
      const st = stage(); st.removeAttribute('srcdoc');
      const loaded = await new Promise(res => { st.onload = () => res(true); st.src = a.url; setTimeout(() => res(false), a.wait_ms || 15000); });
      let readable = false;
      try { readable = !!st.contentWindow.location.href; hookWindow(st.contentWindow, 'frame'); } catch (e) {}
      return { url: a.url, loaded, readable, note: readable ? undefined : 'cross-origin: visible on the phone, but run_js/snapshot cannot see inside it (and the site may refuse to be framed)' };
    },
    async reload() { try { sessionStorage.setItem('pr-expect-reload', '1'); } catch (e) {} setTimeout(() => location.reload(), 100); return 'reloading; it reconnects in a few seconds'; },
  };

  async function handle(m) {
    let resp;
    try {
      const fn = CMDS[m.cmd]; if (!fn) throw new Error('unknown command ' + m.cmd);
      const r = await fn(m.args || {});
      resp = (r && r.__image) ? { ok: true, image: r.__image, mime: r.mime } : { ok: true, result: safe(r) };
    } catch (e) {
      resp = { ok: false, error: e && e.stack ? String(e.message) + '\n' + String(e.stack).split('\n').slice(0, 6).join('\n') : String(e) };
    }
    resp.type = 'res'; resp.id = m.id;
    let s = JSON.stringify(resp);
    if (s.length > 4000000) s = JSON.stringify({ type: 'res', id: m.id, ok: false, error: 'result too large (' + s.length + ' chars); return less' });
    if (ws && ws.readyState === 1) ws.send(s);
  }

  // ---- connection
  let ws = null, backoff = 500, pingT = null, retryT = null;
  function connect() {
    if (ws && ws.readyState <= 1) return;
    clearTimeout(retryT);
    status('connecting');
    const u = ORIGIN.replace(/^http/, 'ws') + '/ws?k=' + encodeURIComponent(K) + '&id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(NAME);
    try { ws = new WebSocket(u); } catch (e) { return retry(); }
    ws.onopen = () => {
      backoff = 500; status('online');
      ws.send(JSON.stringify({ type: 'hello', name: NAME, href: location.href, info: basicInfo() }));
      flush();
      clearInterval(pingT); pingT = setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"type":"ping"}'); }, 20000);
    };
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.type === 'cmd') handle(m); };
    ws.onclose = () => { status('offline'); clearInterval(pingT); retry(); };
    ws.onerror = () => {};
  }
  function retry() { clearTimeout(retryT); retryT = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 10000); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) { backoff = 500; connect(); } });
  addEventListener('online', () => { backoff = 500; connect(); });
  connect();
}
const AGENT_JS = '(' + agentMain.toString() + ')();';

class Hub {
  constructor(state, env) { this.state = state; this.env = env; this.devices = new Map(); this.pending = new Map(); this.seq = 0; }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') return this.accept(url);
    if (url.pathname === '/call') { const { name, args } = await req.json(); return json(await this.call(name, args || {})); }
    return new Response('not found', { status: 404 });
  }
  accept(url) {
    const now = Date.now();
    for (const [k, d] of this.devices) if (!d.ws && d.closedAt && now - d.closedAt > 2 * 3600e3) this.devices.delete(k);
    const pair = new WebSocketPair(); const client = pair[0], server = pair[1];
    server.accept();
    const id = String(url.searchParams.get('id') || crypto.randomUUID()).slice(0, 64);
    const old = this.devices.get(id);
    const dev = { id, ws: server, name: url.searchParams.get('name') || 'device', info: {}, href: '', logs: old ? old.logs : [], logSeq: old ? old.logSeq : 0, connectedAt: now, lastSeen: now, closedAt: 0 };
    if (old && old.ws) { try { old.ws.close(4000, 'replaced'); } catch (e) {} }
    this.devices.set(id, dev);
    server.addEventListener('message', ev => this.onMsg(dev, ev.data));
    const gone = () => { if (this.devices.get(id) === dev && dev.ws) { dev.ws = null; dev.closedAt = Date.now(); } };
    server.addEventListener('close', gone); server.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }
  onMsg(dev, data) {
    dev.lastSeen = Date.now();
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (m.type === 'ping') { try { dev.ws && dev.ws.send('{"type":"pong"}'); } catch (e) {} return; }
    if (m.type === 'hello') { dev.info = m.info || {}; if (m.name) dev.name = m.name; dev.href = m.href || ''; return; }
    if (m.type === 'log') {
      for (const e of (m.entries || [])) { e.seq = ++dev.logSeq; dev.logs.push(e); }
      if (dev.logs.length > 1000) dev.logs.splice(0, dev.logs.length - 1000);
      return;
    }
    if (m.type === 'res') { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); clearTimeout(p.t); p.resolve(m); } }
  }
  pick(sel) {
    const all = Array.from(this.devices.values());
    if (sel) { const d = this.devices.get(sel) || all.find(x => x.name === sel); if (!d) throw new Error('no device "' + sel + '"; call list_devices'); return d; }
    const online = all.filter(d => d.ws).sort((a, b) => b.lastSeen - a.lastSeen);
    if (!online.length) throw new Error('No device connected. Open the harness page on the phone and keep Safari in the foreground.');
    return online[0];
  }
  send(dev, cmd, args, ms) {
    if (!dev.ws) return Promise.reject(new Error('device "' + dev.name + '" is offline (Safari backgrounded, phone locked, or tab closed)'));
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('timed out after ' + ms + 'ms waiting for the phone')); }, ms);
      this.pending.set(id, { resolve, t });
      try { dev.ws.send(JSON.stringify({ type: 'cmd', id, cmd, args })); } catch (e) { clearTimeout(t); this.pending.delete(id); reject(e); }
    });
  }
  async call(name, a) {
    const text = t => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
    const err = e => ({ content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true });
    try {
      if (name === 'list_devices') {
        const now = Date.now();
        return text(Array.from(this.devices.values()).map(d => ({ id: d.id, name: d.name, online: !!d.ws, href: d.href, ua: d.info.ua, viewport: d.info.viewport, connectedAt: new Date(d.connectedAt).toISOString(), lastSeenSecAgo: Math.round((now - d.lastSeen) / 1000) })));
      }
      const dev = this.pick(a.device);
      if (name === 'get_logs') {
        const since = a.since || 0; let logs = dev.logs.filter(e => e.seq > since);
        const lim = a.limit || 200; if (logs.length > lim) logs = logs.slice(-lim);
        const lastSeq = dev.logSeq;
        if (a.clear) dev.logs = [];
        return text({ device: dev.name, online: !!dev.ws, count: logs.length, lastSeq, logs: logs.map(e => ({ seq: e.seq, t: new Date(e.t).toISOString(), level: e.level, src: e.src, msg: e.msg })) });
      }
      if (!FORWARD.has(name)) return err('unknown tool ' + name);
      const ms = Math.min(Math.max(Number(a.timeout_ms) || 30000, 1000), 280000);
      const r = await this.send(dev, name, a, ms);
      if (!r.ok) return err(r.error || 'failed on the phone');
      if (r.image) return { content: [{ type: 'image', data: r.image, mimeType: r.mime || 'image/jpeg' }] };
      return text(r.result === undefined ? 'undefined' : r.result);
    } catch (e) { return err(e); }
  }
}

const worker = {
  async fetch(req, env) {
    const url = new URL(req.url); const p = url.pathname;
    const hub = () => env.HUB.get(env.HUB.idFromName('main'));
    if (p === '/run.js') {
      if (url.searchParams.get('k') !== env.PAGE_KEY) return new Response('bad key', { status: 403 });
      const rid = (url.searchParams.get('id') || '').replace(/[^A-Za-z0-9]/g, '');
      const js = '(window.__prRun = window.__prRun || {})[' + JSON.stringify(rid) + '] = async function (frame, fwin, page) {\n' + (url.searchParams.get('c') || '') + '\n};';
      return new Response(js, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'cross-origin' } });
    }
    if (p === '/agent.js') return new Response(AGENT_JS, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' } });
    if (p === '/p/' + env.PAGE_KEY || p === '/p/' + env.PAGE_KEY + '/') {
      const h = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
      if (url.searchParams.get('coi')) { h['cross-origin-opener-policy'] = 'same-origin'; h['cross-origin-embedder-policy'] = 'require-corp'; }
      return new Response(harnessHtml(env.PAGE_KEY), { headers: h });
    }
    if (p === '/ws') {
      if (url.searchParams.get('k') !== env.PAGE_KEY) return new Response('bad key', { status: 403 });
      if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      return hub().fetch(req);
    }
    if (p === '/mcp/' + env.MCP_KEY) {
      if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: { allow: 'POST' } });
      return handleMcp(req, hub());
    }
    if (p === '/') return new Response('phone-relay', { headers: { 'content-type': 'text/plain' } });
    // Mirror kealjones.com (Squiggle + PR previews) on this origin, with agent.js injected into HTML, so pages run top-level with the relay attached.
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('not found', { status: 404 });
    const up = await fetch('https://kealjones.com' + p + (url.search ? url.search + '&' : '?') + '__pr=' + Date.now(), {   // fresh query: GitHub Pages' CDN keeps files ~10 min
 redirect: 'manual', headers: { 'user-agent': req.headers.get('user-agent') || 'phone-relay', accept: req.headers.get('accept') || '*/*' } });
    const hh = new Headers(up.headers);
    const loc = hh.get('location');
    if (loc) hh.set('location', loc.replace(/^https?:\/\/(www\.)?kealjones\.(com|github\.io)/i, url.origin));
    hh.set('cache-control', 'no-store'); hh.delete('content-length'); hh.delete('content-encoding'); hh.delete('content-security-policy');
    if ((hh.get('content-type') || '').includes('text/html') && up.status === 200) {
      const tag = '<meta name="referrer" content="no-referrer"><script src="/agent.js?k=' + env.PAGE_KEY + '&v=' + Date.now() + '"></script>';   // per-response version: the page's service worker caches same-origin scripts
      let html = await up.text();
      // The page's CSP meta blocks eval, which run_js needs on this mirror only: allow it in script-src, keep the rest.
      html = html.replace(/(<meta[^>]+Content-Security-Policy[^>]*content=")([^"]*)/i, (m, a, c) => a + c.replace(/script-src/, "script-src 'unsafe-eval'"));
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + tag) : tag + html;
      return new Response(html, { status: 200, headers: hh });
    }
    return new Response(up.body, { status: up.status, headers: hh });
  }
};

export { Hub };
export default worker;
