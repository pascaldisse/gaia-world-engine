import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCameraRig, cameraSpec } from '../client/kernel/camera-config.js';
test('cameraSpec defaults safely to the generic perspective lens', () => {
  assert.deepEqual(cameraSpec(), {
    projection: 'perspective', fov: 70, near: 0.1, far: 4000, orthoSize: 10, pixel: null,
  });
});
test('cameraSpec preserves a scene-selected orthographic nearest pixel target', () => {
  assert.deepEqual(cameraSpec({ projection: 'orthographic', orthoSize: 12, pixel: { width: 319.6, height: 180.2 } }).pixel, { width: 320, height: 180 });
  assert.equal(cameraSpec({ projection: 'orthographic', orthoSize: 12 }).projection, 'orthographic');
  assert.equal(cameraSpec({ projection: 'orthographic', orthoSize: 12 }).orthoSize, 12);
});
test('activeCameraRig selects scene-owned on-foot and in-vehicle variants', () => {
  const spec = { projection: 'orthographic', height: 25, onFoot: { height: 22 }, vehicle: { height: 30 } };
  assert.equal(activeCameraRig(spec, false).height, 22);
  assert.equal(activeCameraRig(spec, true).height, 30);
  assert.equal(activeCameraRig(spec, true).projection, 'orthographic');
});
