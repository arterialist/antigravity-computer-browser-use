---
name: computer-use
description: Control local macOS applications and the desktop using background Accessibility tools, the stateful cua_repl JavaScript kernel, or full-screen display tools. Use whenever the user asks to interact with macOS apps, inspect windows, click UI elements, type text, paste rich HTML/Markdown, or automate desktop workflows.
---

# macOS computer use

The `computer-use` MCP server provides three ways to inspect and control macOS applications:

1. **Per-app background tools (`app_*`).** Operates inside a specific application window via `AXUIElement`, `CGWindowList`, and `SkyLight` without moving the user's cursor or stealing window focus. Works even when the target window is behind other apps or on another macOS Space.
2. **Stateful JavaScript REPL (`js` / `js_reset`).** Runs top-level `await` scripts with pre-loaded `sky` and `cua` bindings. Supports multi-step sequences in one turn, stateful Accessibility tree diffs, substring selection (`select_text`), and rich clipboard pasting (`paste` with `"html"`, `"md"`, or `"text"`).
3. **Full-screen display tools (`screenshot`, `zoom`, `left_click`, `computer_batch`, etc.).** Captures the entire display scaled to the 28x28 vision token budget and automatically steps out of the way when clicking coordinates covered by Antigravity.

## Choosing the right mode

Start with background per-app tools (`app_screenshot`, `app_click`, `app_type`, `app_key`, `app_menu`, `app_batch`) or the `js` REPL (`sky.get_app_state`, `sky.click`, `sky.set_value`, `sky.paste`) whenever you know which application you want to control. Background mode never interrupts the user's active focus.

Switch to full-screen display tools (`screenshot`, `zoom`, `left_click`, `left_click_drag`, `type`, `key`, `computer_batch`) when interacting with system dialogs, Mission Control, Spotlight, menu bar extras, or custom canvas UIs that ignore background events.

## Per-app background workflow (`app_*`)

1. Call `app_screenshot` with `app: "AppName"` (or its bundle ID from `list_apps`). This returns a JPEG screenshot of that window alongside an `<ax-summary>` listing interactive elements with `[element_index]` tags, roles, titles, values, supported actions, and window-relative coordinates.
2. Prefer passing `element_index` to `app_click`, `app_type`, or `app_scroll` over raw coordinates. Element targeting acts directly on the `AXUIElement` reference even when the window is on another macOS Space.
3. On subsequent `app_screenshot` calls for the same window, `<ax-summary>` returns a compact diff of added, updated, or removed elements. Pass `disable_diff: true` only when you need the full unfiltered tree.
4. Use `app_batch` to run a sequence of background clicks, text entry, and key presses in a single turn.
5. Use `app_menu` with `path: ["Menu", "Item"]` to trigger menu bar commands in the background without opening visible dropdown menus.

## Stateful JavaScript REPL workflow (`js`)

Use the `js` tool when you want to chain multiple operations, inspect or filter the Accessibility tree in code, select specific substrings inside an editable field, or paste rich HTML content.

```javascript
const state = await sky.get_app_state({ app: "Notes" });
nodeRepl.write(state.text);
```

Available methods on `globalThis.sky`:

- `await sky.list_apps()` and `await sky.list_windows()`
- `await sky.get_app_state({ app, disableDiff? })`
- `await sky.click({ app, element_index?, x?, y?, mouse_button?, click_count? })`
- `await sky.set_value({ app, element_index, value })`
- `await sky.select_text({ app, element_index, text, prefix?, suffix?, selection_type?: "text" | "cursor_before" | "cursor_after" })`
- `await sky.perform_secondary_action({ app, element_index, action })`
- `await sky.paste({ app, text, format: "text" | "md" | "html" })`
- `await sky.press_key({ app, key })`
- `await sky.type_text({ app, text })`
- `await sky.scroll({ app, element_index?, x?, y?, direction: "up" | "down" | "left" | "right", pages? })`
- `await sky.drag({ app, from_x, from_y, to_x, to_y })`

To emit a window screenshot back to the model from inside `js`:

```javascript
const fs = await import("node:fs/promises");
const { fileURLToPath } = await import("node:url");
const state = await sky.get_app_state({ app: "Safari" });
if (state.screenshot) {
  await nodeRepl.emitImage({
    bytes: await fs.readFile(fileURLToPath(state.screenshot.url)),
    mimeType: "image/jpeg"
  });
}
```

## Full-screen display workflow

1. Call `screenshot` to capture the active display. Note the `coordinate frame: WxH` reported in the text output (computed via the 28x28 tile vision token budget, such as `1372x887` on a 16-inch Retina display).
2. For small UI controls or dense text, call `zoom` with `region: [x0, y0, x1, y1]` in the full-screen coordinate frame to inspect a native Retina crop. Subsequent click coordinates still use the full-screen coordinate frame.
3. Group predictable multi-step sequences (such as clicking a field, typing text, and pressing Return) into a single `computer_batch` call to save turns.
4. Physical `Escape` on the keyboard immediately aborts any running action, drag, typing sequence, or batch.
