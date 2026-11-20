#!/usr/bin/env node
'use strict';

/**
 * Antigravity Safari Browser-Use MCP Server (`antigravity-safari-mcp.js`)
 *
 * Implements a high-speed, zero-popup browser automation harness for Apple Safari on macOS:
 * 1. AppleEvents / JXA (Safari.sdef) for instant tab management, zero-JS readable text
 *    extraction (tab.text() in 2ms), raw HTML (tab.source()), and URL navigation without focus theft.
 * 2. Native WebKit Accessibility (AXWebArea via antigravity-cua-native) for interactive
 *    DOM tree walking, stateful token-saving diffing (<ax-diff status="unchanged" />),
 *    and background element actuation (AXPress, kAXValueAttribute, CGEvent mouse/keyboard events).
 * 3. ScreenCaptureKit window capture for fast, zero-flashing visual feedback <= 1568px.
 * 4. High-level browser automation tools (tabs_context_mcp, read_page, find_elements,
 *    get_page_text, browser_batch, browser_js).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function resolveChromeDevToolsMcpSrcDir() {
  const roots = [
    process.env.CHROME_DEVTOOLS_MCP_ROOT,
    path.join(__dirname, '..', 'node_modules', 'chrome-devtools-mcp'),
    path.join(__dirname, 'node_modules', 'chrome-devtools-mcp'),
    path.join(os.homedir(), '.gemini', 'bin', 'node_modules', 'chrome-devtools-mcp')
  ].filter(Boolean);
  try {
    roots.push(path.dirname(require.resolve('chrome-devtools-mcp/package.json')));
  } catch (_) {}
  const npxDir = path.join(os.homedir(), '.npm', '_npx');
  if (fs.existsSync(npxDir)) {
    for (const entry of fs.readdirSync(npxDir)) {
      roots.push(path.join(npxDir, entry, 'node_modules', 'chrome-devtools-mcp'));
    }
  }
  for (const r of roots) {
    for (const rel of [path.join('out', 'Default', 'gen', 'src'), path.join('build', 'src')]) {
      const srcDir = path.join(r, rel);
      if (fs.existsSync(path.join(srcDir, 'index.js'))) return srcDir;
    }
  }
  throw new Error('Could not locate chrome-devtools-mcp module dependencies. Run "npm install" or set CHROME_DEVTOOLS_MCP_ROOT.');
}

const NATIVE_HELPER_BIN = path.join(__dirname, 'antigravity-cua-native');

function callAgyNativeHelper(method, params = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const bin = fs.existsSync(NATIVE_HELPER_BIN)
      ? NATIVE_HELPER_BIN
      : path.join(os.homedir(), '.gemini', 'bin', 'antigravity-cua-native');

    const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let lineBuf = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch (_) {}
      reject(new Error(`Native helper timed out after ${timeoutMs}ms on method=${method}`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      lineBuf += d.toString('utf8');
      let nl;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { proc.kill(); } catch (_) {}
          resolve(msg.result || {});
          return;
        } catch (_) {}
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
  });
}

function runSafariJxa(script, timeoutMs = 5000) {
  const wrapped = `
    const safari = Application("Safari");
    if (!safari.running()) {
      safari.launch();
      delay(0.5);
    }
    (() => {
      ${script}
    })();
  `;
  try {
    const out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', wrapped], {
      encoding: 'utf8',
      timeout: timeoutMs
    });
    return out.trim();
  } catch (err) {
    throw new Error(`Safari JXA execution failed: ${err.message || String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Tab & Window Management via Safari.sdef
// ---------------------------------------------------------------------------

let selectedSafariPageIndex = 1; // 1-based page index
const tabMarks = new Map(); // pageIndex -> 'deliverable' | 'handoff'
const uidMap = new Map(); // uid -> node
const snapshotHistoryByPage = new Map();

function getSafariTabs() {
  const script = `
    const out = [];
    const wins = safari.windows();
    let globalIdx = 1;
    for (let wIdx = 0; wIdx < wins.length; wIdx++) {
      const w = wins[wIdx];
      const currentTab = w.currentTab();
      const tabs = w.tabs();
      for (let tIdx = 0; tIdx < tabs.length; tIdx++) {
        const t = tabs[tIdx];
        out.push({
          pageIndex: globalIdx++,
          windowIndex: wIdx,
          tabIndex: tIdx,
          title: t.name() || "",
          url: t.url() || "",
          active: Boolean(currentTab && t.index() === currentTab.index())
        });
      }
    }
    return JSON.stringify(out);
  `;
  const raw = runSafariJxa(script);
  try {
    return JSON.parse(raw);
  } catch (_) {
    return [];
  }
}

function getSafariTargetTab(pageIdInput) {
  const tabs = getSafariTabs();
  if (tabs.length === 0) {
    // Open a blank tab if Safari has no windows
    runSafariJxa(`safari.Document().make();`);
    return getSafariTabs()[0];
  }
  const idx = typeof pageIdInput === 'number' && pageIdInput > 0 ? pageIdInput : selectedSafariPageIndex;
  const match = tabs.find(t => t.pageIndex === idx) || tabs.find(t => t.active) || tabs[0];
  if (match) selectedSafariPageIndex = match.pageIndex;
  return match;
}

// ---------------------------------------------------------------------------
// 2. Accessibility Tree Snapshot via WebKit AXWebArea
// ---------------------------------------------------------------------------

function formatNodeToSnapshotLine(node) {
  const parts = [`uid=${node.uid}`, node.role || 'generic'];
  if (node.title) {
    const escaped = String(node.title).replace(/\s+/g, ' ').trim();
    parts.push(`"${escaped}"`);
  }
  if (node.subrole) parts.push(`subrole=${node.subrole}`);
  if (node.value !== undefined && node.value !== '') {
    parts.push(`value="${String(node.value).replace(/\s+/g, ' ').slice(0, 80)}"`);
  }
  if (node.actions && Array.isArray(node.actions) && node.actions.length > 0) {
    if (!(node.actions.length === 1 && node.actions[0] === 'AXPress' && (node.role === 'AXButton' || node.role === 'AXLink'))) {
      parts.push(`actions=[${node.actions.join(',')}]`);
    }
  }
  if (typeof node.x === 'number') {
    parts.push(`(${node.x},${node.y} ${node.w}x${node.h})`);
  }
  return `  ${parts.join(' ')}`;
}

async function takeSafariSnapshot(pageIdInput) {
  const target = getSafariTargetTab(pageIdInput);
  if (target) {
    selectedSafariPageIndex = target.pageIndex;
    const script = `
      const wins = safari.windows();
      if (wins[${target.windowIndex}]) {
        const w = wins[${target.windowIndex}];
        const tabs = w.tabs();
        if (tabs[${target.tabIndex}]) {
          w.currentTab = tabs[${target.tabIndex}];
        }
      }
    `;
    try { runSafariJxa(script); } catch (_) {}
  }
  const axRes = await callAgyNativeHelper('walkAxTree', {
    app: 'com.apple.Safari',
    maxNodes: 350
  });

  const rawSummary = Array.isArray(axRes?.axSummary) ? axRes.axSummary : [];
  uidMap.clear();

  let uidCounter = 0;
  const nodes = [];
  const lines = [
    `uid=root WebArea "${String(target?.title || '').replace(/"/g, "'")}" url="${target?.url || ''}"`
  ];

  for (const item of rawSummary) {
    const uidStr = `e${uidCounter++}`;
    const nodeObj = {
      uid: uidStr,
      role: item.role || '',
      subrole: item.subrole || '',
      title: item.title || '',
      value: item.value,
      actions: item.actions || [],
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h
    };
    uidMap.set(uidStr, nodeObj);
    nodes.push(nodeObj);
    lines.push(formatNodeToSnapshotLine(nodeObj));
  }

  return {
    url: target?.url || '',
    title: target?.title || '',
    nodes,
    formattedSnapshot: lines.join('\n')
  };
}

function captureSafariWindowScreenshot(maxDim = 1568, quality = 78) {
  const tmpOut = path.join(os.tmpdir(), `safari-shot-${process.pid}-${Date.now()}.jpg`);
  try {
    const script = `
      const wins = safari.windows();
      return wins.length > 0 ? wins[0].id() : 0;
    `;
    const winId = parseInt(runSafariJxa(script), 10) || 0;
    if (winId > 0) {
      execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(winId), '-t', 'jpg', tmpOut], {
        timeout: 4000
      });
      execFileSync('/usr/bin/sips', [
        '-Z', String(maxDim),
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', String(quality),
        tmpOut
      ], { stdio: 'ignore', timeout: 3000 });
      const buf = fs.readFileSync(tmpOut);
      return { base64: buf.toString('base64'), mimeType: 'image/jpeg', buffer: buf };
    }
  } catch (_) {} finally {
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  }

  // Fallback to display capture
  const dispOut = path.join(os.tmpdir(), `safari-disp-${process.pid}-${Date.now()}.jpg`);
  try {
    execFileSync('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', dispOut], { timeout: 4000 });
    execFileSync('/usr/bin/sips', [
      '-Z', String(maxDim),
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(quality),
      dispOut
    ], { stdio: 'ignore', timeout: 3000 });
    const buf = fs.readFileSync(dispOut);
    return { base64: buf.toString('base64'), mimeType: 'image/jpeg', buffer: buf };
  } finally {
    try { fs.unlinkSync(dispOut); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 3. Diff & Filter Utilities
// ---------------------------------------------------------------------------

function formatCompactSnapshotLines(rawText) {
  return String(rawText || '')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(Boolean);
}

function computeSnapshotDiff(prevLines, currLines) {
  const prevSet = new Set(prevLines);
  const currSet = new Set(currLines);
  const added = currLines.filter(l => !prevSet.has(l));
  const removed = prevLines.filter(l => !currSet.has(l));
  return { added, removed };
}

const INTERACTIVE_SAFARI_ROLES = new Set([
  'AXButton', 'AXLink', 'AXTextField', 'AXTextArea', 'AXCheckBox',
  'AXRadioButton', 'AXPopUpButton', 'AXMenuButton', 'AXTab', 'AXHeading'
]);

function filterSnapshotLines(lines, { filter = 'all', maxDepth = 15, rootUid = null } = {}) {
  const result = [];
  let inSubtree = !rootUid;
  let subtreeBaseIndent = 0;

  for (const line of lines) {
    const leadingSpaces = line.match(/^(\s*)/)?.[1]?.length || 0;
    const depth = Math.floor(leadingSpaces / 2);

    if (rootUid) {
      if (!inSubtree) {
        if (line.includes(`uid=${rootUid} `) || line.endsWith(`uid=${rootUid}`)) {
          inSubtree = true;
          subtreeBaseIndent = leadingSpaces;
        } else {
          continue;
        }
      } else if (leadingSpaces <= subtreeBaseIndent && !line.includes(`uid=${rootUid}`)) {
        break;
      }
    }

    const effectiveDepth = rootUid ? Math.floor((leadingSpaces - subtreeBaseIndent) / 2) : depth;
    if (effectiveDepth > maxDepth) continue;

    if (filter === 'interactive') {
      const roleMatch = line.trim().match(/^uid=\S+\s+([a-zA-Z0-9_-]+)/);
      const role = roleMatch ? roleMatch[1] : '';
      if (effectiveDepth > 0 && !INTERACTIVE_SAFARI_ROLES.has(role)) {
        continue;
      }
    }
    result.push(line);
  }
  return result;
}

function parseCallToolText(res) {
  if (!res || !Array.isArray(res.content)) return '';
  return res.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

function extractSnapshotBody(fullToolText) {
  const marker = '## Latest page snapshot\n';
  const idx = fullToolText.indexOf(marker);
  if (idx !== -1) {
    return fullToolText.slice(idx + marker.length).trim();
  }
  return fullToolText.trim();
}

// ---------------------------------------------------------------------------
// 4. Main MCP Server Initialization
// ---------------------------------------------------------------------------

async function main() {
  const cdtSrcDir = resolveChromeDevToolsMcpSrcDir();
  const importFromCdt = (relPath) => import(pathToFileURL(path.join(cdtSrcDir, relPath)).href);

  await importFromCdt('utils/polyfill.js');
  const { StdioServerTransport, zod, McpServer: SdkMcpServer } = await importFromCdt('third_party/index.js');

  const server = new SdkMcpServer({
    name: 'safari_browser',
    title: 'Safari Browser MCP Server',
    version: '1.0.0'
  }, {
    capabilities: { logging: {}, tools: { listChanged: true } }
  });

  const customToolHandlers = new Map();
  function registerTool(name, description, schemaShape, readOnlyHint, handler) {
    customToolHandlers.set(name, handler);
    server.registerTool(
      name,
      {
        description,
        inputSchema: schemaShape,
        annotations: { readOnlyHint }
      },
      async (args) => handler(args || {})
    );
  }

  // Tool 1: list_pages
  registerTool(
    'list_pages',
    'List all open Safari windows and tabs with their pageId, title, URL, and active state.',
    {},
    true,
    async () => {
      const tabs = getSafariTabs();
      const lines = ['## Pages'];
      tabs.forEach(t => {
        const isSel = t.pageIndex === selectedSafariPageIndex;
        const mark = tabMarks.get(t.pageIndex);
        const markSuffix = mark ? ` [${mark}]` : '';
        lines.push(`${t.pageIndex}: ${t.url}${isSel ? ' [selected]' : ''}${markSuffix} (title=${JSON.stringify(t.title || '')})`);
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // Tool 2: tabs_context_mcp
  registerTool(
    'tabs_context_mcp',
    'Get full context overview of all currently open Safari tabs, active selection, and lifecycle marks.',
    {
      include_urls: zod.boolean().optional().describe('Include full URLs for all tabs (default true).')
    },
    true,
    async () => {
      const tabs = getSafariTabs();
      const target = getSafariTargetTab();
      const lines = ['## Pages'];
      tabs.forEach(t => {
        const isSel = t.pageIndex === selectedSafariPageIndex;
        const mark = tabMarks.get(t.pageIndex);
        const markSuffix = mark ? ` [${mark}]` : '';
        lines.push(`${t.pageIndex}: ${t.url}${isSel ? ' [selected]' : ''}${markSuffix} (title=${JSON.stringify(t.title || '')})`);
      });
      const header = `Profile mode: safari (driver=Safari.sdef+AXWebArea, totalTabs=${tabs.length}, selectedPageIndex=${selectedSafariPageIndex}, activeTitle=${JSON.stringify(target?.title || '')})`;
      return { content: [{ type: 'text', text: `${header}\n\n${lines.join('\n')}` }] };
    }
  );

  // Tool 3: select_page
  registerTool(
    'select_page',
    'Select a Safari tab by its pageId and bring it to front.',
    {
      pageId: zod.number().describe('1-based page index from list_pages / tabs_context_mcp.'),
      bringToFront: zod.boolean().optional().describe('Bring Safari window to front (default false).')
    },
    false,
    async (args) => {
      const target = getSafariTargetTab(args.pageId);
      selectedSafariPageIndex = target.pageIndex;
      const script = `
        const wins = safari.windows();
        if (wins[${target.windowIndex}]) {
          const w = wins[${target.windowIndex}];
          const tabs = w.tabs();
          if (tabs[${target.tabIndex}]) {
            w.currentTab = tabs[${target.tabIndex}];
            ${args.bringToFront ? 'safari.activate();' : ''}
          }
        }
      `;
      runSafariJxa(script);
      return { content: [{ type: 'text', text: `Selected Safari page ${target.pageIndex}: ${target.url}` }] };
    }
  );

  // Tool 4: new_page
  registerTool(
    'new_page',
    'Open a new tab in Safari with the specified URL.',
    {
      url: zod.string().optional().describe('URL to navigate to (default "about:blank").'),
      background: zod.boolean().optional().describe('Open tab in background (default false).')
    },
    false,
    async (args) => {
      const url = args.url || 'about:blank';
      const script = `
        const wins = safari.windows();
        const w = wins[0] || safari.Document().make();
        const t = safari.Tab({ url: ${JSON.stringify(url)} });
        w.tabs.push(t);
        ${!args.background ? 'w.currentTab = t;' : ''}
      `;
      runSafariJxa(script);
      const tabs = getSafariTabs();
      selectedSafariPageIndex = tabs.length;
      return { content: [{ type: 'text', text: `Opened new Safari tab (${selectedSafariPageIndex}): ${url}` }] };
    }
  );

  // Tool 5: close_page
  registerTool(
    'close_page',
    'Close a Safari tab by its pageId.',
    {
      pageId: zod.number().optional().describe('Target page index. Omit for currently selected tab.')
    },
    false,
    async (args) => {
      const target = getSafariTargetTab(args.pageId);
      const script = `
        const wins = safari.windows();
        if (wins[${target.windowIndex}]) {
          const tabs = wins[${target.windowIndex}].tabs();
          if (tabs[${target.tabIndex}]) tabs[${target.tabIndex}].close();
        }
      `;
      runSafariJxa(script);
      return { content: [{ type: 'text', text: `Closed Safari page ${target.pageIndex}` }] };
    }
  );

  // Tool 6: navigate_page
  registerTool(
    'navigate_page',
    'Navigate a Safari tab to a URL or trigger history back/forward/reload.',
    {
      pageId: zod.number().optional().describe('Target page index. Omit for currently selected tab.'),
      type: zod.enum(['url', 'back', 'forward', 'reload']).optional().describe('Navigation type (default "url").'),
      url: zod.string().optional().describe('Target URL when type is "url".')
    },
    false,
    async (args) => {
      const target = getSafariTargetTab(args.pageId);
      const navType = args.type || 'url';
      if (navType === 'url') {
        if (!args.url) throw new Error('url is required for navigate_page with type="url"');
        const script = `
          const wins = safari.windows();
          if (wins[${target.windowIndex}]) {
            const w = wins[${target.windowIndex}];
            const tabs = w.tabs();
            if (tabs[${target.tabIndex}]) {
              tabs[${target.tabIndex}].url = ${JSON.stringify(args.url)};
              w.currentTab = tabs[${target.tabIndex}];
            }
          }
        `;
        runSafariJxa(script);
        return { content: [{ type: 'text', text: `Navigated Safari page ${target.pageIndex} to ${args.url}` }] };
      }
      if (navType === 'back') {
        await callAgyNativeHelper('dispatchRaw', { app: 'com.apple.Safari', key: 'LeftArrow', modifiers: ['Command'] });
        return { content: [{ type: 'text', text: `Triggered history.back() in Safari page ${target.pageIndex}` }] };
      }
      if (navType === 'forward') {
        await callAgyNativeHelper('dispatchRaw', { app: 'com.apple.Safari', key: 'RightArrow', modifiers: ['Command'] });
        return { content: [{ type: 'text', text: `Triggered history.forward() in Safari page ${target.pageIndex}` }] };
      }
      if (navType === 'reload') {
        await callAgyNativeHelper('dispatchRaw', { app: 'com.apple.Safari', key: 'r', modifiers: ['Command'] });
        return { content: [{ type: 'text', text: `Reloaded Safari page ${target.pageIndex}` }] };
      }
    }
  );

  // Tool 7: get_page_text
  registerTool(
    'get_page_text',
    'Extract clean readable article/page text from Safari without DOM/script clutter in ~2ms via native Safari.sdef tab.text().',
    {
      pageId: zod.number().optional().describe('Target page index. Omit for currently selected tab.'),
      max_chars: zod.number().min(500).max(200000).optional().describe('Maximum characters to return (default 40000).')
    },
    true,
    async (args) => {
      const target = getSafariTargetTab(args.pageId);
      const maxChars = args.max_chars ?? 40000;
      const script = `
        const wins = safari.windows();
        if (wins[${target.windowIndex}]) {
          const tabs = wins[${target.windowIndex}].tabs();
          if (tabs[${target.tabIndex}]) return tabs[${target.tabIndex}].text() || "";
        }
        return "";
      `;
      let text = runSafariJxa(script);
      if (text.length > maxChars) {
        text = text.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars]`;
      }
      return { content: [{ type: 'text', text }] };
    }
  );

  // Tool 8: take_snapshot
  registerTool(
    'take_snapshot',
    'Capture full accessibility tree snapshot of the active Safari tab with uid handles for clicking and typing.',
    {
      pageId: zod.number().optional().describe('Target page index. Omit for currently selected tab.'),
      filePath: zod.string().optional().describe('Optional local file path to save snapshot to.')
    },
    true,
    async (args) => {
      const snap = await takeSafariSnapshot(args.pageId);
      if (args.filePath) {
        fs.writeFileSync(args.filePath, snap.formattedSnapshot, 'utf8');
        return { content: [{ type: 'text', text: `Saved snapshot (${snap.nodes.length} nodes) to ${args.filePath}` }] };
      }
      return {
        content: [{ type: 'text', text: `## Latest page snapshot\n${snap.formattedSnapshot}` }]
      };
    }
  );

  // Tool 9: read_page
  registerTool(
    'read_page',
    'Read the accessibility tree snapshot of Safari with optional interactive-only filtering, depth limit, subtree uid focus, and token-saving diff mode.',
    {
      pageId: zod.number().optional().describe('Target page index. Omit for currently selected tab.'),
      filter: zod.enum(['all', 'interactive']).optional().describe('Filter elements: "interactive" for buttons/links/inputs only, or "all" (default "all").'),
      depth: zod.number().min(1).max(40).optional().describe('Maximum tree depth to traverse (default 15).'),
      uid: zod.string().optional().describe('Optional parent element uid to scope snapshot.'),
      diff: zod.boolean().optional().describe('Return only changed elements relative to previous snapshot (default false).'),
      max_chars: zod.number().min(500).max(200000).optional().describe('Maximum characters to return (default 45000).')
    },
    true,
    async (args) => {
      const snap = await takeSafariSnapshot(args.pageId);
      const allLines = formatCompactSnapshotLines(snap.formattedSnapshot);
      const filteredLines = filterSnapshotLines(allLines, {
        filter: args.filter || 'all',
        maxDepth: args.depth ?? 15,
        rootUid: args.uid || null
      });

      const pageKey = `safari:${args.pageId ?? selectedSafariPageIndex}:${args.filter || 'all'}:${args.uid || 'root'}`;
      const prev = snapshotHistoryByPage.get(pageKey);
      snapshotHistoryByPage.set(pageKey, {
        lines: filteredLines,
        timestamp: Date.now()
      });

      let outputText;
      if (args.diff && prev && prev.lines.length > 0) {
        const { added, removed } = computeSnapshotDiff(prev.lines, filteredLines);
        if (added.length === 0 && removed.length === 0) {
          outputText = `<ax-diff status="unchanged" total="${filteredLines.length}" />`;
        } else if (added.length + removed.length < filteredLines.length * 0.75) {
          const parts = [`<ax-diff added_or_changed="${added.length}" removed="${removed.length}" total="${filteredLines.length}">`];
          if (added.length > 0) parts.push(`+ Added/Changed:\n${added.join('\n')}`);
          if (removed.length > 0) parts.push(`- Removed (${removed.length}):\n${removed.slice(0, 25).join('\n')}`);
          parts.push('</ax-diff>');
          outputText = parts.join('\n');
        } else {
          outputText = filteredLines.join('\n');
        }
      } else {
        outputText = filteredLines.join('\n');
      }

      const maxChars = args.max_chars ?? 45000;
      if (outputText.length > maxChars) {
        outputText = outputText.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars]`;
      }
      return { content: [{ type: 'text', text: outputText }] };
    }
  );

  // Tool 10: find_elements
  registerTool(
    'find_elements',
    'Search for elements in Safari by query text, role, or title. Returns up to 20 matching elements with uid handles.',
    {
      query: zod.string().describe('Text, role, or purpose to search for (e.g. "search bar", "login", "submit").'),
      pageId: zod.number().optional().describe('Target page index. Omit for currently selected tab.')
    },
    true,
    async (args) => {
      const snap = await takeSafariSnapshot(args.pageId);
      const terms = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const scored = [];

      for (const node of snap.nodes) {
        let score = 0;
        const haystack = `${node.role} ${node.title} ${node.value || ''}`.toLowerCase();
        for (const t of terms) {
          if (haystack.includes(t)) score += 2;
        }
        if (score > 0) {
          if (INTERACTIVE_SAFARI_ROLES.has(node.role)) score += 1;
          scored.push({ line: formatNodeToSnapshotLine(node).trim(), score });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 20).map(s => s.line);
      const summary = top.length > 0
        ? `Found ${scored.length} matching element(s) in Safari:\n${top.join('\n')}`
        : `No elements matched query "${args.query}" in Safari.`;
      return { content: [{ type: 'text', text: summary }] };
    }
  );

  // Tool 11: take_screenshot
  registerTool(
    'take_screenshot',
    'Capture a visual screenshot of the Safari window in the background downscaled to <= 1568px JPEG.',
    {
      pageId: zod.number().optional().describe('Target page index. Omit for currently selected tab.'),
      quality: zod.number().min(1).max(100).optional().describe('JPEG compression quality (default 78).'),
      filePath: zod.string().optional().describe('Optional local file path to save screenshot.')
    },
    true,
    async (args) => {
      const shot = captureSafariWindowScreenshot(1568, args.quality || 78);
      if (args.filePath) {
        fs.writeFileSync(args.filePath, shot.buffer);
        return { content: [{ type: 'text', text: `Saved Safari screenshot to ${args.filePath}` }] };
      }
      return {
        content: [
          { type: 'text', text: `Captured screenshot of Safari page ${selectedSafariPageIndex}.` },
          { type: 'image', data: shot.base64, mimeType: shot.mimeType }
        ]
      };
    }
  );

  // Tool 12: click
  registerTool(
    'click',
    'Click an element in Safari by its uid handle or screen coordinates.',
    {
      uid: zod.string().optional().describe('Element uid from take_snapshot / read_page (e.g. "e3").'),
      x: zod.number().optional().describe('Optional explicit X coordinate.'),
      y: zod.number().optional().describe('Optional explicit Y coordinate.')
    },
    false,
    async (args) => {
      let clickX = args.x;
      let clickY = args.y;
      if (args.uid && uidMap.has(args.uid)) {
        const node = uidMap.get(args.uid);
        if (typeof node.x === 'number') {
          clickX = Math.round(node.x + node.w / 2);
          clickY = Math.round(node.y + node.h / 2);
        }
      }
      if (typeof clickX === 'number' && typeof clickY === 'number') {
        await callAgyNativeHelper('dispatchRaw', {
          app: 'com.apple.Safari',
          click: { x: clickX, y: clickY, button: 'left', count: 1 }
        });
        return { content: [{ type: 'text', text: `Clicked Safari element ${args.uid || ''} at (${clickX}, ${clickY})` }] };
      }
      throw new Error(`Could not resolve coordinates for click (uid=${args.uid})`);
    }
  );

  // Tool 13: fill
  registerTool(
    'fill',
    'Set text value of an input field in Safari by uid.',
    {
      uid: zod.string().describe('Target element uid.'),
      value: zod.string().describe('Text to enter into the field.')
    },
    false,
    async (args) => {
      if (!uidMap.has(args.uid)) {
        await takeSafariSnapshot();
      }
      const node = uidMap.get(args.uid);
      if (node && typeof node.x === 'number') {
        const clickX = Math.round(node.x + node.w / 2);
        const clickY = Math.round(node.y + node.h / 2);
        // Click to focus and type
        await callAgyNativeHelper('dispatchRaw', {
          app: 'com.apple.Safari',
          click: { x: clickX, y: clickY, button: 'left', count: 1 }
        });
        await new Promise(r => setTimeout(r, 60));
        await callAgyNativeHelper('dispatchRaw', {
          app: 'com.apple.Safari',
          typeText: String(args.value ?? '')
        });
        return { content: [{ type: 'text', text: `Filled Safari element ${args.uid} with "${args.value}"` }] };
      }
      throw new Error(`Element ${args.uid} not found in Safari`);
    }
  );

  // Tool 14: press_key
  registerTool(
    'press_key',
    'Press a keyboard key in Safari (e.g. "Return", "Tab", "Escape", "ArrowDown").',
    {
      key: zod.string().describe('Key name to press.')
    },
    false,
    async (args) => {
      await callAgyNativeHelper('dispatchRaw', {
        app: 'com.apple.Safari',
        key: args.key
      });
      return { content: [{ type: 'text', text: `Pressed key "${args.key}" in Safari` }] };
    }
  );

  // Tool 15: evaluate_script
  registerTool(
    'evaluate_script',
    'Execute JavaScript in the active Safari tab via Safari.sdef doJavaScript command.',
    {
      pageId: zod.number().optional().describe('Target page index. Omit for currently selected tab.'),
      function: zod.string().describe('JavaScript code to evaluate in the tab.')
    },
    false,
    async (args) => {
      const target = getSafariTargetTab(args.pageId);
      const code = String(args.function || '');
      const script = `
        const wins = safari.windows();
        if (wins[${target.windowIndex}]) {
          const tabs = wins[${target.windowIndex}].tabs();
          if (tabs[${target.tabIndex}]) {
            try {
              const res = safari.doJavaScript(${JSON.stringify(code)}, { in: tabs[${target.tabIndex}] });
              return JSON.stringify({ ok: true, value: res });
            } catch (err) {
              return JSON.stringify({ ok: false, error: err.message || String(err) });
            }
          }
        }
        return JSON.stringify({ ok: false, error: "Tab not found" });
      `;
      let res;
      try {
        res = JSON.parse(runSafariJxa(script));
      } catch (err) {
        res = { ok: false, error: err.message };
      }
      if (!res.ok) {
        if (String(res.error).includes('Allow JavaScript from Apple Events')) {
          return {
            content: [{
              type: 'text',
              text: `JavaScript execution in Safari requires enabling "Allow JavaScript from Apple Events": Open Safari -> Settings (Cmd+,) -> Developer -> Check "Allow JavaScript from Apple Events". Alternatively, use get_page_text, take_snapshot, or click which work without this toggle.`
            }],
            isError: true
          };
        }
        return { content: [{ type: 'text', text: `Safari JS Error: ${res.error}` }], isError: true };
      }
      return {
        content: [{ type: 'text', text: typeof res.value === 'string' ? res.value : JSON.stringify(res.value ?? null, null, 2) }]
      };
    }
  );

  // Tool 16: browser_batch
  registerTool(
    'browser_batch',
    'Execute a sequence of Safari browser tool steps in a single MCP round-trip with automatic error short-circuiting.',
    {
      steps: zod.array(
        zod.object({
          tool: zod.string().describe('Tool name to call (e.g. "navigate_page", "click", "fill", "press_key", "read_page", "take_screenshot").'),
          args: zod.record(zod.string(), typeof zod.any === 'function' ? zod.any() : zod.unknown()).optional().describe('Arguments object.')
        })
      ).min(1).describe('Ordered list of Safari tool steps to execute.')
    },
    false,
    async (args) => {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      const outContent = [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const handler = customToolHandlers.get(step.tool);
        if (!handler) {
          outContent.push({ type: 'text', text: `Step ${i}: Unknown tool ${step.tool}` });
          return { content: outContent, isError: true };
        }
        const res = await handler(step.args || {});
        const ok = !res.isError;
        outContent.push({ type: 'text', text: `— steps[${i}] ${step.tool}: ${ok ? 'ok' : 'ERROR'} —` });
        if (Array.isArray(res.content)) outContent.push(...res.content);
        if (!ok) return { content: outContent, isError: true };
      }
      return { content: outContent };
    }
  );

  // Tool 17: browser_switch_profile
  registerTool(
    'browser_switch_profile',
    'Reports the active Safari browser profile mode.',
    {
      mode: zod.enum(['safari', 'main']).describe('Target browser mode.')
    },
    false,
    async () => {
      const tabs = getSafariTabs();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            browser: 'Safari',
            profileMode: 'safari',
            openTabs: tabs.length,
            selectedPageIndex: selectedSafariPageIndex
          }, null, 2)
        }]
      };
    }
  );

  // Tool 18: browser_js
  registerTool(
    'browser_js',
    'Execute JavaScript in a persistent Node REPL with Safari-bound `browser` and `tab` objects (`await tab.ax.write()`, `await tab.ax.click(uid)`, `await tab.goto(url)`, `await tab.getText()`, `await browser.tabs.list()`).',
    {
      code: zod.string().describe('JavaScript code to run (top-level await supported).')
    },
    false,
    async (args) => {
      const logs = [];
      const target = getSafariTargetTab();
      const tabBinding = {
        get pageId() { return selectedSafariPageIndex; },
        async goto(url) { return customToolHandlers.get('navigate_page')({ url }); },
        async getText() { return parseCallToolText(await customToolHandlers.get('get_page_text')({})); },
        markDeliverable() { tabMarks.set(selectedSafariPageIndex, 'deliverable'); return 'deliverable'; },
        markHandoff() { tabMarks.set(selectedSafariPageIndex, 'handoff'); return 'handoff'; },
        ax: {
          async write() {
            const res = await customToolHandlers.get('read_page')({ filter: 'interactive', diff: true });
            return parseCallToolText(res);
          },
          async click(uid) { return customToolHandlers.get('click')({ uid: String(uid) }); },
          async setValue(uid, val) { return customToolHandlers.get('fill')({ uid: String(uid), value: String(val) }); }
        }
      };

      const browserBinding = {
        tabs: {
          async list() { return parseCallToolText(await customToolHandlers.get('list_pages')({})); },
          async get(idx) { selectedSafariPageIndex = Number(idx); return tabBinding; }
        }
      };

      const context = vm.createContext({
        browser: browserBinding,
        tab: tabBinding,
        console: { log: (...a) => logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')) },
        Buffer,
        URL,
        setTimeout,
        clearTimeout
      });

      try {
        const wrapped = `(async () => {\n${args.code}\n})()`;
        const ret = await vm.runInContext(wrapped, context, { timeout: 30000 });
        if (ret !== undefined) logs.push(typeof ret === 'string' ? ret : JSON.stringify(ret, null, 2));
        return { content: [{ type: 'text', text: logs.join('\n') || 'ok' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Safari browser_js error: ${err.message}` }], isError: true };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[antigravity-safari-mcp] fatal error:', err);
  process.exit(1);
});
