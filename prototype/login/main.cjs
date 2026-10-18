'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const runtimeRoot = path.join(root, '.runtime');
const platforms = {
  youtube: {
    url: 'https://www.youtube.com',
    domains: ['youtube.com'],
    authKeys: ['SAPISID', '__Secure-3PSID', '__Secure-1PSID', 'SID', 'HSID', 'SSID'],
  },
  douyu: {
    url: 'https://www.douyu.com',
    domains: ['douyu.com'],
    authKeys: ['acf_uid', 'acf_auth', 'acf_biz', 'acf_stk'],
  },
};

let currentSid;

function powershell(script, env = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  });
  if (result.error || result.status !== 0) throw new Error('Private file permission operation failed.');
  return result.stdout.trim();
}

function getSid() {
  if (!currentSid) {
    currentSid = powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
    if (!/^S-1-\d+(?:-\d+)+$/.test(currentSid)) throw new Error('Current Windows user could not be verified.');
  }
  return currentSid;
}

function verifyPrivate(target, directory, recursive = false) {
  if (process.platform === 'win32') {
    const result = powershell(`
      $ErrorActionPreference = 'Stop'
      $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      $items = @(Get-Item -Force -LiteralPath $env:P0_PRIVATE_PATH)
      if ($env:P0_PRIVATE_RECURSIVE -eq '1') {
        $items += @(Get-ChildItem -Force -Recurse -LiteralPath $env:P0_PRIVATE_PATH)
      }
      foreach ($item in $items) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }
        $acl = Get-Acl -LiteralPath $item.FullName
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $allows = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' })
        if (@($rules | Where-Object { $_.IdentityReference.Value -ne $sid }).Count -ne 0) { exit 1 }
        if (@($allows | Where-Object { ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl }).Count -eq 0) { exit 1 }
      }
      $rootAcl = Get-Acl -LiteralPath $env:P0_PRIVATE_PATH
      if (-not $rootAcl.AreAccessRulesProtected) { exit 1 }
      Write-Output 'PRIVATE_OK'
    `, { P0_PRIVATE_PATH: target, P0_PRIVATE_RECURSIVE: recursive ? '1' : '0' });
    if (result !== 'PRIVATE_OK') throw new Error('Private file permission verification failed.');
  } else {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) {
      throw new Error('Private file permission verification failed.');
    }
    if (directory && recursive) {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        verifyPrivate(path.join(target, entry.name), entry.isDirectory(), true);
      }
    }
  }
}

function protectPrivate(target, directory, recursive = false) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('Unsafe runtime path.');
  }
  if (process.platform === 'win32') {
    const result = spawnSync('icacls.exe', [target, '/inheritance:r', '/grant:r', `*${getSid()}:${directory ? '(OI)(CI)F' : 'F'}`], {
      windowsHide: true, stdio: 'ignore', timeout: 30000,
    });
    if (result.error || result.status !== 0) throw new Error('Private file permission operation failed.');
  } else {
    fs.chmodSync(target, directory ? 0o700 : 0o600);
    if (directory && recursive) {
      const restrictChildren = folder => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          const child = path.join(folder, entry.name);
          const childStat = fs.lstatSync(child);
          if (childStat.isSymbolicLink() || childStat.uid !== process.getuid()) throw new Error('Unsafe runtime path.');
          fs.chmodSync(child, childStat.isDirectory() ? 0o700 : 0o600);
          if (childStat.isDirectory()) restrictChildren(child);
        }
      };
      restrictChildren(target);
    }
  }
  verifyPrivate(target, directory, recursive);
}

function safeDirectory(target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe runtime path.');
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe runtime path.');
  }
  protectPrivate(target, true, true);
  return target;
}

function prepareRuntime() {
  // Protect before Electron or any cookie-producing process is started.
  const profile = safeDirectory(path.join(runtimeRoot, 'login-profile'));
  const locations = { profile, cookies: safeDirectory(path.join(runtimeRoot, 'cookies')) };
  for (const name of ['app-data', 'session-data', 'temp', 'logs', 'crash-dumps', 'downloads']) {
    locations[name] = safeDirectory(path.join(profile, name));
  }
  return locations;
}

function domainAllowed(domain, platform) {
  const host = domain.replace(/^\./, '').toLowerCase();
  // Domain-wide Google cookies and accounts.google.com belong to Google sign-in.
  // Other Google service hosts, such as mail.google.com, are not exported.
  if (platform === 'youtube' && (host === 'google.com' || host === 'accounts.google.com' || host.endsWith('.accounts.google.com'))) return true;
  return platforms[platform].domains.some(base => host === base || host.endsWith(`.${base}`));
}

function navigationAllowed(url, platform, blank = false) {
  if (blank && url === 'about:blank') return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && domainAllowed(parsed.hostname, platform);
  } catch { return false; }
}

function writeCookies(locations, platform, cookies) {
  const selected = cookies.filter(cookie => domainAllowed(cookie.domain, platform));
  const lines = ['# Netscape HTTP Cookie File', '# P0b manual platform login. Do not share this file.', ''];
  for (const cookie of selected) {
    const includeSubdomains = cookie.hostOnly === undefined ? cookie.domain.startsWith('.') : !cookie.hostOnly;
    const hostname = cookie.domain.replace(/^\./, '');
    const domain = `${cookie.httpOnly ? '#HttpOnly_' : ''}${includeSubdomains ? '.' : ''}${hostname}`;
    const fields = [domain, includeSubdomains ? 'TRUE' : 'FALSE', cookie.path || '/', cookie.secure ? 'TRUE' : 'FALSE',
      cookie.session || !cookie.expirationDate ? '0' : String(Math.floor(cookie.expirationDate)), cookie.name, cookie.value];
    if (fields.some(field => /[\t\r\n\0]/.test(field))) throw new Error('Cookie export rejected an unsupported field.');
    lines.push(fields.join('\t'));
  }
  const target = path.join(locations.cookies, `${platform}.txt`);
  const temporary = path.join(locations.cookies, `.${platform}-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    protectPrivate(temporary, false);
    fs.writeFileSync(fd, `${lines.join('\n')}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    verifyPrivate(temporary, false);
    // Atomic replacement retains the verified temporary file's private ACL.
    fs.renameSync(temporary, target);
    verifyPrivate(target, false);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  const present = new Set(selected.map(cookie => cookie.name));
  return { cookieCount: selected.length, authKeysPresent: platforms[platform].authKeys.filter(key => present.has(key)) };
}

function start() {
  const { app, BrowserWindow, session } = require('electron');
  const platform = process.argv[2];
  if (process.argv.length !== 3 || !Object.hasOwn(platforms, platform)) {
    console.error('Usage: npm run login -- youtube|douyu');
    app.exit(1);
    return;
  }
  let locations;
  try { locations = prepareRuntime(); } catch {
    console.error('Login could not start: private runtime permission verification failed.');
    app.exit(1);
    return;
  }
  app.setPath('appData', locations['app-data']);
  app.setPath('userData', locations.profile);
  app.setPath('sessionData', locations['session-data']);
  app.setPath('temp', locations.temp);
  app.setPath('crashDumps', locations['crash-dumps']);
  app.setPath('downloads', locations.downloads);
  app.setAppLogsPath(locations.logs);
  app.commandLine.appendSwitch('disable-logging');
  // One profile-writing process at a time, including across the two platforms.
  if (!app.requestSingleInstanceLock()) {
    console.error('Another login process is already using this prototype profile.');
    app.exit(1);
    return;
  }

  let loginSession;
  let finishing;
  let finished = false;
  let closing = false;
  const windows = new Set();
  const finish = () => {
    if (finishing) return finishing;
    closing = true;
    finishing = (async () => {
      let code = 0;
      try {
        if (!loginSession) throw new Error('Session was not initialized.');
        loginSession.flushStorageData();
        await loginSession.cookies.flushStore();
        const summary = writeCookies(locations, platform, await loginSession.cookies.get({}));
        console.log(`P0_LOGIN ${JSON.stringify(summary)}`);
      } catch {
        // Chromium/API exceptions can contain URLs, tokens or cookie fields.
        console.error('Login cookie export failed. No successful export was reported.');
        code = 1;
      }
      finished = true;
      app.exit(code);
    })();
    return finishing;
  };
  app.on('before-quit', event => {
    if (finished) return;
    event.preventDefault();
    closing = true;
    for (const window of windows) window.destroy();
    void finish();
  });
  app.on('window-all-closed', () => { void finish(); });

  app.whenReady().then(() => {
    loginSession = session.fromPartition(`persist:${platform}`);
    const os = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
    const userAgent = `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
    loginSession.setUserAgent(userAgent);
    loginSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    loginSession.setPermissionCheckHandler(() => false);
    loginSession.setDevicePermissionHandler(() => false);
    loginSession.on('will-download', event => event.preventDefault());

    const preferences = {
      session: loginSession, partition: `persist:${platform}`, contextIsolation: true, sandbox: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    };
    function createWindow(options = {}) {
      const window = new BrowserWindow({
        ...options, width: 1150, height: 850, show: true, title: `P0b ${platform} manual login`,
        autoHideMenuBar: true, webPreferences: preferences,
      });
      window.removeMenu();
      windows.add(window);
      const contents = window.webContents;
      contents.setUserAgent(userAgent);
      contents.on('will-navigate', (event, url) => {
        if (!navigationAllowed(url, platform)) event.preventDefault();
      });
      contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
        if (isMainFrame && !navigationAllowed(url, platform)) event.preventDefault();
      });
      contents.on('will-attach-webview', event => event.preventDefault());
      contents.setWindowOpenHandler(({ url }) => {
        if (closing || !navigationAllowed(url, platform, true)) return { action: 'deny' };
        return {
          action: 'allow', outlivesOpener: true,
          overrideBrowserWindowOptions: { webPreferences: preferences },
          createWindow: options => createWindow(options).webContents,
        };
      });
      window.on('closed', () => {
        windows.delete(window);
        if (windows.size === 0) void finish();
      });
      return window;
    }
    const window = createWindow();
    // Do not print rejected load errors, which may contain an authentication URL.
    window.loadURL(platforms[platform].url, { userAgent }).catch(() => {
      console.error('The platform page did not load. Close all login windows to export the existing session.');
    });
  }).catch(() => {
    console.error('The manual login window could not start.');
    closing = true;
    for (const window of windows) window.destroy();
    void finish();
  });
}

module.exports = { prepareRuntime };
if (require.main === module) start();
