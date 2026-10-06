// render-api/mock-backend.js — recording backend: implements the interface (+optional methods), returns sequential handles,
// appends every call to `log` as [method, ...plainArgs] (typed arrays → arrays, mat4 rounded to 1e-9). For adapter tests.
import { RENDER_API_VERSION } from './interface.js';
const plain = (v) => {
if (ArrayBuffer.isView(v)) return Array.from(v, (x) => Math.round(x * 1e9) / 1e9);
if (Array.isArray(v)) return v.map(plain);
if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
return typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v;
};
export function createMockBackend({ optional = ['updateMesh', 'updateMaterial', 'createInstanced', 'updateInstances', 'createShaderMaterial'] } = {}) {
const log = []; let next = 1;
const rec = (name, ret = false) => (...args) => { log.push([name, ...args.map(plain)]); return ret ? next++ : undefined; };
const b = {
name: 'mock', apiVersion: RENDER_API_VERSION, capabilities: [], log,
createMesh: rec('createMesh', true), destroyMesh: rec('destroyMesh'), createMaterial: rec('createMaterial', true), destroyMaterial: rec('destroyMaterial'),
createNode: rec('createNode', true), createInstance: rec('createInstance', true), updateNode: rec('updateNode'), removeNode: rec('removeNode'),
setCamera: rec('setCamera'), setSun: rec('setSun', true), addPointLight: rec('addPointLight', true), updatePointLight: rec('updatePointLight'), removeLight: rec('removeLight'),
renderFrame: rec('renderFrame'), resize: rec('resize'), dispose: rec('dispose'),
};
const opt = { updateMesh: rec('updateMesh'), updateMaterial: rec('updateMaterial'), createInstanced: rec('createInstanced', true), updateInstances: rec('updateInstances'),
createSkin: rec('createSkin', true), updateSkin: rec('updateSkin'), createSkinnedMesh: rec('createSkinnedMesh', true), destroySkin: rec('destroySkin'), destroySkinnedMesh: rec('destroySkinnedMesh'),
createShaderMaterial: (pkg) => { log.push(['createShaderMaterial', { vertexBytes: pkg.vertex.length, fragmentBytes: pkg.fragment.length, groups: pkg.bindGroups.length }]); return next++; } };
for (const k of optional) b[k] = opt[k];
b.take = () => log.splice(0); // drain
return b;
}
