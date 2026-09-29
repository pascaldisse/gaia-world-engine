// Root-cause investigation #8, part 3 (parent review 09-29): "Zeros must
// never again be silently reported as data." withGpuValidation()
// (tools/gi-parity.mjs) wraps every scene/check in a WebGPU validation
// error scope + a persistent 'uncapturederror' device listener, so a
// silently-invalidated pipeline (exactly what happened in pass #7: 12
// storage buffers > the device's 8-buffer limit, BindGroupLayout
// validation failed, every dispatch a dropped no-op, all-zero readback
// looked like data) surfaces as `result.gpuErrors` and forces
// `result.pass = false` with the actual message, instead of silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withGpuValidation } from '../tools/gi-parity.mjs';

function fakeRenderer({ scopeError = null, uncapturedEvents = [], throwOnPop = false } = {}) {
  const listeners = [];
  const device = {
    pushErrorScope: () => {},
    popErrorScope: async () => {
      // fire any queued uncaptured events "during" the scope, mirroring
      // real WebGPU timing (uncapturederror can fire any time, not just
      // inside pop) -- fire them here for a deterministic, testable order
      for (const evt of uncapturedEvents) {
        for (const l of listeners) l(evt);
      }
      if (throwOnPop) throw new Error('popErrorScope failed');
      return scopeError;
    },
    addEventListener: (type, handler) => { if (type === 'uncapturederror') listeners.push(handler); },
    removeEventListener: (type, handler) => {
      if (type === 'uncapturederror') {
        const idx = listeners.indexOf(handler);
        if (idx !== -1) listeners.splice(idx, 1);
      }
    },
  };
  return { backend: { device }, _listeners: listeners };
}

test('no errors: gpuErrors stays empty, result passes through unchanged', async () => {
  const renderer = fakeRenderer();
  const { result, errors, thrown } = await withGpuValidation(renderer, async () => ({ value: 42 }));
  assert.deepEqual(result, { value: 42 });
  assert.deepEqual(errors, []);
  assert.equal(thrown, null);
});

test('a WebGPU validation error (popErrorScope resolves to a GPUValidationError) is captured with its message', async () => {
  const renderer = fakeRenderer({ scopeError: { message: 'The number of storage buffers (12) in the Compute stage exceeds the maximum per-stage limit (8).' } });
  const { errors } = await withGpuValidation(renderer, async () => 'ok');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'validation');
  assert.match(errors[0].message, /storage buffers \(12\)/);
});

test('an uncapturederror event fired during the scope is captured too', async () => {
  const renderer = fakeRenderer({ uncapturedEvents: [{ error: { message: 'device lost' } }] });
  const { errors } = await withGpuValidation(renderer, async () => 'ok');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'uncapturederror');
  assert.match(errors[0].message, /device lost/);
});

test('BOTH a validation error AND an uncaptured error in the same scope are both captured, not just one', async () => {
  const renderer = fakeRenderer({
    scopeError: { message: 'validation failed' },
    uncapturedEvents: [{ error: { message: 'also this' } }],
  });
  const { errors } = await withGpuValidation(renderer, async () => 'ok');
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.kind === 'validation'));
  assert.ok(errors.some((e) => e.kind === 'uncapturederror'));
});

test('a JS error THROWN inside fn() is captured as `thrown` (caller re-throws) AND recorded in errors, not silently swallowed', async () => {
  const renderer = fakeRenderer();
  const { result, errors, thrown } = await withGpuValidation(renderer, async () => { throw new Error('boom'); });
  assert.equal(result, undefined);
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, 'boom');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'thrown');
});

test('a renderer with no accessible device (no backend/device) still runs fn() normally -- graceful no-op, not a crash', async () => {
  const renderer = {}; // no .backend at all
  const { result, errors } = await withGpuValidation(renderer, async () => 'still works');
  assert.equal(result, 'still works');
  assert.deepEqual(errors, []);
});

test('the uncapturederror listener is removed after the scope ends (no leak across multiple withGpuValidation calls)', async () => {
  const renderer = fakeRenderer();
  await withGpuValidation(renderer, async () => 'first');
  assert.equal(renderer._listeners.length, 0, 'no listener left registered after the first scope ends');
  await withGpuValidation(renderer, async () => 'second');
  assert.equal(renderer._listeners.length, 0, 'still none after a second scope -- not accumulating');
});

test('mutant: forgetting removeEventListener would leak one listener per withGpuValidation call', async () => {
  const renderer = fakeRenderer();
  // simulate the bug directly: add without ever removing
  const device = renderer.backend.device;
  device.addEventListener('uncapturederror', () => {});
  device.addEventListener('uncapturederror', () => {});
  assert.equal(renderer._listeners.length, 2, 'confirms the fake correctly accumulates when nothing removes -- the real code must not do this');
});

// ------------------------------------------------------------------ mutant
test('mutant: a harness that reports the atlas readback WITHOUT checking gpuErrors would treat a silently-dropped dispatch\'s all-zero readback as legitimate data -- exactly the pass-#7 bug', () => {
  const allZeroReadback = new Float32Array(16 * 3); // every value 0 -- looks like "a fully shadowed closed box", not "the pipeline never ran"
  const noErrorCheck = (readback) => ({ pass: true, data: readback }); // BUG: never looks at gpuErrors
  const withErrorCheck = (readback, gpuErrors) => ({ pass: gpuErrors.length === 0, data: readback });
  const errors = [{ kind: 'validation', message: 'storage buffers (12) exceeds limit (8)' }];
  assert.equal(noErrorCheck(allZeroReadback).pass, true, 'the mutant reports success even though the data is meaningless');
  assert.equal(withErrorCheck(allZeroReadback, errors).pass, false, 'the real check correctly refuses to call this a pass');
});
