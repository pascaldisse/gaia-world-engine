import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { keepOnlyModelMeshFileID, unityMeshFileID, fixFbxUnitScale, staticMeshBasis, unityImportOfFbxChain } from '../tools/unity/convert-model.mjs';
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
