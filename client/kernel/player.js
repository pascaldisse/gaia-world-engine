import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.js';

export class Player {
  constructor({ camera, dom, overlay, view }) {
    this.camera = camera;
    this.view = view;
    this.yaw = 0;
    this.pitch = 0;
    this.position = new THREE.Vector3(0, 2, 22);
    this.velocity = new THREE.Vector3();
    this.keys = new Set();
    this.locked = false;
    this.editorMode = false;
    this.flyActive = false;
    this.flyLatched = false;
    this.noclip = false;
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
    const flying = this.editorMode ? this.flyActive || this.flyLatched : this.noclip;
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 14 : 6;
    // Unity-style flythrough moves along the view direction (pitch included)
    const forward = flying
      ? new THREE.Vector3(
          -Math.sin(this.yaw) * Math.cos(this.pitch),
          Math.sin(this.pitch),
          -Math.cos(this.yaw) * Math.cos(this.pitch),
        )
      : new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const move = new THREE.Vector3();
    const canMove = !isTyping() && (this.editorMode ? this.flyActive || this.flyLatched : this.locked);
    if (canMove) {
      if (this.keys.has('KeyW')) move.add(forward);
      if (this.keys.has('KeyS')) move.sub(forward);
      if (this.keys.has('KeyD')) move.add(right);
      if (this.keys.has('KeyA')) move.sub(right);
      if (flying) {
        if (this.keys.has('Space')) move.y += 1;
        if (this.keys.has('KeyC')) move.y -= 1;
        if (this.editorMode) {
          if (this.keys.has('KeyE')) move.y += 1;
          if (this.keys.has('KeyQ')) move.y -= 1;
        }
      }
    }
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);

    this.velocity.lerp(move, Math.min(1, dt * 10));
    this.position.addScaledVector(this.velocity, dt);

    if (!this.editorMode && !this.noclip) {
      let groundY = heightAt(this.position.x, this.position.z);
      const feetY = this.position.y - this.eyeHeight;
      const step = feetY + 0.65;
      // analytic collider boxes first (decks, floors), mesh raycast as fallback
      const walkable = this.view?.walkableAt(this.position.x, this.position.z);
      if (walkable !== null && walkable !== undefined && walkable > groundY && walkable <= step) {
        groundY = walkable;
      }
      const surface = this.view?.surfaceAt(this.position.x, this.position.z, this.position.y + 0.5);
      if (surface !== null && surface !== undefined && surface > groundY && surface <= step) {
        groundY = surface;
      }
      this.position.y += (groundY + this.eyeHeight - this.position.y) * Math.min(1, dt * 12);
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
