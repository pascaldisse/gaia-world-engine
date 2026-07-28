// _middleware.js — THE REAL GATE: runs on every request to every path in
// the Pages project, before any static asset (index.html, main.js, the VRM
// files, atlas-graph.json, world-snapshot.json — all of it) ever leaves the
// edge. client/plugins/atlas-gate.js is presentation-only (its own honesty
// note says as much: a devtools user can strip that overlay or read its
// hash straight out of client/assets/gate-config.json, because by the time
// it runs, the whole app already shipped to the browser). This is the
// enforcement atlas-gate.js said had to "land at deploy time" — same secret,
// checked server-side, before any byte of the site is served.
//
// Flow:
//   unauthenticated (no valid signed cookie) + any path        -> gate shell (401)
//   unauthenticated + POST /gate {password}                    -> check, set cookie, or 401
//   authenticated (valid signed cookie)                        -> next() -> normal Pages static serving
//
// Secret handling:
//   GATE_HASH      — SHA-256 of the raw password (see hashHex below), bound
//                     as a plain var in wrangler.toml. Not secret by itself:
//                     it's the exact same hash client/assets/gate-config.json
//                     already ships to every browser for the presentation
//                     gate. What makes this Worker meaningful is WHEN it
//                     checks it, not that the hash is hidden.
//   SESSION_SECRET — a real secret (HMAC key), never in wrangler.toml. Set
//                     with `wrangler pages secret put SESSION_SECRET`. Signs
//                     the gate_session cookie so it can't be forged by
//                     guessing or copying a cookie shape.

const COOKIE_NAME = 'gate_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/gate') {
    return handleGate(request, env);
  }

  if (await isAuthenticated(request, env)) {
    return next();
  }

  return gateShell(env);
}

// ── the check ────────────────────────────────────────────────────────────

async function handleGate(request, env) {
  if (!env.SESSION_SECRET) {
    return json({ ok: false, error: 'server misconfigured: SESSION_SECRET unset' }, 500);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad request' }, 400);
  }
  const password = typeof body?.password === 'string' ? body.password : '';
  const hash = await sha256Hex(password);
  const expected = String(env.GATE_HASH ?? '');
  const match = expected.length === 64 && timingSafeEqual(hash, expected);
  if (!match) return json({ ok: false }, 401);

  const issuedAt = String(Math.floor(Date.now() / 1000));
  const sig = await sign(issuedAt, env.SESSION_SECRET);
  const cookie = `${issuedAt}.${sig}`;
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_SECONDS}`,
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function isAuthenticated(request, env) {
  if (!env.SESSION_SECRET) return false;
  const cookie = getCookie(request, COOKIE_NAME);
  if (!cookie) return false;
  const [issuedAt, sig] = cookie.split('.');
  if (!issuedAt || !sig) return false;
  const age = Math.floor(Date.now() / 1000) - Number(issuedAt);
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_SECONDS) return false;
  const expected = await sign(issuedAt, env.SESSION_SECRET);
  return timingSafeEqual(expected, sig);
}

// ── crypto ───────────────────────────────────────────────────────────────
// Same algorithm as client/plugins/atlas-gate.js's sha256Hex: the raw
// password string, verbatim (no trim/normalize), UTF-8 encoded, SHA-256 hex.
// Whatever secret unlocks the presentation gate unlocks this one too.

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// fixed-length hex digests (SHA-256 -> 64, HMAC-SHA256 -> 64) — a length
// mismatch means the wrong thing was compared, not a timing side-channel,
// so it's safe to bail before the loop
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

// ── the shell ────────────────────────────────────────────────────────────
// Unauthenticated visitors get ONLY this — never the app bundle, never the
// world snapshot, never a single VRM byte. Deliberately plain: it is a
// password prompt, not a re-implementation of atlas-gate.js's ritual (that
// stays the in-app experience for the SECOND, presentation-layer gate that
// still runs after this one lets you through).

function gateShell(env) {
  const hint = escapeHtml(env.GATE_HINT ?? '');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>paloptic atlas</title>
<style>
  html,body{margin:0;height:100%;background:#000;color:#e6dccd;
    font-family:'Cormorant Garamond','Palatino Linotype',Palatino,Georgia,serif;
    display:flex;align-items:center;justify-content:center}
  .wrap{max-width:26em;padding:0 8vw;text-align:center}
  .hint{opacity:.7;font-size:14px;letter-spacing:.08em;margin-bottom:1.6em}
  input{width:100%;box-sizing:border-box;background:transparent;border:none;
    border-bottom:1px solid rgba(230,220,205,.3);color:#e6dccd;font:inherit;
    font-size:16px;letter-spacing:.2em;text-align:center;padding:.5em 0;outline:none}
  .msg{min-height:1.4em;font-size:12px;letter-spacing:.1em;opacity:.75;margin-top:.8em}
  .msg.wrong{color:#c0342f}
</style>
</head>
<body>
  <div class="wrap">
    <p class="hint">${hint}</p>
    <input id="pw" type="password" autocomplete="off" spellcheck="false" autofocus />
    <p class="msg" id="msg"></p>
  </div>
  <script>
    const pw = document.getElementById('pw');
    const msg = document.getElementById('msg');
    pw.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      msg.textContent = '…';
      msg.className = 'msg';
      try {
        const res = await fetch('/gate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: pw.value }),
        });
        if (res.ok) { location.reload(); return; }
        msg.textContent = 'no.';
        msg.className = 'msg wrong';
      } catch {
        msg.textContent = 'the gate did not answer.';
        msg.className = 'msg wrong';
      }
    });
  </script>
</body>
</html>`;
  return new Response(html, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
