#!/usr/bin/env node
// Sense & act for agents — perception without pixels. Examples:
//   node tools/agent.mjs look
//   node tools/agent.mjs map 0 0 30
//   node tools/agent.mjs describe crystal
//   node tools/agent.mjs query --has sound
//   node tools/agent.mjs check
//   node tools/agent.mjs events 0
//   node tools/agent.mjs move 0 6          (blocks until arrival, prints look frame)
//   node tools/agent.mjs walk 1 0 3
//   node tools/agent.mjs face crystal
//   node tools/agent.mjs grab firefly-1 | drop
//   node tools/agent.mjs say "hello world"

const BASE = process.env.GAIA_URL ?? 'http://localhost:8420';
const AS = process.env.GAIA_AGENT ?? 'agent-claude';
const [cmd, ...rest] = process.argv.slice(2);

async function get(path, params = {}) {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const res = await fetch(url);
  return res.text();
}

async function act(intent, extra = {}) {
  const res = await fetch(`${BASE}/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent, as: AS, ...extra }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  console.log(JSON.stringify(data.result));
  if (data.frame) console.log(data.frame);
}

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i]?.startsWith('--')) out[args[i].slice(2)] = args[i + 1];
  }
  return out;
}

switch (cmd) {
  case 'look':
    console.log(await get('/sense/look', { as: AS, ...flags(rest) }));
    break;
  case 'map':
    console.log(await get('/sense/map', { x: rest[0], z: rest[1], radius: rest[2] }));
    break;
  case 'describe':
    console.log(await get('/sense/describe', { id: rest[0] }));
    break;
  case 'query':
    console.log(await get('/sense/query', flags(rest)));
    break;
  case 'check':
    console.log(await get('/sense/check'));
    break;
  case 'events':
    console.log(await get('/events', { since: rest[0] ?? 0 }));
    break;
  case 'move':
    await act('move_to', { x: Number(rest[0]), z: Number(rest[1]), speed: rest[2] ? Number(rest[2]) : undefined });
    break;
  case 'walk':
    await act('walk', { dx: Number(rest[0]), dz: Number(rest[1]), seconds: Number(rest[2] ?? 2) });
    break;
  case 'face':
    await act('face', Number.isNaN(Number(rest[0])) ? { id: rest[0] } : { yaw: Number(rest[0]) });
    break;
  case 'grab':
    await act('grab', { id: rest[0] });
    break;
  case 'drop':
    await act('drop');
    break;
  case 'say':
    await act('say', { text: rest.join(' ') });
    break;
  case 'shot': {
    // shot [file] [presence-id] — with a presence id only that session's
    // tab answers (otherwise the frontmost of all open tabs wins)
    const res = await fetch(`${BASE}/screenshot${rest[1] ? `?from=${encodeURIComponent(rest[1])}` : ''}`);
    if (!res.ok) {
      console.error(await res.text());
      break;
    }
    const fs = await import('node:fs');
    const file = rest[0] ?? 'shot.png';
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`${file} (${fs.statSync(file).size} bytes)`);
    break;
  }
  default:
    console.log(
      'usage: agent.mjs look | map [x z radius] | describe <id> | query [--has c] [--name s] [--nearX x --nearZ z --radius r] | check | events [since] | move <x> <z> [speed] | walk <dx> <dz> <sec> | face <id|yaw> | grab <id> | drop | say <text>',
    );
}
