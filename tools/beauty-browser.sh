#!/usr/bin/env bash
# BEAUTY LANE · the ONLY way this lane opens a browser.
#
# SEALED LAW (Pascal, 07-28): NO WINDOW ON THE DESKTOP, EVER. Therefore the
# FULL Chromium binary in `--headless=new` mode (a real browser, no window) —
# not `open`, not a visible profile. The full binary is used instead of
# chrome-headless-shell because the shell has no Metal adapter on this machine
# (SwiftShader → ~0.1 fps at 640x360, measured in film lane C): usable for
# static seeks, worthless for the 60 fps gate.
#
# --mute-audio is enforced here AND ?mute=1 in the URL AND audio:false at every
# play(): three independent places, because one forgotten mute means sound on
# the machine a human is sitting at.
set -euo pipefail

CHROME=${CHROME:-/Users/pascaldisse/Library/Caches/ms-playwright/chromium-1228/chrome-mac/Chromium.app/Contents/MacOS/Chromium}
PORT=${GAIA_CLIENT_PORT:-5191}
CDP=${CDP_PORT:-9241}
DIR=${BEAUTY_TMP:-/tmp/beauty}
PROFILE=${PROFILE:-$DIR/prof}
# 1600x900: the film's own framing ratio. Plates are judged at 100%, so a
# smaller window hides exactly the surface detail this pass exists to add.
SIZE=${SIZE:-1600,900}
URL=${URL:-"http://localhost:$PORT/?static=1&intro=off&mute=1"}

pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true
sleep 1
mkdir -p "$PROFILE"

# --headless=new keeps the full GPU stack (ANGLE/Metal) reachable, unlike the
# shell; --enable-unsafe-webgpu is required for WebGPU in headless here.
nohup "$CHROME" \
  --headless=new \
  --mute-audio \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$CDP" \
  --window-size="$SIZE" \
  --hide-scrollbars \
  --enable-unsafe-webgpu \
  --enable-features=Vulkan,WebGPUExperimentalFeatures \
  --use-angle=metal \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --disable-logging --log-level=3 \
  "$URL" > "$DIR/chrome.log" 2>&1 &

for _ in $(seq 1 60); do
  sleep 0.5
  if curl -sf "http://localhost:$CDP/json" | grep -q ":$PORT"; then
    echo "browser up (headless=new, muted) CDP $CDP → $URL"; exit 0
  fi
done
echo "browser did not come up — see $DIR/chrome.log" >&2
exit 1
