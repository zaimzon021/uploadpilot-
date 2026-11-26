'use strict';
// Download Playwright's full Chromium (matching the installed playwright-core) into ./browsers,
// which electron-builder ships as resources/browsers (see build.extraResources).
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const dest = path.join(root, 'browsers');
const pwDir = path.join(root, 'node_modules', 'playwright-core');
const cli = path.join(pwDir, 'cli.js');
console.log(`playwright-core ${JSON.parse(fs.readFileSync(path.join(pwDir, 'package.json'), 'utf8')).version} -> installing chromium into ${dest}`);
execFileSync(process.execPath, [cli, 'install', 'chromium', '--no-shell'], { stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dest } });
const { chromiumInBrowsersDir } = require('../src/profiles/browser');
const exe = chromiumInBrowsersDir(dest).find(p => fs.existsSync(p));
if (!exe) { console.error('Bundled Chromium binary not found after install'); process.exit(1); }
console.log(`Bundled Chromium: ${exe} (${(fs.statSync(exe).size / 1e6).toFixed(1)} MB)`);
