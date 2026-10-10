#!/usr/bin/env bash
# native-play — run the JS game inside the native macOS host (client-rs/packages/game-window): Tauri webview for the game page,
# Rust gaia-render on Metal at internal height -> MetalFX -> surface. Does NOT start the game servers (world/bridge/vite): the game's
# own launcher starts them and passes --url (engine knows no game path).
# usage: tools/native-play.sh [--url U] [--render-height N] [--upscaler metalfx-spatial|bilinear] [--build] [-- <extra game-window args>]
# Params (flag > env > default):
#   --url              NATIVE_URL            default = url.txt of the CURRENT play.sh session under NATIVE_PLAY_ROOT
#   --render-height    NATIVE_RENDER_HEIGHT  720
#   --upscaler         NATIVE_UPSCALER       metalfx-spatial
#   NATIVE_PLAY_ROOT   (no default; game repo root) session lookup <root>/.scratch/live/CURRENT -> <dir>/url.txt, only when no --url
#   NATIVE_RENDER_BACKEND native       forced into the page URL's ?renderBackend= BY game-window (play.sh's url says wgpu = the in-browser wasm path); ?wgpuHeight= is forced the same way from --render-height
#   NATIVE_PROFILE     release         cargo profile of the binary
#   CARGO_TARGET_DIR   <repo>/client-rs/target      CARGO_BUILD_JOBS 4
#   NATIVE_BIN         <target>/<profile>/game-window
#   --build / NATIVE_BUILD=1  (re)build first (also automatic when the binary is missing)
# Every other game-window option (--width --fps-cap --page-gpu --pointer-lock --devtools --fullscreen ... see `game-window --help`) goes after `--`.
set -u
R="$(cd "$(dirname "$0")/.." && pwd)"
URL="${NATIVE_URL:-}"; H="${NATIVE_RENDER_HEIGHT:-720}"; UP="${NATIVE_UPSCALER:-metalfx-spatial}"
ROOT="${NATIVE_PLAY_ROOT:-}"; BACKEND="${NATIVE_RENDER_BACKEND:-native}"
PROFILE="${NATIVE_PROFILE:-release}"; BUILD="${NATIVE_BUILD:-0}"
TARGET="${CARGO_TARGET_DIR:-$R/client-rs/target}"; BIN="${NATIVE_BIN:-$TARGET/$PROFILE/game-window}"
EXTRA=()
while [ $# -gt 0 ]; do case "$1" in
  --url) URL="$2"; shift 2;; --render-height) H="$2"; shift 2;; --upscaler) UP="$2"; shift 2;;
  --build) BUILD=1; shift;; --) shift; EXTRA=("$@"); break;;
  -h|--help) sed -n '2,22p' "$0"; exit 0;;
  *) echo "REFUSED: unknown arg $1 (see --help)" >&2; exit 2;; esac; done
if [ -z "$URL" ]; then
  [ -n "$ROOT" ] || { echo "REFUSED: no --url/NATIVE_URL and no NATIVE_PLAY_ROOT (engine has no game default)" >&2; exit 2; }
  CUR="$ROOT/.scratch/live/CURRENT"
  [ -f "$CUR" ] && [ -f "$(cat "$CUR")/url.txt" ] || { echo "REFUSED: no --url/NATIVE_URL and no play.sh session ($CUR -> url.txt). Start the game servers first." >&2; exit 2; }
  URL="$(cat "$(cat "$CUR")/url.txt")"
fi
case "$URL" in http://*|https://*) ;; *) echo "REFUSED: url must be http(s)://, got $URL" >&2; exit 2;; esac
if [ "$BUILD" = 1 ] || [ ! -x "$BIN" ]; then
  echo "[native-play] building game-window ($PROFILE) -> $TARGET" >&2
  PROF=(); [ "$PROFILE" = release ] && PROF=(--release) || { [ "$PROFILE" = debug ] || PROF=(--profile "$PROFILE"); }
  (cd "$R/client-rs" && CARGO_TARGET_DIR="$TARGET" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" cargo build -p game-window ${PROF[@]+"${PROF[@]}"}) || exit 1
fi
[ -x "$BIN" ] || { echo "REFUSED: $BIN missing after build" >&2; exit 1; }
echo "[native-play] $URL  (render ${H}p, $UP, backend=$BACKEND)" >&2
exec "$BIN" --url "$URL" --render-height "$H" --upscaler "$UP" --render-backend "$BACKEND" ${EXTRA[@]+"${EXTRA[@]}"}
