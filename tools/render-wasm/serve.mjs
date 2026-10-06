// serve.mjs — tiny static server for the render-wasm proof page. Own port (arg/env), nothing copied into git.
//   /               → tools/render-wasm/
//   /pkg/*          → $RENDER_WASM_PKG (wasm-bindgen out-dir, default .scratch/pkg)
//   /kernel/*       → client/kernel/render-api/
//   /asylum.glb     → $GLB (read-only, default scene-export lane .scratch/asylum.glb)
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
export function serve({ port = Number(process.env.PORT || 5391),
  pkg = process.env.RENDER_WASM_PKG || join(root, '.scratch/pkg'),
  glb = process.env.GLB || join(root, '../scene-export/.scratch/asylum.glb') } = {}) {
  const safe = (base, rel) => { const p = resolve(base, '.' + rel); return p.startsWith(resolve(base)) ? p : null; };
  return Bun.serve({ port, async fetch(req) {
    const u = new URL(req.url).pathname;
    let p = null;
    if (u === '/asylum.glb') p = glb;
    else if (u.startsWith('/pkg/')) p = safe(pkg, u.slice(4));
    else if (u.startsWith('/kernel/')) p = safe(join(root, 'client/kernel/render-api'), u.slice(7));
    else p = safe(here, u === '/' ? '/index.html' : u);
    const f = p && Bun.file(p);
    if (!f || !(await f.exists())) return new Response('404', { status: 404 });
    return new Response(f, { headers: { 'cache-control': 'no-store' } });
  } });
}
if (import.meta.main) { const s = serve(); console.log(`render-wasm proof server http://localhost:${s.port}/`); }
