#!/usr/bin/env node
'use strict';

/**
 * Antigravity Chrome Native Messaging Host (`antigravity-browser-native-host.cjs`)
 *
 * Speaks Chrome native messaging framing (uint32 LE length prefix + JSON) on stdin/stdout
 * and routes messages to antigravity-browser-broker.cjs via the local UNIX socket.
 */

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SOCKET_DIR = path.join(os.homedir(), '.gemini', 'antigravity');
const SOCKET_PATH = process.env.ANTIGRAVITY_BROWSER_SOCKET || path.join(SOCKET_DIR, 'browser-bridge.sock');
const BROKER_SCRIPT = path.join(path.dirname(__filename), 'antigravity-browser-broker.cjs');

function ensureBrokerRunning() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryConnect = () => {
      const sock = net.connect(SOCKET_PATH, () => resolve(sock));
      sock.on('error', () => {
        if (attempts === 0) {
          try {
            const child = spawn(process.execPath, [BROKER_SCRIPT], {
              detached: true,
              stdio: 'ignore'
            });
            child.unref();
          } catch (_) {}
        }
        attempts++;
        if (attempts > 20) {
          return reject(new Error('Failed to connect to antigravity-browser-broker'));
        }
        setTimeout(tryConnect, 100);
      });
    };
    tryConnect();
  });
}

function writeNativeMessage(obj) {
  try {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    process.stdout.write(Buffer.concat([header, payload]));
  } catch (_) {}
}

let stdinBuffer = Buffer.alloc(0);
function onStdinData(chunk, onMessage) {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  while (stdinBuffer.length >= 4) {
    const len = stdinBuffer.readUInt32LE(0);
    if (stdinBuffer.length < 4 + len) return;
    const body = stdinBuffer.slice(4, 4 + len);
    stdinBuffer = stdinBuffer.slice(4 + len);
    try {
      onMessage(JSON.parse(body.toString('utf8')));
    } catch (_) {}
  }
}

(async () => {
  const broker = await ensureBrokerRunning();
  broker.setNoDelay(true);

  let brokerBuffer = '';
  broker.on('data', (chunk) => {
    brokerBuffer += chunk.toString('utf8');
    let nl;
    while ((nl = brokerBuffer.indexOf('\n')) !== -1) {
      const line = brokerBuffer.slice(0, nl).trim();
      brokerBuffer = brokerBuffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg && msg.type === 'to_extension' && msg.message) {
          writeNativeMessage(msg.message);
        }
      } catch (_) {}
    }
  });

  broker.on('close', () => process.exit(0));
  broker.on('error', () => process.exit(1));

  broker.write(JSON.stringify({ type: 'hello', role: 'native-host' }) + '\n');

  process.stdin.on('data', (chunk) => {
    onStdinData(chunk, (message) => {
      broker.write(JSON.stringify({ type: 'from_extension', message }) + '\n');
    });
  });

  process.stdin.on('end', () => {
    try { broker.end(); } catch (_) {}
    process.exit(0);
  });
})().catch(() => process.exit(1));
