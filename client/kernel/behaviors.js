import { heightAt } from './terrain.js';

// Data-driven display behaviors. Parameters live in the behavior component,
// so any client (or agent) can retune motion with a single patch op.
export class Behaviors {
  constructor({ store, view }) {
    this.store = store;
    this.view = view;
    this.time = 0;
  }

  update(dt) {
    this.time += dt;
    for (const [id, components] of this.store.entities) {
      const spec = components.behavior;
      if (!spec) continue;
      if (this.view.suppressed.has(id)) continue;
      const group = this.view.getGroup(id);
      if (!group) continue;
      const list = Array.isArray(spec) ? spec : [spec];
      for (const b of list) this.run(b, id, group, dt);
    }
  }

  run(b, id, group, dt) {
    const base = group.userData.base ?? { position: [0, 0, 0], scale: 1 };
    switch (b.type) {
      case 'spin':
        group.rotation.y += (b.speed ?? 1) * dt;
        break;
      case 'bob':
        group.position.y =
          base.position[1] + Math.sin(this.time * (b.speed ?? 1) + (b.phase ?? 0)) * (b.amplitude ?? 0.5);
        break;
      case 'orbit': {
        const [cx, cy, cz] = b.center ?? [0, 0, 0];
        const angle = this.time * (b.speed ?? 0.3) + (b.phase ?? 0);
        const radius = b.radius ?? 10;
        const px = cx + Math.cos(angle) * radius;
        const pz = cz + Math.sin(angle) * radius;
        const py = b.ground ? heightAt(px, pz) + (b.height ?? 0) : cy + (b.height ?? 0);
        group.position.set(px, py, pz);
        break;
      }
      case 'pulse': {
        const k = 1 + Math.sin(this.time * (b.speed ?? 2)) * (b.amount ?? 0.08);
        const s = base.scale;
        if (Array.isArray(s)) group.scale.set(s[0] * k, s[1] * k, s[2] * k);
        else group.scale.setScalar(s * k);
        break;
      }
      case 'flicker': {
        const light = this.view.getLight(id);
        if (!light) break;
        const baseIntensity = light.userData.baseIntensity ?? light.intensity;
        const noise = Math.sin(this.time * 31) * 0.5 + Math.sin(this.time * 47 + 1.3) * 0.5;
        light.intensity = baseIntensity * (1 + noise * (b.amount ?? 0.25));
        break;
      }
    }
  }
}
