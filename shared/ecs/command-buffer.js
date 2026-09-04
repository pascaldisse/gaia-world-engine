export class EntityCommandBuffer {
  constructor() {
    this.commands = [];
    this.nextDeferred = -1;
  }

  createEntity(components = []) {
    const entity = this.nextDeferred--;
    this.commands.push({ op: 'create', entity, components });
    return entity;
  }

  destroyEntity(entity) {
    this.commands.push({ op: 'destroy', entity });
  }

  addComponent(entity, type, value) {
    this.commands.push({ op: 'add', entity, type, value });
  }

  removeComponent(entity, type) {
    this.commands.push({ op: 'remove', entity, type });
  }

  setComponent(entity, type, value) {
    this.commands.push({ op: 'set', entity, type, value });
  }

  setComponentEnabled(entity, type, enabled) {
    this.commands.push({ op: 'enable', entity, type, enabled });
  }

  playback(world) {
    const deferred = new Map();
    const resolve = (entity) => entity < 0 ? deferred.get(entity) : entity;
    for (const command of this.commands) {
      if (command.op === 'create') {
        deferred.set(command.entity, world.createEntity(command.components));
        continue;
      }
      const entity = resolve(command.entity);
      if (!entity) throw new Error(`unresolved deferred entity ${command.entity}`);
      if (command.op === 'destroy') world.destroyEntity(entity);
      else if (command.op === 'add') world.addComponent(entity, command.type, command.value);
      else if (command.op === 'remove') world.removeComponent(entity, command.type);
      else if (command.op === 'set') world.setComponent(entity, command.type, command.value);
      else if (command.op === 'enable') world.setComponentEnabled(entity, command.type, command.enabled);
    }
    this.commands.length = 0;
    return deferred;
  }
}
