'use strict';

// Manual login through the system Chrome browser in a dedicated profile.
//
// Google refuses sign-in inside embedded browsers such as Electron ("此浏览器或应用可能
// 不安全"), so YouTube cannot be logged in from login/main.cjs. Here the real Chrome is
// started with its own --user-data-dir: an independent profile that shares nothing with
// the user's everyday browser.
//
// Chrome rather than Edge: a fresh Edge profile signs itself into the Windows Microsoft
// account and starts syncing extensions and settings, which no command-line flag turns
// off (only machine-wide policy, which would also change the user's everyday Edge).
// Chrome never signs in on its own, and --disable-sync keeps the profile local even if
// the user signs into the Google account to reach YouTube.
//
// Two phases, so that nothing is attached to the browser while the user signs in (Google
// also flags browsers that are under automation):
//   1. Plain Chrome on the dedicated profile. The user logs in by hand and closes it.
//   2. Chrome headless on the same profile with --remote-debugging-pipe, only long enough
//      to read the cookie jar. The pipe (fd 3/4) opens no network port, unlike
//      --remote-debugging-port, so no other process or web page can reach it.
//
// Usage: node login/browser.cjs youtube|douyu

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { safeDirectory, writeCookies, platforms, runtimeRoot } = require('./main.cjs');

const BROWSER_CANDIDATES = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

const COMMON_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  // Keep the profile local: no sync of extensions, history or settings, and no prompt to
  // turn sync on after signing into Google.
  '--disable-sync',
  // Without this Chrome may stay resident after its window closes, holding the profile.
  '--disable-background-mode',
];

const status = text => console.log(`[login] ${text}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function waitForExit(child) {
  return new Promise(resolve => {
    child.on('error', () => resolve(null));
    child.on('exit', code => resolve(code));
  });
}

/** Whether the process still owns a visible top-level window. */
function hasWindow(pid) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { 'yes' } else { 'no' }`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return result.stdout.trim() === 'yes';
}

/**
 * Wait until the user is done with the login window.
 *
 * Closing the browser window does not always end the process: Chromium browsers can stay
 * resident in the background (Edge ignores --disable-background-mode), and the profile
 * stays locked until it does. So the signal is the window disappearing, not the process
 * exiting; once the window has been gone for a few seconds the process tree is ended,
 * which releases the profile for the cookie read.
 */
async function waitForLoginDone(child) {
  let exited = false;
  child.on('exit', () => { exited = true; });
  let sawWindow = false;
  let goneSince = 0;
  while (!exited) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (exited) break;
    if (hasWindow(child.pid)) { sawWindow = true; goneSince = 0; continue; }
    // Before the first window appears the browser is still starting; give it time.
    if (!sawWindow) continue;
    if (!goneSince) { goneSince = Date.now(); continue; }
    if (Date.now() - goneSince >= 4000) {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      await waitForExit(child);
      break;
    }
  }
  // Child processes release the profile lock a moment after the browser process.
  await new Promise(resolve => setTimeout(resolve, 1500));
}

/** Phase 2: read every cookie of the profile over the DevTools pipe, then close. */
function readCookies(executable, profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      `--user-data-dir=${profile}`,
      ...COMMON_FLAGS,
      '--headless=new',
      '--remote-debugging-pipe',
      'about:blank',
    ], {
      windowsHide: true,
      // fd 3 = browser reads commands, fd 4 = browser writes replies (Chromium's pipe contract).
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    const toBrowser = child.stdio[3];
    const fromBrowser = child.stdio[4];
    let buffered = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), 20000);

    fromBrowser.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      let end;
      // Messages are NUL-terminated JSON.
      while ((end = buffered.indexOf(0)) !== -1) {
        const raw = buffered.subarray(0, end).toString('utf8');
        buffered = buffered.subarray(end + 1);
        let message;
        try { message = JSON.parse(raw); } catch { continue; }
        if (message.id === 1) {
          if (message.error || !message.result) { finish(new Error('protocol error')); return; }
          const cookies = message.result.cookies;
          toBrowser.write(`${JSON.stringify({ id: 2, method: 'Browser.close' })}\0`);
          finish(null, cookies);
        }
      }
    });
    child.on('error', () => finish(new Error('spawn failed')));
    child.on('exit', () => finish(new Error('exited early')));
    toBrowser.on('error', () => finish(new Error('pipe failed')));
    toBrowser.write(`${JSON.stringify({ id: 1, method: 'Storage.getCookies' })}\0`);
  });
}

async function main() {
  const platform = process.argv[2];
  if (process.argv.length !== 3 || !Object.hasOwn(platforms, platform)) fail('Usage: npm run login -- youtube|douyu');

  const executable = process.env.P0_BROWSER || BROWSER_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (!executable) fail('Google Chrome was not found. Set P0_BROWSER to a Chromium browser executable.');

  let profile;
  let cookiesDir;
  try {
    // One profile per platform, so a YouTube session and a Douyu session never mix.
    profile = safeDirectory(path.join(runtimeRoot, 'chrome-profile', platform));
    cookiesDir = safeDirectory(path.join(runtimeRoot, 'cookies'));
  } catch {
    fail('Login could not start: private runtime permission verification failed.');
  }

  const name = platform === 'youtube' ? 'YouTube' : '斗鱼';
  status(`chrome-started profile=${platform}`);
  console.log(`在弹出的 Chrome 窗口里登录 ${name}。登录完成后关闭这个 Chrome 窗口，cookie 会自动导出。`);
  const browser = spawn(executable, [
    `--user-data-dir=${profile}`,
    ...COMMON_FLAGS,
    '--new-window',
    platforms[platform].url,
  ], { windowsHide: false, stdio: 'ignore' });
  let startFailed = false;
  browser.on('error', () => { startFailed = true; });
  await waitForLoginDone(browser);
  if (startFailed) fail('Chrome could not be started.');

  status('chrome-closed reading-cookies');
  let cookies;
  try {
    cookies = await readCookies(executable, profile);
  } catch {
    fail('Cookie export failed: the profile could not be read. Make sure every window of this login Chrome is closed, then run the command again.');
  }

  try {
    // Same Netscape writer and domain filter as the Electron login path.
    const summary = writeCookies({ cookies: cookiesDir }, platform, cookies.map(cookie => ({
      domain: cookie.domain,
      hostOnly: !cookie.domain.startsWith('.'),
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      session: cookie.session,
      expirationDate: cookie.expires > 0 ? cookie.expires : undefined,
      name: cookie.name,
      value: cookie.value,
    })));
    console.log(JSON.stringify(summary));
    if (summary.authKeysPresent.length === 0) {
      console.log(`没有找到 ${name} 的登录 cookie。如果还没登录，重新运行这条命令再登录一次。`);
    }
  } catch {
    // File errors can carry cookie fields; report the fact only.
    fail('Cookie export failed. No successful export was reported.');
  }
}

void main();
