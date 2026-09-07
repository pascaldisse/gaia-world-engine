// Mesh-local nose → player convention (-Z at yaw zero). Default preserves authored GAIA bodies.
export function presenceRenderYaw(yaw, mesh) {
  const forward = mesh?.forward ?? '+Z';
  if (!Number.isFinite(yaw)) throw Error('Presence yaw must be finite');
  if (forward === '-Z') return yaw;
  if (forward === '+Z') return yaw + Math.PI;
  throw Error(`Unsupported mesh.forward: ${forward}`);
}

// Ground-relative controller eye ↔ native chassis render-root translation.
export function vehicleRootOffset(vehicle) {
  const value=vehicle?.rootOffsetY??0;
  if(!Number.isFinite(value))throw Error('Vehicle root offset must be finite');
  return value;
}
