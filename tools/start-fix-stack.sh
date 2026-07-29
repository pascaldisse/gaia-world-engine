#!/usr/bin/env bash
# START-FIX LANE · the ONLY way this lane starts anything.
#
# IRON PORTS (this lane, never shared): world 8462 · client 5195 · quest 4695.
# Never 8420 / 8421 / 5173 / 5174, and never another lane's.
# WORLD: its own empty GAIA_WORLD under .scratch/, seeded ONCE from
#   ~/projects/paloptic/viz/data/{atlas,quest}-ops.json.
# QUEST: its own users/sessions/journals files under .scratch/ — a proof run
#   must never register a hunter into paloptic's real data dir.
# Scratch lives INSIDE the repo (.scratch/, git-excluded). /tmp is banned.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
SCRATCH="$ROOT/.scratch/start-fix"
WORLD="$SCRATCH/world"
QDATA="$SCRATCH/quest"
GAIA_PORT_L=${GAIA_PORT_L:-8462}
CLIENT_PORT=${CLIENT_PORT:-5195}
QUEST_PORT_L=${QUEST_PORT_L:-4695}
OPS=/Users/pascaldisse/projects/paloptic/viz/data
QUEST_SRC=/Users/pascaldisse/projects/paloptic/services/quest

mkdir -p "$WORLD/scenes" "$QDATA/journals" "$SCRATCH"

case "${1:-up}" in
  up)
    # ── world server ──────────────────────────────────────────────────────
    if ! curl -sf "http://localhost:$GAIA_PORT_L/world" >/dev/null 2>&1; then
      GAIA_PORT=$GAIA_PORT_L GAIA_WORLD="$WORLD" nohup node server/index.js \
        > "$SCRATCH/world.log" 2>&1 &
      disown
      for _ in $(seq 1 40); do sleep 0.5; curl -sf "http://localhost:$GAIA_PORT_L/world" >/dev/null 2>&1 && break; done
    fi
    curl -sf "http://localhost:$GAIA_PORT_L/world" >/dev/null || { echo "world server never came up — $SCRATCH/world.log" >&2; exit 1; }

    # seed ONCE: the marker is the proof, not the entity count (a re-POST
    # would double every spawn op)
    if [ ! -f "$SCRATCH/.seeded" ]; then
      for f in atlas-ops quest-ops; do
        curl -sf -X POST "http://localhost:$GAIA_PORT_L/op" \
          -H 'content-type: application/json' --data-binary "@$OPS/$f.json" >/dev/null \
          || echo "warn: $f POST refused (see world.log)" >&2
      done
      touch "$SCRATCH/.seeded"
    fi
    echo "world:  http://localhost:$GAIA_PORT_L (GAIA_WORLD=$WORLD)"

    # ── quest service (auth: argon2 /auth/*) ──────────────────────────────
    if ! curl -sf "http://localhost:$QUEST_PORT_L/health" >/dev/null 2>&1; then
      ( cd "$QUEST_SRC" && QUEST_PORT=$QUEST_PORT_L \
        QUEST_USERS_PATH="$QDATA/users.json" \
        QUEST_SESSIONS_PATH="$QDATA/sessions.json" \
        QUEST_JOURNALS_PATH="$QDATA/journals/" \
        QUEST_LEDGER_PATH="$QDATA/ledger.json" \
        QUEST_WORLD_HTTP_URL="http://localhost:$GAIA_PORT_L" \
        nohup bun run src/index.ts > "$SCRATCH/quest.log" 2>&1 & disown )
      for _ in $(seq 1 40); do sleep 0.5; curl -sf "http://localhost:$QUEST_PORT_L/health" >/dev/null 2>&1 && break; done
    fi
    curl -sf "http://localhost:$QUEST_PORT_L/health" >/dev/null || { echo "quest never came up — $SCRATCH/quest.log" >&2; exit 1; }
    echo "quest:  http://localhost:$QUEST_PORT_L (data $QDATA)"

    # ── client ────────────────────────────────────────────────────────────
    cat > "$SCRATCH/vite.config.mjs" <<EOF
import base from '${ROOT}/vite.config.js';
export default { ...base, root: '${ROOT}/client', cacheDir: '${SCRATCH}/vite',
  define: { ...(base.define ?? {}), __GAIA_PORT__: '${GAIA_PORT_L}' } };
EOF
    if ! curl -sf "http://localhost:$CLIENT_PORT/" >/dev/null 2>&1; then
      GAIA_PORT=$GAIA_PORT_L nohup npx vite --config "$SCRATCH/vite.config.mjs" \
        --port "$CLIENT_PORT" --strictPort > "$SCRATCH/vite.log" 2>&1 &
      disown
      for _ in $(seq 1 60); do sleep 0.5; curl -sf "http://localhost:$CLIENT_PORT/" >/dev/null 2>&1 && break; done
    fi
    curl -sf "http://localhost:$CLIENT_PORT/" >/dev/null || { echo "vite never came up — $SCRATCH/vite.log" >&2; exit 1; }
    echo "client: http://localhost:$CLIENT_PORT/?quest=http://localhost:$QUEST_PORT_L"
    ;;
  down)
    pkill -f "$SCRATCH/vite.config.mjs" 2>/dev/null || true
    pkill -f "QUEST_USERS_PATH=$QDATA" 2>/dev/null || true
    lsof -ti :$GAIA_PORT_L -sTCP:LISTEN | xargs -r kill 2>/dev/null || true
    lsof -ti :$QUEST_PORT_L -sTCP:LISTEN | xargs -r kill 2>/dev/null || true
    echo "lane down"
    ;;
  *) echo "usage: start-fix-stack.sh [up|down]"; exit 1;;
esac
