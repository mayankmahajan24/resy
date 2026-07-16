#!/usr/bin/env bash
# Install Playwright into a persistent cache dir so the OpenTable checker survives reboots.
# Only needed for OpenTable (Resy + SevenRooms are pure curl and need nothing installed).
# Idempotent — safe to re-run; skips work if already present.
set -e
CACHE="$HOME/.cache/reservation-checker"
mkdir -p "$CACHE"
cd "$CACHE"
if [ ! -d node_modules/playwright ]; then
  echo "Installing playwright into $CACHE ..."
  [ -f package.json ] || npm init -y >/dev/null 2>&1
  npm install playwright@^1.61.1
else
  echo "playwright already installed in $CACHE"
fi
# Uses the system Chrome (channel:'chrome'), so no need to download Chromium bundles.
echo "Setup complete. System Chrome will be driven headed at run time."
