import fs from 'node:fs';
import path from 'node:path';

export class World {
  // saveFilter: which entities belong to the SAVE FILE — the player layer.
  // Everything else lives in the scene files and is re-seeded from them on
  // every boot, so persisting it here would shadow the source of truth.
  constructor(file, { saveFilter }) {
    this.file = file;
    this.saveFilter = saveFilter;
    this.entities = new Map();
    this.counter = 1;
    this.saveTimer = null;
  }

  load() {
    if (!fs.existsSync(this.file)) return false;
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.counter = data.counter ?? 1;
    this.entities = new Map(Object.entries(data.entities ?? {}));
    for (const [id, comps] of [...this.entities]) {
      if (!this.saveFilter(id, comps)) this.entities.delete(id);
    }
    return this.entities.size > 0;
  }

  snapshot() {
    return { counter: this.counter, entities: Object.fromEntries(this.entities) };
  }

  saveSnapshot() {
    const entities = {};
    for (const [id, comps] of this.entities) {
      if (this.saveFilter(id, comps)) entities[id] = comps;
    }
    return { counter: this.counter, entities };
  }

  applyOps(ops) {
    const applied = [];
    let dirty = false;
    for (const op of ops) {
      // the save rewrites only when the player layer changed — checked on
      // both sides of the op, so an entity LEAVING the layer (persist
      // removed, scene claimed) still drops out of the file
      const before = op.id ? this.entities.get(op.id) : null;
      const wasSaved = before ? this.saveFilter(op.id, before) : false;
      const result = this.applyOp(op);
      if (!result) continue;
      applied.push(result);
      if (result.op === 'event') continue;
      const after = result.id ? this.entities.get(result.id) : null;
      if (wasSaved || result.op === 'clear' || (after && this.saveFilter(result.id, after))) dirty = true;
    }
    if (dirty) this.scheduleSave();
    return applied;
  }

  applyOp(op) {
    switch (op.op) {
      case 'spawn': {
        const id = op.id ?? `e${this.counter++}`;
        this.entities.set(id, structuredClone(op.components ?? {}));
        return { op: 'spawn', id, components: this.entities.get(id) };
      }
      case 'set': {
        const entity = this.entities.get(op.id);
        if (!entity) return null;
        if (op.value === null || op.value === undefined) delete entity[op.component];
        else entity[op.component] = structuredClone(op.value);
        return { op: 'set', id: op.id, component: op.component, value: op.value ?? null };
      }
      case 'merge': {
        const entity = this.entities.get(op.id);
        if (!entity) {
          // merge materializes missing entities — `state` flags entities can
          // appear on first write (broadcast as a spawn so clients learn it)
          const components = { [op.component]: structuredClone(op.value ?? {}) };
          this.entities.set(op.id, components);
          return { op: 'spawn', id: op.id, components };
        }
        entity[op.component] = { ...(entity[op.component] ?? {}), ...structuredClone(op.value ?? {}) };
        return { op: 'set', id: op.id, component: op.component, value: entity[op.component] };
      }
      case 'despawn': {
        if (!this.entities.delete(op.id)) return null;
        return { op: 'despawn', id: op.id };
      }
      case 'clear': {
        this.entities.clear();
        return { op: 'clear' };
      }
      case 'event': {
        // transient: broadcast + journal, never persisted into entities
        return { op: 'event', name: op.name ?? 'event', data: op.data ?? null };
      }
      default:
        return null;
    }
  }

  // trailing throttle, not a debounce: a presence streaming merges faster
  // than the delay must not push the write out forever
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.saveSnapshot(), null, 2));
    }, 1000);
  }
}
