// Parse per-frame RMS metadata dumps (drums/bass/lead-vocals) into structure.json sections.
// Usage: bun make-structure.mjs
import { readFileSync, writeFileSync } from "fs";

function parseRms(path) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const points = []; // {t, db}
  let curTime = null;
  for (const line of lines) {
    const tm = line.match(/pts_time:([\d.]+)/);
    if (tm) {
      curTime = parseFloat(tm[1]);
      continue;
    }
    const rm = line.match(/RMS_level=(-?[\d.]+|-inf)/);
    if (rm && curTime !== null) {
      const val = rm[1] === "-inf" ? -120 : parseFloat(rm[1]);
      points.push({ t: curTime, db: val });
      curTime = null;
    }
  }
  return points;
}

const drums = parseRms("drums.m4a-rms.txt");
const bass = parseRms("bass.m4a-rms.txt");
const vocals = parseRms("lead-vocals.m4a-rms.txt");

const durationSec = 289.1;
const BUCKET = 4.0; // seconds per bucket for energy binning
const numBuckets = Math.ceil(durationSec / BUCKET);

function binSeries(points) {
  const bins = new Array(numBuckets).fill(null).map(() => []);
  for (const p of points) {
    const idx = Math.min(numBuckets - 1, Math.floor(p.t / BUCKET));
    bins[idx].push(p.db);
  }
  // average per bucket (skip -120/-inf outliers reasonably, just average all)
  return bins.map((arr) => {
    if (arr.length === 0) return -120;
    const sum = arr.reduce((a, b) => a + b, 0);
    return sum / arr.length;
  });
}

function smooth(arr, win) {
  const half = Math.floor(win / 2);
  return arr.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(arr.length - 1, i + half);
    let sum = 0, n = 0;
    for (let j = lo; j <= hi; j++) { sum += arr[j]; n++; }
    return sum / n;
  });
}

const drumsBinRaw = binSeries(drums);
const bassBinRaw = binSeries(bass);
const vocalsBinRaw = binSeries(vocals);
const drumsBin = smooth(drumsBinRaw, 3);
const bassBin = smooth(bassBinRaw, 3);
const vocalsBin = smooth(vocalsBinRaw, 3);

// Combined energy = simple average of the three stem dB levels (converted to linear, summed, back to relative scale)
// Use a simpler perceptual proxy: combinedDb = max of the three (loudest stem drives energy perception)
const combined = [];
for (let i = 0; i < numBuckets; i++) {
  const d = drumsBin[i];
  const b = bassBin[i];
  const v = vocalsBin[i];
  const maxDb = Math.max(d, b, v);
  combined.push({ t: i * BUCKET, drums: d, bass: b, vocals: v, energy: maxDb });
}

// Determine energy tiers via quantiles of the combined energy (excluding silence -120)
const sortedEnergies = combined.map((c) => c.energy).filter((e) => e > -110).sort((a, b) => a - b);
const q = (p) => sortedEnergies[Math.min(sortedEnergies.length - 1, Math.floor(p * sortedEnergies.length))];
const lowThresh = q(0.33);
const highThresh = q(0.75);

// Hysteresis state machine to avoid tier flapping: need to cross threshold +/- margin to switch
const MARGIN = 2.0;
let currentTier = "low";
function tierOf(e) {
  if (e <= -110) { currentTier = "silence"; return currentTier; }
  if (currentTier === "silence") currentTier = e < lowThresh ? "low" : e < highThresh ? "mid" : "high";
  if (currentTier === "low" && e > lowThresh + MARGIN) currentTier = e < highThresh ? "mid" : "high";
  else if (currentTier === "mid" && e < lowThresh - MARGIN) currentTier = "low";
  else if (currentTier === "mid" && e > highThresh + MARGIN) currentTier = "high";
  else if (currentTier === "high" && e < highThresh - MARGIN) currentTier = e < lowThresh ? "low" : "mid";
  return currentTier;
}

// Vocal silence detection: vocals db <= -40 considered silent (smoothed series; stem bleed raises floor above true digital silence)
const vocalSilent = (v) => v <= -40;

// Build raw per-bucket tier+vocalPresence, then merge consecutive buckets with same characterization into sections
const rawTags = combined.map((c) => ({
  t: c.t,
  tier: tierOf(c.energy),
  vocal: !vocalSilent(c.vocals),
}));

// Merge into runs
const runs = [];
for (const tag of rawTags) {
  const last = runs[runs.length - 1];
  if (last && last.tier === tag.tier && last.vocal === tag.vocal) {
    last.end = tag.t + BUCKET;
  } else {
    runs.push({ start: tag.t, end: tag.t + BUCKET, tier: tag.tier, vocal: tag.vocal });
  }
}

// Merge tiny runs (<12s) into neighbors to avoid noise, by absorbing into the longer adjacent run
const MIN_RUN = 12.0;
let merged = [...runs];
let changed = true;
while (changed) {
  changed = false;
  for (let i = 0; i < merged.length; i++) {
    const len = merged[i].end - merged[i].start;
    if (len < MIN_RUN && merged.length > 1) {
      // merge with neighbor that has smaller index difference in tier ranking, prefer previous
      if (i > 0) {
        merged[i - 1].end = merged[i].end;
        merged.splice(i, 1);
      } else {
        merged[i + 1].start = merged[i].start;
        merged.splice(i, 1);
      }
      changed = true;
      break;
    }
  }
}

// Label sections: intro (first run, low/silence tier, before first strong vocal run),
// outro (last run, low/silence tier after last strong vocal run),
// bridge (mid tier or instrumental gap with no vocal, in the middle),
// drop (high tier with vocal absent -> instrumental climax) or (high tier immediately following a build),
// chorus (high tier + vocal present),
// verse (low/mid tier + vocal present)
function labelRun(run, idx, arr) {
  const isFirst = idx === 0;
  const isLast = idx === arr.length - 1;
  if (run.tier === "silence") {
    if (isFirst) return "intro";
    if (isLast) return "outro";
    return "bridge";
  }
  if (!run.vocal) {
    if (isFirst) return "intro";
    if (isLast) return "outro";
    if (run.tier === "high") return "drop";
    return "bridge";
  }
  // has vocal
  if (run.tier === "high") return "chorus";
  return "verse";
}

const sections = merged.map((run, idx, arr) => ({
  start: Number(run.start.toFixed(2)),
  end: Number(Math.min(run.end, durationSec).toFixed(2)),
  label: labelRun(run, idx, arr),
  energy: run.tier,
}));

const output = { song: "The Beginning", durationSec, sections };
writeFileSync("structure.json", JSON.stringify(output, null, 2));

console.log("Sections:");
console.log("start\tend\tlabel\tenergy");
for (const s of sections) {
  console.log(`${s.start}\t${s.end}\t${s.label}\t${s.energy}`);
}
