import fs from 'node:fs';
import path from 'node:path';

export class World {
  constructor(file) {
    this.file = file;
    this.entities = new Map();
    this.counter = 1;
    this.saveTimer = null;
  }

  load() {
    if (!fs.existsSync(this.file)) return false;
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.counter = data.counter ?? 1;
    this.entities = new Map(Object.entries(data.entities ?? {}));
    return this.entities.size > 0;
  }

  snapshot() {
    return { counter: this.counter, entities: Object.fromEntries(this.entities) };
  }

  applyOps(ops) {
    const applied = [];
    let dirty = false;
    for (const op of ops) {
      const result = this.applyOp(op);
      if (result) {
        applied.push(result);
        if (result.op !== 'event') dirty = true;
      }
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

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.snapshot(), null, 2));
    }, 300);
  }
}
