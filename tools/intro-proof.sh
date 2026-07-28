#!/usr/bin/env bash
# Live proof pass for the intro: click the title screen, then photograph the
# film AT the lyric cues it is cut to (lyrics.json word times), reading the
# clock back from the director each time so a slow shot cannot drift the next.
#   usage: tools/intro-proof.sh <cue:name> [cue:name ...]
# Only cdp.mjs / cdp-input.mjs are used, and no server is ever touched.
set -u
cd "$(dirname "$0")/.."
export GAIA_CLIENT_PORT=${GAIA_CLIENT_PORT:-5174}
OUT=proof/intro
mkdir -p "$OUT"

t_now() { node tools/cdp.mjs eval 'String(gaia.director.status().t)' 2>/dev/null | tr -d '\r'; }

for spec in "$@"; do
  cue=${spec%%:*}
  name=${spec##*:}
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    t=$(t_now)
    [ -z "$t" ] && sleep 1 && continue
    wait=$(node -e "const d=($cue)-($t); console.log(d>0?Math.min(d,20).toFixed(2):0)")
    ok=$(node -e "console.log(($t)>=($cue)?1:0)")
    if [ "$ok" = "1" ]; then break; fi
    sleep "$wait"
  done
  node tools/cdp.mjs shot "$OUT/$name.png" >/dev/null
  echo "$name @ t=$(t_now) (cue $cue)"
done
