// Parse whisper-cli DTW full JSON (-ojf --dtw) into lyrics.json timeline.
// v2: uses per-token DTW timestamps (t_dtw, centiseconds) instead of raw
// offsets (which collapse/desync on long lines). Splits into short
// subtitle-friendly lines (target 3-8 words) at gaps>0.8s, sentence-end
// punctuation, and (for overlong sentences) comma boundaries.
// Usage: bun make-lyrics.mjs
import { readFileSync, writeFileSync } from "fs";

const whisper = JSON.parse(readFileSync("lv-dtw.json", "utf8"));
const fullMixDurationSec = 289.1; // from full-mix.m4a verification

const GAP_THRESHOLD = 0.8; // seconds - gap that breaks a line
const MIN_WORDS = 3;
const MAX_WORDS = 8;
const NON_SPEECH_RE = /^\s*\[[^\]]*\]\s*$/; // [Music], [sigh], [BLANK_AUDIO], etc.
const SENTENCE_END_RE = /[.!?]$/;

// Flatten all real (non-special) tokens across segments, in order.
const rawTokens = [];
for (const seg of whisper.transcription) {
  for (const tok of seg.tokens) {
    const text = tok.text;
    if (text.trim().startsWith("[_")) continue; // [_BEG_], [_TT_xxx]
    rawTokens.push(tok);
  }
}

// t0 for a token = its own DTW timestamp; t1 = next real token's DTW
// timestamp (or its own offset "to" if it's the last token / dtw missing).
function dtwSec(tok) {
  return tok.t_dtw >= 0 ? tok.t_dtw / 100 : null;
}

// DTW alignment runs per whisper *segment*; trailing tokens near a segment
// boundary can pile up on the exact same DTW timestamp when the alignment
// window runs out (observed: runs of 2-6 tokens sharing one t0). Detect
// these collapsed runs and spread them evenly between the previous distinct
// timestamp and the collapse boundary itself.
const t0Raw = rawTokens.map((tok) => dtwSec(tok) ?? tok.offsets.from / 1000);
const t0Fixed = t0Raw.slice();
{
  let i = 0;
  while (i < t0Fixed.length) {
    let j = i + 1;
    while (j < t0Fixed.length && Math.abs(t0Fixed[j] - t0Fixed[i]) < 0.005) j++;
    const runLen = j - i;
    if (runLen > 1) {
      const boundary = t0Fixed[i];
      const prevT = i > 0 ? t0Fixed[i - 1] : Math.max(0, boundary - runLen * 0.3);
      for (let k = 0; k < runLen; k++) {
        t0Fixed[i + k] = prevT + ((boundary - prevT) * (k + 1)) / (runLen + 1);
      }
    }
    i = j;
  }
}

const tokTimes = rawTokens.map((tok, i) => {
  const t0 = t0Fixed[i];
  const selfRawEnd = tok.offsets.to / 1000;
  let t1;
  const next = rawTokens[i + 1];
  if (next) {
    t1 = t0Fixed[i + 1];
    // Guard against DTW placing the *next* token far away across a real
    // silence/instrumental gap (its own raw offset window can still be a
    // collapsed multi-word span): don't let that inflate *this* token's
    // end time past its own raw offset end + one gap threshold.
    if (t1 - selfRawEnd > GAP_THRESHOLD) t1 = selfRawEnd;
  } else {
    t1 = selfRawEnd;
  }
  if (t1 < t0) t1 = t0;
  // Whisper BPE marks a new word with a leading space in the raw token
  // text; sub-word continuations (and punctuation) have none and must be
  // glued onto the previous token with no inserted space.
  const startsNewWord = tok.text.startsWith(" ");
  return { text: tok.text.trim(), t0, t1, startsNewWord };
});

// Merge same-word continuation tokens (no leading space) into the previous
// real word: extends its text and end time.
const words = [];
for (const tok of tokTimes) {
  if (!tok.text) continue;
  if (!tok.startsNewWord && words.length > 0) {
    const prev = words[words.length - 1];
    prev.w = prev.w + tok.text;
    prev.t1 = tok.t1;
    continue;
  }
  words.push({ w: tok.text, t0: tok.t0, t1: tok.t1 });
}

// --- Segment into raw phrase chunks: break at gap>0.8s or sentence-end. ---
const rawSegments = [];
let current = [];
for (let i = 0; i < words.length; i++) {
  const w = words[i];
  if (current.length > 0) {
    const prev = current[current.length - 1];
    const gap = w.t0 - prev.t1;
    if (gap > GAP_THRESHOLD) {
      rawSegments.push(current);
      current = [];
    }
  }
  current.push(w);
  if (SENTENCE_END_RE.test(w.w)) {
    rawSegments.push(current);
    current = [];
  }
}
if (current.length > 0) rawSegments.push(current);

// --- Split overlong segments (>MAX_WORDS) at comma boundaries, or evenly
// as a fallback, keeping chunks within [MIN_WORDS, MAX_WORDS] where possible.
function splitSegment(seg) {
  if (seg.length <= MAX_WORDS) return [seg];

  // Candidate split points: index right after a comma-ending word.
  const commaIdx = [];
  for (let i = 0; i < seg.length - 1; i++) {
    if (/,$/.test(seg[i].w)) commaIdx.push(i + 1);
  }

  const chunks = [];
  let start = 0;
  while (start < seg.length) {
    const remaining = seg.length - start;
    if (remaining <= MAX_WORDS) {
      chunks.push(seg.slice(start));
      break;
    }
    // Prefer a comma split point within [MIN_WORDS, MAX_WORDS] of start.
    let cut = -1;
    for (const idx of commaIdx) {
      const len = idx - start;
      if (len >= MIN_WORDS && len <= MAX_WORDS) cut = idx;
    }
    if (cut === -1) {
      // Fallback: cut at MAX_WORDS, but avoid leaving < MIN_WORDS in the tail.
      const remainAfter = seg.length - (start + MAX_WORDS);
      cut = remainAfter > 0 && remainAfter < MIN_WORDS
        ? start + (seg.length - start - MIN_WORDS)
        : start + MAX_WORDS;
    }
    chunks.push(seg.slice(start, cut));
    start = cut;
  }
  return chunks;
}

const lineWordGroups = [];
for (const seg of rawSegments) {
  for (const chunk of splitSegment(seg)) lineWordGroups.push(chunk);
}

// Build line objects, join word text into a cleaned string, drop non-speech-only lines
const lines = [];
for (const lineWords of lineWordGroups) {
  const text = lineWords
    .map((w) => w.w)
    .join(" ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1");
  if (!text || NON_SPEECH_RE.test(text)) continue;
  const cleanedText = text.replace(/\[[^\]]*\]/g, "").trim();
  if (!cleanedText) continue;
  const start = lineWords[0].t0;
  const end = lineWords[lineWords.length - 1].t1;
  lines.push({
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    text: cleanedText,
    words: lineWords.map((w) => ({
      w: w.w,
      t0: Number(w.t0.toFixed(3)),
      t1: Number(w.t1.toFixed(3)),
    })),
  });
}

// Ensure monotonic times (sanity clamp)
for (let i = 1; i < lines.length; i++) {
  if (lines[i].start < lines[i - 1].end) {
    lines[i].start = lines[i - 1].end;
  }
}

const output = {
  song: "The Beginning",
  durationSec: fullMixDurationSec,
  lines,
};

writeFileSync("lyrics.json", JSON.stringify(output, null, 2));
console.log(`Wrote lyrics.json with ${lines.length} lines`);
const wordCounts = lines.map((l) => l.words.length);
console.log(
  `word counts: min=${Math.min(...wordCounts)} max=${Math.max(...wordCounts)} avg=${(
    wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length
  ).toFixed(1)}`
);
console.log(JSON.stringify(lines.slice(0, 12), null, 2));
