#!/usr/bin/env bash
# Launch the film-D proof browser. ONE way to do it, so no launch can forget
# the law: --mute-audio ALWAYS (Pascal, 2026-07-28 — a headless test browser
# sang out loud on his machine; no unmuted browser may exist). The film's own
# audio graph is still real inside the page, so el.currentTime keeps advancing
# and A/V-lock proofs stay honest; the speakers just never hear it.
#   usage: tools/film-d-browser.sh [url]
set -eu
CHROME=/Users/pascaldisse/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell
PORT=${CDP_PORT:-9228}
CLIENT=${GAIA_CLIENT_PORT:-5180}
URL=${1:-"http://localhost:${CLIENT}/?intro=off"}
PROFILE=${PROFILE:-/tmp/filmD-chrome}
LOG=${LOG:-/tmp/filmD-logs/chrome.log}
mkdir -p "$(dirname "$LOG")"

pkill -f "remote-debugging-port=${PORT}" 2>/dev/null || true
sleep 1
nohup "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --mute-audio \
  --window-size=1600,900 \
  --autoplay-policy=no-user-gesture-required \
  --use-gl=angle --enable-unsafe-swiftshader \
  "$URL" > "$LOG" 2>&1 < /dev/null &
disown || true
sleep 6
curl -s "http://localhost:${PORT}/json/version" | head -c 120
echo
echo "[film-d] muted browser on CDP ${PORT} → ${URL}"
