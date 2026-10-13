// generator for worlds/skate-maps/{scenes/main.json,game.json}  —  `bun worlds/skate-maps/gen-world.mjs`
// numbers: ~/Games/reskate/maps/{city,mpr}/bounds.json (instance_origin_p1/p99). Y up, metres, native game coords.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const city = { p1: [-237.632, 191.016, 988.444], p99: [984.062, 419.317, 1998.69] };
const mpr = { p1: [-123.422, 176.577, -669.843], p99: [405.321, 283.514, -241.507] };
// SNAP: mpr p1 corner sits 100 m past city p99 on x; z/y aligned to city p1 so the two footprints sit side by side
const snap = [city.p99[0] + 100 - mpr.p1[0], city.p1[1] - mpr.p1[1], city.p1[2] - mpr.p1[2]].map((n) => +n.toFixed(3));
const round = (n) => +n.toFixed(2);
const ent = {};
// --- environment: daylight, no fog (2 km view), neutral hemisphere
ent.skate_env = {
  environment: {
    background: '#b9cde6',
    fog: { color: '#b9cde6', near: 9000, far: 90000 },
    exposure: 1,
    hemisphere: { sky: '#cfe0f5', ground: '#4a4742', intensity: 0.9 },
    sun: { color: '#fff4e0', intensity: 2.2, position: [900, 1200, 300] },
    ambient: { color: '#c8d0dc', intensity: 0.1 },
    bloom: { strength: 0, radius: 0.4, threshold: 1 },
  },
  spawn: { position: [1700, 1300, 600], yaw: 1.5708 },
};
// --- the two maps, static, native coords (glb files = assets/city.glb, assets/mpr.glb → symlinks, gitignored)
ent.map_city = { transform: { position: [0, 0, 0] }, mesh: { gltf: { src: '/assets/city.glb', solid: false } } };
ent.map_mpr = { transform: { position: [0, 0, 0] }, mesh: { gltf: { src: '/assets/mpr.glb', solid: false } } };
// --- step 2: vistas (unpruned mountains/ocean/ships, own glbs) + sky dome (tx_bam_pano_1300 upper-hemisphere pano, unlit, r=22 km). needs camera far >= 30000 -> `?far=60000`
ent.map_city_vista = { transform: { position: [0, 0, 0] }, mesh: { gltf: { src: '/assets/city_vista.glb', solid: false } } };
ent.map_mpr_vista = { transform: { position: [0, 0, 0] }, mesh: { gltf: { src: '/assets/mpr_vista.glb', solid: false } } };
ent.skydome = { transform: { position: [400, 0, 1000] }, mesh: { gltf: { src: '/assets/skydome.glb', solid: false } } };
// --- ground grid, 100 m, y=150 (below both maps), thicker every 500 m
const GY = 150, X0 = -700, X1 = 1900, Z0 = -1500, Z1 = 2900, T = 0.8;
const lines = [], thick = [];
for (let x = X0; x <= X1; x += 100) (x % 500 === 0 ? thick : lines).push({ shape: 'box', position: [x, 0, (Z0 + Z1) / 2], size: [x % 500 === 0 ? 3 : T, 0.4, Z1 - Z0], color: x % 500 === 0 ? '#3a4658' : '#7c8794' });
for (let z = Z0; z <= Z1; z += 100) (z % 500 === 0 ? thick : lines).push({ shape: 'box', position: [(X0 + X1) / 2, 0, z], size: [X1 - X0, 0.4, z % 500 === 0 ? 3 : T], color: z % 500 === 0 ? '#3a4658' : '#7c8794' });
ent.grid = { transform: { position: [0, GY, 0] }, mesh: { parts: [...lines, ...thick] } };
// --- block-letter labels (5x7 font), standing, readable from +x looking -x (screen-right = -z)
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'], P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'], S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'], U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'], C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  '.': ['0', '0', '0', '0', '0', '0', '1'], ' ': ['00', '00', '00', '00', '00', '00', '00'], '+': ['000', '000', '010', '111', '010', '000', '000'],
};
function label(text, color, px) {
  const parts = []; let col = 0;
  const chars = [...text];
  const width = chars.reduce((w, c) => w + FONT[c][0].length + 1, -1);
  for (const c of chars) {
    const g = FONT[c];
    for (let r = 0; r < 7; r++) for (let k = 0; k < g[r].length; k++) if (g[r][k] === '1') {
      // local: z runs along -z (reading direction), y up
      parts.push({ shape: 'box', position: [0, round((6 - r) * px), round(-(col + k - (width - 1) / 2) * px)], size: [px * 0.9, px * 0.9, px * 0.9], color, emissive: color, emissiveIntensity: 0.6 });
    }
    col += g[0].length + 1;
  }
  return parts;
}
const cityC = [(city.p1[0] + city.p99[0]) / 2, 0, (city.p1[2] + city.p99[2]) / 2], mprC = [(mpr.p1[0] + mpr.p99[0]) / 2, 0, (mpr.p1[2] + mpr.p99[2]) / 2];
ent.label_city = { transform: { position: [round(cityC[0]), 640, round(cityC[2])] }, mesh: { parts: label('SAN VANSTERDAM', '#ff8a3d', 12) } };
ent.label_mpr = { transform: { position: [round(mprC[0]), 520, round(mprC[2])] }, mesh: { parts: label('S.U.M.R. CAMP', '#37c8ff', 12) } };
fs.mkdirSync(path.join(here, 'scenes'), { recursive: true });
fs.writeFileSync(path.join(here, 'scenes/main.json'), JSON.stringify(ent, null, 1));
// --- game.json: levels = the toggle. overview = native coords; snap = mpr (+label) moved by `snap`. ?level=<id>
// native level: NO map offset (map_mpr/label_mpr stay at scene coords). vistas swapped to v3 glbs (flat-shaded, mountain #6f7a6a / ground #8a8f86), fog start 12 km so 3 km peaks read
const nativeOps = [
{ op: 'set', id: 'map_city_vista', component: 'mesh', value: { gltf: { src: '/assets/city_vista_v3.glb', solid: false } } },
{ op: 'set', id: 'map_mpr_vista', component: 'mesh', value: { gltf: { src: '/assets/mpr_vista_v3.glb', solid: false } } },
{ op: 'set', id: 'skate_env', component: 'environment', value: { ...ent.skate_env.environment, fog: { color: '#b9cde6', near: 12000, far: 60000 } } },
];
const setPos = (id, p) => ({ op: 'set', id, component: 'transform', value: { position: p } });
const game = {
  title: 'SKATE MAPS',
  subtitle: 'San Vansterdam + S.U.M.R. Camp — native vs snapped',
  menu: { camera: { position: [1700, 1300, 600], yaw: 1.5708, pitch: -0.55 } },
  levels: [
    { id: 'overview', name: 'native coords (1.2 km apart on z)', spawn: { position: [1700, 1300, 600], yaw: 1.5708 }, reset: true, ops: [] },
    { id: 'snap', name: `snap mpr next to city (+${snap.join(', ')})`, spawn: { position: [1800, 1900, 1300], yaw: 1.5708 }, reset: true, ops: [setPos('map_mpr', snap), setPos('label_mpr', [round(mprC[0] + snap[0]), 520, round(mprC[2] + snap[2])])] },
  { id: 'native', name: 'native: city + mpr + real mountains, NO offset (?level=native => far 60000)', spawn: { position: [500, 1500, 3200], yaw: 3.1416 }, reset: true, ops: nativeOps },
],
};
fs.writeFileSync(path.join(here, 'game.json'), JSON.stringify(game, null, 1));
fs.writeFileSync(path.join(here, 'world.json'), JSON.stringify({ scenes: { main: { always: true } } }, null, 1));
console.log('snap offset', snap, 'cityC', cityC, 'mprC', mprC);
