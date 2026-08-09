#!/usr/bin/env bash
# AGNI LANE · headful Brave for the 60fps gate (GATE-FPS-1).
# Constitution: headless is BANNED for photometry/perf — SwiftShader lies and
# headless=new still differs in compositor scheduling. A real window, on Metal.
# Every port is a parameter; nothing hard-coded. Ports 5174/8422/8787 are barred.
set -euo pipefail

BRAVE=${BRAVE:-"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"}
[ -x "$BRAVE" ] || { echo "no Brave at $BRAVE" >&2; exit 1; }
PORT=${GAIA_CLIENT_PORT:-5231}
CDP=${CDP_PORT:-9351}
DIR=${AGNI_DIR:-"$(cd "$(dirname "$0")/.." && pwd)/scratch/agni"}
PROFILE=${PROFILE:-$DIR/prof}
SIZE=${SIZE:-1280,720}
URL=${URL:-"http://localhost:$PORT/?fluid=1&mute=1"}

case "$PORT:$CDP" in *5174*|*8422*|*8787*) echo "banned port" >&2; exit 1;; esac

pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true
sleep 1
mkdir -p "$PROFILE"

nohup "$BRAVE" \
  --mute-audio \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$CDP" \
  --window-size="$SIZE" \
  --new-window \
  --no-first-run --no-default-browser-check \
  --enable-unsafe-webgpu \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --disable-logging --log-level=3 \
  "$URL" > "$DIR/brave.log" 2>&1 &

for _ in $(seq 1 80); do
  sleep 0.5
  if curl -sf "http://localhost:$CDP/json" | grep -q ":$PORT"; then
    echo "brave up HEADFUL (no --headless flag) CDP $CDP → $URL"
    ps -o command= -p "$(pgrep -f "remote-debugging-port=$CDP" | head -1)" | tr ' ' '\n' | grep -i headless && { echo "HEADLESS DETECTED — abort" >&2; exit 1; }
    echo "headless-flag scan: none"
    exit 0
  fi
done
echo "brave did not come up — see $DIR/brave.log" >&2
exit 1
