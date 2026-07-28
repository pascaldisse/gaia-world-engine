#!/usr/bin/env bash
# FILM LANE C · the ONLY way this lane opens a browser.
#
# LAW (Pascal, 07-28, live order): no unmuted browser may exist. The mute is
# enforced in THREE independent places, because any one of them can be
# forgotten and the player hears it on his own speakers:
#   --mute-audio        the whole browser process is silent at the OS level
#   ?mute=1             the engine's own mute (atlas-sound + director graph)
#   audio:false         every play() this lane makes runs on the virtual clock
# Audio-sync verification, if it is ever needed, is done with
# `gaia.director.director.audio.el.muted = true` — currentTime still advances.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME=${CHROME:-/Users/pascaldisse/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell}
PORT=${GAIA_CLIENT_PORT:-5179}
CDP=${CDP_PORT:-9227}
PROFILE=${PROFILE:-/tmp/filmC/profile}
URL=${URL:-"http://localhost:${PORT}/?mute=1"}
LOG=${LOG:-/tmp/filmC/chrome.log}

pkill -f "user-data-dir=${PROFILE}" 2>/dev/null || true
sleep 1
mkdir -p "$PROFILE" "$(dirname "$LOG")"

nohup "$CHROME" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$CDP" \
  --mute-audio \
  --window-size=1600,900 \
  --enable-unsafe-webgpu \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --disable-logging --log-level=3 \
  "$URL" > "$LOG" 2>&1 &

echo "browser: CDP $CDP → $URL (profile $PROFILE, --mute-audio)"
for _ in $(seq 1 40); do
  sleep 1
  if curl -s -m 2 "http://localhost:${CDP}/json/list" | grep -q "\"type\": \"page\""; then
    echo "cdp up after ${_}s"; exit 0
  fi
done
echo "cdp never came up — see $LOG" >&2
exit 1
