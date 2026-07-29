# DEFECT B — subtitle timing · VERDICT: CAPTURE ARTIFACT, not drift

Test (one take, no stitching): roll to 258 → subtitles on → `subs 261 293`
reads the film's OWN audio clock every frame and dumps
`{frame, t, audioT, cueIndex, subText, domSub, subOn, seg}` next to the cue
table the director built from `lyrics.json` word times.

* `subs-261-293.json` — 33 frames, **0 mismatches** against the cue table.
  Every displayed line sits inside its own [t0-0.05, t1] window; the only
  blank samples (f264, f268, f281) land inside the deliberate 90 ms cut
  between two cues (`applySubtitle`, atlas-director.js). Tolerance ±0.5 s.
* The folded clock does NOT drift, and a seek does NOT replay: `applySubtitle`
  picks the cue by `findIndex` on t (stateless), and `seek()`/`begin()` reset
  `cueIndex = -2` so the line is recomputed from t.

## What actually happened in contact-fix-225-293.jpg
The old `strip-fix` loop named frames by a **wall clock** (`t0 + n*1000`), not
by the film's clock. When the audio clock lagged the wall — seek settle,
shader compile — every later frame kept a name its picture did not own. The
line seen at "f279" is the 220.56–224.08 cue: a ~55 s wall-vs-film lag.

Independent corroboration (a different failure path, per the measurement law):
the old `strip-fix/f226.jpg` is a black pre-roll frame carrying the kernel HUD,
while a real t=226 frame (`strip-panelfix/f226.jpg`) is the seg7 cosmos.
Same lag, seen in the picture instead of the subtitle.

## Fix
`tools/film2-fold-driver.mjs` — `strip-fix` now waits on and names every frame
by `audio.el.currentTime` (the law the later `grab` command already obeyed).
No change was needed in the subtitle system; it was never wrong.
