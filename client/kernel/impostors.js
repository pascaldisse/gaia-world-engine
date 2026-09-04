// impostors — Doom's trick, done from the real geometry at runtime.
//
// Under an orthographic 2.5D lens the frame is a fixed pose: the same building
// is seen from the same handful of angles all game long. So draw it ONCE per
// angle bucket into an offscreen render target, keep that texture in GPU
// memory, and blit it as a camera-facing quad. The 3D model stays the source of
// truth — nothing is authored, nothing is exported, NOTHING TOUCHES DISK: the
// cache is a Map of WebGLRenderTarget/RenderTarget objects and dies with the tab.
//
// Re-render happens only on a *delta*: a new angle bucket, or a new animation
// frame bucket. A still object under a still camera renders zero times per
// frame after its first.
//
// Everything tunable is a parameter (see IMPOSTOR_DEFAULTS); a world turns the
// system on and tunes it via `env.impostors` in its scene declaration. The
// engine hardcodes no game-specific value and no pixel size.
import * as THREE from 'three/webgpu';

export const IMPOSTOR_DEFAULTS = Object.freeze({
  enabled: false,        // opt-in: a world declares env.impostors.enabled
  angleBuckets: 16,      // yaw buckets around the object (Doom used 8)
  pitchBuckets: 1,       // usually 1: an ortho rig holds one pitch
  tile: 128,             // impostor texture edge in px — the sprite's resolution
  animBuckets: 0,        // animation frame buckets (0 = static objects only)
  minSize: 0,            // world-space diameter below which an object stays 3D
  maxSize: 0,            // and above which it stays 3D too (0 = no ceiling).
                         // City-scale meshes (ground, road networks) must never
                         // become one sprite: a single quad would eat the frame.
  maxTextures: 512,      // GPU cache ceiling; least-recently-used evicted
  padding: 1.02,         // framing slack so silhouettes are not clipped
  alphaTest: 0.5,        // cutout threshold; declared by a world, never a shader literal
});

export function impostorSpec(spec = null) {
  const source = spec && typeof spec === 'object' ? spec : {};
  const out = { ...IMPOSTOR_DEFAULTS };
  for (const key of Object.keys(IMPOSTOR_DEFAULTS)) {
    const v = source[key];
    if (key === 'enabled') { out.enabled = v === true; continue; }
    if (key === 'alphaTest') { if (Number.isFinite(v) && v >= 0 && v <= 1) out[key] = v; continue; }
    if (Number.isFinite(v) && v >= 0) out[key] = v;
  }
  out.angleBuckets = Math.max(1, Math.round(out.angleBuckets));
  out.pitchBuckets = Math.max(1, Math.round(out.pitchBuckets));
  out.tile = Math.max(8, Math.round(out.tile));
  out.animBuckets = Math.max(0, Math.round(out.animBuckets));
  out.maxTextures = Math.max(1, Math.round(out.maxTextures));
  out.maxSize = Math.max(0, out.maxSize);
  out.alphaTest = Math.min(1, Math.max(0, out.alphaTest));
  return out;
}

// Which cache cell a view direction + animation phase falls into. Bucketing IS
// the re-render policy: same bucket -> the cached texture is reused verbatim.
export function bucketOf(spec, { yaw = 0, pitch = 0, animPhase = 0 } = {}) {
  const tau = Math.PI * 2;
  const wrap = (a) => ((a % tau) + tau) % tau;
  // EPS: an angle sitting exactly on a bucket seam is a float coin-flip
  // (i/16*2pi does not divide back cleanly) and would split one cell in two.
  const EPS = 1e-9;
  const yawBucket = Math.floor((wrap(yaw) / tau) * spec.angleBuckets + EPS) % spec.angleBuckets;
  const pitchSpan = Math.PI; // -90..+90 folded onto [0,1)
  const pitchNorm = Math.min(0.999999, Math.max(0, (pitch + Math.PI / 2) / pitchSpan));
  const pitchBucket = Math.floor(pitchNorm * spec.pitchBuckets);
  const animBucket = spec.animBuckets > 0
    ? Math.floor((wrap(animPhase * tau) / tau) * spec.animBuckets + EPS) % spec.animBuckets
    : 0;
  return { yawBucket, pitchBucket, animBucket };
}

// The camera basis for a view direction, in the SAME convention renderInto
// places its ortho camera: `dir` points from the subject toward the camera.
// Pure: no THREE objects, so the sizing law is testable headless.
export function viewBasis({ yaw = 0, pitch = 0 } = {}) {
  const dir = {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: -Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  };
  // right = up0 x dir, degenerate when the lens looks straight down/up
  let right = { x: dir.z * 1 - 0, y: 0, z: -dir.x };
  let len = Math.hypot(right.x, right.y, right.z);
  if (len < 1e-6) { right = { x: 1, y: 0, z: 0 }; len = 1; }
  right = { x: right.x / len, y: right.y / len, z: right.z / len };
  // up = dir x right (right-handed, dir plays the camera's +Z)
  const up = {
    x: dir.y * right.z - dir.z * right.y,
    y: dir.z * right.x - dir.x * right.z,
    z: dir.x * right.y - dir.y * right.x,
  };
  return { dir, right, up };
}

// SIZING LAW. The quad must be the object's SILHOUETTE under this lens, not the
// circumscribed sphere: a 40m-tall 8m-wide tower has radius ~20m, and a 40x40
// sphere-sized sprite is a grey slab five times the building. So project the
// AABB's half-extents onto the camera's right/up axes and take width and height
// SEPARATELY (support function of a box: h . |axis| summed per component).
// Returns half-extents in world metres, padding applied.
export function projectedExtents(halfExtents, view = {}, padding = 1) {
  const { dir, right, up } = viewBasis(view);
  const h = halfExtents;
  const support = (a) => Math.abs(h.x * a.x) + Math.abs(h.y * a.y) + Math.abs(h.z * a.z);
  return {
    halfWidth: support(right) * padding,
    halfHeight: support(up) * padding,
    halfDepth: support(dir) * padding,
  };
}

export function bucketKey(modelKey, bucket) {
  return `${modelKey}|y${bucket.yawBucket}|p${bucket.pitchBucket}|a${bucket.animBucket}`;
}

// The cache. `renderer` may be omitted (headless tests): everything except the
// actual GPU render is pure and testable.
export class ImpostorCache {
  constructor({ renderer = null, spec = null } = {}) {
    this.renderer = renderer;
    this.spec = impostorSpec(spec);
    this.textures = new Map(); // key -> { target, lastUsed, renders }
    this.clock = 0;
    this.stats = { renders: 0, hits: 0, misses: 0, evictions: 0, diskWrites: 0 };
    this.scene = new THREE.Scene();
    // The capture scene contains only the source model, not the world's lights.
    // Preserve ordinary StandardMaterial albedo instead of baking a black
    // unlit silhouette into every tile.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1));
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  }

  get enabled() { return this.spec.enabled; }

  configure(spec) {
    const next = impostorSpec(spec);
    // a resolution or bucketing change invalidates every cached tile
    if (next.tile !== this.spec.tile || next.angleBuckets !== this.spec.angleBuckets
      || next.pitchBuckets !== this.spec.pitchBuckets || next.animBuckets !== this.spec.animBuckets) {
      this.clear();
    }
    this.spec = next;
    return this.spec;
  }

  // The one entry point: give it the source object and the view, get back a
  // texture. Renders ONLY when the (model, angle, anim) cell is cold.
  acquire(modelKey, source, view = {}) {
    const bucket = bucketOf(this.spec, view);
    const key = bucketKey(modelKey, bucket);
    const hit = this.textures.get(key);
    this.clock++;
    if (hit) {
      hit.lastUsed = this.clock;
      this.stats.hits++;
      return { key, bucket, target: hit.target, rendered: false };
    }
    this.stats.misses++;
    const target = this.createTarget();
    if (source && this.renderer) this.renderInto(target, source, view);
    this.textures.set(key, { target, lastUsed: this.clock, renders: 1 });
    this.evictIfNeeded();
    return { key, bucket, target, rendered: true };
  }

  createTarget() {
    const t = new THREE.RenderTarget(this.spec.tile, this.spec.tile, {
      magFilter: THREE.NearestFilter, // sprites stay crisp: this is a pixel game surface
      minFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      // the tile is sampled as ordinary colour: it must live in the same space
      // as the main pass or every sprite reads washed out against its geometry
      colorSpace: THREE.SRGBColorSpace,
    });
    // WebGPU keeps a target's alpha only if the texture is declared to have one
    // AND nothing premultiplies it on the way back in; both are asserted here
    // rather than inherited, because the failure mode is a grey opaque slab.
    t.texture.premultiplyAlpha = false;
    t.texture.generateMipmaps = false;
    return t;
  }

  // Offscreen pass: frame the source's bounding sphere with the private ortho
  // camera placed along the view direction, render, restore. GPU only.
  renderInto(target, source, view) {
    const box = new THREE.Box3().setFromObject(source);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    // frame the SILHOUETTE, per axis -- see projectedExtents
    const ext = projectedExtents({ x: half.x, y: half.y, z: half.z }, view, this.spec.padding);
    const hw = Math.max(1e-4, ext.halfWidth);
    const hh = Math.max(1e-4, ext.halfHeight);
    const hd = Math.max(1e-4, ext.halfDepth);
    const cam = this.camera;
    cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh;
    const d = hd * 2 + 1;
    cam.near = 0.01; cam.far = d + hd * 2 + 1;
    const yaw = view.yaw ?? 0;
    const pitch = view.pitch ?? 0;
    cam.position.set(
      center.x + Math.sin(yaw) * Math.cos(pitch) * d,
      center.y - Math.sin(pitch) * d,
      center.z + Math.cos(yaw) * Math.cos(pitch) * d,
    );
    cam.lookAt(center);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const previousParent = source.parent;
    const previousVisible = source.visible;
    // Cached sources are hidden in the main pass. This private capture must
    // still see them, while attach() preserves the holder's world transform.
    source.visible = true;
    this.scene.attach(source);
    const prevTarget = this.renderer.getRenderTarget?.() ?? null;
    // the tile must keep its silhouette: everything the model does not cover
    // stays fully transparent, or a sprite is a grey slab over the street
    const prevClear = new THREE.Color();
    this.renderer.getClearColor?.(prevClear);
    const prevAlpha = this.renderer.getClearAlpha?.() ?? 1;
    const prevAutoClear = this.renderer.autoClear;
    const prevBackground = this.scene.background;
    this.scene.background = null; // a background would paint the tile opaque
    this.renderer.setClearColor?.(0x000000, 0);
    this.renderer.setClearAlpha?.(0);
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(target);
    this.renderer.clear?.();
    this.renderer.render(this.scene, cam);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor?.(prevClear, prevAlpha);
    this.renderer.setClearAlpha?.(prevAlpha);
    this.renderer.autoClear = prevAutoClear;
    this.scene.background = prevBackground;
    this.scene.remove(source);
    if (previousParent) previousParent.attach(source);
    source.visible = previousVisible;
    this.stats.renders++;
  }

  // A camera-facing quad carrying an impostor texture. Sized in world metres by
  // the caller so the sprite occupies exactly the silhouette it replaced.
  billboard(target, width = 1, height = width) {
    // alphaTest, NOT blending: a cutout writes depth and needs no sort, and a
    // half-transparent slab is exactly the grey-screen bug we are killing.
    const material = new THREE.MeshBasicNodeMaterial({ transparent: false, alphaTest: this.spec.alphaTest });
    material.map = target.texture;
    material.side = THREE.DoubleSide;
    material.depthWrite = true;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    mesh.userData.kind = 'impostor';
    return mesh;
  }

  evictIfNeeded() {
    while (this.textures.size > this.spec.maxTextures) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of this.textures) if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; }
      if (oldestKey === null) break;
      this.textures.get(oldestKey).target.dispose?.();
      this.textures.delete(oldestKey);
      this.stats.evictions++;
    }
  }

  clear() {
    for (const entry of this.textures.values()) entry.target.dispose?.();
    this.textures.clear();
  }

  // Explicit live instrumentation: a proof delimits its counter epoch
  // without changing cache contents or render policy.
  resetStats() {
    this.stats = { renders: 0, hits: 0, misses: 0, evictions: 0, diskWrites: 0 };
  }

  report() {
    return { ...this.stats, cached: this.textures.size, spec: this.spec };
  }
}
