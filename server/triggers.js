import { inArea } from '../shared/scenes.js';
import { matchesWhen, substitute } from '../shared/ops.js';
import { r2 } from '../shared/num.js';

// Trigger volumes: world logic as data. An entity with a `trigger` component
// watches every presence (players, agents); when one enters its area the
// trigger fires its ops — with `$now` replaced by world time and `$id` by
// the entity that entered — and/or emits an event. The first sliver of M9,
// forced by the opening's boatman rescue.
//
// trigger: { area: {center:[x,z], radius | size:[sx,sz]}, yMin?, yMax?,
//            on?: 'enter'|'exit', when?: {"entity.component.path": value},
//            cooldown?: seconds, event?: {name, data}, ops?: [...] }
// `when` gates firing on world state — shortcut doors, quest flags.
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
    const withCenter = area.center ? area : { ...area, center: comps.transform?.position?.filter((_, i) => i !== 1) };
    if (!inArea(withCenter, x, z)) return false;
    if (trig.yMin !== undefined && y < trig.yMin) return false;
    if (trig.yMax !== undefined && y > trig.yMax) return false;
    return true;
  }

  tick() {
    // one motion-math pass per presence, not per trigger×presence
    const presences = [];
    for (const [pid, pcomps] of this.world.entities) {
      if (pcomps.presence) presences.push([pid, this.sense.positionOf(pcomps)]);
    }
    for (const [tid, comps] of this.world.entities) {
      const trig = comps.trigger;
      if (!trig) continue;
      for (const [pid, [px, py, pz]] of presences) {
        if (pid === tid) continue;
        const key = `${tid}|${pid}`;
        const inside = this.contains(trig, comps, px, py, pz);
        const was = this.inside.get(key) ?? false;
        this.inside.set(key, inside);
        const edge = (trig.on ?? 'enter') === 'exit' ? was && !inside : inside && !was;
        if (!edge) continue;
        if (trig.when && !this.matches(trig.when)) continue;
        const last = this.lastFired.get(tid) ?? -Infinity;
        if (this.now() - last < (trig.cooldown ?? 0)) continue;
        this.fire(tid, trig, pid);
      }
    }
    // disconnected presences (and despawned triggers) must not grow the map forever
    for (const key of this.inside.keys()) {
      const [tid, pid] = key.split('|');
      if (!this.world.entities.has(tid) || !this.world.entities.has(pid)) this.inside.delete(key);
    }
  }

  // "world-state.state.gate": "open" → entity world-state, component state,
  // key gate must equal "open" — the shared rule the client's E-prompt uses too
  matches(when) {
    return matchesWhen(when, (id) => this.world.entities.get(id));
  }

  // Press-E world logic: an `interact` component fires when a presence USES
  // the entity on purpose (client sends {op:'use', id, by}) instead of by
  // walking somewhere. Same rules as trigger volumes — when gates, cooldown,
  // $now/$id substitution. Returns the expanded ops (empty = refused).
  use(tid, pid) {
    const comps = this.world.entities.get(tid);
    const act = comps?.interact;
    if (!act) return [];
    const user = pid ? this.world.entities.get(pid) : null;
    if (!user) return [];
    const [px, py, pz] = this.sense.positionOf(user);
    const [x, y, z] = this.sense.positionOf(comps);
    // +2m slack: presence positions publish at 300ms — don't refuse a
    // player the client already showed the prompt to
    if (Math.hypot(px - x, py - y, pz - z) > (act.radius ?? 4) + 2) return [];
    if (act.when && !this.matches(act.when)) return [];
    const last = this.lastFired.get(tid) ?? -Infinity;
    if (this.now() - last < (act.cooldown ?? 0)) return [];
    this.lastFired.set(tid, this.now());
    const ops = [
      { op: 'event', name: act.event?.name ?? 'use', data: { ...(act.event?.data ?? {}), target: tid, by: pid } },
    ];
    for (const op of act.ops ?? []) ops.push(this.substitute(op, pid));
    console.log(`[gaia] use ${tid} (by ${pid})`);
    return ops;
  }

  fire(tid, trig, pid) {
    this.lastFired.set(tid, this.now());
    const ops = [];
    if (trig.event) {
      ops.push({ op: 'event', name: trig.event.name ?? 'trigger', data: { ...(trig.event.data ?? {}), trigger: tid, by: pid } });
    }
    for (const op of trig.ops ?? []) ops.push(this.substitute(op, pid));
    if (ops.length) {
      this.apply(ops, `trigger:${tid}`);
      console.log(`[gaia] trigger ${tid} fired (by ${pid})`);
    }
  }

  substitute(op, pid) {
    return substitute(structuredClone(op), { $now: r2(this.now()), $id: pid });
  }
}
