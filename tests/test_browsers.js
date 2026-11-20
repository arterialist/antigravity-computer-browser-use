#!/usr/bin/env node
'use strict';

/**
 * End-to-end Verification for Antigravity Chrome and Safari MCP Servers
 */

const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function runMcpTest(binPath, testName, testFn) {
  return new Promise((resolve, reject) => {
    console.log(`\n--- RUNNING ${testName} (${binPath}) ---`);
    const proc = spawn(process.execPath, [binPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let buf = '';
    const pending = new Map();
    let nextId = 1;

    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending.has(msg.id)) {
            const { resolve: res, t0 } = pending.get(msg.id);
            pending.delete(msg.id);
            res({ msg, ms: Date.now() - t0 });
          }
        } catch (_) {}
      }
    });

    proc.stderr.on('data', (d) => {
      const s = d.toString();
      if (!s.includes('ExperimentalWarning')) {
        console.error(`[${testName} stderr]:`, s.trim());
      }
    });

    const rpc = (method, params = {}) => {
      const id = nextId++;
      return new Promise((res) => {
        pending.set(id, { resolve: res, t0: Date.now() });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    };

    (async () => {
      try {
        await rpc('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

        await testFn(rpc);
        console.log(`PASSED: ${testName}`);
        proc.kill();
        resolve();
      } catch (err) {
        proc.kill();
        reject(err);
      }
    })();
  });
}

(async () => {
  try {
    // 1. Test Chrome MCP Server
    await runMcpTest(
      path.join(ROOT, 'bin', 'antigravity-browser-mcp.js'),
      'Google Chrome MCP Server',
      async (rpc) => {
        const list = await rpc('tools/list', {});
        assert(list.msg.result.tools.length >= 40, 'Should expose >= 40 tools');
        console.log(`Tools exposed: ${list.msg.result.tools.length}`);

        const ctx = await rpc('tools/call', { name: 'tabs_context_mcp', arguments: {} });
        assert(ctx.msg.result.content[0].text.includes('Pages'), 'Should return tab pages list');
        console.log(`tabs_context_mcp returned in ${ctx.ms}ms`);

        const shot = await rpc('tools/call', { name: 'take_screenshot', arguments: {} });
        assert(shot.msg.result.content.some(c => c.type === 'image'), 'Should return screenshot image');
        console.log(`take_screenshot returned in ${shot.ms}ms`);
      }
    );

    // 2. Test Safari MCP Server
    await runMcpTest(
      path.join(ROOT, 'bin', 'antigravity-safari-mcp.js'),
      'Apple Safari MCP Server',
      async (rpc) => {
        const list = await rpc('tools/list', {});
        assert(list.msg.result.tools.length >= 18, 'Should expose Safari tools');
        console.log(`Tools exposed: ${list.msg.result.tools.length}`);

        const ctx = await rpc('tools/call', { name: 'tabs_context_mcp', arguments: {} });
        assert(ctx.msg.result.content[0].text.includes('Profile mode: safari'), 'Should report safari profile');
        console.log(`Safari tabs_context_mcp returned in ${ctx.ms}ms`);

        const txt = await rpc('tools/call', { name: 'get_page_text', arguments: {} });
        assert(txt.msg.result.content[0].text.length > 0, 'Should extract text from tab');
        console.log(`Safari get_page_text returned in ${txt.ms}ms (length: ${txt.msg.result.content[0].text.length})`);

        const shot = await rpc('tools/call', { name: 'take_screenshot', arguments: {} });
        assert(shot.msg.result.content.some(c => c.type === 'image'), 'Should return Safari screenshot');
        console.log(`Safari take_screenshot returned in ${shot.ms}ms`);
      }
    );

    console.log('\n====================================================');
    console.log('ALL BROWSER MCP TESTS (CHROME + SAFARI) PASSED!');
    console.log('====================================================\n');
  } catch (err) {
    console.error('Test suite failed:', err);
    process.exit(1);
  }
})();
