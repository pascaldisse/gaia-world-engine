#!/usr/bin/env node
// POI/interaction-point loader — reads a map-import manifest (doors, benches,
// shrine, etc.) and spawns each as a world entity with a visible marker mesh
// + an `interact` component, riding the engine's EXISTING press-E hook
// (server/triggers.js `use(tid, pid)`, wired to client `{op:'use', id, by}`).
// No parallel loader: this is the same ops/spawn protocol every other entity
// uses (server/index.js POST /op -> applyAndBroadcast -> world.applyOps).
//
// Manifest contract (defensive on field names — the map-import lane's exact
// shape is UNVERIFIED as of this writing; adjust FIELD ALIASES below once
// the real manifest lands, don't rewrite the spawn logic):
//   { pois: [ { id?, type|kind, name?, position|pos|[x,y,z] } , ... ] }
// type is free text; anything containing "door" | "bench" | "shrine" gets a
// matching marker shape+color, everything else gets a generic waypoint pin.
//
// Usage:
//   node tools/poi.mjs load <manifest.json> [--prefix gwe-poi]
//   node tools/poi.mjs clear [--prefix gwe-poi]
//   node tools/poi.mjs use <poiId> [--by agent-claude]

import fs from 'node:fs';

const BASE = process.env.GAIA_URL ?? 'http://localhost:8420';
const [cmd, ...rest] = process.argv.slice(2);

function flags(args) {
  const out = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]?.startsWith('--')) { out[args[i].slice(2)] = args[i + 1]; i++; }
    else pos.push(args[i]);
  }
  return { pos, flags: out };
}

async function op(body) {
  const res = await fetch(`${BASE}/op`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data.applied;
}

// type -> { shape, color, emissive } — visual read of what a marker IS
// without needing the interact prompt first
function markerFor(type) {
  const t = (type ?? '').toLowerCase();
  if (t.includes('door')) return { shape: 'box', width: 1, height: 2, depth: 0.2, color: '#8a5a3a', emissive: '#3a2010', emissiveIntensity: 0.4 };
  if (t.includes('bench')) return { shape: 'box', width: 1.4, height: 0.5, depth: 0.5, color: '#7a6a4a', emissive: '#2a2010', emissiveIntensity: 0.3 };
  if (t.includes('shrine')) return { shape: 'cylinder', radiusTop: 0.6, radiusBottom: 0.8, height: 1.6, color: '#c94b4b', emissive: '#ff5555', emissiveIntensity: 0.8 };
  return { shape: 'octahedron', radius: 0.4, color: '#ffd966', emissive: '#ffcc33', emissiveIntensity: 1.2 };
}

function posOf(entry) {
  const p = entry.position ?? entry.pos ?? entry.transform?.position;
  if (Array.isArray(p) && p.length >= 3) return [p[0], p[1] ?? 0, p[2]];
  if (p && typeof p === 'object') return [p.x ?? 0, p.y ?? 0, p.z ?? 0];
  throw new Error(`POI entry missing position: ${JSON.stringify(entry)}`);
}

async function load(manifestPath, prefix) {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const pois = raw.pois ?? raw.points ?? raw.markers ?? raw;
  if (!Array.isArray(pois)) throw new Error('manifest has no array of POIs (expected .pois/.points/.markers or a bare array)');
  const ops = [];
  const ids = [];
  pois.forEach((entry, i) => {
    const type = entry.type ?? entry.kind ?? 'poi';
    const name = entry.name ?? `${type}-${i}`;
    const id = `${prefix}-${entry.id ?? name}`.replace(/\s+/g, '_');
    const [x, y, z] = posOf(entry);
    const mk = markerFor(type);
    ids.push(id);
    ops.push({
      op: 'spawn',
      id,
      components: {
        transform: { position: [x, y, z] },
        ground: { offset: 0 },
        mesh: { parts: [{ ...mk, position: [0, (mk.height ?? mk.radius ?? 0.5) / 2, 0] }] },
        light: { type: 'point', color: mk.emissive, intensity: 6, distance: 6 },
        // press-E hook: client sends {op:'use', id, by} within radius; the
        // event fires + these ops apply (here: flip a `state.interacted`
        // flag so a screenshot/query can prove the trigger fired).
        interact: {
          radius: 2.5,
          cooldown: 0.5,
          event: { name: 'poi-interact', data: { poiType: type, poiName: name } },
          ops: [{ op: 'merge', id, component: 'state', value: { interacted: true, lastBy: '$id', at: '$now' } }],
        },
        state: { interacted: false, poiType: type, poiName: name },
      },
    });
  });
  const applied = await op({ ops, from: 'poi-loader' });
  console.log(`spawned ${applied.length} POI ops for ${pois.length} entries: ${ids.join(', ')}`);
}

async function clear(prefix) {
  const listRes = await fetch(`${BASE}/sense/query?has=interact`);
  const list = await listRes.json();
  const ids = (Array.isArray(list) ? list : list.results ?? []).map((e) => e.id ?? e).filter((id) => String(id).startsWith(prefix));
  const ops = ids.map((id) => ({ op: 'despawn', id }));
  if (ops.length) await op({ ops, from: 'poi-loader' });
  console.log(`despawned ${ops.length}: ${ids.join(', ')}`);
}

async function use(id, by) {
  const applied = await op({ ops: [{ op: 'use', id, by }], from: 'poi-loader' });
  console.log(JSON.stringify(applied));
}

const { pos, flags: fl } = flags(rest);
const prefix = fl.prefix ?? 'gwe-poi';

switch (cmd) {
  case 'load':
    await load(pos[0], prefix);
    break;
  case 'clear':
    await clear(prefix);
    break;
  case 'use':
    await use(pos[0], fl.by ?? 'agent-claude');
    break;
  default:
    console.log('usage: poi.mjs load <manifest.json> [--prefix p] | clear [--prefix p] | use <id> [--by agent]');
    process.exit(1);
}
