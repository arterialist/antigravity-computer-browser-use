# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-11-20

### Added
- **Computer Use MCP (`antigravity-cua-mcp.js` + `antigravity-cua-native.swift`)**:
  - 43 unified tools combining display-scope mouse/keyboard/capture tools, background `AXUIElement` per-app tools, guided walkthrough callouts, and a persistent `js` REPL (`sky` and `cua` bindings).
  - Exact 28x28 tile vision token budget scaling (`<= 1568px` / `<= 1568` tokens).
  - `SoMInvalidationObserver` (`AXObserver` per target PID) and `AdaptiveSettleEngine` for fast cached Accessibility snapshots.
  - Non-activating macOS `NSPanel` desktop HUD & click ripple overlay.
  - Standalone `CGEvent`, `NSWorkspace`, and `CGWindowListCopyWindowInfo` fallbacks in `antigravity-cua-native`.
- **Chrome Browser Use MCP (`antigravity-browser-mcp.js` + Chrome Extension Bridge)**:
  - Combines `chrome-devtools-mcp` tools with `tabs_context_mcp`, `read_page` (interactive/depth/subtree filtering + stateful AX diffing), `find_elements`, `get_page_text`, `browser_batch`, `browser_js`, and `browser_switch_profile` (`main`, `cloned`, `isolated`).
  - Zero-popup `"main"` browser mode via the included Manifest V3 Chrome extension and UNIX socket native messaging broker (`browser-bridge.sock`).
- **Safari Browser Use MCP (`antigravity-safari-mcp.js`)**:
  - 18-tool native macOS Safari harness combining `Safari.sdef` JXA automation with WebKit `AXWebArea` tree walking and ScreenCaptureKit window capture.
- **Installer, Plugin Bundle, CI, and Test Suites**:
  - Automated `scripts/install.sh` and `scripts/uninstall.sh`.
  - Antigravity `computer-use` plugin bundle (`plugins/computer-use/`).
  - Offline smoke tests (`npm test`), CUA suite (`npm run test:cua`), Browser suite (`npm run test:browsers`), and full-spectrum workbench stress test (`npm run test:stress`).
