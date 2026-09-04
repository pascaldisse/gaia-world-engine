import * as THREE from 'three/webgpu';
import { activeCameraRig } from './camera-config.js';
import { heightAt } from './terrain.js';
import { isTyping } from './dom.js';
import { r2 } from '../../shared/num.js';
import { applyAngularDrag, applyDrag, evaluateCurve } from './avp.js';

// per-frame scratch — the movement math must not allocate
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _camTarget = new THREE.Vector3();

// Scene locomotion may override these on its environment entity. Keep these
// values in one spec so worlds without that component retain engine behavior.
const LOCOMOTION_DEFAULTS = Object.freeze({ walk: 6, run: 14, backwardFactor: 1 });
const DEFAULT_VEHICLE_CAMERA_RIG = Object.freeze({ yaw: 0, pitch: -0.22, distance: 8, height: 3.5, damp: 4 });

// ArcadeVP literals and prefab defaults, named here so the live old-spec seam
// can run without smuggling converted units back into the controller.
const AVP_INPUT_DEADZONE = 0.1;
const AVP_MOVING_THRESHOLD = 1;
const AVP_LATERAL_FRICTION_SPEED_SCALE = 100;
const AVP_TORQUE_SCALE = 100;
const AVP_VELOCITY_ACCEL_DIVISOR = 10;
const AVP_GROUNDED_ROTATION_SLERP = 0.12;
const AVP_AIR_ROTATION_SLERP = 0.02;
const AVP_DEFAULT_FIXED_TIMESTEP = 0.02;
const AVP_DEFAULT_MAX_SPEED = 60;
const AVP_DEFAULT_ACCELARATION = 1;
const AVP_DEFAULT_TURN = 20;
const AVP_DEFAULT_GRAVITY = 7;
const AVP_DEFAULT_DOWNFORCE = 5;
const AVP_DEFAULT_DRIFT_MULTIPLIER = 1.5;
const AVP_DEFAULT_MOVEMENT_MODE = 1;
const AVP_DEFAULT_GROUND_CHECK = 0;
const AVP_DEFAULT_SPHERE_MASS = 1;
const AVP_DEFAULT_SPHERE_DRAG = 0;
const AVP_DEFAULT_SPHERE_ANGULAR_DRAG = 2;
const AVP_DEFAULT_SPHERE_RADIUS = 0.65449935;
const AVP_DEFAULT_INTERPOLATE = 1;
const AVP_DEFAULT_BODY_MASS = 1;
const AVP_DEFAULT_BODY_ANGULAR_DRAG = 40;
const AVP_PHYSICS_GRAVITY_Y = -20;
const AVP_MAX_ANGULAR_SPEED = 100;
const AVP_MOVEMENT_MODE_VELOCITY = 0;
const AVP_MOVEMENT_MODE_ANGULAR_VELOCITY = 1;
export const PLAYER_EYE_HEIGHT_DEFAULT_M = 1.7;

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
    this.eyeHeight = PLAYER_EYE_HEIGHT_DEFAULT_M;
    this.eyeStand = PLAYER_EYE_HEIGHT_DEFAULT_M;
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
    this.vehicle = null;
    this.driveState = null;
    this.drivePose = null;
    this.locomotion = { ...LOCOMOTION_DEFAULTS };
    // Weapons supply this from their extracted data; it is intentionally local
    // presentation, while the server remains authoritative about equipment.
    this.weaponSpeedMultiplier = 1;

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
    this.driveState = null;
    this.drivePose = null;
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
    this.driveState = null;
    this.drivePose = null;
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

    if (this.vehicle && !flying) {
      this.updateDrive(dt, canMove);
      this.applyCameraRig(dt, activeCameraRig(this.rig, true) || DEFAULT_VEHICLE_CAMERA_RIG);
      return;
    }

    // crouch (hold ctrl or C): the eye sinks toward crouch height; grounded
    // follow lowers the camera with it, and mid-air the FEET rise instead —
    // which is exactly what makes the crouch-jump clear higher ledges
    const crouching =
      canMove && !flying && !this.swimming &&
      (this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyC'));
    this.eyeHeight += ((crouching ? this.eyeCrouch : this.eyeStand) - this.eyeHeight) * Math.min(1, dt * 12);
    if (!this.keys.has('Space')) this.jumpLocked = false;

    const loco = this.locomotion;
    const speedBase = crouching ? 3 : this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? loco.run : loco.walk;
    const backward = this.keys.has('KeyS') && !this.keys.has('KeyW');
    const speed = (this.swimming && !flying ? speedBase * 0.4 : speedBase) * (backward ? loco.backwardFactor : 1) * this.weaponSpeedMultiplier;
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
      // Shared foot/vehicle sampling → identical self/lifecycle exclusions.
      const { y: groundY, platformId } = this.groundAt(x, z, this.position.y, this.swimming ? 2.0 : 0.65);

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

    this.applyCameraRig(dt, activeCameraRig(rig, false));
  }

  updateDrive(dt, canMove) {
    const spec = this.vehicle ?? {};
    const identity = spec.carId ?? spec.model ?? spec;
    if (!this.driveState || this.driveState.identity !== identity) {
      const pose = { position: this.position.clone(), yaw: this.bodyYaw };
      this.driveState = {
        identity,
        accumulator: 0,
        sphereAngularVelocity: 0,
        bodyAngularVelocity: 0,
        dynamicFriction: 0,
        previous: { position: pose.position.clone(), yaw: pose.yaw },
        current: pose,
      };
      this.drivePose = { position: pose.position.clone(), yaw: pose.yaw };
    }
    const state = this.driveState;

    // InputManager_ArcadeVP.Update/ProvideInputs: inputs are sampled in Update
    // and held constant for every FixedUpdate consumed by this render frame.
    state.steeringInput = canMove ? (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0) : 0;
    state.accelerationInput = canMove ? (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0) : 0;
    const frameForward = _forward.set(-Math.sin(this.bodyYaw), 0, -Math.cos(this.bodyYaw));
    const frameSpeed = this.velocity.dot(frameForward);
    state.brakeInput = canMove && (this.keys.has('Space') || (this.keys.has('KeyS') && frameSpeed > AVP_MOVING_THRESHOLD)) ? 1 : 0;

    // ArcadeVehicleController.FixedUpdate runs only on Unity's fixed clock;
    // leftover render time is carried to the next frame.
    const fixedDt = spec.fixedTimestep ?? AVP_DEFAULT_FIXED_TIMESTEP;
    state.accumulator += dt;
    while (state.accumulator >= fixedDt) {
      state.previous.position.copy(state.current.position);
      state.previous.yaw = state.current.yaw;
      this.fixedDriveStep(fixedDt, state, spec);
      state.current.position.copy(this.position);
      state.current.yaw = this.bodyYaw;
      state.accumulator -= fixedDt;
    }

    // Rigidbody interpolation is the OG sphere/body follow. The controller
    // contains no positional Lerp of carBody; the prefab's HingeJoint follows
    // the sphere, and both referenced rigidbodies have m_Interpolate enabled.
    const interpolate = spec.rigidbody?.interpolate ?? AVP_DEFAULT_INTERPOLATE;
    const alpha = interpolate !== 0 ? Math.min(1, state.accumulator / fixedDt) : 1;
    this.drivePose.position.copy(state.previous.position).lerp(state.current.position, alpha);
    const yawDelta = Math.atan2(Math.sin(state.current.yaw - state.previous.yaw), Math.cos(state.current.yaw - state.previous.yaw));
    this.drivePose.yaw = interpolate !== 0 ? state.previous.yaw + yawDelta * alpha : state.current.yaw;

    // ArcadeVehicleController.Update -> Visuals: wheel steer/roll and BodyMesh
    // pitch/roll are local child presentation. The root position/yaw exposed
    // above remains the interpolated Rigidbody pose, exactly as in Unity.
    this.eyeHeight += (this.eyeStand - this.eyeHeight) * Math.min(1, dt * 12);
    this.jumpLocked = false;
    this.swimming = false;
    this.sinking = false;
    this.swimTime = 0;
    this.platform = null;
  }

  fixedDriveStep(dt, state, spec) {
    const MaxSpeed = spec.MaxSpeed ?? spec.maxSpeed ?? AVP_DEFAULT_MAX_SPEED;
    const accelaration = spec.accelaration ?? spec.accel ?? AVP_DEFAULT_ACCELARATION;
    const turn = spec.turn ?? AVP_DEFAULT_TURN;
    const gravity = spec.gravity ?? AVP_DEFAULT_GRAVITY;
    const downforce = spec.downforce ?? AVP_DEFAULT_DOWNFORCE;
    const AirControl = spec.AirControl ?? spec.airControl ?? false;
    const kartLike = spec.kartLike ?? false;
    const driftMultiplier = spec.driftMultiplier ?? AVP_DEFAULT_DRIFT_MULTIPLIER;
    const movementMode = spec.movementMode ?? AVP_DEFAULT_MOVEMENT_MODE;
    const GroundCheck = spec.GroundCheck ?? AVP_DEFAULT_GROUND_CHECK;
    const sphereMass = spec.rigidbody?.mass ?? AVP_DEFAULT_SPHERE_MASS;
    const sphereDrag = spec.rigidbody?.drag ?? spec.drag ?? AVP_DEFAULT_SPHERE_DRAG;
    const sphereAngularDrag = spec.rigidbody?.angularDrag ?? AVP_DEFAULT_SPHERE_ANGULAR_DRAG;
    const radius = spec.rigidbody?.sphereRadius ?? AVP_DEFAULT_SPHERE_RADIUS;
    const bodyMass = spec.carBodyRigidbody?.mass ?? AVP_DEFAULT_BODY_MASS;
    const bodyAngularDrag = spec.carBodyRigidbody?.angularDrag ?? AVP_DEFAULT_BODY_ANGULAR_DRAG;
    const SteeringInput = state.steeringInput;
    const AccelerationInput = state.accelerationInput;
    const BrakeInput = state.brakeInput;

    const forward = _forward.set(-Math.sin(this.bodyYaw), 0, -Math.cos(this.bodyYaw));
    const right = _right.set(Math.cos(this.bodyYaw), 0, -Math.sin(this.bodyYaw));

    // ArcadeVehicleController.FixedUpdate: carVelocity =
    // carBody.transform.InverseTransformDirection(carBody.linearVelocity).
    let localForwardVelocity = this.velocity.dot(forward);
    let localLateralVelocity = this.velocity.dot(right);
    const carVelocityMagnitude = Math.hypot(localForwardVelocity, localLateralVelocity, this.vy);

    // FixedUpdate: if lateral speed is nonzero, update dynamicFriction from
    // frictionCurve.Evaluate(abs(carVelocity.x / 100)).
    if (Math.abs(localLateralVelocity) > 0) {
      state.dynamicFriction = evaluateCurve(
        spec.frictionCurve ?? spec.grip,
        Math.abs(localLateralVelocity / AVP_LATERAL_FRICTION_SPEED_SCALE),
        0,
      );
    }

    // grounded(): GAIA seam — Unity ray/sphere casts use GAIA's existing
    // terrain/walkable/surface ground query. GroundCheck still selects the C#
    // branch, whose two casts have the same boolean result in this seam.
    const ground = this.driveGroundAt(this.position.x, this.position.z, this.position.y);
    const grounded = (GroundCheck === 0 || GroundCheck === 1)
      && this.position.y - this.eyeHeight <= ground.y + 0.35
      && this.vy <= 0;

    if (grounded) {
      // FixedUpdate grounded turnlogic: sign, turnCurve, kart drift multiplier.
      const sign = Math.sign(localForwardVelocity);
      let TurnMultiplyer = evaluateCurve(spec.turnCurve, MaxSpeed !== 0 ? carVelocityMagnitude / MaxSpeed : 0, 0);
      if (kartLike && BrakeInput > AVP_INPUT_DEADZONE) TurnMultiplyer *= driftMultiplier;

      // FixedUpdate grounded forward/reverse branches both AddTorque to carBody.
      if (AccelerationInput > AVP_INPUT_DEADZONE || localForwardVelocity > AVP_MOVING_THRESHOLD) {
        const torque = SteeringInput * sign * turn * AVP_TORQUE_SCALE * TurnMultiplyer;
        state.bodyAngularVelocity += torque / bodyMass * dt;
      } else if (AccelerationInput < -AVP_INPUT_DEADZONE || localForwardVelocity < -AVP_MOVING_THRESHOLD) {
        const torque = SteeringInput * sign * turn * AVP_TORQUE_SCALE * TurnMultiplyer;
        state.bodyAngularVelocity += torque / bodyMass * dt;
      }

      // FixedUpdate normal brakelogic: FreezeRotationX while braking.
      state.freezeSphereRotationX = !kartLike && BrakeInput > AVP_INPUT_DEADZONE;
      if (state.freezeSphereRotationX) state.sphereAngularVelocity = 0;

      // FixedUpdate acceleration logic, AngularVelocity branch.
      if (movementMode === AVP_MOVEMENT_MODE_ANGULAR_VELOCITY) {
        if (Math.abs(AccelerationInput) > AVP_INPUT_DEADZONE && BrakeInput < AVP_INPUT_DEADZONE && !kartLike) {
          const targetAngularVelocity = AccelerationInput * MaxSpeed / radius;
          const t = Math.min(1, accelaration * dt);
          state.sphereAngularVelocity += (targetAngularVelocity - state.sphereAngularVelocity) * t;
        } else if (Math.abs(AccelerationInput) > AVP_INPUT_DEADZONE && kartLike) {
          const targetAngularVelocity = AccelerationInput * MaxSpeed / radius;
          const t = Math.min(1, accelaration * dt);
          state.sphereAngularVelocity += (targetAngularVelocity - state.sphereAngularVelocity) * t;
        }
      // FixedUpdate acceleration logic, Velocity branch.
      } else if (movementMode === AVP_MOVEMENT_MODE_VELOCITY) {
        if (Math.abs(AccelerationInput) > AVP_INPUT_DEADZONE && BrakeInput < AVP_INPUT_DEADZONE && !kartLike) {
          const t = Math.min(1, accelaration / AVP_VELOCITY_ACCEL_DIVISOR * dt);
          localForwardVelocity += (AccelerationInput * MaxSpeed - localForwardVelocity) * t;
          localLateralVelocity += (0 - localLateralVelocity) * t;
          this.vy += (0 - this.vy) * t;
        } else if (Math.abs(AccelerationInput) > AVP_INPUT_DEADZONE && kartLike) {
          const t = Math.min(1, accelaration / AVP_VELOCITY_ACCEL_DIVISOR * dt);
          localForwardVelocity += (AccelerationInput * MaxSpeed - localForwardVelocity) * t;
          localLateralVelocity += (0 - localLateralVelocity) * t;
          this.vy += (0 - this.vy) * t;
        }
      }

      // FixedUpdate down force: rb.AddForce(-transform.up * downforce * rb.mass).
      // ForceMode.Force divides by mass, leaving this real vertical acceleration.
      this.vy += (-downforce * sphereMass / sphereMass) * dt;

      // FixedUpdate body tilt: MoveRotation(Slerp(... hit.normal, 0.12)).
      // GAIA seam — the ground normal comes from the same ground query; the
      // player pose exposes yaw only, so this pitch/roll Slerp cannot alter it.
      state.surfaceRotationSlerp = AVP_GROUNDED_ROTATION_SLERP;
    } else {
      if (AirControl) {
        // FixedUpdate airborne turnlogic and AddTorque (no velocity sign).
        const TurnMultiplyer = evaluateCurve(spec.turnCurve, MaxSpeed !== 0 ? carVelocityMagnitude / MaxSpeed : 0, 0);
        const torque = SteeringInput * turn * AVP_TORQUE_SCALE * TurnMultiplyer;
        state.bodyAngularVelocity += torque / bodyMass * dt;
      }

      // FixedUpdate airborne upright MoveRotation Slerp(... Vector3.up, 0.02).
      state.surfaceRotationSlerp = AVP_AIR_ROTATION_SLERP;
      // FixedUpdate airborne gravity: Lerp(v, v + down * gravity, dt * gravity).
      this.vy += -gravity * Math.min(1, dt * gravity);
    }

    // Unity Rigidbody simulation follows FixedUpdate. Both prefab bodies use
    // gravity; sphere drag/angularDrag and carBody angularDrag use Unity's
    // documented multiplicative integration.
    this.vy += AVP_PHYSICS_GRAVITY_Y * dt;
    localForwardVelocity = applyDrag(localForwardVelocity, sphereDrag, dt);
    localLateralVelocity = applyDrag(localLateralVelocity, sphereDrag, dt);
    this.vy = applyDrag(this.vy, sphereDrag, dt);
    state.sphereAngularVelocity = applyAngularDrag(state.sphereAngularVelocity, sphereAngularDrag, dt);
    state.bodyAngularVelocity = applyAngularDrag(state.bodyAngularVelocity, bodyAngularDrag, dt);
    state.sphereAngularVelocity = Math.max(-AVP_MAX_ANGULAR_SPEED, Math.min(AVP_MAX_ANGULAR_SPEED, state.sphereAngularVelocity));
    state.bodyAngularVelocity = Math.max(-AVP_MAX_ANGULAR_SPEED, Math.min(AVP_MAX_ANGULAR_SPEED, state.bodyAngularVelocity));

    if (grounded && movementMode === AVP_MOVEMENT_MODE_ANGULAR_VELOCITY) {
      // GAIA seam — PhysX sphere/ground contact turns right-axis angular
      // velocity into forward rolling velocity; GAIA keeps that contact map.
      localForwardVelocity = state.sphereAngularVelocity * radius;
    }
    if (grounded) {
      // GAIA seam — PhysX contact consumes dynamicFriction; represent that same
      // contact on the one lateral degree of freedom retained by the kernel.
      localLateralVelocity = applyDrag(localLateralVelocity, state.dynamicFriction, dt);
    }

    // Unity LH yaw -> three RH yaw flip. D must decrease GAIA yaw.
    this.bodyYaw -= state.bodyAngularVelocity * dt;
    this.velocity.copy(forward).multiplyScalar(localForwardVelocity).addScaledVector(right, localLateralVelocity);
    this.position.addScaledVector(this.velocity, dt);
    this.position.y += this.vy * dt;

    // GAIA seam — PhysX hull collisions become blocker push + into-wall clip.
    this.view?.resolveBlockers?.(this.position, this.eyeHeight, this.velocity);

    // GAIA seam — resolve the sphere/ground contact against GAIA ground data.
    const resolvedGround = this.driveGroundAt(this.position.x, this.position.z, this.position.y);
    if (this.position.y - this.eyeHeight <= resolvedGround.y && this.vy <= 0) {
      this.position.y = resolvedGround.y + this.eyeHeight;
      this.vy = 0;
      if (!resolvedGround.platformId) this.lastSafe = { x: this.position.x, y: this.position.y, z: this.position.z };
    }

    if (this.position.y < this.voidY) {
      this.onEvent?.('void', {});
      if (this.lastSafe) this.position.set(this.lastSafe.x, this.lastSafe.y, this.lastSafe.z);
      else this.respawn();
      this.velocity.set(0, 0, 0);
      this.vy = 0;
    }
  }

  driveGroundAt(x, z, eyeY) {
    return this.groundAt(x, z, eyeY);
  }

  groundAt(x, z, eyeY, walkReach = 0.65) {
    this._groundExcludeIds ??= new Set();
    this._groundExcludeIds.clear();
    this._groundExcludeIds.add(this.view?.ownPresence);
    if (this.vehicle?.carId) this._groundExcludeIds.add(this.vehicle.carId);
    const excludeIds = this._groundExcludeIds;
    const feet = eyeY - this.eyeHeight;
    let y = heightAt(x, z);
    let platformId = null;
    const walk = this.view?.walkableAt(x, z, feet + walkReach, { excludeIds });
    if (walk && walk.top > y) {
      y = walk.top;
      platformId = walk.id;
    }
    const surface = this.view?.surfaceAt(x, z, eyeY + 0.5, { excludeIds, maxTop: feet + 0.65 });
    if (surface !== null && surface !== undefined && surface > y && surface <= feet + 0.65) {
      y = surface;
      platformId = null;
    }
    return { y, platformId };
  }

  applyCameraRig(dt, rig) {
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
