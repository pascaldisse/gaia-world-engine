#!/usr/bin/env node
// Rebuild client/assets/world-snapshot.json — the file static mode
// (?static=1 / GAIA_STATIC_BUILD) loads INSTEAD of the websocket, per
// docs/atlas-static.md.
//
// THIS SCRIPT DECIDES NOTHING. It is a pure projection of the atlas ops file
// that the world server itself is fed:
//     entities = { op.id: op.components }  for every {op:'spawn'} op
// plus the world meta taken verbatim from the atlas world dir's world.json.
// Every number in the snapshot therefore comes from paloptic's world-build
// pipeline; nothing here can drift from the live world by having an opinion.
//
// Why the ops file and not the live server's /world: a dev server accumulates
// runtime strays (a leftover presence entity, an editor experiment). The ops
// file is the clean source — docs/atlas-static.md, "world-snapshot.json was
// built from ... the canonical source named in the task, not the live dev
// server's /world (435 vs 434 entities)".
//
// usage:
//   node tools/build-atlas-snapshot.mjs [opsPath] [worldJsonPath] [outPath]
// defaults point at the paloptic atlas lane.
import fs from 'node:fs';
import path from 'node:path';

const ATLAS = '/Users/pascaldisse/projects/paloptic/viz';
const here = path.dirname(new URL(import.meta.url).pathname);

const opsPath = process.argv[2] ?? `${ATLAS}/data/atlas-ops.json`;
const worldPath = process.argv[3] ?? `${ATLAS}/world-atlas/world.json`;
const outPath = process.argv[4] ?? path.join(here, '../client/assets/world-snapshot.json');

const ops = JSON.parse(fs.readFileSync(opsPath, 'utf8'));
const world = JSON.parse(fs.readFileSync(worldPath, 'utf8'));

const entities = {};
let skipped = 0;
for (const op of ops) {
  if (op.op !== 'spawn' || !op.id) { skipped += 1; continue; }
  entities[op.id] = op.components;
}

const snapshot = { time: 0, entities, world, game: null, materials: {} };
fs.writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);

const kinds = {};
for (const id of Object.keys(entities)) {
  const k = id.split(':')[0];
  kinds[k] = (kinds[k] ?? 0) + 1;
}
console.log(JSON.stringify({ opsPath, worldPath, outPath, ops: ops.length, entities: Object.keys(entities).length, skipped, kinds }, null, 2));
