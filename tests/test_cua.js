#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MCP_SERVER_PATH = path.join(ROOT, 'bin', 'antigravity-cua-mcp.js');
const NATIVE_HELPER_PATH = path.join(ROOT, 'bin', 'antigravity-cua-native');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`PASSED: ${message}`);
}

class McpTestClient {
  constructor(serverPath) {
    this.proc = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        } catch (_) {}
      }
    });
  }

  request(method, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  close() {
    try { this.proc.kill(); } catch (_) {}
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('RUNNING ANTIGRAVITY COMPUTER USE (CUA) TEST SUITE');
  console.log('====================================================\n');

  // 1. Verify binaries and plugin files exist
  console.log('--- TEST 1: Binary & Plugin Layout ---');
  assert(fs.existsSync(MCP_SERVER_PATH), 'bin/antigravity-cua-mcp.js exists');
  assert(fs.existsSync(NATIVE_HELPER_PATH), 'bin/antigravity-cua-native compiled binary exists');
  assert(fs.existsSync(path.join(ROOT, 'plugins/computer-use/plugin.json')), 'plugins/computer-use/plugin.json exists');
  assert(fs.existsSync(path.join(ROOT, 'plugins/computer-use/mcp_config.json')), 'plugins/computer-use/mcp_config.json exists');
  assert(fs.existsSync(path.join(ROOT, 'plugins/computer-use/hooks.json')), 'plugins/computer-use/hooks.json exists');
  assert(fs.existsSync(path.join(ROOT, 'plugins/computer-use/skills/computer-use/SKILL.md')), 'plugins/computer-use/skills/computer-use/SKILL.md exists');

  // 2. Test MCP server initialization and 42-tool catalog
  console.log('\n--- TEST 2: MCP Server Initialization & Tool Schemas ---');
  const client = new McpTestClient(MCP_SERVER_PATH);
  const initRes = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cua-test', version: '1.0.0' }
  });
  assert(initRes && initRes.serverInfo && initRes.serverInfo.name === 'antigravity-computer-use', 'MCP initialize returns serverInfo.name === "antigravity-computer-use"');

  const listRes = await client.request('tools/list', {});
  const tools = listRes.tools || [];
  const toolNames = new Set(tools.map(t => t.name));
  assert(tools.length >= 42, `MCP server exposes ${tools.length} tools (>= 42 expected)`);
  for (const requiredTool of [
    'request_access', 'screenshot', 'zoom', 'left_click', 'double_click', 'triple_click', 'right_click',
    'left_click_drag', 'scroll', 'type', 'key', 'computer_batch',
    'app_list_windows', 'app_screenshot', 'app_ax_find', 'app_click', 'app_type', 'app_key', 'app_menu', 'app_batch',
    'js', 'js_reset', 'sky_select_text', 'sky_perform_secondary_action', 'sky_paste',
    'teach_step'
  ]) {
    assert(toolNames.has(requiredTool), `Tool "${requiredTool}" is registered`);
  }

  // 3. Test 28x28 tile vision scaling via `screenshot`
  console.log('\n--- TEST 3: Display Screenshot & 28x28 Tile Vision Scaling ---');
  const shotRes = await client.request('tools/call', {
    name: 'screenshot',
    arguments: { exclude_antigravity: true }
  });
  assert(shotRes && Array.isArray(shotRes.content) && shotRes.content.length >= 2, 'screenshot returns multimodal content array');
  const textBlock = shotRes.content.find(c => c.type === 'text');
  const imgBlock = shotRes.content.find(c => c.type === 'image');
  assert(textBlock && /Coordinate frame: (\d+)x(\d+)/.test(textBlock.text), `screenshot metadata: "${textBlock.text.split('\n')[0]}"`);
  assert(imgBlock && /^image\/(jpeg|png)$/.test(imgBlock.mimeType) && imgBlock.data.length > 1000, `screenshot returns base64 image (${imgBlock?.mimeType})`);

  const dimMatch = textBlock.text.match(/Coordinate frame: (\d+)x(\d+)/);
  const w = parseInt(dimMatch[1], 10);
  const h = parseInt(dimMatch[2], 10);
  const tiles = (Math.floor((w - 1) / 28) + 1) * (Math.floor((h - 1) / 28) + 1);
  assert(w <= 1568 && h <= 1568 && tiles <= 1568, `Target dimensions ${w}x${h} fit within 1568px and 1568 vision tokens (actual: ${tiles} tokens)`);

  // 4. Test `js` REPL and Sky bindings
  console.log('\n--- TEST 4: Stateful JS REPL & Sky Bindings ---');
  const replRes1 = await client.request('tools/call', {
    name: 'js',
    arguments: {
      code: `
        globalThis.counter = 41;
        const winList = await sky.list_apps();
        const displays = await sky.list_displays();
        console.log("Apps count:", winList.length, "Displays count:", displays.length);
      `
    }
  });
  const replText1 = replRes1.content.find(c => c.type === 'text')?.text || '';
  assert(/Apps count: \d+ Displays count: \d+/.test(replText1), 'js REPL executed top-level await sky.list_apps() and sky.list_displays()');

  const replRes2 = await client.request('tools/call', {
    name: 'js',
    arguments: {
      code: `
        globalThis.counter += 1;
        console.log("Persistent counter:", globalThis.counter);
      `
    }
  });
  const replText2 = replRes2.content.find(c => c.type === 'text')?.text || '';
  assert(replText2.includes('Persistent counter: 42'), 'js REPL persists globalThis state across tool calls');

  client.close();

  console.log('\n====================================================');
  console.log('ALL COMPUTER USE (CUA) TESTS PASSED!');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('Test suite error:', err);
  process.exit(1);
});
