// Engine-side weapon registry: games register authoritative gameplay hooks here.
export class Weapons {
  constructor({ hooks = [] } = {}) {
    this.hooks = hooks;
  }

  expand(op) {
    const hook = this.hooks.find((candidate) => candidate.handles?.(op));
    return hook ? hook.expand(op) : [op];
  }
}
