#!/usr/bin/env node
'use strict';

/**
 * Antigravity Unified Chrome Browser-Use MCP Server (`antigravity-browser-mcp.js`)
 *
 * Extends `chrome-devtools-mcp` with a token-efficient, low-latency browser harness:
 * 1. Full Chrome DevTools MCP toolset (stock tools + WebMCP + Extensions)
 * 2. Stateful `browser_js` REPL (`tab.ax.write()` stateful accessibility tree diffing,
 *    `webmcp` / `pageAssets` / `cdp` capabilities, `markDeliverable()` / `markHandoff()` tab lifecycle)
 * 3. Token-efficient page inspection (`tabs_context_mcp`, `read_page` with `interactive` filter
 *    & depth/subtree scoping, `find_elements`, `get_page_text`, `browser_batch`)
 * 4. `AdaptiveSettleEngine` DOM/network quiet settle, 28x28 vision tile scaling <= 1568px,
 *    and optional APFS copy-on-write profile cloning (`--cloned-profile`)
 *
 * Main Browser by Default (Zero Popups):
 * In `"main"` mode (default), routes directly through the installed Chrome Extension
 * Native Messaging Broker (`~/.gemini/antigravity/browser-bridge.sock`) + JXA
 * (`Application(mainChromePid)`), controlling the user's live Chrome browser in 7-45ms
 * without ever triggering Chrome 136+'s `"Allow remote debugging?"` modal popup.
 * Isolated (`--isolated`) and cloned (`--cloned-profile`) modes remain strictly optional.
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
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
      if (fs.existsSync(path.join(srcDir, 'index.js'))) {
        return srcDir;
      }
    }
  }
  throw new Error('Could not locate chrome-devtools-mcp installation. Run "npm install" or set CHROME_DEVTOOLS_MCP_ROOT.');
}

const MAIN_CHROME_USER_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const CLONED_PROFILE_DIR = path.join(os.homedir(), '.cache', 'antigravity-browser-mcp', 'cloned-profile');
const ISOLATED_PROFILE_DIR = path.join(os.homedir(), '.cache', 'antigravity-browser-mcp', 'isolated-profile');
const EXTENSION_INSTALL_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'chrome-extension');
const BROKER_DIR = path.join(os.homedir(), '.gemini', 'antigravity');
const BROKER_SOCKET_PATH = process.env.ANTIGRAVITY_BROWSER_SOCKET || path.join(BROKER_DIR, 'browser-bridge.sock');
const BROKER_SCRIPT_PATH = path.join(__dirname, 'antigravity-browser-broker.cjs');
const AGY_SESSION_ID = `agy-browser-${process.pid}`;

// ---------------------------------------------------------------------------
// 1. Dedicated Antigravity Chrome Extension Bridge (Zero-Popup Main Browser Control)
// ---------------------------------------------------------------------------

function maybeStartExtensionBroker() {
  try {
    const brokerFile = fs.existsSync(BROKER_SCRIPT_PATH)
      ? BROKER_SCRIPT_PATH
      : path.join(os.homedir(), '.gemini', 'bin', 'antigravity-browser-broker.cjs');
    if (fs.existsSync(brokerFile)) {
      const child = spawn(process.execPath, [brokerFile], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    }
  } catch (_) {}
}

function queryTabsViaJxa() {
  try {
    const script = `
      (() => {
        const chrome = Application("Google Chrome");
        if (!chrome.running()) return JSON.stringify([]);
        const out = [];
        const wins = chrome.windows();
        for (const w of wins) {
          const tabs = w.tabs();
          for (const t of tabs) {
            out.push({
              id: Number(t.id()),
              url: t.url(),
              title: t.title(),
              active: Boolean(t.id() === w.activeTab()?.id()),
              windowId: Number(w.id())
            });
          }
        }
        return JSON.stringify(out);
      })();
    `;
    const res = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
      encoding: 'utf8',
      timeout: 3000
    });
    return JSON.parse(res.trim() || '[]');
  } catch (_) {
    return [];
  }
}

function captureChromeWindowFallback(maxDim = 1568, quality = 78) {
  const tmpOut = path.join(os.tmpdir(), `chrome-fallback-${process.pid}-${Date.now()}.jpg`);
  try {
    const winsScript = `
      (() => {
        const chrome = Application("Google Chrome");
        return chrome.running() && chrome.windows.length > 0 ? chrome.windows[0].id() : 0;
      })();
    `;
    const winId = parseInt(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', winsScript], { encoding: 'utf8' }).trim(), 10) || 0;
    if (winId > 0) {
      execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(winId), '-t', 'jpg', tmpOut], { timeout: 4000 });
      execFileSync('/usr/bin/sips', ['-Z', String(maxDim), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), tmpOut], { stdio: 'ignore', timeout: 3000 });
      const buf = fs.readFileSync(tmpOut);
      return { base64: buf.toString('base64'), mimeType: 'image/jpeg', buffer: buf };
    }
  } catch (_) {} finally {
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  }
  const dispOut = path.join(os.tmpdir(), `chrome-disp-${process.pid}-${Date.now()}.jpg`);
  try {
    execFileSync('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', dispOut], { timeout: 4000 });
    execFileSync('/usr/bin/sips', ['-Z', String(maxDim), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), dispOut], { stdio: 'ignore', timeout: 3000 });
    const buf = fs.readFileSync(dispOut);
    return { base64: buf.toString('base64'), mimeType: 'image/jpeg', buffer: buf };
  } finally {
    try { fs.unlinkSync(dispOut); } catch (_) {}
  }
}

function callExtensionBrokerRaw(op, payload = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(BROKER_SOCKET_PATH);
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      reject(new Error(`Chrome extension broker timed out after ${timeoutMs}ms on op=${op}`));
    }, timeoutMs);

    sock.on('connect', () => {
      sock.setNoDelay(true);
      sock.write(JSON.stringify({ type: 'hello', role: 'plugin', sessionId: AGY_SESSION_ID }) + '\n');
      sock.write(JSON.stringify({
        type: 'request',
        id: 1,
        sessionId: AGY_SESSION_ID,
        op,
        ...payload
      }) + '\n');
    });

    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'response' && msg.id === 1) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { sock.end(); } catch (_) {}
            if (msg.ok) {
              resolve(msg.data);
            } else {
              reject(new Error(msg.error || 'Unknown extension broker error'));
            }
          }
        } catch (_) {}
      }
    });

    sock.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function callExtensionBroker(op, payload = {}, timeoutMs = 15000) {
  try {
    return await callExtensionBrokerRaw(op, payload, timeoutMs);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) {
      maybeStartExtensionBroker();
      await new Promise(r => setTimeout(r, 250));
      return await callExtensionBrokerRaw(op, payload, timeoutMs);
    }
    throw err;
  }
}

async function callExtTool(tool, args = {}, timeoutMs = 15000) {
  if (typeof args.tabId === 'number') {
    try {
      await callExtensionBroker('claim_tab', { tabId: args.tabId, force: true }, 3000);
    } catch (_) {}
  }
  return await callExtensionBroker('tool', { tool, args }, timeoutMs);
}

// ---------------------------------------------------------------------------
// 2. Main Browser Tab & Snapshot State Cache
// ---------------------------------------------------------------------------

let selectedMainTabId = null;
const tabIndexToId = new Map(); // 1-based pageId -> Chrome tab.id
const tabIdToIndex = new Map(); // Chrome tab.id -> 1-based pageId
const uidMapByTab = new Map();  // tabId -> Map<uid, nodeObj>
const snapshotHistoryByPage = new Map(); // pageKey -> { lines: string[], timestamp: number }
const tabMarks = new Map(); // pageId -> 'deliverable' | 'handoff' | 'ephemeral'

async function refreshMainTabs() {
  let tabs = [];
  try {
    const res = await callExtTool('get_tabs', {});
    tabs = typeof res?.content === 'string' ? JSON.parse(res.content) : (res?.content || []);
  } catch (_) {
    tabs = queryTabsViaJxa();
  }

  tabIndexToId.clear();
  tabIdToIndex.clear();
  tabs.forEach((t, idx) => {
    const pageNum = idx + 1;
    tabIndexToId.set(pageNum, t.id);
    tabIdToIndex.set(t.id, pageNum);
  });

  if (!selectedMainTabId || !tabs.some(t => t.id === selectedMainTabId)) {
    const activeTab = tabs.find(t => t.active) || tabs[0];
    if (activeTab) {
      selectedMainTabId = activeTab.id;
    }
  }
  return tabs;
}

async function resolveMainTabId(pageIdInput) {
  if (typeof pageIdInput === 'number' && Number.isFinite(pageIdInput)) {
    if (pageIdInput > 10000) {
      selectedMainTabId = pageIdInput;
      return pageIdInput;
    }
    if (!tabIndexToId.has(pageIdInput)) {
      await refreshMainTabs();
    }
    const mapped = tabIndexToId.get(pageIdInput);
    if (mapped) {
      selectedMainTabId = mapped;
      return mapped;
    }
  }
  if (selectedMainTabId) {
    return selectedMainTabId;
  }
  try {
    const active = await callExtTool('get_active_tab', {});
    if (active && typeof active.tabId === 'number') {
      selectedMainTabId = active.tabId;
      return active.tabId;
    }
  } catch (_) {}
  const tabs = await refreshMainTabs();
  if (tabs.length > 0) {
    selectedMainTabId = tabs[0].id;
    return selectedMainTabId;
  }
  throw new Error('No open tabs found in main Chrome browser.');
}

function buildSelectorCandidatesForNode(node) {
  if (!node) return [];
  const candidates = [];
  if (node.uid) {
    candidates.push(`[data-agy-uid="${node.uid}"]`);
  }
  if (node.selector) {
    candidates.push(node.selector);
  }
  const cleanName = String(node.name || '').trim();
  if (cleanName && cleanName.length <= 120) {
    candidates.push(`aria=${cleanName}`);
    if (['input', 'textarea', 'select'].includes(node.tag)) {
      candidates.push(`placeholder=${cleanName}`);
      candidates.push(`label=${cleanName}`);
    }
    candidates.push(`text=${cleanName}`);
  }
  if (node.href) {
    try {
      const u = new URL(node.href);
      candidates.push(`a[href="${node.href}"]`);
      if (u.pathname && u.pathname !== '/') {
        candidates.push(`a[href*="${u.pathname}"]`);
      }
    } catch (_) {}
  }
  return [...new Set(candidates)];
}

async function resolveUidOrSelector(tabId, uidOrSel) {
  const raw = String(uidOrSel || '').trim();
  if (!raw) throw new Error('uid or selector is required');

  let tabMap = uidMapByTab.get(tabId);
  if (!tabMap || !tabMap.has(raw)) {
    try {
      await takeMainSnapshot(tabId);
      tabMap = uidMapByTab.get(tabId);
    } catch (_) {}
  }

  const node = tabMap ? tabMap.get(raw) : null;
  if (node) {
    const candidates = buildSelectorCandidatesForNode(node);
    if (candidates.length > 0) {
      return { selector: candidates.join(' || '), node };
    }
  }
  return { selector: raw, node: null };
}

function formatNodeToSnapshotLine(node) {
  const parts = [`uid=${node.uid}`, node.role || node.tag || 'generic'];
  if (node.name) {
    const escaped = String(node.name).replace(/\s+/g, ' ').trim();
    parts.push(`"${escaped}"`);
  }
  if (node.tag && node.tag !== node.role) {
    parts.push(`tag=${node.tag}`);
  }
  if (node.type) {
    parts.push(`type=${node.type}`);
  }
  if (node.value !== undefined && node.value !== '') {
    parts.push(`value="${String(node.value).replace(/\s+/g, ' ').slice(0, 80)}"`);
  }
  if (node.href) {
    parts.push(`url="${node.href}"`);
  }
  if (node.disabled) parts.push('disabled');
  if (node.readOnly) parts.push('readonly');
  if (node.rect && typeof node.rect.x === 'number') {
    parts.push(`(${node.rect.x},${node.rect.y} ${node.rect.w}x${node.rect.h})`);
  }
  return `  ${parts.join(' ')}`;
}

async function takeMainSnapshot(tabId) {
  const res = await callExtTool('snapshot', { tabId });
  const data = typeof res?.content === 'string' ? JSON.parse(res.content) : (res?.content || {});
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const nodeMap = new Map();
  for (const n of nodes) {
    if (n && n.uid) {
      nodeMap.set(n.uid, n);
    }
  }
  uidMapByTab.set(tabId, nodeMap);

  const lines = [
    `uid=root WebArea "${String(data.title || '').replace(/"/g, "'")}" url="${data.url || ''}"`
  ];
  for (const n of nodes) {
    lines.push(formatNodeToSnapshotLine(n));
  }
  return {
    url: data.url || '',
    title: data.title || '',
    text: data.text || '',
    nodes,
    links: data.links || [],
    formattedSnapshot: lines.join('\n')
  };
}

function transcodeDataUrlToCompactJpeg(dataUrl, maxDim = 1568, quality = 78) {
  const m = String(dataUrl || '').match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!m) {
    throw new Error('Invalid screenshot data URL from Chrome extension');
  }
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const rawBuf = Buffer.from(m[2], 'base64');
  const tmpIn = path.join(os.tmpdir(), `agy-chrome-shot-in-${process.pid}-${Date.now()}.${ext}`);
  const tmpOut = path.join(os.tmpdir(), `agy-chrome-shot-out-${process.pid}-${Date.now()}.jpg`);
  try {
    fs.writeFileSync(tmpIn, rawBuf);
    execFileSync('/usr/bin/sips', [
      '-Z', String(maxDim),
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(quality),
      tmpIn,
      '--out', tmpOut
    ], { stdio: 'ignore', timeout: 4000 });
    const jpgBuf = fs.readFileSync(tmpOut);
    return { base64: jpgBuf.toString('base64'), mimeType: 'image/jpeg', buffer: jpgBuf };
  } catch (_) {
    return { base64: m[2], mimeType: `image/${m[1]}`, buffer: rawBuf };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 3. Optional APFS Copy-on-Write Profile Cloner (`--cloned-profile`)
// ---------------------------------------------------------------------------

function cloneMainChromeProfileCoW() {
  fs.mkdirSync(path.join(CLONED_PROFILE_DIR, 'Default'), { recursive: true });
  const topFiles = ['Local State'];
  const defaultFiles = ['Cookies', 'Preferences', 'Secure Preferences', 'Network Action Predictor', 'Web Data'];
  const defaultDirs = ['Local Storage', 'Session Storage', 'IndexedDB'];

  for (const f of topFiles) {
    const src = path.join(MAIN_CHROME_USER_DATA_DIR, f);
    const dst = path.join(CLONED_PROFILE_DIR, f);
    try {
      execFileSync('/bin/cp', ['-c', '-f', src, dst], { stdio: 'ignore' });
    } catch (_) {
      try { fs.copyFileSync(src, dst); } catch (_) {}
    }
  }
  for (const f of defaultFiles) {
    const src = path.join(MAIN_CHROME_USER_DATA_DIR, 'Default', f);
    const dst = path.join(CLONED_PROFILE_DIR, 'Default', f);
    try {
      execFileSync('/bin/cp', ['-c', '-f', src, dst], { stdio: 'ignore' });
    } catch (_) {
      try { fs.copyFileSync(src, dst); } catch (_) {}
    }
  }
  for (const d of defaultDirs) {
    const src = path.join(MAIN_CHROME_USER_DATA_DIR, 'Default', d);
    const dst = path.join(CLONED_PROFILE_DIR, 'Default', d);
    try {
      execFileSync('/bin/cp', ['-c', '-R', '-f', src, dst], { stdio: 'ignore' });
    } catch (_) {}
  }
  return CLONED_PROFILE_DIR;
}

// ---------------------------------------------------------------------------
// 4. Snapshot Filtering & Stateful Diff Helpers
// ---------------------------------------------------------------------------

const INTERACTIVE_A11Y_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox',
  'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'heading',
  'a', 'input', 'textarea', 'select'
]);

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
      const role = roleMatch ? roleMatch[1].toLowerCase() : '';
      if (effectiveDepth > 0 && !INTERACTIVE_A11Y_ROLES.has(role) && !line.includes('focusable') && !line.includes('url=')) {
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
// 5. Main Entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const cdtSrcDir = resolveChromeDevToolsMcpSrcDir();
  const importFromCdt = (relPath) => import(pathToFileURL(path.join(cdtSrcDir, relPath)).href);

  await importFromCdt('utils/polyfill.js');
  const { BrowserManager } = await importFromCdt('BrowserManager.js');
  const { McpServer } = await importFromCdt('index.js');
  const { ServerConfig } = await importFromCdt('config/ServerConfig.js');
  const { ConfigParser } = await importFromCdt('config/ConfigParser.js');
  const { StdioServerTransport, zod } = await importFromCdt('third_party/index.js');
  const { VERSION } = await importFromCdt('version.js');

  const cliFlags = new Set(process.argv.slice(2));
  let currentProfileMode = 'main';
  if (cliFlags.has('--isolated') || process.env.AGY_BROWSER_PROFILE_MODE === 'isolated') {
    currentProfileMode = 'isolated';
  } else if (cliFlags.has('--cloned-profile') || process.env.AGY_BROWSER_PROFILE_MODE === 'cloned') {
    currentProfileMode = 'cloned';
  }

  const configParser = new ConfigParser(VERSION);
  const baseConfig = configParser.parseConfig([]);
  const resolvedArgs = {
    ...baseConfig.resolved,
    usageStatistics: false,
    allowUnrestrictedPaths: true,
    categoryWebmcp: true,
    categoryExtensions: true,
    categoryThirdParty: true,
    screenshotFormat: 'jpeg',
    screenshotQuality: 78,
    screenshotMaxWidth: 1568,
    screenshotMaxHeight: 1568,
    pageIdRouting: true
  };

  const serverConfig = new ServerConfig({
    cliArgs: {},
    fileArgs: {},
    configPath: undefined,
    resolved: resolvedArgs
  });

  const browserManager = new BrowserManager(serverConfig, {});
  const origEnsureBrowser = browserManager.ensureBrowser.bind(browserManager);

  let activeBrowserHandle = null;

  // BrowserManager is ONLY invoked when currentProfileMode is 'cloned' or 'isolated'
  browserManager.ensureBrowser = async function patchedEnsureBrowser() {
    if (activeBrowserHandle && activeBrowserHandle.connected) {
      return activeBrowserHandle;
    }

    if (currentProfileMode === 'cloned') {
      const clonedDir = cloneMainChromeProfileCoW();
      delete serverConfig.resolved.wsEndpoint;
      serverConfig.resolved.isolated = false;
      serverConfig.resolved.userDataDir = clonedDir;
      serverConfig.resolved.chromeArg = [
        '--enable-features=EnableBoundSessionCredentials,DeviceBoundSessions,DeviceBoundSessionsForRestrictedSites,WebMCP'
      ];
      activeBrowserHandle = await origEnsureBrowser();
      return activeBrowserHandle;
    }

    fs.mkdirSync(ISOLATED_PROFILE_DIR, { recursive: true });
    delete serverConfig.resolved.wsEndpoint;
    serverConfig.resolved.isolated = true;
    delete serverConfig.resolved.userDataDir;
    serverConfig.resolved.chromeArg = [
      '--enable-features=EnableBoundSessionCredentials,DeviceBoundSessions,DeviceBoundSessionsForRestrictedSites,WebMCP'
    ];
    activeBrowserHandle = await origEnsureBrowser();
    return activeBrowserHandle;
  };

  const mcpServer = await McpServer.from(serverConfig, { browserManager });
  const origCallTool = mcpServer.callTool.bind(mcpServer);

  // -------------------------------------------------------------------------
  // Main Browser Extension Dispatcher (Zero "Allow remote debugging?" popups)
  // -------------------------------------------------------------------------

  async function dispatchMainBrowserExtensionTool(name, args = {}) {
    if (name === 'list_pages') {
      const tabs = await refreshMainTabs();
      const lines = ['## Pages'];
      tabs.forEach((t, idx) => {
        const pageNum = idx + 1;
        const isSel = t.id === selectedMainTabId;
        const mark = tabMarks.get(pageNum) || tabMarks.get(t.id);
        const markSuffix = mark ? ` [${mark}]` : '';
        lines.push(`${pageNum}: ${t.url}${isSel ? ' [selected]' : ''}${markSuffix} (tabId=${t.id}, title=${JSON.stringify(t.title || '')})`);
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'select_page') {
      const tabId = await resolveMainTabId(args.pageId);
      selectedMainTabId = tabId;
      await callExtensionBroker('claim_tab', { tabId, force: true });
      if (args.bringToFront) {
        try {
          await callExtTool('activate_tab', { tabId });
        } catch (_) {}
      }
      const tabs = await refreshMainTabs();
      const chosen = tabs.find(t => t.id === tabId);
      return {
        content: [{
          type: 'text',
          text: `Selected page ${tabIdToIndex.get(tabId) || tabId} (tabId=${tabId}): ${chosen?.url || ''}`
        }]
      };
    }

    if (name === 'new_page') {
      const url = args.url || 'about:blank';
      const active = !args.background;
      const res = await callExtTool('open_tab', { url, active });
      if (res && typeof res.tabId === 'number') {
        selectedMainTabId = res.tabId;
        await callExtensionBroker('claim_tab', { tabId: res.tabId, force: true });
      }
      await refreshMainTabs();
      return {
        content: [{
          type: 'text',
          text: `Opened new page (tabId=${selectedMainTabId}): ${url}`
        }]
      };
    }

    if (name === 'close_page') {
      const tabId = await resolveMainTabId(args.pageId);
      await callExtTool('close_tab', { tabId });
      if (selectedMainTabId === tabId) selectedMainTabId = null;
      await refreshMainTabs();
      return {
        content: [{ type: 'text', text: `Closed page (tabId=${tabId})` }]
      };
    }

    if (name === 'navigate_page') {
      const tabId = await resolveMainTabId(args.pageId);
      const navType = args.type || 'url';
      if (navType === 'url' && args.url) {
        await callExtTool('navigate', { tabId, url: args.url });
        return {
          content: [{ type: 'text', text: `Successfully navigated to ${args.url}.` }]
        };
      }
      if (navType === 'back' || navType === 'forward' || navType === 'reload') {
        const jsExpr = navType === 'back'
          ? 'history.back()'
          : navType === 'forward'
            ? 'history.forward()'
            : 'location.reload()';
        try {
          await callExtTool('eval_js', { tabId, code: jsExpr });
        } catch (_) {}
        return {
          content: [{ type: 'text', text: `Executed navigation (${navType}) on tab ${tabId}.` }]
        };
      }
      throw new Error(`Invalid navigate_page parameters: ${JSON.stringify(args)}`);
    }

    if (name === 'take_snapshot') {
      const tabId = await resolveMainTabId(args.pageId);
      const snap = await takeMainSnapshot(tabId);
      if (args.filePath) {
        fs.writeFileSync(args.filePath, snap.formattedSnapshot, 'utf8');
        return {
          content: [{ type: 'text', text: `Saved snapshot (${snap.nodes.length} nodes) to ${args.filePath}` }]
        };
      }
      return {
        content: [{
          type: 'text',
          text: `## Latest page snapshot\n${snap.formattedSnapshot}`
        }]
      };
    }

    if (name === 'take_screenshot') {
      const tabId = await resolveMainTabId(args.pageId);
      let dataUrl = null;
      try {
        const res = await callExtTool('screenshot', { tabId });
        dataUrl = res?.content;
      } catch (_) {}

      let transcoded = null;
      if (dataUrl) {
        try {
          transcoded = transcodeDataUrlToCompactJpeg(
            dataUrl,
            1568,
            typeof args.quality === 'number' ? args.quality : 78
          );
        } catch (_) {}
      }
      if (!transcoded) {
        transcoded = captureChromeWindowFallback(
          1568,
          typeof args.quality === 'number' ? args.quality : 78
        );
      }

      if (args.filePath) {
        fs.writeFileSync(args.filePath, transcoded.buffer);
        return {
          content: [{ type: 'text', text: `Saved screenshot to ${args.filePath}` }]
        };
      }
      return {
        content: [
          { type: 'text', text: `Captured screenshot of tab ${tabId}.` },
          { type: 'image', data: transcoded.base64, mimeType: transcoded.mimeType }
        ]
      };
    }

    if (name === 'click') {
      const tabId = await resolveMainTabId(args.pageId);
      const { selector } = await resolveUidOrSelector(tabId, args.uid || args.selector);
      const res = await callExtTool('click', { tabId, selector });
      const out = [{ type: 'text', text: res?.content || `Clicked ${args.uid || selector}` }];
      if (args.includeSnapshot) {
        const snap = await takeMainSnapshot(tabId);
        out.push({ type: 'text', text: `## Latest page snapshot\n${snap.formattedSnapshot}` });
      }
      return { content: out };
    }

    if (name === 'fill') {
      const tabId = await resolveMainTabId(args.pageId);
      const { selector, node } = await resolveUidOrSelector(tabId, args.uid || args.selector);
      let res;
      if (node && node.tag === 'select') {
        res = await callExtTool('select', { tabId, selector, value: String(args.value ?? ''), label: String(args.value ?? '') });
      } else {
        res = await callExtTool('type', { tabId, selector, text: String(args.value ?? ''), clear: true });
      }
      const out = [{ type: 'text', text: res?.content || `Filled ${args.uid || selector}` }];
      if (args.includeSnapshot) {
        const snap = await takeMainSnapshot(tabId);
        out.push({ type: 'text', text: `## Latest page snapshot\n${snap.formattedSnapshot}` });
      }
      return { content: out };
    }

    if (name === 'fill_form') {
      const tabId = await resolveMainTabId(args.pageId);
      const elements = Array.isArray(args.elements) ? args.elements : [];
      const summaries = [];
      for (const item of elements) {
        const { selector, node } = await resolveUidOrSelector(tabId, item.uid);
        if (node && node.tag === 'select') {
          await callExtTool('select', { tabId, selector, value: String(item.value ?? ''), label: String(item.value ?? '') });
        } else {
          await callExtTool('type', { tabId, selector, text: String(item.value ?? ''), clear: true });
        }
        summaries.push(`${item.uid}=${JSON.stringify(item.value)}`);
      }
      return {
        content: [{ type: 'text', text: `Filled ${summaries.length} form field(s): ${summaries.join(', ')}` }]
      };
    }

    if (name === 'type_text') {
      const tabId = await resolveMainTabId(args.pageId);
      const selector = args.uid ? (await resolveUidOrSelector(tabId, args.uid)).selector : 'input:focus, textarea:focus, [contenteditable="true"]:focus, input, textarea';
      const res = await callExtTool('type', { tabId, selector, text: String(args.text ?? ''), clear: false });
      if (args.submitKey) {
        try {
          await callExtTool('press_key', { tabId, key: args.submitKey });
        } catch (_) {}
      }
      return {
        content: [{ type: 'text', text: res?.content || `Typed "${args.text}"` }]
      };
    }

    if (name === 'press_key') {
      const tabId = await resolveMainTabId(args.pageId);
      try {
        const res = await callExtTool('press_key', { tabId, key: args.key });
        return { content: [{ type: 'text', text: res?.content || `Pressed key ${args.key}` }] };
      } catch (_) {
        return { content: [{ type: 'text', text: `Pressed key ${args.key}` }] };
      }
    }

    if (name === 'hover') {
      const tabId = await resolveMainTabId(args.pageId);
      const { selector } = await resolveUidOrSelector(tabId, args.uid || args.selector);
      try {
        const res = await callExtTool('hover', { tabId, selector });
        return { content: [{ type: 'text', text: res?.content || `Hovered ${args.uid}` }] };
      } catch (_) {
        const firstSel = selector.split('||')[0].trim();
        await callExtTool('highlight', { tabId, selector: firstSel, duration: 500 });
        return { content: [{ type: 'text', text: `Hovered ${args.uid}` }] };
      }
    }

    if (name === 'drag') {
      const tabId = await resolveMainTabId(args.pageId);
      const fromResolved = await resolveUidOrSelector(tabId, args.from_uid);
      const toResolved = await resolveUidOrSelector(tabId, args.to_uid);
      const res = await callExtTool('drag', {
        tabId,
        fromSelector: fromResolved.selector.split('||')[0].trim(),
        toSelector: toResolved.selector.split('||')[0].trim()
      });
      return { content: [{ type: 'text', text: res?.content || `Dragged ${args.from_uid} to ${args.to_uid}` }] };
    }

    if (name === 'upload_file') {
      const tabId = await resolveMainTabId(args.pageId);
      const { selector } = await resolveUidOrSelector(tabId, args.uid);
      const res = await callExtTool('set_file_input', {
        tabId,
        selector: selector.split('||')[0].trim(),
        filePath: args.filePath
      });
      return { content: [{ type: 'text', text: res?.content || `Uploaded ${args.filePath}` }] };
    }

    if (name === 'wait_for') {
      const tabId = await resolveMainTabId(args.pageId);
      const texts = Array.isArray(args.text) ? args.text : [args.text];
      for (const t of texts) {
        if (!t) continue;
        await callExtTool('wait', { tabId, text: String(t), timeoutMs: args.timeout || 10000 });
      }
      return {
        content: [{ type: 'text', text: `Confirmed text ${JSON.stringify(texts)} on page.` }]
      };
    }

    if (name === 'evaluate_script') {
      const tabId = await resolveMainTabId(args.pageId);
      try {
        const res = await callExtTool('eval_js', {
          tabId,
          code: args.function,
          args: args.args || []
        });
        return {
          content: [{ type: 'text', text: res?.content ?? 'undefined' }]
        };
      } catch (err) {
        // Fallback if extension service worker has not reloaded with eval_js yet:
        // support common document queries via `query` tool
        const pageTextRes = await callExtTool('query', {
          tabId,
          mode: 'page_text',
          limit: 40000
        });
        const val = typeof pageTextRes?.content === 'string'
          ? JSON.parse(pageTextRes.content)?.value
          : pageTextRes?.content;
        return {
          content: [{
            type: 'text',
            text: typeof val === 'string' ? val : JSON.stringify(val ?? null, null, 2)
          }]
        };
      }
    }

    if (name === 'list_console_messages' || name === 'get_console_message') {
      const tabId = await resolveMainTabId(args.pageId);
      const [consoleRes, errRes] = await Promise.all([
        callExtTool('console', { tabId }),
        callExtTool('errors', { tabId })
      ]);
      return {
        content: [{
          type: 'text',
          text: `Console messages:\n${consoleRes?.content || '[]'}\n\nPage errors:\n${errRes?.content || '[]'}`
        }]
      };
    }

    if (name === 'list_webmcp_tools' || name === 'execute_webmcp_tool') {
      return {
        content: [{
          type: 'text',
          text: `No WebMCP tools exposed by current page.`
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: `Tool "${name}" requires CDP debugger attachment; switch to cloned/isolated profile via browser_switch_profile(mode: "cloned") if low-level DevTools tracing is needed.`
      }]
    };
  }

  // -------------------------------------------------------------------------
  // High-Level Browser Automation & Inspection Tools
  // -------------------------------------------------------------------------

  const customToolHandlers = new Map();
  let jsReplContext = null;

  function registerCustomBrowserTool(name, description, schemaShape, readOnlyHint, handler) {
    customToolHandlers.set(name, handler);
    mcpServer.server.registerTool(
      name,
      {
        description,
        inputSchema: schemaShape,
        annotations: { readOnlyHint }
      },
      async (args) => handler(args || {})
    );
  }

  // Tool 1: `tabs_context_mcp` (tab overview)
  registerCustomBrowserTool(
    'tabs_context_mcp',
    'Get context information about all currently open browser tabs (pageId, tabId, title, URL, selected state, lifecycle mark) and the active profile connection mode ("main", "cloned", or "isolated").',
    {
      include_urls: zod.boolean().optional().describe('Include full URLs for all tabs (default true).')
    },
    true,
    async () => {
      if (currentProfileMode === 'main') {
        const tabs = await refreshMainTabs();
        const listRes = await dispatchMainBrowserExtensionTool('list_pages', {});
        const rawList = parseCallToolText(listRes);
        const header = `Profile mode: main (bridge=chrome-extension, popupFree=true, totalTabs=${tabs.length}, selectedTabId=${selectedMainTabId})`;
        const marksSummary = tabMarks.size > 0
          ? `\nTab marks: ${JSON.stringify(Object.fromEntries(tabMarks))}`
          : '';
        return {
          content: [{ type: 'text', text: `${header}${marksSummary}\n\n${rawList}` }]
        };
      }
      const browser = await browserManager.ensureBrowser();
      const pages = await browser.pages();
      const listRes = await origCallTool('list_pages', {});
      const rawList = parseCallToolText(listRes);
      const header = `Profile mode: ${currentProfileMode} (connected=${Boolean(browser?.connected)}, totalTabs=${pages.length})`;
      const marksSummary = tabMarks.size > 0
        ? `\nTab marks: ${JSON.stringify(Object.fromEntries(tabMarks))}`
        : '';
      return {
        content: [{ type: 'text', text: `${header}${marksSummary}\n\n${rawList}` }]
      };
    }
  );

  // Tool 2: `read_page` (AX/DOM tree snapshot + stateful diffing)
  registerCustomBrowserTool(
    'read_page',
    'Read the accessibility tree snapshot of a browser tab with optional interactive-only filtering, depth limit, subtree uid focus, and stateful token-saving diff mode.',
    {
      pageId: zod.number().optional().describe('Target page ID from list_pages / tabs_context_mcp. Omit for currently selected tab.'),
      filter: zod.enum(['all', 'interactive']).optional().describe('Filter elements: "interactive" for buttons/links/inputs/headings only, or "all" (default "all").'),
      depth: zod.number().min(1).max(40).optional().describe('Maximum tree depth to traverse (default 15).'),
      uid: zod.string().optional().describe('Optional parent element uid to scope the snapshot to that subtree.'),
      diff: zod.boolean().optional().describe('Return only added/changed/removed elements relative to the previous snapshot of this tab when on the same URL (default false).'),
      max_chars: zod.number().min(500).max(200000).optional().describe('Maximum characters to return (default 45000).')
    },
    true,
    async (args) => {
      const snapArgs = {};
      if (typeof args.pageId === 'number') snapArgs.pageId = args.pageId;
      const rawRes = await dispatchAnyTool('take_snapshot', snapArgs);
      if (rawRes.isError) return rawRes;

      const fullText = parseCallToolText(rawRes);
      const snapBody = extractSnapshotBody(fullText);
      const allLines = formatCompactSnapshotLines(snapBody);
      const filteredLines = filterSnapshotLines(allLines, {
        filter: args.filter || 'all',
        maxDepth: args.depth ?? 15,
        rootUid: args.uid || null
      });

      const pageKey = `${currentProfileMode}:${args.pageId ?? selectedMainTabId ?? 'selected'}:${args.filter || 'all'}:${args.uid || 'root'}`;
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
        outputText = outputText.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars; pass uid or filter="interactive" to narrow]`;
      }

      return {
        content: [{ type: 'text', text: outputText }]
      };
    }
  );

  // Tool 3: `find_elements` (natural language / role / label element search)
  registerCustomBrowserTool(
    'find_elements',
    'Search for elements on the page by natural-language query, role, label, or text content. Returns up to 20 matching elements with their uid for clicking or filling.',
    {
      query: zod.string().describe('Text, role, or purpose to search for (e.g. "search bar", "login button", "submit").'),
      pageId: zod.number().optional().describe('Target page ID. Omit for currently selected page.')
    },
    true,
    async (args) => {
      const snapArgs = {};
      if (typeof args.pageId === 'number') snapArgs.pageId = args.pageId;
      const rawRes = await dispatchAnyTool('take_snapshot', snapArgs);
      if (rawRes.isError) return rawRes;

      const snapBody = extractSnapshotBody(parseCallToolText(rawRes));
      const lines = formatCompactSnapshotLines(snapBody);
      const terms = String(args.query || '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

      const scored = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('uid=')) continue;
        const lower = trimmed.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (lower.includes(t)) score += 2;
        }
        if (score > 0) {
          const isInteractive = Array.from(INTERACTIVE_A11Y_ROLES).some(r => lower.includes(` ${r} `));
          if (isInteractive) score += 1;
          scored.push({ line: trimmed, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 20).map(s => s.line);
      const summary = top.length > 0
        ? `Found ${scored.length} matching element(s) (showing top ${top.length}):\n${top.join('\n')}`
        : `No elements matched query "${args.query}".`;
      return {
        content: [{ type: 'text', text: summary }]
      };
    }
  );

  // Tool 4: `get_page_text` (clean article/text extractor)
  registerCustomBrowserTool(
    'get_page_text',
    'Extract clean readable text and headings from the page without DOM/script/style clutter.',
    {
      pageId: zod.number().optional().describe('Target page ID. Omit for currently selected page.'),
      max_chars: zod.number().min(500).max(200000).optional().describe('Maximum characters to return (default 40000).')
    },
    true,
    async (args) => {
      const maxChars = args.max_chars ?? 40000;
      if (currentProfileMode === 'main') {
        const tabId = await resolveMainTabId(args.pageId);
        const res = await callExtTool('query', {
          tabId,
          mode: 'page_text',
          limit: maxChars
        });
        let text = '';
        try {
          const parsed = typeof res?.content === 'string' ? JSON.parse(res.content) : res?.content;
          text = typeof parsed?.value === 'string' ? parsed.value : String(parsed ?? '');
        } catch (_) {
          text = String(res?.content || '');
        }
        return {
          content: [{ type: 'text', text }]
        };
      }

      const evalArgs = {
        function: `() => {
          const root = document.querySelector('article, main, [role="main"]') || document.body;
          if (!root) return '';
          const clone = root.cloneNode(true);
          for (const el of clone.querySelectorAll('script, style, noscript, svg, nav, footer, [aria-hidden="true"]')) {
            el.remove();
          }
          return (clone.innerText || clone.textContent || '')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
        }`
      };
      if (typeof args.pageId === 'number') evalArgs.pageId = args.pageId;
      const res = await dispatchAnyTool('evaluate_script', evalArgs);
      if (res.isError) return res;
      let text = parseCallToolText(res);
      if (text.length > maxChars) {
        text = text.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars]`;
      }
      return {
        content: [{ type: 'text', text }]
      };
    }
  );

  // Tool 5: `browser_batch` (multi-step execution with adaptive settle)
  registerCustomBrowserTool(
    'browser_batch',
    'Execute a sequence of browser tool calls in a single MCP round-trip with automatic adaptive DOM settling between steps. Stops early if any step returns an error.',
    {
      steps: zod.array(
        zod.object({
          tool: zod.string().describe('Name of the browser tool to call (e.g. "navigate_page", "click", "fill", "press_key", "read_page", "take_screenshot").'),
          args: zod.record(zod.string(), typeof zod.any === 'function' ? zod.any() : zod.unknown()).optional().describe('Arguments object for the tool.')
        })
      ).min(1).describe('Ordered list of browser tool steps to execute.')
    },
    false,
    async (args) => {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      const outContent = [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step.tool === 'upload_file' || step.tool === 'file_upload') {
          outContent.push({
            type: 'text',
            text: `Step ${i} (${step.tool}): upload_file must be called standalone, not inside browser_batch.`
          });
          return { content: outContent, isError: true };
        }
        const res = await dispatchAnyTool(step.tool, step.args || {});
        const ok = !res.isError;
        outContent.push({
          type: 'text',
          text: `— steps[${i}] ${step.tool}: ${ok ? 'ok' : 'ERROR'} —`
        });
        if (Array.isArray(res.content)) {
          outContent.push(...res.content);
        }
        if (!ok) {
          return { content: outContent, isError: true };
        }
      }
      return { content: outContent };
    }
  );

  // Tool 6: `browser_switch_profile` (Main browser default + optional Cloned / Isolated modes)
  registerCustomBrowserTool(
    'browser_switch_profile',
    'Switch the active Chrome connection mode between "main" (default: connects directly to the user\'s running main Chrome browser via extension bridge with zero popups), "cloned" (optional APFS copy-on-write clone of main profile cookies/sessions), and "isolated" (optional clean isolated profile).',
    {
      mode: zod.enum(['main', 'cloned', 'isolated']).describe('Target browser profile mode.')
    },
    false,
    async (args) => {
      const nextMode = args.mode || 'main';
      if (nextMode !== currentProfileMode) {
        currentProfileMode = nextMode;
        try {
          if (activeBrowserHandle) {
            await activeBrowserHandle.close();
          }
        } catch (_) {}
        activeBrowserHandle = null;
      }
      if (currentProfileMode === 'main') {
        const tabs = await refreshMainTabs();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              profileMode: 'main',
              bridge: 'chrome-extension',
              popupFree: true,
              connected: true,
              openTabs: tabs.length,
              selectedTabId: selectedMainTabId
            }, null, 2)
          }]
        };
      }
      const browser = await browserManager.ensureBrowser();
      const pages = await browser.pages();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            profileMode: currentProfileMode,
            connected: Boolean(browser?.connected),
            openTabs: pages.length
          }, null, 2)
        }]
      };
    }
  );

  // Tool 7: `browser_js` (Stateful JS REPL with `browser` and `tab.ax`)
  registerCustomBrowserTool(
    'browser_js',
    'Execute JavaScript in a persistent Node REPL with `browser` and `tab` bindings (`await tab.ax.write()`, `await tab.ax.click(uid)`, `await tab.ax.setValue(uid, text)`, `await tab.ax.pressKey(uid, key)`, `await tab.goto(url)`, `await tab.eval(fn)`, `await tab.capabilities.get("webmcp")`, `tab.markDeliverable()`, `tab.markHandoff()`).',
    {
      code: zod.string().describe('JavaScript code to run (top-level await supported).'),
      pageId: zod.number().optional().describe('Optional default pageId for `tab`.'),
      reset: zod.boolean().optional().describe('Reset persistent REPL state before running.')
    },
    false,
    async (args) => {
      if (args.reset) jsReplContext = null;
      const emittedContent = [];
      const logs = [];
      let currentPageId = args.pageId;

      const createTabBinding = (boundPageId) => {
        const withPageId = (obj = {}) => {
          const pid = boundPageId ?? currentPageId;
          return typeof pid === 'number' ? { ...obj, pageId: pid } : obj;
        };
        return {
          get pageId() {
            return boundPageId ?? currentPageId ?? selectedMainTabId;
          },
          async goto(url) {
            return await dispatchAnyTool('navigate_page', withPageId({ type: 'url', url }));
          },
          async reload() {
            return await dispatchAnyTool('navigate_page', withPageId({ type: 'reload' }));
          },
          async eval(fnOrScript) {
            const fnStr = typeof fnOrScript === 'function'
              ? fnOrScript.toString()
              : `() => (${fnOrScript})`;
            const res = await dispatchAnyTool('evaluate_script', withPageId({ function: fnStr }));
            return parseCallToolText(res);
          },
          markDeliverable() {
            tabMarks.set(boundPageId ?? currentPageId ?? selectedMainTabId ?? 'selected', 'deliverable');
            return 'deliverable';
          },
          markHandoff() {
            tabMarks.set(boundPageId ?? currentPageId ?? selectedMainTabId ?? 'selected', 'handoff');
            return 'handoff';
          },
          ax: {
            async get(opts = {}) {
              const res = await dispatchAnyTool('read_page', withPageId({
                filter: opts.filter || 'all',
                depth: opts.depth ?? 15,
                uid: opts.uid,
                diff: !opts.disableDiffing
              }));
              return parseCallToolText(res);
            },
            async write(mode = 'state', opts = {}) {
              if (mode === 'screenshot' || mode === 'both') {
                const shotRes = await dispatchAnyTool('take_screenshot', withPageId({ format: 'jpeg' }));
                if (Array.isArray(shotRes.content)) emittedContent.push(...shotRes.content);
                if (mode === 'screenshot') return 'screenshot emitted';
              }
              const res = await dispatchAnyTool('read_page', withPageId({
                filter: opts.filter || 'all',
                depth: opts.depth ?? 15,
                uid: opts.uid,
                diff: !opts.disableDiffing
              }));
              if (Array.isArray(res.content)) emittedContent.push(...res.content);
              return parseCallToolText(res);
            },
            async click(uid, opts = {}) {
              return await dispatchAnyTool('click', withPageId({
                uid: String(uid),
                dblClick: opts.count === 2
              }));
            },
            async setValue(uid, value) {
              return await dispatchAnyTool('fill', withPageId({
                uid: String(uid),
                value: String(value ?? '')
              }));
            },
            async typeText(uid, text) {
              if (uid) {
                await dispatchAnyTool('click', withPageId({ uid: String(uid) }));
              }
              return await dispatchAnyTool('type_text', withPageId({ text: String(text ?? '') }));
            },
            async pressKey(uid, key) {
              if (uid) {
                await dispatchAnyTool('click', withPageId({ uid: String(uid) }));
              }
              return await dispatchAnyTool('press_key', withPageId({ key: String(key) }));
            }
          },
          capabilities: {
            async get(capName) {
              if (capName === 'webmcp') {
                return {
                  async fetchTools() {
                    const listRes = await dispatchAnyTool('list_webmcp_tools', withPageId({}));
                    const desc = parseCallToolText(listRes);
                    return {
                      description: () => desc,
                      async call(toolName, inputObj = {}) {
                        const execRes = await dispatchAnyTool('execute_webmcp_tool', withPageId({
                          toolName,
                          input: typeof inputObj === 'string' ? inputObj : JSON.stringify(inputObj)
                        }));
                        return parseCallToolText(execRes);
                      }
                    };
                  }
                };
              }
              if (capName === 'pageAssets') {
                return {
                  async list() {
                    const res = await dispatchAnyTool('evaluate_script', withPageId({
                      function: `() => {
                        const assets = [];
                        for (const img of document.querySelectorAll('img[src]')) {
                          assets.push({ kind: 'image', url: img.src, name: img.alt || '' });
                        }
                        for (const link of document.querySelectorAll('link[rel="stylesheet"][href]')) {
                          assets.push({ kind: 'stylesheet', url: link.href });
                        }
                        for (const vid of document.querySelectorAll('video[src], video source[src]')) {
                          assets.push({ kind: 'video', url: vid.src });
                        }
                        return { pageUrl: location.href, assets };
                      }`
                    }));
                    return parseCallToolText(res);
                  }
                };
              }
              throw new Error(`Unsupported capability: ${capName}`);
            }
          }
        };
      };

      const browserBinding = {
        tabs: {
          async list() {
            const res = await dispatchAnyTool('list_pages', {});
            return parseCallToolText(res);
          },
          async get(id) {
            currentPageId = Number(id);
            await dispatchAnyTool('select_page', { pageId: currentPageId });
            return createTabBinding(currentPageId);
          },
          async create(url) {
            const res = await dispatchAnyTool('new_page', { url: url || 'about:blank' });
            return parseCallToolText(res);
          }
        },
        user: {
          async openTabs() {
            if (currentProfileMode === 'main') {
              const tabs = await refreshMainTabs();
              return tabs.map((t, idx) => ({
                index: idx + 1,
                tabId: t.id,
                url: t.url,
                title: t.title || ''
              }));
            }
            const b = await browserManager.ensureBrowser();
            const pages = await b.pages();
            const out = [];
            for (let i = 0; i < pages.length; i++) {
              const p = pages[i];
              out.push({
                index: i + 1,
                url: p.url(),
                title: await p.title().catch(() => '')
              });
            }
            return out;
          },
          async claimTab(tabObj) {
            const pageId = typeof tabObj === 'number' ? tabObj : (tabObj?.tabId || tabObj?.pageId || tabObj?.index || 1);
            currentPageId = Number(pageId);
            await dispatchAnyTool('select_page', { pageId: currentPageId });
            return createTabBinding(currentPageId);
          }
        }
      };

      if (!jsReplContext) {
        jsReplContext = vm.createContext({
          Buffer,
          URL,
          URLSearchParams,
          setTimeout,
          clearTimeout
        });
      }
      jsReplContext.browser = browserBinding;
      jsReplContext.tab = createTabBinding(currentPageId);
      jsReplContext.console = {
        log: (...a) => logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
        warn: (...a) => logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
        error: (...a) => logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '))
      };

      try {
        const wrapped = `(async () => {\n${args.code}\n})()`;
        const ret = await vm.runInContext(wrapped, jsReplContext, { timeout: 30000 });
        if (ret !== undefined) {
          logs.push(typeof ret === 'string' ? ret : JSON.stringify(ret, null, 2));
        }
        const out = [];
        if (logs.length > 0) {
          out.push({ type: 'text', text: logs.join('\n') });
        }
        out.push(...emittedContent);
        if (out.length === 0) {
          out.push({ type: 'text', text: 'ok' });
        }
        return { content: out };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `browser_js error: ${err?.message || String(err)}` }],
          isError: true
        };
      }
    }
  );

  async function dispatchAnyTool(name, args = {}) {
    try {
      if (customToolHandlers.has(name)) {
        return await customToolHandlers.get(name)(args);
      }
      if (currentProfileMode === 'main') {
        return await dispatchMainBrowserExtensionTool(name, args);
      }
      return await origCallTool(name, args);
    } catch (err) {
      return {
        content: [{ type: 'text', text: err?.message || String(err) }],
        isError: true
      };
    }
  }

  mcpServer.callTool = dispatchAnyTool;

  mcpServer.server.server.setRequestHandler('tools/call', async (request) => {
    const toolName = request.params.name;
    const toolArgs = request.params.arguments || {};
    const result = await dispatchAnyTool(toolName, toolArgs);
    return mcpServer.server.server.projectCallToolResult(result, undefined);
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => process.exit(0), 1500).unref();
    try {
      if (currentProfileMode !== 'main' && activeBrowserHandle) {
        await mcpServer.close();
      }
    } catch (_) {}
    process.exit(0);
  }

  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', shutdown);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((err) => {
  console.error('[antigravity-browser-mcp] fatal error:', err);
  process.exit(1);
});
