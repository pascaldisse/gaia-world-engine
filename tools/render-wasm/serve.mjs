// serve.mjs — tiny static server for the render-wasm proof page. Own port (arg/env), nothing copied into git.
//   /               → tools/render-wasm/
//   /pkg/*          → $RENDER_WASM_PKG (wasm-bindgen out-dir, default .scratch/pkg)
//   /kernel/*       → client/kernel/render-api/
//   /asylum.glb     → $GLB (read-only, default scene-export lane .scratch/asylum.glb)
//   /nm/*           → $NODE_MODULES (default: nearest node_modules walking up from the repo root; three r180 for three.html)
//   /gi/*          → client/kernel/gi (GIController for r6-gi.html)
//   /tsl/*          → scratch/tsl-games (game TSL sources staged by test/render-api-tsl.test.js)
import { resolve, join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const nearestNodeModules = (d) => { for (let p = d; ; p = dirname(p)) { if (existsSync(join(p, 'node_modules/three'))) return join(p, 'node_modules'); if (dirname(p) === p) return join(d, 'node_modules'); } };
export function serve({ port = Number(process.env.PORT || 5391),
  pkg = process.env.RENDER_WASM_PKG || join(root, '.scratch/pkg'),
  glb = process.env.GLB || join(root, '../scene-export/.scratch/asylum.glb'), nm = process.env.NODE_MODULES || nearestNodeModules(root) } = {}) {
  const safe = (base, rel) => { const p = resolve(base, '.' + rel); return p.startsWith(resolve(base)) ? p : null; };
  return Bun.serve({ port, async fetch(req) {
    const u = new URL(req.url).pathname;
    let p = null;
    if (u === '/asylum.glb') p = glb;
    else if (u.startsWith('/pkg/')) p = safe(pkg, u.slice(4));
    else if (u.startsWith('/ext/')) p = safe(join(root, '.scratch/ext'), u.slice(4)); // r8: read-only game assets copied into .scratch (never committed)
    else if (u.startsWith('/nm/')) p = safe(nm, u.slice(3));
    else if (u.startsWith('/tsl/')) p = safe(join(root, 'scratch/tsl-games'), u.slice(4));
    else if (u.startsWith('/gi/')) p = safe(join(root, 'client/kernel/gi'), u.slice(3));
    else if (u.startsWith('/kernel/')) p = safe(join(root, 'client/kernel/render-api'), u.slice(7));
    else p = safe(here, u === '/' ? '/index.html' : u);
    const f = p && Bun.file(p);
    if (!f || !(await f.exists())) return new Response('404', { status: 404 });
    return new Response(f, { headers: { 'cache-control': 'no-store' } });
  } });
}
if (import.meta.main) { const s = serve(); console.log(`render-wasm proof server http://localhost:${s.port}/`); }
