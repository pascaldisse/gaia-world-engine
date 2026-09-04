import * as THREE from 'three/webgpu';

export class InstancedModels {
  constructor(scene) {
    this.scene = scene;
    this.entries = new Set();
    this.pools = new Map();
    this.dirty = false;
  }

  register(holder, spec) {
    this.entries.add({ holder, spec });
    this.dirty = true;
  }

  markDirty() {
    this.dirty = true;
  }

  sync() {
    if (!this.dirty) return;
    this.dirty = false;

    const buckets = new Map();
    for (const entry of [...this.entries]) {
      if (!this.attached(entry.holder)) {
        this.entries.delete(entry);
        continue;
      }
      if (!this.visible(entry.holder)) continue;
      entry.holder.updateWorldMatrix(true, false);
      entry.spec.templates.forEach((template, i) => {
        const key = `${entry.spec.src}|${i}|${entry.spec.materialKey}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { template, spec: entry.spec, matrices: [] };
          buckets.set(key, bucket);
        }
        bucket.matrices.push(entry.holder.matrixWorld.clone().multiply(template.matrix));
      });
    }

    for (const [key, bucket] of buckets) {
      const count = bucket.matrices.length;
      const existing = this.pools.get(key);
      if (existing && existing.count === count) {
        for (let i = 0; i < count; i++) existing.setMatrixAt(i, bucket.matrices[i]);
        existing.instanceMatrix.needsUpdate = true;
        continue;
      }
      if (existing) {
        existing.dispose();
        this.scene.remove(existing);
      }
      const mesh = new THREE.InstancedMesh(bucket.template.geometry, bucket.spec.material ?? bucket.template.material, count);
      mesh.frustumCulled = false;
      mesh.castShadow = bucket.spec.castShadow;
      mesh.receiveShadow = true;
      mesh.userData.kind = 'instanced-models';
      for (let i = 0; i < count; i++) mesh.setMatrixAt(i, bucket.matrices[i]);
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
      this.pools.set(key, mesh);
    }

    for (const [key, pool] of [...this.pools]) {
      if (buckets.has(key)) continue;
      pool.dispose();
      this.scene.remove(pool);
      this.pools.delete(key);
    }
  }

  attached(holder) {
    for (let obj = holder; obj; obj = obj.parent) {
      if (obj === this.scene) return true;
    }
    return false;
  }

  visible(holder) {
    for (let obj = holder; obj; obj = obj.parent) {
      if (obj.visible === false) return false;
      if (obj === this.scene) return true;
    }
    return false;
  }
}
