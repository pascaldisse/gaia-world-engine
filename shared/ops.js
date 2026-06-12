// Op semantics every observer must agree on — shared by the server (the
// authority) and the client (prompts, menus, optimistic mirrors), so the
// two can never drift apart.

// $-token substitution in authored op lists (trigger/interact ops, game.json
// level ops): vars maps tokens to values, e.g. { $id: pid, $now: t }.
// Mutates objects in place — pass a structuredClone of the authored op.
export function substitute(value, vars) {
  if (typeof value === 'string' && value in vars) return vars[value];
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = substitute(value[k], vars);
  }
  return value;
}

// `when` gates: {"entity.component.path": value} — every pair must match.
// getComps resolves an entity id to its component document (world map on the
// server, store mirror on the client), so the E-prompt and the server apply
// the exact same rule.
export function matchesWhen(when, getComps) {
  for (const [path, expected] of Object.entries(when)) {
    const [id, ...keys] = path.split('.');
    let value = getComps(id);
    for (const key of keys) value = value?.[key];
    if (value !== expected) return false;
  }
  return true;
}

// The named-library merge rule (`scene` and `material` ops): value null
// deletes the whole entry; otherwise keys merge into it, a null key deletes
// that key, and `name` never lands (it's the address, not content).
export function mergeIntoLibrary(library, name, value) {
  if (value === null) {
    delete library[name];
    return;
  }
  const entry = (library[name] = library[name] ?? {});
  for (const [key, v] of Object.entries(value ?? {})) {
    if (key === 'name') continue;
    if (v === null) delete entry[key];
    else entry[key] = v;
  }
}
