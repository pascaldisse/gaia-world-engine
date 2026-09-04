// GATE (stage 1, ambient/sound excision): the ENGINE owns no game sounds.
// Every event sound comes from the world (`world.json` -> audio.events).
// A world that declares nothing is SILENT.
//
// audio.js imports three/webgpu and the vite-injected __GAIA_PORT__, so the
// real method under test is lifted from source and run against a stub graph -
// the assertion still exercises the shipped code, not a re-implementation.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const audioSrc = fs.readFileSync(path.join(ROOT, 'client/kernel/audio.js'), 'utf8');

function liftMethod(src, name) {
  const start = src.indexOf(`
  ${name}(`);
  expect(start).toBeGreaterThan(-1);
  // params: paren-balanced from the method's '(' (destructuring is nested)
  const pOpen = src.indexOf('(', start);
  let pd = 0;
  let pClose = pOpen;
  for (let j = pOpen; j < src.length; j++) {
    if (src[j] === '(') pd++;
    else if (src[j] === ')' && --pd === 0) { pClose = j; break; }
  }
  const args = src.slice(pOpen + 1, pClose);
  const i = src.indexOf('{', pClose);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) {
      const body = src.slice(i, j + 1);
      return new Function(`return function ${name}(${args}) ${body}`)();
    }
  }
  throw new Error(`method ${name} not closed`);
}

const event = liftMethod(audioSrc, 'event');

function stub(eventSpecs) {
  const played = [];
  return { eventSpecs, played, oneShot(spec) { played.push(spec); }, event };
}

test('no world audio declaration -> zero sounds', () => {
  const a = stub(null);
  expect(a.event('lightning')).toBe(0);
  expect(a.event('splash')).toBe(0);
  expect(a.event('wisp', { hint: { freq: 700 } })).toBe(0);
  expect(a.played.length).toBe(0);
});

test('declared events play exactly what the world declared', () => {
  const a = stub({ lightning: [{ wave: 'noise', level: 0.5 }, { freq: 46, level: 0.2 }] });
  expect(a.event('lightning', { scale: 0.5 })).toBe(2);
  expect(a.played.map((s) => s.level)).toEqual([0.25, 0.1]);
  expect(a.event('splash')).toBe(0); // undeclared stays silent
  expect(a.played.length).toBe(2);
});

test('world declaration outranks engine hints', () => {
  const a = stub({ wisp: [{ freq: 300, level: 0.1 }] });
  a.event('wisp', { hint: { freq: 620, decay: 0.5 } });
  expect(a.played[0].freq).toBe(300); // declared wins
  expect(a.played[0].decay).toBe(0.5); // hint only fills a gap
});

test('engine source carries no baked game-sound constants', () => {
  for (const banned of ['splash(', 'thunder(', 'blip(']) {
    expect(audioSrc.includes(`\n  ${banned}`)).toBe(false);
  }
  const client = ['client/main.js', 'client/kernel/effects.js', 'client/kernel/environment.js'];
  for (const rel of client) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expect(/audio[?.]*\.(splash|thunder|blip)\(/.test(src)).toBe(false);
  }
});
