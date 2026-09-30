// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Spec §15 census: every bld_* model, every mesh part (≤8, consumer convention), {seed:7, amount:20}.
// Needs EE_ASSETS=<dir with bld_*.gltf>; skips (reported) when unset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadGltfParts } from './helpers/gltf-soup.js';
import { fractureCells } from '../client/extensions/rayfire/fracture.js';
import { isWatertight, facesVolume } from '../client/extensions/rayfire/geometry.js';

const dir = process.env.EE_ASSETS;
test('census: all bld_* models -> every fragment watertight + positive volume, 0 throws; p95 reported', { skip: dir ? false : 'EE_ASSETS unset' }, () => {
  const files = fs.readdirSync(dir).filter(f => f.startsWith('bld_') && f.endsWith('.gltf')).sort();
  assert.ok(files.length >= 400, `expected ~407 models, found ${files.length}`);
  let frags = 0, bad = 0, throws = 0, hull = 0; const model = [], part = [];
  for (const f of files) {
    let total = 0;
    for (const p of loadGltfParts(path.join(dir, f))) {
      const t0 = performance.now(); let cells = [];
      try { cells = fractureCells(p.triangles, { seed: 7, amount: 20 }); } catch (e) { throws++; console.log('THROW', f, e.message); }
      const dt = performance.now() - t0; total += dt; part.push(dt);
      for (const c of cells) { frags++; if (c.hullFallback) hull++; if (!isWatertight(c.faces) || !(facesVolume(c.faces) > 0)) { bad++; console.log('BAD', f, p.name); } }
    }
    model.push(total);
  }
  const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
  console.log(`# census models=${files.length} fragments=${frags} bad=${bad} throws=${throws} hullFallback=${hull} | per-model ms p50=${q(model, .5).toFixed(1)} p95=${q(model, .95).toFixed(1)} max=${Math.max(...model).toFixed(1)} | per-part ms p50=${q(part, .5).toFixed(1)} p95=${q(part, .95).toFixed(1)}`);
  assert.equal(throws, 0); assert.equal(bad, 0);
  assert.ok(frags > 5000);
});
