// Client-side mirror of the world store. The server is canonical; this map
// only ever changes by applying ops or snapshots received from it.
export class WorldStore {
  constructor() {
    this.entities = new Map();
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) fn(event);
  }

  applySnapshot(entities) {
    this.entities = new Map(Object.entries(entities));
    this.emit({ kind: 'snapshot' });
  }

  applyOps(ops) {
    for (const op of ops) {
      switch (op.op) {
        case 'spawn':
          this.entities.set(op.id, op.components ?? {});
          this.emit({ kind: 'spawn', id: op.id });
          break;
        case 'set': {
          const entity = this.entities.get(op.id);
          if (!entity) break;
          if (op.value === null) delete entity[op.component];
          else entity[op.component] = op.value;
          this.emit({ kind: 'set', id: op.id, component: op.component });
          break;
        }
        case 'despawn':
          if (this.entities.delete(op.id)) this.emit({ kind: 'despawn', id: op.id });
          break;
        case 'clear':
          this.entities.clear();
          this.emit({ kind: 'snapshot' });
          break;
      }
    }
  }

  get(id) {
    return this.entities.get(id);
  }
}
