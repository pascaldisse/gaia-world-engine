import * as THREE from 'three/webgpu';

// `transmission` is part-data, not a global renderer switch. Its fields map
// directly to MeshPhysicalMaterial and therefore remain serializable world data.
export function makeTransmissionMaterial(part) {
  const spec = part.transmission;
  if (!spec || spec.enabled === false) return null;
  const material = new THREE.MeshPhysicalMaterial({
    color: spec.color ?? part.color ?? '#dcefff',
    roughness: spec.roughness ?? part.roughness ?? 0.12,
    metalness: spec.metalness ?? part.metalness ?? 0,
    transmission: spec.amount ?? 1,
    thickness: spec.thickness ?? 0.5,
    ior: spec.ior ?? 1.45,
    attenuationColor: spec.attenuationColor ?? '#ffffff',
    attenuationDistance: spec.attenuationDistance ?? Infinity,
    transparent: true,
    opacity: spec.opacity ?? part.opacity ?? 1,
  });
  if (spec.clearcoat !== undefined) material.clearcoat = spec.clearcoat;
  if (spec.clearcoatRoughness !== undefined) material.clearcoatRoughness = spec.clearcoatRoughness;
  if (part.fog === false) material.fog = false;
  if (part.doubleSide) material.side = THREE.DoubleSide;
  return material;
}
