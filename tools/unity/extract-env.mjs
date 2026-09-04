#!/usr/bin/env node
// Extract environment and scene-root directional-light settings from Boomtown.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitUnityDocuments, parseUnityYamlBody, normalizeFileID } from './unity-yaml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_UNITY_ROOT = process.env.UNITY_PROJECT_ROOT;
let DEFAULT_OUT = path.join(__dirname, 'out', 'env-settings.json');

function usage() {
  console.error('usage: node tools/unity/extract-env.mjs [unity-project-root]');
  process.exit(2);
}

const args = process.argv.slice(2);
let rootArg = DEFAULT_UNITY_ROOT, sceneArg;
for (let i=0; i<args.length; i++) {
  if (args[i] === '--out') DEFAULT_OUT = path.resolve(args[++i] ?? usage());
  else if (args[i] === '--scene') sceneArg = path.resolve(args[++i] ?? usage());
  else if (!args[i].startsWith('-') && !rootArg) rootArg = args[i];
  else usage();
}
if (!rootArg || !sceneArg) throw new Error('project root and --scene required');
const unityRoot = path.resolve(rootArg);
const scenePath = sceneArg;

function unwrap(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed ?? {};
  const keys = Object.keys(parsed);
  return keys.length === 1 ? parsed[keys[0]] : parsed;
}

function buildIndex(text) {
  const entries = [];
  const byFileID = new Map();
  const componentsByGameObject = new Map();
  for (const doc of splitUnityDocuments(text)) {
    const data = unwrap(parseUnityYamlBody(doc.lines));
    const entry = { classId: doc.classId, fileID: doc.fileID, data };
    entries.push(entry);
    byFileID.set(doc.fileID, entry);
    if (data?.m_GameObject != null) {
      const gameObjectID = normalizeFileID(data.m_GameObject);
      if (!componentsByGameObject.has(gameObjectID)) componentsByGameObject.set(gameObjectID, []);
      componentsByGameObject.get(gameObjectID).push(entry);
    }
  }
  return { entries, byFileID, componentsByGameObject };
}

function valueOrNull(value) {
  return value == null ? null : value;
}

function tupleOrNull(value, keys) {
  if (!value || keys.some((key) => value[key] == null)) return null;
  return keys.map((key) => value[key]);
}

function refFileIDOrNull(ref) {
  if (!ref || ref.fileID == null) return null;
  const normalized = normalizeFileID(ref.fileID);
  const numeric = Number(normalized);
  return Number.isSafeInteger(numeric) ? numeric : normalized;
}

function lightDetails(index, light) {
  const gameObjectID = normalizeFileID(light.data.m_GameObject);
  const gameObject = index.byFileID.get(gameObjectID);
  const transform = (index.componentsByGameObject.get(gameObjectID) ?? [])
    .find((entry) => entry.classId === 4);
  return {
    name: valueOrNull(gameObject?.data?.m_Name),
    color: tupleOrNull(light.data.m_Color, ['r', 'g', 'b']),
    intensity: valueOrNull(light.data.m_Intensity),
    rotation: tupleOrNull(transform?.data?.m_LocalRotation, ['x', 'y', 'z', 'w']),
  };
}

function main() {
  const scene = buildIndex(fs.readFileSync(scenePath, 'utf8'));
  const renderEntry = scene.entries.find((entry) => entry.classId === 104);
  const data = renderEntry?.data ?? {};
  const sunFileID = refFileIDOrNull(data.m_Sun);
  const skyboxFileID = refFileIDOrNull(data.m_SkyboxMaterial);

  const renderSettings = {
    fog: data.m_Fog == null ? null : Boolean(Number(data.m_Fog)),
    fogColor: tupleOrNull(data.m_FogColor, ['r', 'g', 'b', 'a']),
    fogMode: valueOrNull(data.m_FogMode),
    fogDensity: valueOrNull(data.m_FogDensity),
    fogStart: valueOrNull(data.m_LinearFogStart),
    fogEnd: valueOrNull(data.m_LinearFogEnd),
    ambientMode: valueOrNull(data.m_AmbientMode),
    ambientSkyColor: tupleOrNull(data.m_AmbientSkyColor, ['r', 'g', 'b', 'a']),
    ambientIntensity: valueOrNull(data.m_AmbientIntensity),
    skyboxMaterialGuid: skyboxFileID == null || String(skyboxFileID) === '0'
      ? null
      : valueOrNull(data.m_SkyboxMaterial?.guid),
    sunGuidOrFileId: sunFileID,
    sun: null,
  };

  if (sunFileID != null && String(sunFileID) !== '0') {
    const sunLight = scene.byFileID.get(String(sunFileID));
    if (sunLight?.classId === 108) {
      const details = lightDetails(scene, sunLight);
      renderSettings.sun = {
        color: details.color,
        intensity: details.intensity,
        rotation: details.rotation,
      };
    }
  }

  const directionalLights = scene.entries
    .filter((entry) => entry.classId === 108 && Number(entry.data.m_Type) === 1)
    .map((light) => lightDetails(scene, light));

  const output = {
    source: scenePath,
    renderSettings,
    directionalLights,
  };
  fs.mkdirSync(path.dirname(DEFAULT_OUT), { recursive: true });
  fs.writeFileSync(DEFAULT_OUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`[extract-env] directionalLights=${directionalLights.length} out=${DEFAULT_OUT}`);
}

main();
