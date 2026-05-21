#!/usr/bin/env bash
# Sync vendor/axona-protocol/ from the local axona-protocol source.
#
# dht-sim links @axona/protocol via `file:../axona-protocol` in
# package.json for Node-side tests, but the BROWSER reads the kernel
# through an importmap that points at vendor/axona-protocol/ — that's
# what gets served on GitHub Pages.  This script keeps the vendored
# copy in sync with the local source.
#
# Run after any axona-protocol change you want reflected in the
# deployed simulator UI:
#
#   ./scripts/sync-vendor-kernel.sh
#   git add vendor/ && git commit -m "Vendor resync: <kernel tag>"
#   git push                 # GitHub Pages picks it up in ~30s
#
set -euo pipefail

SRC="../axona-protocol"
DEST="vendor/axona-protocol"

if [ ! -d "$SRC/src" ]; then
  echo "error: $SRC/src/ does not exist — clone axona-protocol as a sibling of dht-sim" >&2
  exit 1
fi

rm -rf "$DEST/src"
mkdir -p "$DEST"
cp -R "$SRC/src" "$DEST/src"
cp "$SRC/LICENSE"   "$DEST/LICENSE"   2>/dev/null || true
cp "$SRC/README.md" "$DEST/README.md" 2>/dev/null || true

# Stamp the kernel version for human verification.
KERNEL_VERSION="$(grep -m1 'KERNEL_VERSION' "$DEST/src/transport/handshake.js" | sed -E "s/.*'([^']+)'.*/\1/")"
echo "Synced vendor/axona-protocol from $SRC (kernel v$KERNEL_VERSION)"
