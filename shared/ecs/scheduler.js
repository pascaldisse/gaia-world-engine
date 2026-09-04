export const ROOT_GROUPS = Object.freeze({
  INITIALIZATION: 'InitializationSystemGroup',
  SIMULATION: 'SimulationSystemGroup',
  FIXED: 'FixedStepSimulationSystemGroup',
  PRESENTATION: 'PresentationSystemGroup',
});

const DEFAULT_FIXED_DELTA = 0.02;
const DEFAULT_MAX_FIXED_STEPS = 8;

export class Scheduler {
  constructor(world, options = {}) {
    this.world = world;
    this.elapsedTime = 0;
    this.sequence = 0;
    this.groups = new Map();
    this.systems = new Map();
    this.compiled = false;
    this.addGroup(ROOT_GROUPS.INITIALIZATION);
    this.addGroup(ROOT_GROUPS.SIMULATION);
    this.addGroup(ROOT_GROUPS.FIXED, {
      parent: ROOT_GROUPS.SIMULATION,
      fixedDelta: options.fixedDelta ?? DEFAULT_FIXED_DELTA,
      maxSteps: options.maxFixedSteps ?? DEFAULT_MAX_FIXED_STEPS,
    });
    this.addGroup(ROOT_GROUPS.PRESENTATION);
  }

  addGroup(name, options = {}) {
    if (this.groups.has(name) || this.systems.has(name)) throw new Error(`duplicate ECS schedule item ${name}`);
    const group = {
      kind: 'group',
      name,
      parent: options.parent ?? null,
      before: array(options.before),
      after: array(options.after),
      orderFirst: options.orderFirst === true,
      orderLast: options.orderLast === true,
      fixedDelta: options.fixedDelta,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_FIXED_STEPS,
      enabled: options.enabled !== false,
      accumulator: 0,
      children: [],
      order: this.sequence++,
    };
    if (group.fixedDelta !== undefined && !(group.fixedDelta > 0)) throw new Error(`${name} fixedDelta must be > 0`);
    this.groups.set(name, group);
    this.compiled = false;
    return group;
  }

  addSystem(name, update, options = {}) {
    if (this.groups.has(name) || this.systems.has(name)) throw new Error(`duplicate ECS schedule item ${name}`);
    if (typeof update !== 'function') throw new TypeError(`${name} update must be a function`);
    const system = {
      kind: 'system',
      name,
      update,
      parent: options.group ?? ROOT_GROUPS.SIMULATION,
      before: array(options.before),
      after: array(options.after),
      orderFirst: options.orderFirst === true,
      orderLast: options.orderLast === true,
      enabled: options.enabled !== false,
      order: this.sequence++,
    };
    this.systems.set(name, system);
    this.compiled = false;
    return system;
  }

  setSystemEnabled(name, enabled) {
    const system = this.systems.get(name);
    if (!system) throw new Error(`unknown ECS system ${name}`);
    system.enabled = Boolean(enabled);
  }

  setGroupEnabled(name, enabled) {
    const group = this.groups.get(name);
    if (!group) throw new Error(`unknown ECS group ${name}`);
    group.enabled = Boolean(enabled);
  }

  compile() {
    for (const group of this.groups.values()) group.children = [];
    for (const group of this.groups.values()) {
      if (!group.parent) continue;
      const parent = this.groups.get(group.parent);
      if (!parent) throw new Error(`${group.name}: unknown UpdateInGroup ${group.parent}`);
      parent.children.push(group);
    }
    for (const system of this.systems.values()) {
      const parent = this.groups.get(system.parent);
      if (!parent) throw new Error(`${system.name}: unknown UpdateInGroup ${system.parent}`);
      parent.children.push(system);
    }
    for (const group of this.groups.values()) group.children = sortChildren(group);
    this.compiled = true;
    return this;
  }

  tick(deltaTime) {
    if (!(deltaTime >= 0)) throw new Error('deltaTime must be >= 0');
    if (!this.compiled) this.compile();
    this.elapsedTime += deltaTime;
    const frame = { deltaTime, elapsedTime: this.elapsedTime, fixed: false, alpha: 1 };
    this.runGroup(this.groups.get(ROOT_GROUPS.INITIALIZATION), frame);
    this.runGroup(this.groups.get(ROOT_GROUPS.SIMULATION), frame);
    this.runGroup(this.groups.get(ROOT_GROUPS.PRESENTATION), frame);
  }

  runGroup(group, context) {
    if (!group.enabled) return;
    if (group.fixedDelta !== undefined) {
      group.accumulator += context.deltaTime;
      let steps = 0;
      while (group.accumulator + Number.EPSILON >= group.fixedDelta && steps < group.maxSteps) {
        const fixed = {
          deltaTime: group.fixedDelta,
          elapsedTime: context.elapsedTime - group.accumulator + group.fixedDelta,
          fixed: true,
          alpha: 0,
        };
        this.runChildren(group, fixed);
        group.accumulator -= group.fixedDelta;
        steps++;
      }
      // A bounded catch-up avoids a tab-resume death spiral. Preserve less
      // than one step so interpolation remains meaningful after the clamp.
      if (steps === group.maxSteps && group.accumulator >= group.fixedDelta) group.accumulator %= group.fixedDelta;
      return;
    }
    this.runChildren(group, context);
  }

  runChildren(group, context) {
    for (const child of group.children) {
      if (child.kind === 'group') this.runGroup(child, context);
      else if (child.enabled) child.update({ world: this.world, scheduler: this, group: group.name, ...context });
    }
  }

  fixedAlpha(groupName = ROOT_GROUPS.FIXED) {
    const group = this.groups.get(groupName);
    if (!group?.fixedDelta) return 1;
    return Math.min(1, group.accumulator / group.fixedDelta);
  }

  orderedNames(groupName) {
    if (!this.compiled) this.compile();
    const group = this.groups.get(groupName);
    if (!group) throw new Error(`unknown ECS group ${groupName}`);
    return group.children.map((child) => child.name);
  }
}

function sortChildren(group) {
  const items = [...group.children];
  const names = new Map(items.map((item) => [item.name, item]));
  const edges = new Map(items.map((item) => [item.name, new Set()]));
  const indegree = new Map(items.map((item) => [item.name, 0]));
  const edge = (from, to) => {
    if (from === to || !names.has(from) || !names.has(to) || edges.get(from).has(to)) return;
    edges.get(from).add(to);
    indegree.set(to, indegree.get(to) + 1);
  };
  for (const item of items) {
    for (const before of item.before) edge(item.name, before);
    for (const after of item.after) edge(after, item.name);
  }
  const first = items.filter((item) => item.orderFirst);
  const last = items.filter((item) => item.orderLast);
  const middle = items.filter((item) => !item.orderFirst && !item.orderLast);
  for (const a of first) for (const b of [...middle, ...last]) edge(a.name, b.name);
  for (const a of middle) for (const b of last) edge(a.name, b.name);

  const ready = items.filter((item) => indegree.get(item.name) === 0).sort((a, b) => a.order - b.order);
  const out = [];
  while (ready.length) {
    const item = ready.shift();
    out.push(item);
    for (const target of edges.get(item.name)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        ready.push(names.get(target));
        ready.sort((a, b) => a.order - b.order);
      }
    }
  }
  if (out.length !== items.length) {
    const cycle = items.filter((item) => indegree.get(item.name) > 0).map((item) => item.name).join(', ');
    throw new Error(`${group.name}: UpdateBefore/UpdateAfter cycle involving ${cycle}`);
  }
  return out;
}

function array(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
