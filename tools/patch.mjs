#!/usr/bin/env node
// Agent/CLI interface to the live world. Examples:
//   node tools/patch.mjs spawn '{"transform":{"position":[5,0,5]},"ground":{},"mesh":{"parts":[{"shape":"box"}]}}' my-box
//   node tools/patch.mjs set my-box transform '{"position":[8,0,5]}'
//   node tools/patch.mjs merge my-box transform '{"scale":2}'
//   node tools/patch.mjs despawn my-box
//   node tools/patch.mjs load world/scenes/village.json
//   node tools/patch.mjs snapshot

const BASE = process.env.GAIA_URL ?? 'http://localhost:8420';
const [cmd, ...rest] = process.argv.slice(2);

async function post(ops) {
  const res = await fetch(`${BASE}/op`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  console.log(JSON.stringify(data.applied, null, 2));
}

switch (cmd) {
  case 'spawn':
    await post([{ op: 'spawn', id: rest[1], components: JSON.parse(rest[0]) }]);
    break;
  case 'set':
    await post([{ op: 'set', id: rest[0], component: rest[1], value: JSON.parse(rest[2]) }]);
    break;
  case 'merge':
    await post([{ op: 'merge', id: rest[0], component: rest[1], value: JSON.parse(rest[2]) }]);
    break;
  case 'despawn':
    await post([{ op: 'despawn', id: rest[0] }]);
    break;
  case 'clear':
    await post([{ op: 'clear' }]);
    break;
  case 'load': {
    const fs = await import('node:fs');
    await post(JSON.parse(fs.readFileSync(rest[0], 'utf8')));
    break;
  }
  case 'snapshot': {
    const res = await fetch(`${BASE}/world`);
    console.log(await res.text());
    break;
  }
  case 'prefab': {
    const res = await fetch(`${BASE}/prefabs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: rest[0], components: JSON.parse(rest[1]) }),
    });
    console.log(await res.text());
    break;
  }
  case 'prefabs': {
    const res = await fetch(`${BASE}/prefabs`);
    console.log(await res.text());
    break;
  }
  default:
    console.log('usage: patch.mjs spawn <components-json> [id] | set <id> <component> <json|null> | merge <id> <component> <json> | despawn <id> | clear | load <ops-file> | snapshot | prefabs | prefab <name> <components-json>');
}
