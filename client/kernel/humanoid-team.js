// Humanoid kit — team-colour slot (stage 5). glTF material extras `ee.teamMask {index, channel:'R'}` (or flat
// `teamMask`) name a texture whose R channel marks the texels `colors.team` tints (multiply). GLTFLoader doesn't
// bind extras to textures, so the index is resolved through the parser once per template.
//   ONE team-capable node material per SOURCE material (shared, refcounted) serves EVERY team colour: the colour
//   is a PER-OBJECT uniform read from mesh.userData.teamColor ⇒ 200 units × 4 teams = 1 material, 0 clones per colour.
//   WebGPU node material (client renderer); headless/no-TSL ⇒ acquireTeamMaterial → null and the caller falls
//   back to the plain (material,hex) tint.
const teamMaskDef = (m) => m.userData?.ee?.teamMask ?? m.userData?.teamMask ?? null;

// material.uuid → THREE.Texture for every material of `scene` that declares a team mask
export async function loadTeamMasks(scene, gltf) {
  const out = new Map();
  if (!gltf?.parser) return out;
  const mats = new Set();
  scene.traverse((o) => { for (const m of [].concat(o.material ?? [])) mats.add(m); });
  for (const m of mats) {
    const def = teamMaskDef(m);
    if (!def || !Number.isInteger(def.index)) continue;
    try {
      const tex = await gltf.parser.getDependency('texture', def.index);
      if (tex) { tex.userData.shared = true; out.set(m.uuid, tex); }
    } catch (error) { console.warn('[humanoid] team mask failed to load', error); }
  }
  return out;
}

const TEAM = new Map(); // `team|${srcUuid}` → { material, refs }
let tslPromise = null;
const loadTsl = () => (tslPromise ??= Promise.all([import('three/webgpu'), import('three/tsl')]).then(([w, t]) => ({ ...w, ...t })).catch(() => null));

export async function acquireTeamMaterial(src, mask) {
  const key = `team|${src.uuid}`;
  let e = TEAM.get(key);
  if (!e) {
    const T = await loadTsl();
    if (!T?.MeshStandardNodeMaterial) return null;
    if ((e = TEAM.get(key))) { e.refs++; return { key, material: e.material }; } // raced while importing
    const m = new T.MeshStandardNodeMaterial();
    for (const k in src) if (k !== 'uuid' && k !== 'id' && k !== 'type' && k !== 'userData') m[k] = src[k]; // as NodeLibrary.fromMaterial
    m.userData = { ...src.userData, shared: true, humanoidTeam: true };
    const team = T.uniform(new T.Color('#ffffff')).onObjectUpdate(({ object }, self) => { self.value.set(object.userData.teamColor ?? '#ffffff'); });
    const k = T.texture(mask, T.uv()).r;
    m.colorNode = T.vec4(T.materialColor.rgb.mul(T.mix(T.vec3(1, 1, 1), team, k)), T.materialColor.a);
    m.name = `${src.name}@team`;
    TEAM.set(key, (e = { material: m, refs: 0 }));
  }
  e.refs++;
  return { key, material: e.material };
}

export function releaseTeamMaterial(key) {
  const e = TEAM.get(key);
  if (!e) return;
  if (--e.refs <= 0) { TEAM.delete(key); e.material.dispose(); }
}

export const teamMaterialStats = () => ({ materials: TEAM.size, refs: [...TEAM.values()].reduce((s, e) => s + e.refs, 0) });
