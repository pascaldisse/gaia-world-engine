import { animatedPosition, hasMotion, behaviorList } from '../../shared/motion.js';
import { heightAt } from './terrain.js';

// Data-driven display behaviors. Orbit/bob positions come from the shared
// world-clock motion math, so every client — and the server's senses — agree.
export class Behaviors {
  constructor({ store, view, clock }) {
    this.store = store;
    this.view = view;
    this.clock = clock;
  }

  update(dt) {
    const t = this.clock.now();
    for (const [id, components] of this.store.entities) {
      const spec = components.behavior;
      if (!spec) continue;
      if (this.view.suppressed.has(id)) continue;
      const group = this.view.getGroup(id);
      if (!group) continue;
      const list = behaviorList(components);
      if (hasMotion(components)) {
        const [x, y, z] = animatedPosition(components, t, heightAt);
        group.position.set(x, y, z);
        // path followers face their direction of travel (+z leads)
        if (list.some((b) => b.type === 'path')) {
          const [nx, , nz] = animatedPosition(components, t + 0.4, heightAt);
          const dx = nx - x;
          const dz = nz - z;
          if (dx * dx + dz * dz > 0.0004) group.rotation.y = Math.atan2(dx, dz);
        }
      }
      for (const b of list) this.run(b, id, group, dt, t);
    }
  }

  run(b, id, group, dt, t) {
    const base = group.userData.base ?? { position: [0, 0, 0], scale: 1 };
    switch (b.type) {
      case 'spin':
        group.rotation.y += (b.speed ?? 1) * dt;
        break;
      case 'pulse': {
        const k = 1 + Math.sin(t * (b.speed ?? 2)) * (b.amount ?? 0.08);
        const s = base.scale;
        if (Array.isArray(s)) group.scale.set(s[0] * k, s[1] * k, s[2] * k);
        else group.scale.setScalar(s * k);
        break;
      }
      case 'flicker': {
        const light = this.view.getLight(id);
        if (!light) break;
        const baseIntensity = light.userData.baseIntensity ?? light.intensity;
        const noise = Math.sin(t * 31) * 0.5 + Math.sin(t * 47 + 1.3) * 0.5;
        light.intensity = baseIntensity * (1 + noise * (b.amount ?? 0.25));
        break;
      }
    }
  }
}
