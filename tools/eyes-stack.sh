#!/usr/bin/env bash
# BEAUTY LANE · EYES — the lane's own stack. Nothing here may touch another
# lane's ports (8420/8421 = the live world, 5173/5174 = the live client) or
# another lane's vite cache: the shared node_modules/.vite re-optimizes under
# two vite processes and breaks whichever server was already running, so this
# lane gets its OWN cacheDir in /tmp (see /tmp/eyes/vite.config.mjs).
#
# §IRON — every port is an env override with the lane's default.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

export GAIA_PORT=${GAIA_PORT:-8431}          # world server (never 8420/8421)
export GAIA_CLIENT_PORT=${GAIA_CLIENT_PORT:-5187}  # vite (never 5173/5174)
export GAIA_WORLD=${GAIA_WORLD:-/tmp/eyes/world}   # ops persist HERE, not the repo
LANE=${LANE:-/tmp/eyes}
LOG=$LANE/logs

mkdir -p "$GAIA_WORLD" "$LOG"

# the lane's vite config: the repo's, plus an absolute root and a private cache
cat > "$LANE/vite.config.mjs" <<EOF
import base from '${ROOT}/vite.config.js';
export default { ...base, root: '${ROOT}/client', cacheDir: '${LANE}/vite-cache' };
EOF

pkill -f "GAIA_EYES_LANE=1" 2>/dev/null || true
sleep 0.6

GAIA_EYES_LANE=1 nohup node server/index.js > "$LOG/server.log" 2>&1 &
GAIA_EYES_LANE=1 nohup npx vite --config "$LANE/vite.config.mjs" --port "$GAIA_CLIENT_PORT" --strictPort > "$LOG/vite.log" 2>&1 &

for _ in $(seq 1 40); do
  sleep 0.5
  if curl -s -m 2 "http://localhost:${GAIA_CLIENT_PORT}/" > /dev/null 2>&1; then
    echo "eyes stack up: world ${GAIA_PORT} · client ${GAIA_CLIENT_PORT} · world dir ${GAIA_WORLD}"
    exit 0
  fi
done
echo "stack never came up — see $LOG/vite.log $LOG/server.log" >&2
exit 1
