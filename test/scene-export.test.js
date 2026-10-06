// test/scene-export.test.js — Run: bun test test/scene-export.test.js
import { describe, test, expect } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { exportScene, selfCheck, readGlb } from '../tools/scene-export/export.mjs';

const DIR = new URL('../.scratch/test-scene-export/', import.meta.url).pathname;

function dds4x4Dxt1() { // 4x4 DXT1 block, c0=pure red 565 (0xF800), c1=0, all idx 0 -> red
  const b = Buffer.alloc(128 + 8); b.write('DDS ', 0, 'latin1'); b.writeUInt32LE(124, 4); b.writeUInt32LE(4, 12); b.writeUInt32LE(4, 16); b.writeUInt32LE(32, 76); b.writeUInt32LE(4, 80); b.write('DXT1', 84, 'latin1');
  b.writeUInt16LE(0xf800, 128); b.writeUInt16LE(0, 130); return b;
}
function buildGlb(json, bin) {
  const pad = (b, f) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, f)]);
  const j = pad(Buffer.from(JSON.stringify(json)), 0x20), bn = pad(bin, 0);
  const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + j.length + 8 + bn.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(j.length, 0); c1.writeUInt32LE(0x4e4f534a, 4); const c2 = Buffer.alloc(8); c2.writeUInt32LE(bn.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([h, c1, j, c2, bn]);
}
function fixture() {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uv = new Float32Array([0, 0, 1, 0, 0, 1]), idx = new Uint16Array([0, 1, 2, 0]);
  const dds = dds4x4Dxt1(); const parts = [Buffer.from(pos.buffer), Buffer.from(uv.buffer), Buffer.from(idx.buffer), dds]; let off = 0; const views = parts.map(p => { const v = { buffer: 0, byteOffset: off, byteLength: p.length }; off += p.length + ((4 - (p.length % 4)) % 4); return v; });
  const bin = Buffer.concat(parts.map(p => Buffer.concat([p, Buffer.alloc((4 - (p.length % 4)) % 4)])));
  const prim = (mat) => ({ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: mat });
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1, 2] }],
    nodes: [{ name: 'render', children: [3, 4] }, { name: 'skinned:chr', mesh: 0, skin: 0 }, { name: 'collision', mesh: 1 }, { name: 'wall', mesh: 0, translation: [5, 0, 0] }, { name: 'floor', mesh: 1 }],
    meshes: [{ name: 'wallmesh', primitives: [prim(0)] }, { name: 'colmesh', primitives: [prim(1)] }],
    materials: [{ name: 'stone', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, { name: 'collision-diagnostic' }],
    textures: [{ extensions: { MSFT_texture_dds: { source: 0 } } }], images: [{ name: 'red', mimeType: 'image/vnd-ms.dds', bufferView: 3 }],
    extensionsUsed: ['MSFT_texture_dds'], extensionsRequired: ['MSFT_texture_dds'],
    skins: [{ joints: [1] }], animations: [{ channels: [], samplers: [] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }, { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' }],
    bufferViews: views, buffers: [{ byteLength: bin.length }],
  };
  return buildGlb(json, bin);
}

describe('scene-export', () => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(DIR + 'in.glb', fixture());
  const manifest = {
    input: 'in.glb', exclude: { skinned: true, nodes: ['^collision$'], materials: ['^collision-diagnostic$'] },
    sun: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 3 },
    pointLights: [{ name: 'torch', position: [1, 2, 3], color: [1, 0.5, 0.2], intensity: 20, range: 8 }],
    camera: { position: [0, 1.7, 0], yawDeg: 90, fovYDeg: 70 },
  };
  const { glb, gltf, stats } = exportScene(manifest, DIR);
  test('self-check passes', () => { expect(selfCheck(glb)).toEqual({ ok: true, errors: [], errorCount: 0 }); });
  test('skinned + collision dropped, static kept', () => {
    const names = gltf.nodes.map(n => n.name); expect(names).toContain('wall'); expect(names).not.toContain('skinned:chr'); expect(names).not.toContain('collision');
    expect(gltf.skins).toBeUndefined(); expect(gltf.animations).toBeUndefined(); expect(stats.droppedNodes).toBe(2);
  });
  test('u32 indices, NORMAL generated, TEXCOORD_0 kept, triangle count from 4-idx buffer trimmed? (3 indices)', () => {
    const p = gltf.meshes[0].primitives[0]; expect(gltf.accessors[p.indices].componentType).toBe(5125); expect(p.attributes.NORMAL).toBeDefined(); expect(p.attributes.TEXCOORD_0).toBeDefined();
    expect(stats.generatedNormals).toBe(1); expect(stats.triangles).toBe(1);
  });
  test('DDS decoded to a PNG, MSFT extension gone', () => {
    expect(gltf.images[0].mimeType).toBe('image/png'); expect(gltf.textures[0].source).toBe(0); expect(JSON.stringify(gltf)).not.toContain('MSFT'); expect(stats.ddsDecoded).toBe(1);
    const { json, bin } = readGlb(DIR + 'in.glb'); expect(json.images.length).toBe(1);
  });
  test('lights + camera', () => {
    expect(gltf.extensions.KHR_lights_punctual.lights.map(l => l.type)).toEqual(['directional', 'point']); expect(gltf.extensionsUsed).toContain('KHR_lights_punctual');
    expect(gltf.cameras).toHaveLength(1); expect(gltf.nodes.filter(n => n.camera !== undefined)).toHaveLength(1);
  });
  test('cleanup', () => { rmSync(DIR, { recursive: true, force: true }); });
});
