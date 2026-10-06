// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Mutation runner: apply each mutant to SOURCE, run the named test file, require RED (non-zero exit), restore the file.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const X = 'client/extensions/rayfire/';
const M = [
  ['#1 volume formula sign/div', 'geometry.js', 'return s / 6;', 'return s / 5;', 'rayfire-geometry'],
  ['#2 watertight checker always true', 'geometry.js', 'if (checkClosed(polys, 0)) return true;', 'return true;', 'rayfire-geometry'],
  ['#2b oracle ignores twins', 'geometry.js', 'if (!dir.has(b * SH + a)) return false;', 'if (false) return false;', 'rayfire-geometry'],
  ['#2c oracle quantised-only (drop exact pass)', 'geometry.js', 'if (checkClosed(polys, 0)) return true;', '', 'rayfire-geometry'],
  ['#3 approximate split (skip cut cap)', 'fracture.js', 'for (const loop of loops) for (const poly of capPolygons(loop)) out.push', 'for (const loop of []) for (const poly of capPolygons(loop)) out.push', 'rayfire-fracture'],
  ['#3b overlapping split (no clipping)', 'fracture.js', 'if (pos === 0) { out.push(f); continue; }\n    if (neg === 0) continue;', 'out.push(f); continue;', 'rayfire-fracture'],
  ['#5/#6 seed ignored', 'fracture.js', 'seed: (o.seed ?? o.sd ?? 1) >>> 0,', 'seed: 1,', 'rayfire-fracture'],
  ['#7 cut faces tagged exterior', 'fracture.js', 'out.push({ verts: poly, interior: true, materialId: interiorMaterial })', 'out.push({ verts: poly, interior: false, materialId: 0 })', 'rayfire-fracture'],
  // #8 original mutant (`seeds.length === 1 ? proxy : buildCell` -> always buildCell) is EQUIVALENT: buildCell with one seed has an empty
  // `others` list, runs zero clip iterations and returns the proxy faces unchanged (uncapped=false; the proxy flag is OR-ed in below).
  // Replaced by a real spurious-cut mutant: an extra seed at amount 1.
  ['#8 spurious extra seed at amount 1', 'fracture.js', 'let n = amount;', 'let n = amount + 1;', 'rayfire-fracture'],
  ['#9 bias ignored', 'fracture.js', 'if (bias > 0 && biasPoint) {', 'if (false) {', 'rayfire-fracture'],
  ['#10 skip open-shell pre-close', 'closure.js', 'const closed = closeBoundaries(faces, { interiorMaterial, quantum: 0 });', 'const closed = { faces, uncapped: false, capped: 0 };', 'rayfire-fracture'],
  ['#10b skip post-close+hull ladder', 'fracture.js', '  if (!isWatertight(faces)) {\n    const ab = boundsOfFaces', '  if (false) {\n    const ab = boundsOfFaces', 'rayfire-closure'],
  ['#11 keep zero-volume slivers', 'fracture.js', 'if (!(vol > volEps)) return null;', '', 'rayfire-closure'],
  ['#15 local-space stub (no matrix copy)', 'render.js', 'mesh.matrix.copy(source.matrixWorld);', '', 'rayfire-render'],
  ['#14 single material', 'render.js', 'return cells.map(cell => {\n    const mesh = new THREE.Mesh(facesToBufferGeometry(cell.faces), mats);', 'return cells.map(cell => {\n    const mesh = new THREE.Mesh(facesToBufferGeometry(cell.faces), mats[0]);', 'rayfire-render'],
  ['#17 impulse first fragment not nearest', 'render.js', 'if (d < best) { best = d; closest = i; }', 'if (i === 0) { best = d; closest = i; }', 'rayfire-glue'],
  ['#18 no ground clamp', 'world.js', 'p.y = this.groundY + ext;', '', 'rayfire-world'],
  ['#18b never sleeps', 'world.js', 'b.awake = false; v.x', 'v.x', 'rayfire-world'],
  ['#19 modes swapped', 'world.js', "const k = mode === 'impulse' ? 1 / b.mass : 1;", "const k = mode === 'impulse' ? 1 : 1 / b.mass;", 'rayfire-world'],
  ['#20 raycast returns farther', 'world.js', 'if (best && t >= best.distance) continue;', 'if (best && t <= best.distance) continue;', 'rayfire-world'],
  ['#36 removeBody leaks', 'world.js', 'removeBody(id) { return this.bodies.delete(id); }', 'removeBody(id) { return this.bodies.has(id); }', 'rayfire-glue'],
  ['#21 round not trunc', 'demolition.js', 'Math.trunc(am * dpf + 1e-9)', 'Math.round(am * dpf)', 'rayfire-demolition'],
  ['#21b no floor 3', 'demolition.js', 'Math.max(MIN_CHILD_AMOUNT, ', '(', 'rayfire-demolition'],
  ['#23 anchor by AABB overlap', 'structure.js', 'if (pointInBox(f.centroid, box))', 'if (pointInBox({ x: f.aabb.max.x, y: f.aabb.max.y, z: f.aabb.max.z }, box))', 'rayfire-structure'],
  ['#24 adjacency connects everything', 'structure.js', 'if (b.min.y - expand > a.max.y + expand || b.max.y + expand < a.min.y - expand) continue;', '', 'rayfire-structure'],
  ['#25 components ignore broken joints', 'structure.js', 'if (j.broken) continue;\n    const a = find(j.i)', 'const a = find(j.i)', 'rayfire-structure'],
  ['#27 support = adjacency only (no cone)', 'structure.js', '<= support) { sup[b] = true;', '<= 180) { sup[b] = true;', 'rayfire-structure'],
  ['#28 support without anchors', 'structure.js', 'if (fragments[i].unyielding) { sup[i] = true; queue.push(i); }', 'sup[i] = true; queue.push(i);', 'rayfire-structure'],
  ['#29 supported joints erode', 'structure.js', 'if (supported[j.i] && supported[j.j]) continue;', '', 'rayfire-structure'],
  ['#29b erosion never accumulates', 'structure.js', 'j.stress = (j.stress ?? 0) + (ang / 180) * sizeRatio * erosion;', 'j.stress = 0;', 'rayfire-structure'],
  ['#30 area rule inverted', 'collapse.js', 'jitter(j.area ?? 1, v, rand01(seed, a, b)) < minArea', 'jitter(j.area ?? 1, v, rand01(seed, a, b)) > minArea', 'rayfire-collapse'],
  ['#31 protection removed (area)', 'collapse.js', 'if (j.broken || protectedJoint(j, fragments)) continue;\n    const [a, b] = pairKey(j);\n    if (jitter', 'if (j.broken) continue;\n    const [a, b] = pairKey(j);\n    if (jitter', 'rayfire-collapse'],
  ['#31b protection removed (random)', 'collapse.js', 'if (j.broken || protectedJoint(j, fragments)) continue;\n    const [a, b] = pairKey(j);\n    if (rand01', 'if (j.broken) continue;\n    const [a, b] = pairKey(j);\n    if (rand01', 'rayfire-collapse'],
  ['#32 size rule breaks one joint only', 'collapse.js', 'if (small.has(j.i) || small.has(j.j)) { j.broken = true; n++; }', 'if (small.has(j.i) && small.has(j.j)) { j.broken = true; n++; }', 'rayfire-collapse'],
  ['#33 random unseeded (order dependent)', 'collapse.js', 'if (rand01(seed, a, b) * 100 < percent)', 'if (rand01(seed, n, 0) * 100 < percent)', 'rayfire-collapse'],
  ['#34 runCollapseSteps stops short', 'collapse.js', 'for (let k = 0; k <= steps; k++)', 'for (let k = 0; k < steps; k++)', 'rayfire-collapse'],
  ['#12/act idempotence lost', 'activation.js', 'if (state.activated || !activatable(state)) return false;\n  const body', 'const body', 'rayfire-lifecycle'],
  ['#37 SCALE_DOWN never removes', 'fade.js', 'if (k >= 1) { state.phase', 'if (false) { state.phase', 'rayfire-lifecycle'],
  ['#37b NONE fades', 'fade.js', 'if (o.fadeType === FadeType.NONE || state.removed) return state;', 'if (state.removed) return state;', 'rayfire-lifecycle'],
  ['#14 explode ignores range', 'impulses.js', 'if (!(distance <= range)) return;', '', 'rayfire-lifecycle'],
  ['#14b shoot hits farther', 'impulses.js', "world.applyImpulse(hit.id, impulse, 'velocityChange');", "world.applyImpulse(hit.id, impulse, 'impulse');", 'rayfire-lifecycle'],
  ['#38 api missing name', 'index.js', 'FADE_DEFAULTS, explode, shoot,\n});', 'FADE_DEFAULTS, explode,\n});', 'rayfire-index'],
];
let alive = 0;
for (const [name, file, from, to, test] of M) {
  const p = path.join(ROOT, X, file), orig = fs.readFileSync(p, 'utf8');
  if (!orig.includes(from)) { console.log(`?? ${name}: pattern not found in ${file}`); alive++; continue; }
  fs.writeFileSync(p, orig.replace(from, to));
  let r;
  try { r = spawnSync('node', ['--test', `test/${test}.test.js`], { cwd: ROOT, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' }); } finally { fs.writeFileSync(p, orig); }
  const hung = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL';
  const red = hung || r.status !== 0;
  if (!red) alive++;
  console.log(`${red ? (hung ? 'KILLED(hang)' : 'KILLED') : 'SURVIVED'} ${name}  [${file} -> ${test}]`);
}
console.log(`\n${M.length - alive}/${M.length} killed`);
process.exit(alive ? 1 : 0);
