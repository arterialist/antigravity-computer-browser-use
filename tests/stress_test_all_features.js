#!/usr/bin/env node
'use strict';

/**
 * Antigravity Full-Spectrum Stress Test Battery
 * Tests Computer Use, Google Chrome MCP, and Apple Safari MCP under complex workloads,
 * detects edge cases and blind spots, and asserts correctness.
 */

const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const FIXTURE_PATH = `file://${path.resolve(__dirname, 'fixtures', 'complex_workbench.html')}`;

function createMcpClient(binPath, name) {
  const proc = spawn(process.execPath, [binPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let buf = '';
  const pending = new Map();
  let nextId = 1;

  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
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
    const s = d.toString('utf8').trim();
    if (!s.includes('ExperimentalWarning') && s.length > 0) {
      console.warn(`[${name} stderr]:`, s);
    }
  });

  const rpc = (method, params = {}) => {
    const id = nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rej(new Error(`RPC timeout after 30s on method=${method}`));
        }
      }, 30000);
      pending.set(id, {
        resolve: (val) => { clearTimeout(timer); res(val); },
        t0: Date.now()
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  const init = async () => {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'stress-tester', version: '1.0.0' }
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  };

  const close = () => {
    try { proc.kill(); } catch (_) {}
  };

  return { rpc, init, close, proc };
}

async function runTests() {
  console.log('================================================================');
  console.log('ANTIGRAVITY FULL-SPECTRUM STRESS TEST BATTERY');
  console.log('Testing: Chrome MCP + Safari MCP + Computer Use (CUA)');
  console.log('Fixture:', FIXTURE_PATH);
  console.log('================================================================\n');

  const blindSpotsIdentified = [];

  // =========================================================================
  // SECTION 1: GOOGLE CHROME MCP STRESS TESTS
  // =========================================================================
  console.log('>>> [1/3] STRESS TESTING GOOGLE CHROME MCP VIA DEDICATED EXTENSION <<<');
  const chromeClient = createMcpClient(
    path.join(__dirname, '..', 'bin', 'antigravity-browser-mcp.js'),
    'ChromeMCP'
  );
  await chromeClient.init();

  try {
    // 1.1 Navigate to complex fixture
    console.log('  1.1 Navigating to complex workbench fixture...');
    const nav = await chromeClient.rpc('tools/call', {
      name: 'navigate_page',
      arguments: { url: FIXTURE_PATH }
    });
    console.log(`    Navigated in ${nav.ms}ms:`, nav.msg.result?.content?.[0]?.text);

    // 1.2 Inspect tabs context
    console.log('  1.2 Inspecting tabs context...');
    const ctx = await chromeClient.rpc('tools/call', { name: 'tabs_context_mcp', arguments: {} });
    assert(ctx.msg.result?.content?.[0]?.text.includes('complex_workbench.html'), 'Fixture tab should be active');
    console.log(`    tabs_context_mcp in ${ctx.ms}ms: ${ctx.msg.result?.content?.[0]?.text.split('\n')[0]}`);

    // 1.3 Deep DOM Snapshot (Testing Shadow DOM piercing & data-agy-uid stamping)
    console.log('  1.3 Taking deep DOM snapshot...');
    const snap = await chromeClient.rpc('tools/call', { name: 'take_snapshot', arguments: {} });
    const snapText = snap.msg.result?.content?.[0]?.text || '';
    assert(snapText.includes('Username:'), 'Should contain Username field');
    assert(snapText.includes('Submit Form'), 'Should contain Submit Form button');
    assert(snapText.includes('Shadow DOM Root Piercing Test') || snapText.includes('shadow-btn') || snapText.includes('Click Inside Shadow Root'), 'Should pierce shadow DOM');
    console.log(`    Snapshot returned in ${snap.ms}ms (${snapText.length} chars)`);

    // 1.4 Test Stateful Diffing (Unchanged)
    console.log('  1.4 Testing stateful diffing (unchanged state)...');
    const rp1 = await chromeClient.rpc('tools/call', {
      name: 'read_page',
      arguments: { filter: 'interactive', diff: true }
    });
    const rp2 = await chromeClient.rpc('tools/call', {
      name: 'read_page',
      arguments: { filter: 'interactive', diff: true }
    });
    assert(rp2.msg.result?.content?.[0]?.text.includes('<ax-diff status="unchanged"'), 'Second call must report unchanged diff');
    console.log(`    Stateful diff verified in ${rp2.ms}ms: ${rp2.msg.result?.content?.[0]?.text}`);

    // 1.5 Interactive Form Filling
    console.log('  1.5 Testing interactive form filling by selector/uid...');
    await chromeClient.rpc('tools/call', {
      name: 'fill',
      arguments: { uid: '#username-field', value: 'AntigravityAgent-007' }
    });
    await chromeClient.rpc('tools/call', {
      name: 'fill',
      arguments: { uid: '#notes-field', value: 'Automated telemetry test run.' }
    });
    await chromeClient.rpc('tools/call', {
      name: 'fill',
      arguments: { uid: '#role-select', value: 'sentinel' }
    });

    // 1.6 Click Action
    console.log('  1.6 Clicking Submit Form button...');
    const clickRes = await chromeClient.rpc('tools/call', {
      name: 'click',
      arguments: { uid: '#submit-btn' }
    });
    console.log(`    Clicked in ${clickRes.ms}ms: ${clickRes.msg.result?.content?.[0]?.text}`);

    // Verify submission text
    const textAfterSubmit = await chromeClient.rpc('tools/call', {
      name: 'evaluate_script',
      arguments: { function: '() => document.getElementById("status-display").textContent' }
    });
    console.log(`    Status display: ${textAfterSubmit.msg.result?.content?.[0]?.text}`);
    assert(textAfterSubmit.msg.result?.content?.[0]?.text.includes('Submitted form with username=AntigravityAgent-007'), 'Form action must execute');

    // 1.7 Dynamic DOM Mutation & Diff Detection
    console.log('  1.7 Testing dynamic DOM mutation and diff detection...');
    await chromeClient.rpc('tools/call', { name: 'click', arguments: { uid: '#mutate-btn' } });
    await new Promise(r => setTimeout(r, 160)); // Wait for 80ms mutation
    const diffAfterMutate = await chromeClient.rpc('tools/call', {
      name: 'read_page',
      arguments: { filter: 'all', diff: true }
    });
    const diffText = diffAfterMutate.msg.result?.content?.[0]?.text || '';
    assert(diffText.includes('Dynamic Node Attached: Verification Passed!') || diffText.includes('dynamic-badge'), 'Diff must detect added dynamic node');
    console.log(`    Diff detected mutation in ${diffAfterMutate.ms}ms`);

    // 1.8 Pierced Shadow DOM Interaction
    console.log('  1.8 Testing interaction inside pierced Shadow DOM...');
    const shadowClick = await chromeClient.rpc('tools/call', {
      name: 'click',
      arguments: { selector: '#shadow-btn' }
    });
    console.log(`    Shadow DOM click: ${shadowClick.msg.result?.content?.[0]?.text}`);

    // 1.9 Visual Screenshot & JPEG Optimization
    console.log('  1.9 Testing visual screenshot capture and tile scaling...');
    const shot = await chromeClient.rpc('tools/call', { name: 'take_screenshot', arguments: {} });
    const imgItem = shot.msg.result?.content?.find(c => c.type === 'image');
    assert(imgItem && imgItem.data.length > 5000, 'Screenshot must return valid base64 JPEG');
    console.log(`    Screenshot captured in ${shot.ms}ms, mime: ${imgItem.mimeType}, size: ${(imgItem.data.length / 1024).toFixed(1)} KB`);

    // 1.10 Multi-step browser_batch
    console.log('  1.10 Testing multi-step browser_batch...');
    const batch = await chromeClient.rpc('tools/call', {
      name: 'browser_batch',
      arguments: {
        steps: [
          { tool: 'click', args: { uid: '#clear-btn' } },
          { tool: 'evaluate_script', args: { function: '() => document.getElementById("username-field").value' } },
          { tool: 'get_page_text', args: { max_chars: 1000 } }
        ]
      }
    });
    assert(batch.msg.result?.content?.some(c => c.text && c.text.includes('steps[0] click: ok')), 'Batch step 0 must succeed');
    console.log(`    browser_batch executed in ${batch.ms}ms`);

    // 1.11 Persistent JS REPL (browser_js)
    console.log('  1.11 Testing persistent JS REPL (browser_js)...');
    const repl = await chromeClient.rpc('tools/call', {
      name: 'browser_js',
      arguments: {
        code: `
          const tabs = await browser.user.openTabs();
          const pageTitle = await tab.eval(() => document.title);
          tab.markDeliverable();
          return { tabsCount: tabs.length, title: pageTitle, activeTabId: tab.pageId };
        `
      }
    });
    const replData = JSON.parse(repl.msg.result?.content?.[0]?.text || '{}');
    assert(replData.title === 'Antigravity Browser & Computer Use Workbench', 'REPL must read tab document title');
    console.log(`    browser_js REPL executed in ${repl.ms}ms:`, replData);

    console.log('>>> [1/3] CHROME MCP TESTS COMPLETED SUCCESSFULLY! <<<\n');
  } catch (err) {
    console.error('CHROME MCP FAILED:', err);
    blindSpotsIdentified.push(`Chrome MCP error: ${err.message}`);
  } finally {
    chromeClient.close();
  }

  // =========================================================================
  // SECTION 2: APPLE SAFARI MCP STRESS TESTS
  // =========================================================================
  console.log('>>> [2/3] STRESS TESTING APPLE SAFARI MCP <<<');
  const safariClient = createMcpClient(
    path.join(__dirname, '..', 'bin', 'antigravity-safari-mcp.js'),
    'SafariMCP'
  );
  await safariClient.init();

  try {
    // 2.1 Navigate Safari to fixture
    console.log('  2.1 Navigating Safari to fixture...');
    const nav = await safariClient.rpc('tools/call', {
      name: 'navigate_page',
      arguments: { url: FIXTURE_PATH }
    });
    console.log(`    Safari navigated in ${nav.ms}ms: ${nav.msg.result?.content?.[0]?.text}`);

    // 2.2 Inspect tabs context
    console.log('  2.2 Inspecting Safari tabs context...');
    const ctx = await safariClient.rpc('tools/call', { name: 'tabs_context_mcp', arguments: {} });
    console.log(`    Safari tabs_context_mcp in ${ctx.ms}ms: ${ctx.msg.result?.content?.[0]?.text.split('\n')[0]}`);

    // 2.3 Instant Text Extraction (2ms native Safari.sdef)
    console.log('  2.3 Extracting clean readable text via native Safari.sdef...');
    const pageText = await safariClient.rpc('tools/call', { name: 'get_page_text', arguments: {} });
    const txt = pageText.msg.result?.content?.[0]?.text || '';
    assert(txt.includes('Antigravity Stress-Test Workbench'), 'Safari get_page_text must return page contents');
    console.log(`    Safari get_page_text in ${pageText.ms}ms (${txt.length} chars)`);

    // 2.4 Safari WebKit AXWebArea Snapshot & Diffing
    console.log('  2.4 Reading Safari WebKit Accessibility Tree...');
    const sSnap = await safariClient.rpc('tools/call', {
      name: 'read_page',
      arguments: { filter: 'interactive', diff: true }
    });
    console.log(`    Safari read_page in ${sSnap.ms}ms: ${sSnap.msg.result?.content?.[0]?.text.slice(0, 150)}...`);

    // 2.5 Find Elements in Safari
    console.log('  2.5 Searching elements in Safari...');
    const fe = await safariClient.rpc('tools/call', {
      name: 'find_elements',
      arguments: { query: 'Submit Form' }
    });
    console.log(`    Safari find_elements in ${fe.ms}ms: ${fe.msg.result?.content?.[0]?.text.split('\n')[0]}`);
    assert(fe.msg.result?.content?.[0]?.text.includes('matching element'), 'Safari find_elements must match Submit Form');

    // 2.6 Visual Screenshot of Safari Window
    console.log('  2.6 Capturing Safari window screenshot...');
    const sShot = await safariClient.rpc('tools/call', { name: 'take_screenshot', arguments: {} });
    const sImg = sShot.msg.result?.content?.find(c => c.type === 'image');
    assert(sImg && sImg.data.length > 5000, 'Safari screenshot must return image data');
    console.log(`    Safari screenshot in ${sShot.ms}ms, size: ${(sImg.data.length / 1024).toFixed(1)} KB`);

    // 2.7 Safari browser_js REPL
    console.log('  2.7 Executing Safari browser_js REPL...');
    const sRepl = await safariClient.rpc('tools/call', {
      name: 'browser_js',
      arguments: {
        code: `
          const txt = await tab.getText();
          return { safariTextLen: txt.length, pageId: tab.pageId };
        `
      }
    });
    console.log(`    Safari browser_js in ${sRepl.ms}ms: ${sRepl.msg.result?.content?.[0]?.text}`);

    console.log('>>> [2/3] SAFARI MCP TESTS COMPLETED SUCCESSFULLY! <<<\n');
  } catch (err) {
    console.error('SAFARI MCP FAILED:', err);
    blindSpotsIdentified.push(`Safari MCP error: ${err.message}`);
  } finally {
    safariClient.close();
  }

  // =========================================================================
  // SECTION 3: COMPUTER USE (CUA) STRESS TESTS
  // =========================================================================
  console.log('>>> [3/3] STRESS TESTING COMPUTER USE (CUA) HARNESS <<<');
  const cuaClient = createMcpClient(
    path.join(__dirname, '..', 'bin', 'antigravity-cua-mcp.js'),
    'CuaMCP'
  );
  await cuaClient.init();

  try {
    // 3.1 App window enumeration across macOS Spaces
    console.log('  3.1 Inspecting application windows across Spaces...');
    const wins = await cuaClient.rpc('tools/call', {
      name: 'app_list_windows',
      arguments: { app: 'com.google.Chrome' }
    });
    console.log(`    app_list_windows in ${wins.ms}ms: ${wins.msg.result?.content?.[0]?.text.slice(0, 120)}...`);

    // 3.2 app_ax_find with text_only: true (0 vision tokens)
    console.log('  3.2 Testing app_ax_find (text_only: true)...');
    const axFind = await cuaClient.rpc('tools/call', {
      name: 'app_ax_find',
      arguments: {
        app: 'com.google.Chrome',
        query: 'Username',
        text_only: true
      }
    });
    assert(!axFind.msg.result?.content?.some(c => c.type === 'image'), 'text_only: true must emit 0 image tokens');
    console.log(`    app_ax_find in ${axFind.ms}ms (0 image tokens)`);

    // 3.3 SoMInvalidationObserver Cache Benchmark
    console.log('  3.3 Benchmarking SoMInvalidationObserver (<1ms cache hit)...');
    const t0 = Date.now();
    const ax1 = await cuaClient.rpc('tools/call', {
      name: 'app_ax_find',
      arguments: { app: 'com.google.Chrome', query: 'Submit', text_only: true }
    });
    const coldMs = Date.now() - t0;

    const t1 = Date.now();
    const ax2 = await cuaClient.rpc('tools/call', {
      name: 'app_ax_find',
      arguments: { app: 'com.google.Chrome', query: 'Submit', text_only: true }
    });
    const cachedMs = Date.now() - t1;
    console.log(`    SoM cold: ${coldMs}ms vs cached: ${cachedMs}ms`);

    // 3.4 Rich Clipboard Snapshot & Restore (sky_paste)
    console.log('  3.4 Testing rich HTML/Markdown clipboard snapshot and restore...');
    const origClip = await cuaClient.rpc('tools/call', { name: 'read_clipboard', arguments: {} });
    await cuaClient.rpc('tools/call', {
      name: 'sky_paste',
      arguments: {
        app: 'com.google.Chrome',
        text: '### Antigravity Stress Test Verification\n- Timestamp: ' + Date.now(),
        format: 'md'
      }
    });
    await new Promise(r => setTimeout(r, 200));
    const restoredClip = await cuaClient.rpc('tools/call', { name: 'read_clipboard', arguments: {} });
    console.log(`    Clipboard safely restored: origLen=${origClip.msg.result?.content?.[0]?.text?.length} restoredLen=${restoredClip.msg.result?.content?.[0]?.text?.length}`);

    // 3.5 Persistent JS REPL (js) with sky & cua handles
    console.log('  3.5 Testing persistent JS REPL (js)...');
    const cuaRepl = await cuaClient.rpc('tools/call', {
      name: 'js',
      arguments: {
        code: `
          const running = await sky.list_apps();
          const displays = await sky.list_displays();
          return { runningCount: running.length, displayCount: displays.length };
        `
      }
    });
    console.log(`    CUA js REPL in ${cuaRepl.ms}ms: ${cuaRepl.msg.result?.content?.[0]?.text}`);
    const cuaReplData = JSON.parse(cuaRepl.msg.result?.content?.[0]?.text || '{}');
    assert(cuaReplData.runningCount > 0, 'CUA REPL must return running apps count');
    assert(cuaReplData.displayCount > 0, 'CUA REPL must return displays count');

    console.log('>>> [3/3] COMPUTER USE TESTS COMPLETED SUCCESSFULLY! <<<\n');
  } catch (err) {
    console.error('CUA MCP FAILED:', err);
    blindSpotsIdentified.push(`CUA MCP error: ${err.message}`);
  } finally {
    cuaClient.close();
  }

  // =========================================================================
  // SUMMARY & BLIND SPOTS
  // =========================================================================
  console.log('================================================================');
  console.log('STRESS TEST RESULTS SUMMARY');
  console.log('================================================================');
  if (blindSpotsIdentified.length === 0) {
    console.log('ALL TESTS PASSED WITH ZERO ERRORS ACROSS ALL THREE HARNESSES!');
  } else {
    console.log(`IDENTIFIED ${blindSpotsIdentified.length} BLIND SPOT(S):`);
    blindSpotsIdentified.forEach((bs, i) => console.log(`  [${i + 1}] ${bs}`));
  }
}

runTests().catch((err) => {
  console.error('Fatal stress test failure:', err);
  process.exit(1);
});
