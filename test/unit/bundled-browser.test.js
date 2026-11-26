'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectExecutable, chromiumInBrowsersDir } = require('../../src/profiles/browser');

function fakeBrowsers(revs, sub) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'up-browsers-'));
  for (const r of revs) {
    const f = path.join(root, `chromium-${r}`, sub);
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '');
  }
  return root;
}

test('bundled chromium: finds chrome.exe under chromium-*/chrome-win*/ newest revision first', () => {
  const root = fakeBrowsers([999, 1255], 'chrome-win64/chrome.exe');
  fs.mkdirSync(path.join(root, 'chromium-headless-shell-1255'), { recursive: true });
  const found = chromiumInBrowsersDir(root, 'win32').filter(p => fs.existsSync(p));
  assert.strictEqual(found[0], path.join(root, 'chromium-1255', 'chrome-win64', 'chrome.exe'));
  const legacy = fakeBrowsers([1100], 'chrome-win/chrome.exe');
  assert.ok(chromiumInBrowsersDir(legacy, 'win32').some(p => p.endsWith(path.join('chrome-win', 'chrome.exe')) && fs.existsSync(p)));
});

test('detectExecutable order: user path -> bundled resources/browsers -> others', () => {
  const sub = process.platform === 'win32' ? 'chrome-win64/chrome.exe' : process.platform === 'darwin' ? 'chrome-mac/Chromium.app/Contents/MacOS/Chromium' : 'chrome-linux64/chrome';
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'up-res-'));
  const bundled = path.join(resources, 'browsers', 'chromium-1255', sub);
  fs.mkdirSync(path.dirname(bundled), { recursive: true }); fs.writeFileSync(bundled, '');
  const saved = process.env.UPLOADPILOT_CHROME; delete process.env.UPLOADPILOT_CHROME;
  try {
    const userExe = path.join(resources, 'my-chrome'); fs.writeFileSync(userExe, '');
    assert.strictEqual(detectExecutable({ executablePath: userExe }, { resourcesPath: resources }), userExe);
    // a user path that no longer exists falls through to the built-in browser
    assert.strictEqual(detectExecutable({ executablePath: path.join(resources, 'gone.exe') }, { resourcesPath: resources }), bundled);
    assert.strictEqual(detectExecutable({}, { resourcesPath: resources }), bundled);
  } finally { if (saved !== undefined) process.env.UPLOADPILOT_CHROME = saved; }
});
