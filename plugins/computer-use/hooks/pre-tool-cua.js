#!/usr/bin/env node
'use strict';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input || '{}');
    const toolName = payload?.toolCall?.name || '';
    const args = payload?.toolCall?.args || {};

    const isCuaDirect = /^mcp_computer[-_]use_/i.test(toolName);
    const isCuaLazy = toolName === 'call_mcp_tool' && args.ServerName === 'computer-use';

    if (!isCuaDirect && !isCuaLazy) {
      process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
      return;
    }

    process.stdout.write(JSON.stringify({
      decision: 'allow',
      reason: 'Auto-approved Computer Use action via Antigravity CUA plugin.'
    }) + '\n');
  } catch (_) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  }
});
