import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { registerMaterialShader, makePartMaterial } from '../client/kernel/geometry.js';

test('real material factory: complete shader data keys shared cache; source look does not collide', () => {
  let builds = 0;
  const remove = registerMaterialShader('test-source-material', (spec, context) => {
    expect(typeof context.loadTexture).toBe('function'); builds++;
    return new THREE.MeshStandardMaterial({ color: spec.tint });
  });
  try {
    const part = { shader: { name: 'test-source-material', tint: '#ff0000' }, fog: false };
    const red = makePartMaterial(part);
    expect(red.color.getHexString()).toBe('ff0000'); expect(red.fog).toBe(false);
    expect(red.userData.shared).toBe(true);
    expect(makePartMaterial(structuredClone(part))).toBe(red);
    const blue = makePartMaterial({ ...part, shader: { ...part.shader, tint: '#0000ff' } });
    expect(blue).not.toBe(red); expect(blue.color.getHexString()).toBe('0000ff'); expect(builds).toBe(2);
    expect(() => registerMaterialShader('test-source-material', () => red)).toThrow();
  } finally { remove(); }
});
test('unregistered source shader fails explicitly rather than silently rendering gray', () => {
  expect(() => makePartMaterial({ shader: { name: 'test-not-registered' } })).toThrow('material shader unavailable');
});
