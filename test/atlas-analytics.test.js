// test/atlas-analytics.test.js — standalone bun test for client/plugins/atlas-analytics.js
// Run: bun test test/atlas-analytics.test.js
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildAdjacency,
  degree,
  pagerank,
  louvain,
  shortestPath,
  outliers,
  layoutByGroups,
  layoutShells,
  layoutTimeline,
  layoutOrbit,
  createSim,
} from '../client/plugins/atlas-analytics.js';

const SIDECAR_PATH = '/Users/pascaldisse/projects/paloptic/viz/data/atlas-graph.json';

function starGraph(leafCount) {
  const nodes = [{ id: 'center', kind: 'hub', label: 'center' }];
  const edges = [];
  for (let i = 0; i < leafCount; i += 1) {
    const id = `leaf${i}`;
    nodes.push({ id, kind: 'leaf', label: id });
    edges.push({ id: `e${i}`, from: id, to: 'center', kind: 'belongs_to' });
  }
  return { nodes, edges };
}

function twoCliqueGraph(size = 5) {
  const nodes = [];
  const edges = [];
  let eid = 0;
  for (const prefix of ['a', 'b']) {
    for (let i = 0; i < size; i += 1) nodes.push({ id: `${prefix}${i}`, kind: 'n', label: `${prefix}${i}` });
    for (let i = 0; i < size; i += 1) {
      for (let j = i + 1; j < size; j += 1) {
        edges.push({ id: `e${eid++}`, from: `${prefix}${i}`, to: `${prefix}${j}`, kind: 'link', weight: 1 });
      }
    }
  }
  return { nodes, edges };
}

function syntheticGraph(n, seedFn) {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < n; i += 1) nodes.push({ id: `n${i}`, kind: i % 3 === 0 ? 'store' : i % 3 === 1 ? 'customer' : 'order', label: `n${i}` });
  let eid = 0;
  let s = seedFn;
  for (let i = 0; i < n; i += 1) {
    const degreeCount = 2 + (i % 4);
    for (let k = 0; k < degreeCount; k += 1) {
      s = (s * 1103515245 + 12345) >>> 0;
      const j = s % n;
      if (j === i) continue;
      edges.push({ id: `e${eid++}`, from: `n${i}`, to: `n${j}`, kind: 'link', weight: 1 + (s % 3) });
    }
  }
  return { nodes, edges };
}

function loadSidecar() {
  const raw = readFileSync(SIDECAR_PATH, 'utf8');
  const data = JSON.parse(raw);
  return { nodes: data.nodes, edges: data.edges };
}

// ---------------------------------------------------------------------------

describe('buildAdjacency / degree', () => {
  test('directed entries with correct dir + weight default', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const edges = [{ id: 'e1', from: 'a', to: 'b', kind: 'x' }, { id: 'e2', from: 'c', to: 'b', kind: 'y', weight: 3 }];
    const adj = buildAdjacency(nodes, edges);
    expect(adj.byId.size).toBe(3);
    const aOut = adj.neighbors.get('a');
    expect(aOut).toEqual([{ id: 'b', edgeId: 'e1', kind: 'x', weight: 1, dir: 'out' }]);
    const bIn = adj.neighbors.get('b');
    expect(bIn.length).toBe(2);
    expect(bIn.find((n) => n.id === 'c').weight).toBe(3);
    expect(bIn.find((n) => n.id === 'c').dir).toBe('in');

    const deg = degree(adj);
    expect(deg.get('a')).toEqual({ in: 0, out: 1, total: 1 });
    expect(deg.get('b')).toEqual({ in: 2, out: 0, total: 2 });
  });
});

describe('pagerank', () => {
  test('normalizes to ~1 and hub dominates a star graph', () => {
    const { nodes, edges } = starGraph(9);
    const adj = buildAdjacency(nodes, edges);
    const pr = pagerank(adj, { damping: 0.85, iterations: 40 });
    let sum = 0;
    for (const v of pr.values()) sum += v;
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    const center = pr.get('center');
    const leaf = pr.get('leaf0');
    expect(center).toBeGreaterThan(leaf * 5);
  });

  test('deterministic across runs (fixed iteration count, no RNG)', () => {
    const { nodes, edges } = starGraph(9);
    const adj = buildAdjacency(nodes, edges);
    const a = pagerank(adj);
    const b = pagerank(adj);
    for (const [id, v] of a) expect(b.get(id)).toBe(v);
  });
});

describe('louvain', () => {
  test('finds two communities on a two-clique fixture, modularity > 0, deterministic per seed', () => {
    const { nodes, edges } = twoCliqueGraph(5);
    const adj = buildAdjacency(nodes, edges);
    const r1 = louvain(adj, { seed: 7 });
    const r2 = louvain(adj, { seed: 7 });
    expect(r1.modularity).toBeGreaterThan(0);
    expect(r1.count).toBeGreaterThanOrEqual(2);
    // clique members share a community with each other
    const ca = r1.communities.get('a0');
    for (let i = 1; i < 5; i += 1) expect(r1.communities.get(`a${i}`)).toBe(ca);
    const cb = r1.communities.get('b0');
    for (let i = 1; i < 5; i += 1) expect(r1.communities.get(`b${i}`)).toBe(cb);
    expect(ca).not.toBe(cb);
    // determinism
    for (const [id, c] of r1.communities) expect(r2.communities.get(id)).toBe(c);
    expect(r1.modularity).toBe(r2.modularity);
  });

  test('modularity improves over singleton baseline', () => {
    const { nodes, edges } = twoCliqueGraph(5);
    const adj = buildAdjacency(nodes, edges);
    const r = louvain(adj, { seed: 3 });
    // singleton baseline modularity is always <= 0 for a connected weighted graph with m>0
    expect(r.modularity).toBeGreaterThan(0);
  });
});

describe('shortestPath', () => {
  test('finds correct path length + edge list, null for disconnected', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'isolated' }];
    const edges = [
      { id: 'e1', from: 'a', to: 'b' },
      { id: 'e2', from: 'b', to: 'c' },
      { id: 'e3', from: 'c', to: 'd' },
      { id: 'e4', from: 'a', to: 'd', weight: 10 },
    ];
    const adj = buildAdjacency(nodes, edges);
    const bfs = shortestPath(adj, 'a', 'd');
    expect(bfs.path).toEqual(['a', 'd']); // 1 hop via e4 beats 3 hops in BFS (unweighted = fewest edges)
    expect(bfs.edges).toEqual(['e4']);

    const dijkstra = shortestPath(adj, 'a', 'd', { weighted: true });
    expect(dijkstra.path).toEqual(['a', 'b', 'c', 'd']); // weight 1+1+1=3 beats weight 10
    expect(dijkstra.edges).toEqual(['e1', 'e2', 'e3']);

    expect(shortestPath(adj, 'a', 'isolated')).toBeNull();
    expect(shortestPath(adj, 'a', 'nope')).toBeNull();
    expect(shortestPath(adj, 'a', 'a')).toEqual({ path: ['a'], edges: [] });
  });
});

describe('outliers', () => {
  test('returns low-degree ids sorted', () => {
    const nodes = [{ id: 'hub' }, { id: 'a' }, { id: 'b' }, { id: 'lonely' }];
    const edges = [
      { id: 'e1', from: 'hub', to: 'a' },
      { id: 'e2', from: 'hub', to: 'b' },
    ];
    const adj = buildAdjacency(nodes, edges);
    const out = outliers(adj, { maxDegree: 1 });
    expect(out).toEqual(['lonely', 'a', 'b']);
  });
});

describe('layouts', () => {
  const nodes = [];
  for (let i = 0; i < 40; i += 1) nodes.push({ id: `n${i}`, kind: ['store', 'customer', 'order'][i % 3], label: `n${i}`, stats: { relations: i % 2 === 0 ? i * 3 : null } });

  test('layoutByGroups covers every node, no NaN, deterministic per seed', () => {
    const groups = new Map(nodes.map((n, i) => [n.id, i % 5]));
    const p1 = layoutByGroups(nodes, groups, { seed: 11 });
    const p2 = layoutByGroups(nodes, groups, { seed: 11 });
    expect(p1.size).toBe(nodes.length);
    for (const n of nodes) {
      const [x, y, z] = p1.get(n.id);
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      expect(p2.get(n.id)).toEqual(p1.get(n.id));
    }
  });

  test('layoutShells covers every node, no NaN, no overlap-at-zero for multi-member shells', () => {
    const p = layoutShells(nodes, ['store', 'customer', 'order']);
    expect(p.size).toBe(nodes.length);
    const seen = new Set();
    for (const n of nodes) {
      const [x, y, z] = p.get(n.id);
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
      expect(seen.has(key)).toBe(false); // no two nodes stacked exactly
      seen.add(key);
      expect(x === 0 && y === 0 && z === 0).toBe(false);
    }
  });

  test('layoutTimeline covers every node, nulls parked past axis end, no NaN', () => {
    const p = layoutTimeline(nodes, (n) => n.stats.relations, { axisLength: 1000 });
    expect(p.size).toBe(nodes.length);
    for (const n of nodes) {
      const [x, y, z] = p.get(n.id);
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      if (n.stats.relations === null) expect(x).toBeGreaterThan(500);
    }
  });

  test('layoutOrbit covers centers + all assigned satellites, no NaN', () => {
    const centers = ['n0', 'n3', 'n6'];
    const assign = new Map();
    nodes.forEach((n, i) => {
      if (!centers.includes(n.id)) assign.set(n.id, centers[i % centers.length]);
    });
    const p = layoutOrbit(centers, assign, { orbitRadius: 100, ring: 30 });
    for (const id of centers) expect(p.has(id)).toBe(true);
    for (const id of assign.keys()) expect(p.has(id)).toBe(true);
    for (const [, pos] of p) {
      expect(pos.every((v) => Number.isFinite(v))).toBe(true);
    }
  });
});

describe('createSim', () => {
  test('200 steps on 500-node synthetic graph: energy trends down, no NaN, step timing logged', () => {
    const { nodes, edges } = syntheticGraph(500, 42);
    const sim = createSim(nodes, edges, { mass: 'degree', seed: 5 });

    // Random init -> KE rises from 0 to a peak (system flying apart/settling),
    // then decays under damping as it relaxes. Track the full 200-step trace so
    // the decrease can be verified regardless of where the peak lands.
    const stepTimes = [];
    const trace = [];
    for (let i = 0; i < 200; i += 1) {
      const t0 = performance.now();
      sim.step(1 / 60);
      stepTimes.push(performance.now() - t0);
      trace.push(sim.energy());
    }

    for (let i = 0; i < sim.positions.length; i += 1) expect(Number.isFinite(sim.positions[i])).toBe(true);
    for (const e of trace) expect(Number.isFinite(e)).toBe(true);

    const peakEnergy = Math.max(...trace);
    const peakIdx = trace.indexOf(peakEnergy);
    const finalEnergy = trace[trace.length - 1];
    const tailStart = trace[trace.length - 50];
    // final state has decayed off the peak, and the tail (last 50 steps) is trending down
    expect(finalEnergy).toBeLessThan(peakEnergy);
    expect(finalEnergy).toBeLessThan(tailStart);

    stepTimes.sort((a, b) => a - b);
    const median = stepTimes[Math.floor(stepTimes.length / 2)];
    const max = stepTimes[stepTimes.length - 1];
    console.log(
      `[sim/500-node] peak energy=${peakEnergy.toFixed(4)} (step ${peakIdx}) final energy=${finalEnergy.toFixed(4)} ` +
        `median step=${median.toFixed(3)}ms max step=${max.toFixed(3)}ms`
    );

    sim.setParams({ mass: 'pagerank', damping: 0.8 });
    sim.step(1 / 60);
    for (let i = 0; i < sim.positions.length; i += 1) expect(Number.isFinite(sim.positions[i])).toBe(true);
  });
});

describe('real sidecar (paloptic atlas-graph.json)', () => {
  test('load + pagerank + louvain + 60 sim steps, timings logged', () => {
    const { nodes, edges } = loadSidecar();
    expect(nodes.length).toBeGreaterThan(0);
    expect(edges.length).toBeGreaterThan(0);

    const t0 = performance.now();
    const adj = buildAdjacency(nodes, edges);
    const tAdj = performance.now();

    const pr = pagerank(adj);
    const tPr = performance.now();
    let prSum = 0;
    for (const v of pr.values()) prSum += v;
    expect(Math.abs(prSum - 1)).toBeLessThan(1e-3);
    for (const v of pr.values()) expect(Number.isFinite(v)).toBe(true);

    const lv = louvain(adj, { seed: 1 });
    const tLv = performance.now();
    expect(lv.count).toBeGreaterThan(0);
    expect(Number.isFinite(lv.modularity)).toBe(true);

    const sim = createSim(nodes, edges, { mass: 'degree' });
    const tSimInit = performance.now();
    let maxStep = 0;
    for (let i = 0; i < 60; i += 1) {
      const s0 = performance.now();
      sim.step(1 / 60);
      maxStep = Math.max(maxStep, performance.now() - s0);
    }
    const tSim60 = performance.now();
    for (let i = 0; i < sim.positions.length; i += 1) expect(Number.isFinite(sim.positions[i])).toBe(true);

    console.log(
      `[real sidecar] nodes=${nodes.length} edges=${edges.length} ` +
        `buildAdjacency=${(tAdj - t0).toFixed(1)}ms pagerank=${(tPr - tAdj).toFixed(1)}ms ` +
        `louvain=${(tLv - tPr).toFixed(1)}ms (communities=${lv.count} modularity=${lv.modularity.toFixed(4)}) ` +
        `simInit=${(tSimInit - tLv).toFixed(1)}ms sim60steps=${(tSim60 - tSimInit).toFixed(1)}ms ` +
        `avgStep=${((tSim60 - tSimInit) / 60).toFixed(2)}ms maxStep=${maxStep.toFixed(2)}ms`
    );
  });
});
