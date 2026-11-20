#!/usr/bin/env bash
set -euo pipefail

AGY_BIN="$HOME/.gemini/bin"
AGY_PLUGINS="$HOME/.gemini/config/plugins"
MCP_CONFIG="$HOME/.gemini/antigravity/mcp_config.json"
CHROME_HOST_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.google.antigravity.browser_bridge.json"
EXTENSION_INSTALL_DIR="$HOME/.gemini/antigravity/chrome-extension"

echo "=== Uninstalling Antigravity Computer & Browser Use MCP Suite ==="

for f in \
  antigravity-cua-mcp.js \
  antigravity-cua-native.swift \
  antigravity-cua-native \
  antigravity-browser-mcp.js \
  antigravity-browser-broker.cjs \
  antigravity-browser-native-host.cjs \
  antigravity-browser-native-host.sh \
  antigravity-safari-mcp.js; do
  rm -f "$AGY_BIN/$f"
done

rm -rf "$AGY_PLUGINS/computer-use"
rm -rf "$EXTENSION_INSTALL_DIR"
rm -f "$CHROME_HOST_MANIFEST"

if [ -f "$MCP_CONFIG" ]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      if (cfg && cfg.mcpServers) {
        delete cfg.mcpServers["computer-use"];
        delete cfg.mcpServers["chrome-devtools-mcp"];
        delete cfg.mcpServers["safari-browser-mcp"];
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      }
    } catch (_) {}
  ' "$MCP_CONFIG"
fi

echo "=== Uninstall complete ==="
