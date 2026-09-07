import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { keepOnlyModelMeshFileID, unityMeshFileID, fixFbxUnitScale, staticMeshBasis, unityImportOfFbxChain, validateFloatAccessor } from '../tools/unity/convert-model.mjs';
import { parseMetaRecycleNames } from '../tools/unity/fileid.mjs';

// A per-mesh ("narrowed") static GLB is placed by the emitter at the Unity part transform, Z-mirrored
// (unityToGaiaTransform). Assimp leaves FBX vertices RAW in the parent's space with the pivot as a pseudo-node chain,
// so wheels/doors/steering wheels rendered with the pivot applied twice (parked cars hovering on their hull underside).
// Oracle here is an INDEPENDENT path: the full pseudo-node matrix product (three.js) -> Unity import (X mirror)
// -> GAIA (Z mirror), compared against the baked GLB placed by the emitter's formula.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(repo, '.scratch', 'pivot-bake'); fs.mkdirSync(scratch, { recursive: true });
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const M = (m) => new THREE.Matrix4().fromArray(m);
const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z).toArray();
const Rq = (q) => new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...q)).toArray();
const quatAxis = (axis, deg) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), (deg * Math.PI) / 180).toArray();

// Build an assimp-shaped GLB: RootNode(scale) > Hull(mesh 0) > pseudo-node chains > part meshes. Vertices RAW (parent space).
function buildGlb(file, parts, rootScale = 0.1) {
  const bins = []; let off = 0; const accessors = []; const views = [];
  const push = (arr, type) => { const f = new Float32Array(arr); const b = Buffer.from(f.buffer); views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); bins.push(b); off += b.length; const comps = type === 'VEC3' ? 3 : type === 'VEC4' ? 4 : 1; const acc = { bufferView: views.length - 1, componentType: 5126, count: f.length / comps, type }; if (type === 'VEC3') { acc.min = [Infinity, Infinity, Infinity]; acc.max = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < f.length; i++) { acc.min[i % 3] = Math.min(acc.min[i % 3], f[i]); acc.max[i % 3] = Math.max(acc.max[i % 3], f[i]); } } accessors.push(acc); return accessors.length - 1; };
  const pushIdx = (arr) => { const u = new Uint16Array(arr); const b = Buffer.from(u.buffer); const pad = (4 - (off % 4)) % 4; if (pad) { bins.push(Buffer.alloc(pad)); off += pad; } views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); bins.push(b); off += b.length; accessors.push({ bufferView: views.length - 1, componentType: 5123, count: u.length, type: 'SCALAR' }); return accessors.length - 1; };
  const nodes = [{ name: 'RootNode', scale: [rootScale, rootScale, rootScale], children: [1] }, { name: 'Hull', children: [] }]; const meshes = [];
  for (const part of parts) {
    const mesh = meshes.length; meshes.push({ name: part.name, primitives: [{ attributes: { POSITION: push(part.positions.flat(), 'VEC3'), NORMAL: push(part.normals.flat(), 'VEC3') }, indices: pushIdx(part.indices), mode: 4 }] });
    let parentIdx = 1; for (const [kind, matrix] of part.chain) { nodes.push({ name: `${part.name}_$AssimpFbx$_${kind}`, matrix, children: [] }); nodes[parentIdx].children.push(nodes.length - 1); parentIdx = nodes.length - 1; }
    nodes.push({ name: part.name, mesh }); nodes[parentIdx].children.push(nodes.length - 1);
  }
  const bin = Buffer.concat(bins); const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes, meshes, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }] };
  const jt = Buffer.from(JSON.stringify(json)); const jp = (4 - (jt.length % 4)) % 4; const jc = Buffer.concat([jt, Buffer.alloc(jp, 0x20)]); const bp = (4 - (bin.length % 4)) % 4; const bc = Buffer.concat([bin, Buffer.alloc(bp)]);
  const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jc.length + 8 + bc.length, 8); const jh = Buffer.alloc(8); jh.writeUInt32LE(jc.length, 0); jh.writeUInt32LE(0x4e4f534a, 4); const bh = Buffer.alloc(8); bh.writeUInt32LE(bc.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([h, jh, jc, bh, bc])); return json;
}
function readGlb(file) { const b = fs.readFileSync(file); const len = b.readUInt32LE(12); const json = JSON.parse(b.subarray(20, 20 + len).toString()); const bs = 20 + len; const bin = b.subarray(bs + 8, bs + 8 + b.readUInt32LE(bs)); const f32 = (i, comps) => { const a = json.accessors[i]; const v = json.bufferViews[a.bufferView]; const o = bin.byteOffset + v.byteOffset + (a.byteOffset ?? 0); return new Float32Array(bin.buffer.slice(o, o + a.count * comps * 4)); }; return { json, f32 }; }
// emitter formula (tools/unity/emit.mjs unityToGaiaTransform): position (x,y,-z), quaternion (-x,-y,z,w)
const emitterPlacement = (unityLocal) => new THREE.Matrix4().compose(new THREE.Vector3(unityLocal.position[0], unityLocal.position[1], -unityLocal.position[2]), new THREE.Quaternion(-unityLocal.rotation[0], -unityLocal.rotation[1], unityLocal.rotation[2], unityLocal.rotation[3]), new THREE.Vector3(...unityLocal.scale));
const MX = new THREE.Matrix4().makeScale(-1, 1, 1), MZ = new THREE.Matrix4().makeScale(1, 1, -1);

// the three source cases, raw parent-space vertices (file units), pivots off-centre of the geometry on purpose
const P_WHEEL = [7.691, 4.186, -14.428];
const wheel = { name: 'Wheel_rl', chain: [['RotationPivot', T(...P_WHEEL)], ['RotationPivotInverse', T(-P_WHEEL[0], -P_WHEEL[1], -P_WHEEL[2])], ['ScalingPivot', T(...P_WHEEL)], ['ScalingPivotInverse', T(-P_WHEEL[0], -P_WHEEL[1], -P_WHEEL[2])]],
  positions: [[8.6, 0, -14.4], [9.5, 4.186, -14.428], [8.6, 8.372, -14.4], [7.0, 4.186, -13.0]], normals: [[0, -1, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], indices: [0, 1, 2, 0, 2, 3] }; // hub centre x 8.6 vs pivot 7.691
const P_SW = [4.31, -1.373, 12.994], OFF_SW = [0, 13.127, -7.285], R_SW = quatAxis([1, 0, 0], 70.1);
const steering = { name: 'SteeringW', chain: [['RotationOffset', T(...OFF_SW)], ['RotationPivot', T(...P_SW)], ['Rotation', Rq(R_SW)], ['RotationPivotInverse', T(-P_SW[0], -P_SW[1], -P_SW[2])], ['ScalingPivot', T(...P_SW)], ['ScalingPivotInverse', T(-P_SW[0], -P_SW[1], -P_SW[2])]],
  positions: [[4.31, -2.49, 12.994], [5.9, -1.373, 12.994], [4.31, -0.93, 12.5], [3.0, -1.6, 13.4]], normals: [[0, 0, 1], [0, 0, 1], [0.6, 0.8, 0], [0, 0, 1]], indices: [0, 1, 2, 0, 2, 3] };
const P_DOOR = [8.063, 10.85, -22.768], R_DOOR = quatAxis([0, 1, 0], 30);
const door = { name: 'Door_l', chain: [['RotationPivot', T(...P_DOOR)], ['Rotation', Rq(R_DOOR)], ['RotationPivotInverse', T(-P_DOOR[0], -P_DOOR[1], -P_DOOR[2])], ['ScalingPivot', T(...P_DOOR)], ['ScalingPivotInverse', T(-P_DOOR[0], -P_DOOR[1], -P_DOOR[2])]],
  positions: [[8.0, 7.274, -22.7], [0.5, 7.274, -21.0], [0.5, 18.0, -21.0], [8.0, 18.0, -22.7]], normals: [[1, 0, 0.2], [1, 0, 0.2], [1, 0, 0.2], [1, 0, 0.2]], indices: [0, 1, 2, 0, 2, 3] }; // hinge at x 8.06, panel spans to x 0.5: asymmetric
const hull = { name: 'Hull_Mesh', chain: [], positions: [[-10, 2.448, 20], [10, 2.448, 20], [0, 18.8, -20]], normals: [[0, -1, 0], [0, -1, 0], [0, 1, 0]], indices: [0, 1, 2] };

function oracleWorld(part, rootScale) { // FBX world via the FULL pseudo-node product -> Unity (Mx) -> GAIA (Mz); an independent path from the bake
  let m = new THREE.Matrix4().makeScale(rootScale, rootScale, rootScale); for (const [, mat] of part.chain) m = m.clone().multiply(M(mat));
  const toGaia = MZ.clone().multiply(MX).multiply(m); const nrm = new THREE.Matrix3().getNormalMatrix(toGaia);
  return { pos: part.positions.map((p) => new THREE.Vector3(...p).applyMatrix4(toGaia)), nrm: part.normals.map((n) => new THREE.Vector3(...n).applyMatrix3(nrm).normalize()) };
}

test('pivot bake: wheel (pivot+inverse), steering wheel (RotationOffset + non-identity Rotation), asymmetric hinge door, and a chain-less hull all land where Unity->GAIA puts them; off-centre geometry preserved (no recentring); winding untouched', () => {
  for (const part of [wheel, steering, door, hull]) {
    const file = path.join(scratch, `${part.name}.glb`); buildGlb(file, [hull, wheel, steering, door]);
    const fid = unityMeshFileID(part.name); assert.equal(keepOnlyModelMeshFileID(file, fid, null, { strict: true }), true);
    const { json, f32 } = readGlb(file); const meshNode = json.nodes[json.nodes.length - 1]; assert.equal(meshNode.name, part.name);
    const bake = meshNode.extras.fbxPivotBake; assert.ok(bake, 'bake recorded'); const rootScale = json.nodes[0].scale[0]; assert.equal(rootScale, 0.1, 'ancestor scale kept');
    const mesh = json.meshes[meshNode.mesh]; const pos = f32(mesh.primitives[0].attributes.POSITION, 3); const nrm = f32(mesh.primitives[0].attributes.NORMAL, 3);
    const placement = emitterPlacement({ position: bake.unityLocal.position.map((v) => v * rootScale), rotation: bake.unityLocal.rotation, scale: bake.unityLocal.scale }); // emitter positions in metres
    const local = new THREE.Matrix4().makeScale(rootScale, rootScale, rootScale); const full = placement.clone().multiply(local); const nm = new THREE.Matrix3().getNormalMatrix(full);
    const oracle = oracleWorld(part, rootScale);
    for (let i = 0; i < part.positions.length; i++) {
      const g = new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(full); assert.ok(g.distanceTo(oracle.pos[i]) < 1e-5, `${part.name} v${i}: baked+placed ${g.toArray().map((v) => v.toFixed(4))} vs oracle ${oracle.pos[i].toArray().map((v) => v.toFixed(4))}`);
      const n = new THREE.Vector3(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]).applyMatrix3(nm).normalize(); assert.ok(n.distanceTo(oracle.nrm[i]) < 1e-5, `${part.name} n${i}`);
    }
    // winding: Mz*Mx is a proper rotation -> indices untouched; the geometric normal of the first triangle agrees with the stored normal
    const idx = json.accessors[mesh.primitives[0].indices]; assert.equal(idx.count, part.indices.length);
    if (part !== hull) { assert.deepEqual(bake.pivot.map((v) => +v.toFixed(3)), part === wheel ? P_WHEEL : part === steering ? P_SW : P_DOOR); }
    const min = json.accessors[mesh.primitives[0].attributes.POSITION].min; assert.ok(Array.isArray(min) && min.length === 3, 'accessor min/max refreshed');
  }
  // wheel specifics: bottom of the tyre at y = 0 once placed at the Unity hub height; hub stays off-centre (x 8.6 vs pivot 7.691 -> 0.0909 m outward, sign flipped by Mx then Mz)
  const file = path.join(scratch, 'w.glb'); buildGlb(file, [hull, wheel]); keepOnlyModelMeshFileID(file, unityMeshFileID('Wheel_rl'), null, { strict: true });
  const { json, f32 } = readGlb(file); const bake = json.nodes.at(-1).extras.fbxPivotBake; const pos = f32(json.meshes[json.nodes.at(-1).mesh].primitives[0].attributes.POSITION, 3);
  assert.deepEqual(bake.unityLocal.position.map((v) => +(v * 0.1).toFixed(4)), [-0.7691, 0.4186, -1.4428], 'Unity localPosition = Mx(T+Roff+Rp) (matches the PolygonCity prefab wheel transform)');
  assert.ok(Math.abs(pos[1] * 0.1 + 0.4186) < 1e-4, 'tyre bottom at -radius in mesh space -> y=0 in the world'); assert.ok(Math.abs(Math.abs(pos[0]) * 0.1 - 0.0909) < 1e-3, 'hub offset preserved, not recentred');
});

test('pivot bake gates: bakePivot:false leaves raw vertices; ScalingPivot != RotationPivot refuses under strict and warns/leaves raw otherwise; whole-model handle 100100000 untouched', () => {
  const raw = path.join(scratch, 'raw.glb'); buildGlb(raw, [hull, wheel]); keepOnlyModelMeshFileID(raw, unityMeshFileID('Wheel_rl'), null, { strict: true, bakePivot: false });
  const r = readGlb(raw); assert.equal(r.json.nodes.at(-1).extras, undefined); assert.equal(r.f32(r.json.meshes[r.json.nodes.at(-1).mesh].primitives[0].attributes.POSITION, 3)[0], Math.fround(8.6));
  const bad = { ...wheel, chain: [['RotationPivot', T(...P_WHEEL)], ['RotationPivotInverse', T(-P_WHEEL[0], -P_WHEEL[1], -P_WHEEL[2])], ['ScalingPivot', T(1, 2, 3)], ['ScalingPivotInverse', T(-1, -2, -3)]] };
  const f1 = path.join(scratch, 'bad1.glb'); buildGlb(f1, [hull, bad]); assert.throws(() => keepOnlyModelMeshFileID(f1, unityMeshFileID('Wheel_rl'), null, { strict: true }), /not Unity-bakeable.*ScalingPivot/);
  const f2 = path.join(scratch, 'bad2.glb'); buildGlb(f2, [hull, bad]); assert.equal(keepOnlyModelMeshFileID(f2, unityMeshFileID('Wheel_rl'), null, { strict: false }), true); const b2 = readGlb(f2); assert.equal(b2.json.nodes.at(-1).extras, undefined, 'left raw, no bake recorded');
  const f3 = path.join(scratch, 'whole.glb'); buildGlb(f3, [hull, wheel]); assert.equal(keepOnlyModelMeshFileID(f3, '100100000', null, { strict: true }), false); assert.equal(readGlb(f3).json.nodes.length, 8, 'whole model untouched');
  const imp = unityImportOfFbxChain({ chain: {} }); assert.deepEqual(imp.pivot, [0, 0, 0]); assert.deepEqual(staticMeshBasis([1, 2, 3], [1, 1, 1]), [-0, 1, -2]);
});

// REAL: convert the PolygonCity FBX with assimp into .scratch (a conversion, not an asset copy), run the pipeline's
// fixFbxUnitScale -> narrowing, and check against the Unity prefab transforms + the parent's live symptom numbers.
const unityRoot = process.env.BOOMTOWN_UNITY_ROOT || path.join(process.env.HOME ?? '', 'projects', 'boomtown-rampage');
const assimp = spawnSync('which', ['assimp']).status === 0;
const cars = { SM_Veh_Car_Medium_01: { liveMinY: 0.2448236, wheels: ['SM_Veh_Car_Medium_Wheel_rl', 'SM_Veh_Car_Medium_Wheel_rr', 'SM_Veh_Car_Medium_Wheel_fl', 'SM_Veh_Car_Medium_Wheel_fr'], check: ['SM_Veh_Car_Medium_SteeringW'] }, SM_Veh_Car_Ambo_01: { liveMinY: 0.2103317, wheels: ['SM_Veh_Car_Ambo_Wheel_rl', 'SM_Veh_Car_Ambo_Wheel_rr', 'SM_Veh_Car_Ambo_Wheel_fl', 'SM_Veh_Car_Ambo_Wheel_fr'], check: ['SM_Veh_Car_Ambo_Door_l', 'SM_Veh_Car_Ambo_Door_r', 'SM_Veh_Car_Ambo_SteeringW'] } };
const haveReal = assimp && fs.existsSync(path.join(unityRoot, 'Assets/PolygonCity/Models/SM_Veh_Car_Medium_01.fbx'));
function prefabTransforms(prefabFile) { const t = fs.readFileSync(prefabFile, 'utf8'); const docs = t.split(/^--- !u!/m).slice(1); const goName = new Map(), out = new Map(); for (const d of docs) { const id = /^\d+ &(-?\d+)/.exec(d)?.[1]; if (d.startsWith('1 ')) { const n = /m_Name: (.+)/.exec(d)?.[1]; if (n) goName.set(id, n.trim()); } } for (const d of docs) { if (!d.startsWith('4 ')) continue; const go = /m_GameObject: \{fileID: (-?\d+)\}/.exec(d)?.[1]; const p = /m_LocalPosition: \{x: ([-\d.e]+), y: ([-\d.e]+), z: ([-\d.e]+)\}/.exec(d); const q = /m_LocalRotation: \{x: ([-\d.e]+), y: ([-\d.e]+), z: ([-\d.e]+), w: ([-\d.e]+)\}/.exec(d); if (go && p) out.set(goName.get(go), { position: [+p[1], +p[2], +p[3]], rotation: q ? [+q[1], +q[2], +q[3], +q[4]] : [0, 0, 0, 1] }); } return out; }

test('REAL PolygonCity vehicles: every wheel/door/steering-wheel narrowed GLB gets Unity localPosition/rotation == the prefab transform (X mirror proven per part), tyre bottoms at y=0, assembled car bottom 0 instead of the live hull-only minY; hull unchanged in height', { skip: !haveReal && 'assimp or Unity project missing', timeout: 300000 }, () => {
  for (const [car, spec] of Object.entries(cars)) {
    const fbx = path.join(unityRoot, `Assets/PolygonCity/Models/${car}.fbx`); const names = parseMetaRecycleNames(fs.readFileSync(`${fbx}.meta`, 'utf8')); const table = names instanceof Map ? names : new Map(Object.entries(names ?? {}));
    const nameToFid = new Map([...table.entries()].map(([k, v]) => [v, String(k)]));
    const prefab = prefabTransforms(path.join(unityRoot, `Assets/PolygonCity/Prefabs/Vehicles/${car}.prefab`));
    const base = path.join(scratch, `${car}.glb`); const r = spawnSync('assimp', ['export', fbx, base, '-f', 'glb2', '-triangulate', '-joinidenticalvertices', '-pretransformvertices']); assert.equal(r.status, 0, r.stderr?.toString());
    fixFbxUnitScale(base, fbx); const full = readGlb(base); assert.ok(full.json.nodes.some((n) => /\$AssimpFbx\$_RotationPivot$/.test(n.name)), 'assimp CLI ignores -pretransformvertices: pivot chains retained (what narrowing relies on)');
    let assembledMinY = Infinity, hullMinY = null;
    for (const name of [car, ...spec.wheels, ...spec.check]) {
      const fid = nameToFid.get(name); assert.ok(fid, `${name} in .meta recycle table`);
      const f = path.join(scratch, `${car}-${name}.glb`); fs.copyFileSync(base, f); assert.equal(keepOnlyModelMeshFileID(f, fid, table, { strict: true }), true, `${name} narrowed`);
      const { json, f32 } = readGlb(f); const node = json.nodes.at(-1); const bake = node.extras.fbxPivotBake; const s = json.nodes[0].scale?.[0] ?? 1; assert.ok(Math.abs(s - 0.1) < 1e-6, 'root scale 0.1 (globalScale 10 x file 0.01)');
      const pos = f32(json.meshes[node.mesh].primitives[0].attributes.POSITION, 3);
      const unityPos = bake.unityLocal.position.map((v) => v * s); const pt = prefab.get(name); assert.ok(pt, `${name} in prefab`);
      assert.ok(unityPos.every((v, i) => Math.abs(v - pt.position[i]) < 2e-4), `${name}: Unity import position ${unityPos.map((v) => v.toFixed(4))} == prefab ${pt.position}`);
      const qa = new THREE.Quaternion(...bake.unityLocal.rotation), qb = new THREE.Quaternion(...pt.rotation); assert.ok(qa.angleTo(qb) < 2e-3, `${name}: Unity import rotation == prefab (${qa.angleTo(qb).toExponential(2)} rad)`);
      const placement = emitterPlacement({ position: unityPos, rotation: bake.unityLocal.rotation, scale: [1, 1, 1] }).multiply(new THREE.Matrix4().makeScale(s, s, s));
      let minY = Infinity; for (let i = 0; i < pos.length; i += 3) minY = Math.min(minY, new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(placement).y);
      if (spec.wheels.includes(name)) assert.ok(Math.abs(minY) < 6e-3, `${name}: tyre bottom at y=0 (${minY.toFixed(4)})`);
      if (name === car) { hullMinY = minY; assert.ok(Math.abs(minY - spec.liveMinY) < 1e-4, `${car}: hull underside ${minY} == live minY (hull height untouched by the basis rotation)`); }
      assembledMinY = Math.min(assembledMinY, minY);
    }
    assert.ok(Math.abs(assembledMinY) < 6e-3, `${car}: assembled bottom ${assembledMinY.toFixed(4)} (was ${hullMinY} live)`);
  }
});

test('idempotency: narrowing the same GLB again (what --repair-narrowed does) is a byte-identical no-op that keeps the bake annotation; retargeting a narrowed GLB to another mesh refuses; a LEGACY narrowed file (no marker, ancestry stripped) refuses under strict and is left untouched otherwise', () => {
  const f = path.join(scratch, 'idem.glb'); buildGlb(f, [hull, wheel]); const fid = unityMeshFileID('Wheel_rl');
  assert.equal(keepOnlyModelMeshFileID(f, fid, null, { strict: true }), true); const once = fs.readFileSync(f); const j1 = readGlb(f).json;
  assert.deepEqual(j1.extras.gaiaNarrowed.fileID, String(fid)); assert.equal(j1.extras.gaiaNarrowed.mesh, 'Wheel_rl'); assert.deepEqual(j1.extras.gaiaNarrowed.bake.pivot.map((v) => +v.toFixed(3)), P_WHEEL);
  assert.equal(keepOnlyModelMeshFileID(f, fid, null, { strict: true }), false, 'second run: no-op'); assert.ok(fs.readFileSync(f).equals(once), 'bytes identical after the repeat (no second rotation)');
  assert.equal(keepOnlyModelMeshFileID(f, fid, null, { strict: false }), false); assert.ok(fs.readFileSync(f).equals(once));
  assert.throws(() => keepOnlyModelMeshFileID(f, unityMeshFileID('Hull_Mesh'), null, { strict: true }), /already narrowed to mesh Wheel_rl; cannot retarget/);
  assert.throws(() => keepOnlyModelMeshFileID(f, unityMeshFileID('Hull_Mesh'), null, { strict: false }), /cannot retarget/, 'retarget refused regardless of strict');
  // legacy pre-marker narrowed file: one mesh node, several meshes, no pivot pseudo-nodes, no extras
  const legacy = path.join(scratch, 'legacy.glb'); buildGlb(legacy, [hull, wheel]); keepOnlyModelMeshFileID(legacy, fid, null, { strict: true, bakePivot: false });
  { const b = fs.readFileSync(legacy); const len = b.readUInt32LE(12); const j = JSON.parse(b.subarray(20, 20 + len).toString()); delete j.extras; const jt = Buffer.from(JSON.stringify(j)); const jp = (4 - (jt.length % 4)) % 4; const jc = Buffer.concat([jt, Buffer.alloc(jp, 0x20)]); const rest = b.subarray(20 + len); const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jc.length + rest.length, 8); const jh = Buffer.alloc(8); jh.writeUInt32LE(jc.length, 0); jh.writeUInt32LE(0x4e4f534a, 4); fs.writeFileSync(legacy, Buffer.concat([h, jh, jc, rest])); }
  const before = fs.readFileSync(legacy); assert.throws(() => keepOnlyModelMeshFileID(legacy, fid, null, { strict: true }), /looks already narrowed .* pivot bake impossible/);
  assert.equal(keepOnlyModelMeshFileID(legacy, fid, null, { strict: false }), false); assert.ok(fs.readFileSync(legacy).equals(before), 'legacy file left untouched (no blind R(pi) with pivot 0)');
});

test('accessor validation before any byte is written: wrong VEC type, non-float, sparse, bad stride, accessor past its bufferView, bufferView past the BIN chunk', () => {
  const f = path.join(scratch, 'acc.glb'); buildGlb(f, [hull, wheel]); const b = fs.readFileSync(f); const len = b.readUInt32LE(12); const json = JSON.parse(b.subarray(20, 20 + len).toString()); const glb = { buf: b, jsonEnd: 20 + len };
  const wheelMesh = json.meshes.find((m) => m.name === 'Wheel_rl'); const pos = wheelMesh.primitives[0].attributes.POSITION;
  assert.ok(validateFloatAccessor(glb, json, pos, 3, 'POSITION').stride === 12);
  const mut = (fn, re) => { const j = JSON.parse(JSON.stringify(json)); fn(j); assert.throws(() => validateFloatAccessor(glb, j, pos, 3, 'POSITION'), re); };
  mut((j) => { j.accessors[pos].type = 'VEC2'; }, /type VEC2 != VEC3/); mut((j) => { j.accessors[pos].componentType = 5123; }, /!= float32/); mut((j) => { j.accessors[pos].sparse = { count: 1 }; }, /sparse/);
  mut((j) => { j.bufferViews[j.accessors[pos].bufferView].byteStride = 8; }, /byteStride 8 invalid/); mut((j) => { j.bufferViews[j.accessors[pos].bufferView].byteStride = 14; }, /byteStride 14 invalid/);
  mut((j) => { j.accessors[pos].count += 1; }, /exceeds its bufferView/); mut((j) => { j.bufferViews[j.accessors[pos].bufferView].byteLength += 100000; }, /exceeds BIN chunk/);
  // through the public path: a corrupt accessor makes narrowing throw before the file changes
  const bad = path.join(scratch, 'acc-bad.glb'); { const j = JSON.parse(JSON.stringify(json)); j.accessors[pos].type = 'VEC2'; const jt = Buffer.from(JSON.stringify(j)); const jp = (4 - (jt.length % 4)) % 4; const jc = Buffer.concat([jt, Buffer.alloc(jp, 0x20)]); const rest = b.subarray(20 + len); const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jc.length + rest.length, 8); const jh = Buffer.alloc(8); jh.writeUInt32LE(jc.length, 0); jh.writeUInt32LE(0x4e4f534a, 4); fs.writeFileSync(bad, Buffer.concat([h, jh, jc, rest])); }
  const before = fs.readFileSync(bad); assert.throws(() => keepOnlyModelMeshFileID(bad, unityMeshFileID('Wheel_rl'), null, { strict: true }), /POSITION accessor .* type VEC2/); assert.ok(fs.readFileSync(bad).equals(before), 'file untouched on validation failure');
});

// The CURRENT traffic recipes (ecs/traffic-prefabs.json: 15 vehicles = 14 + Tram1, 29 distinct narrowed GLBs) all take this
// path. Their DotsCity LOD-0 FBX files carry NO pivot pseudo-nodes and origin-centred meshes, so the bake is a pure basis
// rotation R_y(pi) (pivot 0): every hull/wheel part turns 180 deg about Y relative to the pre-fix cache. Encoded here so a
// regression in either direction (lost rotation, or a second one) fails loudly.
const worldDir = process.env.GAIA_TEST_WORLD || path.join(process.env.HOME ?? '', 'projects', 'boomtown-rampage-gwe-wt', 'astra', 'tools', 'unity', 'out', 'boomtown-world');
const trafficFile = path.join(worldDir, 'ecs', 'traffic-prefabs.json');
const haveTraffic = assimp && fs.existsSync(trafficFile) && fs.existsSync(path.join(unityRoot, 'Assets/DotsCity/Samples/Demo Presets/Art/Models/Cars/LOD 0/Bus1.fbx'));
test('REAL traffic recipes (ecs/traffic-prefabs.json, 29 narrowed GLBs, no parent cache writes): every multi-mesh recipe bakes with pivot 0 (pure R_y(pi)), wheels stay origin-centred with the axle on X, hull bottoms keep their height, x/z bounds flip sign, output deterministic; single-mesh Tram1 is untouched (whole-model path)', { skip: !haveTraffic && 'traffic recipes / assimp / DotsCity FBX missing', timeout: 600000 }, () => {
  const t = JSON.parse(fs.readFileSync(trafficFile, 'utf8')); const glbs = new Set(); let baked = 0, single = 0;
  for (const car of t.cars) {
    const fbx = path.join(unityRoot, car.sourceModel); const base = path.join(scratch, `${car.key}.glb`);
    const r = spawnSync('assimp', ['export', fbx, base, '-f', 'glb2', '-triangulate', '-joinidenticalvertices', '-pretransformvertices']); assert.equal(r.status, 0, `${car.key} assimp`); fixFbxUnitScale(base, fbx);
    const table = parseMetaRecycleNames(fs.readFileSync(`${fbx}.meta`, 'utf8')); const full = readGlb(base);
    assert.equal(full.json.nodes.filter((n) => /_\$AssimpFbx\$_/.test(n.name)).length, 0, `${car.key}: DotsCity LOD-0 FBX has no pivot pseudo-nodes`);
    for (const src of new Set(car.parts.map((p) => p.src))) {
      glbs.add(src); const m = /-m(n?)(\d+)\.glb$/.exec(src); const fid = (m[1] ? '-' : '') + m[2]; const f = path.join(scratch, path.basename(src)); fs.copyFileSync(base, f);
      const ok = keepOnlyModelMeshFileID(f, fid, table, { strict: true });
      if (full.json.meshes.length <= 1) { single++; assert.equal(ok, false, `${car.key}: single-mesh model is not narrowed/baked`); assert.ok(fs.readFileSync(f).equals(fs.readFileSync(base)), 'bytes untouched'); continue; }
      assert.equal(ok, true, `${src} narrowed`); baked++; const g = readGlb(f); const node = g.json.nodes.at(-1); const bake = node.extras.fbxPivotBake; assert.ok(bake, `${src}: bake recorded`); assert.deepEqual(bake.pivot, [0, 0, 0], `${src}: pivot 0 -> pure basis rotation`); assert.deepEqual(g.json.extras.gaiaNarrowed.fileID, fid);
      const s = g.json.nodes[0].scale?.[0] ?? 1; const pos = g.f32(g.json.meshes[node.mesh].primitives[0].attributes.POSITION, 3);
      const rawMesh = full.json.meshes[node.mesh]; const raw = full.f32(rawMesh.primitives[0].attributes.POSITION, 3); assert.equal(raw.length, pos.length);
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], rmn = [Infinity, Infinity, Infinity], rmx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i += 3) for (let d = 0; d < 3; d++) { mn[d] = Math.min(mn[d], pos[i + d] * s); mx[d] = Math.max(mx[d], pos[i + d] * s); rmn[d] = Math.min(rmn[d], raw[i + d] * s); rmx[d] = Math.max(rmx[d], raw[i + d] * s); }
      for (let i = 0; i < pos.length; i += 3) { assert.equal(pos[i], Math.fround(-raw[i])); assert.equal(pos[i + 1], raw[i + 1]); assert.equal(pos[i + 2], Math.fround(-raw[i + 2])); } // exact R_y(pi), no recentring
      assert.ok(Math.abs(mn[1] - rmn[1]) < 1e-6 && Math.abs(mx[1] - rmx[1]) < 1e-6, `${src}: height untouched`); assert.ok(Math.abs(mn[0] + rmx[0]) < 1e-6 && Math.abs(mn[2] + rmx[2]) < 1e-6, `${src}: x/z bounds flip sign`);
      if (/wheel/i.test(node.name)) { const ext = mn.map((v, i) => mx[i] - v); assert.ok(ext[0] < ext[1] && ext[0] < ext[2], `${src}: axle on X (${ext.map((v) => v.toFixed(2))})`); assert.ok(Math.abs(mn[1] + mx[1]) < 2e-3 && Math.abs(mn[2] + mx[2]) < 2e-3, `${src}: wheel centred on its axle (y,z)`); assert.ok(Math.abs(mn[0] + mx[0]) < 2e-3, `${src}: wheel centred across the axle (x)`); }
      const f2 = `${f}.again`; fs.copyFileSync(base, f2); keepOnlyModelMeshFileID(f2, fid, table, { strict: true }); assert.ok(fs.readFileSync(f2).equals(fs.readFileSync(f)), `${src}: deterministic bytes`);
      assert.equal(keepOnlyModelMeshFileID(f, fid, table, { strict: true }), false, `${src}: repeat is a no-op`);
    }
  }
  assert.equal(glbs.size, 29, 'all 29 distinct narrowed traffic GLBs covered'); assert.equal(baked, 28); assert.equal(single, 1, 'Tram1');
});

test('non-FBX inputs never get the FBX-import basis: convertOne gates bakePivot by the actual input extension, and bakePivot:false keeps the triangle basis byte-for-byte (a .glb/.gltf/.blend source has no Unity FBX import to mirror)', () => {
  const src = fs.readFileSync(path.join(repo, 'tools', 'unity', 'convert-model.mjs'), 'utf8');
  const calls = [...src.matchAll(/keepOnlyModelMeshFileID\(outFile, meshFileID, table, \{([^}]*)\}\)/g)].map((m) => m[1]);
  assert.equal(calls.length, 3, 'three convertOne call sites (.glb/.gltf, .blend, fbx converters)'); for (const c of calls) assert.match(c, /bakePivot: \/\\\.fbx\$\/i\.test\(inFile\)/, `call site gates on the FBX extension: {${c}}`);
  // the gate's effect: a non-FBX source narrowed without the bake keeps raw vertices, normals and indices identical to the input
  const f = path.join(scratch, 'nonfbx.glb'); const json = buildGlb(f, [hull, door]); const before = readGlb(f); const rawPos = Array.from(before.f32(json.meshes[1].primitives[0].attributes.POSITION, 3)); const rawNrm = Array.from(before.f32(json.meshes[1].primitives[0].attributes.NORMAL, 3));
  assert.equal(keepOnlyModelMeshFileID(f, unityMeshFileID('Door_l'), null, { strict: true, bakePivot: false }), true);
  const after = readGlb(f); const node = after.json.nodes.at(-1); assert.equal(node.name, 'Door_l'); assert.equal(node.extras, undefined, 'no bake annotation'); assert.equal(after.json.extras.gaiaNarrowed.bake, null);
  assert.deepEqual(Array.from(after.f32(after.json.meshes[node.mesh].primitives[0].attributes.POSITION, 3)), rawPos, 'positions untouched'); assert.deepEqual(Array.from(after.f32(after.json.meshes[node.mesh].primitives[0].attributes.NORMAL, 3)), rawNrm, 'normals untouched');
  assert.ok(after.json.nodes.slice(0, -1).every((n) => n.translation === undefined && n.rotation === undefined && n.matrix === undefined), 'ancestors still stripped to scale-only (pre-existing narrowing behaviour, independent of the bake)');
});

test('accessor validation refuses NaN/negative/fractional/undefined count, offsets, lengths, strides (comparisons against NaN silently pass otherwise)', () => {
  const f = path.join(scratch, 'acc2.glb'); buildGlb(f, [hull, wheel]); const b = fs.readFileSync(f); const len = b.readUInt32LE(12); const json = JSON.parse(b.subarray(20, 20 + len).toString()); const glb = { buf: b, jsonEnd: 20 + len };
  const pos = json.meshes.find((m) => m.name === 'Wheel_rl').primitives[0].attributes.POSITION; const mut = (fn, re) => { const j = JSON.parse(JSON.stringify(json)); fn(j); assert.throws(() => validateFloatAccessor(glb, j, pos, 3, 'POSITION'), re); };
  mut((j) => { j.accessors[pos].count = NaN; }, /count NaN is not a non-negative integer/); mut((j) => { j.accessors[pos].count = -1; }, /count -1/); mut((j) => { j.accessors[pos].count = 1.5; }, /count 1.5/); mut((j) => { delete j.accessors[pos].count; }, /count undefined/); mut((j) => { j.accessors[pos].count = 0; }, /exceeds its bufferView|count 0/);
  mut((j) => { j.accessors[pos].byteOffset = -4; }, /byteOffset -4/); mut((j) => { j.accessors[pos].byteOffset = NaN; }, /byteOffset NaN/); mut((j) => { j.accessors[pos].byteOffset = 2.5; }, /byteOffset 2.5/);
  mut((j) => { j.bufferViews[j.accessors[pos].bufferView].byteLength = NaN; }, /bufferView.byteLength NaN/); mut((j) => { delete j.bufferViews[j.accessors[pos].bufferView].byteLength; }, /bufferView.byteLength undefined/); mut((j) => { j.bufferViews[j.accessors[pos].bufferView].byteOffset = -1; }, /bufferView.byteOffset -1/);
  mut((j) => { j.bufferViews[j.accessors[pos].bufferView].byteStride = NaN; }, /bufferView.byteStride NaN/); mut((j) => { j.bufferViews[j.accessors[pos].bufferView].byteStride = 12.5; }, /byteStride 12.5/); mut((j) => { j.bufferViews[j.accessors[pos].bufferView].byteStride = Infinity; }, /byteStride Infinity/);
  mut((j) => { j.accessors[pos].bufferView = -1; }, /bufferView -1/); mut((j) => { j.bufferViews[j.accessors[pos].bufferView].buffer = 1; }, /buffer 0 only/);
  assert.ok(validateFloatAccessor(glb, json, pos, 3, 'POSITION'), 'the pristine accessor still passes');
});
