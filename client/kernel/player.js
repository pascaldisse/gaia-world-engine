import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.js';

export class Player {
  constructor({ camera, dom, overlay }) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0;
    this.position = new THREE.Vector3(0, 2, 22);
    this.velocity = new THREE.Vector3();
    this.keys = new Set();
    this.locked = false;
    this.editorMode = false;
    this.flyActive = false;
    this.eyeHeight = 1.7;
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');

    overlay.addEventListener('click', () => dom.requestPointerLock());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
      overlay.style.display = this.locked || this.editorMode ? 'none' : 'flex';
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * 0.0022));
    });
    document.addEventListener('keydown', (e) => this.keys.add(e.code));
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  update(dt) {
    const fly = this.editorMode;
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 14 : 6;
    // Unity-style flythrough moves along the view direction (pitch included)
    const forward = fly
      ? new THREE.Vector3(
          -Math.sin(this.yaw) * Math.cos(this.pitch),
          Math.sin(this.pitch),
          -Math.cos(this.yaw) * Math.cos(this.pitch),
        )
      : new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const move = new THREE.Vector3();
    const canMove = !isTyping() && (fly ? this.flyActive : this.locked);
    if (canMove) {
      if (this.keys.has('KeyW')) move.add(forward);
      if (this.keys.has('KeyS')) move.sub(forward);
      if (this.keys.has('KeyD')) move.add(right);
      if (this.keys.has('KeyA')) move.sub(right);
      if (fly) {
        if (this.keys.has('KeyE')) move.y += 1;
        if (this.keys.has('KeyQ')) move.y -= 1;
      }
    }
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);

    this.velocity.lerp(move, Math.min(1, dt * 10));
    this.position.addScaledVector(this.velocity, dt);

    if (!fly) {
      const groundY = heightAt(this.position.x, this.position.z) + this.eyeHeight;
      this.position.y += (groundY - this.position.y) * Math.min(1, dt * 12);
    }

    this.camera.position.copy(this.position);
    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
  }
}

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}
