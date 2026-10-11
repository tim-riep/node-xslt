#!/usr/bin/env bash
# Builds native/ (the cgo c-shared export layer) for the current GOOS/GOARCH
# (or whatever the caller has set them to, e.g. a CI build matrix) and writes
# it to dist/native/ under the name loader.ts expects: a Node
# platform/arch-named file, not a Go GOOS/GOARCH-named one.
#
# Requires CGO_ENABLED=1 and a real C toolchain for the TARGET platform —
# unlike the wasm build this replaced, this generally cannot cross-compile
# from a different host OS; build on a native runner per target (see
# .github/workflows/release.yml).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

GOOS="$(go env GOOS)"
GOARCH="$(go env GOARCH)"

case "$GOOS" in
  darwin) NODE_PLATFORM=darwin; EXT=dylib ;;
  linux)  NODE_PLATFORM=linux;  EXT=so ;;
  windows) NODE_PLATFORM=win32; EXT=dll ;;
  *) echo "error: unsupported GOOS=$GOOS" >&2; exit 1 ;;
esac

case "$GOARCH" in
  arm64) NODE_ARCH=arm64 ;;
  amd64) NODE_ARCH=x64 ;;
  *) echo "error: unsupported GOARCH=$GOARCH" >&2; exit 1 ;;
esac

OUT_DIR="dist/native"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/goxslt-$NODE_PLATFORM-$NODE_ARCH.$EXT"

echo "==> go build -buildmode=c-shared (GOOS=$GOOS GOARCH=$GOARCH CGO_ENABLED=1)"
(cd native && CGO_ENABLED=1 go build -buildmode=c-shared -ldflags="-s -w" -o "../$OUT_FILE" .)
# c-shared also emits a .h header next to the library; not needed at runtime.
rm -f "${OUT_FILE%.*}.h" "$OUT_DIR"/*.h 2>/dev/null || true

echo "==> wrote $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"
