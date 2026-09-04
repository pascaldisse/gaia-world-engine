import { ComponentColumn, componentDefault } from './component.js';

const DEFAULT_ARCHETYPE_CAPACITY = 64;

class Archetype {
  constructor(types, capacity = DEFAULT_ARCHETYPE_CAPACITY) {
    this.types = [...types].sort((a, b) => a.id - b.id);
    this.typeSet = new Set(this.types);
    this.key = this.types.map((type) => type.id).join(',');
    this.capacity = Math.max(1, capacity);
    this.entities = new Int32Array(this.capacity);
    this.length = 0;
    this.columns = new Map(this.types.map((type) => [type, new ComponentColumn(type, this.capacity)]));
  }

  reserve() {
    if (this.length < this.capacity) return;
    this.capacity *= 2;
    const entities = new Int32Array(this.capacity);
    entities.set(this.entities);
    this.entities = entities;
    for (const column of this.columns.values()) column.grow(this.capacity);
  }

  append(entity, values = new Map()) {
    this.reserve();
    const row = this.length++;
    this.entities[row] = entity;
    for (const type of this.types) this.columns.get(type).set(row, values.has(type) ? values.get(type) : componentDefault(type));
    return row;
  }

  remove(row) {
    const last = --this.length;
    const moved = row === last ? 0 : this.entities[last];
    if (moved) this.entities[row] = moved;
    for (const column of this.columns.values()) column.swapRemove(row, last);
    return moved;
  }
}

class QueryRow {
  constructor(world, archetype, row) {
    this.world = world;
    this.archetype = archetype;
    this.row = row;
    this.entity = archetype.entities[row];
  }

  get(type) {
    return this.archetype.columns.get(type)?.get(this.row);
  }

  set(type, value) {
    const column = this.archetype.columns.get(type);
    if (!column) throw new Error(`entity ${this.entity} lacks ${type.name}`);
    column.set(this.row, value);
  }

  refRO(type) {
    return { get valueRO() { return this._column.ref(this._row); }, _column: this.archetype.columns.get(type), _row: this.row };
  }

  refRW(type) {
    const column = this.archetype.columns.get(type);
    if (!column) throw new Error(`entity ${this.entity} lacks ${type.name}`);
    return {
      get valueRO() { return column.ref(this._row); },
      get valueRW() { return column.ref(this._row); },
      set valueRW(value) { column.set(this._row, value); },
      _row: this.row,
    };
  }

  buffer(type) {
    if (!type.buffer) throw new Error(`${type.name} is not a buffer component`);
    return this.archetype.columns.get(type)?.get(this.row);
  }

  isEnabled(type) {
    const column = this.archetype.columns.get(type);
    return column?.enabled ? Boolean(column.enabled[this.row]) : true;
  }
}

export class EcsWorld {
  constructor(options = {}) {
    this.initialCapacity = options.initialCapacity ?? DEFAULT_ARCHETYPE_CAPACITY;
    this.nextEntity = 1;
    this.locations = new Map();
    this.archetypes = new Map();
    this.resources = new Map();
    this.structuralVersion = 0;
    this.getArchetype([]);
  }

  getArchetype(types) {
    const sorted = [...new Set(types)].sort((a, b) => a.id - b.id);
    const key = sorted.map((type) => type.id).join(',');
    let archetype = this.archetypes.get(key);
    if (!archetype) {
      archetype = new Archetype(sorted, this.initialCapacity);
      this.archetypes.set(key, archetype);
    }
    return archetype;
  }

  createEntity(components = []) {
    const values = normalizeComponents(components);
    const entity = this.nextEntity++;
    const archetype = this.getArchetype(values.keys());
    const row = archetype.append(entity, values);
    this.locations.set(entity, { archetype, row });
    this.structuralVersion++;
    return entity;
  }

  exists(entity) {
    return this.locations.has(entity);
  }

  destroyEntity(entity) {
    const location = this.requireLocation(entity);
    const moved = location.archetype.remove(location.row);
    if (moved) this.locations.get(moved).row = location.row;
    this.locations.delete(entity);
    this.structuralVersion++;
  }

  hasComponent(entity, type) {
    return this.locations.get(entity)?.archetype.typeSet.has(type) ?? false;
  }

  getComponent(entity, type) {
    const location = this.requireComponent(entity, type);
    return location.archetype.columns.get(type).get(location.row);
  }

  getRef(entity, type) {
    const location = this.requireComponent(entity, type);
    return location.archetype.columns.get(type).ref(location.row);
  }

  setComponent(entity, type, value) {
    const location = this.requireComponent(entity, type);
    location.archetype.columns.get(type).set(location.row, value);
  }

  addComponent(entity, type, value = componentDefault(type)) {
    const location = this.requireLocation(entity);
    if (location.archetype.typeSet.has(type)) throw new Error(`entity ${entity} already has ${type.name}`);
    this.moveEntity(entity, [...location.archetype.types, type], new Map([[type, value]]));
  }

  removeComponent(entity, type) {
    const location = this.requireComponent(entity, type);
    this.moveEntity(entity, location.archetype.types.filter((entry) => entry !== type));
  }

  setComponentEnabled(entity, type, enabled) {
    if (!type.enableable) throw new Error(`${type.name} is not enableable`);
    const location = this.requireComponent(entity, type);
    location.archetype.columns.get(type).enabled[location.row] = Number(Boolean(enabled));
  }

  isComponentEnabled(entity, type) {
    const location = this.requireComponent(entity, type);
    const enabled = location.archetype.columns.get(type).enabled;
    return enabled ? Boolean(enabled[location.row]) : true;
  }

  moveEntity(entity, targetTypes, added = new Map()) {
    const source = this.requireLocation(entity);
    const target = this.getArchetype(targetTypes);
    const values = new Map();
    for (const type of target.types) {
      if (added.has(type)) values.set(type, added.get(type));
      else if (source.archetype.typeSet.has(type)) values.set(type, source.archetype.columns.get(type).get(source.row));
    }
    const enabled = new Map();
    for (const type of target.types) {
      if (source.archetype.typeSet.has(type) && type.enableable) enabled.set(type, source.archetype.columns.get(type).enabled[source.row]);
    }
    const targetRow = target.append(entity, values);
    for (const [type, value] of enabled) target.columns.get(type).enabled[targetRow] = value;
    const moved = source.archetype.remove(source.row);
    if (moved) this.locations.get(moved).row = source.row;
    this.locations.set(entity, { archetype: target, row: targetRow });
    this.structuralVersion++;
  }

  *query(spec = {}) {
    const all = spec.all ?? [];
    const any = spec.any ?? [];
    const none = spec.none ?? [];
    const includeDisabled = spec.includeDisabled === true;
    for (const archetype of this.archetypes.values()) {
      if (!all.every((type) => archetype.typeSet.has(type))) continue;
      if (any.length && !any.some((type) => archetype.typeSet.has(type))) continue;
      if (none.some((type) => archetype.typeSet.has(type))) continue;
      for (let row = 0; row < archetype.length; row++) {
        if (!includeDisabled) {
          let disabled = false;
          for (const type of all) {
            const enabled = archetype.columns.get(type).enabled;
            if (enabled && !enabled[row]) {
              disabled = true;
              break;
            }
          }
          if (disabled) continue;
        }
        yield new QueryRow(this, archetype, row);
      }
    }
  }

  getSingleton(type, options = {}) {
    const rows = [...this.query({ all: [type], includeDisabled: options.includeDisabled })];
    if (rows.length !== 1) throw new Error(`${type.name} singleton expected one entity, found ${rows.length}`);
    return rows[0].get(type);
  }

  getSingletonEntity(type, options = {}) {
    const rows = [...this.query({ all: [type], includeDisabled: options.includeDisabled })];
    if (rows.length !== 1) throw new Error(`${type.name} singleton expected one entity, found ${rows.length}`);
    return rows[0].entity;
  }

  setResource(key, value) {
    this.resources.set(key, value);
  }

  getResource(key) {
    return this.resources.get(key);
  }

  requireLocation(entity) {
    const location = this.locations.get(entity);
    if (!location) throw new Error(`entity ${entity} does not exist`);
    return location;
  }

  requireComponent(entity, type) {
    const location = this.requireLocation(entity);
    if (!location.archetype.typeSet.has(type)) throw new Error(`entity ${entity} lacks ${type.name}`);
    return location;
  }
}

function normalizeComponents(components) {
  if (components instanceof Map) return new Map(components);
  if (!Array.isArray(components)) throw new TypeError('components must be [type, value][] or a Map');
  return new Map(components.map((entry) => Array.isArray(entry) ? entry : [entry.type, entry.value]));
}
