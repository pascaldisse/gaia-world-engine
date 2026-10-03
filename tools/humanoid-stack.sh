#!/usr/bin/env bash
# humanoid-kit live verify stack — own ports, temp world OUTSIDE the hub (proof/humanoid-kit/world, gitignored).
#   tools/humanoid-stack.sh world|up|down|status [url-suffix]   (world: HK_UNITS=<dir> once, builds the temp world)
# world server :18720 · vite :15473 · CDP :9733 (headless=new Brave, muted, no window)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
# own env names: the gaia daemon env squats GAIA_PORT=8787, never inherit it
export GAIA_PORT=${HK_PORT:-18720} GAIA_CLIENT_PORT=${HK_CLIENT_PORT:-15473}
export GAIA_WORLD=$ROOT/proof/humanoid-kit/world GAIA_SAVE=humanoid-kit
CDP=${CDP_PORT:-9733}
LOGS=$ROOT/proof/humanoid-kit/logs; mkdir -p "$LOGS"
PROFILE=$ROOT/proof/humanoid-kit/logs/brave-profile
BRAVE="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
URL="http://localhost:${GAIA_CLIENT_PORT}/?mute=1${2:-}"
case "${1:-status}" in
world) # (re)build the temp world: flat ground + spawn; HK_UNITS=<dir of unit glTF folders> is SYMLINKED as assets/units (read-only, never copied)
[ -d "${HK_UNITS:-}" ] || { echo "set HK_UNITS=<dir with unit glTF folders>" >&2; exit 1; }
mkdir -p "$GAIA_WORLD/scenes" "$GAIA_WORLD/assets"
echo '{ "voidY": -10, "scenes": { "main": { "always": true } } }' >"$GAIA_WORLD/world.json"
cat >"$GAIA_WORLD/scenes/main.json" <<'JSON'
{
 "world_spawn": { "spawn": { "position": [0, 15, 20], "yaw": 0, "gameMode": true } },
 "environment": { "environment": { "background": "#a5bfce", "ambient": { "color": "#ffffff", "intensity": 1.5 }, "sun": { "color": "#fff3cf", "intensity": 2.5 }, "fog": { "color": "#a5bfce", "density": 0.003 } } },
 "land": { "transform": { "position": [0, -0.15, 0] }, "mesh": { "parts": [{ "shape": "box", "size": [60, 0.3, 60], "color": "#617746", "castShadow": false }] } }
}
JSON
ln -sfn "$HK_UNITS" "$GAIA_WORLD/assets/units"; ls -la "$GAIA_WORLD/assets" ;;
  up)
    lsof -iTCP:$GAIA_PORT -sTCP:LISTEN >/dev/null 2>&1 || (nohup node server/index.js >"$LOGS/server.log" 2>&1 &)
    lsof -iTCP:$GAIA_CLIENT_PORT -sTCP:LISTEN >/dev/null 2>&1 || (nohup node_modules/.bin/vite >"$LOGS/vite.log" 2>&1 &)
    for _ in $(seq 1 40); do curl -s -m 1 localhost:$GAIA_PORT/schema >/dev/null && break; sleep 0.5; done
    pkill -f "remote-debugging-port=$CDP" 2>/dev/null || true; sleep 0.5
    nohup "$BRAVE" --headless=new --user-data-dir="$PROFILE" --remote-debugging-port=$CDP --mute-audio \
      --window-size=${HK_SIZE:-1600,900} --hide-scrollbars --enable-unsafe-webgpu --enable-features=Vulkan,Metal --use-angle=metal \
      --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding \
      --disable-backgrounding-occluded-windows --disable-logging --log-level=3 "$URL" >"$LOGS/brave.log" 2>&1 &
    sleep 4
    # headless=new opens the URL twice — keep ONE tab (every tab is a full player session)
    for id in $(curl -s localhost:$CDP/json/list | python3 -c 'import json,sys; ids=[t["id"] for t in json.load(sys.stdin) if t["type"]=="page"]; print("\n".join(ids[1:]))'); do curl -s localhost:$CDP/json/close/$id >/dev/null; done
    curl -s localhost:$CDP/json/list | grep -c '"type": "page"' ;;
  down)
    pkill -f "remote-debugging-port=$CDP" || true
    lsof -tiTCP:$GAIA_CLIENT_PORT -sTCP:LISTEN | xargs -r kill || true
    lsof -tiTCP:$GAIA_PORT -sTCP:LISTEN | xargs -r kill || true ;;
  status) lsof -iTCP:$GAIA_PORT -iTCP:$GAIA_CLIENT_PORT -iTCP:$CDP -sTCP:LISTEN -n -P ;;
esac
