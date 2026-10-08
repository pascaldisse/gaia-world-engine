// r15b: lit TSL packages must track the scene's lights at runtime (DS lightmapped walls ignored light toggles).
// export once -> mutate light intensity / visible / add / remove -> pkg.live.update must report the new light-uniform values.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { exportNodeMaterial, structCache } from '../client/kernel/render-api/tsl-export.js';

const tex = () => { const t = new THREE.DataTexture(new Uint8Array(16).fill(200), 2, 2, THREE.RGBAFormat); t.needsUpdate = true; return t; };
const geo = () => { const g = new THREE.PlaneGeometry(1, 1); g.setAttribute('uv1', g.attributes.uv.clone()); return g; };
const lightmapped = () => { const m = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 1 }); m.colorNode = TSL.vec4(TSL.texture(tex(), TSL.uv(0)).rgb.mul(TSL.texture(tex(), TSL.uv(1)).rgb), 1); return m; };
const plain = () => new THREE.MeshStandardNodeMaterial({ color: 0x88aacc, roughness: 0.6 });

function rig(mk) {
  const sc = new THREE.Scene(), grp = new THREE.Group(); sc.add(grp);
  const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(3, 5, 1); grp.add(sun, sun.target);
  const pt = new THREE.PointLight(0xffaa88, 5, 40); pt.position.set(0, 2, -4); sc.add(pt);
  const hemi = new THREE.HemisphereLight(0x8899ff, 0x332211, 1); sc.add(hemi);
  const amb = new THREE.AmbientLight(0xffffff, 0.5); sc.add(amb);
  const m = mk(), o = new THREE.Mesh(geo(), m); sc.add(o); sc.updateMatrixWorld(true);
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500); cam.updateMatrixWorld();
  const pkg = exportNodeMaterial(m, { THREE, object: o, scene: sc, camera: cam });
  let f = 0; const up = () => pkg.live.update({ scene: sc, camera: cam, frameToken: ++f });
  const lightVals = () => { const out = {}; for (const { key, node } of pkg.tpl.liveUniforms) { const l = pkg.bindGroups.flatMap((g) => g.bindings).flatMap((b) => b.uniforms ?? []).find((u) => u.key === key); if (l?.source.kind === 'light') out[key] = node.value?.toArray ? node.value.toArray() : node.value; } return out; };
  return { sc, grp, sun, pt, hemi, amb, pkg, up, lightVals };
}
const colorOf = (R, node) => R.pkg.tpl.updateNodes.find((n) => n.light === node);
const flat = (ch) => JSON.stringify(ch.map((c) => c.value));

for (const [name, mk] of [['lightmapped colorNode', lightmapped], ['plain', plain]]) {
  test(`${name}: light intensity change reaches the package`, () => {
    const R = rig(mk); R.up(); assert.equal(R.up().length, 0, 'idle frame reports nothing');
    R.sun.intensity = 0.5; const ch = R.up();
    assert.ok(ch.some((c) => Array.isArray(c.value) && c.value.every((x) => Math.abs(x - 0.5) < 1e-6)), 'sun colour*intensity uniform = 0.5 ' + flat(ch));
  });

  test(`${name}: invisible lights (self or ancestor) contribute 0 and recover; intensity untouched`, () => {
    const R = rig(mk); R.up();
    const base = R.up(); assert.equal(base.length, 0);
    for (const [label, hide, show] of [['hemi', () => { R.hemi.visible = false; }, () => { R.hemi.visible = true; }], ['ambient', () => { R.amb.visible = false; }, () => { R.amb.visible = true; }], ['sun via invisible parent group', () => { R.grp.visible = false; }, () => { R.grp.visible = true; }], ['point', () => { R.pt.visible = false; }, () => { R.pt.visible = true; }]]) {
      const before = JSON.stringify([R.sun.intensity, R.hemi.intensity, R.amb.intensity, R.pt.intensity]);
      hide(); const off = R.up();
      assert.ok(off.length > 0, `${label}: hiding must change a light uniform`);
      assert.ok(off.some((c) => Array.isArray(c.value) && c.value.every((x) => x === 0)), `${label}: colour*intensity uniform -> [0,0,0] ${flat(off)}`);
      assert.equal(JSON.stringify([R.sun.intensity, R.hemi.intensity, R.amb.intensity, R.pt.intensity]), before, `${label}: user-visible intensity restored`);
      show(); const on = R.up();
      assert.ok(on.length > 0, `${label}: showing again restores the uniform`);
    }
  });
}

test('light set change: a package exported after add/remove carries the new light set (shared LightsNode re-keyed)', () => {
  structCache.lightsBuilt = 0;
  const R = rig(lightmapped); const n0 = R.pkg.tpl.updateNodes.filter((n) => n.light).length;
  const extra = new THREE.PointLight(0xffffff, 3, 10); R.sc.add(extra); R.sc.updateMatrixWorld(true);
  const m2 = lightmapped(), o2 = new THREE.Mesh(geo(), m2); R.sc.add(o2);
  const pkg2 = exportNodeMaterial(m2, { THREE, object: o2, scene: R.sc, camera: new THREE.PerspectiveCamera() });
  assert.equal(pkg2.tpl.updateNodes.filter((n) => n.light).length, n0 + 1, 'added light is in the new package');
  R.sc.remove(extra);
  const m3 = lightmapped(), o3 = new THREE.Mesh(geo(), m3); R.sc.add(o3);
  const pkg3 = exportNodeMaterial(m3, { THREE, object: o3, scene: R.sc, camera: new THREE.PerspectiveCamera() });
  assert.equal(pkg3.tpl.updateNodes.filter((n) => n.light).length, n0 + 1, 'r16-perf: light set is GROW-ONLY (pool churn must not thrash re-exports): removed light stays baked, reads 0 via the detached check');
  const live = pkg3.live.update({ object: o3, scene: R.sc, camera: new THREE.PerspectiveCamera(), time: 0 }); assert.ok(Array.isArray(live)); // detached light -> intensity 0 while its node updates
});

// adapter level: the light SET is baked into the package at export -> adding/removing a light re-exports TSL materials (once); intensity/visibility never do.
import { createSceneAdapter } from '../client/kernel/render-api/scene-adapter.js';
import { createMockBackend } from '../client/kernel/render-api/mock-backend.js';
test('adapter: light add/remove re-exports TSL materials once; intensity/visible changes do not', () => {
  const sc = new THREE.Scene(); const m = lightmapped(); sc.add(new THREE.Mesh(geo(), m));
  const be = createMockBackend(); const ad = createSceneAdapter(be, { three: THREE, exportNodeMaterial, tslOptions: { THREE, cache: 'off' } });
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100); cam.position.set(0, 0, 5); cam.updateMatrixWorld();
  const n = () => be.log.filter((c) => c[0] === 'createShaderMaterial').length;
  ad.sync(sc, cam); ad.sync(sc, cam); assert.equal(n(), 1, 'first export');
  const sun = new THREE.DirectionalLight(0xffffff, 2); sc.add(sun, sun.target);
  ad.sync(sc, cam); ad.sync(sc, cam); assert.equal(n(), 2, 'light added -> re-exported exactly once');
  sun.intensity = 0.1; sun.visible = false; ad.sync(sc, cam); ad.sync(sc, cam); assert.equal(n(), 2, 'intensity/visible never re-export');
  sc.remove(sun); ad.sync(sc, cam); ad.sync(sc, cam); assert.equal(n(), 2, 'r16-perf: light removed -> NO re-export (grow-only set; detached light reads 0)'); sc.add(sun, sun.target); ad.sync(sc, cam); ad.sync(sc, cam); assert.equal(n(), 2, 'same light object re-added (pool reassign) -> NO re-export'); sc.add(new THREE.PointLight(0xffffff, 1, 5)); ad.sync(sc, cam); ad.sync(sc, cam); assert.equal(n(), 3, 'never-seen light -> re-exported once');
});

// r16-perf: per-fragment light cull (If around every light after the first) must keep ONE accumulator init (a re-zeroing branch wiped earlier lights) and branch every later point light.
test('light cull: accumulators initialised once outside the branches; later point lights branched', () => {
  const sc = new THREE.Scene(); for (let i = 0; i < 4; i++) { const p = new THREE.PointLight(0xffaa88, 5, 40); p.position.set(i, 2, 0); sc.add(p); }
  const m = lightmapped(), o = new THREE.Mesh(geo(), m); sc.add(o); sc.updateMatrixWorld(true);
  const cam = new THREE.PerspectiveCamera(); cam.updateMatrixWorld();
  const f = exportNodeMaterial(m, { THREE, object: o, scene: sc, camera: cam }).fragment;
  assert.equal((f.match(/\n\tdirectDiffuse = vec3<f32>\( 0\.0, 0\.0, 0\.0 \);/g) ?? []).length, 1, 'directDiffuse zeroed exactly once');
  assert.equal((f.match(/\n\tdirectSpecular = vec3<f32>\( 0\.0, 0\.0, 0\.0 \);/g) ?? []).length, 1, 'directSpecular zeroed exactly once');
  assert.equal((f.match(/\.x \+ render\.nodeUniform\d+\.y \) \+ render\.nodeUniform\d+\.z \) > 0\.0/g) ?? []).length, 3, '3 of 4 point lights uniform-gated (first runs in the outer scope)');
});
