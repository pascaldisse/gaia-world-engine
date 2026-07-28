import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// client/assets/** and client/atlas-graph.json are never `import`ed by any
// JS module — every consumer (vrm.js, atlas-strategy.js, atlas-gate.js,
// atlas-cosmos.js, atlas-director.js) reaches them at runtime with a plain
// same-origin fetch('/assets/...') or fetch('/atlas-graph.json'). Vite's
// build only bundles what the module graph sees, so a production build
// silently drops them — this plugin copies them into outDir verbatim after
// the JS bundle is written, at the exact same relative paths, so every one
// of those runtime fetches resolves identically in dist/ as in dev.
function copyStaticAssets() {
  let root;
  let outDir;
  return {
    name: 'gaia-copy-static-assets',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = path.isAbsolute(config.build.outDir) ? config.build.outDir : path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const rel of ['assets', 'atlas-graph.json']) {
        const from = path.join(root, rel);
        if (!fs.existsSync(from)) continue;
        fs.cpSync(from, path.join(outDir, rel), { recursive: true });
      }
    },
  };
}

// Two games can run side by side: GAIA_PORT moves the world server (and the
// client's idea of where it lives — injected as __GAIA_PORT__), and
// GAIA_CLIENT_PORT moves vite itself. GAIA_STATIC_BUILD=1 bakes __GAIA_STATIC__
// true, so a static production build boots from the snapshot (client/kernel/
// static-world.js) without needing ?static=1 on every URL — the other half
// of the switch (?static=1) is read at runtime, not here.
export default defineConfig({
  root: 'client',
  server: { port: Number(process.env.GAIA_CLIENT_PORT ?? 5173), fs: { allow: ['..'] } },
  define: {
    __GAIA_PORT__: JSON.stringify(process.env.GAIA_PORT ?? '8420'),
    __QUEST_URL__: JSON.stringify(process.env.QUEST_URL ?? 'http://localhost:4610'),
    __GAIA_STATIC__: JSON.stringify(process.env.GAIA_STATIC_BUILD === '1'),
  },
  build: {
    // top-level await (renderer boot) + WebGPU-era three.js need a modern
    // target; the default esbuild target (~chrome87) rejects the former outright
    target: 'esnext',
    outDir: '../dist',
    emptyOutDir: true,
  },
  plugins: [copyStaticAssets()],
});
