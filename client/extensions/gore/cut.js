// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
//
// §1 gore.cut(mesh, {part}|{plane}) → {stump,piece}|null. §3: non-skinned
// meshes required cleanly, skinned = best-effort (bakes the CURRENT pose via
// SkinnedMesh.boneTransform) else null. Slicing itself is geometry-utils.js's
// pure triangle-plane core; this module bakes world-space input for it,
// turns the two output triangle soups into real three.BufferGeometry (with a
// body group + a red cap group, §3 "both halves capped ... red cap material"),
// and owns cut piece physics (§1 gravity/ground-rest/damping via `update`).
import { sliceTriangleSoup, normalize } from './geometry-utils.js';

const GRAVITY = 9.8;
const GROUND_Y = 0;
const BOUNCE_DAMPING = 0.35; // horizontal damping on ground contact (own tunable, §6)
const CAP_COLOR = 0x7a1010; // dark red, own tunable

// §3 part mode: axis-aligned band of the mesh's world bounding box.
// PLACEHOLDER tunables (§6 unspecified) — head is precise (flat horizontal
// band, tested by §5.10); arm/leg bands are a single-plane approximation of
// a naturally two-axis region (a plane cut can only ever produce ONE
// half-space piece per call) and are documented as such.
function partPlane(three, mesh, part) {
  const box = new three.Box3().setFromObject(mesh);
  const { min, max } = box;
  const width = max.x - min.x, height = max.y - min.y;
  const midX = (min.x + max.x) / 2, midY = (min.y + max.y) / 2, midZ = (min.z + max.z) / 2;
  switch (part) {
    case 'head': return { point: [midX, min.y + 0.85 * height, midZ], normal: [0, 1, 0] };
    case 'leftArm': return { point: [min.x + width / 3, min.y + 0.65 * height, midZ], normal: normalize([-1, 0.15, 0]) };
    case 'rightArm': return { point: [min.x + (2 * width) / 3, min.y + 0.65 * height, midZ], normal: normalize([1, 0.15, 0]) };
    case 'leftLeg': return { point: [midX, midY, midZ], normal: normalize([-1, -1, 0]) };
    case 'rightLeg': return { point: [midX, midY, midZ], normal: normalize([1, -1, 0]) };
    default: return null;
  }
}

function getTriangleIndexList(geo) {
  if (geo.index) {
    const idx = geo.index.array;
    const tris = [];
    for (let i = 0; i < idx.length; i += 3) tris.push([idx[i], idx[i + 1], idx[i + 2]]);
    return tris;
  }
  const count = geo.attributes.position.count;
  const tris = [];
  for (let i = 0; i < count; i += 3) tris.push([i, i + 1, i + 2]);
  return tris;
}

/** World-space bake. Skinned meshes: best-effort via boneTransform (current
 *  pose only); returns null on any failure so cut() can fall back to null
 *  rather than produce wrong geometry (§3 "else null"). */
function bakeWorldVertices(three, mesh) {
  mesh.updateWorldMatrix(true, false);
  const geo = mesh.geometry;
  const posAttr = geo.attributes.position, nrmAttr = geo.attributes.normal, uvAttr = geo.attributes.uv;
  if (!posAttr) return null;
  const count = posAttr.count;
  const normalMatrix = new three.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const skinned = !!mesh.isSkinnedMesh;
  const verts = new Array(count);
  const scratch = new three.Vector3(), wp = new three.Vector3(), wn = new three.Vector3();
  for (let i = 0; i < count; i++) {
    let x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    if (skinned) {
      scratch.set(x, y, z);
      try { mesh.boneTransform(i, scratch); } catch { return null; }
      x = scratch.x; y = scratch.y; z = scratch.z;
    }
    wp.set(x, y, z).applyMatrix4(mesh.matrixWorld);
    const nx = nrmAttr ? nrmAttr.getX(i) : 0, ny = nrmAttr ? nrmAttr.getY(i) : 1, nz = nrmAttr ? nrmAttr.getZ(i) : 0;
    wn.set(nx, ny, nz).applyMatrix3(normalMatrix).normalize();
    const u = uvAttr ? uvAttr.getX(i) : 0, v = uvAttr ? uvAttr.getY(i) : 0;
    verts[i] = { pos: [wp.x, wp.y, wp.z], normal: [wn.x, wn.y, wn.z], uv: [u, v] };
  }
  return verts;
}

function buildGeometryFromSlice(three, side) {
  const tris = [...side.body, ...side.cap];
  const geo = new three.BufferGeometry();
  const position = new Float32Array(tris.length * 9), normal = new Float32Array(tris.length * 9), uv = new Float32Array(tris.length * 6);
  let p = 0, u2 = 0;
  for (const [a, b, c] of tris) {
    for (const v of [a, b, c]) {
      position[p] = v.pos[0]; position[p + 1] = v.pos[1]; position[p + 2] = v.pos[2];
      normal[p] = v.normal[0]; normal[p + 1] = v.normal[1]; normal[p + 2] = v.normal[2];
      p += 3;
      uv[u2] = v.uv[0]; uv[u2 + 1] = v.uv[1]; u2 += 2;
    }
  }
  geo.setAttribute('position', new three.BufferAttribute(position, 3));
  geo.setAttribute('normal', new three.BufferAttribute(normal, 3));
  geo.setAttribute('uv', new three.BufferAttribute(uv, 2));
  const bodyCount = side.body.length * 3, capCount = side.cap.length * 3;
  if (bodyCount > 0) geo.addGroup(0, bodyCount, 0);
  if (capCount > 0) geo.addGroup(bodyCount, capCount, 1);
  return geo;
}

export class GoreCut {
  constructor(gpu, scene, opts = {}) {
    this.three = gpu.three; this.scene = scene; this.seed = opts.seed ?? 1;
    this.pieces = []; // [{ mesh, velocity }] -- §1 update() integrates these
  }

  _cloneBodyMaterial(material) {
    const src = Array.isArray(material) ? material[0] : material;
    return src?.clone ? src.clone() : new this.three.MeshStandardNodeMaterial();
  }

  _makeCapMaterial() {
    return new this.three.MeshStandardNodeMaterial({ color: CAP_COLOR, roughness: 0.9 });
  }

  /** @returns {{stump:import('three').Mesh, piece:import('three').Mesh}|null} */
  cut(mesh, options = {}) {
    if (!mesh || !mesh.geometry) return null;
    let plane;
    if (options.plane && Array.isArray(options.plane.point) && Array.isArray(options.plane.normal)) {
      plane = { point: options.plane.point, normal: normalize(options.plane.normal) };
    } else if (options.part) {
      plane = partPlane(this.three, mesh, options.part);
      if (!plane) return null;
    } else return null;

    const verts = bakeWorldVertices(this.three, mesh);
    if (!verts) return null;
    const tris = getTriangleIndexList(mesh.geometry);
    const result = sliceTriangleSoup({ verts, tris }, plane);
    if (!result) return null;
    if (result.positive.body.length + result.positive.cap.length === 0) return null;
    if (result.negative.body.length + result.negative.cap.length === 0) return null;

    const stumpGeo = buildGeometryFromSlice(this.three, result.negative);
    const pieceGeo = buildGeometryFromSlice(this.three, result.positive);

    const bodyMaterial = this._cloneBodyMaterial(mesh.material);
    const stumpMesh = new this.three.Mesh(stumpGeo, [bodyMaterial, this._makeCapMaterial()]);
    const pieceMesh = new this.three.Mesh(pieceGeo, [bodyMaterial.clone(), this._makeCapMaterial()]);

    this.scene.add(stumpMesh);
    this.scene.add(pieceMesh);

    const velocity = Array.isArray(options.impulse) ? [options.impulse[0], options.impulse[1], options.impulse[2]] : [0, 0, 0];
    pieceMesh.userData.gore = { velocity };
    // geometry is baked in WORLD space (§1 "world transforms baked"), so the
    // mesh's own .position starts at (0,0,0) and is a pure ADDITIVE offset on
    // top of that baked height. "ground y=0 rest" (§1) is an ABSOLUTE world
    // constraint, so ground contact must compare against the piece's baked
    // lowest vertex, not against a naive position.y<=0.
    pieceGeo.computeBoundingBox();
    const groundOffset = -pieceGeo.boundingBox.min.y;
    this.pieces.push({ mesh: pieceMesh, velocity, groundOffset });

    return { stump: stumpMesh, piece: pieceMesh };
  }

  /** §1 gravity, ground y=0 rest, damping -- reads velocity from userData.gore.velocity IN PLACE each call (caller may overwrite it). */
  update(dt) {
    for (const rec of this.pieces) {
      const v = rec.mesh.userData.gore.velocity;
      v[1] -= GRAVITY * dt;
      rec.mesh.position.x += v[0] * dt;
      rec.mesh.position.y += v[1] * dt;
      rec.mesh.position.z += v[2] * dt;
      if (rec.mesh.position.y <= rec.groundOffset) {
        rec.mesh.position.y = rec.groundOffset;
        if (v[1] < 0) v[1] = 0;
        v[0] *= BOUNCE_DAMPING; v[2] *= BOUNCE_DAMPING;
      }
    }
  }

  stats() { return this.pieces.length; }

  _disposeMesh(mesh) {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
  }

  dispose() {
    for (const rec of this.pieces) this._disposeMesh(rec.mesh);
    for (const mesh of this.stumps) this._disposeMesh(mesh);
    this.pieces = []; this.stumps = [];
  }
}
