import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { pointerToNdc, screenRayGroundPoint, yawTo, aimYawFromPointer } from '../client/kernel/aim.js';

// Boomtown's declared top-down lens: perspective, straight down, fov 18, high.
function topDownCamera({ px = 0, pz = 0, height = 158, fov = 18, aspect = 320 / 180 } = {}) {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 5000);
  cam.position.set(px, height, pz);
  cam.up.set(0, 0, -1); // stable up when looking straight down
  cam.lookAt(px, 0, pz);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

const RECT = { left: 0, top: 0, width: 320, height: 180 };

// Inverse of pointerToNdc: an INDEPENDENT oracle path (THREE.project) gives NDC
// of a known world point; convert to a pixel and feed it back through our code.
function ndcToPixel(ndc, rect) {
  return {
    clientX: rect.left + ((ndc.x + 1) / 2) * rect.width,
    clientY: rect.top + ((1 - ndc.y) / 2) * rect.height,
  };
}

test('pointerToNdc maps the canvas rect corners and centre', () => {
  expect(pointerToNdc(0, 0, RECT)).toEqual({ x: -1, y: 1 });
  expect(pointerToNdc(320, 180, RECT)).toEqual({ x: 1, y: -1 });
  const mid = pointerToNdc(160, 90, RECT);
  expect(mid.x).toBeCloseTo(0, 9);
  expect(mid.y).toBeCloseTo(0, 9);
  // a non-zero origin rect (canvas not at page corner)
  const off = pointerToNdc(200, 110, { left: 40, top: 20, width: 320, height: 180 });
  expect(off.x).toBeCloseTo(0, 9);
  expect(off.y).toBeCloseTo(0, 9);
});

test('yawTo uses the engine forward = (-sin, 0, -cos) convention', () => {
  // target to -Z ("north") -> yaw 0 (forward = (0,0,-1))
  expect(yawTo(0, 0, 0, -5)).toBeCloseTo(0, 9);
  // target to -X ("west") -> forward (-1,0,0) => -sin=-1 => yaw = +PI/2
  expect(yawTo(0, 0, -5, 0)).toBeCloseTo(Math.PI / 2, 9);
  // target to +X ("east") -> yaw = -PI/2
  expect(yawTo(0, 0, 5, 0)).toBeCloseTo(-Math.PI / 2, 9);
  // target to +Z ("south") -> yaw = PI
  expect(Math.abs(yawTo(0, 0, 0, 5))).toBeCloseTo(Math.PI, 9);
});

test('screenRayGroundPoint round-trips THREE.project for many ground points (independent oracle)', () => {
  const cam = topDownCamera({ px: 10, pz: -0.82 });
  const planeY = 0;
  for (const [tx, tz] of [[10, -0.82], [10, 10], [-8, -12], [30, 6], [10 + 40, -0.82], [10, -0.82 - 25]]) {
    // ORACLE: forward-project the known ground point with THREE
    const ndc = new THREE.Vector3(tx, planeY, tz).project(cam);
    const { clientX, clientY } = ndcToPixel(ndc, RECT);
    // our code: pixel -> ndc -> unproject -> plane hit
    const back = pointerToNdc(clientX, clientY, RECT);
    const p = screenRayGroundPoint(cam, back.x, back.y, planeY);
    expect(p).not.toBeNull();
    expect(p.x).toBeCloseTo(tx, 4);
    expect(p.z).toBeCloseTo(tz, 4);
    expect(p.y).toBeCloseTo(planeY, 6);
  }
});

test('aimYawFromPointer: cursor offset yields the yaw from body toward the ground hit', () => {
  const from = { x: 10, y: 0, z: -0.82 }; // body root at feet y=0
  const cam = topDownCamera({ px: from.x, pz: from.z });
  // pick a ground target, project to a pixel via the oracle, aim back
  for (const [tx, tz, wantYaw] of [
    [from.x, from.z - 20, 0],
    [from.x - 20, from.z, Math.PI / 2],
    [from.x + 20, from.z, -Math.PI / 2],
  ]) {
    const ndc = new THREE.Vector3(tx, from.y, tz).project(cam);
    const { clientX, clientY } = ndcToPixel(ndc, RECT);
    const res = aimYawFromPointer({ camera: cam, rect: RECT, clientX, clientY, from, planeY: from.y });
    expect(res).not.toBeNull();
    expect(res.point.x).toBeCloseTo(tx, 3);
    expect(res.point.z).toBeCloseTo(tz, 3);
    expect(Math.abs(Math.atan2(Math.sin(res.yaw - wantYaw), Math.cos(res.yaw - wantYaw)))).toBeCloseTo(0, 4);
  }
});

test('aim plane at the body ROOT height differs from plane 0 under parallax (root-height honoured)', () => {
  const from = { x: 10, y: 1.7, z: -0.82 }; // pretend the plane is the eye vs feet
  const cam = topDownCamera({ px: 0, pz: 0 }); // camera offset from body so the ray is not vertical
  // an off-axis pixel: the two plane heights must give different x,z hits (proves
  // the plane height is actually used, not ignored)
  const atRoot = screenRayGroundPoint(cam, 0.5, 0.3, 0);
  const atEye = screenRayGroundPoint(cam, 0.5, 0.3, from.y);
  expect(atRoot).not.toBeNull();
  expect(atEye).not.toBeNull();
  expect(Math.hypot(atRoot.x - atEye.x, atRoot.z - atEye.z)).toBeGreaterThan(1e-3);
});

test('screenRayGroundPoint returns null when the ray never meets the plane', () => {
  // camera looking horizontally: its central ray is parallel to a horizontal plane
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  cam.position.set(0, 5, 0);
  cam.lookAt(0, 5, -10); // dead level
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  expect(screenRayGroundPoint(cam, 0, 0, 5)).toBeNull(); // plane through the eye, parallel central ray
});

test('aimYawFromPointer guards bad rect / missing inputs', () => {
  const cam = topDownCamera();
  const from = { x: 0, y: 0, z: 0 };
  expect(aimYawFromPointer({ camera: cam, rect: { left: 0, top: 0, width: 0, height: 0 }, clientX: 1, clientY: 1, from })).toBeNull();
  expect(aimYawFromPointer({ camera: null, rect: RECT, clientX: 1, clientY: 1, from })).toBeNull();
  expect(aimYawFromPointer({ camera: cam, rect: RECT, clientX: 1, clientY: 1, from: null })).toBeNull();
});
