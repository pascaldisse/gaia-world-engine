# paloptic-atlas — Cloudflare Pages deploy

Ships the Atlas as a static site (see `../../docs/atlas-static.md`) behind an
edge password gate (`functions/_middleware.js`) that blocks every request —
HTML, JS bundle, `atlas-graph.json`, `world-snapshot.json`, every VRM/audio
asset — until a signed session cookie is present. Groundwork only: **not
deployed yet**, no `CLOUDFLARE_API_TOKEN` exists in this environment.

## What's here

```
deploy/cloudflare/
  wrangler.toml              Pages project "paloptic-atlas" config
  functions/_middleware.js   the attached Worker (Pages Functions) — the gate
  README.md                  this file
```

`wrangler.toml`'s `pages_build_output_dir = "../../dist"` points at the repo
root's `dist/`, built separately (see below). `functions/` sits next to
`wrangler.toml`, not inside `dist/` — that's the Pages Functions convention:
Wrangler looks for `functions/` at the directory it's invoked from, not in
the build output.

## One-time setup (human steps)

1. Install wrangler if you want it resident (otherwise every command below
   works fine via `npx wrangler …`, which is what this README uses — no
   global install happened during this task):
   ```
   npm i -D wrangler        # optional
   ```
2. Auth: `CLOUDFLARE_API_TOKEN` comes from `~/.gaia/secrets.env` **when
   Pascal provides it** — it is not there yet (checked 2026-07-28: 0
   `CLOUDFLARE*` entries). Once it exists:
   ```
   set -a && source ~/.gaia/secrets.env && set +a
   ```
   (or `export CLOUDFLARE_API_TOKEN=…` directly). Wrangler picks it up from
   the environment automatically — no `wrangler login` needed in a
   non-interactive environment.
3. Create the Pages project (first deploy also does this implicitly, but
   explicit is clearer):
   ```
   cd deploy/cloudflare
   npx wrangler pages project create paloptic-atlas
   ```
4. Bind the real secret (the HMAC key that signs the session cookie —
   generate one, don't reuse the local test value below):
   ```
   openssl rand -hex 32 | npx wrangler pages secret put SESSION_SECRET --project-name paloptic-atlas
   ```
   `GATE_HASH` and `GATE_HINT` are already plain `[vars]` in `wrangler.toml`
   (not secret — see the comment there for why) and ship with every deploy
   automatically; no `secret put` needed for those. If the password ever
   changes, update `GATE_HASH` in `wrangler.toml` from
   `/Users/pascaldisse/projects/paloptic/gate/gate-config.json`'s `"sha256"`
   field (the hash only — never commit `PASSWORD.txt`).

## Build

From the repo root (`GAIA-World-Engine/`):

```
GAIA_STATIC_BUILD=1 npx vite build
```

Produces `dist/` — verified contents (2026-07-28 build): `index.html`,
`assets/index-*.js` (client+plugins bundle, ~1.4 MB), `assets/vrm/` (62 MB),
`assets/audio/` (37 MB), `assets/vrma/`, `assets/gate-config.json`,
`assets/world-snapshot.json` (~632 KB), `atlas-graph.json` (4.1 MB) — 106 MB
total, largest single file 18.5 MB (`cand-Sakurada_Fumiriya.vrm`), well
under Cloudflare Pages' 25 MB per-file limit.

## Deploy

```
cd deploy/cloudflare
npx wrangler pages deploy ../../dist --project-name paloptic-atlas
```

`wrangler.toml`'s `pages_build_output_dir` makes the directory arg
redundant in newer wrangler versions but harmless to keep explicit.

## Local test (no deploy, no token needed)

Pages Functions dev server, run from this directory so it finds
`functions/_middleware.js`:

```
cd deploy/cloudflare
npx wrangler pages dev ../../dist --port 8788 \
  -b GATE_HASH=<sha256-of-a-test-password> \
  -b GATE_HINT="local test" \
  -b SESSION_SECRET=<any-test-string>
```

`wrangler pages dev` does **not** read `[vars]`/secrets from `wrangler.toml`
(confirmed on wrangler 4.114.0 — only `CF_PAGES*` defaults show up without
`-b`); pass `GATE_HASH`/`GATE_HINT`/`SESSION_SECRET` as `-b` bindings for a
local run. `wrangler pages deploy` (the real deploy path) does read
`wrangler.toml`'s `[vars]` — only the secret needs the separate
`secret put` step above.

Verified 2026-07-28 against the built `dist/` with a throwaway test
password/hash pair (not the real gate secret):
- `GET /` unauthenticated → `401`, gate shell HTML only (hint text present,
  zero app bytes)
- `GET /atlas-graph.json` unauthenticated → `401` (the 4.2 MB file never
  leaves the edge without a session)
- `POST /gate` wrong password → `401`, no cookie
- `POST /gate` correct password → `200`, `Set-Cookie: gate_session=…;
  HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`
- same request replayed with the cookie → `GET /atlas-graph.json` `200`
  full 4,225,492 bytes; `GET /assets/world-snapshot.json` `200` full 645,798
  bytes; `GET /` `200` the real `index.html` (not the gate shell)
- forged/tampered cookie (`gate_session=1700000000.deadbeef`) → `401`, back
  to the gate (HMAC signature check rejects it)

## Remaining human steps to actually ship

1. Get `CLOUDFLARE_API_TOKEN` into `~/.gaia/secrets.env` (Pages:Edit
   permission on the target account).
2. `npx wrangler pages project create paloptic-atlas` (once).
3. `openssl rand -hex 32 | npx wrangler pages secret put SESSION_SECRET --project-name paloptic-atlas` (once, or whenever rotating).
4. `GAIA_STATIC_BUILD=1 npx vite build` from repo root (every deploy).
5. `npx wrangler pages deploy ../../dist --project-name paloptic-atlas` from
   `deploy/cloudflare/` (every deploy).
6. Visit the `*.pages.dev` URL Wrangler prints, confirm the gate prompt
   appears, unlock with the real password, confirm the Atlas loads.
7. Optional: attach a custom domain in the Cloudflare dashboard (Pages
   project → Custom domains) — no code change needed, the Worker gates
   every hostname that routes to the project.

## Known limitation carried over

`client/plugins/atlas-gate.js`'s own honesty note still applies to the
in-app presentation gate that runs *after* this Worker lets a session
through: `client/assets/gate-config.json`'s hash is visible client-side
regardless. This Worker is the actual enforcement layer (nothing ships
without a valid signed cookie first) — the in-app gate is now a second,
cosmetic ritual layered on top of a session that has already been checked.
