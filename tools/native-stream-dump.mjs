#!/usr/bin/env bun
// tools/native-stream-dump.mjs — headless (no browser/Tauri/GPU): drive GaiaRenderNative with a capturing transport, write the raw command
// stream, and self-check the framing against the generated op table. Replay it through the REAL Rust decoder + a headless device with:
//   cd client-rs && cargo run -p gaia-render-host --example replay -- <stream.bin> [message_bytes=777]
// usage: bun tools/native-stream-dump.mjs [out=.scratch/native-stream.bin]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GaiaRenderNative } from '../client/kernel/render-api/native/gaia-render-native.js';
import { OPS } from '../client/kernel/render-api/native/gaia-render-native.gen.js';

const out = process.argv[2] ?? '.scratch/native-stream.bin';
const chunks = [];
const send = async (bytes) => { chunks.push(bytes.slice()); return { errors: [], q: { hdrScene: true, hasTimestamps: false }, frame: 1 }; };
const gpu = await GaiaRenderNative.create(null, { renderHeight: 360, hdrScene: 1, shadows: { enabled: false } }, { send, chunkMB: 1 });

const tri = { p: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), n: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), uv: Float32Array.of(0, 0, 1, 0, 0, 1), i: Uint32Array.of(0, 1, 2) };
const mesh = gpu.createMesh(tri.p, tri.n, tri.uv, tri.i);
const tex = gpu.createTexture(2, 2, new Uint8Array(16).fill(200));
const mat = gpu.createMaterial(Float32Array.of(1, 1, 1, 1), 0, 0.5, tex, -1, Float32Array.of(0, 0, 0));
gpu.setMaterialFlags(mat, 0, false, -1, 0, -1);
const ident = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
const inst = gpu.createInstance(mesh, mat, ident);
gpu.setCamera(ident, 1, 0.1, 1000);
gpu.setSun(Float32Array.of(0, -1, 0), Float32Array.of(1, 1, 1), 3);
gpu.setShadowOptions({ enabled: false, resolution: 1024 });
gpu.createShaderMaterial('@vertex fn vs()->@builtin(position) vec4<f32>{return vec4<f32>(0.);} @fragment fn fs()->@location(0) vec4<f32>{return vec4<f32>(1.);}', 'vs', 'fs',
  [{ kind: 'uniform', binding: 0, data: new Uint8Array(16), vertex: true }, { kind: 'texture', binding: 1, texture: tex }, { kind: 'sampler', binding: 2 }]);
gpu.createThreeMaterial('{"bogus":true}', ['mapTexture'], Uint32Array.of(tex)); // expected: host reports an error for this id (error path)
// a >chunk upload: 3 MiB texture splits across IPC messages (partial-command buffering on the Rust side)
gpu.createTexture(1024, 768, new Uint8Array(1024 * 768 * 4));
gpu.render();
await gpu._t.idle();

// ---- self-check: framing vs op table ----
const total = chunks.reduce((n, c) => n + c.byteLength, 0);
const all = new Uint8Array(total); let o = 0; for (const c of chunks) { all.set(c, o); o += c.byteLength; }
const dv = new DataView(all.buffer); const names = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));
const hist = {}; let pos = 0, n = 0;
while (pos < all.length) {
  const op = dv.getUint16(pos, true), len = dv.getUint32(pos + 4, true);
  if (len % 4) throw new Error(`cmd ${n}: payload ${len} not 4-aligned`);
  const name = op === 0 ? 'HELLO' : op === 0xffff ? 'FREE' : names[op]; if (!name) throw new Error(`cmd ${n}: unknown op ${op}`);
  hist[name] = (hist[name] ?? 0) + 1; pos += 8 + len; n++;
}
if (pos !== all.length) throw new Error(`stream ends mid-command (${pos} vs ${all.length})`);
mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, all);
console.log(`ok: ${n} commands, ${total} bytes in ${chunks.length} IPC messages (max ${Math.max(...chunks.map((c) => c.byteLength))} B) -> ${out}`);
console.log(hist, 'handles', { mesh, tex, mat, inst });
console.log('ipc', gpu.ipcStats());
