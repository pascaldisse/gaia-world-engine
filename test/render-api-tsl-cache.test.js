// r10-3: structural export cache — same node graph, different uniforms/textures => 1 builder run, per-material bindings correct.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { texture, uniform, float, vec3, Fn } from 'three/tsl';
import { exportNodeMaterial, structCache } from '../client/kernel/render-api/tsl-export.js';
const tex = (v) => { const t = new THREE.DataTexture(new Uint8Array(16).fill(v), 2, 2, THREE.RGBAFormat); t.needsUpdate = true; return t; };
const mk = (c, t, f, op = 1) => { const m = new THREE.MeshBasicNodeMaterial(); m.opacity = op; m.transparent = true; m.colorNode = texture(t).rgb.mul(uniform(new THREE.Color(c))).add(float(f)); return m; };
const reset = () => { for (const k of ['hits', 'misses', 'uncacheable', 'rebindFail', 'mismatch', 'layoutMismatch', 'valueMismatch', 'verified']) structCache[k] = 0; structCache.map.clear(); structCache.log.length = 0; structCache.reasons = {}; };
// builder-side singleton uniforms (materialOpacity & co) need a 2nd build to be PROVEN shared before the key rebinds -> warm with 2 builds
const warm = (f = mk) => { exportNodeMaterial(f(0x111111, tex(1), 1), { THREE }); exportNodeMaterial(f(0x222222, tex(2), 1), { THREE }); for (const k of ['hits', 'misses']) structCache[k] = 0; };
const uni = (p) => p.bindGroups.flatMap((g) => g.bindings).filter((b) => b.uniforms).flatMap((b) => b.uniforms);
const tb = (p) => p.bindGroups.flatMap((g) => g.bindings).filter((b) => b.textureUuid);
test('same graph, different uniforms/textures -> 1 export, correct bindings', () => {
  reset(); warm();
  const t1 = tex(10), t2 = tex(200), a = mk(0xff0000, t1, 1, 0.5), b = mk(0x00ff00, t2, 1, 0.25);
  const pa = exportNodeMaterial(a, { THREE }), pb = exportNodeMaterial(b, { THREE });
  assert.equal(structCache.misses, 0); assert.equal(structCache.hits, 2, JSON.stringify(structCache.reasons) + structCache.log.join('|'));
  assert.equal(pa.fragment, pb.fragment);
  assert.equal(tb(pa)[0].textureUuid, t1.uuid); assert.equal(tb(pb)[0].textureUuid, t2.uuid);
  assert.equal(pb.textureSources[t2.uuid], t2); assert.equal(pb.textureSources[t1.uuid], undefined);
  const full = exportNodeMaterial(mk(0x00ff00, t2, 1, 0.25), { THREE, cache: 'off' }); // reference build
  const vals = (p) => uni(p).map((u) => (u.source?.kind === 'material' ? 'M' : JSON.stringify(u.value))).join(); // material-sourced uniforms (builder singletons) ship a stale value until live.update; compare the rest (robust to global singleton state left by other tests)
  // shared builder singleton (materialOpacity) ships the stale template value; the FIRST live.update must correct it to this material's 0.25
  const ch = pb.live.update({}); assert.ok(ch.some((c) => c.value === 0.25), JSON.stringify(ch));
  assert.equal(vals(pb), vals(full));
  // own live closure: mutate b's uniform, a must not see it
  assert.notDeepEqual(pa.live.keys, pb.live.keys);
  assert.ok(pa.live.update({}).some((c) => c.value === 0.5)); assert.deepEqual(pb.live.update({}), []);
});
test('verify mode: rebound == fully built', () => {
  reset(); warm();
  for (const [c, f] of [[0xff0000, 1], [0x00ff00, 1], [0x0000ff, 1]]) exportNodeMaterial(mk(c, tex(c % 255), f), { THREE, cache: 'verify' });
  assert.equal(structCache.mismatch, 0, structCache.log.join('|')); assert.equal(structCache.verified, 3);
});
test('different constant => different key (own build)', () => {
  reset();
  exportNodeMaterial(mk(0xff0000, tex(1), 1), { THREE }); exportNodeMaterial(mk(0xff0000, tex(1), 2), { THREE });
  assert.equal(structCache.misses, 2); assert.equal(structCache.hits, 0);
});
// the live closure of a rebound material tracks ITS OWN uniform node
test('live closure per material', () => {
  reset(); warm((c) => { const x = new THREE.MeshBasicNodeMaterial(); x.colorNode = uniform(new THREE.Color(c)).mul(float(2)); return x; });
  const u1 = uniform(new THREE.Color(1, 0, 0)), u2 = uniform(new THREE.Color(0, 1, 0));
  const m = (u) => { const x = new THREE.MeshBasicNodeMaterial(); x.colorNode = u.mul(float(2)); return x; };
  const p1 = exportNodeMaterial(m(u1), { THREE }), p2 = exportNodeMaterial(m(u2), { THREE });
  assert.equal(structCache.hits, 2);
  u2.value.set(0, 0, 1);
  assert.deepEqual(p1.live.update({}), []);
  const ch = p2.live.update({}); assert.equal(ch.length, 1); assert.deepEqual(ch[0].value, [0, 0, 1]); assert.equal(ch[0].key, u2.uuid);
});
// material-slot textures (material.map): builder creates the TextureNode itself -> rebind to THIS material's map + texture matrix
test('material.map slot rebinds + verify equal', () => {
  reset();
  const mkS = (c, t, rep) => { const m = new THREE.MeshStandardNodeMaterial(); m.map = t; t.repeat.set(rep, rep); t.updateMatrix(); m.color.set(c); m.roughness = 0.3 + rep / 10; m.colorNode = null; m.emissiveNode = uniform(new THREE.Color(c)); return m; };
  for (let i = 0; i < 4; i++) exportNodeMaterial(mkS(0x101010 * (i + 1), tex(i * 40), i + 1), { THREE, cache: 'verify' });
  assert.equal(structCache.mismatch, 0, structCache.log.join(' | ')); assert.ok(structCache.verified >= 2, JSON.stringify(structCache.reasons) + structCache.log.join('|'));
  const t5 = tex(99); t5.repeat.set(7, 7); t5.updateMatrix(); const p = exportNodeMaterial(mkS(0xabcdef, t5, 7), { THREE });
  assert.ok(structCache.hits >= 3);
  assert.equal(p.bindGroups.flatMap((g) => g.bindings).find((b) => b.textureUuid).textureUuid, t5.uuid);
  // r10-6: the texture-matrix uniform is a setup-created node now (rebound by walk slot); like a full build it ships the pre-update value, the first live.update delivers THIS texture's matrix
const ch = p.live.update({}); assert.ok(ch.some((c) => Array.isArray(c.value) && c.value.length === 9 && c.value[0] === 7), JSON.stringify(ch));
});
// r10-6: key computed at setup->analyze on the builder's own post-setup graph: setup-created uniforms + custom subclasses rebind by slot; hit skips analyze+generate
import { bufferAttribute } from 'three/tsl';
class SetupMat extends THREE.MeshBasicNodeMaterial { constructor(c) { super(); this.tint = c; } setupDiffuseColor(builder) { this.colorNode = uniform(new THREE.Color(this.tint)).mul(float(2)); super.setupDiffuseColor(builder); } }
const live = (p) => new Map(p.live.update({}).map((c) => [c.key, c.value]));
test('custom subclass w/ setup-created uniform: hit, rebinds to OWN uniform, == full build', () => {
reset(); warm((c) => new SetupMat(c));
const a = new SetupMat(0xff0000), b = new SetupMat(0x0000ff);
const pa = exportNodeMaterial(a, { THREE }), pb = exportNodeMaterial(b, { THREE });
assert.equal(structCache.misses, 0, JSON.stringify(structCache.reasons)); assert.equal(structCache.hits, 2);
const full = exportNodeMaterial(new SetupMat(0x0000ff), { THREE, cache: 'off' });
assert.equal(pb.fragment, full.fragment); assert.equal(pb.vertex, full.vertex);
const cu = (p) => uni(p).filter((u) => u.source?.kind === 'uniform' && u.value?.length === 3).map((u) => u.value);
assert.deepEqual(cu(pb), cu(full)); assert.notDeepEqual(cu(pa), cu(pb));
assert.notDeepEqual(pa.live.keys, pb.live.keys);
// own live closure per material: mutating b's setup-created uniform (reached through its colorNode) shows ONLY in pb
const find = (n) => { if (n.isUniformNode) return n; for (const { childNode } of THREE.NodeUtils.getNodeChildren(n)) { const r = find(childNode); if (r) return r; } return null; }; const ub = find(b.colorNode); assert.ok(ub?.isUniformNode);
ub.value.set(0, 1, 0); assert.deepEqual(pa.live.update({}).filter((c) => c.key === ub.uuid), []); assert.ok(pb.live.update({}).some((c) => c.key === ub.uuid && c.value[1] === 1));
});
test('custom subclass verify == 0 mismatches', () => {
reset(); for (let i = 0; i < 4; i++) exportNodeMaterial(new SetupMat(0x101010 * (i + 1)), { THREE, cache: 'verify' });
assert.equal(structCache.mismatch, 0, structCache.log.join('|')); assert.ok(structCache.verified >= 2, JSON.stringify(structCache.reasons));
});
test('node-held attribute (bufferAttribute node) rebinds to OWN attribute', () => {
reset();
const mkA = (n) => { const at = new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3); const m = new THREE.MeshBasicNodeMaterial(); m.colorNode = bufferAttribute(at, 'vec3'); return [m, at]; };
for (let i = 0; i < 2; i++) exportNodeMaterial(mkA(4)[0], { THREE });
const [m3, at3] = mkA(8); const p = exportNodeMaterial(m3, { THREE }); const full = exportNodeMaterial(mkA(8)[0], { THREE, cache: 'off' });
assert.ok(structCache.hits >= 1, JSON.stringify(structCache.reasons) + structCache.log.join('|'));
assert.equal(p.fragment, full.fragment);
assert.deepEqual(Object.values(p.attributeSources), [at3]); assert.equal(p.attributes.find((x) => x.source === 'node').key, Object.keys(p.attributeSources)[0]);
});
test('hit leaves material clean: fresh full build afterwards unchanged', () => {
reset(); warm((c) => new SetupMat(c));
const m = new SetupMat(0x123456), v = m.version; const p = exportNodeMaterial(m, { THREE });
assert.equal(structCache.hits, 1); assert.equal(m.version, v);
const again = exportNodeMaterial(m, { THREE, cache: 'off' }); assert.equal(again.fragment, p.fragment);
});
// r10-7: never-repeating keys (per-mesh splits) must not pile up retained node graphs (Burnout: V8 OOM ~4 GB at ~900 exports with the cache on).
test('template retention is bounded (FIFO) when every key is unique', () => {
  reset(); const prev = structCache.maxTemplates; structCache.maxTemplates = 4; structCache.evicted = 0;
  try {
    for (let i = 0; i < 12; i++) { const m = mk(0x111111, tex(i), 1); m.colorNode = m.colorNode.add(float(i)).mul(vec3(...Array.from({ length: i + 1 }, () => 1)).length()); exportNodeMaterial(m, { THREE }); } // i-dependent graph shape => unique keys
    assert.ok(structCache.map.size <= 4, 'map size ' + structCache.map.size);
    assert.ok(structCache.evicted >= 1 || structCache.map.size < 4, 'evicted ' + structCache.evicted + ' size ' + structCache.map.size + ' misses ' + structCache.misses);
  } finally { structCache.maxTemplates = prev; }
});
test('retainTemplate: FIFO eviction + hit refreshes recency', async () => {
  const { retainTemplate } = await import('../client/kernel/render-api/tsl-export.js');
  const C = { map: new Map(), maxTemplates: 2, evicted: 0 };
  retainTemplate(C, 'a', 1); retainTemplate(C, 'b', 2); retainTemplate(C, 'a', 1); retainTemplate(C, 'c', 3);
  assert.deepEqual([...C.map.keys()], ['a', 'c']); assert.equal(C.evicted, 1);
});

// r10-8: Burnout-like -- every material builds its OWN closure of the same Fn source (fresh jsFunc identity) -> must key identically (was 1 key / material).
const mkFn = (c, t, f, op = 1) => { const m = new THREE.MeshBasicNodeMaterial(); m.opacity = op; m.transparent = true; const k = uniform(new THREE.Color(c)); const tx = texture(t); const body = Fn(() => tx.rgb.mul(k).add(float(f))); m.colorNode = body(); return m; };
test('r10-8: per-material Fn closures of equal source -> 1 build', () => {
  reset(); warm(mkFn);
  const ps = [0xff0000, 0x00ff00, 0x0000ff, 0x123456].map((c, i) => exportNodeMaterial(mkFn(c, tex(i * 50), 1, 0.2 + i / 10), { THREE }));
  assert.equal(structCache.misses, 0, JSON.stringify(structCache.reasons) + structCache.log.join('|')); assert.equal(structCache.hits, 4);
  assert.ok(ps.every((p) => p.fragment === ps[0].fragment));
});
test('r10-8: verify compares WGSL + layout, uniform VALUES checked after first update (0 mismatches of every kind)', () => {
  reset(); warm(mkFn);
  for (let i = 0; i < 4; i++) exportNodeMaterial(mkFn(0x101010 * (i + 1), tex(i * 40), 1, 0.1 * (i + 1)), { THREE, cache: 'verify' });
  assert.equal(structCache.mismatch + structCache.layoutMismatch + structCache.valueMismatch, 0, structCache.log.join('|')); assert.equal(structCache.verified, 4, JSON.stringify({h: structCache.hits, m: structCache.misses, r: structCache.reasons, rf: structCache.rebindFail}) + structCache.log.join('|'));
});

// r10-9: anything that changes WGSL must change the key (merge guard for r10-shadow: receive flags / shadowNode per material). Same material, receive=true vs false => 2 keys, each = its own full build.
test('r10-9: receiveShadow true vs false (shadow-casting light) -> 2 keys, WGSL equals a cache-off build', () => {
  reset();
  const scene = new THREE.Scene(); const L = new THREE.DirectionalLight(0xffffff, 1); L.castShadow = true; scene.add(L, L.target);
  const mkS = (rcv) => { const m = new THREE.MeshStandardNodeMaterial(); m.colorNode = float(0.5).mul(vec3(1, 0.5, 0.25)); const o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m); o.receiveShadow = rcv; scene.add(o); return { m, o }; };
  const run = (rcv, cache) => { const { m, o } = mkS(rcv); return exportNodeMaterial(m, { THREE, object: o, scene, cache }); };
  run(true); run(true); run(false); run(false); // 2 builds each: singletons proven shared
  const keys = structCache.map.size; const on = [run(true), run(false)], off = [run(true, 'off'), run(false, 'off')];
  assert.equal(on[0].fragment, off[0].fragment, 'receive=true WGSL = full build'); assert.equal(on[1].fragment, off[1].fragment, 'receive=false WGSL = full build');
  // merge r10-sync+r10-shadow: the core-shadow hook is set up on the SHARED LightsNode by the first receiver build and cached there -> that first build's graph differs once (3 keys = one extra miss, never a merge). Correctness = WGSL equality above + 0 mismatches below.
  assert.ok(keys >= 2, 'receive flag changes the post-setup graph -> keys never merge (' + keys + ')'); // (three's headless WGSL happens to be identical for both: shadows are not exported -- keys still split, never merge)
  assert.equal(structCache.mismatch + structCache.rebindFail, 0, structCache.log.join('|'));
  console.log('receive keys', keys, 'wgslDiffers', off[0].fragment !== off[1].fragment);
});

// r10-9: fused key walker == reference walker (same key string + node order) over varied graphs.
test('r10-9: fused builderWalk emits byte-identical keys to the reference walker', () => {
  reset(); structCache.walkCheck = true; structCache.walkChecked = 0; structCache.walkMismatch = 0;
  try {
    const scene = new THREE.Scene(); scene.add(new THREE.DirectionalLight(0xffffff, 1), new THREE.PointLight(0xffffff, 2));
    for (let i = 0; i < 3; i++) { exportNodeMaterial(mk(0x111111 * (i + 1), tex(i), i), { THREE }); exportNodeMaterial(mkFn(0x222222, tex(i), i), { THREE, scene }); }
    const st = new THREE.MeshStandardNodeMaterial(); st.map = tex(7); st.colorNode = vec3(0.2, 0.4, 0.6).mul(uniform(0.5)); exportNodeMaterial(st, { THREE, scene }); exportNodeMaterial(st, { THREE, scene });
    assert.ok(structCache.walkChecked >= 8, 'walks checked ' + structCache.walkChecked); assert.equal(structCache.walkMismatch, 0, structCache.log.join('|'));
  } finally { structCache.walkCheck = false; }
});
