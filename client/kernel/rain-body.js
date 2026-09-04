// Declarative skeleton binding for rain proprioception. Animated GLBs have no
// VRM humanoid map; the world names the semantic bones on the model part.
export function resolveRainBones(root, binding = {}) {
  const byName = new Map();
  root?.traverse?.((node) => {
    if (node.name && !byName.has(node.name)) byName.set(node.name, node);
  });
  return Object.fromEntries(Object.entries(binding).map(([semantic, name]) => [semantic, byName.get(name) ?? null]));
}
