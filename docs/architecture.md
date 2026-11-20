# Architecture

This document describes the architecture of the three macOS MCP servers in **Antigravity Computer & Browser Use**:

1. **Computer Use MCP (`bin/antigravity-cua-mcp.js` + `bin/antigravity-cua-native.swift`)**
2. **Chrome Browser Use MCP (`bin/antigravity-browser-mcp.js` + `extensions/antigravity-browser-extension/`)**
3. **Safari Browser Use MCP (`bin/antigravity-safari-mcp.js`)**

---

## 1. Computer Use MCP (`antigravity-cua-mcp.js`)

The Computer Use MCP exposes 43 tools across three execution models:

- **Display-scope tools**: `request_access`, `screenshot`, `zoom`, `left_click`, `double_click`, `triple_click`, `right_click`, `middle_click`, `left_click_drag` (60 FPS cubic ease-out interpolation), `mouse_move`, `left_mouse_down`, `left_mouse_up`, `scroll`, `type` (clipboard fast-path + grapheme-by-grapheme focus guard), `key`, `hold_key`, `wait`, `cursor_position`, `open_application`, `switch_display`, `list_apps`, `read_clipboard`, `write_clipboard`, and `computer_batch`.
- **Per-app background tools**: `app_list_windows`, `app_screenshot`, `app_ax_find`, `app_click`, `app_type`, `app_key`, `app_scroll`, `app_drag`, `app_menu`, `app_bring_to_current_space`, `app_move_to_display`, `app_batch`, and `app_release`.
- **Stateful JavaScript REPL & Sky AX primitives**: `js`, `js_reset`, `sky_select_text`, `sky_perform_secondary_action`, `sky_paste`, and `teach_step`.

### 1.1 28x28 tile vision token budget scaling

Instead of fixed XGA (`1024x768`), display and window captures compute the largest integer dimensions `[frameWidth, frameHeight]` preserving the display aspect ratio where neither axis exceeds `1568` px and total `28x28` tiles do not exceed `1568` tokens:

$$\text{tiles}(w, h) = \left(\left\lfloor \frac{w - 1}{28} \right\rfloor + 1\right) \times \left(\left\lfloor \frac{h - 1}{28} \right\rfloor + 1\right) \le 1568$$

### 1.2 Native Swift Helper (`antigravity-cua-native.swift`)

`antigravity-cua-native` runs as a persistent stdio JSON-RPC helper providing:

1. **`SoMInvalidationObserver` (`AXObserver` per target PID)**: Subscribes to `kAXValueChangedNotification`, `kAXUIElementDestroyedNotification`, `kAXFocusedUIElementChangedNotification`, `kAXWindowMovedNotification`, `kAXWindowResizedNotification`, `kAXTitleChangedNotification`, and `kAXMainWindowChangedNotification`. Unchanged trees return cached `axSummary` snapshots in ~7 ms.
2. **`AdaptiveSettleEngine`**: Replaces fixed post-action sleeps with an `AXObserver`-driven settle loop polling every 10 ms and exiting after 28 ms of UI quietness (capped at 90 ms).
3. **Off-Space `AXUIElement` tree walking & direct actuation**: Enumerates `kAXWindowsAttribute`, `kAXMainWindowAttribute`, and `kAXFocusedWindowAttribute`, caching live `AXUIElement` handles for `clickElement`, `setValue`, `selectText`, and `performSecondaryAction`.
4. **In-memory `captureDisplayFast` / `captureWindowFast` with 64-bit `dHash`**: Downscales captures directly in memory to JPEG (`quality: 0.76`) and computes a 64-bit `dHash` + 9x8 `lumaDelta`.
5. **Rich clipboard snapshot/restore**: Writes HTML, Markdown (converted to HTML + plain text), or plain text to `NSPasteboard` and restores previous pasteboard items after pasting.
6. **Non-activating desktop HUD overlay**: Renders a floating `NSPanel` status pill and click ripple (`OverlayController`) without stealing window focus.
7. **Standalone `CGEvent` & `CGWindowListCopyWindowInfo` primitives**: Supports `listApps`, `listWindows`, `mouseLocation`, `appMenu`, `appUnderPoint`, `moveAppBehind`, and `cgEventInput` natively on macOS with zero external dependencies.

### 1.3 Host IDE Auto-Ghosting & Token Efficiency

- **Auto-Ghosting**: Automatically lowers overlapping `com.google.antigravity` windows when a foreground display click would otherwise target the IDE itself (`ANTIGRAVITY_CUA_AUTO_GHOST`).
- **Text-only mode (`text_only: true`)**: Skips image capture in `app_screenshot` and `app_ax_find` when only the Accessibility tree is needed.

---

## 2. Chrome Browser Use MCP (`antigravity-browser-mcp.js`)

`antigravity-browser-mcp.js` combines stock `chrome-devtools-mcp` tools with 7 high-level automation tools:

- `tabs_context_mcp`: Lists open tabs (`pageId`, `tabId`, title, URL, active profile mode, lifecycle marks).
- `read_page`: Accessibility/DOM snapshot with `filter: "interactive" | "all"`, `depth`, `uid` subtree scoping, and stateful diffing (`<ax-diff status="unchanged" />` or `+ Added / - Removed` lines).
- `find_elements`: Scores and returns up to 20 matching elements (`uid=...`) by natural-language query, role, or label.
- `get_page_text`: Extracts clean readable article/page text without DOM or script clutter.
- `browser_batch`: Runs an array of browser steps in a single MCP round-trip with short-circuiting on error.
- `browser_js`: Persistent Node VM REPL exposing `browser` and `tab` (`tab.ax.write()`, `tab.ax.click(uid)`, `tab.ax.setValue(uid, text)`, `tab.goto(url)`, `tab.eval(fn)`, `browser.user.openTabs()`).
- `browser_switch_profile`: Switches between `"main"` (default), `"cloned"` (APFS copy-on-write clone of main profile cookies/storage), and `"isolated"` (clean ephemeral profile).

### Zero-popup main browser bridge

In Chrome 136+, attaching an external CDP client to the default user profile triggers a blocking `"Allow remote debugging?"` modal dialog. In `"main"` mode, `antigravity-browser-mcp.js` communicates over a local UNIX domain socket (`~/.gemini/antigravity/browser-bridge.sock`) through `antigravity-browser-broker.cjs` and `antigravity-browser-native-host.cjs` to the **Antigravity Browser Bridge** Chrome extension (`extensions/antigravity-browser-extension/`), automating your live Chrome tabs with zero popups.

---

## 3. Apple Safari Browser Use MCP (`antigravity-safari-mcp.js`)

`antigravity-safari-mcp.js` provides an 18-tool native Safari harness combining two zero-popup macOS mechanisms:

1. **`Safari.sdef` AppleEvents / JXA (`Application("Safari")`)**: Lists all Safari windows/tabs, navigates (`tab.url = ...`), extracts readable text (`tab.text()`) and HTML (`tab.source()`), and synchronizes `window.currentTab` without stealing focus.
2. **WebKit `AXWebArea` + `antigravity-cua-native`**: Walks the live Safari accessibility hierarchy (`walkAxTree`), supports stateful snapshot diffing (`read_page`) and natural-language element search (`find_elements`), performs background `AXPress` / `AXValue` actuation, captures Safari window screenshots (`<= 1568px` JPEG), and provides a stateful `browser_js` REPL.
