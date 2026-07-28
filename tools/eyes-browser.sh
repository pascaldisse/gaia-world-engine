#!/usr/bin/env bash
# BEAUTY LANE · EYES — the ONLY way this lane opens a browser.
#
# TWO LAWS, both absolute (Pascal, 07-28):
#   NO DESKTOP WINDOW EVER   → --headless=new (no window is ever mapped)
#   NO UNMUTED BROWSER EVER  → --mute-audio at the process level, ?mute=1 in
#                              the engine, audio:false on every play() the
#                              plate driver makes. Three independent places,
#                              because any one of them can be forgotten.
# The measured cost of headless (this machine, 07-28): chrome-headless-shell
# has no Metal WebGPU adapter → SwiftShader. --headless=new on a full Chrome/
# Brave build keeps the GPU process, so the adapter is real; that is why this
# script prefers a full browser binary over the shell.
set -euo pipefail
cd "$(dirname "$0")/.."

# a full browser binary (has a GPU process even headless), first that exists
for c in \
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Users/pascaldisse/Library/Caches/ms-playwright/chromium-1228/chrome-mac/Chromium.app/Contents/MacOS/Chromium" ; do
  [ -x "$c" ] && CHROME=${CHROME:-$c} && break
done
CHROME=${CHROME:?no browser binary found}

CDP=${CDP_PORT:-9251}
CLIENT=${GAIA_CLIENT_PORT:-5187}
PROFILE=${PROFILE:-/tmp/eyes/browser}
LOG=${LOG:-/tmp/eyes/logs/browser.log}
SIZE=${SIZE:-1600,900}
URL=${1:-"http://localhost:${CLIENT}/?mute=1&intro=off"}

pkill -f "remote-debugging-port=${CDP}" 2>/dev/null || true
sleep 0.8
mkdir -p "$PROFILE" "$(dirname "$LOG")"

nohup "$CHROME" \
  --headless=new \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$CDP" \
  --mute-audio \
  --window-size="$SIZE" \
  --hide-scrollbars \
  --enable-unsafe-webgpu \
  --enable-features=Vulkan,Metal \
  --use-angle=metal \
  --autoplay-policy=no-user-gesture-required \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  --disable-logging --log-level=3 \
  "$URL" > "$LOG" 2>&1 &

for _ in $(seq 1 40); do
  sleep 0.5
  if curl -s -m 2 "http://localhost:${CDP}/json/list" | grep -q '"type": "page"'; then
    echo "browser: headless CDP ${CDP} → ${URL} (muted, no window)"
    exit 0
  fi
done
echo "cdp never came up — see $LOG" >&2
exit 1
