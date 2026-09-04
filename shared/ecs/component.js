const TYPE_INFO = {
  f32: [Float32Array, 1],
  f64: [Float64Array, 1],
  i8: [Int8Array, 1],
  u8: [Uint8Array, 1],
  i16: [Int16Array, 1],
  u16: [Uint16Array, 1],
  i32: [Int32Array, 1],
  u32: [Uint32Array, 1],
  bool: [Uint8Array, 1],
  entity: [Int32Array, 1],
  vec2: [Float32Array, 2],
  vec3: [Float32Array, 3],
  vec4: [Float32Array, 4],
  quat: [Float32Array, 4],
};

let nextTypeId = 1;

export function defineComponent(name, options = {}) {
  if (!name || typeof name !== 'string') throw new TypeError('component name must be a non-empty string');
  const fields = {};
  for (const [field, descriptor] of Object.entries(options.fields ?? {})) {
    const spec = typeof descriptor === 'string' ? { type: descriptor } : { ...descriptor };
    if (spec.type !== 'object' && !TYPE_INFO[spec.type]) throw new TypeError(`${name}.${field}: unknown type ${spec.type}`);
    fields[field] = spec;
  }
  return Object.freeze({
    id: nextTypeId++,
    name,
    fields: Object.freeze(fields),
    enableable: options.enableable === true,
    buffer: options.buffer === true,
    shared: options.shared === true,
    managed: options.managed === true,
    kind: options.kind ?? (options.buffer ? 'IBufferElementData' : 'IComponentData'),
    source: options.source ?? null,
    sourceKey: options.sourceKey ?? name,
    csharpFields: Object.freeze(options.csharpFields ?? {}),
    default: options.default,
  });
}

export function componentDefault(type) {
  if (type.default !== undefined) return cloneValue(typeof type.default === 'function' ? type.default() : type.default);
  if (type.buffer) return [];
  const value = {};
  for (const [name, spec] of Object.entries(type.fields)) {
    const info = TYPE_INFO[spec.type];
    value[name] = spec.default !== undefined
      ? cloneValue(spec.default)
      : spec.type === 'object'
        ? null
        : info[1] === 1
          ? 0
          : Array(info[1]).fill(0);
  }
  return value;
}

export class ComponentColumn {
  constructor(type, capacity) {
    this.type = type;
    this.capacity = capacity;
    this.fields = new Map();
    if (type.buffer) {
      this.buffers = Array(capacity);
    } else {
      for (const [name, spec] of Object.entries(type.fields)) {
        if (spec.type === 'object') this.fields.set(name, Array(capacity));
        else {
          const [ArrayType, width] = TYPE_INFO[spec.type];
          this.fields.set(name, { data: new ArrayType(capacity * width), width, boolean: spec.type === 'bool' });
        }
      }
    }
    this.enabled = type.enableable ? new Uint8Array(capacity).fill(1) : null;
  }

  grow(capacity) {
    if (capacity <= this.capacity) return;
    if (this.type.buffer) this.buffers.length = capacity;
    else {
      for (const [name, field] of this.fields) {
        if (Array.isArray(field)) field.length = capacity;
        else {
          const next = new field.data.constructor(capacity * field.width);
          next.set(field.data);
          this.fields.set(name, { ...field, data: next });
        }
      }
    }
    if (this.enabled) {
      const next = new Uint8Array(capacity).fill(1);
      next.set(this.enabled);
      this.enabled = next;
    }
    this.capacity = capacity;
  }

  set(row, input) {
    const value = input === undefined ? componentDefault(this.type) : input;
    if (this.type.buffer) {
      this.buffers[row] = cloneValue(value ?? []);
      return;
    }
    for (const [name, spec] of Object.entries(this.type.fields)) this.setField(row, name, value?.[name] ?? componentDefault(this.type)[name], spec);
  }

  setField(row, name, value, spec = this.type.fields[name]) {
    const field = this.fields.get(name);
    if (!field) throw new Error(`${this.type.name} has no field ${name}`);
    if (Array.isArray(field)) {
      field[row] = cloneValue(value);
      return;
    }
    if (field.width === 1) field.data[row] = field.boolean ? Number(Boolean(value)) : Number(value ?? 0);
    else {
      for (let i = 0; i < field.width; i++) field.data[row * field.width + i] = Number(value?.[i] ?? 0);
    }
  }

  get(row) {
    if (this.type.buffer) return this.buffers[row];
    const value = {};
    for (const name of Object.keys(this.type.fields)) value[name] = this.getField(row, name);
    return value;
  }

  getField(row, name) {
    const field = this.fields.get(name);
    if (Array.isArray(field)) return field[row];
    if (field.width === 1) return field.boolean ? Boolean(field.data[row]) : field.data[row];
    return Array.from(field.data.subarray(row * field.width, row * field.width + field.width));
  }

  ref(row) {
    if (this.type.buffer) return this.buffers[row];
    return new Proxy({}, {
      ownKeys: () => Object.keys(this.type.fields),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
      get: (_, name) => typeof name === 'string' && name in this.type.fields ? this.getField(row, name) : undefined,
      set: (_, name, value) => {
        if (typeof name !== 'string' || !(name in this.type.fields)) return false;
        this.setField(row, name, value);
        return true;
      },
    });
  }

  copy(fromRow, target, toRow) {
    target.set(toRow, this.get(fromRow));
    if (this.enabled) target.enabled[toRow] = this.enabled[fromRow];
  }

  swapRemove(row, last) {
    if (row === last) return;
    if (this.type.buffer) this.buffers[row] = this.buffers[last];
    else {
      for (const field of this.fields.values()) {
        if (Array.isArray(field)) field[row] = field[last];
        else {
          for (let i = 0; i < field.width; i++) field.data[row * field.width + i] = field.data[last * field.width + i];
        }
      }
    }
    if (this.enabled) this.enabled[row] = this.enabled[last];
  }
}

export function cloneValue(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}
