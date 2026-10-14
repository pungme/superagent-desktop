#!/bin/sh
# Compile the simulator framebuffer helper. macOS only, and entirely optional:
# if this fails the app falls back to the screenshot mirror, so never hard-fail
# the build over it.
set -e
cd "$(dirname "$0")"
[ "$(uname)" = "Darwin" ] || { echo "simfb: not macOS, skipping"; exit 0; }
command -v clang >/dev/null 2>&1 || { echo "simfb: no clang, skipping"; exit 0; }
clang -O2 -fobjc-arc -mmacosx-version-min=11.0 \
  -framework Foundation -framework CoreGraphics -framework ImageIO \
  -framework IOSurface -framework UniformTypeIdentifiers \
  -o simfb simfb.m
echo "simfb: built"

# The hands of computer use (cuse.c): optional in the same way. Without it the
# agent is told computer use is unavailable rather than the build failing.
clang -O2 -mmacosx-version-min=11.0 \
  -framework ApplicationServices -framework CoreFoundation \
  -o cuse cuse.c && echo "cuse: built" || echo "cuse: not built, skipping"

# The ring that shows where computer use is about to act (ring.m). It only
# draws; without it actions simply happen unannounced.
clang -O2 -fobjc-arc -mmacosx-version-min=11.0 \
  -framework Cocoa -framework QuartzCore \
  -o ring ring.m && echo "ring: built" || echo "ring: not built, skipping"

# Simulator input the way Xcode 27 takes it (siminput.m): through dtuhidd.
# Without it input goes through baguette, which Xcode 27 silently ignores.
clang -O2 -fobjc-arc -mmacosx-version-min=11.0 \
  -framework Foundation \
  -o siminput siminput.m && echo "siminput: built" || echo "siminput: not built, skipping"

# The simulator's screen embedded in the window (simview.m), a Node-API
# module. Node-API is ABI-stable, so the headers of whichever Node is building
# do for Electron's. Without it the pane streams the screen instead.
NODE_INC="$(node -p "require('path').join(process.execPath, '..', '..', 'include', 'node')" 2>/dev/null || true)"
if [ -n "$NODE_INC" ] && [ -f "$NODE_INC/node_api.h" ]; then
  clang -O2 -fobjc-arc -mmacosx-version-min=11.0 -I"$NODE_INC" \
    -bundle -undefined dynamic_lookup \
    -framework Foundation -framework AppKit -framework QuartzCore -framework IOSurface \
    -o simview.node simview.m && echo "simview: built" || echo "simview: not built, skipping"
else
  echo "simview: no Node-API headers, skipping"
fi
