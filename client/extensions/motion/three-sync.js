// GAIA-World-Engine motion extension · OPTIONAL three.js helper (no import of three; duck-typed Object3D).
// syncThree(handle, map: {bodyName → Object3D}) — copies world transforms (object must be a scene-root child or have identity parents).
export function syncThree(handle, map, cache) {
  const tr = handle.transforms(cache);
  for (const [name, o] of Object.entries(map)) {
    const t = tr.get(name); if (!t || !o) continue;
    o.position.set(t.p[0], t.p[1], t.p[2]); o.quaternion.set(t.q[0], t.q[1], t.q[2], t.q[3]);
  }
  return tr;
}
