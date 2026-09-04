import assert from 'node:assert/strict';
import test from 'node:test';
import { Sense } from '../server/sense.js';

function check(entity, options) {
  return new Sense({ entities: new Map([['model', entity]]) }).check(options);
}

test('sense check uses emitted visual bounds rather than a source-model pivot', () => {
  const grounded = {
    mesh: { parts: [{ shape: 'model' }], bounds: { center: [0, -20, 0], size: [4, 40, 4] } },
    transform: { position: [0, 20, 0] },
  };
  assert.equal(check(grounded), 'no problems found');

  const floating = {
    mesh: { parts: [{ shape: 'model' }], bounds: { center: [0, 6, 0], size: [4, 2, 4] } },
    transform: { position: [0, 0, 0] },
  };
  assert.match(check(floating, { floatTolerance: 4 }), /floats 5m above ground/);
});
