#!/usr/bin/env bash
# build.sh — gaia-render → wasm → JS glue. Everything lands in .scratch (gitignored); no global installs.
#   wasm-bindgen-cli pinned to the Cargo.lock wasm-bindgen version; installed into .scratch/tools if absent.
set -euo pipefail
R=$(cd "$(dirname "$0")/../.." && pwd)
WBG=$(awk '/name = "wasm-bindgen"/{getline; gsub(/"/,""); sub(/^ *version *= */,""); print; exit}' "$R/client-rs/Cargo.lock")
BIN=${WBG_BIN:-$R/.scratch/tools/bin/wasm-bindgen}
[ -x "$BIN" ] || cargo install wasm-bindgen-cli --version "$WBG" --root "$R/.scratch/tools" --target-dir "$R/.scratch/tools-build"
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$R/.scratch/target}
(cd "$R/client-rs" && cargo build --profile wasm-release -p render-wasm --target wasm32-unknown-unknown)
"$BIN" --target web --out-dir "${OUT:-$R/.scratch/pkg}" --out-name render_wasm "$CARGO_TARGET_DIR/wasm32-unknown-unknown/wasm-release/render_wasm.wasm"
ls -l "${OUT:-$R/.scratch/pkg}"/render_wasm_bg.wasm
