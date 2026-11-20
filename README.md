# Antigravity Computer & Browser Use

[![CI](https://github.com/arterialist/antigravity-computer-browser-use/actions/workflows/ci.yml/badge.svg)](https://github.com/arterialist/antigravity-computer-browser-use/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS-lightgrey.svg)](https://www.apple.com/macos/)

A suite of three fast, zero-popup **Model Context Protocol (MCP)** servers for macOS desktop automation, Google Chrome automation, and Apple Safari automation:

1. **Computer Use MCP (`antigravity-cua-mcp.js`)** — 43 tools combining full-screen display control, per-app background `AXUIElement` automation, stateful AX tree diffing, a persistent `js` REPL (`sky` & `cua` bindings), and a native Swift helper (`antigravity-cua-native`).
2. **Chrome Browser Use MCP (`antigravity-browser-mcp.js`)** — Combines `chrome-devtools-mcp` with `tabs_context_mcp`, stateful `read_page` diffing, `find_elements`, `get_page_text`, `browser_batch`, `browser_js` REPL, and a Manifest V3 Chrome Extension + Native Messaging broker for zero-popup control of your live Chrome session.
3. **Safari Browser Use MCP (`antigravity-safari-mcp.js`)** — 18 native Safari tools combining `Safari.sdef` JXA automation (`tab.text()`, navigation, tab switching) with WebKit `AXWebArea` tree walking and ScreenCaptureKit/window capture.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     MCP Client (Antigravity / AI Agent)                 │
└───────────┬──────────────────────────┬───────────────────────┬──────────┘
            │ stdio JSON-RPC           │ stdio JSON-RPC        │ stdio JSON-RPC
            ▼                          ▼                       ▼
┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────┐
│ antigravity-cua-mcp   │  │ antigravity-browser-  │  │ antigravity-      │
│ (43 Desktop/App Tools)│  │ mcp (Chrome, 45 Tools)│  │ safari-mcp (18)   │
└───────────┬───────────┘  └───────────┬───────────┘  └─────────┬─────────┘
            │ JSON-RPC                 │ UNIX socket            │ JXA +
            ▼                          ▼                        │ JSON-RPC
┌───────────────────────┐  ┌───────────────────────┐            │
│ antigravity-cua-native│  │ browser-bridge.sock   │            │
│ (Swift AX + CGEvent + │  │ -> Native Host        │◄───────────┘
│  ScreenCaptureKit HUD)│  │ -> Chrome Extension   │
└───────────────────────┘  └───────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for deep technical details.

---

## Features

### Computer Use (`computer-use`)
- **43 tools** covering display actions (`screenshot`, `zoom`, `left_click`, `left_click_drag`, `type`, `key`, `computer_batch`), background per-app tools (`app_screenshot`, `app_ax_find`, `app_click`, `app_type`, `app_menu`, `app_batch`, `app_move_to_display`), and a persistent `js` REPL (`sky` & `cua`).
- **28x28 vision token budget scaling**: Automatically scales screenshots to fit within `1568px` and `1568` vision tokens.
- **`SoMInvalidationObserver` & `AdaptiveSettleEngine`**: Uses macOS `AXObserver` notifications per target PID to skip redundant tree walks (~7 ms cache hits) and wait dynamically for UI settle.
- **Stateful AX tree diffing**: Returns compact diffs (`+ Added` / `- Removed` / `<ax-diff status="unchanged" />`) across consecutive calls, plus `text_only: true` for zero-vision-token inspection.
- **Non-activating desktop HUD**: Floating macOS `NSPanel` overlay and click ripple indicator (`antigravity-cua-native`).

### Google Chrome (`chrome-devtools-mcp`)
- **Zero-popup `"main"` mode**: Routes through the included **Antigravity Browser Bridge** Chrome Extension (`extensions/antigravity-browser-extension/`) and local UNIX socket broker (`~/.gemini/antigravity/browser-bridge.sock`), avoiding Chrome 136+'s `"Allow remote debugging?"` modal popup.
- **Optional `"cloned"` & `"isolated"` modes**: Switch anytime via `browser_switch_profile` (supports APFS copy-on-write profile cloning on macOS).
- **Token-efficient primitives**: `read_page` (interactive/depth/subtree filters + stateful diffs), `find_elements`, `get_page_text`, `browser_batch`, and `browser_js` REPL.

### Apple Safari (`safari-browser-mcp`)
- **Zero driver setup**: Uses `Safari.sdef` AppleEvents / JXA + WebKit `AXWebArea` accessibility traversal.
- **Fast text & DOM access**: `get_page_text`, `read_page` (with stateful diffing), `find_elements`, `click`, `fill`, `take_screenshot`, `browser_batch`, and `browser_js`.

---

## Quick Start

### Prerequisites
- **macOS** (Apple Silicon or Intel, macOS 13+)
- **Node.js 18+** (`node -v`)
- **Xcode Command Line Tools** (`swiftc --version` — install via `xcode-select --install` if missing)

### 1. Clone, Build & Install

```bash
git clone https://github.com/arterialist/antigravity-computer-browser-use.git
cd antigravity-computer-browser-use
npm install
./scripts/install.sh
```

`scripts/install.sh` will:
1. Compile `bin/antigravity-cua-native.swift` to `bin/antigravity-cua-native`.
2. Install all server scripts and dependencies into `~/.gemini/bin/`.
3. Install the `computer-use` plugin bundle into `~/.gemini/config/plugins/computer-use/`.
4. Install the Chrome Extension into `~/.gemini/antigravity/chrome-extension/` and register the Native Messaging host manifest in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
5. Register `computer-use`, `chrome-devtools-mcp`, and `safari-browser-mcp` in `~/.gemini/antigravity/mcp_config.json`.

### 2. Load the Chrome Extension (for zero-popup `"main"` mode)
1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select `~/.gemini/antigravity/chrome-extension`.
4. Pin the **Antigravity Browser Bridge** extension (badge shows `ON` when connected).

### 3. Grant macOS Permissions
In **System Settings → Privacy & Security**:
- **Accessibility**: Enable your terminal / IDE (and Chrome/Safari if prompted).
- **Screen & System Audio Recording**: Enable your terminal / IDE so screenshots and window captures succeed.

---

## Standalone MCP Configuration

If you want to wire these servers into another MCP client directly from your cloned repo:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "node",
      "args": ["/path/to/antigravity-computer-browser-use/bin/antigravity-cua-mcp.js"],
      "timeoutSeconds": 60
    },
    "chrome-devtools-mcp": {
      "command": "node",
      "args": ["/path/to/antigravity-computer-browser-use/bin/antigravity-browser-mcp.js"],
      "timeoutSeconds": 60
    },
    "safari-browser-mcp": {
      "command": "node",
      "args": ["/path/to/antigravity-computer-browser-use/bin/antigravity-safari-mcp.js"],
      "timeoutSeconds": 60
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ANTIGRAVITY_CUA_AUTO_GHOST` | `1` | Set to `0` to disable auto-ghosting when a click coordinate overlaps the IDE window. |
| `ANTIGRAVITY_CUA_HUD` | `1` | Set to `0` to disable the floating desktop HUD & click ripple overlay. |
| `ANTIGRAVITY_CUA_TRACE_LOG` | `/tmp/antigravity-cua-trace.jsonl` | Path for local JSONL CUA action trace logs. |
| `ANTIGRAVITY_BROWSER_SOCKET` | `~/.gemini/antigravity/browser-bridge.sock` | Custom UNIX socket path for the Chrome extension native messaging broker. |
| `AGY_BROWSER_PROFILE_MODE` | `main` | Chrome profile mode: `main`, `cloned`, or `isolated`. |
| `CHROME_DEVTOOLS_MCP_ROOT` | Auto-detected | Optional override path to `chrome-devtools-mcp`. |

---

## Testing

Run the offline syntax, Swift compilation, and MCP protocol smoke tests:

```bash
npm test
```

Run the live macOS Computer Use, Chrome/Safari Browser, and full-spectrum workbench stress tests:

```bash
npm run test:cua
npm run test:browsers
npm run test:stress
```

---

## Uninstall

```bash
./scripts/uninstall.sh
```

---

## License

[MIT](LICENSE) © arterialist
