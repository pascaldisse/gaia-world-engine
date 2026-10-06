// test/scene-export-groups.test.js — visibility-group extras → extras.gaia.visibilityGroups. Run: bun test test/scene-export-groups.test.js
import { describe, test, expect } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { exportScene, readGlb } from '../tools/scene-export/export.mjs';

const DIR = new URL('../.scratch/test-scene-export-groups/', import.meta.url).pathname;
const pad = (b, f) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, f)]);
function buildGlb(json, bin) {
  const j = pad(Buffer.from(JSON.stringify(json)), 0x20), bn = pad(bin, 0);
  const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + j.length + 8 + bn.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(j.length, 0); c1.writeUInt32LE(0x4e4f534a, 4); const c2 = Buffer.alloc(8); c2.writeUInt32LE(bn.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([h, c1, j, c2, bn]);
}
// nodes: 0 piece 'mappiece:p0' draw[3,50,130] · 1 object 'object:o0' draw[7] parent 'p0' (own groups ignored by the engine) · 2 plain 'object:o1' no groups
//        3 'object:o2' parent 'col0' (a node excluded from the output) · 4 'collision:col0' draw[9] (pruned) · 5 'object:o3' extras but no group keys · 6 'object:cycle' parent 'p0'… (ordinary)
function fixture(rootExtras) {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), idx = new Uint16Array([0, 1, 2, 0]);
  const bin = Buffer.concat([pad(Buffer.from(pos.buffer)), pad(Buffer.from(idx.buffer))]);
  const prim = { attributes: { POSITION: 0 }, indices: 1 };
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1, 2, 3, 4, 5] }],
    nodes: [
      { name: 'mappiece:p0', mesh: 0, extras: { drawGroups: [130, 3, 50, 3], displayGroups: [], placementId: 'MapPiece:0' } },
      { name: 'object:o0', mesh: 0, extras: { drawGroups: [7], drawParent: 'p0' } },
      { name: 'object:o1', mesh: 0 },
      { name: 'object:o2', mesh: 0, extras: { drawParent: 'col0' } },
      { name: 'collision:col0', mesh: 0, extras: { drawGroups: [9], displayGroups: [50, 51] } },
      { name: 'object:o3', mesh: 0, extras: { placementId: 'Object:3', gaia: { keep: 1 } } },
    ],
    meshes: [{ primitives: [prim] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5123, count: 4, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 8 }],
    buffers: [{ byteLength: bin.length }],
    ...(rootExtras ? { extras: rootExtras } : {}),
  };
  return buildGlb(json, bin);
}
const byName = (gltf, n) => gltf.nodes.find(x => x.name === n);

describe('scene-export visibility groups', () => {
  mkdirSync(DIR, { recursive: true });
  const table = { schema: 'ds-draw-groups/1', bitCount: 128, collisions: [{ name: 'col0', displayGroups: [50, 51], drawGroups: [9] }] };
  writeFileSync(DIR + 'in.glb', fixture({ drawGroups: table }));
  const { glb, gltf, stats } = exportScene({ input: 'in.glb', exclude: { nodes: ['^collision:'] } }, DIR);
  const vg = (n) => byName(gltf, n)?.extras?.gaia?.visibilityGroups;

  test('draw/display copied sorted+deduped into extras.gaia.visibilityGroups; source keys kept verbatim', () => {
    expect(vg('mappiece:p0')).toEqual({ draw: [3, 50, 130], display: [] });
    expect(byName(gltf, 'mappiece:p0').extras.drawGroups).toEqual([130, 3, 50, 3]);
    expect(byName(gltf, 'mappiece:p0').extras.placementId).toBe('MapPiece:0');
  });
  test('parent resolved to the OUTPUT node index (name after the kind prefix)', () => {
    const v = vg('object:o0');
    expect(v.parent).toBe('p0');
    expect(gltf.nodes[v.parentNode].name).toBe('mappiece:p0');
    expect(v.draw).toEqual([7]);
  });
  test('parent pruned from the output → its effective draw groups inlined + warning', () => {
    const v = vg('object:o2');
    expect(v.parentNode).toBeUndefined();
    expect(v.draw).toEqual([9]);
    expect(stats.warnings.some(w => w.includes("'col0'") && w.includes('pruned'))).toBe(true);
  });
  test('nodes without group keys get no visibilityGroups; foreign extras.gaia kept', () => {
    expect(byName(gltf, 'object:o1').extras).toBeUndefined();
    expect(byName(gltf, 'object:o3').extras.gaia).toEqual({ keep: 1 });
    expect(stats.visibilityNodes).toBe(3);
  });
  test('root extras.drawGroups table copied verbatim', () => {
    expect(gltf.extras.drawGroups).toEqual(table);
    expect(readGlb(DIR + 'in.glb').json.extras.drawGroups).toEqual(table); // source had it too
    expect(glb.length).toBeGreaterThan(100);
  });
  test('manifest.visibilityGroups renames the source keys (generic)', () => {
    writeFileSync(DIR + 'in2.glb', buildGlb(JSON.parse(JSON.stringify({ ...readGlb(DIR + 'in.glb').json, nodes: [{ name: 'a', mesh: 0, extras: { cullSets: [4, 1], shownSets: [2], follows: 'b' } }, { name: 'b', mesh: 0, extras: { cullSets: [1] } }], scenes: [{ nodes: [0, 1] }] })), Buffer.concat([pad(Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer)), pad(Buffer.from(new Uint16Array([0, 1, 2, 0]).buffer))])));
    const r = exportScene({ input: 'in2.glb', visibilityGroups: { draw: 'cullSets', display: 'shownSets', parent: 'follows' } }, DIR);
    const a = byName(r.gltf, 'a').extras.gaia.visibilityGroups;
    expect(a.draw).toEqual([1, 4]); expect(a.display).toEqual([2]); expect(r.gltf.nodes[a.parentNode].name).toBe('b');
    // default key names find nothing in this file
    expect(exportScene({ input: 'in2.glb' }, DIR).stats.visibilityNodes).toBe(0);
  });
  test('cleanup', () => { rmSync(DIR, { recursive: true, force: true }); });
});
