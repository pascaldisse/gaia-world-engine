#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const ROOT = '/Users/pascaldisse/projects/GAIA-World-Engine';
const CMD_FILE = '/tmp/nari-soma.cmd';
const PID_FILE = '/tmp/nari-soma.pid';
const LOG_FILE = '/tmp/nari-soma.log';
const AFFECT_FILE = '/tmp/nari-soma-affect.json';
const BODY_ID = process.env.NARI_SOMA_BODY_ID ?? 'nyari-avatar';
const AGENT_ID = process.env.GAIA_AGENT ?? 'agent-nyari';
const GAIA_URL = process.env.GAIA_URL ?? `http://localhost:${process.env.GAIA_PORT ?? 8420}`;
const TICK_MS = 200;
const PRIORITY = { low: 0, normal: 1, high: 2 };
const WAYPOINTS = {
  noodle_stall: { x: 1190, z: 8 },
  seawall: { x: 1260, z: -20 },
  altar_lighthouse: { x: 1290, z: -60 },
};
const WANDER_ORDER = ['noodle_stall', 'seawall', 'altar_lighthouse'];

let current = null;
let offset = 0;
let pending = '';
let lastTickAt = Date.now();
let lastTickLogAt = 0;
let inTick = false;
let ownPos = null;
let lastSampleAt = 0;
let samplePromise = null;
let wanderIndex = 0;
let nextWanderAt = Date.now() + randomWanderMs();
let idleStanding = null;
const affect = { warmth: 0.6, strain: 0.1 };
const affectTarget = { warmth: 0.6, strain: 0.1 };
let lastAffectWritten = { warmth: Number.NaN, strain: Number.NaN };

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').slice(0, 500);
}

function log(line) {
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${oneLine(line)}\n`);
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

function randomWanderMs() {
  return (45 + Math.random() * 45) * 1000;
}

function writeAffect(force = false) {
  const changed =
    Math.abs(affect.warmth - lastAffectWritten.warmth) >= 0.01 ||
    Math.abs(affect.strain - lastAffectWritten.strain) >= 0.01;
  if (!force && !changed) return;
  const out = { warmth: Number(affect.warmth.toFixed(3)), strain: Number(affect.strain.toFixed(3)) };
  fs.writeFileSync(AFFECT_FILE, `${JSON.stringify(out)}\n`);
  lastAffectWritten = { ...affect };
}

function shellNode(args, { timeout = 8000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, {
      cwd: ROOT,
      timeout,
      env: { ...process.env, GAIA_URL, GAIA_AGENT: AGENT_ID, ...env },
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function agent(verb, ...args) {
  return shellNode(['tools/agent.mjs', verb, ...args.map(String)], { timeout: 12000 });
}

async function samplePosition(force = false) {
  const now = Date.now();
  if (!force && now - lastSampleAt < 2000) return ownPos;
  if (samplePromise) return samplePromise;
  lastSampleAt = now;
  samplePromise = shellNode(['tools/agent.mjs', 'describe', AGENT_ID], { timeout: 6000 })
    .then(({ stdout }) => {
      const pos = parseDescribePosition(stdout);
      if (!pos) throw new Error(`no position in describe output: ${stdout.trim().split('\n')[0] ?? ''}`);
      ownPos = pos;
      updateStuck(pos);
      return pos;
    })
    .finally(() => { samplePromise = null; });
  return samplePromise;
}

function parseDescribePosition(text) {
  const match = /at \((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/.exec(text);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  const z = Number(match[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z, at: Date.now() };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function updateStuck(pos) {
  if (!current || !['walkTo', 'follow'].includes(current.behaviorId)) return;
  current.samples ??= [];
  current.samples.push(pos);
  const cutoff = Date.now() - 7000;
  current.samples = current.samples.filter((p) => p.at >= cutoff);
}

function isStuck() {
  if (!current?.samples?.length) return false;
  const now = Date.now();
  const old = current.samples.find((p) => now - p.at >= 6000);
  const newest = current.samples[current.samples.length - 1];
  return Boolean(old && newest && distance(old, newest) < 0.3);
}

function makeBehavior(cmd, reason = 'dispatch') {
  return {
    behaviorId: String(cmd.behaviorId),
    priority: cmd.priority in PRIORITY ? cmd.priority : 'normal',
    origin: cmd.origin ?? 'unknown',
    args: cmd.args ?? {},
    state: 'new',
    startedAt: Date.now(),
    lastWalkAt: 0,
    forceWalk: true,
    samples: [],
    reason,
  };
}

function dispatch(cmd) {
  if (!cmd || typeof cmd !== 'object') return;
  const behaviorId = String(cmd.behaviorId ?? '');
  if (!behaviorId) return;
  const priority = cmd.priority in PRIORITY ? cmd.priority : 'normal';

  if (behaviorId === 'affect') {
    const channel = cmd.args?.channel;
    if (channel === 'warmth' || channel === 'strain') {
      affectTarget[channel] = clamp01(Number(cmd.args?.target));
      log(`[dispatch] behavior=affect priority=${priority} origin=${cmd.origin ?? 'unknown'} channel=${channel} target=${affectTarget[channel]}`);
      log(`[complete] behavior=affect channel=${channel}`);
    } else {
      log(`[failure] behavior=affect reason=bad-channel`);
    }
    return;
  }

  if (behaviorId === 'halt') {
    const stopped = current?.behaviorId ?? 'none';
    current = null;
    idleStanding = null;
    nextWanderAt = Date.now() + 60000;
    log(`[dispatch] behavior=halt priority=${priority} origin=${cmd.origin ?? 'unknown'} stopped=${stopped}`);
    samplePosition(true)
      .then((pos) => {
        if (!pos) return;
        return agent('move', pos.x.toFixed(3), pos.z.toFixed(3));
      })
      .then(() => log(`[complete] behavior=halt stopVerb=move-self`))
      .catch((err) => log(`[failure] behavior=halt reason=${oneLine(String(err?.message ?? err))}`));
    return;
  }

  if (current?.behaviorId === behaviorId) {
    current.priority = priority;
    current.origin = cmd.origin ?? current.origin;
    current.args = cmd.args ?? {};
    current.state = 'new';
    current.startedAt = Date.now();
    current.lastWalkAt = 0;
    current.forceWalk = true;
    current.samples = [];
    log(`[dispatch] behavior=${behaviorId} priority=${priority} origin=${current.origin} restart=same`);
    return;
  }

  if (current && PRIORITY[current.priority] > PRIORITY[priority]) {
    log(`[refused] behavior=${behaviorId} priority=${priority} current=${current.behaviorId} currentPriority=${current.priority}`);
    return;
  }

  const previous = current?.behaviorId ?? 'none';
  current = makeBehavior({ ...cmd, priority }, previous === 'none' ? 'dispatch' : 'interrupt');
  idleStanding = null;
  log(`[dispatch] behavior=${behaviorId} priority=${priority} origin=${current.origin} previous=${previous}`);
}

function pollCommands() {
  if (!fs.existsSync(CMD_FILE)) fs.writeFileSync(CMD_FILE, '');
  const st = fs.statSync(CMD_FILE);
  if (st.size < offset) {
    offset = 0;
    pending = '';
  }
  if (st.size === offset) return;
  const fd = fs.openSync(CMD_FILE, 'r');
  try {
    const buf = Buffer.alloc(st.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    offset = st.size;
    pending += buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = pending.split(/\r?\n/);
  pending = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      dispatch(JSON.parse(trimmed));
    } catch (err) {
      log(`[failure] behavior=parse reason=${oneLine(err.message ?? err)}`);
    }
  }
}

function updateAffect(dtSec) {
  let changed = false;
  for (const channel of ['warmth', 'strain']) {
    const before = affect[channel];
    const target = affectTarget[channel];
    const step = 0.1 * dtSec;
    if (Math.abs(target - before) <= step) affect[channel] = target;
    else affect[channel] += Math.sign(target - before) * step;
    if (affect[channel] !== before) changed = true;
  }
  if (changed) writeAffect(false);
}

function maybeStartIdle() {
  if (current) return;
  if (affect.strain > 0.5) {
    if (idleStanding === 'seawall') return;
    current = makeBehavior({ behaviorId: 'walkTo', priority: 'low', origin: 'idle', args: WAYPOINTS.seawall }, 'idle');
    current.idleKind = 'seawall';
    log(`[dispatch] behavior=walkTo priority=low origin=idle waypoint=seawall`);
    return;
  }
  idleStanding = null;
  if (Date.now() < nextWanderAt) return;
  const name = WANDER_ORDER[wanderIndex % WANDER_ORDER.length];
  wanderIndex += 1;
  nextWanderAt = Date.now() + randomWanderMs();
  current = makeBehavior({ behaviorId: 'walkTo', priority: 'low', origin: 'idle', args: WAYPOINTS[name] }, 'idle');
  current.idleKind = 'wander';
  current.waypoint = name;
  log(`[dispatch] behavior=walkTo priority=low origin=idle waypoint=${name}`);
}

function completeCurrent(extra = '') {
  if (!current) return;
  const done = current;
  current = null;
  if (done.idleKind === 'seawall') idleStanding = 'seawall';
  log(`[complete] behavior=${done.behaviorId}${extra ? ` ${extra}` : ''}`);
}

function failCurrent(reason, tag = 'failure') {
  if (!current) return;
  const failed = current;
  current = null;
  log(`[${tag}] behavior=${failed.behaviorId} reason=${reason}`);
}

async function tickBehavior() {
  if (!current) return;
  const b = current;
  try {
    if (b.behaviorId === 'walkTo' || b.behaviorId === 'follow') {
      const target = { x: Number(b.args?.x), z: Number(b.args?.z) };
      if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) {
        failCurrent('bad-target');
        return;
      }
      const pos = await samplePosition(false);
      if (current !== b || !pos) return;
      const d = distance(pos, target);
      if (b.behaviorId === 'walkTo' && d <= 1.5) {
        completeCurrent(`distance=${d.toFixed(2)}`);
        return;
      }
      if (isStuck()) {
        failCurrent('moved<0.3m/6s', 'stuck');
        return;
      }
      const now = Date.now();
      const targetKey = `${target.x.toFixed(2)},${target.z.toFixed(2)}`;
      if (b.forceWalk || b.moveTargetKey !== targetKey || now - b.lastWalkAt >= 5000) {
        b.forceWalk = false;
        b.lastWalkAt = now;
        b.moveTargetKey = targetKey;
        agent('move', target.x.toFixed(3), target.z.toFixed(3)).catch((err) => {
          if (current === b) failCurrent(`agent-move:${String(err.message ?? err)}`);
        });
      }
      return;
    }

    if (b.behaviorId === 'face') {
      if (b.state === 'running') return;
      b.state = 'running';
      const target = { x: Number(b.args?.x), z: Number(b.args?.z) };
      if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) {
        failCurrent('bad-target');
        return;
      }
      const pos = await samplePosition(true);
      if (current !== b || !pos) return;
      const yaw = Math.atan2(-(target.x - pos.x), -(target.z - pos.z));
      await agent('face', yaw.toFixed(6));
      if (current === b) completeCurrent(`yaw=${yaw.toFixed(3)}`);
      return;
    }

    failCurrent('unknown-behavior');
  } catch (err) {
    if (current === b) failCurrent(String(err.message ?? err));
  }
}

async function tick() {
  if (inTick) return;
  inTick = true;
  try {
    const now = Date.now();
    const dtSec = Math.max(0, Math.min(1, (now - lastTickAt) / 1000));
    lastTickAt = now;
    pollCommands();
    updateAffect(dtSec);
    maybeStartIdle();
    await tickBehavior();
    if (now - lastTickLogAt >= 1000) {
      lastTickLogAt = now;
      log(`[tick] current=${current?.behaviorId ?? 'none'} warmth=${affect.warmth.toFixed(2)} strain=${affect.strain.toFixed(2)}`);
    }
  } catch (err) {
    log(`[failure] behavior=tick reason=${oneLine(err.message ?? err)}`);
  } finally {
    inTick = false;
  }
}

fs.writeFileSync(PID_FILE, `${process.pid}\n`);
if (!fs.existsSync(CMD_FILE)) fs.writeFileSync(CMD_FILE, '');
offset = fs.statSync(CMD_FILE).size;
writeAffect(true);
log(`[start] pid=${process.pid} agent=${AGENT_ID} body=${BODY_ID} gaia=${GAIA_URL}`);
setInterval(tick, TICK_MS);
tick();
