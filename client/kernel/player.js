import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.js';
import { isTyping } from './dom.js';
import { r2 } from '../../shared/num.js';

// per-frame scratch — the movement math must not allocate
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _camTarget = new THREE.Vector3();

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
    // data-driven camera rig (the scene's `camera` component, set by Scenes).
    // Under a rig the view holds a FIXED yaw/pitch and follows the body from
    // distance/height — the 2.5D side-on frame. WASD moves in the rig's frame,
    // the mouse steers nothing, and bodyYaw (the way the body faces — what the
    // world renders and publishes) turns toward the movement instead of the look.
    this.rig = null;
    this.bodyYaw = 0;
    this.camPos = null; // damped rig camera — null = pick up from wherever the camera is
    // frozen: a title menu is up — the world plays behind the card but the
    // body doesn't exist yet (no input, no gravity, no void teleports); the
    // camera just holds the menu shot until a level is chosen
    this.frozen = false;

    // while a title menu is live (overlay.dataset.menu), entering the world
    // is the menu's job — a background click must not skip level setup
    overlay.addEventListener('click', () => {
      if (!overlay.dataset.menu) dom.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
      overlay.style.display = this.locked || this.editorMode ? 'none' : 'flex';
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      if (this.rig && !this.editorMode) return; // the rig owns the frame
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
    this.bodyYaw = this.yaw;
    this.pitch = 0;
    this.velocity.set(0, 0, 0);
    this.vy = 0;
    this.swimming = false;
    this.sinking = false;
    this.swimTime = 0;
    this.platform = null;
  }

  // the one sanctioned outside hand on the body: a `warp` component landed on
  // our presence and the world wants us somewhere. Settles all motion state and
  // makes the destination the safe ground — the caller moves streaming/voidY
  // with it so a cross-scene warp can never void-bounce.
  warpTo({ position, yaw, pitch } = {}) {
    if (position) this.position.set(...position);
    if (yaw !== undefined) {
      this.yaw = yaw;
      this.bodyYaw = yaw;
    }
    if (pitch !== undefined) this.pitch = Math.max(-1.45, Math.min(1.45, pitch));
    this.velocity.set(0, 0, 0);
    this.vy = 0;
    this.platform = null;
    this.swimming = false;
    this.sinking = false;
    this.swimTime = 0;
    this.lastSafe = { x: this.position.x, y: this.position.y, z: this.position.z };
  }

  update(dt) {
    if (this.frozen) {
      this.camera.position.copy(this.position);
      this.euler.set(this.pitch, this.yaw, 0);
      this.camera.quaternion.setFromEuler(this.euler);
      return;
    }
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
    // under a rig, movement lives in the rig's fixed frame (the editor's
    // flythrough and noclip always keep the free first-person frame)
    const rig = this.rig && !this.editorMode && !flying ? this.rig : null;
    const moveYaw = rig ? rig.yaw ?? 0 : this.yaw;
    // Unity-style flythrough moves along the view direction (pitch included)
    const forward = flying
      ? _forward.set(
          -Math.sin(this.yaw) * Math.cos(this.pitch),
          Math.sin(this.pitch),
          -Math.cos(this.yaw) * Math.cos(this.pitch),
        )
      : _forward.set(-Math.sin(moveYaw), 0, -Math.cos(moveYaw));
    const right = _right.set(Math.cos(moveYaw), 0, -Math.sin(moveYaw));

    const move = _move.set(0, 0, 0);
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

    // the body faces the way it looks — except under a rig, where the look is
    // fixed and the body turns toward wherever it is actually going
    if (rig) {
      const vx = this.velocity.x;
      const vz = this.velocity.z;
      if (vx * vx + vz * vz > 0.25) {
        const want = Math.atan2(-vx, -vz);
        const d = Math.atan2(Math.sin(want - this.bodyYaw), Math.cos(want - this.bodyYaw));
        this.bodyYaw += d * Math.min(1, dt * 10);
      }
    } else {
      this.bodyYaw = this.yaw;
    }

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

    if (rig) {
      // the rig's frame: pulled back along the fixed yaw, lifted, leading the
      // body by its own velocity, damped — a dolly on rails, never a cut
      const ryaw = rig.yaw ?? 0;
      _camTarget
        .set(
          this.position.x + Math.sin(ryaw) * (rig.distance ?? 14),
          this.position.y + (rig.height ?? 3),
          this.position.z + Math.cos(ryaw) * (rig.distance ?? 14),
        )
        .addScaledVector(this.velocity, (rig.lookAhead ?? 0) / 6);
      // first frame under the rig picks up from wherever the camera was — the
      // damp then glides it onto the rails (first-person → side is a shot, not a cut)
      if (!this.camPos) this.camPos = this.camera.position.clone();
      this.camPos.lerp(_camTarget, Math.min(1, dt * (rig.damp ?? 5)));
      this.camera.position.copy(this.camPos);
      this.euler.set(rig.pitch ?? 0, ryaw, 0);
      this.camera.quaternion.setFromEuler(this.euler);
    } else {
      this.camPos = null;
      this.camera.position.copy(this.position);
      this.euler.set(this.pitch, this.yaw, 0);
      this.camera.quaternion.setFromEuler(this.euler);
    }
  }
}
