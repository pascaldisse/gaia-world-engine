#!/usr/bin/env bash
# nari-say.sh — Nyari's voice: speak in-world AND aloud through claude-voice.
#
# Usage: nari-say.sh "text to say"
#
# HARD RULES:
#   - Never touch any process except starting the claude-voice daemon if down.
#   - Never touch the engine on port 8420.

set -euo pipefail

ENGINE_DIR="/Users/pascaldisse/projects/GAIA-World-Engine-naruko"
CLAUDE_SAY="/Users/pascaldisse/projects/claude-voice/bin/claude-say"
VOICE_START="/Users/pascaldisse/projects/claude-voice/start.sh"
HEALTH_URL="http://127.0.0.1:8778/health"
LOG_FILE="/tmp/nari-voice.log"

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$LOG_FILE"
}

if [ "$#" -lt 1 ]; then
  echo "usage: nari-say.sh \"text...\"" >&2
  exit 1
fi

TEXT="$*"

# (1) Post the text in-world. This must never be blocked by voice failure.
(cd "$ENGINE_DIR" && GAIA_AGENT="agent-nyari" node tools/agent.mjs say "$TEXT")

# (2) Resilience check for the voice daemon.
is_healthy() {
  curl -s -m 2 "$HEALTH_URL" | grep -q '"ok":true'
}

VOICE_STATE=""

if is_healthy; then
  VOICE_STATE="healthy"
else
  nohup "$VOICE_START" >/dev/null 2>&1 &
  disown || true

  waited=0
  started=false
  while [ "$waited" -lt 30 ]; do
    if is_healthy; then
      started=true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if [ "$started" = true ]; then
    VOICE_STATE="started"
  else
    VOICE_STATE="skipped"
  fi
fi

log "$VOICE_STATE"

# (3) Speak it aloud, in background, only if the daemon is up.
if [ "$VOICE_STATE" != "skipped" ]; then
  ( "$CLAUDE_SAY" --voice airy "$TEXT" >/dev/null 2>&1 & disown ) || true
fi

exit 0
