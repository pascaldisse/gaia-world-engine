// Root-cause investigation #10 (parent live-GPU rerun, 09-29): pass #9's
// reset fix changed NOTHING live. The captured WGSL (pass #9's own new
// tool) showed the REAL cause directly: the update kernel's outer ray loop
// and marchOccupancyTSL's inner step loop BOTH generated `for (var i:
// i32 = 0; ...)` -- TSL's Loop() names its counter 'i' by default,
// independently per call. WGSL lexical scoping means the inner loop's `i`
// SHADOWS the outer one inside its braces; since TSL evaluates node
// expressions lazily at their point of use, `fibonacciDirTSL(i,...)`'s `i`
// reference (the ray loop's index) got emitted as the bare identifier "i"
// wherever `dir` was actually used -- inside the march loop's body -- so
// it resolved to the WRONG (inner, march-step) variable there. `dir`
// depended on the march step, not the ray, identical for every ray of a
// probe: exactly the reported "march dist constant per probe" symptom.
//
// Fix: (1) every Loop() nested inside another (directly, or via a plain-
// JS function call boundary like marchOccupancyTSL/traceAndShadeRayTSL)
// gets an EXPLICIT, DISTINCT `name`, and (2) values computed from a loop
// index that get used across a nested-loop boundary (`dir`) are
// materialized via `.toVar()` so their VALUE is frozen into a real
// variable, immune to being re-inlined/re-evaluated wherever referenced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../client/kernel/gi/gi-nodes.js', import.meta.url), 'utf8');
// strip comments before scanning for CODE patterns -- several comments in
// this file legitimately quote the OLD (pre-fix) Loop() call text as
// documentation/history, which would otherwise false-positive-match a
// naive regex scan of the raw source
const CODE_ONLY = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
  .replace(/\/\/.*$/gm, ''); // line comments

// ---------------------------------------------------------- (1) no default-named Loop
test('no Loop() call in gi-nodes.js uses the DEFAULT (unnamed) count-only form -- every one has an explicit name', () => {
  // matches `Loop(` NOT immediately followed by `{` (the object form) --
  // i.e. the bare Loop(count, cb) / Loop(count, count2, cb) forms that
  // fall back to TSL's default 'i'/'j'/'k' naming
  const bareLoopCalls = CODE_ONLY.match(/\bLoop\(\s*[^{]/g) || [];
  assert.deepEqual(bareLoopCalls, [], `found ${bareLoopCalls.length} Loop() call(s) NOT using the explicit-name object form: ${JSON.stringify(bareLoopCalls)}`);
});

test('every Loop() call site specifies a `name` property, and no two names collide across the whole file', () => {
  const names = [...CODE_ONLY.matchAll(/Loop\(\s*\{[^}]*name:\s*'(\w+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 6, `expected at least 6 named loops (ray x2, march-step, point-light, 3 query corners), found ${names.length}: ${names}`);
  // rayI legitimately appears twice (the irradiance AND depth update
  // kernels are separate top-level functions, their loops can never be
  // nested inside each other) -- every OTHER name must be globally unique
  const nonRayI = names.filter((n) => n !== 'rayI');
  const unique = new Set(nonRayI);
  assert.equal(unique.size, nonRayI.length, `found an unexpected duplicate loop name (only 'rayI' is allowed to repeat, across the two separate update kernels): ${names}`);
  assert.equal(names.filter((n) => n === 'rayI').length, 2, 'rayI must appear exactly twice');
});

test('the specific names this fix introduced are all present: rayI (x2, update+depth kernels), stepI (march), lightI (point lights), cx/cy/cz (query corners)', () => {
  for (const expected of ['rayI', 'stepI', 'lightI', 'cx', 'cy', 'cz']) {
    assert.ok(SRC.includes(`name: '${expected}'`), `expected loop name '${expected}' to appear in gi-nodes.js`);
  }
  const rayICount = (SRC.match(/name: 'rayI'/g) || []).length;
  assert.equal(rayICount, 2, 'rayI must appear exactly twice: the irradiance update kernel AND the depth update kernel');
});

// ------------------------------------------------------- (2) dir materialized as a Var
test('`dir` is materialized via .toVar() in BOTH the irradiance and depth update kernels\' ray loops (a real frozen variable, not a lazily re-evaluated expression)', () => {
  const dirVarCount = (SRC.match(/const dir = fibonacciDirTSL\(rayI, raysPerProbe, rotation\)\.toVar\(\);/g) || []).length;
  assert.equal(dirVarCount, 2, 'expected exactly 2 occurrences (irradiance update kernel + depth update kernel)');
});

test('probeIdx and probePos are also materialized via .toVar() in both update kernels (defensive -- they don\'t reference a loop index directly, but freezing them is cheap insurance against this whole bug class)', () => {
  const probeIdxVarCount = (SRC.match(/\.mod\(int\(probeCount\)\)\.toVar\(\);/g) || []).length;
  assert.equal(probeIdxVarCount, 2);
  const probePosVarCount = (SRC.match(/probeGrid\.origin\.z\.add\(float\(iz\)\.mul\(probeGrid\.spacing\)\),\n      \)\.toVar\(\);/g) || []).length;
  assert.equal(probePosVarCount, 2, 'both update kernels\' probePos must end with .toVar()');
});

// -------------------------------------------------------------------- mutants
test('mutant: reverting the ray loop to the default-named Loop(raysPerProbe, ({i}) => ...) form reproduces the EXACT collision with marchOccupancyTSL\'s (also default-named) step loop', () => {
  const preFixRayLoop = 'Loop(raysPerProbe, ({ i }) => {';
  assert.ok(!SRC.includes(preFixRayLoop), 'the exact pre-fix bare ray-loop form must not reappear');
});

test('mutant: dropping .toVar() from `dir` (reverting to a lazy expression) would reopen the exact bug even with correctly-named loops, if a FUTURE refactor ever reused a name accidentally', () => {
  const lazyDirWithCorrectNaming = 'const dir = fibonacciDirTSL(rayI, raysPerProbe, rotation);'; // no .toVar()
  assert.ok(!SRC.includes(lazyDirWithCorrectNaming), 'dir must always be materialized, not just correctly-named -- defense in depth');
});

test('mutant: a query-node fix that only renames the JS destructuring alias ({i:ox}) but leaves the underlying Loop() name as default \'i\' would NOT fix the bug -- the WGSL-level name is what matters, not the JS alias', () => {
  const cosmeticOnlyFix = "Loop(2, ({ i: ox }) => {"; // BUG: JS-side rename only, WGSL still gets 'i'
  assert.ok(!SRC.includes(cosmeticOnlyFix), 'the cosmetic-only (JS alias without an explicit WGSL name) pre-fix pattern must not reappear');
});
