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
