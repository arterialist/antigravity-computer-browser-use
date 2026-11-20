# Contributing to Antigravity Computer & Browser Use

Thank you for your interest in contributing!

## Development Setup

1. Clone the repository on macOS (Xcode Command Line Tools and Node.js 18+ required):

   ```bash
   git clone https://github.com/arterialist/antigravity-computer-browser-use.git
   cd antigravity-computer-browser-use
   npm install
   npm run build
   ```

2. Run the offline protocol & syntax smoke tests:

   ```bash
   npm test
   ```

3. Run the live macOS / browser integration tests (requires macOS Accessibility and Screen Recording permissions, plus Google Chrome / Apple Safari):

   ```bash
   npm run test:cua
   npm run test:browsers
   npm run test:stress
   ```

## Guidelines

- Keep all three MCP servers (`antigravity-cua-mcp.js`, `antigravity-browser-mcp.js`, `antigravity-safari-mcp.js`) dependency-light and self-contained on macOS.
- Avoid hardcoding user-specific paths or local usernames in scripts, configs, or tests.
- Make sure `npm run build` and `npm test` pass cleanly before opening a pull request.
