#!/usr/bin/env bash
# FILM2 FOLD · the ONLY way this lane starts a client or a browser.
#
# IRON PORTS (this lane, never shared): client 5196 · CDP 9256.
# Never 8420 / 8421 / 5173 / 5174, never a segment lane's.
# WORLD: ?static=1 (client/assets/world-snapshot.json) — no world server, no
# socket to anyone else's state, no ops POSTed anywhere. GAIA_WORLD, if a
# server is ever wanted here, is /tmp/film2fold-world and nothing else.
# MUTED: --mute-audio at the OS level. The film's own audio element still
# runs (currentTime advances), which is the clock this fold must prove.
# NO WINDOW EVER: Brave, hidden (open -n -g -j), own profile under .scratch/.
# Why Brave and not chrome-headless-shell: the shell has no Metal adapter on
# this machine → SwiftShader → 0.1 fps, which cannot photograph a real-time
# strip. Brave hidden gets the Metal-3 adapter.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
SCRATCH="$ROOT/.scratch"
PORT=${GAIA_CLIENT_PORT:-5196}
CDP=${CDP_PORT:-9256}
BRAVE=${BRAVE:-/Applications/Brave Browser.app/Contents/MacOS/Brave Browser}
mkdir -p "$SCRATCH"

cat > "$SCRATCH/vite.config.mjs.new" <<EOF
import base from '${ROOT}/vite.config.js';
export default { ...base, root: '${ROOT}/client', cacheDir: '${SCRATCH}/vite' };
EOF
cmp -s "$SCRATCH/vite.config.mjs.new" "$SCRATCH/vite.config.mjs" \
  && rm -f "$SCRATCH/vite.config.mjs.new" \
  || mv "$SCRATCH/vite.config.mjs.new" "$SCRATCH/vite.config.mjs"

case "${1:-up}" in
  up)
    if ! curl -sf "http://localhost:$PORT/" >/dev/null 2>&1; then
      nohup npx vite --config "$SCRATCH/vite.config.mjs" --port "$PORT" --strictPort \
        > "$SCRATCH/vite.log" 2>&1 &
      disown
      for _ in $(seq 1 40); do sleep 0.5; curl -sf "http://localhost:$PORT/" >/dev/null 2>&1 && break; done
    fi
    curl -sf "http://localhost:$PORT/" >/dev/null || { echo "vite never came up — $SCRATCH/vite.log" >&2; exit 1; }
    echo "client: http://localhost:$PORT"

    if ! curl -sf "http://localhost:$CDP/json/list" >/dev/null 2>&1; then
      open -n -g -j -a "$BRAVE" --args \
        --user-data-dir="$SCRATCH/brave" \
        --remote-debugging-port="$CDP" \
        --mute-audio \
        --window-size=1280,720 \
        --autoplay-policy=no-user-gesture-required \
        --disable-backgrounding-occluded-windows \
        --disable-renderer-backgrounding \
        --disable-background-timer-throttling \
        "http://localhost:$PORT/?static=1"
      for _ in $(seq 1 60); do
        sleep 1
        curl -s -m 2 "http://localhost:$CDP/json/list" | grep -q '"type": "page"' && break
      done
    fi
    curl -s -m 2 "http://localhost:$CDP/json/list" | grep -q '"type": "page"' \
      || { echo "cdp never came up" >&2; exit 1; }
    echo "browser: CDP $CDP (Brave hidden, --mute-audio, profile $SCRATCH/brave)"
    ;;
  down)
    pkill -f "user-data-dir=$SCRATCH/brave" 2>/dev/null || true
    pkill -f "$SCRATCH/vite.config.mjs" 2>/dev/null || true
    echo "lane down"
    ;;
  *) echo "usage: film2-fold-stack.sh [up|down]"; exit 1;;
esac
