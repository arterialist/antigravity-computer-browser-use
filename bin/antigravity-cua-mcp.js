#!/usr/bin/env node
/**
 * Antigravity Computer Use MCP Server (antigravity-cua-mcp.js)
 *
 * Provides 43 macOS desktop & application automation tools:
 * 1. Display-scope tools: request_access, screenshot, zoom, left_click, double_click,
 *    triple_click, right_click, middle_click, left_click_drag (60fps cubic ease-out),
 *    mouse_move, left_mouse_down, left_mouse_up, scroll, type (clipboard fast-path +
 *    grapheme pacing), key, hold_key, wait, cursor_position, open_application,
 *    switch_display, list_apps, read_clipboard, write_clipboard, computer_batch.
 * 2. Per-app background tools (AXUIElement + CGWindowList):
 *    app_list_windows, app_screenshot (with <ax-summary>), app_ax_find, app_click,
 *    app_type, app_key, app_scroll, app_drag, app_menu, app_bring_to_current_space,
 *    app_move_to_display, app_batch, app_release.
 * 3. Stateful JavaScript REPL & Accessibility primitives:
 *    js, js_reset, sky_select_text, sky_perform_secondary_action, sky_paste, teach_step.
 *    Includes 28x28 tile vision token budget binary search (maxTargetPx=1568, maxTargetTokens=1568),
 *    SoMInvalidationObserver AX caching, AdaptiveSettleEngine, and desktop HUD overlay
 *    via `antigravity-cua-native`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { spawn, execFileSync } = require('child_process');

// ============================================================================
// 1. Native Helper Process Discovery (`antigravity-cua-native`)
// ============================================================================

const AGY_CUA_NATIVE_PATHS = [
  path.join(__dirname, 'antigravity-cua-native'),
  path.join(os.homedir(), '.gemini/bin/antigravity-cua-native')
];

// JSON-RPC Stdio Helper Manager (for `antigravity-cua-native`)
class StdioJsonRpcHelper {
  constructor(binaryPaths, name) {
    this.binaryPath = binaryPaths.find(p => fs.existsSync(p)) || null;
    this.binaryMtimeMs = 0;
    this.name = name;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
  }

  ensureSpawned() {
    if (this.binaryPath && fs.existsSync(this.binaryPath)) {
      try {
        const mtime = fs.statSync(this.binaryPath).mtimeMs;
        if (this.proc && !this.proc.killed && this.binaryMtimeMs && mtime > this.binaryMtimeMs) {
          try { this.proc.kill(); } catch (_) {}
          this.proc = null;
        }
        this.binaryMtimeMs = mtime;
      } catch (_) {}
    }
    if (this.proc && !this.proc.killed) return true;
    if (!this.binaryPath) return false;
    try {
      this.proc = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      if (this.proc.unref) this.proc.unref();
      this.proc.stdout.on('data', (chunk) => {
        this.buf += chunk.toString('utf8');
        const lines = this.buf.split('\n');
        this.buf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.id && this.pending.has(msg.id)) {
              const { resolve, reject, timer } = this.pending.get(msg.id);
              clearTimeout(timer);
              this.pending.delete(msg.id);
              if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              else resolve(msg.result);
            }
          } catch (_) {}
        }
      });
      this.proc.on('exit', () => {
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(new Error(`${this.name} exited`));
        }
        this.pending.clear();
        this.proc = null;
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  call(method, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.ensureSpawned()) {
        return reject(new Error(`${this.name} binary not available`));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}.${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
}

const agyNativeHelper = new StdioJsonRpcHelper(AGY_CUA_NATIVE_PATHS, 'antigravity-cua-native');

// ============================================================================
// 2. Vision Token Budget & Coordinate Scaling Math (28x28 Tile Formula)
// ============================================================================

const VISION_BUDGET = {
  pxPerToken: 28,
  maxTargetPx: 1568,
  maxTargetTokens: 1568
};

function tilesOnAxis(px, pxPerToken = 28) {
  return Math.floor((px - 1) / pxPerToken) + 1;
}

function imageTokens(w, h, pxPerToken = 28) {
  return tilesOnAxis(w, pxPerToken) * tilesOnAxis(h, pxPerToken);
}

/**
 * Binary search for the largest integer [width, height] preserving aspect ratio
 * such that width <= 1568, height <= 1568, and ceil(w/28)*ceil(h/28) <= 1568 tokens.
 */
function computeTargetDimensions(physW, physH, gen = VISION_BUDGET) {
  if (physW <= 0 || physH <= 0) return [1024, 768];
  if (physW < physH) {
    const [h, w] = computeTargetDimensions(physH, physW, gen);
    return [w, h];
  }
  const aspect = physW / physH;
  let lo = 1;
  let hi = Math.min(physW, gen.maxTargetPx);
  let bestW = 1;
  let bestH = 1;
  while (lo <= hi) {
    const midW = (lo + hi) >> 1;
    const midH = Math.max(Math.round(midW / aspect), 1);
    if (midW <= gen.maxTargetPx && midH <= gen.maxTargetPx && imageTokens(midW, midH, gen.pxPerToken) <= gen.maxTargetTokens) {
      bestW = midW;
      bestH = midH;
      lo = midW + 1;
    } else {
      hi = midW - 1;
    }
  }
  return [bestW, bestH];
}

// ============================================================================
// 3. Session State, Safety Policy, & Telemetry Synchronization
// ============================================================================

const HOST_BUNDLE_IDS = [
  'com.google.antigravity',
  'com.google.antigravity.helper'
];

const session = {
  selectedDisplayId: undefined,
  coordinateMode: 'pixels', // 'pixels' | 'normalized_1000' | 'normalized_100'
  lastScreenshot: null,     // { width, height, frameWidth, frameHeight, displayWidth, displayHeight, originX, originY, displayId, scale, buffer }
  appSnapshots: new Map(),  // key: `${bundleId}:${windowId || 'main'}` -> { resolvedWindowId, width, height, windowBounds, axSummary, formattedTree, lastActionTime }
  allowedApps: new Map(),   // bundleId -> { bundleId, displayName, tier: 'full' | 'click' | 'read' }
  grantFlags: {
    clipboardRead: true,
    clipboardWrite: true,
    systemKeyCombos: true
  },
  excludeAntigravityFromScreenshots: process.env.ANTIGRAVITY_CUA_EXCLUDE_IDE !== '0',
  autoGhostAntigravityWindow: process.env.ANTIGRAVITY_CUA_AUTO_GHOST !== '0',
  desktopOverlayEnabled: process.env.ANTIGRAVITY_CUA_HUD !== '0',
  mouseDownHeld: false,
  aborted: false,
  lastActionTimestamp: 0,
  replContext: null,
  metrics: {
    actionsExecuted: 0,
    screenshotsCaptured: 0,
    backgroundAxActions: 0,
    backgroundRawActions: 0,
    displayActions: 0,
    replExecutions: 0
  }
};

// Escape hotkey tap: ONLY active while a computer use tool is executing
let activeActionDepth = 0;
let escapeRegistered = false;

function acquireEscapeTrap() {
  activeActionDepth++;
  if (activeActionDepth === 1) {
    session.aborted = false;
  }
}

function releaseEscapeTrap() {
  activeActionDepth = Math.max(0, activeActionDepth - 1);
}

function cleanupEscapeTrap() {}

process.on('exit', cleanupEscapeTrap);
process.on('SIGINT', () => { cleanupEscapeTrap(); process.exit(0); });
process.on('SIGTERM', () => { cleanupEscapeTrap(); process.exit(0); });

const CUA_TRACE_LOG = process.env.ANTIGRAVITY_CUA_TRACE_LOG || path.join(os.tmpdir(), 'antigravity-cua-trace.jsonl');

function appendCuaTrace(entry) {
  const full = {
    ts: new Date().toISOString(),
    epochMs: Date.now(),
    pid: process.pid,
    selectedDisplayId: session.selectedDisplayId ?? null,
    ...entry
  };
  if (!Array.isArray(session.traceRing)) session.traceRing = [];
  session.traceRing.push(full);
  if (session.traceRing.length > 200) session.traceRing.shift();
  try {
    fs.appendFileSync(CUA_TRACE_LOG, JSON.stringify(full) + '\n');
  } catch (_) {}
}

function recordCuaEvent(eventPayload) {
  appendCuaTrace({
    kind: 'cua_event',
    ...eventPayload,
    metrics: session.metrics
  });
}

function triggerDesktopOverlay(mode, label, x, y, tooltip, durationMs = 2800, cursorLabel = undefined, isClick = true) {
  if (!session.desktopOverlayEnabled) return;
  agyNativeHelper.call('showOverlay', {
    mode,
    label,
    cursorLabel: cursorLabel || undefined,
    x: typeof x === 'number' ? x : undefined,
    y: typeof y === 'number' ? y : undefined,
    isClick: Boolean(isClick),
    tooltip: tooltip || undefined,
    durationMs
  }, 1500).catch(() => {});
}

// ============================================================================
// 4. App Resolution, Display Geometry, & Coordinate Conversion
// ============================================================================

function resolveAppIdentifier(appInput) {
  if (!appInput || typeof appInput !== 'string') {
    throw new Error('app identifier must be a non-empty string');
  }
  const clean = appInput.trim();
  const commonMap = {
    'finder': 'com.apple.finder',
    'safari': 'com.apple.Safari',
    'google chrome': 'com.google.Chrome',
    'chrome': 'com.google.Chrome',
    'terminal': 'com.apple.Terminal',
    'iterm': 'com.googlecode.iterm2',
    'iterm2': 'com.googlecode.iterm2',
    'notes': 'com.apple.Notes',
    'calendar': 'com.apple.iCal',
    'messages': 'com.apple.MobileSMS',
    'mail': 'com.apple.mail',
    'music': 'com.apple.Music',
    'spotify': 'com.spotify.client',
    'slack': 'com.tinyspeck.slackmacgap',
    'notion': 'notion.id',
    'calculator': 'com.apple.calculator',
    'system settings': 'com.apple.systempreferences',
    'system preferences': 'com.apple.systempreferences',
    'clock': 'com.apple.clock',
    'textedit': 'com.apple.TextEdit',
    'text edit': 'com.apple.TextEdit',
    'preview': 'com.apple.Preview',
    'reminders': 'com.apple.reminders',
    'numbers': 'com.apple.iWork.Numbers',
    'pages': 'com.apple.iWork.Pages',
    'keynote': 'com.apple.iWork.Keynote'
  };
  const mapped = commonMap[clean.toLowerCase()];
  if (mapped) return { bundleId: mapped, displayName: clean };
  return { bundleId: clean, displayName: clean };
}

function getDisplayGeometry(displayId) {
  return { width: 1728, height: 1117, scaleFactor: 2, displayId: displayId ? Number(displayId) : 1, originX: 0, originY: 0 };
}

async function listAllPhysicalDisplays() {
  try {
    const res = await agyNativeHelper.call('listDisplays', {}, 2000);
    if (res && res.ok && Array.isArray(res.displays) && res.displays.length > 0) {
      return res.displays.map(d => {
        const [fw, fh] = computeTargetDimensions(d.physicalWidth || d.width * 2, d.physicalHeight || d.height * 2, VISION_BUDGET);
        return {
          ...d,
          coordinateFrame: { width: fw, height: fh },
          isSelected: session.selectedDisplayId ? (d.displayId === session.selectedDisplayId) : Boolean(d.isMain)
        };
      });
    }
  } catch (_) {}
  const fallback = [getDisplayGeometry(session.selectedDisplayId)];
  return fallback.map((d, idx) => {
    const [fw, fh] = computeTargetDimensions(Math.round(d.width * (d.scaleFactor || 2)), Math.round(d.height * (d.scaleFactor || 2)), VISION_BUDGET);
    return {
      index: idx,
      displayId: d.displayId || idx + 1,
      label: d.label || `Display ${idx + 1}`,
      originX: d.originX || 0,
      originY: d.originY || 0,
      width: d.width,
      height: d.height,
      scaleFactor: d.scaleFactor || 2,
      coordinateFrame: { width: fw, height: fh },
      isSelected: session.selectedDisplayId ? (d.displayId === session.selectedDisplayId) : idx === 0
    };
  });
}

function parseCoordinateInput(args, fieldName = 'coordinate') {
  if (Array.isArray(args[fieldName]) && args[fieldName].length === 2) {
    const [x, y] = args[fieldName];
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
      return [x, y];
    }
  }
  if (typeof args.x === 'number' && typeof args.y === 'number' && fieldName === 'coordinate') {
    return [args.x, args.y];
  }
  throw new Error(`${fieldName} must be [x, y] numbers`);
}

/**
 * Maps model coordinate [x, y] to macOS logical global screen point { x, y }.
 * Supports:
 * - 'pixels' (default, relative to lastScreenshot.frameWidth x frameHeight)
 * - 'normalized_1000' (0..1000 normalized coordinate space)
 * - 'normalized_100' (0..100 percentage coordinate space)
 */
function mapToScreenPoint(rawX, rawY, modeOverride) {
  const disp = getDisplayGeometry(session.selectedDisplayId);
  const last = session.lastScreenshot;
  const mode = modeOverride || session.coordinateMode || 'pixels';

  if (mode === 'screen' || mode === 'global' || mode === 'logical') {
    return {
      x: Math.round(rawX),
      y: Math.round(rawY)
    };
  }

  const originX = (last ? last.originX : disp.originX) || 0;
  const originY = (last ? last.originY : disp.originY) || 0;
  const dispW = (last ? last.displayWidth : disp.width) || disp.width;
  const dispH = (last ? last.displayHeight : disp.height) || disp.height;

  // If rawY is negative (e.g. external display positioned above main display) while originY is 0,
  // treat as direct global logical coordinates rather than clamping to the main display top edge (y=0).
  if (rawY < 0 && originY >= 0) {
    return {
      x: Math.round(rawX),
      y: Math.round(rawY)
    };
  }

  if (mode === 'normalized_1000') {
    const sx = Math.round((rawX / 1000) * dispW) + originX;
    const sy = Math.round((rawY / 1000) * dispH) + originY;
    return {
      x: Math.max(originX, Math.min(originX + dispW - 1, sx)),
      y: Math.max(originY, Math.min(originY + dispH - 1, sy))
    };
  }
  if (mode === 'normalized_100') {
    const sx = Math.round((rawX / 100) * dispW) + originX;
    const sy = Math.round((rawY / 100) * dispH) + originY;
    return {
      x: Math.max(originX, Math.min(originX + dispW - 1, sx)),
      y: Math.max(originY, Math.min(originY + dispH - 1, sy))
    };
  }

  if (last && (last.frameWidth || last.width) && (last.frameHeight || last.height)) {
    const fw = last.frameWidth || last.width;
    const fh = last.frameHeight || last.height;
    const sx = Math.round(rawX * (dispW / fw)) + originX;
    const sy = Math.round(rawY * (dispH / fh)) + originY;
    return {
      x: Math.max(originX, Math.min(originX + dispW - 1, sx)),
      y: Math.max(originY, Math.min(originY + dispH - 1, sy))
    };
  }

  const scale = disp.scaleFactor || 2;
  return {
    x: Math.round(rawX / scale) + originX,
    y: Math.round(rawY / scale) + originY
  };
}

function mapScreenPointToImage(screenX, screenY) {
  const disp = getDisplayGeometry(session.selectedDisplayId);
  const last = session.lastScreenshot;
  if (!last) {
    return { x: screenX, y: screenY, coordinateSpace: 'logical_points' };
  }
  const fw = last.frameWidth || last.width;
  const fh = last.frameHeight || last.height;
  const dispW = last.displayWidth || disp.width;
  const dispH = last.displayHeight || disp.height;
  const ox = last.originX || 0;
  const oy = last.originY || 0;
  return {
    x: Math.round((screenX - ox) * (fw / dispW)),
    y: Math.round((screenY - oy) * (fh / dispH)),
    coordinateSpace: 'image_pixels'
  };
}

// ============================================================================
// 5. Safety Guards & Antigravity Window Auto-Ghosting
// ============================================================================

async function ensureTargetNotOccludedByAntigravity(screenX, screenY) {
  if (!session.autoGhostAntigravityWindow) return;
  try {
    const hit = await agyNativeHelper.call('appUnderPoint', { x: screenX, y: screenY }, 1000);
    if (hit && hit.bundleId && HOST_BUNDLE_IDS.includes(hit.bundleId)) {
      recordCuaEvent({ type: 'window_ghost', x: screenX, y: screenY });
      await agyNativeHelper.call('moveAppBehind', { bundleId: hit.bundleId }, 1000).catch(() => {});
      await sleep(35);
    }
  } catch (_) {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// 6. Display-Scope Execution Primitives
// ============================================================================

async function captureDisplayScreenshot(options = {}) {
  const scale = (typeof options.scale === 'number' && options.scale >= 0.1 && options.scale <= 1.0)
    ? options.scale
    : 1.0;
  const requestedDisplay = options.display !== undefined ? options.display : session.selectedDisplayId;
  const allDisplays = await listAllPhysicalDisplays();
  let disp = getDisplayGeometry(requestedDisplay);
  if (requestedDisplay !== undefined && allDisplays.length > 0) {
    const q = String(requestedDisplay).toLowerCase().trim();
    const matched = allDisplays.find((d, idx) =>
      String(d.displayId) === q ||
      String(idx) === q ||
      (d.label || '').toLowerCase() === q ||
      (d.label || '').toLowerCase().includes(q)
    );
    if (matched) disp = matched;
  }
  const targetDisplayId = requestedDisplay !== undefined ? (disp.displayId || undefined) : undefined;
  const screenIndexOneBased = (typeof disp.index === 'number' ? disp.index : 0) + 1;
  const physW = Math.round(disp.width * (disp.scaleFactor || 2));
  const physH = Math.round(disp.height * (disp.scaleFactor || 2));
  const [frameWidth, frameHeight] = computeTargetDimensions(physW, physH, VISION_BUDGET);
  const imgW = Math.max(1, Math.round(frameWidth * scale));
  const imgH = Math.max(1, Math.round(frameHeight * scale));

  let base64Data = null;
  let actualW = imgW;
  let actualH = imgH;
  let originX = disp.originX || 0;
  let originY = disp.originY || 0;
  let displayW = disp.width;
  let displayH = disp.height;
  let displayId = targetDisplayId || disp.displayId || 1;
  let dHash = null;
  let lumaDelta = null;
  let unchanged = false;

  try {
    const fastShot = await agyNativeHelper.call('captureDisplayFast', {
      displayId,
      width: imgW,
      height: imgH,
      quality: 0.76
    }, 1500);
    if (fastShot && fastShot.ok && fastShot.base64) {
      base64Data = fastShot.base64;
      actualW = fastShot.width || imgW;
      actualH = fastShot.height || imgH;
      originX = fastShot.originX ?? originX;
      originY = fastShot.originY ?? originY;
      displayW = fastShot.displayWidth || displayW;
      displayH = fastShot.displayHeight || displayH;
      displayId = fastShot.displayId || displayId;
      dHash = fastShot.dHash || null;
      lumaDelta = fastShot.lumaDelta ?? null;
      unchanged = Boolean(fastShot.unchanged);
    }
  } catch (_) {}

  // Fallback to macOS `screencapture` CLI (with `-D <screenIndex>` for secondary physical displays)
  if (!base64Data) {
    const tmpFile = path.join(os.tmpdir(), `agy-cua-shot-${Date.now()}.jpg`);
    execFileSync('/usr/sbin/screencapture', ['-x', '-C', '-D', String(screenIndexOneBased), '-t', 'jpg', tmpFile]);
    execFileSync('/usr/bin/sips', ['-z', String(imgH), String(imgW), tmpFile], { stdio: 'ignore' });
    base64Data = fs.readFileSync(tmpFile).toString('base64');
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }

  session.lastScreenshot = {
    width: actualW,
    height: actualH,
    frameWidth,
    frameHeight,
    displayWidth: displayW,
    displayHeight: displayH,
    originX,
    originY,
    displayId,
    scale,
    dHash,
    lumaDelta,
    unchanged,
    timestamp: Date.now()
  };
  session.metrics.screenshotsCaptured++;
  recordCuaEvent({
    type: 'screenshot',
    mode: 'display',
    frameWidth,
    frameHeight,
    scale
  });

  let savedPath = null;
  if (options.save_to_disk) {
    savedPath = path.join(os.tmpdir(), `antigravity-screenshot-${Date.now()}.jpg`);
    fs.writeFileSync(savedPath, Buffer.from(base64Data, 'base64'));
  }

  const notes = [];
  if (scale !== 1.0) {
    notes.push(`${scale}-scale view; coordinate frame: ${frameWidth}x${frameHeight}.`);
  } else {
    notes.push(`Coordinate frame: ${frameWidth}x${frameHeight} (logical display ${displayW}x${displayH}).`);
  }
  if (savedPath) {
    notes.push(`Saved to disk: ${savedPath}`);
  }

  return {
    content: [
      { type: 'text', text: notes.join(' ') },
      { type: 'image', data: base64Data, mimeType: 'image/jpeg' }
    ]
  };
}

async function captureZoomRegion(region, options = {}) {
  if (!Array.isArray(region) || region.length !== 4) {
    throw new Error('region must be [x0, y0, x1, y1]');
  }
  const [x0, y0, x1, y1] = region.map(Number);
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) {
    throw new Error('region [x0, y0, x1, y1] must satisfy 0 <= x0 < x1 and 0 <= y0 < y1');
  }
  const scale = (typeof options.scale === 'number' && options.scale >= 0.1 && options.scale <= 1.0)
    ? options.scale
    : 1.0;

  const disp = getDisplayGeometry(session.selectedDisplayId);
  const last = session.lastScreenshot || {
    frameWidth: computeTargetDimensions(Math.round(disp.width * disp.scaleFactor), Math.round(disp.height * disp.scaleFactor))[0],
    frameHeight: computeTargetDimensions(Math.round(disp.width * disp.scaleFactor), Math.round(disp.height * disp.scaleFactor))[1],
    displayWidth: disp.width,
    displayHeight: disp.height
  };

  // Convert region from screenshot frame coordinates into logical display points
  const scaleX = last.displayWidth / last.frameWidth;
  const scaleY = last.displayHeight / last.frameHeight;
  const regX = Math.round(x0 * scaleX);
  const regY = Math.round(y0 * scaleY);
  const regW = Math.max(1, Math.round((x1 - x0) * scaleX));
  const regH = Math.max(1, Math.round((y1 - y0) * scaleY));

  const [targetW, targetH] = computeTargetDimensions(
    Math.round(regW * (disp.scaleFactor || 2)),
    Math.round(regH * (disp.scaleFactor || 2)),
    VISION_BUDGET
  );
  const outW = Math.max(1, Math.round(targetW * scale));
  const outH = Math.max(1, Math.round(targetH * scale));

  let shot = null;
  const tmpFile = path.join(os.tmpdir(), `agy-zoom-${Date.now()}.jpg`);
  try {
    const gx = (disp.originX || 0) + regX;
    const gy = (disp.originY || 0) + regY;
    execFileSync('/usr/sbin/screencapture', ['-x', '-R', `${gx},${gy},${regW},${regH}`, '-t', 'jpg', tmpFile]);
    execFileSync('/usr/bin/sips', ['-z', String(outH), String(outW), tmpFile], { stdio: 'ignore' });
    shot = { base64: fs.readFileSync(tmpFile).toString('base64') };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }

  session.metrics.screenshotsCaptured++;
  let savedPath = null;
  if (options.save_to_disk && shot && shot.base64) {
    savedPath = path.join(os.tmpdir(), `antigravity-zoom-${Date.now()}.jpg`);
    fs.writeFileSync(savedPath, Buffer.from(shot.base64, 'base64'));
  }

  return {
    content: [
      {
        type: 'text',
        text: `Zoomed region [${x0}, ${y0}, ${x1}, ${y1}] (${outW}x${outH} px). Subsequent click coordinates still refer to the full-screen coordinate frame (${last.frameWidth}x${last.frameHeight}).${savedPath ? ' Saved to ' + savedPath : ''}`
      },
      { type: 'image', data: shot.base64, mimeType: 'image/jpeg' }
    ]
  };
}

// Normalize key names across macOS and X11 key chord conventions ("cmd+shift+a", "Super_L+c", "Return", "KP_0")
const KEY_ALIASES = {
  'return': 'return',
  'enter': 'return',
  'kp_enter': 'return',
  'escape': 'escape',
  'esc': 'escape',
  'tab': 'tab',
  'space': 'space',
  'backspace': 'backspace',
  'delete': 'delete',
  'up': 'up',
  'down': 'down',
  'left': 'left',
  'right': 'right',
  'home': 'home',
  'end': 'end',
  'page_up': 'pageup',
  'pageup': 'pageup',
  'prior': 'pageup',
  'page_down': 'pagedown',
  'pagedown': 'pagedown',
  'next': 'pagedown',
  'super_l': 'command',
  'super_r': 'command',
  'super': 'command',
  'meta_l': 'command',
  'meta_r': 'command',
  'meta': 'command',
  'cmd': 'command',
  'command': 'command',
  'win': 'command',
  'windows': 'command',
  'control_l': 'control',
  'control_r': 'control',
  'ctrl': 'control',
  'control': 'control',
  'alt_l': 'alt',
  'alt_r': 'alt',
  'alt': 'alt',
  'option': 'alt',
  'shift_l': 'shift',
  'shift_r': 'shift',
  'shift': 'shift',
  'period': '.',
  'comma': ',',
  'slash': '/',
  'backslash': '\\',
  'minus': '-',
  'equal': '=',
  'plus': '+',
  'kp_0': '0',
  'kp_1': '1',
  'kp_2': '2',
  'kp_3': '3',
  'kp_4': '4',
  'kp_5': '5',
  'kp_6': '6',
  'kp_7': '7',
  'kp_8': '8',
  'kp_9': '9'
};

function parseKeyChord(chordStr) {
  if (!chordStr || typeof chordStr !== 'string') {
    throw new Error('key chord must be a non-empty string');
  }
  const parts = chordStr
    .split('+')
    .map(s => s.trim())
    .filter(Boolean)
    .map(k => KEY_ALIASES[k.toLowerCase()] || k.toLowerCase());
  if (parts.length === 0) throw new Error('key chord is empty');
  if (parts.length > 8) throw new Error(`key chord has ${parts.length} keys; maximum is 8`);
  return parts;
}

async function performDisplayClick(button, count, rawCoord, modifierText, coordinateMode) {
  session.aborted = false;
  if (session.mouseDownHeld) {
    try { await agyNativeHelper.call('cgEventInput', { op: 'mouseUp', button: 'left' }); } catch (_) {}
    session.mouseDownHeld = false;
  }
  const { x: screenX, y: screenY } = mapToScreenPoint(rawCoord[0], rawCoord[1], coordinateMode);

  // Check if Antigravity window is occluding this point
  await ensureTargetNotOccludedByAntigravity(screenX, screenY);

  let hitApp = null;
  try {
    hitApp = await agyNativeHelper.call('appUnderPoint', { x: screenX, y: screenY }, 800);
  } catch (_) {}

  const appLabel = hitApp?.displayName || hitApp?.bundleId || 'Desktop';
  triggerDesktopOverlay(
    'display',
    `Antigravity Agent · ${button} click (${screenX}, ${screenY})`,
    screenX,
    screenY,
    undefined,
    2800,
    `${appLabel} · Click`,
    true
  );

  const mods = modifierText && modifierText.trim() ? parseKeyChord(modifierText) : [];
  await agyNativeHelper.call('cgEventInput', { op: 'move', x: screenX, y: screenY });
  await sleep(40);
  await agyNativeHelper.call('cgEventInput', { op: 'click', x: screenX, y: screenY, button, count, modifiers: mods });

  session.lastActionTimestamp = Date.now();
  session.metrics.actionsExecuted++;
  session.metrics.displayActions++;
  recordCuaEvent({
    type: 'action',
    mode: 'display',
    action: `${button}_click_${count}x`,
    coordinate: [screenX, screenY],
    targetApp: appLabel
  });
  return { screenX, screenY, hitApp };
}

async function performDisplayDrag(startCoord, endCoord, coordinateMode) {
  session.aborted = false;
  const endPt = mapToScreenPoint(endCoord[0], endCoord[1], coordinateMode);
  let currentMouse = endPt;
  if (!startCoord) {
    try {
      const loc = await agyNativeHelper.call('mouseLocation', {});
      if (loc && loc.ok) currentMouse = { x: loc.x, y: loc.y };
    } catch (_) {}
  }
  const startPt = startCoord
    ? mapToScreenPoint(startCoord[0], startCoord[1], coordinateMode)
    : currentMouse;

  await ensureTargetNotOccludedByAntigravity(startPt.x, startPt.y);
  triggerDesktopOverlay(
    'display',
    `Antigravity Agent · Drag (${startPt.x},${startPt.y}) -> (${endPt.x},${endPt.y})`,
    endPt.x,
    endPt.y,
    undefined,
    2800,
    `Drag -> (${endPt.x}, ${endPt.y})`,
    true
  );

  let actualCursorAfter = null;
  await agyNativeHelper.call('cgEventInput', { op: 'move', x: startPt.x, y: startPt.y });
  await sleep(50);
  await agyNativeHelper.call('cgEventInput', { op: 'mouseDown', button: 'left', x: startPt.x, y: startPt.y });
  await sleep(50);
  try {
    // 60 FPS cubic ease-out interpolation
    const dx = endPt.x - startPt.x;
    const dy = endPt.y - startPt.y;
    const dist = Math.hypot(dx, dy);
    const durationSec = Math.min(dist / 2000, 0.5);
    const steps = Math.max(1, Math.round(durationSec * 60));
    const stepDelayMs = Math.round(1000 / 60);
    for (let i = 1; i <= steps; i++) {
      if (session.aborted) throw new Error('Drag aborted by user (Escape)');
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 3);
      const cx = Math.round(startPt.x + dx * ease);
      const cy = Math.round(startPt.y + dy * ease);
      await agyNativeHelper.call('cgEventInput', { op: 'move', x: cx, y: cy });
      if (i < steps) await sleep(stepDelayMs);
    }
    await sleep(50);
    try {
      const loc = await agyNativeHelper.call('mouseLocation', {});
      if (loc && loc.ok) actualCursorAfter = { x: loc.x, y: loc.y };
    } catch (_) {}
  } finally {
    try {
      await agyNativeHelper.call('cgEventInput', { op: 'mouseUp', button: 'left', x: endPt.x, y: endPt.y });
    } catch (_) {}
  }

  session.lastActionTimestamp = Date.now();
  session.metrics.actionsExecuted++;
  session.metrics.displayActions++;
  const traceInfo = {
    type: 'action',
    mode: 'display',
    action: 'left_click_drag',
    rawStart: startCoord || null,
    rawEnd: endCoord,
    coordinateMode: coordinateMode || session.coordinateMode || 'pixels',
    mappedStart: startPt,
    mappedEnd: endPt,
    actualCursorAfter
  };
  recordCuaEvent(traceInfo);
  return traceInfo;
}

async function performDisplayType(text) {
  session.aborted = false;

  // Multi-line clipboard fast-path
  if (text.includes('\n') && session.grantFlags.clipboardWrite) {
    let prevClip = '';
    try {
      prevClip = execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8' });
    } catch (_) {}
    try {
      execFileSync('/usr/bin/pbcopy', [], { input: text, encoding: 'utf8' });
      const check = execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8' });
      if (check === text) {
        await agyNativeHelper.call('cgEventInput', { op: 'keys', keys: ['command', 'v'] });
        await sleep(100);
        session.lastActionTimestamp = Date.now();
        session.metrics.actionsExecuted++;
        session.metrics.displayActions++;
        return `Typed ${text.length} char(s) via clipboard fast-path.`;
      }
    } finally {
      try { execFileSync('/usr/bin/pbcopy', [], { input: prevClip, encoding: 'utf8' }); } catch (_) {}
    }
  }

  // Grapheme-by-grapheme paced typing
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const graphemes = Array.from(segmenter.segment(text), s => s.segment);

  for (let i = 0; i < graphemes.length; i++) {
    if (session.aborted) {
      throw new Error(`Typing aborted after ${i} of ${graphemes.length} graphemes (user Escape).`);
    }
    if (i > 0) await sleep(8);
    const g = graphemes[i];
    if (g === '\n' || g === '\r' || g === '\r\n') {
      await agyNativeHelper.call('cgEventInput', { op: 'keys', keys: ['return'] });
    } else if (g === '\t') {
      await agyNativeHelper.call('cgEventInput', { op: 'keys', keys: ['tab'] });
    } else {
      await agyNativeHelper.call('cgEventInput', { op: 'typeText', text: g });
    }
  }

  session.lastActionTimestamp = Date.now();
  session.metrics.actionsExecuted++;
  session.metrics.displayActions++;
  recordCuaEvent({ type: 'action', mode: 'display', action: 'type', length: graphemes.length });
  return `Typed ${graphemes.length} grapheme(s).`;
}

async function performDisplayKey(chordStr, repeat = 1) {
  session.aborted = false;
  const keys = parseKeyChord(chordStr);

  for (let i = 0; i < repeat; i++) {
    if (session.aborted) {
      throw new Error(`Key repeat aborted after ${i} of ${repeat} presses (user Escape).`);
    }
    if (i > 0) await sleep(8);
    await agyNativeHelper.call('cgEventInput', { op: 'keys', keys });
  }

  session.lastActionTimestamp = Date.now();
  session.metrics.actionsExecuted++;
  session.metrics.displayActions++;
  recordCuaEvent({ type: 'action', mode: 'display', action: 'key', key: chordStr, repeat });
}

// ============================================================================
// 7. Per-App Background Execution (`app_*` & `sky.*`)
// ============================================================================

function formatAxElementLine(node, idx, windowBounds) {
  const relX = Math.round(node.x - (windowBounds?.x || 0));
  const relY = Math.round(node.y - (windowBounds?.y || 0));
  const w = Math.round(node.w || 0);
  const h = Math.round(node.h || 0);
  const titleStr = node.title ? String(node.title).slice(0, 120) : '';
  const valStr = node.value !== undefined && node.value !== null ? String(node.value).slice(0, 80) : '';
  const titlePart = titleStr ? ` ${JSON.stringify(titleStr)}` : '';
  const subrolePart = node.subrole ? ` (${node.subrole})` : '';
  const valuePart = (valStr && valStr !== titleStr) ? ` value=${JSON.stringify(valStr)}` : '';
  let actions = Array.isArray(node.actions) ? node.actions : [];
  if ((node.role === 'AXButton' || node.role === 'AXLink') && actions.length === 1 && actions[0] === 'AXPress') {
    actions = [];
  }
  const actionsPart = actions.length > 0 ? ` actions=[${actions.join(',')}]` : '';
  return `[${idx}] ${node.role}${subrolePart}${titlePart}${valuePart}${actionsPart} @ (${relX}, ${relY}, ${w}x${h})`;
}

/**
 * Computes a stateful Accessibility Tree Diff between the previous AX snapshot
 * and current AX snapshot for an app window.
 */
function formatAxTreeWithOptionalDiff(axSummary, windowBounds, prevFormattedLines, disableDiff) {
  const currentLines = (axSummary || []).map((n, i) => formatAxElementLine(n, i, windowBounds));
  if (disableDiff || !prevFormattedLines || prevFormattedLines.length === 0) {
    return {
      text: `<ax-summary count="${currentLines.length}" mode="full">\n${currentLines.join('\n')}\n</ax-summary>`,
      lines: currentLines,
      isDiff: false
    };
  }

  const prevSet = new Set(prevFormattedLines);
  const currSet = new Set(currentLines);
  const addedOrChanged = currentLines.filter(l => !prevSet.has(l));
  const removed = prevFormattedLines.filter(l => !currSet.has(l));

  if (addedOrChanged.length === 0 && removed.length === 0) {
    return {
      text: `<ax-summary count="${currentLines.length}" mode="diff">\n[No accessibility tree changes since previous state. All ${currentLines.length} element_index values remain unchanged.]\n</ax-summary>`,
      lines: currentLines,
      isDiff: true
    };
  }

  // If >75% of elements changed, return full tree for clarity
  if (addedOrChanged.length > currentLines.length * 0.75) {
    return {
      text: `<ax-summary count="${currentLines.length}" mode="full">\n${currentLines.join('\n')}\n</ax-summary>`,
      lines: currentLines,
      isDiff: false
    };
  }

  const diffParts = [];
  if (addedOrChanged.length > 0) {
    diffParts.push(`Added / Updated Elements (${addedOrChanged.length}):\n` + addedOrChanged.map(l => `+ ${l}`).join('\n'));
  }
  if (removed.length > 0) {
    diffParts.push(`Removed Elements (${removed.length}):\n` + removed.slice(0, 25).map(l => `- ${l}`).join('\n'));
  }
  return {
    text: `<ax-summary count="${currentLines.length}" mode="diff">\n${diffParts.join('\n\n')}\n</ax-summary>`,
    lines: currentLines,
    isDiff: true
  };
}

async function getAppsListWithFallback() {
  try {
    const res = await agyNativeHelper.call('listApps', {}, 2500);
    if (res && res.ok && Array.isArray(res.apps)) return res.apps;
  } catch (_) {}
  return [];
}

async function getAppWindowsWithFallback(bundleId) {
  try {
    const res = await agyNativeHelper.call('listWindows', { app: bundleId }, 2500);
    if (res && res.ok && Array.isArray(res.windows)) return res.windows;
  } catch (_) {}
  return [];
}

/**
 * Captures a single application's window in the background via CGWindowList/screencapture + AXUIElement.
 */
async function captureAppWindowState(appInput, options = {}) {
  let resolved = resolveAppIdentifier(appInput);
  let bundleId = resolved.bundleId;

  // Transparently launch the app in the background if not running
  const running = await getAppsListWithFallback();
  const isRunning = running.some(a => a.bundleId === bundleId);
  if (!isRunning && options.autoLaunch !== false) {
    try {
      execFileSync('/usr/bin/open', ['-g', '-b', bundleId]);
      await sleep(600);
    } catch (_) {}
  }

  // Adaptive UI settling via AXObserver epoch instead of fixed sleep
  const sinceLastAction = Date.now() - session.lastActionTimestamp;
  const settleWaitMs = (sinceLastAction < 250 && options.waitForSettle !== false) ? 90 : 0;
  const skipImage = Boolean(options.skipImage || options.text_only);

  const wins = await getAppWindowsWithFallback(bundleId);
  let targetWin = null;
  if (typeof options.window_id === 'number') {
    targetWin = wins.find(w => w.windowId === options.window_id);
  }
  if (!targetWin) {
    targetWin = wins.find(w => w.isMain && !w.isMinimized) || wins.find(w => !w.isMinimized) || wins[0];
  }

  const winId = targetWin ? targetWin.windowId : options.window_id;

  const disp = getDisplayGeometry(session.selectedDisplayId);
  const scale = (typeof options.scale === 'number' && options.scale >= 0.1 && options.scale <= 1.0)
    ? options.scale
    : 1.0;
  const winW = targetWin?.bounds?.w || disp.width;
  const winH = targetWin?.bounds?.h || disp.height;
  const [frameW, frameH] = computeTargetDimensions(
    Math.round(winW * (disp.scaleFactor || 2)),
    Math.round(winH * (disp.scaleFactor || 2)),
    VISION_BUDGET
  );
  const maxW = Math.max(1, Math.round(frameW * scale));
  const maxH = Math.max(1, Math.round(frameH * scale));

  let shot = {
    resolvedWindowId: winId || 0,
    width: maxW,
    height: maxH,
    windowBounds: targetWin?.bounds || { x: 0, y: 0, w: winW, h: winH },
    axSummary: [],
    base64: null
  };

  // Run native AX tree walk (with adaptive settle + cached epoch fast-path) concurrently with screenshot capture
  const nativeAxPromise = agyNativeHelper.call('walkAxTree', {
    app: bundleId,
    maxNodes: 250,
    settleWaitMs
  }, 2500).catch(() => null);

  if (!skipImage) {
    if (winId) {
      try {
        const fastWin = await agyNativeHelper.call('captureWindowFast', {
          windowId: winId,
          width: maxW,
          height: maxH,
          quality: 0.76
        }, 1200);
        if (fastWin && fastWin.ok && fastWin.base64) {
          shot.base64 = fastWin.base64;
          shot.width = fastWin.width || maxW;
          shot.height = fastWin.height || maxH;
          shot.dHash = fastWin.dHash;
          shot.lumaDelta = fastWin.lumaDelta;
          shot.unchanged = fastWin.unchanged;
        }
      } catch (_) {}
    }
    if (!shot.base64 && winId) {
      try {
        const tmpFile = path.join(os.tmpdir(), `agy-win-${winId}-${Date.now()}.jpg`);
        execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(winId), '-t', 'jpg', tmpFile]);
        if (fs.existsSync(tmpFile)) {
          execFileSync('/usr/bin/sips', ['-Z', String(Math.max(maxW, maxH)), tmpFile], { stdio: 'ignore' });
          shot.base64 = fs.readFileSync(tmpFile).toString('base64');
          try { fs.unlinkSync(tmpFile); } catch (_) {}
        }
      } catch (_) {}
    }
  }

  let axList = shot.axSummary || [];
  let winBounds = shot.windowBounds;

  const nativeAx = await nativeAxPromise;
  if (nativeAx && nativeAx.ok && Array.isArray(nativeAx.axSummary) && nativeAx.axSummary.length > 0) {
    axList = nativeAx.axSummary;
    if (nativeAx.windowBounds) winBounds = nativeAx.windowBounds;
  }

  const snapKey = `${bundleId}:${shot.resolvedWindowId || winId || 'main'}`;
  const prevSnap = session.appSnapshots.get(snapKey) || session.appSnapshots.get(`${bundleId}:main`);

  const { text: axText, lines: formattedLines, isDiff } = formatAxTreeWithOptionalDiff(
    axList,
    winBounds,
    prevSnap?.formattedLines,
    Boolean(options.disableDiff)
  );

  const snapshotObj = {
    bundleId,
    displayName: resolved.displayName || bundleId,
    resolvedWindowId: shot.resolvedWindowId || winId,
    width: shot.width,
    height: shot.height,
    windowBounds: winBounds,
    axSummary: axList,
    formattedLines,
    formattedText: axText,
    base64: shot.base64,
    timestamp: Date.now()
  };

  session.appSnapshots.set(snapKey, snapshotObj);
  session.appSnapshots.set(`${bundleId}:main`, snapshotObj);
  session.metrics.screenshotsCaptured++;

  recordCuaEvent({
    type: 'screenshot',
    mode: 'background',
    targetApp: snapshotObj.displayName,
    windowId: snapshotObj.resolvedWindowId,
    axCount: snapshotObj.axSummary.length,
    isDiff
  });

  return snapshotObj;
}

/**
 * Resolves a window-local point { x, y } and screen-global point { screenX, screenY }
 * for a per-app action given either `element_index` or `coordinate: [x, y]`.
 */
function resolveAppTargetCoordinates(bundleId, windowId, args) {
  const snap = session.appSnapshots.get(`${bundleId}:${windowId || 'main'}`) ||
               session.appSnapshots.get(`${bundleId}:main`);
  const bounds = snap?.windowBounds || { x: 0, y: 0, w: 1200, h: 800 };

  if (args.element_index !== undefined && args.element_index !== null) {
    const idx = Number(args.element_index);
    if (!snap || !Array.isArray(snap.axSummary) || idx < 0 || idx >= snap.axSummary.length) {
      throw new Error(`Invalid element_index ${args.element_index}. Call app_screenshot or get_app_state first to get current element indices.`);
    }
    const el = snap.axSummary[idx];
    const screenX = Math.round(el.x + el.w / 2);
    const screenY = Math.round(el.y + el.h / 2);
    const winLocalX = Math.round(screenX - bounds.x);
    const winLocalY = Math.round(screenY - bounds.y);
    return {
      winLocalPt: { x: winLocalX, y: winLocalY },
      screenPt: { x: screenX, y: screenY },
      element: el,
      resolvedWindowId: snap.resolvedWindowId || windowId
    };
  }

  let rawX, rawY;
  if (Array.isArray(args.coordinate) && args.coordinate.length === 2) {
    [rawX, rawY] = args.coordinate;
  } else if (typeof args.x === 'number' && typeof args.y === 'number') {
    rawX = args.x;
    rawY = args.y;
  } else if (args.target === 'focused') {
    return {
      winLocalPt: { x: Math.round(bounds.w / 2), y: Math.round(bounds.h / 2) },
      screenPt: { x: Math.round(bounds.x + bounds.w / 2), y: Math.round(bounds.y + bounds.h / 2) },
      focused: true,
      resolvedWindowId: snap?.resolvedWindowId || windowId
    };
  } else {
    throw new Error('Provide either element_index, coordinate: [x, y], or target: "focused".');
  }

  const scaleX = snap && snap.width ? (bounds.w / snap.width) : 1;
  const scaleY = snap && snap.height ? (bounds.h / snap.height) : 1;
  const winLocalX = Math.round(rawX * scaleX);
  const winLocalY = Math.round(rawY * scaleY);
  const screenX = Math.round(bounds.x + winLocalX);
  const screenY = Math.round(bounds.y + winLocalY);

  return {
    winLocalPt: { x: winLocalX, y: winLocalY },
    screenPt: { x: screenX, y: screenY },
    resolvedWindowId: snap?.resolvedWindowId || windowId
  };
}

/**
 * Executes a background per-app action via cached AXUIElement direct dispatch (`antigravity-cua-native`).
 */
async function dispatchBackgroundAppAction(appInput, windowId, intent, targetArgs = {}) {
  const resolved = resolveAppIdentifier(appInput);
  const bundleId = resolved.bundleId;
  const target = resolveAppTargetCoordinates(bundleId, windowId, targetArgs);

  triggerDesktopOverlay(
    'background',
    `Antigravity Background CUA · ${resolved.displayName} (${intent.kind})`,
    target.screenPt?.x,
    target.screenPt?.y
  );

  session.lastActionTimestamp = Date.now();
  session.metrics.actionsExecuted++;

  // Cached AXUIElement direct dispatch via antigravity-cua-native (works across off-Space windows!)
  if (intent.kind === 'click' || intent.kind === 'type') {
    try {
      const nativeRes = intent.kind === 'click'
        ? await agyNativeHelper.call('clickElement', {
            app: bundleId,
            element_index: targetArgs.element_index,
            screenX: target.screenPt?.x,
            screenY: target.screenPt?.y
          }, 2500)
        : await agyNativeHelper.call('setValue', {
            app: bundleId,
            element_index: targetArgs.element_index,
            value: intent.text,
            mode: intent.mode || 'insert',
            screenX: target.screenPt?.x,
            screenY: target.screenPt?.y
          }, 2500);
      if (nativeRes && nativeRes.ok) {
        session.metrics.backgroundAxActions++;
        recordCuaEvent({
          type: 'action',
          mode: 'background_ax_native',
          targetApp: resolved.displayName,
          action: intent.kind,
          axOp: nativeRes.axOp || intent.kind,
          role: nativeRes.role || 'AXElement'
        });
        return {
          ok: true,
          path: 'ax_native',
          outcome: 'performed',
          role: nativeRes.role || 'AXElement',
          axOp: nativeRes.axOp || intent.kind
        };
      }
    } catch (_) {}
  }

  return {
    ok: false,
    path: 'ax',
    outcome: 'unsupported',
    reasonCode: 'unsupported_element',
    role: 'unknown',
    axOp: intent.kind
  };
}

// ============================================================================
// 8. Stateful JavaScript REPL (`cua_repl` with `sky` & `cua` bindings)
// ============================================================================

function createSkyAndCuaBindings(replOutputCollector) {
  const sky = {
    target: 'mac',

    async list_apps() {
      const list = await getAppsListWithFallback(true);
      return list.map(a => ({
        id: a.bundleId,
        displayName: a.displayName,
        isRunning: Boolean(a.isRunning ?? true)
      }));
    },

    async list_displays() {
      return listAllPhysicalDisplays();
    },

    async list_windows() {
      const running = await getAppsListWithFallback(false);
      const all = [];
      for (const app of running) {
        if (!app.bundleId || HOST_BUNDLE_IDS.includes(app.bundleId)) continue;
        try {
          const wins = await getAppWindowsWithFallback(app.bundleId);
          for (const w of wins) {
            all.push({
              id: w.windowId,
              app: app.bundleId,
              displayName: app.displayName,
              title: w.rawTitle || w.title || '',
              focused: Boolean(w.isMain),
              isMinimized: Boolean(w.isMinimized),
              isOffSpace: Boolean(w.isOffSpace),
              x: w.bounds?.x || 0,
              y: w.bounds?.y || 0,
              width: w.bounds?.w || 0,
              height: w.bounds?.h || 0
            });
          }
        } catch (_) {}
      }
      return all;
    },

    async get_app_state(input) {
      const appId = typeof input === 'string' ? input : input?.app;
      const disableDiff = typeof input === 'object' ? Boolean(input?.disableDiff) : false;
      const skipImage = typeof input === 'object' ? Boolean(input?.skipImage || input?.text_only) : false;
      const snap = await captureAppWindowState(appId, { disableDiff, skipImage });
      let tmpFile = null;
      if (snap.base64) {
        tmpFile = path.join(os.tmpdir(), `app-state-${snap.bundleId}-${Date.now()}.jpg`);
        fs.writeFileSync(tmpFile, Buffer.from(snap.base64, 'base64'));
      }
      return {
        app: snap.bundleId,
        screenshot: snap.base64 ? { url: `file://${tmpFile}`, base64: snap.base64 } : null,
        text: snap.formattedText
      };
    },

    async click(input) {
      const res = await dispatchBackgroundAppAction(
        input.app,
        input.window_id,
        {
          kind: 'click',
          button: (input.mouse_button === 'right' || input.mouse_button === 'r') ? 'right' : 'left',
          count: input.click_count || 1
        },
        input
      );
      if (!res.ok && (typeof input.x === 'number' || typeof input.element_index === 'number')) {
        // Fallback to foreground click at resolved screen point
        const target = resolveAppTargetCoordinates(resolveAppIdentifier(input.app).bundleId, input.window_id, input);
        if (target.screenPt) {
          await agyNativeHelper.call('cgEventInput', { op: 'move', x: target.screenPt.x, y: target.screenPt.y });
          await sleep(40);
          await agyNativeHelper.call('cgEventInput', {
            op: 'click',
            x: target.screenPt.x,
            y: target.screenPt.y,
            button: 'left',
            count: input.click_count || 1
          });
        }
      }
    },

    async set_value(input) {
      const resolved = resolveAppIdentifier(input.app);
      const target = resolveAppTargetCoordinates(resolved.bundleId, input.window_id, { element_index: input.element_index });
      const res = await dispatchBackgroundAppAction(
        resolved.bundleId,
        target.resolvedWindowId,
        { kind: 'type', text: String(input.value), overwriteExisting: true, mode: 'replace' },
        { element_index: input.element_index }
      );
      if (!res.ok) {
        await agyNativeHelper.call('setValue', {
          app: resolved.bundleId,
          value: String(input.value),
          screenX: target.screenPt?.x,
          screenY: target.screenPt?.y
        });
      }
    },

    async select_text(input) {
      const resolved = resolveAppIdentifier(input.app);
      const target = resolveAppTargetCoordinates(resolved.bundleId, input.window_id, { element_index: input.element_index });
      const res = await agyNativeHelper.call('selectText', {
        app: resolved.bundleId,
        text: input.text,
        prefix: input.prefix || '',
        suffix: input.suffix || '',
        selection_type: input.selection_type || input.selection || 'text',
        screenX: target.screenPt?.x,
        screenY: target.screenPt?.y
      });
      if (!res || !res.ok) {
        throw new Error(res?.error || 'select_text failed');
      }
      session.lastActionTimestamp = Date.now();
      session.metrics.actionsExecuted++;
    },

    async perform_secondary_action(input) {
      const resolved = resolveAppIdentifier(input.app);
      const target = resolveAppTargetCoordinates(resolved.bundleId, input.window_id, { element_index: input.element_index });
      const res = await agyNativeHelper.call('performSecondaryAction', {
        app: resolved.bundleId,
        action: input.action,
        screenX: target.screenPt?.x,
        screenY: target.screenPt?.y
      });
      if (!res || !res.ok) {
        throw new Error(res?.error || `Secondary action '${input.action}' failed`);
      }
      session.lastActionTimestamp = Date.now();
      session.metrics.actionsExecuted++;
    },

    async paste(input) {
      const resolved = resolveAppIdentifier(input.app);
      const format = input.format || 'text';
      await agyNativeHelper.call('setRichClipboard', {
        text: String(input.text || ''),
        format
      });
      try {
        await dispatchBackgroundAppAction(
          resolved.bundleId,
          input.window_id,
          { kind: 'key', combo: 'command+v' },
          { target: 'focused' }
        );
        await sleep(120);
      } finally {
        await agyNativeHelper.call('restoreClipboard', {});
      }
      session.lastActionTimestamp = Date.now();
      session.metrics.actionsExecuted++;
    },

    async press_key(input) {
      await dispatchBackgroundAppAction(
        input.app,
        input.window_id,
        { kind: 'key', combo: input.key },
        { target: 'focused' }
      );
    },

    async type_text(input) {
      await dispatchBackgroundAppAction(
        input.app,
        input.window_id,
        { kind: 'type', text: input.text, mode: 'insert' },
        { target: 'focused' }
      );
    },

    async scroll(input) {
      const pages = input.pages ?? 1;
      const dir = (input.direction || 'down').toLowerCase();
      const dy = (dir === 'down' || dir === 'd') ? Math.round(pages * 5) : (dir === 'up' || dir === 'u') ? -Math.round(pages * 5) : 0;
      const dx = (dir === 'right' || dir === 'r') ? Math.round(pages * 5) : (dir === 'left' || dir === 'l') ? -Math.round(pages * 5) : 0;
      await dispatchBackgroundAppAction(
        input.app,
        input.window_id,
        { kind: 'scroll', dx, dy },
        input
      );
    },

    async drag(input) {
      const resolved = resolveAppIdentifier(input.app);
      const toTarget = resolveAppTargetCoordinates(resolved.bundleId, input.window_id, { x: input.to_x, y: input.to_y });
      await dispatchBackgroundAppAction(
        resolved.bundleId,
        input.window_id,
        { kind: 'drag', toWindowPt: toTarget.winLocalPt },
        { x: input.from_x, y: input.from_y }
      );
    },

    async move_window_to_display(input) {
      const resolved = resolveAppIdentifier(input.app);
      const res = await agyNativeHelper.call('moveWindowToDisplay', {
        app: resolved.bundleId,
        window_id: input.window_id,
        display: input.display ?? 'external',
        switch_to_desktop: input.switch_to_desktop !== false,
        space_id: input.space_id,
        other_space: Boolean(input.other_space),
        x: input.x,
        y: input.y,
        label: input.label,
        tooltip: input.tooltip,
        duration_ms: input.duration_ms,
        is_click: input.is_click
      }, 4500);
      if (!res || !res.ok) {
        throw new Error(res?.error || 'move_window_to_display failed');
      }
      session.lastActionTimestamp = Date.now();
      session.metrics.actionsExecuted++;
      appendCuaTrace({ kind: 'move_window_to_display', result: res });
      return res;
    },

    async trace_status(limit = 20) {
      return (session.traceRing || []).slice(-limit);
    }
  };

  // Object-oriented wrapper (`cua.getApp(...)`)
  const cua = {
    async initialize() { return true; },
    async listApps() { return sky.list_apps(); },
    async listDisplays() { return sky.list_displays(); },
    async listWindows() { return sky.list_windows(); },
    async getApp(target) {
      const appName = typeof target === 'string' ? target : target?.app;
      return {
        app: appName,
        async getAXState(opts = {}) {
          const st = await sky.get_app_state({ app: appName, disableDiff: opts.disableDiffing });
          if (opts.emit !== false) replOutputCollector.write(st.text);
          return st.text;
        },
        async getScreenshot(opts = {}) {
          const st = await sky.get_app_state({ app: appName, disableDiff: true });
          if (opts.emit !== false && st.screenshot?.base64) {
            await replOutputCollector.emitImage({ bytes: Buffer.from(st.screenshot.base64, 'base64'), mimeType: 'image/jpeg' });
          }
          return st.screenshot;
        },
        async getAXStateAndScreenshot(opts = {}) {
          const st = await sky.get_app_state({ app: appName, disableDiff: opts.disableDiffing });
          if (opts.emit !== false) {
            replOutputCollector.write(st.text);
            if (st.screenshot?.base64) {
              await replOutputCollector.emitImage({ bytes: Buffer.from(st.screenshot.base64, 'base64'), mimeType: 'image/jpeg' });
            }
          }
          return st;
        },
        async click(targetElOrCoord, opts = {}) {
          if (typeof targetElOrCoord === 'number') {
            return sky.click({ app: appName, element_index: targetElOrCoord, mouse_button: opts.mouseButton, click_count: opts.clickCount });
          }
          if (Array.isArray(targetElOrCoord)) {
            return sky.click({ app: appName, x: targetElOrCoord[0], y: targetElOrCoord[1], mouse_button: opts.mouseButton, click_count: opts.clickCount });
          }
        },
        async drag(fromPt, toPt) {
          return sky.drag({ app: appName, from_x: fromPt[0], from_y: fromPt[1], to_x: toPt[0], to_y: toPt[1] });
        },
        async scroll(targetElOrCoord, direction, pages = 1) {
          if (typeof targetElOrCoord === 'number') {
            return sky.scroll({ app: appName, element_index: targetElOrCoord, direction, pages });
          }
          return sky.scroll({ app: appName, x: targetElOrCoord?.[0] || 200, y: targetElOrCoord?.[1] || 200, direction, pages });
        },
        async setValue(elementIndex, value) {
          return sky.set_value({ app: appName, element_index: elementIndex, value });
        },
        async selectText(elementIndex, text, opts = {}) {
          return sky.select_text({
            app: appName,
            element_index: elementIndex,
            text,
            prefix: opts.prefix,
            suffix: opts.suffix,
            selection_type: opts.selectionType || 'text'
          });
        },
        async performSecondaryAction(elementIndex, action) {
          return sky.perform_secondary_action({ app: appName, element_index: elementIndex, action });
        },
        async paste(text, opts = {}) {
          return sky.paste({ app: appName, text, format: opts.format || 'text' });
        },
        async pressKey(key, opts = {}) {
          return sky.press_key({ app: appName, key, duration: opts.durationMs ? opts.durationMs / 1000 : undefined });
        },
        async typeText(text, elementIndex) {
          if (typeof elementIndex === 'number') {
            await sky.click({ app: appName, element_index: elementIndex });
          }
          return sky.type_text({ app: appName, text });
        }
      };
    }
  };

  return { sky, cua };
}

async function executeCuaReplJs(code, timeoutMs = 30000) {
  session.metrics.replExecutions++;
  const logs = [];
  const images = [];

  const collector = {
    cwd: process.cwd(),
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    write(val) {
      logs.push(typeof val === 'string' ? val : JSON.stringify(val, null, 2));
    },
    async emitImage(img) {
      if (!img) return;
      let b64 = null;
      if (Buffer.isBuffer(img.bytes)) b64 = img.bytes.toString('base64');
      else if (img.bytes instanceof Uint8Array) b64 = Buffer.from(img.bytes).toString('base64');
      else if (typeof img.base64 === 'string') b64 = img.base64;
      if (b64) {
        images.push({ type: 'image', data: b64, mimeType: img.mimeType || 'image/jpeg' });
      }
    }
  };

  if (!session.replContext) {
    const { sky, cua } = createSkyAndCuaBindings(collector);
    const sandbox = {
      sky,
      cua,
      sleep,
      nodeRepl: collector,
      Buffer,
      setTimeout,
      clearTimeout,
      fetch: globalThis.fetch
    };
    sandbox.globalThis = sandbox;
    session.replContext = vm.createContext(sandbox);
  } else {
    session.replContext.nodeRepl = collector;
    const { sky, cua } = createSkyAndCuaBindings(collector);
    session.replContext.sky = sky;
    session.replContext.cua = cua;
  }
  session.replContext.console = {
    log: (...a) => collector.write(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
    error: (...a) => collector.write('[ERROR] ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '))
  };

  // Transform top-level `const`/`let` into `var` so bindings persist across REPL turns
  const transformed = code.replace(/^\s*(const|let)\s+/gm, 'var ');
  const wrapped = `(async () => {\n${transformed}\n})()`;
  const script = new vm.Script(wrapped, { filename: 'cua_repl.js' });
  const result = await script.runInContext(session.replContext, { timeout: timeoutMs });
  if (result !== undefined && logs.length === 0) {
    collector.write(result);
  }

  const content = [];
  if (logs.length > 0) {
    content.push({ type: 'text', text: logs.join('\n') });
  } else {
    content.push({ type: 'text', text: 'Executed successfully (no stdout).' });
  }
  for (const img of images) {
    content.push(img);
  }
  return { content };
}

// ============================================================================
// 9. Complete MCP Tool Definitions (Display + Per-App + JS REPL)
// ============================================================================

const TOOLS = [
  // --- Display-Scope Tools ---
  {
    name: 'request_access',
    description: 'Request permission to control specified macOS applications and optional clipboard/system shortcut capabilities.',
    inputSchema: {
      type: 'object',
      properties: {
        apps: { type: 'array', items: { type: 'string' }, description: 'Application names or bundle IDs to request access for.' },
        reason: { type: 'string', description: 'Short explanation of what actions will be performed.' },
        clipboardRead: { type: 'boolean' },
        clipboardWrite: { type: 'boolean' },
        systemKeyCombos: { type: 'boolean' }
      },
      required: ['apps', 'reason']
    }
  },
  {
    name: 'screenshot',
    description: 'Capture a full-screen display screenshot scaled to the optimal 28x28 tile vision token budget (max 1568px / 1568 tokens).',
    inputSchema: {
      type: 'object',
      properties: {
        display: { type: 'string', description: 'Optional physical monitor name, displayId, or index (0, 1, ...) to capture.' },
        scale: { type: 'number', description: 'Optional resolution scale in [0.1, 1.0]. Coordinates still map to the unscaled frameWidth x frameHeight.' },
        save_to_disk: { type: 'boolean', description: 'Save JPEG to disk and include file path in response.' }
      }
    }
  },
  {
    name: 'zoom',
    description: 'Capture a high-resolution crop of [x0, y0, x1, y1] from the live Retina display. Subsequent click coordinates still refer to the full-screen screenshot coordinate frame.',
    inputSchema: {
      type: 'object',
      properties: {
        region: {
          type: 'array',
          items: { type: 'integer' },
          minItems: 4,
          maxItems: 4,
          description: '[x0, y0, x1, y1] rectangle in the full-screen screenshot coordinate space.'
        },
        scale: { type: 'number' },
        save_to_disk: { type: 'boolean' }
      },
      required: ['region']
    }
  },
  {
    name: 'left_click',
    description: 'Left-click at [x, y] in screenshot coordinates (with optional modifier keys held).',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        text: { type: 'string', description: 'Optional modifier keys to hold during click (e.g. "shift", "cmd+alt").' }
      },
      required: ['coordinate']
    }
  },
  {
    name: 'double_click',
    description: 'Double left-click at [x, y] in screenshot coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        text: { type: 'string' }
      },
      required: ['coordinate']
    }
  },
  {
    name: 'triple_click',
    description: 'Triple left-click at [x, y] in screenshot coordinates (selects line/paragraph).',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        text: { type: 'string' }
      },
      required: ['coordinate']
    }
  },
  {
    name: 'right_click',
    description: 'Right-click (context menu) at [x, y] in screenshot coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        text: { type: 'string' }
      },
      required: ['coordinate']
    }
  },
  {
    name: 'middle_click',
    description: 'Middle-click at [x, y] in screenshot coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        text: { type: 'string' }
      },
      required: ['coordinate']
    }
  },
  {
    name: 'left_click_drag',
    description: 'Smoothly drag with the left mouse button from start_coordinate (or current cursor) to coordinate using 60fps cubic ease-out motion.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Drag end coordinate [x, y].' },
        start_coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Optional drag start coordinate [x, y].' }
      },
      required: ['coordinate']
    }
  },
  {
    name: 'mouse_move',
    description: 'Move the mouse cursor to [x, y] in screenshot coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }
      },
      required: ['coordinate']
    }
  },
  {
    name: 'left_mouse_down',
    description: 'Press and hold the left mouse button at the current cursor position.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'left_mouse_up',
    description: 'Release the left mouse button at the current cursor position.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'scroll',
    description: 'Scroll the mouse wheel at [x, y] in direction ("up", "down", "left", "right") by scroll_amount ticks.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'integer', minimum: 0, maximum: 100 }
      },
      required: ['coordinate', 'scroll_direction', 'scroll_amount']
    }
  },
  {
    name: 'type',
    description: 'Type text into the currently focused element (uses clipboard fast-path for multi-line text and verifies focus before every grapheme).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' }
      },
      required: ['text']
    }
  },
  {
    name: 'key',
    description: 'Press a key or modifier chord (e.g. "return", "escape", "cmd+shift+p", "super+c") with optional repeat count.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        repeat: { type: 'integer', minimum: 1, maximum: 100 }
      },
      required: ['text']
    }
  },
  {
    name: 'hold_key',
    description: 'Hold a key or chord down for duration seconds (0..100).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        duration: { type: 'number', minimum: 0, maximum: 100 }
      },
      required: ['text', 'duration']
    }
  },
  {
    name: 'wait',
    description: 'Wait for duration seconds (0..100), aborting immediately if the user presses Escape.',
    inputSchema: {
      type: 'object',
      properties: {
        duration: { type: 'number', minimum: 0, maximum: 100 }
      },
      required: ['duration']
    }
  },
  {
    name: 'cursor_position',
    description: 'Return the current mouse cursor position in screenshot coordinates.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'open_application',
    description: 'Open or activate an application by name or bundle ID (or launch in background when background=true).',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        background: { type: 'boolean' }
      },
      required: ['app']
    }
  },
  {
    name: 'switch_display',
    description: 'Pin screenshots and coordinate mapping to a specific monitor by name or "auto".',
    inputSchema: {
      type: 'object',
      properties: {
        display: { type: 'string' }
      },
      required: ['display']
    }
  },
  {
    name: 'list_apps',
    description: 'List installed and running macOS applications with bundle IDs and running state.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        running_first: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 }
      }
    }
  },
  {
    name: 'read_clipboard',
    description: 'Read the current macOS system clipboard text.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'write_clipboard',
    description: 'Write text to the macOS system clipboard.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  },
  {
    name: 'computer_batch',
    description: 'Execute a sequence of display-scope computer use actions in a single turn with 10ms delay between steps, stopping on first error.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'key', 'type', 'mouse_move', 'left_click', 'left_click_drag',
                  'right_click', 'middle_click', 'double_click', 'triple_click',
                  'scroll', 'hold_key', 'screenshot', 'zoom', 'cursor_position',
                  'left_mouse_down', 'left_mouse_up', 'wait'
                ]
              },
              coordinate: { type: 'array', items: { type: 'number' } },
              start_coordinate: { type: 'array', items: { type: 'number' } },
              region: { type: 'array', items: { type: 'integer' } },
              text: { type: 'string' },
              repeat: { type: 'integer' },
              duration: { type: 'number' },
              scroll_direction: { type: 'string' },
              scroll_amount: { type: 'integer' },
              scale: { type: 'number' }
            },
            required: ['action']
          }
        }
      },
      required: ['actions']
    }
  },

  // --- Per-App Background Tools ---
  {
    name: 'app_list_windows',
    description: 'List all open windows for a macOS application (including minimized and off-Space windows) without disturbing focus.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Application display name or bundle ID.' }
      },
      required: ['app']
    }
  },
  {
    name: 'app_screenshot',
    description: 'Capture a single application window in the background via ScreenCaptureKit (even if behind other windows or on another Space) AND return its indexed Accessibility tree (<ax-summary>) with stateful diffing.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Application display name or bundle ID.' },
        window_id: { type: 'number', description: 'Optional specific window_id from app_list_windows.' },
        scale: { type: 'number', description: 'Optional scale in [0.1, 1.0].' },
        disable_diff: { type: 'boolean', description: 'Return the full Accessibility tree instead of a diff from the previous capture.' }
      },
      required: ['app']
    }
  },
  {
    name: 'app_ax_find',
    description: 'Search the Accessibility elements captured by the last app_screenshot by role or title substring.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window_id: { type: 'number' },
        role: { type: 'string', description: 'Exact AXRole filter (e.g. "AXButton", "AXTextField").' },
        title_contains: { type: 'string', description: 'Case-insensitive substring match on element title.' }
      },
      required: ['app']
    }
  },
  {
    name: 'app_click',
    description: 'Click an element or coordinate inside a background application window without stealing focus or moving the user cursor via direct AXUIElement dispatch.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window_id: { type: 'number' },
        element_index: { type: 'number', description: 'Element [N] index from app_screenshot <ax-summary>.' },
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Window-local screenshot coordinate [x, y].' },
        target: { type: 'string', enum: ['focused'] },
        button: { type: 'string', enum: ['left', 'right'] },
        count: { type: 'integer', enum: [1, 2, 3] }
      },
      required: ['app']
    }
  },
  {
    name: 'app_type',
    description: 'Type or replace text in an element or focused field of a background application window without stealing focus.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window_id: { type: 'number' },
        element_index: { type: 'number' },
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        target: { type: 'string', enum: ['focused'] },
        text: { type: 'string' },
        overwrite_existing: { type: 'boolean' },
        mode: { type: 'string', enum: ['insert', 'replace'] },
        disable_substitutions: { type: 'boolean' }
      },
      required: ['app', 'text']
    }
  },
  {
    name: 'app_key',
    description: 'Send a key or shortcut chord to a background application window without stealing focus.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window_id: { type: 'number' },
        element_index: { type: 'number' },
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        target: { type: 'string', enum: ['focused'] },
        combo: { type: 'string', description: 'Key or modifier chord, e.g. "return", "cmd+f", "escape".' }
      },
      required: ['app', 'combo']
    }
  },
  {
    name: 'app_scroll',
    description: 'Scroll vertically or horizontally inside a background application window.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window_id: { type: 'number' },
        element_index: { type: 'number' },
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        dx: { type: 'number' },
        dy: { type: 'number', description: 'Positive scrolls down, negative scrolls up.' }
      },
      required: ['app']
    }
  },
  {
    name: 'app_drag',
    description: 'Drag from coordinate [x0, y0] to to_coordinate [x1, y1] inside a background application window.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window_id: { type: 'number' },
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        to_coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }
      },
      required: ['app', 'coordinate', 'to_coordinate']
    }
  },
  {
    name: 'app_menu',
    description: 'List or invoke macOS menu bar items of an application in the background via AXMenuBar without opening visible menus.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        path: { type: 'array', items: { type: 'string' }, description: 'Menu path to invoke, e.g. ["File", "New Tab"].' },
        list: { type: 'string', description: 'Optional top-level menu name to list items under (or omit to list top-level menus).' }
      },
      required: ['app']
    }
  },
  {
    name: 'app_bring_to_current_space',
    description: 'Move an application window onto the active macOS desktop Space or onto a specified physical monitor (e.g. "external" or "main"), automatically switching the monitor out of any fullscreen Space if switch_to_desktop is true.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window_id: { type: 'number' },
        display: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description: 'Optional target physical display ID, 0-based index, name (e.g. "Built-in Retina Display"), or "external" / "main".'
        },
        switch_to_desktop: {
          type: 'boolean',
          description: 'Switch the target display to its standard Desktop Space if a fullscreen app is currently occupying it (default: true).'
        }
      },
      required: ['app']
    }
  },
  {
    name: 'app_move_to_display',
    description: 'Move an application window to a target physical display (e.g. "external", "main", or displayId) and its Desktop Space via AXPosition + SkyLight.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window_id: { type: 'number' },
        display: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description: 'Target display name ("Built-in Retina Display", "external", "main"), 0-based index, or CGDirectDisplayID.'
        },
        switch_to_desktop: {
          type: 'boolean',
          description: 'Switch the target display to its Desktop Space so the moved window is immediately visible (default: true).'
        },
        x: { type: 'number', description: 'Optional global X coordinate on target display (centers window by default).' },
        y: { type: 'number', description: 'Optional global Y coordinate on target display (centers window by default).' }
      },
      required: ['app']
    }
  },
  {
    name: 'app_batch',
    description: 'Execute a batch of background per-app actions (click, type, key, scroll, drag, screenshot) sequentially in a single turn.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window_id: { type: 'number' },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['click', 'type', 'key', 'scroll', 'drag', 'screenshot'] },
              element_index: { type: 'number' },
              coordinate: { type: 'array', items: { type: 'number' } },
              to_coordinate: { type: 'array', items: { type: 'number' } },
              target: { type: 'string' },
              button: { type: 'string' },
              count: { type: 'integer' },
              text: { type: 'string' },
              combo: { type: 'string' },
              dx: { type: 'number' },
              dy: { type: 'number' },
              mode: { type: 'string' },
              overwrite_existing: { type: 'boolean' }
            },
            required: ['action']
          }
        }
      },
      required: ['app', 'actions']
    }
  },
  {
    name: 'app_release',
    description: 'Release background per-app control locks and hide any phantom cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window_id: { type: 'number' }
      }
    }
  },

  // --- Stateful JS REPL & Accessibility Primitives ---
  {
    name: 'js',
    description: 'Execute JavaScript in a persistent Computer Use `cua_repl` kernel with top-level await. Pre-loaded with `globalThis.sky` (list_apps, get_app_state, click, set_value, select_text, perform_secondary_action, paste, press_key, type_text, scroll, drag) and `globalThis.cua` (getApp, listApps, listWindows) plus `nodeRepl.write(str)` and `await nodeRepl.emitImage({bytes, mimeType})`.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute with top-level await.' },
        timeout_ms: { type: 'integer', description: 'Execution timeout in milliseconds (default 30000).' },
        title: { type: 'string', description: 'Short summary of what the CUA script does.' }
      },
      required: ['code']
    }
  },
  {
    name: 'js_reset',
    description: 'Reset the persistent `cua_repl` JavaScript kernel and clear top-level bindings.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'sky_select_text',
    description: 'Accessibility primitive: Select specific substring text inside an editable accessibility element (or place cursor before/after it), using optional prefix/suffix to disambiguate repeated matches.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        element_index: { type: 'number' },
        text: { type: 'string', description: 'Exact substring to locate inside the element value.' },
        prefix: { type: 'string', description: 'Optional text immediately before target text.' },
        suffix: { type: 'string', description: 'Optional text immediately after target text.' },
        selection_type: { type: 'string', enum: ['text', 'cursor_before', 'cursor_after'] }
      },
      required: ['app', 'element_index', 'text']
    }
  },
  {
    name: 'sky_perform_secondary_action',
    description: 'Accessibility primitive: Invoke a named secondary accessibility action on an element (e.g. "AXShowMenu", "AXIncrement", "AXDecrement", "AXConfirm", "AXCancel", "AXRaise").',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        element_index: { type: 'number' },
        action: { type: 'string' }
      },
      required: ['app', 'element_index', 'action']
    }
  },
  {
    name: 'sky_paste',
    description: 'Paste plain text, Markdown, or rich HTML ("text" | "md" | "html") into an app via NSPasteboard and automatically restore the previous clipboard contents.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        text: { type: 'string' },
        format: { type: 'string', enum: ['text', 'md', 'html'] }
      },
      required: ['app', 'text']
    }
  },
  {
    name: 'teach_step',
    description: 'Display an interactive guided-walkthrough tooltip callout anchored at [x, y] on the user screen and optionally execute display actions.',
    inputSchema: {
      type: 'object',
      properties: {
        explanation: { type: 'string', description: 'Text shown in the on-screen callout card.' },
        anchor: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, y] screenshot coordinate to anchor the callout.' },
        duration_ms: { type: 'integer', description: 'How long to show the tooltip in ms (default 5000).' }
      },
      required: ['explanation']
    }
  }
];

// ============================================================================
// 10. Tool Call Dispatcher
// ============================================================================

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text) }],
    ...(isError ? { isError: true } : {})
  };
}

async function handleToolCall(name, args = {}) {
  acquireEscapeTrap();
  try {
    switch (name) {
      case 'request_access': {
        const apps = Array.isArray(args.apps) ? args.apps : [];
        const granted = [];
        for (const a of apps) {
          const resolved = resolveAppIdentifier(a);
          session.allowedApps.set(resolved.bundleId, {
            bundleId: resolved.bundleId,
            displayName: resolved.displayName || a,
            tier: 'full'
          });
          granted.push({ bundleId: resolved.bundleId, displayName: resolved.displayName || a, tier: 'full' });
        }
        if (typeof args.clipboardRead === 'boolean') session.grantFlags.clipboardRead = args.clipboardRead;
        if (typeof args.clipboardWrite === 'boolean') session.grantFlags.clipboardWrite = args.clipboardWrite;
        if (typeof args.systemKeyCombos === 'boolean') session.grantFlags.systemKeyCombos = args.systemKeyCombos;
        return textResult(JSON.stringify({
          granted: true,
          allowedApps: granted,
          grantFlags: session.grantFlags
        }, null, 2));
      }

      case 'screenshot':
        return await captureDisplayScreenshot(args);

      case 'zoom':
        return await captureZoomRegion(args.region, args);

      case 'left_click':
      case 'double_click':
      case 'triple_click':
      case 'right_click':
      case 'middle_click': {
        const coord = parseCoordinateInput(args, 'coordinate');
        const button = name === 'right_click' ? 'right' : name === 'middle_click' ? 'middle' : 'left';
        const count = name === 'double_click' ? 2 : name === 'triple_click' ? 3 : 1;
        const { screenX, screenY, hitApp } = await performDisplayClick(button, count, coord, args.text, args.coordinate_mode);
        return textResult(`Clicked (${button}${count > 1 ? ' x' + count : ''}) at screen (${screenX}, ${screenY})${hitApp?.displayName ? ' on ' + hitApp.displayName : ''}.`);
      }

      case 'left_click_drag': {
        const endCoord = parseCoordinateInput(args, 'coordinate');
        const startCoord = args.start_coordinate ? parseCoordinateInput(args, 'start_coordinate') : undefined;
        const dragTrace = await performDisplayDrag(startCoord, endCoord, args.coordinate_mode);
        return textResult(
          `Dragged from (${dragTrace.mappedStart.x}, ${dragTrace.mappedStart.y}) to (${dragTrace.mappedEnd.x}, ${dragTrace.mappedEnd.y})` +
          (dragTrace.actualCursorAfter ? ` [cursor=(${dragTrace.actualCursorAfter.x}, ${dragTrace.actualCursorAfter.y})]` : '') + '.'
        );
      }

      case 'mouse_move': {
        const coord = parseCoordinateInput(args, 'coordinate');
        const { x, y } = mapToScreenPoint(coord[0], coord[1], args.coordinate_mode);
        triggerDesktopOverlay(
          'display',
          `Antigravity Agent · Move (${x}, ${y})`,
          x,
          y,
          undefined,
          2400,
          'Antigravity Agent',
          false
        );
        await agyNativeHelper.call('cgEventInput', { op: 'move', x, y });
        await sleep(50);
        session.metrics.actionsExecuted++;
        return textResult(`Moved cursor to (${x}, ${y}).`);
      }

      case 'left_mouse_down': {
        await agyNativeHelper.call('cgEventInput', { op: 'mouseDown', button: 'left' });
        session.mouseDownHeld = true;
        session.metrics.actionsExecuted++;
        return textResult('Left mouse button pressed down.');
      }

      case 'left_mouse_up': {
        await agyNativeHelper.call('cgEventInput', { op: 'mouseUp', button: 'left' });
        session.mouseDownHeld = false;
        session.metrics.actionsExecuted++;
        return textResult('Left mouse button released.');
      }

      case 'scroll': {
        const coord = parseCoordinateInput(args, 'coordinate');
        const { x, y } = mapToScreenPoint(coord[0], coord[1], args.coordinate_mode);
        const dir = args.scroll_direction;
        const amt = Number(args.scroll_amount ?? 3);
        const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
        const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0;
        await agyNativeHelper.call('cgEventInput', { op: 'move', x, y });
        await sleep(40);
        await agyNativeHelper.call('cgEventInput', { op: 'scroll', dx, dy });
        session.metrics.actionsExecuted++;
        return textResult(`Scrolled ${dir} by ${amt} at (${x}, ${y}).`);
      }

      case 'type': {
        const msg = await performDisplayType(String(args.text ?? ''));
        return textResult(msg);
      }

      case 'key': {
        await performDisplayKey(String(args.text ?? ''), args.repeat || 1);
        return textResult(args.repeat > 1 ? `Key '${args.text}' pressed ${args.repeat} times.` : `Key '${args.text}' pressed.`);
      }

      case 'hold_key': {
        const keys = parseKeyChord(String(args.text ?? ''));
        const durMs = Math.min(100, Math.max(0, Number(args.duration || 0.5))) * 1000;
        const held = [];
        session.aborted = false;
        try {
          for (const k of keys) {
            await agyNativeHelper.call('cgEventInput', { op: 'keyDown', key: k });
            held.push(k);
          }
          const end = Date.now() + durMs;
          while (Date.now() < end) {
            if (session.aborted) break;
            await sleep(Math.min(50, end - Date.now()));
          }
        } finally {
          while (held.length > 0) {
            const k = held.pop();
            try {
              await agyNativeHelper.call('cgEventInput', { op: 'keyUp', key: k });
            } catch (_) {}
          }
        }
        session.metrics.actionsExecuted++;
        return textResult(`Held '${args.text}' for ${args.duration}s.`);
      }

      case 'wait': {
        const durSec = args.duration !== undefined
          ? Number(args.duration)
          : (args.duration_ms !== undefined ? Number(args.duration_ms) / 1000 : 1);
        const durMs = Math.min(100000, Math.max(0, durSec * 1000));
        session.aborted = false;
        const end = Date.now() + durMs;
        while (Date.now() < end) {
          if (session.aborted) return textResult('Wait aborted by user (Escape).', true);
          await sleep(Math.min(50, end - Date.now()));
        }
        return textResult(`Waited ${(durMs / 1000).toFixed(2)}s.`);
      }

      case 'cursor_position': {
        let loc = { x: 0, y: 0 };
        try {
          const res = await agyNativeHelper.call('mouseLocation', {});
          if (res && res.ok) loc = { x: res.x, y: res.y };
        } catch (_) {}
        const mapped = mapScreenPointToImage(loc.x, loc.y);
        return textResult(JSON.stringify({ screen: loc, image: mapped }));
      }

      case 'open_application': {
        const resolved = resolveAppIdentifier(args.app);
        const activates = args.background ? false : true;
        execFileSync('/usr/bin/open', [ ...(activates ? [] : ['-g']), '-b', resolved.bundleId ]);
        return textResult(`Opened "${resolved.displayName || resolved.bundleId}"${activates ? '' : ' in the background'}.`);
      }

      case 'switch_display': {
        const all = await listAllPhysicalDisplays();
        const dispStr = args.display !== undefined && args.display !== null ? String(args.display).trim() : '';
        if (!dispStr || dispStr.toLowerCase() === 'auto' || dispStr.toLowerCase() === 'list') {
          if (dispStr.toLowerCase() === 'list') {
            return textResult(JSON.stringify(all, null, 2));
          }
          session.selectedDisplayId = undefined;
          return textResult(`Returned to automatic monitor selection.\nAvailable displays:\n${JSON.stringify(all, null, 2)}`);
        }
        const q = dispStr.toLowerCase();
        const match = all.find((d, idx) =>
          (d.label || '').toLowerCase() === q ||
          (d.label || '').toLowerCase().includes(q) ||
          String(d.displayId) === q ||
          String(idx) === q ||
          `display ${idx + 1}` === q ||
          ((q === 'external' || q === 'secondary') && !d.isBuiltin) ||
          ((q === 'main' || q === 'builtin' || q === 'primary') && d.isBuiltin)
        );
        if (!match) {
          return textResult(`Monitor "${args.display}" not found. Available: ${all.map(d => `${d.label} (id=${d.displayId}, index=${d.index})`).join(', ')}`, true);
        }
        session.selectedDisplayId = match.displayId;
        appendCuaTrace({ kind: 'switch_display', selectedDisplay: match });
        return textResult(`Switched to display "${match.label}" (id=${match.displayId}, origin=${match.originX},${match.originY}, logical=${match.width}x${match.height}, coordinateFrame=${match.coordinateFrame.width}x${match.coordinateFrame.height}).`);
      }

      case 'list_apps': {
        const list = await getAppsListWithFallback(true);
        let filtered = list;
        if (args.query) {
          const q = args.query.toLowerCase();
          filtered = filtered.filter(a =>
            (a.displayName && a.displayName.toLowerCase().includes(q)) ||
            (a.bundleId && a.bundleId.toLowerCase().includes(q))
          );
        }
        if (args.running_first !== false) {
          filtered.sort((a, b) => Number(Boolean(b.isRunning)) - Number(Boolean(a.isRunning)));
        }
        const limit = Math.min(200, Math.max(1, Number(args.limit || 40)));
        return textResult(JSON.stringify(filtered.slice(0, limit), null, 2));
      }

      case 'read_clipboard': {
        const txt = execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8' });
        return textResult(txt);
      }

      case 'write_clipboard': {
        execFileSync('/usr/bin/pbcopy', [], { input: String(args.text ?? ''), encoding: 'utf8' });
        return textResult(`Wrote ${String(args.text ?? '').length} char(s) to clipboard.`);
      }

      case 'computer_batch': {
        const actions = Array.isArray(args.actions) ? args.actions : [];
        if (actions.length === 0) return textResult('actions must be a non-empty array', true);
        const outContent = [];
        session.aborted = false;
        for (let i = 0; i < actions.length; i++) {
          if (session.aborted) {
            outContent.push({ type: 'text', text: `Batch aborted at step ${i} (user Escape).` });
            return { content: outContent, isError: true };
          }
          if (i > 0) await sleep(10);
          const step = actions[i];
          const res = await handleToolCall(step.action, step);
          const ok = !res.isError;
          outContent.push({ type: 'text', text: `— actions[${i}] ${step.action}: ${ok ? 'ok' : 'STOPPED'} —` });
          if (res.content) outContent.push(...res.content);
          if (!ok) {
            return { content: outContent, isError: true };
          }
        }
        outContent.push({ type: 'text', text: `All ${actions.length} batch actions completed.` });
        return { content: outContent };
      }

      // --- Per-App Background Tools ---
      case 'app_list_windows': {
        const resolved = resolveAppIdentifier(args.app);
        const wins = await getAppWindowsWithFallback(resolved.bundleId);
        return textResult(JSON.stringify(wins.map(w => ({
          window_id: w.windowId,
          title: w.rawTitle || w.title || '',
          is_main: w.isMain,
          is_minimized: w.isMinimized,
          is_off_space: w.isOffSpace,
          bounds: w.bounds
        })), null, 2));
      }

      case 'app_screenshot': {
        const snap = await captureAppWindowState(args.app, {
          window_id: args.window_id,
          scale: args.scale,
          disableDiff: Boolean(args.disable_diff),
          skipImage: Boolean(args.text_only)
        });
        const content = [
          {
            type: 'text',
            text: `Window ${snap.resolvedWindowId} of ${snap.displayName} (${snap.width}x${snap.height} px).\n${snap.formattedText}`
          }
        ];
        if (snap.base64 && !args.text_only) {
          content.push({ type: 'image', data: snap.base64, mimeType: 'image/jpeg' });
        }
        return { content };
      }

      case 'app_ax_find': {
        const resolved = resolveAppIdentifier(args.app);
        let snap = session.appSnapshots.get(`${resolved.bundleId}:${args.window_id || 'main'}`) ||
                   session.appSnapshots.get(`${resolved.bundleId}:main`);
        if (!snap) {
          snap = await captureAppWindowState(args.app, {
            window_id: args.window_id,
            skipImage: true
          });
        }
        const roleFilter = args.role ? String(args.role).trim() : null;
        const titleFilter = args.title_contains ? String(args.title_contains).toLowerCase() : null;
        const matches = [];
        snap.axSummary.forEach((node, idx) => {
          if (roleFilter && node.role !== roleFilter) return;
          if (titleFilter && !String(node.title || '').toLowerCase().includes(titleFilter)) return;
          matches.push(formatAxElementLine(node, idx, snap.windowBounds));
        });
        if (matches.length === 0) {
          return textResult(`No elements matched in ${snap.axSummary.length} elements.`);
        }
        return textResult(`<ax-summary matches="${matches.length}">\n${matches.slice(0, 50).join('\n')}\n</ax-summary>`);
      }

      case 'app_click': {
        if (args.button === 'right') {
          return textResult('Right-clicking in background mode would bring the context menu to the front. Use app_menu or sky_perform_secondary_action ("AXShowMenu") instead.', true);
        }
        const res = await dispatchBackgroundAppAction(
          args.app,
          args.window_id,
          { kind: 'click', button: 'left', count: args.count || 1 },
          args
        );
        if (!res.ok) {
          return textResult(`Background click unsupported (${res.reasonCode}). Try element_index or display-scope left_click.`, true);
        }
        return textResult(`ok (${res.axOp} on ${res.role} via ${res.path})`);
      }

      case 'app_type': {
        const res = await dispatchBackgroundAppAction(
          args.app,
          args.window_id,
          {
            kind: 'type',
            text: String(args.text ?? ''),
            overwriteExisting: Boolean(args.overwrite_existing),
            mode: args.mode === 'replace' ? 'replace' : 'insert',
            disableSubstitutions: Boolean(args.disable_substitutions)
          },
          args
        );
        if (!res.ok) {
          return textResult(`Background app_type failed (${res.reasonCode}).`, true);
        }
        return textResult(`ok (${res.axOp} on ${res.role} via ${res.path})`);
      }

      case 'app_key': {
        const res = await dispatchBackgroundAppAction(
          args.app,
          args.window_id,
          { kind: 'key', combo: String(args.combo ?? '') },
          args
        );
        if (!res.ok) {
          return textResult(`Background app_key failed (${res.reasonCode}).`, true);
        }
        return textResult(`ok (key '${args.combo}' delivered via ${res.path})`);
      }

      case 'app_scroll': {
        const res = await dispatchBackgroundAppAction(
          args.app,
          args.window_id,
          { kind: 'scroll', dx: Number(args.dx || 0), dy: Number(args.dy || 0) },
          args
        );
        return textResult(res.ok ? `ok (scrolled via ${res.path})` : `scroll failed (${res.reasonCode})`, !res.ok);
      }

      case 'app_drag': {
        const resolved = resolveAppIdentifier(args.app);
        const toTarget = resolveAppTargetCoordinates(resolved.bundleId, args.window_id, { coordinate: args.to_coordinate });
        const res = await dispatchBackgroundAppAction(
          resolved.bundleId,
          args.window_id,
          { kind: 'drag', toWindowPt: toTarget.winLocalPt },
          { coordinate: args.coordinate }
        );
        return textResult(res.ok ? `ok (dragged via ${res.path})` : `drag failed (${res.reasonCode})`, !res.ok);
      }

      case 'app_menu': {
        const resolved = resolveAppIdentifier(args.app);
        const mode = Array.isArray(args.path) && args.path.length > 0 ? 'invoke' : 'list';
        const menuPath = mode === 'invoke' ? args.path : (args.list ? [args.list] : []);
        const res = await agyNativeHelper.call('appMenu', {
          app: resolved.bundleId,
          mode,
          path: menuPath
        }, 4000);
        return textResult(typeof res === 'string' ? res : JSON.stringify(res, null, 2));
      }

      case 'app_bring_to_current_space':
      case 'app_move_to_display': {
        const resolved = resolveAppIdentifier(args.app);
        const res = await agyNativeHelper.call('moveWindowToDisplay', {
          app: resolved.bundleId,
          window_id: args.window_id,
          display: args.display ?? (name === 'app_move_to_display' ? 'external' : 'main'),
          switch_to_desktop: args.switch_to_desktop !== false,
          space_id: args.space_id,
          other_space: Boolean(args.other_space),
          x: args.x,
          y: args.y
        }, 4500);
        appendCuaTrace({ kind: name, args, result: res });
        return textResult(JSON.stringify(res, null, 2), !res?.ok);
      }

      case 'app_batch': {
        const actions = Array.isArray(args.actions) ? args.actions : [];
        const out = [];
        for (let i = 0; i < actions.length; i++) {
          if (i > 0) await sleep(10);
          const step = actions[i];
          const res = await handleToolCall(`app_${step.action}`, {
            ...step,
            app: args.app,
            window_id: args.window_id ?? step.window_id
          });
          out.push({ type: 'text', text: `— app_batch[${i}] ${step.action}: ${res.isError ? 'STOPPED' : 'ok'} —` });
          if (res.content) out.push(...res.content);
          if (res.isError) return { content: out, isError: true };
        }
        return { content: out };
      }

      case 'app_release': {
        await agyNativeHelper.call('hideOverlay', {}).catch(() => {});
        return textResult('Released background app lock.');
      }

      // --- Stateful JS REPL & Accessibility Primitives ---
      case 'js':
        return await executeCuaReplJs(String(args.code || ''), Number(args.timeout_ms || 30000));

      case 'js_reset':
        session.replContext = null;
        return textResult('cua_repl JavaScript kernel reset.');

      case 'sky_select_text': {
        const { sky } = createSkyAndCuaBindings({ write() {}, async emitImage() {} });
        await sky.select_text(args);
        return textResult(`Selected '${args.text}' (${args.selection_type || 'text'}) in element [${args.element_index}].`);
      }

      case 'sky_perform_secondary_action': {
        const { sky } = createSkyAndCuaBindings({ write() {}, async emitImage() {} });
        await sky.perform_secondary_action(args);
        return textResult(`Performed secondary action '${args.action}' on element [${args.element_index}].`);
      }

      case 'sky_paste': {
        const { sky } = createSkyAndCuaBindings({ write() {}, async emitImage() {} });
        await sky.paste(args);
        return textResult(`Pasted ${String(args.text || '').length} char(s) as ${args.format || 'text'} into ${args.app} and restored clipboard.`);
      }

      case 'teach_step': {
        let sx = 600, sy = 400;
        if (Array.isArray(args.anchor) && args.anchor.length === 2) {
          const pt = mapToScreenPoint(args.anchor[0], args.anchor[1]);
          sx = pt.x;
          sy = pt.y;
        }
        triggerDesktopOverlay(
          'display',
          'Antigravity Guided Walkthrough',
          sx,
          sy,
          args.explanation,
          Number(args.duration_ms || 5000)
        );
        return textResult(`Displayed walkthrough callout at (${sx}, ${sy}): "${args.explanation}"`);
      }

      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    return textResult(`CUA Error in ${name}: ${err.message || String(err)}`, true);
  } finally {
    releaseEscapeTrap();
  }
}

// ============================================================================
// 11. MCP JSON-RPC 2.0 Stdio Server Transport
// ============================================================================

function sendRpcMessage(msg) {
  const str = JSON.stringify(msg);
  process.stdout.write(str + '\n');
}

async function processRpcRequest(req) {
  if (!req || typeof req !== 'object') return;
  const { id, method, params } = req;

  if (method === 'initialize') {
    return sendRpcMessage({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: 'antigravity-computer-use',
          version: '2.0.0'
        },
        instructions: 'macOS Computer Use MCP server providing display-scope input & capture, per-app background Accessibility automation, stateful AX tree diffing, and a persistent `js` REPL.'
      }
    });
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    return;
  }

  if (method === 'ping') {
    return sendRpcMessage({ jsonrpc: '2.0', id, result: {} });
  }

  if (method === 'tools/list') {
    return sendRpcMessage({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS }
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    const result = await handleToolCall(toolName, toolArgs);
    return sendRpcMessage({
      jsonrpc: '2.0',
      id,
      result
    });
  }

  if (id !== undefined) {
    sendRpcMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  }
}

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  while (true) {
    // Support Content-Length header framing if used
    if (stdinBuffer.startsWith('Content-Length:')) {
      const headerEnd = stdinBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = stdinBuffer.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        stdinBuffer = stdinBuffer.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(match[1], 10);
      const totalNeeded = headerEnd + 4 + len;
      if (Buffer.byteLength(stdinBuffer, 'utf8') < totalNeeded) break;
      const bodyBuf = Buffer.from(stdinBuffer, 'utf8').subarray(headerEnd + 4, totalNeeded);
      stdinBuffer = Buffer.from(stdinBuffer, 'utf8').subarray(totalNeeded).toString('utf8');
      try {
        processRpcRequest(JSON.parse(bodyBuf.toString('utf8')));
      } catch (_) {}
      continue;
    }

    const nlIdx = stdinBuffer.indexOf('\n');
    if (nlIdx === -1) break;
    const line = stdinBuffer.slice(0, nlIdx).trim();
    stdinBuffer = stdinBuffer.slice(nlIdx + 1);
    if (!line) continue;
    try {
      processRpcRequest(JSON.parse(line));
    } catch (_) {}
  }
});
