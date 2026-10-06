// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
//
// §4 hard limit: every material/geometry this extension creates ≤ 6 vertex
// buffers, including instanced attrs (WebGPU device max is 8; the spec cites a
// live black-screen bug at 9). A "vertex buffer" here = one BufferAttribute /
// InstancedBufferAttribute the render pipeline must bind per draw: every key
// in geometry.attributes, PLUS the mesh's own instanceMatrix (mat4, one
// binding) and instanceColor when present, PLUS any attribute this module
// bolts on directly on top for per-instance packed data (already inside
// geometry.attributes for standard three InstancedMesh usage, so this walk
// only counts each buffer once).

/**
 * Count the vertex buffers a single Mesh/InstancedMesh will bind.
 * @param {import('three').Mesh} mesh
 * @returns {number}
 */
export function countVertexBuffers(mesh) {
  const geo = mesh.geometry;
  if (!geo) return 0;
  let n = Object.keys(geo.attributes ?? {}).length;
  if (mesh.isInstancedMesh) {
    if (mesh.instanceMatrix) n += 1;
    if (mesh.instanceColor) n += 1;
  }
  return n;
}

/**
 * Audit every mesh the extension owns against the §4 budget.
 * @param {import('three').Mesh[]} meshes
 * @param {number} [limit=6]
 * @returns {{ mesh, count, over }[]} entries whose count exceeds the limit
 */
export function auditVertexBudget(meshes, limit = 6) {
  return meshes
    .map((mesh) => ({ mesh, count: countVertexBuffers(mesh), over: countVertexBuffers(mesh) > limit }))
    .filter((e) => e.over);
}
