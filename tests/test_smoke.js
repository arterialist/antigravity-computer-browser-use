#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function checkSyntax(filePath) {
  execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
}

function testSwiftNativeHelper(binPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const pending = new Map();
    let nextId = 1;

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      reject(new Error('Swift native helper smoke test timed out'));
    }, 10000);

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending.has(msg.id)) {
            const res = pending.get(msg.id);
            pending.delete(msg.id);
            res(msg.result);
          }
        } catch (_) {}
      }
    });

    const call = (method, params = {}) => new Promise((res) => {
      const id = nextId++;
      pending.set(id, res);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    (async () => {
      try {
        const ping = await call('ping');
        assert(ping && ping.ok === true, 'Swift helper ping ok');

        const displays = await call('listDisplays');
        assert(displays && displays.ok === true && Array.isArray(displays.displays), 'Swift helper listDisplays ok');

        const apps = await call('listApps');
        assert(apps && apps.ok === true && Array.isArray(apps.apps), 'Swift helper listApps ok');

        clearTimeout(timer);
        try { proc.kill(); } catch (_) {}
        resolve();
      } catch (err) {
        clearTimeout(timer);
        try { proc.kill(); } catch (_) {}
        reject(err);
      }
    })();
  });
}

function testMcpServerHandshake(serverPath, expectedServerName, minTools) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const pending = new Map();
    let nextId = 1;

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      reject(new Error(`MCP handshake timed out for ${serverPath}`));
    }, 15000);

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        } catch (_) {}
      }
    });

    const rpc = (method, params = {}) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    (async () => {
      try {
        const init = await rpc('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '1.0.0' }
        });
        assert(init && init.serverInfo && init.serverInfo.name === expectedServerName,
          `Expected serverInfo.name=${expectedServerName}, got ${init?.serverInfo?.name}`);
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

        const listed = await rpc('tools/list', {});
        const tools = listed?.tools || [];
        assert(tools.length >= minTools,
          `Expected >= ${minTools} tools for ${expectedServerName}, got ${tools.length}`);

        clearTimeout(timer);
        try { proc.kill(); } catch (_) {}
        resolve(tools.length);
      } catch (err) {
        clearTimeout(timer);
        try { proc.kill(); } catch (_) {}
        reject(err);
      }
    })();
  });
}

async function main() {
  console.log('=== Running Antigravity Computer & Browser Use Smoke Tests ===');

  const jsFiles = [
    'bin/antigravity-cua-mcp.js',
    'bin/antigravity-browser-mcp.js',
    'bin/antigravity-safari-mcp.js',
    'bin/antigravity-browser-broker.cjs',
    'bin/antigravity-browser-native-host.cjs',
    'plugins/computer-use/hooks/pre-tool-cua.js',
    'tests/test_cua.js',
    'tests/test_browsers.js',
    'tests/stress_test_all_features.js'
  ];

  for (const rel of jsFiles) {
    checkSyntax(path.join(ROOT, rel));
  }
  console.log(`PASSED: Syntax check (${jsFiles.length} JS/CJS files)`);

  const jsonFiles = [
    'package.json',
    'extensions/antigravity-browser-extension/manifest.json',
    'extensions/antigravity-browser-extension/com.google.antigravity.browser_bridge.json',
    'plugins/computer-use/plugin.json',
    'plugins/computer-use/mcp_config.json',
    'plugins/computer-use/hooks.json'
  ];

  for (const rel of jsonFiles) {
    JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  }
  console.log(`PASSED: JSON validation (${jsonFiles.length} config files)`);

  const nativeBin = path.join(ROOT, 'bin', 'antigravity-cua-native');
  assert(fs.existsSync(nativeBin), 'bin/antigravity-cua-native must be compiled before running smoke tests');
  await testSwiftNativeHelper(nativeBin);
  console.log('PASSED: Swift native helper ping, listDisplays, and listApps');

  const cuaTools = await testMcpServerHandshake(
    path.join(ROOT, 'bin', 'antigravity-cua-mcp.js'),
    'antigravity-computer-use',
    42
  );
  console.log(`PASSED: Computer Use MCP handshake (${cuaTools} tools)`);

  const chromeTools = await testMcpServerHandshake(
    path.join(ROOT, 'bin', 'antigravity-browser-mcp.js'),
    'chrome_devtools',
    40
  );
  console.log(`PASSED: Chrome Browser MCP handshake (${chromeTools} tools)`);

  const safariTools = await testMcpServerHandshake(
    path.join(ROOT, 'bin', 'antigravity-safari-mcp.js'),
    'safari_browser',
    18
  );
  console.log(`PASSED: Safari Browser MCP handshake (${safariTools} tools)`);

  console.log('=== All smoke tests passed! ===');
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
