#!/usr/bin/env bash
# native-play — run the JS game inside the native macOS host (client-rs/packages/game-window): Tauri webview for the game page,
# Rust gaia-render on Metal at internal height -> MetalFX -> surface. Does NOT start the game servers (world/bridge/vite): use the DS
# launcher for that (~/projects/nari-world-companion/tools/ds-world/play.sh; it opens Brave at the end -- PLAY_BRAVE=/usr/bin/true skips it, UNVERIFIED), then run this.
# usage: tools/native-play.sh [--url U] [--render-height N] [--upscaler metalfx-spatial|bilinear] [--build] [-- <extra game-window args>]
# Params (flag > env > default):
#   --url              NATIVE_URL            default = url.txt of the CURRENT play.sh session under NATIVE_PLAY_ROOT
#   --render-height    NATIVE_RENDER_HEIGHT  720
#   --upscaler         NATIVE_UPSCALER       metalfx-spatial
#   NATIVE_PLAY_ROOT   ~/projects/nari-world-companion        (session lookup: <root>/.scratch/live/CURRENT -> <dir>/url.txt)
#   NATIVE_RENDER_BACKEND native       value written to ?renderBackend= (wgpu in play.sh's url = the in-browser wasm path); contract with the page-side transport (lane nt-ipc)
#   NATIVE_HOST        ipc             ipc = real gaia_render_host::Host | stub = window/loop only, draws nothing
#   NATIVE_PROFILE     release         cargo profile of the binary
#   CARGO_TARGET_DIR   <repo>/client-rs/target      CARGO_BUILD_JOBS 4
#   NATIVE_BIN         <target>/<profile>/game-window
#   --build / NATIVE_BUILD=1  (re)build first (also automatic when the binary is missing)
# Every other game-window option (--width --fps-cap --page-gpu --pointer-lock --devtools --fullscreen ... see `game-window --help`) goes after `--`.
set -u
R="$(cd "$(dirname "$0")/.." && pwd)"
URL="${NATIVE_URL:-}"; H="${NATIVE_RENDER_HEIGHT:-720}"; UP="${NATIVE_UPSCALER:-metalfx-spatial}"
ROOT="${NATIVE_PLAY_ROOT:-$HOME/projects/nari-world-companion}"; BACKEND="${NATIVE_RENDER_BACKEND:-native}"
HOST="${NATIVE_HOST:-ipc}"; PROFILE="${NATIVE_PROFILE:-release}"; BUILD="${NATIVE_BUILD:-0}"
TARGET="${CARGO_TARGET_DIR:-$R/client-rs/target}"; BIN="${NATIVE_BIN:-$TARGET/$PROFILE/game-window}"
EXTRA=()
while [ $# -gt 0 ]; do case "$1" in
  --url) URL="$2"; shift 2;; --render-height) H="$2"; shift 2;; --upscaler) UP="$2"; shift 2;;
  --build) BUILD=1; shift;; --) shift; EXTRA=("$@"); break;;
  -h|--help) sed -n '2,22p' "$0"; exit 0;;
  *) echo "REFUSED: unknown arg $1 (see --help)" >&2; exit 2;; esac; done
if [ -z "$URL" ]; then
  CUR="$ROOT/.scratch/live/CURRENT"
  [ -f "$CUR" ] && [ -f "$(cat "$CUR")/url.txt" ] || { echo "REFUSED: no --url/NATIVE_URL and no play.sh session ($CUR -> url.txt). Start the game servers first." >&2; exit 2; }
  URL="$(cat "$(cat "$CUR")/url.txt")"
fi
case "$URL" in http://*|https://*) ;; *) echo "REFUSED: url must be http(s)://, got $URL" >&2; exit 2;; esac
# the page picks its renderer from ?renderBackend= : point it at the native host
if printf '%s' "$URL" | grep -Eq '[?&]renderBackend='; then URL="$(printf '%s' "$URL" | sed -E "s/([?&])renderBackend=[^&]*/\\1renderBackend=$BACKEND/")"
elif printf '%s' "$URL" | grep -q '?'; then URL="$URL&renderBackend=$BACKEND"; else URL="$URL?renderBackend=$BACKEND"; fi
case "$HOST" in
  ipc) FEAT=(--no-default-features --features host-ipc)
       [ -d "$R/client-rs/crates/gaia-render-host" ] || { echo "REFUSED: NATIVE_HOST=ipc but client-rs/crates/gaia-render-host is missing (lane nt-ipc not merged). NATIVE_HOST=stub runs the window/loop only." >&2; exit 2; };;
  stub) FEAT=();;
  *) echo "REFUSED: NATIVE_HOST=$HOST (ipc|stub)" >&2; exit 2;;
esac
if [ "$BUILD" = 1 ] || [ ! -x "$BIN" ]; then
  echo "[native-play] building game-window ($PROFILE, host=$HOST) -> $TARGET" >&2
  PROF=(); [ "$PROFILE" = release ] && PROF=(--release) || { [ "$PROFILE" = debug ] || PROF=(--profile "$PROFILE"); }
  (cd "$R/client-rs" && CARGO_TARGET_DIR="$TARGET" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" cargo build -p game-window ${PROF[@]+"${PROF[@]}"} ${FEAT[@]+"${FEAT[@]}"}) || exit 1
fi
[ -x "$BIN" ] || { echo "REFUSED: $BIN missing after build" >&2; exit 1; }
echo "[native-play] $URL  (render ${H}p, $UP, host=$HOST)" >&2
exec "$BIN" --url "$URL" --render-height "$H" --upscaler "$UP" ${EXTRA[@]+"${EXTRA[@]}"}
