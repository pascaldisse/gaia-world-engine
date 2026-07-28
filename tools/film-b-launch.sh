#!/usr/bin/env bash
# FILM LANE B · the isolated headless browser for this lane, and the ONLY way
# it is ever launched.
#
# --mute-audio IS NOT OPTIONAL (Pascal, live order 07-28): a verification
# browser must never make a sound on the machine a human is sitting at. The
# film's own transport is driven with audio:false; when audio sync itself has
# to be verified, mute the media element (el.muted = true — currentTime still
# advances) and never the speakers' luck.
#
# Iso stack law for this lane: 8425 / 5178 / CDP 9226. Never 8420/8421/5173/5174.
set -euo pipefail

CHROME=${CHROME:-/Users/pascaldisse/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell}
PORT=${GAIA_CLIENT_PORT:-5178}
CDP=${CDP_PORT:-9226}
PROFILE=${PROFILE:-/tmp/filmB-profile}

nohup "$CHROME" \
  --mute-audio \
  --remote-debugging-port="$CDP" \
  --user-data-dir="$PROFILE" \
  --window-size=1920,1080 \
  --hide-scrollbars \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --use-gl=angle --enable-unsafe-swiftshader \
  "http://localhost:$PORT/?intro=off&mute=1" > /tmp/filmB-chrome.log 2>&1 &

for _ in $(seq 1 40); do
  sleep 0.5
  if curl -sf "http://localhost:$CDP/json" | grep -q ":$PORT"; then echo "browser up (muted) on CDP $CDP → :$PORT"; exit 0; fi
done
echo "browser did not come up" >&2
exit 1
