// motion-rt.js — live ragdoll client for gaia-motion's real-time server.
//
// Engine extension contract (kernel/extensions.js): register(ctx) → {name, api, update}.
// Opt-in by URL: ?motion=1 (default ws://127.0.0.1:8979) or ?motion=ws://host:port.
// No ?motion → register() is a no-op (no socket, no meshes, no HUD).
//
// WIRE (server → client, per tick):  {t, phase?, behaviour?, bodies:[{name,pos:[x,y,z],quat:[x,y,z,w]}]}
// WIRE (client → server):
//   {cmd:'impulse', body:'Pelvis', ns:300, axis:[1,0,0]}   key I
//   {cmd:'reset'}                                           key R
//   {cmd:'behaviour', name:'bodyBalance'|'catchFall'|'staggerFall'|'shot'|'protectHead'}   keys 1..5
//
// COORDS: real gaia-motion rt server is MuJoCo = right-handed, Z-up, metres (xpos = body ORIGIN, quat xyzw).
// three.js/GWE is Y-up → the Ragdoll group is rotated -90° about X (pos+quat convert together). ?motionUp=y = identity (mock / Y-up server).
// ?motionQuat=wxyz flips the quaternion component order if a server sends w-first;
// ?motionAt=x,y,z adds a world offset to the whole Ragdoll group.
//
// SHAPES: pos is the body ORIGIN (SMPL joint). Bodies with a known child get a capsule
// spanning origin→child (offset measured once from the first frame, in the body's own
// frame, so it rotates rigidly with the body); leaf bodies (Toe/Head/Hand) get a sphere.
// Meshes are made from the names in the frame (unknown names → sphere), so a different
// rig still renders.

export const DEFAULT_URL = 'ws://127.0.0.1:8979';
export const KEYS = {
  KeyI: { cmd: 'impulse', body: 'Pelvis', ns: 300, axis: [1, 0, 0] },
  KeyR: { cmd: 'reset' },
  Digit1: { cmd: 'behaviour', name: 'bodyBalance' },
  Digit2: { cmd: 'behaviour', name: 'catchFall' },
  Digit3: { cmd: 'behaviour', name: 'staggerFall' },
  Digit4: { cmd: 'behaviour', name: 'shot' },
  Digit5: { cmd: 'behaviour', name: 'protectHead' },
};

// SMPL (24-body) chain: body → the child its capsule points at
const CHILD = {
  Pelvis: 'Torso', Torso: 'Spine', Spine: 'Chest', Chest: 'Neck', Neck: 'Head',
  L_Hip: 'L_Knee', L_Knee: 'L_Ankle', L_Ankle: 'L_Toe',
  R_Hip: 'R_Knee', R_Knee: 'R_Ankle', R_Ankle: 'R_Toe',
  L_Thorax: 'L_Shoulder', L_Shoulder: 'L_Elbow', L_Elbow: 'L_Wrist', L_Wrist: 'L_Hand',
  R_Thorax: 'R_Shoulder', R_Shoulder: 'R_Elbow', R_Elbow: 'R_Wrist', R_Wrist: 'R_Hand',
};
const RADIUS = {
  Pelvis: 0.085, Torso: 0.075, Spine: 0.075, Chest: 0.1, Neck: 0.045, Head: 0.1,
  L_Hip: 0.06, L_Knee: 0.054, L_Ankle: 0.045, L_Toe: 0.04, R_Hip: 0.06, R_Knee: 0.054, R_Ankle: 0.045, R_Toe: 0.04,
  L_Thorax: 0.052, L_Shoulder: 0.052, L_Elbow: 0.04, L_Wrist: 0.032, L_Hand: 0.05,
  R_Thorax: 0.052, R_Shoulder: 0.052, R_Elbow: 0.04, R_Wrist: 0.032, R_Hand: 0.05,
};
const colorOf = (n) => (n.startsWith('L_') ? 0x4aa8ff : n.startsWith('R_') ? 0xff9a3c : 0xd8d8d8);

function params() {
  try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); }
}

export function motionUrl(p = params()) {
  if (!p.has('motion')) return null;
  const v = p.get('motion');
  return /^wss?:\/\//.test(v) ? v : DEFAULT_URL;
}

export function createMotionRt({ THREE, scene, url, wxyz = false, zUp = true, at = [0, 0, 0], document: doc = globalThis.document, WebSocketImpl = globalThis.WebSocket }) {
  const group = new THREE.Group();
  group.name = 'Ragdoll';
  group.position.set(...at);
group.rotation.x = zUp ? -Math.PI / 2 : 0; // MuJoCo world is Z-up: (x,y,z)->three (x,z,-y); quats ride the same group rotation
  scene.add(group);

  const meshes = new Map();
  const arrivals = []; // performance.now() of each frame, trimmed to 1 s
  const state = { url, status: 'connecting', hz: 0, phase: '—', behaviour: '', t: 0, frames: 0, bodies: 0 };
  let socket = null;
  let retry = 500;
  let rest = null; // first frame by name — capsule extents come from it
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();

  // HUD: its own div so it never fights the engine's #hud
  const hud = doc.createElement('div');
  hud.id = 'motion-hud';
  hud.style.cssText = 'position:fixed;top:34px;left:10px;z-index:30;font:12px/1.4 ui-monospace,Menlo,monospace;color:#cfe;background:rgba(0,0,0,.55);padding:5px 9px;border-radius:4px;pointer-events:none;white-space:pre';
  doc.body.appendChild(hud);
  const renderHud = () => {
    hud.textContent = `MOTION-RT ${state.status} · ${state.hz.toFixed(1)} Hz · phase ${state.phase}`
      + `${state.behaviour ? ` · ${state.behaviour}` : ''} · ${state.bodies} bodies · t ${state.t.toFixed(2)}\n`
      + 'I impulse · R reset · 1 balance 2 catchFall 3 staggerFall 4 shot 5 protectHead';
  };

  function makeMesh(name, frameByName) {
    const r = RADIUS[name] ?? 0.06;
    const child = frameByName.get(CHILD[name]);
    const me = frameByName.get(name);
    let geo;
    if (child) {
      // origin→child in the BODY frame, measured once
      q.set(...me.quat).invert();
      v.set(child.pos[0] - me.pos[0], child.pos[1] - me.pos[1], child.pos[2] - me.pos[2]).applyQuaternion(q);
      const len = v.length();
      geo = new THREE.CapsuleGeometry(r, Math.max(len - 2 * r, 0.005), 6, 12);
      geo.translate(0, len / 2, 0);
      geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.clone().normalize()));
    } else {
      geo = new THREE.SphereGeometry(r, 16, 12);
    }
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: colorOf(name), roughness: 0.6, metalness: 0.05 }));
    mesh.name = name;
    mesh.matrixAutoUpdate = true;
    group.add(mesh);
    meshes.set(name, mesh);
    return mesh;
  }

  const quatOf = (a) => (wxyz ? [a[1], a[2], a[3], a[0]] : [a[0], a[1], a[2], a[3]]);

  function onFrame(msg) {
    if (!Array.isArray(msg.bodies)) return;
    const bodies = msg.bodies.map((b) => ({ name: b.name, pos: b.pos, quat: quatOf(b.quat ?? [0, 0, 0, 1]) }));
    const byName = new Map(bodies.map((b) => [b.name, b]));
    if (!rest) rest = byName;
    for (const b of bodies) {
      const m = meshes.get(b.name) ?? makeMesh(b.name, rest);
      m.position.set(b.pos[0], b.pos[1], b.pos[2]);
      m.quaternion.set(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
    }
    state.bodies = meshes.size;
    state.t = msg.t ?? state.t;
    if (msg.phase != null) state.phase = String(msg.phase);
    if (msg.behaviour != null) state.behaviour = String(msg.behaviour);
    state.frames++;
    arrivals.push(performance.now());
  }

  function open() {
    state.status = 'connecting';
    socket = new WebSocketImpl(url);
    socket.onopen = () => { retry = 500; state.status = 'live'; };
    socket.onmessage = (e) => {
      try { onFrame(JSON.parse(e.data)); } catch (err) { console.warn('[motion-rt] bad frame', err); }
    };
    socket.onclose = () => {
      state.status = 'reconnecting';
      state.hz = 0;
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 5000);
    };
    socket.onerror = () => socket.close();
  }
  open();

  const send = (obj) => {
    if (socket?.readyState !== 1) return false;
    socket.send(JSON.stringify(obj));
    return true;
  };

  const onKey = (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    const cmd = KEYS[e.code];
    if (cmd) send(cmd);
  };
  globalThis.addEventListener?.('keydown', onKey);

  let hudAcc = 0;
  return {
    group, meshes, state, send,
    update(dt) {
      hudAcc += dt;
      if (hudAcc < 0.25) return;
      hudAcc = 0;
      const now = performance.now();
      while (arrivals.length && now - arrivals[0] > 1000) arrivals.shift();
      // frames in the last second, scaled by the span they actually cover
      const span = arrivals.length > 1 ? (arrivals[arrivals.length - 1] - arrivals[0]) / 1000 : 0;
      state.hz = span > 0 ? (arrivals.length - 1) / span : 0;
      renderHud();
    },
    dispose() {
      globalThis.removeEventListener?.('keydown', onKey);
      socket.onclose = null;
      socket.close();
      hud.remove();
      scene.remove(group);
    },
  };
}

export function register(ctx = {}) {
  const p = params();
  const url = motionUrl(p);
  if (!url || !ctx.scene || !ctx.three) return {};
  const at = (p.get('motionAt') ?? '0,0,0').split(',').map(Number);
  const rt = createMotionRt({ THREE: ctx.three, scene: ctx.scene, url, wxyz: p.get('motionQuat') === 'wxyz', zUp: p.get('motionUp') !== 'y', at: at.length === 3 && at.every(Number.isFinite) ? at : [0, 0, 0] });
  return { name: 'motionRt', api: rt, update: rt.update };
}
