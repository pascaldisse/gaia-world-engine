// Material hook (§GI-PROBES.md Material sampling): attaches a GI query node
// to a NodeMaterial the SAME way three attaches a light map — by pushing a
// three/webgpu IrradianceNode into the material's per-instance lights array
// (NodeMaterial.setupLights), so it participates in the existing
// PhysicalLightingModel.indirectDiffuse() term for free. Only ever called by
// gi-controller.js when gi.enabled === true — an unattached material's
// setupLights is never touched.

import { IrradianceNode } from 'three/webgpu';

/**
 * @param {import('three/webgpu').NodeMaterial} material
 * @param {import('three/tsl').Node} giNode vec3 irradiance node (gi-nodes.js: createGIQueryNode)
 */
export function attachGI(material, giNode) {
  if (!material || typeof material.setupLights !== 'function') {
    throw new Error('attachGI: material must be a NodeMaterial (setupLights not found)');
  }
  if (material.__giAttached) return material; // idempotent — re-attach is a no-op, not a double-push
  const original = material.setupLights.bind(material);
  material.setupLights = function giSetupLights(builder) {
    const lightsN = original(builder);
    const giLighting = new IrradianceNode(giNode);
    return builder.renderer.lighting.createNode([...lightsN.getLights(), giLighting]);
  };
  material.__giAttached = true;
  material.__giNode = giNode;
  return material;
}

export function detachGI(material, originalSetupLights) {
  if (!material) return;
  if (originalSetupLights) material.setupLights = originalSetupLights;
  material.__giAttached = false;
  material.__giNode = null;
}
