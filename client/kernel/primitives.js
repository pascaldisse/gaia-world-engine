import * as THREE from 'three/webgpu';

// Opt-in entity mechanics. A world enables this kernel with
// `world.features.primitives: true`; worlds without that exact flag remain
// byte-for-byte on their historical scene graph path.
export class PrimitiveRuntime {
  constructor({ store, view, clock, send }) {
    this.store = store;
    this.view = view;
    this.clock = clock;
    this.send = send;
    this.enabled = false;
    this.expired = new Set();
    this.births = new Map();
    this.position = new THREE.Vector3();
    this.rotation = new THREE.Quaternion();
    this.euler = new THREE.Euler();
    this.scale = new THREE.Vector3();
    this.local = new THREE.Matrix4();
    this.world = new THREE.Matrix4();
  }

  setWorld(world) {
    this.enabled = world?.features?.primitives === true;
    this.expired.clear();
    this.births.clear();
    if (!this.enabled) this.detachAll();
  }

  update() {
    if (!this.enabled) return;
    const now = this.clock.now();
    for (const [id, components] of this.store.entities) {
      this.attach(id, components.attach);
      this.expire(id, components.lifecycle, now);
      this.phase(id, components.mesh, now);
    }
  }

  attach(id, spec) {
    const child = this.view.getGroup(id);
    if (!child) return;
    const parentId = typeof spec?.parent === 'string' ? spec.parent : null;
    if (!parentId || parentId === id) {
      if (child.userData.base) this.applyLocal(child, child.userData.base);
      return;
    }
    this.inherit(id, new Set());
  }

  // Entity groups stay direct scene children. View owns their teardown and
  // rebuild path, so physical Object3D reparenting would leave stale children
  // behind on a mesh edit. Matrix inheritance gives the same authored result
  // without changing View's ownership invariant.
  inherit(id, visiting) {
    if (visiting.has(id)) return;
    visiting.add(id);
    const child = this.view.getGroup(id);
    const spec = this.store.get(id)?.attach;
    const parentId = typeof spec?.parent === 'string' ? spec.parent : null;
    const parent = parentId && parentId !== id ? this.view.getGroup(parentId) : null;
    if (!child || !parent) return;
    this.inherit(parentId, visiting);
    const base = child.userData.base;
    if (!base) return;
    this.local.compose(
      this.position.fromArray(base.position),
      this.rotation.setFromEuler(this.euler.fromArray(base.rotation)),
      this.scale.set(...(Array.isArray(base.scale) ? base.scale : [base.scale, base.scale, base.scale])),
    );
    parent.updateMatrixWorld(true);
    this.world.multiplyMatrices(parent.matrixWorld, this.local).decompose(child.position, child.quaternion, child.scale);
  }

  detachAll() {
    for (const group of this.view.groups.values()) {
      if (group.userData.base) this.applyLocal(group, group.userData.base);
    }
  }

  applyLocal(group, transform = {}) {
    const [x, y, z] = transform?.position ?? [0, 0, 0];
    const [rx, ry, rz] = transform?.rotation ?? [0, 0, 0];
    const scale = transform?.scale ?? 1;
    group.position.set(x, y, z);
    group.rotation.set(rx, ry, rz);
    if (Array.isArray(scale)) group.scale.set(...scale);
    else group.scale.setScalar(scale);
  }

  expire(id, spec, now) {
    if (!Number.isFinite(spec?.ttl) || spec.ttl < 0 || this.expired.has(id)) return;
    // `bornAt` is authored by the spawning authority; absent timestamps start
    // at first client observation, intentionally making legacy data harmless.
    const bornAt = Number.isFinite(spec.bornAt)
      ? spec.bornAt
      : (this.births.get(id) ?? this.births.set(id, now).get(id));
    if (now < bornAt + spec.ttl) return;
    this.expired.add(id);
    this.send([{ op: 'despawn', id }]);
  }

  phase(id, mesh, now) {
    const group = this.view.getGroup(id);
    if (!group || !mesh) return;
    const parts = mesh.parts ?? [mesh];
    const rendered = group.children.filter((child) => child.userData.kind === 'mesh-part');
    for (let index = 0; index < Math.min(parts.length, rendered.length); index++) {
      const authored = parts[index];
      const phase = authored.phase;
      if (!phase || phase.enabled === false) continue;
      const spec = phase.states?.[phase.state] ?? phase;
      const part = rendered[index];
      const amplitude = spec.amplitude ?? 0;
      const speed = spec.speed ?? 1;
      const offset = spec.offset ?? 0;
      const wave = Math.sin(now * speed + offset);
      if (spec.state === 'hidden') part.visible = false;
      else part.visible = true;
      if (spec.axis === 'scale') {
        const base = spec.base ?? (Array.isArray(authored.scale) ? authored.scale[1] : authored.scale ?? 1);
        part.scale.setScalar(base + wave * amplitude);
      } else if (spec.axis === 'rotation') {
        part.rotation.y = (spec.base ?? authored.rotation?.[1] ?? 0) + wave * amplitude;
      } else {
        part.position.y = (spec.base ?? authored.position?.[1] ?? 0) + wave * amplitude;
      }
    }
  }
}
