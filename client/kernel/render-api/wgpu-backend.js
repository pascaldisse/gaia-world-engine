// render-api/wgpu-backend.js — backend #2: gaia-render (Rust/wgpu) compiled to wasm, WebGPU canvas.
// Implements interface.js on top of client-rs/packages/render-wasm (wasm-bindgen: typed arrays in, integer handles out).
// NO three imports. Creation is ASYNC (adapter/device request); every method of the returned backend is sync.
//
//   const backend = await createWgpuBackend({ canvas, wasm: await import('/pkg/render_wasm.js'), renderHeight: 720 });
//   // `wasm` = the wasm-bindgen --target web module ({ default: init, GaiaRender }); `wasmUrl` optional override for init().
//
// Core handles: mesh/material ids come straight from the wasm core. NodeId (groups + instances) and LightId are minted here:
// the core only knows flat world-space instances, so node hierarchy (parent × local) + visibility are resolved in JS and
// pushed down as world mat4s. Capabilities are the honest subset gaia-render has TODAY (see NOTES in crates/gaia-render).
import { RENDER_API_VERSION, validateMeshArrays, isMat4, IDENTITY_MAT4 } from './interface.js';

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
// '#rrggbb' | 0xrrggbb are authoring (sRGB) colors → linear (three ColorManagement); [r,g,b] arrays are taken as linear.
function colorOf(c, fallback = [1, 1, 1]) {
  if (c == null) return fallback;
  if (Array.isArray(c) || ArrayBuffer.isView(c)) return [c[0], c[1], c[2]];
  const n = typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : c;
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

function mul4(a, b, out = new Float64Array(16)) { // out = a × b (column-major)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}

// general 4×4 inverse (view → camera-to-world)
export function invert4(m) {
  const o = new Float64Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) throw new Error('render-api(wgpu): singular view matrix');
  det = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}

// perspective projection → { yfov, znear, zfar(0 = infinite) }. 'gl' = z∈[-1,1] (three default), 'zo' = z∈[0,1] (WebGPU coord system).
export function decomposePerspective(p, depth = 'gl') {
  const yfov = 2 * Math.atan(1 / p[5]);
  const a = p[10], b = p[14];
  let znear, zfar;
  if (depth === 'zo') { znear = b / a; zfar = b / (a + 1); } else { znear = b / (a - 1); zfar = b / (a + 1); }
  if (!(zfar > znear) || !Number.isFinite(zfar)) zfar = 0;
  return { yfov, znear, zfar };
}

function computeNormals(positions, indices) {
  const n = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // area-weighted
    for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

// three Texture → {width,height,data:Uint8Array rgba8} (DataTexture rgba8 as-is; image/canvas/bitmap via 2D canvas). null = unreadable.
export function texturePixels(t) {
  const img = t?.image;
  if (!img) return null;
  if (img.data && img.width > 0 && img.height > 0) {
    const d = img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray ? img.data : null;
    return d && d.length === img.width * img.height * 4 ? { width: img.width, height: img.height, data: new Uint8Array(d.buffer, d.byteOffset, d.length) } : null;
  }
  const w = img.width ?? img.videoWidth, h = img.height ?? img.videoHeight;
  if (!(w > 0 && h > 0) || typeof OffscreenCanvas === 'undefined') return null;
  const c = new OffscreenCanvas(w, h).getContext('2d'); c.drawImage(img, 0, 0);
  return { width: w, height: h, data: new Uint8Array(c.getImageData(0, 0, w, h).data.buffer) };
}
export async function createWgpuBackend({ canvas, wasm, wasmUrl, renderHeight = 720, options = {}, depth = 'gl' } = {}) {
  if (!canvas) throw new Error('createWgpuBackend requires { canvas }');
  if (!wasm?.GaiaRender) throw new Error('createWgpuBackend requires { wasm } = the render_wasm.js module');
  if (!navigator.gpu) throw new Error('createWgpuBackend: WebGPU unavailable (navigator.gpu missing)');
  await (wasmUrl ? wasm.default(wasmUrl) : wasm.default());
  const gpu = await wasm.GaiaRender.create(canvas, { renderHeight, ...options });

  let next = 1;
  const nodes = new Map();      // NodeId → { id, kind, parent, children:Set, local, world, visible, mesh, material, rid }
  const lights = new Map();     // LightId → { kind:'sun'|'point', ... }
  const matTextures = new Map(); // MaterialId → [wasm texture ids] owned by that material
  let lightsDirty = false;
  let sunId = 0;

  const need = (map, id, what) => { const v = map.get(id); if (!v) throw new Error(`render-api(wgpu): unknown ${what} ${id}`); return v; };
  const asMat = (m) => { if (!isMat4(m)) throw new Error('render-api(wgpu): mat4 must be 16 finite numbers'); return m; };

  // resolve world transform + effective visibility for a node subtree, push to the core
  function sync(node, parentWorld, parentVisible) {
    node.world = parentWorld ? mul4(parentWorld, node.local, node.world || new Float64Array(16)) : Float64Array.from(node.local);
    const eff = parentVisible && node.visible;
    if (node.kind === 'instance') {
      if (eff) {
        const w = Float32Array.from(node.world);
        if (node.rid && node.ridMat === node.material && node.ridMesh === node.mesh) gpu.updateInstance(node.rid, w);
        else {
          if (node.rid) gpu.removeInstance(node.rid);
          node.rid = gpu.createInstance(node.mesh, node.material, w);
          node.ridMat = node.material; node.ridMesh = node.mesh;
        }
      } else if (node.rid) { gpu.removeInstance(node.rid); node.rid = 0; }
    }
    for (const cid of node.children) sync(nodes.get(cid), node.world, eff);
  }
  const parentState = (node) => {
    const p = node.parent ? nodes.get(node.parent) : null;
    if (!p) return [null, true];
    let vis = true; for (let q = p; q; q = q.parent ? nodes.get(q.parent) : null) vis = vis && q.visible;
    return [p.world, vis];
  };
  function link(node, parentId) {
    if (parentId) need(nodes, parentId, 'parent node').children.add(node.id);
    node.parent = parentId || 0;
  }
  function dropRids(node) {
    if (node.rid) { gpu.removeInstance(node.rid); node.rid = 0; }
    for (const cid of node.children) dropRids(nodes.get(cid));
  }

  function pushLights() {
    const pts = [...lights.values()].filter((l) => l.kind === 'point');
    const packed = new Float32Array(pts.length * 8);
    pts.forEach((l, i) => {
      packed.set([...l.position, l.distance > 0 ? l.distance : 1e4, ...l.color, l.intensity], i * 8);
    });
    gpu.setPointLights(packed);
    const sun = lights.get(sunId);
    if (sun) gpu.setSun(Float32Array.from(sun.direction.map((v) => -v)), Float32Array.from(sun.color), sun.intensity);
    lightsDirty = false;
  }

  const backend = {
    name: 'wgpu',
    apiVersion: RENDER_API_VERSION,
    capabilities: ['mesh-arrays', 'pbr', 'textures-rgba8', 'instances', 'nodes', 'sun', 'point-lights', 'shader-material-wgsl', 'webgpu', gpu.hasTimestamps() ? 'timestamp-query' : 'no-timestamp-query'],
    gpu, // raw wasm handle (frame stats / renderTimed / createShaderMaterial live here, not in the neutral interface)

    createMesh(arrays) {
      const n = validateMeshArrays(arrays);
      const indices = arrays.indices instanceof Uint32Array ? arrays.indices : Uint32Array.from(arrays.indices || Array.from({ length: n }, (_, i) => i));
      const positions = arrays.positions instanceof Float32Array ? arrays.positions : Float32Array.from(arrays.positions);
      const normals = arrays.normals ? Float32Array.from(arrays.normals) : computeNormals(positions, indices);
      const uvs = arrays.uvs ? Float32Array.from(arrays.uvs) : new Float32Array(n * 2);
      return gpu.createMesh(positions, normals, uvs, indices);
    },
    destroyMesh(id) { gpu.destroyMesh(id); },

    // params = three-style; preset → degrades to pbr; opacity/doubleSide/fog/flatShading not in the core yet (drawn opaque, no cull).
    createMaterial(params = {}, textures = null) {
      const [r, g, b] = colorOf(params.color);
      const e = colorOf(params.emissive, [0, 0, 0]);
      const k = params.emissiveIntensity ?? 1;
      const owned = [];
      let tex = 0;
      if (textures?.map) {
        const t = textures.map;
        if (!t.data || !(t.width > 0) || !(t.height > 0)) throw new Error('createMaterial: texture map needs { width, height, data }');
        tex = gpu.createTexture(t.width, t.height, t.data instanceof Uint8Array ? t.data : new Uint8Array(t.data.buffer ?? t.data));
        owned.push(tex);
      }
      const id = gpu.createMaterial(Float32Array.of(r, g, b, params.opacity ?? 1), params.metalness ?? 0, params.roughness ?? 1, tex,
        params.alphaTest > 0 ? params.alphaTest : -1, Float32Array.of(e[0] * k, e[1] * k, e[2] * k));
      if (owned.length) matTextures.set(id, owned);
      return id;
    },
    // three r180 TSL package (tsl-export.js) as-is → gaia-render create_three_material. Texture bindings resolved through the
    // package's non-enumerable textureSources (uuid → three Texture); a texture binding without readable pixels = loud Error.
    createShaderMaterial(pkg) {
      if (!pkg?.vertex || !pkg?.fragment || !Array.isArray(pkg.bindGroups)) throw new Error('createShaderMaterial: tsl-export package required');
      const names = [], ids = [], owned = [];
      for (const g of pkg.bindGroups) for (const b of g.bindings) {
        if (!String(b.kind).startsWith('texture')) continue;
        const t = pkg.textureSources?.[b.textureUuid];
        const px = t && texturePixels(t);
        if (!px) throw new Error(`createShaderMaterial: texture binding '${b.name}' (uuid ${b.textureUuid}) has no readable pixels`);
        const id = gpu.createTexture(px.width, px.height, px.data); owned.push(id); names.push(b.name); ids.push(id);
      }
      const id = gpu.createThreeMaterial(JSON.stringify(pkg), names, Uint32Array.from(ids));
      if (owned.length) matTextures.set(id, owned);
      return id;
    },
    setShaderTime(seconds) { gpu.setThreeTime(seconds); },
    destroyMaterial(id) {
      gpu.destroyMaterial(id);
      for (const t of matTextures.get(id) || []) gpu.destroyTexture(t);
      matTextures.delete(id);
    },

    createNode(mat4, parent = 0) {
      const node = { id: next++, kind: 'group', parent: 0, children: new Set(), local: Float64Array.from(asMat(mat4)), world: null, visible: true };
      nodes.set(node.id, node); link(node, parent);
      const [pw, pv] = parentState(node); sync(node, pw, pv);
      return node.id;
    },
    createInstance(mesh, material, mat4, flags = {}) {
      const node = { id: next++, kind: 'instance', parent: 0, children: new Set(), local: Float64Array.from(asMat(mat4)), world: null,
        visible: flags.visible !== false, mesh, material, rid: 0, ridMat: 0, ridMesh: 0 };
      nodes.set(node.id, node); link(node, flags.parent);
      const [pw, pv] = parentState(node); sync(node, pw, pv);
      return node.id;
    },
    updateNode(id, patch = {}) {
      const node = need(nodes, id, 'node');
      if (patch.mat4) node.local = Float64Array.from(asMat(patch.mat4));
      if (patch.visible !== undefined) node.visible = !!patch.visible;
      if (patch.material !== undefined && node.kind === 'instance') node.material = patch.material;
      // castShadow/receiveShadow/renderOrder/euler: accepted, no-ops (no shadows / ordering in the core yet)
      const [pw, pv] = parentState(node); sync(node, pw, pv);
    },
    removeNode(id) {
      const node = need(nodes, id, 'node');
      for (const cid of [...node.children]) backend.removeNode(cid);
      dropRids(node);
      if (node.parent) nodes.get(node.parent)?.children.delete(id);
      nodes.delete(id);
    },

    // view = world→camera (as three's matrixWorldInverse); proj = perspective (see decomposePerspective for depth convention)
    setCamera(view, proj) {
      asMat(view); asMat(proj);
      const { yfov, znear, zfar } = decomposePerspective(proj, depth);
      gpu.setCamera(Float32Array.from(invert4(view)), yfov, znear, zfar);
    },

    setSun({ direction = [0, 1, 0], color = [1, 1, 1], intensity = 1 } = {}) {
      if (!sunId) sunId = next++;
      lights.set(sunId, { kind: 'sun', direction: [...direction], color: colorOf(color), intensity });
      lightsDirty = true;
      return sunId;
    },
    addPointLight({ position = [0, 0, 0], color = [1, 1, 1], intensity = 1, distance = 0, decay = 2 } = {}) {
      const id = next++;
      lights.set(id, { kind: 'point', position: [...position], color: colorOf(color), intensity, distance, decay });
      lightsDirty = true;
      return id;
    },
    updatePointLight(id, patch = {}) {
      const l = need(lights, id, 'light');
      if (patch.color) patch = { ...patch, color: colorOf(patch.color) };
      Object.assign(l, patch); lightsDirty = true;
    },
    removeLight(id) { need(lights, id, 'light'); lights.delete(id); if (id === sunId) sunId = 0; lightsDirty = true; },

    renderFrame(/* dt */) {
      if (lightsDirty) pushLights();
      return gpu.render();
    },
    // wgpu-only: render + Promise<ms submit→queue-done> (wall clock incl. queue latency, not pure GPU time)
    renderFrameTimed() {
      if (lightsDirty) pushLights();
      return gpu.renderTimed();
    },
    // wgpu-only: render + Promise<{scene,upscale,total} GPU-timestamp ms | null> (null: no timestamp-query / sample in flight)
    renderFrameGpuTimed() {
      if (lightsDirty) pushLights();
      return gpu.renderGpuTimed();
    },
    resize(renderHeight) { gpu.setRenderHeight(renderHeight); },
    dispose() { for (const id of [...nodes.keys()]) if (nodes.has(id) && !nodes.get(id).parent) backend.removeNode(id); gpu.free(); },
  };
  return backend;
}

export { IDENTITY_MAT4 };
