import { terrainHeight } from '../shared/noise.js';
import { animatedPosition } from '../shared/motion.js';

// Perception without pixels: the same world documents the renderer draws are
// summarized into compact text frames, queries, maps, and sanity checks.
export class Sense {
  constructor(world, now = () => 0) {
    this.world = world;
    this.now = now;
  }

  terrainParams() {
    for (const comps of this.world.entities.values()) {
      if (comps.terrain) return comps.terrain;
    }
    return null;
  }

  groundAt(x, z) {
    return terrainHeight(x, z, this.terrainParams());
  }

  positionOf(comps) {
    // world-clock motion math: orbiting/bobbing entities sense at their live position
    return animatedPosition(comps, this.now(), (x, z) => this.groundAt(x, z));
  }

  poseOf(as) {
    const comps = this.world.entities.get(as);
    if (!comps) return null;
    const [x, y, z] = this.positionOf(comps);
    return { x, y: y + 1.2, z, yaw: comps.presence?.yaw ?? 0 };
  }

  look({ as, x = 0, y = 2, z = 0, yaw = 0, fov = 110, range = 60 } = {}) {
    if (as) {
      const pose = this.poseOf(as);
      if (pose) ({ x, y, z, yaw } = pose);
    }
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const seen = [];
    const heard = [];

    for (const [id, comps] of this.world.entities) {
      if (id === as || comps.terrain) continue;
      const [ex, ey, ez] = this.positionOf(comps);
      const dx = ex - x;
      const dy = ey - y;
      const dz = ez - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > range) continue;
      const flat = Math.hypot(dx, dz) || 0.0001;
      const nx = dx / flat;
      const nz = dz / flat;
      const cross = fx * nz - fz * nx;
      const dot = fx * nx + fz * nz;
      const bearing = (Math.atan2(cross, dot) * 180) / Math.PI;
      const entry = { id, comps, d, bearing };
      if (comps.sound && d <= 40) heard.push(entry);
      if (Math.abs(bearing) <= fov / 2 || d < 2.5) {
        entry.salience = this.salience(comps, d);
        seen.push(entry);
      }
    }

    seen.sort((a, b) => b.salience - a.salience);
    heard.sort((a, b) => a.d - b.d);

    const ground = this.groundAt(x, z);
    const slope =
      (Math.abs(this.groundAt(x + 2, z) - ground) + Math.abs(this.groundAt(x, z + 2) - ground)) / 4;
    const lines = [];
    lines.push(
      `pose (${r1(x)}, ${r1(y)}, ${r1(z)}) facing ${compass(yaw)} · ground ${r1(ground)}m, slope ${slope < 0.08 ? 'flat' : slope < 0.25 ? 'gentle' : 'steep'} · ${this.world.entities.size} entities in world`,
    );
    if (!seen.length) lines.push('nothing visible within range');
    for (const e of seen.slice(0, 12)) {
      lines.push(`${dirWord(e.bearing)} ${r1(e.d)}m: ${e.id} — ${this.describe(e.comps)}`);
    }
    if (heard.length) {
      lines.push(
        `hearing: ${heard
          .slice(0, 5)
          .map((e) => `${e.id} (${soundWord(e.comps.sound)}, ${r1(e.d)}m ${dirWord(e.bearing)})`)
          .join(' · ')}`,
      );
    }
    return lines.join('\n');
  }

  salience(comps, d) {
    let size = 1;
    for (const part of comps.mesh?.parts ?? []) {
      size = Math.max(size, ...(part.size ?? []), (part.radius ?? 0) * 2, part.height ?? 0);
    }
    const scale = comps.transform?.scale;
    if (typeof scale === 'number') size *= scale;
    let bonus = 1;
    if (comps.light) bonus += 0.8;
    if (comps.sound) bonus += 0.5;
    if (comps.behavior) bonus += 0.5;
    if (comps.presence) bonus += 1;
    for (const part of comps.mesh?.parts ?? []) if (part.emissive) bonus += 0.6;
    return (size * bonus) / Math.max(1, d);
  }

  describe(comps) {
    const bits = [];
    if (comps.presence) bits.push(`${comps.presence.kind ?? 'someone'} avatar`);
    const parts = comps.mesh?.parts ?? [];
    if (parts.length) {
      const shapes = [...new Set(parts.map((p) => p.shape ?? 'box'))].join('+');
      const main = parts[0];
      const glow = parts.some((p) => p.emissive);
      bits.push(`${shapes}${main.color ? ` ${main.color}` : ''}${glow ? ', glowing' : ''}`);
    }
    if (comps.light) bits.push(`sheds ${comps.light.color ?? 'white'} light`);
    if (comps.sound) bits.push(soundWord(comps.sound));
    const behaviors = comps.behavior ? (Array.isArray(comps.behavior) ? comps.behavior : [comps.behavior]) : [];
    if (behaviors.length) bits.push(behaviors.map((b) => b.type).join('+'));
    if (comps.terrain) bits.push(`terrain seed ${comps.terrain.seed}`);
    if (comps.scatter) {
      bits.push(`scatter of ~${comps.scatter.count ?? 100} across ${comps.scatter.area?.radius ?? 60}m`);
    }
    if (comps.particles) {
      bits.push(`${comps.particles.count ?? 100} ${comps.particles.motion?.type ?? 'drift'} particles`);
    }
    if (comps.environment) bits.push('environment settings (fog, sky, sun, bloom)');
    if (comps.weather) {
      bits.push(`weather (rain ${comps.weather.rain ?? 0}${comps.weather.lightning !== false ? ', lightning' : ''})`);
    }
    if (comps.sfx) bits.push(`sfx on "${comps.sfx.on}"`);
    return bits.join(' · ') || 'empty entity';
  }

  query({ nearX, nearZ, radius, has, name } = {}) {
    const results = [];
    for (const [id, comps] of this.world.entities) {
      if (has && !comps[has]) continue;
      if (name && !id.includes(name)) continue;
      const pos = this.positionOf(comps).map(r1);
      let distance;
      if (nearX !== undefined && nearZ !== undefined) {
        distance = r1(Math.hypot(pos[0] - nearX, pos[2] - nearZ));
        if (radius !== undefined && distance > radius) continue;
      }
      results.push({ id, position: pos, distance, components: Object.keys(comps) });
    }
    results.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    return results;
  }

  map({ x = 0, z = 0, radius = 24, cells = 21 } = {}) {
    const chars = ' .:-=+*#%';
    const grid = [];
    const step = (radius * 2) / (cells - 1);
    let min = Infinity;
    let max = -Infinity;
    const heights = [];
    for (let row = 0; row < cells; row++) {
      heights.push([]);
      for (let col = 0; col < cells; col++) {
        const h = this.groundAt(x - radius + col * step, z - radius + row * step);
        heights[row].push(h);
        min = Math.min(min, h);
        max = Math.max(max, h);
      }
    }
    const span = Math.max(0.001, max - min);
    for (let row = 0; row < cells; row++) {
      grid.push(
        heights[row].map((h) => chars[Math.min(chars.length - 1, Math.floor(((h - min) / span) * chars.length))]),
      );
    }
    const legend = {};
    for (const [id, comps] of this.world.entities) {
      if (comps.terrain) continue;
      const [ex, , ez] = this.positionOf(comps);
      const col = Math.round((ex - (x - radius)) / step);
      const row = Math.round((ez - (z - radius)) / step);
      if (row < 0 || row >= cells || col < 0 || col >= cells) continue;
      const ch = comps.presence ? '@' : id[0].toUpperCase();
      grid[row][col] = ch;
      (legend[ch] ??= []).push(id);
    }
    const lines = grid.map((row) => row.join(''));
    lines.push(`center (${x}, ${z}) · ${radius}m radius · height ${r1(min)}..${r1(max)}m (dark=low)`);
    for (const [ch, ids] of Object.entries(legend)) lines.push(`${ch} = ${ids.join(', ')}`);
    return lines.join('\n');
  }

  check() {
    const problems = [];
    const spheres = [];
    for (const [id, comps] of this.world.entities) {
      if (comps.terrain || !comps.mesh) continue;
      const behaviors = comps.behavior ? (Array.isArray(comps.behavior) ? comps.behavior : [comps.behavior]) : [];
      const orbits = behaviors.some((b) => b.type === 'orbit');
      const [x, y, z] = this.positionOf(comps);
      const ground = this.groundAt(x, z);
      if (!comps.ground && !orbits) {
        if (y - ground > 4) problems.push(`${id} floats ${r1(y - ground)}m above ground`);
        if (y < ground - 0.5) problems.push(`${id} is buried ${r1(ground - y)}m below ground`);
      }
      let radius = 0.5;
      for (const part of comps.mesh.parts ?? []) {
        radius = Math.max(radius, ...(part.size ?? []).map((s) => s / 2), part.radius ?? 0, (part.height ?? 0) / 2);
      }
      const scale = typeof comps.transform?.scale === 'number' ? comps.transform.scale : 1;
      // mega-structures (seas, sky features) make bounding-sphere overlap meaningless
      if (!orbits && radius * scale < 40) spheres.push({ id, x, y, z, r: radius * scale });
    }
    for (let i = 0; i < spheres.length; i++) {
      for (let j = i + 1; j < spheres.length; j++) {
        const a = spheres[i];
        const b = spheres[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (d < (a.r + b.r) * 0.5) problems.push(`${a.id} and ${b.id} overlap (${r1(d)}m apart)`);
      }
    }
    // lights that illuminate nothing
    for (const [id, comps] of this.world.entities) {
      if (!comps.light || comps.terrain) continue;
      const [lx, ly, lz] = this.positionOf(comps);
      const reach = comps.light.distance || 25;
      let lit = 0;
      for (const [otherId, other] of this.world.entities) {
        if (otherId === id || !other.mesh) continue;
        const [ox, oy, oz] = this.positionOf(other);
        if (Math.hypot(ox - lx, oy - ly, oz - lz) < reach) lit++;
      }
      if (!lit) problems.push(`${id}'s light reaches nothing within ${reach}m`);
    }
    // walkability: how much of the local terrain is too steep
    const params = this.terrainParams();
    if (params) {
      let steep = 0;
      const samples = 28;
      const extent = 100;
      for (let i = 0; i < samples; i++) {
        for (let j = 0; j < samples; j++) {
          const x = -extent + (i / (samples - 1)) * extent * 2;
          const z = -extent + (j / (samples - 1)) * extent * 2;
          const h = this.groundAt(x, z);
          const slope = Math.max(Math.abs(this.groundAt(x + 2, z) - h), Math.abs(this.groundAt(x, z + 2) - h)) / 2;
          if (slope > 0.9) steep++;
        }
      }
      const pct = Math.round((steep / (samples * samples)) * 100);
      if (pct > 25) problems.push(`${pct}% of terrain within ${extent}m is too steep to walk`);
    }
    return problems.length ? problems.slice(0, 20).join('\n') : 'no problems found';
  }
}

function r1(v) {
  return Math.round(v * 10) / 10;
}

function dirWord(bearing) {
  const abs = Math.abs(bearing);
  if (abs <= 15) return 'ahead';
  if (abs >= 135) return 'behind';
  return `${bearing < 0 ? 'left' : 'right'} ${Math.round(abs)}°`;
}

function compass(yaw) {
  const dirs = ['N', 'NW', 'W', 'SW', 'S', 'SE', 'E', 'NE'];
  const idx = Math.round(((yaw % (Math.PI * 2)) + Math.PI * 2) / (Math.PI / 4)) % 8;
  return dirs[idx];
}

function soundWord(sound) {
  if (sound.kind === 'hum') return `humming at ${sound.freq ?? 110}Hz`;
  if (sound.kind === 'chime') return `chiming every ${sound.interval ?? 2.5}s`;
  return sound.kind ?? 'sounding';
}
