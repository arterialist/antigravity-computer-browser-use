#!/bin/sh
# Antigravity Native Host Wrapper for Google Chrome

NODE_BIN="$(command -v node 2>/dev/null || true)"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.volta/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
    fi
  done
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "antigravity-browser-native-host: node binary not found" >&2
  exit 1
fi

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/antigravity-browser-native-host.cjs"
exec "$NODE_BIN" "$SCRIPT_PATH"
