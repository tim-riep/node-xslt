#!/usr/bin/env bash
# Builds the Go WASM binding (go/) and copies it, together with the matching
# wasm_exec.js glue from the local Go toolchain, into dist/wasm/. Run this
# with the same Go toolchain version you intend to publish with: the glue
# file's import-object shape must match the binary it was built alongside.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT_DIR="dist/wasm"
mkdir -p "$OUT_DIR"

echo "==> go build (GOOS=js GOARCH=wasm)"
(cd go && GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o "../$OUT_DIR/go-xslt.wasm" .)

GOROOT="$(go env GOROOT)"
GLUE="$GOROOT/lib/wasm/wasm_exec.js"
if [ ! -f "$GLUE" ]; then
  # Older Go toolchains (< 1.24) shipped it under misc/wasm instead.
  GLUE="$GOROOT/misc/wasm/wasm_exec.js"
fi
if [ ! -f "$GLUE" ]; then
  echo "error: could not find wasm_exec.js under $GOROOT" >&2
  exit 1
fi

# .cjs so Node's ESM loader always runs it as CommonJS (it's a plain script
# with no import/export statements, and sets globals as a side effect).
cp "$GLUE" "$OUT_DIR/wasm_exec.cjs"

echo "==> wrote $OUT_DIR/go-xslt.wasm ($(du -h "$OUT_DIR/go-xslt.wasm" | cut -f1)) and $OUT_DIR/wasm_exec.cjs"
