import * as THREE from 'three/webgpu';

const easeOutBack = (t) => {
  const c = 1.70158;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

// Spawn wisps, materialize/dissolve tweens — the world's changes should feel
// like a spirit at work, not a database update.
export class Effects {
  constructor({ scene, audio }) {
    this.scene = scene;
    this.audio = audio;
    this.tweens = new Set();
  }

  tween({ duration, step, done }) {
    this.tweens.add({ t: 0, duration, step, done });
  }

  update(dt) {
    for (const tw of [...this.tweens]) {
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.duration);
      tw.step(k);
      if (k >= 1) {
        this.tweens.delete(tw);
        tw.done?.();
      }
    }
  }

  wispTo(target, done) {
    const wisp = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 12, 8),
      new THREE.MeshBasicMaterial({ color: '#bfe8ff' }),
    );
    const from = target.clone().add(
      new THREE.Vector3((Math.random() - 0.5) * 10, 12 + Math.random() * 5, (Math.random() - 0.5) * 10),
    );
    const mid = from.clone().lerp(target, 0.5).add(new THREE.Vector3(0, 3, 0));
    wisp.position.copy(from);
    this.scene.add(wisp);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    this.tween({
      duration: 0.55,
      step: (k) => {
        a.copy(from).lerp(mid, k);
        b.copy(mid).lerp(target, k);
        wisp.position.copy(a.lerp(b, k));
        wisp.scale.setScalar(1 - k * 0.6);
      },
      done: () => {
        this.scene.remove(wisp);
        wisp.geometry.dispose();
        wisp.material.dispose();
        this.audio?.blip(620 + Math.random() * 260);
        done?.();
      },
    });
  }

  scaleIn(group) {
    const target = group.scale.clone();
    group.scale.setScalar(0.001);
    this.tween({
      duration: 0.4,
      step: (k) => {
        const e = Math.max(0.001, easeOutBack(k));
        group.scale.set(target.x * e, target.y * e, target.z * e);
      },
      done: () => group.scale.copy(target),
    });
  }

  scaleOut(group, done) {
    const start = group.scale.clone();
    this.tween({
      duration: 0.25,
      step: (k) => {
        const e = Math.max(0.001, 1 - k * k);
        group.scale.set(start.x * e, start.y * e, start.z * e);
      },
      done,
    });
  }
}
