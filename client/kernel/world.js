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
    const previous = this.entities;
    this.entities = new Map(Object.entries(entities));
    this.emit({ kind: 'snapshot' });
    for (const [id, entity] of previous) {
      if (!this.entities.has(id)) this.emit({ kind: 'removed', id, entity });
    }
    for (const [id, entity] of this.entities) {
      const before = previous.get(id);
      if (!before) this.emit({ kind: 'added', id, entity });
      else if (JSON.stringify(before) !== JSON.stringify(entity)) this.emit({ kind: 'updated', id, entity, previous: before });
    }
  }

  applyOps(ops) {
    for (const op of ops) {
      switch (op.op) {
        case 'spawn': {
          const entity = op.components ?? {};
          this.entities.set(op.id, entity);
          this.emit({ kind: 'spawn', id: op.id, entity });
          this.emit({ kind: 'added', id: op.id, entity });
          break;
        }
        case 'set': {
          const entity = this.entities.get(op.id);
          if (!entity) break;
          const previous = entity[op.component];
          if (op.value === null) delete entity[op.component];
          else entity[op.component] = op.value;
          this.emit({ kind: 'set', id: op.id, component: op.component, value: op.value, entity });
          this.emit({ kind: 'updated', id: op.id, component: op.component, value: op.value, entity, previous });
          break;
        }
        case 'despawn': {
          const entity = this.entities.get(op.id);
          if (this.entities.delete(op.id)) {
            this.emit({ kind: 'despawn', id: op.id, entity });
            this.emit({ kind: 'removed', id: op.id, entity });
          }
          break;
        }
        case 'clear': {
          const removed = [...this.entities];
          this.entities.clear();
          this.emit({ kind: 'snapshot' });
          for (const [id, entity] of removed) this.emit({ kind: 'removed', id, entity });
          break;
        }
      }
    }
  }

  get(id) {
    return this.entities.get(id);
  }
}
