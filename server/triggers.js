// Trigger volumes: world logic as data. An entity with a `trigger` component
// watches every presence (players, agents); when one enters its area the
// trigger fires its ops — with `$now` replaced by world time and `$id` by
// the entity that entered — and/or emits an event. The first sliver of M9,
// forced by the opening's boatman rescue.
//
// trigger: { area: {center:[x,z], radius | size:[sx,sz]}, yMin?, yMax?,
//            cooldown?: seconds, event?: {name, data}, ops?: [...] }
export class Triggers {
  constructor({ world, sense, apply, now }) {
    this.world = world;
    this.sense = sense;
    this.apply = apply;
    this.now = now;
    this.inside = new Map(); // "trigger|presence" → bool
    this.lastFired = new Map(); // trigger id → world time
  }

  contains(trig, comps, x, y, z) {
    const area = trig.area;
    if (!area) return false;
    const [cx, cz] = area.center ?? comps.transform?.position?.filter((_, i) => i !== 1) ?? [0, 0];
    if (area.radius) {
      if (Math.hypot(x - cx, z - cz) > area.radius) return false;
    } else {
      const [sx, sz] = area.size ?? [10, 10];
      if (Math.abs(x - cx) > sx / 2 || Math.abs(z - cz) > sz / 2) return false;
    }
    if (trig.yMin !== undefined && y < trig.yMin) return false;
    if (trig.yMax !== undefined && y > trig.yMax) return false;
    return true;
  }

  tick() {
    for (const [tid, comps] of this.world.entities) {
      const trig = comps.trigger;
      if (!trig) continue;
      for (const [pid, pcomps] of this.world.entities) {
        if (!pcomps.presence || pid === tid) continue;
        const [px, py, pz] = this.sense.positionOf(pcomps);
        const key = `${tid}|${pid}`;
        const inside = this.contains(trig, comps, px, py, pz);
        const was = this.inside.get(key) ?? false;
        this.inside.set(key, inside);
        if (!inside || was) continue;
        const last = this.lastFired.get(tid) ?? -Infinity;
        if (this.now() - last < (trig.cooldown ?? 0)) continue;
        this.fire(tid, trig, pid);
      }
    }
  }

  fire(tid, trig, pid) {
    this.lastFired.set(tid, this.now());
    const ops = [];
    if (trig.event) {
      ops.push({ op: 'event', name: trig.event.name ?? 'trigger', data: { ...(trig.event.data ?? {}), trigger: tid, by: pid } });
    }
    for (const op of trig.ops ?? []) ops.push(this.substitute(structuredClone(op), pid));
    if (ops.length) {
      this.apply(ops, `trigger:${tid}`);
      console.log(`[gaia] trigger ${tid} fired (by ${pid})`);
    }
  }

  substitute(value, pid) {
    if (value === '$now') return Math.round(this.now() * 100) / 100;
    if (value === '$id') return pid;
    if (Array.isArray(value)) return value.map((v) => this.substitute(v, pid));
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) value[k] = this.substitute(value[k], pid);
    }
    return value;
  }
}
