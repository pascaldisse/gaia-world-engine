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
    this.eyeStand = 1.7;
    this.eyeCrouch = 1.0;
    this.jumpLocked = false; // held Space = one jump until release
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    // bodies in space: vertical velocity (gravity), swim state, ridden platform
    this.vy = 0;
    this.swimming = false;
    this.sinking = false;
    this.swimTime = 0;
    this.swimLimit = Infinity;
    this.platform = null;
    this.spawnPose = null;
    this.voidY = -120;
    this.lastSafe = null; // last static ground pose — void falls return here
    this.onEvent = null; // (name, data) => {} — splash/sinking/drown/void hooks

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

  respawn() {
    const pose = this.spawnPose ?? { position: [0, 2, 22], yaw: 0 };
    this.position.set(...(pose.position ?? [0, 2, 22]));
    this.yaw = pose.yaw ?? 0;
    this.pitch = 0;
    this.velocity.set(0, 0, 0);
    this.vy = 0;
    this.swimming = false;
    this.sinking = false;
    this.swimTime = 0;
    this.platform = null;
  }

  update(dt) {
    const flying = this.editorMode ? this.flyActive || this.flyLatched : this.noclip;

    // riding: a moving platform carries the body with its frame delta
    if (this.platform && !flying) {
      const group = this.view?.getGroup(this.platform.id);
      if (group) {
        this.position.x += group.position.x - this.platform.x;
        this.position.y += group.position.y - this.platform.y;
        this.position.z += group.position.z - this.platform.z;
        const dyaw = group.rotation.y - this.platform.yaw;
        if (dyaw) {
          const px = this.position.x - group.position.x;
          const pz = this.position.z - group.position.z;
          const cos = Math.cos(dyaw);
          const sin = Math.sin(dyaw);
          this.position.x = group.position.x + px * cos + pz * sin;
          this.position.z = group.position.z - px * sin + pz * cos;
          this.yaw += dyaw;
        }
        this.platform = { id: this.platform.id, x: group.position.x, y: group.position.y, z: group.position.z, yaw: group.rotation.y };
      } else {
        this.platform = null;
      }
    }

    const canMove = !isTyping() && (this.editorMode ? this.flyActive || this.flyLatched : this.locked);

    // crouch (hold ctrl or C): the eye sinks toward crouch height; grounded
    // follow lowers the camera with it, and mid-air the FEET rise instead —
    // which is exactly what makes the crouch-jump clear higher ledges
    const crouching =
      canMove && !flying && !this.swimming &&
      (this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyC'));
    this.eyeHeight += ((crouching ? this.eyeCrouch : this.eyeStand) - this.eyeHeight) * Math.min(1, dt * 12);
    if (!this.keys.has('Space')) this.jumpLocked = false;

    const speedBase = crouching ? 3 : this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 14 : 6;
    const speed = this.swimming && !flying ? speedBase * 0.4 : speedBase;
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

    this.velocity.lerp(move, Math.min(1, dt * (this.swimming && !flying ? 4 : 10)));
    this.position.addScaledVector(this.velocity, dt);

    if (!this.editorMode && !this.noclip) {
      // fell out of the world: return to the last safe ground
      if (this.position.y < this.voidY) {
        this.onEvent?.('void', {});
        if (this.lastSafe) {
          this.position.set(this.lastSafe.x, this.lastSafe.y, this.lastSafe.z);
          this.velocity.set(0, 0, 0);
          this.vy = 0;
        } else {
          this.respawn();
        }
        return;
      }

      this.view?.resolveBlockers?.(this.position, this.eyeHeight);

      const x = this.position.x;
      const z = this.position.z;
      const feet = this.position.y - this.eyeHeight;
      let groundY = heightAt(x, z);
      let platformId = null;
      // analytic collider boxes first (decks, floors), mesh raycast as fallback;
      // a swimmer can haul up onto a low deck (the hand that pulls you out)
      const reach = this.swimming ? 2.0 : 0.65;
      const walk = this.view?.walkableAt(x, z, feet + reach);
      if (walk && walk.top > groundY) {
        groundY = walk.top;
        platformId = walk.id;
      }
      const surface = this.view?.surfaceAt(x, z, this.position.y + 0.5);
      if (surface !== null && surface !== undefined && surface > groundY && surface <= feet + 0.65) {
        groundY = surface;
        platformId = null;
      }

      const water = this.view?.waterAt?.(x, z);
      const inDeepWater = water && water.level - groundY > 1.15 && feet < water.level - 0.2;

      if (inDeepWater) {
        if (!this.swimming) {
          this.swimming = true;
          this.sinking = false;
          this.swimTime = 0;
          this.swimLimit = water.drownAfter ?? Infinity;
          this.vy = 0;
          this.platform = null;
          this.onEvent?.('splash', { x: r2(x), z: r2(z) });
        }
        this.swimTime += dt;
        if (!this.sinking && this.swimTime > this.swimLimit) {
          this.sinking = true;
          this.onEvent?.('sinking', {});
        }
        if (this.sinking) {
          // the soul has run dry — the water takes you
          this.position.y -= dt * 1.1;
          if (this.position.y < water.level - 7 || this.swimTime > this.swimLimit + 5) {
            this.onEvent?.('drown', { x: r2(x), z: r2(z) });
            this.respawn();
          }
        } else {
          // buoyancy holds the head just above the surface
          this.position.y += (water.level + 0.35 - this.position.y) * Math.min(1, dt * 6);
        }
      } else {
        if (this.swimming) {
          this.swimming = false;
          this.sinking = false;
          this.swimTime = 0;
        }
        if (feet <= groundY + 0.35 && this.vy <= 0) {
          // grounded — and Space leaves it: vy 8 against gravity 24 is a
          // ~1.3m arc, Half-Life-sized. The vy<=0 guard above is what lets
          // the jump survive its first frame inside the ground-snap band.
          if (canMove && !flying && this.keys.has('Space') && !this.jumpLocked) {
            this.jumpLocked = true;
            this.vy = 8;
            this.position.y += this.vy * dt;
            this.onEvent?.('jump', { x: r2(x), z: r2(z) });
          } else {
            // follow the ground (and remember a platform under us)
            this.vy = 0;
            this.position.y += (groundY + this.eyeHeight - this.position.y) * Math.min(1, dt * 12);
          }
          if (platformId) {
            if (this.platform?.id !== platformId) {
              const group = this.view?.getGroup(platformId);
              this.platform = group
                ? { id: platformId, x: group.position.x, y: group.position.y, z: group.position.z, yaw: group.rotation.y }
                : null;
            }
          } else {
            this.platform = null;
            // static ground is safe ground (platforms move out from under you)
            this.lastSafe = { x: this.position.x, y: groundY + this.eyeHeight, z: this.position.z };
          }
        } else {
          // airborne: gravity (the Fall is just a very long version of this).
          // The ridden platform is KEPT — jumping on the moving ferry must
          // not leave you hanging over the water it just sailed out from under
          this.vy = Math.max(this.vy - 24 * dt, -26);
          this.position.y += this.vy * dt;
          if (this.position.y - this.eyeHeight <= groundY) {
            this.position.y = groundY + this.eyeHeight;
            this.vy = 0;
          }
        }
      }
    } else {
      this.vy = 0;
      this.platform = null;
      if (this.swimming) {
        this.swimming = false;
        this.sinking = false;
        this.swimTime = 0;
      }
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

function r2(v) {
  return Math.round(v * 100) / 100;
}
