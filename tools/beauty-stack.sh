#!/usr/bin/env bash
# BEAUTY LANE · the iso stack (vite only — the beauty pass photographs the
# STATIC snapshot, so no world server and no ops POST are involved).
#
# Iso law: this lane owns 5191 / CDP 9241 and nothing else. Never 8420, 8421,
# 5173, 5174 (serving trees), never 5178/5179/8425/8426 (film lanes).
#
# Own cacheDir is not optional: the shared node_modules/.vite re-optimises
# when a second root uses it and that has broken other lanes' RUNNING servers
# mid-capture. /tmp/beauty/vite is private to this lane.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=${GAIA_CLIENT_PORT:-5191}
DIR=${BEAUTY_TMP:-/tmp/beauty}
mkdir -p "$DIR"

cat > "$DIR/vite.config.mjs" <<EOF
import base from '$ROOT/vite.config.js';
export default { ...base, root: '$ROOT/client', cacheDir: '$DIR/vite' };
EOF

pkill -f "vite.*--port $PORT" 2>/dev/null || true
sleep 0.5
cd "$ROOT"
GAIA_CLIENT_PORT="$PORT" nohup npx vite --config "$DIR/vite.config.mjs" --port "$PORT" --strictPort \
  > "$DIR/vite.log" 2>&1 &

for _ in $(seq 1 60); do
  sleep 0.5
  if curl -sf "http://localhost:$PORT/" >/dev/null 2>&1; then echo "vite up → http://localhost:$PORT/ (cacheDir $DIR/vite)"; exit 0; fi
done
echo "vite never came up — see $DIR/vite.log" >&2
exit 1
