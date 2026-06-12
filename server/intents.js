import { r2 } from '../shared/num.js';

const DEFAULT_AGENT = 'agent-claude';

// Agents act through the same world physics the player does: terrain-following
// movement at finite speed, streamed as ops every tick so every client watches
// the avatar actually travel.
export class Intents {
  constructor({ world, apply, sense }) {
    this.world = world;
    this.apply = apply;
    this.sense = sense;
    this.active = new Map();
    this.holding = new Map();
  }

  ensureAvatar(id) {
    if (this.world.entities.has(id)) return;
    this.apply(
      [
        {
          op: 'spawn',
          id,
          components: {
            presence: { kind: 'agent', yaw: 0 },
            transform: { position: [2, 0, 16] },
            ground: { offset: 1.4 },
            mesh: {
              parts: [
                {
                  shape: 'sphere',
                  radius: 0.32,
                  color: '#dff6ff',
                  emissive: '#9fe8ff',
                  emissiveIntensity: 2.2,
                  castShadow: false,
                },
              ],
            },
            light: { type: 'point', color: '#9fe8ff', intensity: 14, distance: 14 },
            behavior: { type: 'bob', amplitude: 0.18, speed: 1.4 },
          },
        },
      ],
      'intents',
    );
  }

  positionOf(id) {
    // the senses' motion math — grab/face range agrees with what agents see
    const comps = this.world.entities.get(id);
    return comps ? this.sense.positionOf(comps) : [0, 0, 0];
  }

  run(cmd) {
    const as = cmd.as ?? DEFAULT_AGENT;
    this.ensureAvatar(as);
    switch (cmd.intent) {
      case 'move_to': {
        if (typeof cmd.x !== 'number' || typeof cmd.z !== 'number') throw new Error('move_to needs x and z');
        this.active.get(as)?.resolve?.({ status: 'superseded' });
        return new Promise((resolve) => {
          this.active.set(as, {
            kind: 'move_to',
            x: cmd.x,
            z: cmd.z,
            speed: cmd.speed ?? 4,
            deadline: Date.now() + 90000,
            resolve,
          });
        });
      }
      case 'walk': {
        const len = Math.hypot(cmd.dx ?? 0, cmd.dz ?? 0) || 1;
        this.active.get(as)?.resolve?.({ status: 'superseded' });
        return new Promise((resolve) => {
          this.active.set(as, {
            kind: 'walk',
            dx: (cmd.dx ?? 0) / len,
            dz: (cmd.dz ?? 0) / len,
            speed: cmd.speed ?? 4,
            until: Date.now() + (cmd.seconds ?? 2) * 1000,
            resolve,
          });
        });
      }
      case 'face': {
        let yaw = cmd.yaw;
        if (cmd.id) {
          const target = this.world.entities.get(cmd.id);
          if (!target) throw new Error(`no entity ${cmd.id}`);
          const [ax, , az] = this.positionOf(as);
          const [tx, , tz] = this.positionOf(cmd.id);
          yaw = Math.atan2(-(tx - ax), -(tz - az));
        }
        if (typeof yaw !== 'number') throw new Error('face needs id or yaw');
        this.apply([{ op: 'merge', id: as, component: 'presence', value: { yaw: r2(yaw) } }], 'intents');
        return { status: 'facing', yaw: r2(yaw) };
      }
      case 'grab': {
        if (!this.world.entities.has(cmd.id)) throw new Error(`no entity ${cmd.id}`);
        const [ax, , az] = this.positionOf(as);
        const [tx, , tz] = this.positionOf(cmd.id);
        if (Math.hypot(tx - ax, tz - az) > 4) throw new Error(`${cmd.id} is out of reach (move closer)`);
        this.holding.set(as, cmd.id);
        this.event({ name: 'grab', agent: as, target: cmd.id });
        return { status: 'holding', id: cmd.id };
      }
      case 'drop': {
        const held = this.holding.get(as);
        this.holding.delete(as);
        if (held) this.event({ name: 'drop', agent: as, target: held });
        return { status: 'dropped', id: held ?? null };
      }
      case 'say': {
        this.event({ name: 'say', agent: as, text: String(cmd.text ?? '') });
        return { status: 'said' };
      }
      default:
        throw new Error(`unknown intent ${cmd.intent}`);
    }
  }

  event(data) {
    this.apply([{ op: 'event', name: data.name, data }], 'intents');
  }

  tick(dt) {
    for (const [as, task] of [...this.active]) {
      const comps = this.world.entities.get(as);
      if (!comps) {
        this.active.delete(as);
        task.resolve?.({ status: 'lost' });
        continue;
      }
      const [x, , z] = comps.transform?.position ?? [0, 0, 0];
      let status = null;

      if (task.kind === 'move_to') {
        const dx = task.x - x;
        const dz = task.z - z;
        const d = Math.hypot(dx, dz);
        if (d < 0.35) status = 'arrived';
        else if (Date.now() > task.deadline) status = 'timeout';
        else {
          const step = Math.min(d, task.speed * dt);
          this.applyMove(as, x + (dx / d) * step, z + (dz / d) * step, Math.atan2(-dx / d, -dz / d));
        }
      } else if (task.kind === 'walk') {
        if (Date.now() >= task.until) status = 'done';
        else this.applyMove(as, x + task.dx * task.speed * dt, z + task.dz * task.speed * dt, Math.atan2(-task.dx, -task.dz));
      }

      if (status) {
        this.active.delete(as);
        const at = this.positionOf(as).map(r2);
        this.event({ name: 'intent', agent: as, status, at });
        task.resolve?.({ status, position: at });
      }
    }

    for (const [as, heldId] of this.holding) {
      const comps = this.world.entities.get(as);
      const held = this.world.entities.get(heldId);
      if (!comps || !held) {
        this.holding.delete(as);
        continue;
      }
      const [x, y, z] = this.positionOf(as);
      const yaw = comps.presence?.yaw ?? 0;
      this.apply(
        [
          {
            op: 'merge',
            id: heldId,
            component: 'transform',
            value: { position: [r2(x - Math.sin(yaw) * 1.6), r2(y), r2(z - Math.cos(yaw) * 1.6)] },
          },
        ],
        'intents',
      );
    }
  }

  applyMove(as, x, z, yaw) {
    this.apply(
      [
        { op: 'merge', id: as, component: 'transform', value: { position: [r2(x), 0, r2(z)] } },
        { op: 'merge', id: as, component: 'presence', value: { yaw: r2(yaw) } },
      ],
      'intents',
    );
  }
}
