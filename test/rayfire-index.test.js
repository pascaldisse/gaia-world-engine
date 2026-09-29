// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Spec §16 #38 register()/api surface + attribute/uniform naming law (rfX prefix, no WGSL reserved words) + headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ext from '../client/extensions/rayfire/index.js';
import { WGSL_RESERVED } from './helpers/wgsl-reserved.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../client/extensions/rayfire');
const API = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/cleanroom/destruction-api.md'), 'utf8');

// names in the fenced "Export list" block of destruction-api.md
function documentedNames() {
  const sec = API.slice(API.indexOf('## Export list'), API.indexOf('## Naming law'));
  const block = sec.split('```')[1] ?? '';
  return new Set(block.split(/\s+/).filter(Boolean));
}

const REQUIRED = [
  'v3', 'createRng', 'mixSeed', 'rand01', 'RFX_NAMES',
  'meshVolume', 'facesVolume', 'isWatertight', 'closeOpenShell', 'fractureCells', 'nextFragmentAmount', 'DEMOLITION_DEFAULTS', 'demolishMesh',
  'facesToBufferGeometry', 'geometryToTriangles', 'fracture', 'demolish',
  'RFWorld', 'RF_WORLD_DEFAULTS',
  'pointInBox', 'markUnyielding', 'buildAdjacency', 'assignJointStrength', 'breakJoints', 'connectedComponents', 'partitionByUnyielding', 'computeSupport', 'tickErosion',
  'CollapseType', 'removeByArea', 'removeBySize', 'removeRandom', 'collapseStep', 'runCollapseSteps', 'COLLAPSE_DEFAULTS',
  'createActivationState', 'shouldActivate', 'activate',
  'FadeType', 'createFadeState', 'tickFade', 'FADE_DEFAULTS',
  'explode', 'shoot',
];

test('#38 register() with NO argument returns { name:"rayfire", api } and api exposes EVERY documented name', () => {
  const r = ext.register();
  assert.equal(r.name, 'rayfire');
  assert.ok(r.api && typeof r.api === 'object');
  for (const n of REQUIRED) assert.ok(n in r.api, `api missing ${n}`);
  const documented = documentedNames();
  for (const n of documented) assert.ok(n in r.api, `documented in destruction-api.md but absent from api: ${n}`);
  for (const n of REQUIRED) assert.ok(documented.has(n), `REQUIRED list drifted from destruction-api.md: ${n}`);
  assert.equal(documented.size, REQUIRED.length, 'export list and REQUIRED must be the same set');
});

test('#38 the consumer destructure works and each member has the right kind', () => {
  const { api } = ext.register();
  const { v3, RFWorld, FadeType, CollapseType } = api;
  assert.deepEqual(v3(1, 2, 3), { x: 1, y: 2, z: 3 });
  assert.equal(typeof RFWorld, 'function'); assert.ok(new RFWorld({}).bodies instanceof Map);
  assert.equal(FadeType.SCALE_DOWN, 'scaleDown'); assert.equal(CollapseType.RANDOM, 'random');
  for (const n of REQUIRED) if (!/^[A-Z_]+$/.test(n) && n !== 'RFWorld' && n !== 'FadeType' && n !== 'CollapseType') assert.equal(typeof api[n], 'function', n);
  assert.equal(register_twice(), true);
});
function register_twice() { const a = ext.register(), b = ext.register(); return a.name === b.name && a.api.fractureCells === b.api.fractureCells; }

test('register(ctx) ignores ctx (pure api factory) and named exports mirror the api', () => {
  const r = ext.register({ scene: {}, store: {} });
  assert.equal(r.name, 'rayfire');
  for (const n of REQUIRED) assert.equal(ext[n], r.api[n], `named export ${n}`);
});

test('naming law: every rfX-prefixed identifier is well-formed and not a WGSL keyword/reserved word', () => {
  const { api } = ext.register();
  const names = Object.values(api.RFX_NAMES);
  for (const n of names) { assert.match(n, /^rfX[A-Za-z0-9_]*$/); assert.equal(WGSL_RESERVED.has(n), false, `${n} is a WGSL reserved word`); assert.equal(WGSL_RESERVED.has(n.toLowerCase()), false); }
  assert.equal(Object.isFrozen(api.RFX_NAMES), true);
  // scan all sources: any rfX token must be listed in RFX_NAMES (or be a hull-tag key), none reserved
  const tokens = new Set();
  for (const f of fs.readdirSync(DIR)) if (f.endsWith('.js')) for (const m of fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\/\/.*$/gm, '').matchAll(/\brfX\w*/g)) tokens.add(m[0]);
  const allowed = new Set(names);
  for (const t of tokens) { assert.equal(WGSL_RESERVED.has(t), false, `${t} reserved`); assert.ok(allowed.has(t), `unlisted rfX token ${t}`); }
  // the reserved list itself carries the words our own names could plausibly collide with
  for (const w of ['array', 'atomic', 'discard', 'fn', 'let', 'loop', 'override', 'ptr', 'struct', 'switch', 'var', 'while', 'enum', 'filter', 'target', 'premerge']) assert.ok(WGSL_RESERVED.has(w), w);
});

test('every source file carries the clean-room header on line 1', () => {
  const HEADER = '// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)';
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js'));
  assert.ok(files.length >= 10);
  for (const f of files) assert.equal(fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')[0], HEADER, f);
  const testDir = path.join(DIR, '../../../test');
  for (const f of fs.readdirSync(testDir).filter(f => f.startsWith('rayfire-') && f.endsWith('.test.js'))) assert.equal(fs.readFileSync(path.join(testDir, f), 'utf8').split('\n')[0], HEADER, f);
});

test('purity: no module-level mutable state leaks between register() calls; no THREE outside render.js/hull.js', () => {
  for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.js') && !['render.js', 'hull.js'].includes(f))) {
    assert.doesNotMatch(fs.readFileSync(path.join(DIR, f), 'utf8'), /from\s+['"]three/, `${f} imports THREE`);
  }
  const a = ext.register().api, b = ext.register().api;
  const w1 = new a.RFWorld(), w2 = new b.RFWorld();
  w1.addBody({ position: { x: 0, y: 0, z: 0 }, shape: { type: 'sphere', radius: 1 } });
  assert.equal(w2.bodies.size, 0);
});
