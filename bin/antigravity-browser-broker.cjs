#!/usr/bin/env node
'use strict';

/**
 * Antigravity Dedicated Browser Bridge Broker (`antigravity-browser-broker.cjs`)
 *
 * Listens on ~/.gemini/antigravity/browser-bridge.sock and mediates communication
 * between the Antigravity Chrome Extension (via antigravity-browser-native-host.cjs)
 * and the Antigravity Browser MCP server (antigravity-browser-mcp.js).
 */

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOCKET_DIR = path.join(os.homedir(), '.gemini', 'antigravity');
const SOCKET_PATH = process.env.ANTIGRAVITY_BROWSER_SOCKET || path.join(SOCKET_DIR, 'browser-bridge.sock');

fs.mkdirSync(SOCKET_DIR, { recursive: true });

function createJsonLineParser(onMessage) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (_) {}
    }
  };
}

function writeJsonLine(socket, msg) {
  try {
    socket.write(JSON.stringify(msg) + '\n');
  } catch (_) {}
}

let host = null; // { socket }
let nextExtId = 0;
const extPending = new Map(); // extId -> { resolve, reject, timeout }
const clients = new Set();
let activeClaimedTabId = null;

function ensureHost() {
  if (host && host.socket && !host.socket.destroyed) return;
  throw new Error('Antigravity Chrome extension is not connected (native host offline). Ensure the extension is loaded.');
}

function callExtension(tool, args = {}) {
  ensureHost();
  const extId = ++nextExtId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!extPending.has(extId)) return;
      extPending.delete(extId);
      reject(new Error(`Timed out waiting for extension tool=${tool}`));
    }, 45000);

    extPending.set(extId, { resolve, reject, timeout });
    writeJsonLine(host.socket, {
      type: 'to_extension',
      message: { type: 'tool_request', id: extId, tool, args }
    });
  });
}

function handleClientMessage(socket, client, msg) {
  if (!msg) return;

  if (msg.type === 'hello') {
    client.role = msg.role || 'mcp';
    if (client.role === 'native-host') {
      if (host && host.socket && host.socket !== socket) {
        try { host.socket.destroy(); } catch (_) {}
      }
      host = { socket };
      writeJsonLine(socket, { type: 'host_ready', ok: true });
    }
    return;
  }

  if (msg.type === 'from_extension') {
    const message = msg.message;
    if (message && message.type === 'tool_response' && typeof message.id === 'number') {
      const pending = extPending.get(message.id);
      if (!pending) return;
      extPending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.content || String(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
    return;
  }

  if (msg.type === 'request' && typeof msg.id === 'number') {
    const requestId = msg.id;
    const replyOk = (data) => writeJsonLine(socket, { type: 'response', id: requestId, ok: true, data });
    const replyErr = (err) => writeJsonLine(socket, { type: 'response', id: requestId, ok: false, error: err?.message || String(err) });

    (async () => {
      try {
        if (msg.op === 'status') {
          replyOk({
            broker: true,
            hostConnected: Boolean(host && host.socket && !host.socket.destroyed),
            activeClaimedTabId
          });
          return;
        }

        if (msg.op === 'claim_tab') {
          if (typeof msg.tabId === 'number') activeClaimedTabId = msg.tabId;
          replyOk({ ok: true, tabId: activeClaimedTabId });
          return;
        }

        if (msg.op === 'tool') {
          const tool = msg.tool;
          const args = { ...msg.args };
          if (tool !== 'get_tabs' && tool !== 'open_tab' && tool !== 'reload_self') {
            if (typeof args.tabId !== 'number' && activeClaimedTabId) {
              args.tabId = activeClaimedTabId;
            }
          }
          const res = await callExtension(tool, args);
          if (res && typeof res.tabId === 'number') {
            activeClaimedTabId = res.tabId;
          }
          replyOk(res);
          return;
        }

        throw new Error(`Unknown broker op: ${msg.op}`);
      } catch (err) {
        replyErr(err);
      }
    })();
  }
}

function start() {
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch (_) {}

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const client = { role: 'unknown' };
    clients.add(client);

    socket.on('data', createJsonLineParser((msg) => handleClientMessage(socket, client, msg)));

    socket.on('close', () => {
      clients.delete(client);
      if (client.role === 'native-host' && host && host.socket === socket) {
        host = null;
        for (const [extId, pending] of extPending.entries()) {
          extPending.delete(extId);
          if (pending.timeout) clearTimeout(pending.timeout);
          pending.reject(new Error('Antigravity Chrome Native Host disconnected'));
        }
      }
    });

    socket.on('error', () => {});
  });

  server.listen(SOCKET_PATH, () => {
    try { fs.chmodSync(SOCKET_PATH, 0o600); } catch (_) {}
  });

  server.on('error', (err) => {
    console.error('[antigravity-browser-broker] fatal error:', err);
    process.exit(1);
  });
}

start();
