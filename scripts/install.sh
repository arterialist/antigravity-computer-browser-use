#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGY_BIN="$HOME/.gemini/bin"
AGY_PLUGINS="$HOME/.gemini/config/plugins"
MCP_CONFIG="$HOME/.gemini/antigravity/mcp_config.json"

echo "=== Installing Antigravity Computer & Browser Use MCP Suite ==="

mkdir -p "$AGY_BIN"
mkdir -p "$AGY_PLUGINS"
mkdir -p "$(dirname "$MCP_CONFIG")"

if [ ! -d "$SCRIPT_DIR/node_modules/chrome-devtools-mcp" ]; then
  echo "Installing npm dependencies..."
  (cd "$SCRIPT_DIR" && npm install --omit=dev)
fi

if [ -f "$SCRIPT_DIR/bin/antigravity-cua-native.swift" ]; then
  if [ ! -f "$SCRIPT_DIR/bin/antigravity-cua-native" ] || [ "$SCRIPT_DIR/bin/antigravity-cua-native.swift" -nt "$SCRIPT_DIR/bin/antigravity-cua-native" ]; then
    echo "Compiling native Swift Computer Use helper..."
    swiftc -O "$SCRIPT_DIR/bin/antigravity-cua-native.swift" -o "$SCRIPT_DIR/bin/antigravity-cua-native"
  fi
fi

echo "Copying scripts and binaries to $AGY_BIN..."
cp -f "$SCRIPT_DIR/bin/"* "$AGY_BIN/"
chmod +x "$AGY_BIN/"*.sh "$AGY_BIN/"*.js "$AGY_BIN/antigravity-cua-native" 2>/dev/null || true

if [ -d "$SCRIPT_DIR/node_modules" ]; then
  echo "Syncing Node dependencies to $AGY_BIN/node_modules..."
  rm -rf "$AGY_BIN/node_modules"
  cp -R "$SCRIPT_DIR/node_modules" "$AGY_BIN/node_modules"
fi

if [ -d "$SCRIPT_DIR/plugins/computer-use" ]; then
  echo "Installing Computer Use plugin to $AGY_PLUGINS/computer-use..."
  rm -rf "$AGY_PLUGINS/computer-use"
  cp -R "$SCRIPT_DIR/plugins/computer-use" "$AGY_PLUGINS/computer-use"
  chmod +x "$AGY_PLUGINS/computer-use/hooks/"*.js 2>/dev/null || true
  node -e '
    const fs = require("fs");
    const cfgPath = process.argv[1];
    const cuaBin = process.argv[2];
    const cfg = {
      mcpServers: {
        "computer-use": {
          command: "node",
          args: [cuaBin],
          forceAllToolsEager: true,
          timeoutSeconds: 60
        }
      }
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  ' "$AGY_PLUGINS/computer-use/mcp_config.json" "$AGY_BIN/antigravity-cua-mcp.js"
fi

CHROME_HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
EXTENSION_INSTALL_DIR="$HOME/.gemini/antigravity/chrome-extension"

if [ -d "$SCRIPT_DIR/extensions/antigravity-browser-extension" ]; then
  echo "Installing Antigravity Browser Bridge Chrome Extension to $EXTENSION_INSTALL_DIR..."
  mkdir -p "$EXTENSION_INSTALL_DIR"
  cp -R "$SCRIPT_DIR/extensions/antigravity-browser-extension/"* "$EXTENSION_INSTALL_DIR/"
  rm -f "$EXTENSION_INSTALL_DIR/com.google.antigravity.browser_bridge.json"

  mkdir -p "$CHROME_HOSTS_DIR"
  node -e '
    const fs = require("fs");
    const src = process.argv[1];
    const dst = process.argv[2];
    const hostPath = process.argv[3];
    const manifest = JSON.parse(fs.readFileSync(src, "utf8"));
    manifest.path = hostPath;
    fs.writeFileSync(dst, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  ' "$SCRIPT_DIR/extensions/antigravity-browser-extension/com.google.antigravity.browser_bridge.json" \
    "$CHROME_HOSTS_DIR/com.google.antigravity.browser_bridge.json" \
    "$AGY_BIN/antigravity-browser-native-host.sh"
fi

echo "Registering computer-use, chrome-devtools-mcp, and safari-browser-mcp servers in $MCP_CONFIG..."
node -e '
const fs = require("fs");
const p = process.argv[1];
const cuaBin = process.argv[2];
const chromeBin = process.argv[3];
const safariBin = process.argv[4];
let cfg = { mcpServers: {} };
try {
  if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, "utf8"));
} catch (_) {}
if (!cfg.mcpServers) cfg.mcpServers = {};
cfg.mcpServers["computer-use"] = {
  command: "node",
  args: [cuaBin],
  forceAllToolsEager: true,
  timeoutSeconds: 60
};
cfg.mcpServers["chrome-devtools-mcp"] = {
  command: "node",
  args: [chromeBin],
  timeoutSeconds: 60
};
cfg.mcpServers["safari-browser-mcp"] = {
  command: "node",
  args: [safariBin],
  timeoutSeconds: 60
};
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
' "$MCP_CONFIG" "$AGY_BIN/antigravity-cua-mcp.js" "$AGY_BIN/antigravity-browser-mcp.js" "$AGY_BIN/antigravity-safari-mcp.js"

echo ""
echo "=== Installation complete! ==="
echo "Next steps:"
echo "  1. Grant macOS Accessibility & Screen Recording permissions to your terminal / IDE."
echo "  2. For zero-popup main Chrome control, load unpacked extension in chrome://extensions from:"
echo "     $EXTENSION_INSTALL_DIR"
