#!/usr/bin/env node
// Extract the Boomtown Cinemachine rigs and their prefab/scene overrides.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitUnityDocuments, parseUnityYamlBody, normalizeFileID } from './unity-yaml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_UNITY_ROOT = null;
const DEFAULT_OUT = path.join(__dirname, 'out', 'camera-rigs.json');
const HUB_INSTANCE_FILE_ID = '2640877238463074667';
const SCENE_HUB_INSTANCE_FILE_ID = '429743421';
const RIG_NAMES = [
  '1st Person Car Camera',
  'TopDown Car Camera',
  'Tracking Camera',
  'FreeFly Camera',
];

// Cinemachine 3 component script GUIDs, taken from the serialized components.
const CINEMACHINE_CAMERA_GUID = 'f9dfa5b682dcd46bda6128250e975f58';
const CINEMACHINE_FOLLOW_GUID = 'b617507da6d07e749b7efdb34e1173e1';
const POSITION_COMPOSER_GUID = '886251e9a18ece04ea8e61686c173e1b';
const ROTATION_COMPOSER_GUID = 'f38bda98361e1de48a4ca2bd86ea3c17';

// Unity assigns new local identifiers when Main Camera City's locally-added
// objects pass through the Hub prefab boundary.  These are identity links,
// not camera values: the left IDs are the targets serialized in boomtown.unity
// and the right IDs are their source components in Main Camera City.prefab.
const HUB_EFFECTIVE_TO_MAIN_CITY = new Map([
  ['1583704001145994458', '3556776899359960497'], // TopDown Car Camera / CinemachineCamera
  ['2531502077709167863', '542670977906326940'],  // TopDown Car Camera / CinemachineFollow
  ['8688730625171549461', '6643607338264165502'], // TopDown Car Camera / CinemachineRotationComposer
]);

function usage() {
  console.error('usage: node tools/unity/extract-camera.mjs [unity-project-root]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help') || args.length > 1) usage();
if (!args[0] && !process.env.UNITY_PROJECT) usage();
const unityRoot = path.resolve(args[0] ?? process.env.UNITY_PROJECT);
const scenePath = path.join(unityRoot, 'Assets', 'Scenes', 'boomtown.unity');
const hubPath = path.join(unityRoot, 'Assets', 'DotsCity', 'Samples', 'Demo City', 'Prefabs', 'Core', 'Hub.prefab');
const cameraCityPath = path.join(unityRoot, 'Assets', 'DotsCity', 'Samples', 'Demo City', 'Prefabs', 'UI', 'Main Camera City.prefab');

function unwrap(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed ?? {};
  const keys = Object.keys(parsed);
  return keys.length === 1 ? parsed[keys[0]] : parsed;
}

function buildIndex(text) {
  const byFileID = new Map();
  const componentsByGameObject = new Map();
  for (const doc of splitUnityDocuments(text)) {
    const data = unwrap(parseUnityYamlBody(doc.lines));
    const entry = { classId: doc.classId, fileID: doc.fileID, data };
    byFileID.set(doc.fileID, entry);
    if (doc.classId === 4 || doc.classId === 114) {
      const gameObjectID = normalizeFileID(data.m_GameObject);
      if (!componentsByGameObject.has(gameObjectID)) componentsByGameObject.set(gameObjectID, []);
      componentsByGameObject.get(gameObjectID).push(entry);
    }
  }
  return { byFileID, componentsByGameObject };
}

function prefabInstance(index, fileID) {
  const entry = index.byFileID.get(fileID);
  if (!entry || entry.classId !== 1001) throw new Error(`PrefabInstance &${fileID} not found`);
  return entry.data;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function number(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected number at ${label}, got ${JSON.stringify(value)}`);
  return Object.is(n, -0) ? 0 : n;
}

function vector(value, keys, label) {
  return keys.map((key) => number(value?.[key], `${label}.${key}`));
}

function setPath(target, propertyPath, value) {
  const keys = propertyPath.split('.');
  let cursor = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
}

function relevantOverride(propertyPath) {
  return /(Lens|Damping|Lookahead|FieldOfView|field of view|OrthographicSize|orthographic size|orthographic)/i.test(propertyPath ?? '');
}

function modifications(instance) {
  return instance.m_Modification?.m_Modifications ?? [];
}

function scriptGuid(entry) {
  return entry?.data?.m_Script?.guid?.toLowerCase();
}

function componentFor(components, guid) {
  return components.find((entry) => scriptGuid(entry) === guid);
}

function main() {
  const cameraCity = buildIndex(fs.readFileSync(cameraCityPath, 'utf8'));
  const hub = buildIndex(fs.readFileSync(hubPath, 'utf8'));
  const scene = buildIndex(fs.readFileSync(scenePath, 'utf8'));

  const rigSources = [];
  const mutableComponents = new Map();
  for (const name of RIG_NAMES) {
    const gameObject = [...cameraCity.byFileID.values()].find(
      (entry) => entry.classId === 1 && entry.data.m_Name === name,
    );
    if (!gameObject) throw new Error(`Rig GameObject not found: ${name}`);
    const components = cameraCity.componentsByGameObject.get(gameObject.fileID) ?? [];
    const copies = components.map((entry) => ({ ...entry, data: clone(entry.data) }));
    for (const entry of copies) mutableComponents.set(entry.fileID, entry);
    rigSources.push({ name, components: copies });
  }

  // Hub overrides the real Unity Camera inherited through Main Camera City.
  // Its lens values are the effective defaults for every extracted virtual
  // camera, so retain them as an overlay rather than inventing rig values.
  const globalLens = {};
  for (const mod of modifications(prefabInstance(hub, HUB_INSTANCE_FILE_ID))) {
    if (!relevantOverride(mod.propertyPath)) continue;
    const property = mod.propertyPath.toLowerCase();
    if (property === 'field of view') globalLens.FieldOfView = number(mod.value, 'Hub field of view');
    else if (property === 'orthographic size') globalLens.OrthographicSize = number(mod.value, 'Hub orthographic size');
    else if (property === 'orthographic') globalLens.ModeOverride = number(mod.value, 'Hub orthographic') ? 1 : 2;
  }

  // Scene overrides address the same components through the Hub's generated
  // effective local IDs.  Apply every camera-related serialized modification
  // for which one of the four requested rigs is the target.
  for (const mod of modifications(prefabInstance(scene, SCENE_HUB_INSTANCE_FILE_ID))) {
    if (!relevantOverride(mod.propertyPath)) continue;
    const sourceID = HUB_EFFECTIVE_TO_MAIN_CITY.get(normalizeFileID(mod.target));
    const component = sourceID ? mutableComponents.get(sourceID) : null;
    if (component) setPath(component.data, mod.propertyPath, mod.value);
  }

  const rigs = rigSources.map(({ name, components }) => {
    const camera = componentFor(components, CINEMACHINE_CAMERA_GUID);
    const transform = components.find((entry) => entry.classId === 4);
    if (!camera || !transform) throw new Error(`Incomplete camera rig: ${name}`);

    const mode = number(camera.data.Lens?.ModeOverride, `${name}.Lens.ModeOverride`);
    const lensData = { ...camera.data.Lens, ...globalLens };
    const rig = {
      name,
      enabled: Boolean(number(camera.data.m_Enabled, `${name}.m_Enabled`)),
      lens: {
        fov: number(lensData.FieldOfView, `${name}.Lens.FieldOfView`),
        orthographic: mode === 1,
        orthoSize: number(lensData.OrthographicSize, `${name}.Lens.OrthographicSize`),
        near: number(lensData.NearClipPlane, `${name}.Lens.NearClipPlane`),
        far: number(lensData.FarClipPlane, `${name}.Lens.FarClipPlane`),
      },
    };

    const follow = componentFor(components, CINEMACHINE_FOLLOW_GUID);
    if (follow) {
      rig.follow = {
        offset: vector(follow.data.FollowOffset, ['x', 'y', 'z'], `${name}.FollowOffset`),
        damping: vector(follow.data.TrackerSettings?.PositionDamping, ['x', 'y', 'z'], `${name}.TrackerSettings.PositionDamping`),
        rotateDamping: number(follow.data.TrackerSettings?.QuaternionDamping, `${name}.TrackerSettings.QuaternionDamping`),
      };
    }

    const positionComposer = componentFor(components, POSITION_COMPOSER_GUID);
    if (positionComposer) {
      rig.positionComposer = {
        cameraDistance: number(positionComposer.data.CameraDistance, `${name}.CameraDistance`),
        targetOffset: vector(positionComposer.data.TargetOffset, ['x', 'y', 'z'], `${name}.TargetOffset`),
      };
    }

    const rotationComposer = componentFor(components, ROTATION_COMPOSER_GUID);
    const lookahead = positionComposer?.data?.Lookahead ?? rotationComposer?.data?.Lookahead;
    if (lookahead && lookahead.Time != null && lookahead.Smoothing != null) {
      rig.lookahead = {
        time: number(lookahead.Time, `${name}.Lookahead.Time`),
        smoothing: number(lookahead.Smoothing, `${name}.Lookahead.Smoothing`),
      };
    }

    rig.transform = {
      position: vector(transform.data.m_LocalPosition, ['x', 'y', 'z'], `${name}.m_LocalPosition`),
      rotation: vector(transform.data.m_LocalRotation, ['x', 'y', 'z', 'w'], `${name}.m_LocalRotation`),
    };
    return rig;
  });

  const output = {
    source: {
      scene: scenePath,
      prefabs: [hubPath, cameraCityPath],
    },
    rigs,
  };
  fs.mkdirSync(path.dirname(DEFAULT_OUT), { recursive: true });
  fs.writeFileSync(DEFAULT_OUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`[extract-camera] rigs=${rigs.length} out=${DEFAULT_OUT}`);
}

main();
