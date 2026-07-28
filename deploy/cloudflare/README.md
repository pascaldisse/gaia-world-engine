# paloptic-atlas — Cloudflare Worker (static assets) deploy

Ships the Atlas as a static site (see `../../docs/atlas-static.md`) behind an
edge password gate (`worker.js`) that blocks every request — HTML, JS
bundle, `atlas-graph.json`, `world-snapshot.json`, every VRM/audio asset —
until a signed session cookie is present. **Deployed 2026-07-28.**

## Architecture (why Worker, not Pages)

`CLOUDFLARE_API_TOKEN` in `~/.gaia/secrets.env` has the **"Edit Cloudflare
Workers"** template scope only — verified via `wrangler whoami` — no Pages
scope. So this ships as **one Worker with a bound `[assets]` directory**
(Workers Static Assets, GA since 2025), not a Pages project. Functionally
equivalent: `worker.js` is the entry point, gates every request, and falls
through to `env.ASSETS.fetch(request)` for authenticated static serving.

An earlier Pages-style draft (`functions/_middleware.js` as a Pages
Function) exists in git history (commit `0ccf782c`) — superseded, removed
from the working tree, semantics carried forward into `worker.js` almost
unchanged (just `SESSION_SECRET` → `GATE_COOKIE_KEY` and
`context.next()` → `env.ASSETS.fetch(request)`).

## What's here

```
deploy/cloudflare/
  wrangler.toml   Worker "paloptic-atlas" config: main=worker.js, [assets] -> ../../dist
  worker.js       the gate + asset passthrough
  README.md       this file
  proof/          browser screenshots from the live verification pass
```

## One-time setup (human steps)

1. Wrangler: not installed globally — every command below runs via
   `bunx wrangler`, which is fine.
2. Auth:
   ```
   source ~/.gaia/secrets.env   # CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
   export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
   ```
   Wrangler picks both up from the environment automatically.
3. Bind the real secret (the HMAC key that signs the session cookie):
   ```
   openssl rand -hex 32 | bunx wrangler secret put GATE_COOKIE_KEY
   ```
   `GATE_HASH` and `GATE_HINT` are plain `[vars]` in `wrangler.toml` (not
   secret — see the comment there) and ship with every deploy automatically.
   If the password ever changes, update `GATE_HASH` from
   `/Users/pascaldisse/projects/paloptic/gate/gate-config.json`'s `"sha256"`
   field (the hash only — never commit `PASSWORD.txt`).

## Build

From the repo root (`GAIA-World-Engine/`):

```
GAIA_STATIC_BUILD=1 npx vite build
```

Produces `dist/` (verified 2026-07-28 build, 108 MB / 48 files): `index.html`
(21 KB), `assets/index-*.js` (client+plugins bundle incl. atlas-gate,
atlas-director, atlas-analytics — plugins that aren't statically imported
are still reachable at runtime via `fetch`; forge/cosmos/eidos ship inside
the same bundle since the module graph pulls them in), `assets/vrm/` (4
files, largest 19.3 MB), `assets/vrma/`, `assets/audio/beginning/` +
`assets/audio/bloodborne/`, `assets/gate-config.json`,
`assets/world-snapshot.json` (933 KB, 436 entities incl. Dream locus, v3),
`atlas-graph.json` (4.38 MB). Largest single file 19.3 MB
(`cand-Sakurada_Fumiriya.vrm`) — every file confirmed under Workers' 25 MB
per-asset-file limit.

## Deploy

```
cd deploy/cloudflare
source ~/.gaia/secrets.env
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
bunx wrangler deploy
```

`wrangler.toml`'s `main = "worker.js"` + `[assets] directory = "../../dist"`
make the deploy self-contained — no extra flags needed. Prints the live
`*.workers.dev` URL on success.

## Verified live (2026-07-28)

- `GET /` unauthenticated → `401`, gate shell HTML only (liturgy + hint,
  zero app bytes)
- `GET /atlas-graph.json` unauthenticated → `401` (no asset leakage)
- `POST /gate` wrong password → `401`, no cookie
- `POST /gate` correct password → `200`, `Set-Cookie: gate_session=…;
  HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`
- authenticated `GET /` → real `index.html`
- authenticated `GET /atlas-graph.json` → `200`, full 4,383,780 bytes
- authenticated `GET /assets/audio/beginning/full-mix.m4a` → `200`, full
  bytes
- Browser (CDP): gate → correct password → eye opens → "THE BEGINNING" →
  film plays → Esc → database/universe renders. Screenshots in `proof/`.

## Known limitation carried over

`client/plugins/atlas-gate.js`'s own honesty note still applies to the
in-app presentation gate that runs *after* this Worker lets a session
through: `client/assets/gate-config.json`'s hash is visible client-side
regardless. This Worker is the actual enforcement layer (nothing ships
without a valid signed cookie first) — the in-app gate is now a second,
cosmetic ritual layered on top of a session that has already been checked.
