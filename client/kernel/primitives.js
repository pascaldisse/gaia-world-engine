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
    const parent = parentId ? this.view.getGroup(parentId) : this.view.scene;
    // Missing parents leave the child in the scene root: load order cannot
    // make a valid entity disappear, and the next frame heals the link.
    const target = parent ?? this.view.scene;
    if (child.parent === target) return;
    target.attach(child); // preserves world pose during streamed parent arrival
    if (parent) {
      const local = spec?.local ?? true;
      if (local) this.applyLocal(child, this.store.get(id)?.transform);
    }
  }

  detachAll() {
    for (const group of this.view.groups.values()) {
      if (group.parent && group.parent !== this.view.scene) this.view.scene.attach(group);
    }
  }

  applyLocal(group, transform = {}) {
    const [x, y, z] = transform.position ?? [0, 0, 0];
    const [rx, ry, rz] = transform.rotation ?? [0, 0, 0];
    const scale = transform.scale ?? 1;
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
