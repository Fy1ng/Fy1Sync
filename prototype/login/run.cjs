'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { prepareRuntime } = require('./main.cjs');

const platform = process.argv[2];
if (process.argv.length !== 3 || !['youtube', 'douyu'].includes(platform)) {
  console.error('Usage: npm run login -- youtube|douyu');
  process.exitCode = 1;
} else {
  try {
    const root = path.resolve(__dirname, '..');
    // Resolve the already installed Electron package. Never download or install here.
    const electron = require('electron');
    if (typeof electron !== 'string' || !fs.existsSync(electron)) throw new Error('Electron is not installed.');
    const locations = prepareRuntime();
    const env = {
      ...process.env, TEMP: locations.temp, TMP: locations.temp, TMPDIR: locations.temp,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_ENABLE_LOGGING;
    delete env.ELECTRON_LOG_FILE;
    delete env.CHROME_LOG_FILE;
    delete env.SSLKEYLOGFILE;
    delete env.NODE_OPTIONS;
    const child = spawn(electron, [path.join(__dirname, 'main.cjs'), platform], {
      // windowsHide must stay off: on Windows it starts the child with SW_HIDE, which
      // Electron applies to its first window and the login window never appears.
      cwd: root, env, windowsHide: false, stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Forward only the fixed export summary, never Chromium/renderer diagnostics.
    const authKeys = new Set(platform === 'youtube'
      ? ['SAPISID', '__Secure-3PSID', '__Secure-1PSID', 'SID', 'HSID', 'SSID']
      : ['acf_uid', 'acf_auth', 'acf_biz', 'acf_stk']);
    let pending = '';
    let reported = false;
    function report(line) {
      const progress = /^P0_STATUS ([a-z-]+(?: [a-z]+=[A-Za-z0-9_-]+)*)$/.exec(line);
      if (progress) { console.log(`[login] ${progress[1]}`); return; }
      if (!line.startsWith('P0_LOGIN ')) return;
      try {
        const data = JSON.parse(line.slice(9));
        if (!Number.isSafeInteger(data.cookieCount) || data.cookieCount < 0 || !Array.isArray(data.authKeysPresent)) return;
        if (data.authKeysPresent.some(key => !authKeys.has(key))) return;
        reported = true;
        console.log(JSON.stringify({ cookieCount: data.cookieCount, authKeysPresent: data.authKeysPresent }));
      } catch { /* Never relay unknown child output. */ }
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      if (pending.length > 16384) pending = '';
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        report(pending.slice(0, end).trimEnd());
        pending = pending.slice(end + 1);
      }
    });
    child.on('error', () => {
      console.error('The manual login process could not start. Run npm run setup if Electron is missing.');
      process.exitCode = 1;
    });
    child.on('close', code => {
      if (pending) report(pending.trimEnd());
      if (code !== 0 || !reported) console.error('Manual login or private cookie export failed. No successful export was reported.');
      process.exitCode = code === 0 && reported ? 0 : (code || 1);
    });
  } catch {
    console.error('Login could not start. Check local Electron installation and private runtime directory permissions.');
    process.exitCode = 1;
  }
}
