const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime');

function restrict(file, directory = false) {
  try {
    if (process.platform === 'win32') {
      const user = process.env.USERDOMAIN
        ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
      execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `${user}:F`], {
        stdio: 'ignore', windowsHide: true,
      });
    } else {
      fs.chmodSync(file, directory ? 0o700 : 0o600);
    }
  } catch {
    throw new Error('Could not restrict temporary cookie storage to the current user');
  }
}

// No credentials are accepted from outside the prototype's ignored runtime tree.
function loadCookies() {
  if (!process.env.P0_COOKIES) return null;
  try {
    const base = fs.realpathSync(runtime);
    if (fs.lstatSync(runtime).isSymbolicLink()) throw new Error();
    const file = fs.realpathSync(path.resolve(process.env.P0_COOKIES));
    const relative = path.relative(base, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || !fs.statSync(file).isFile() || fs.statSync(file).size > 4 * 1024 * 1024) {
      throw new Error();
    }
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (!/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)/.test(text)) throw new Error();
    const cookies = [];
    for (let line of text.split(/\r?\n/)) {
      if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
      else if (!line || line.startsWith('#')) continue;
      const fields = line.split('\t');
      if (fields.length !== 7) throw new Error();
      const [domain, subdomains, cookiePath, secure, expiry, name, value] = fields;
      if (!/^\.?[a-z0-9.-]+$/i.test(domain) || !/^(TRUE|FALSE)$/.test(subdomains)
        || !cookiePath.startsWith('/') || /[\x00-\x20\x7f]/.test(cookiePath)
        || !/^(TRUE|FALSE)$/.test(secure) || !/^\d+$/.test(expiry)
        || !/^[!#$%&'*+.^_`|~a-z0-9-]+$/i.test(name) || /[\x00-\x20\x7f;]/.test(value)) throw new Error();
      const expires = Number(expiry);
      if (!Number.isSafeInteger(expires)) throw new Error();
      if (expires && expires <= Date.now() / 1000) continue;
      cookies.push({ domain: domain.replace(/^\./, '').toLowerCase(), subdomains: subdomains === 'TRUE',
        path: cookiePath, secure: secure === 'TRUE', name, value });
    }
    return { text, cookies };
  } catch {
    throw new Error('P0_COOKIES must be a valid Netscape cookie file inside prototype/.runtime/');
  }
}

function createCookieContext() {
  const loaded = loadCookies();
  return {
    enabled: loaded !== null,
    count: loaded?.cookies.length ?? 0,
    // Child diagnostics and authenticated HTML/JSON may echo credentials. Keep
    // them in memory and persist only the caller's explicitly selected metrics.
    diagnostics(text) {
      return loaded && text ? '[Cookie-enabled diagnostics omitted]' : String(text);
    },
    headerFor(url) {
      if (!loaded) return '';
      const target = new URL(url);
      if (target.protocol !== 'https:' || !(target.hostname === 'douyu.com' || target.hostname.endsWith('.douyu.com'))) return '';
      return loaded.cookies.filter(cookie =>
        (cookie.domain === 'douyu.com' || cookie.domain.endsWith('.douyu.com'))
        && (target.hostname === cookie.domain || (cookie.subdomains && target.hostname.endsWith(`.${cookie.domain}`)))
        && (target.pathname === cookie.path || (target.pathname.startsWith(cookie.path)
          && (cookie.path.endsWith('/') || target.pathname[cookie.path.length] === '/'))))
        .sort((a, b) => b.path.length - a.path.length)
        .map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    },
    async withYtdlpCookies(callback) {
      if (!loaded) return await callback([]);
      const parent = path.join(runtime, 'cookies');
      fs.mkdirSync(parent, { recursive: true });
      if (!fs.realpathSync(parent).startsWith(fs.realpathSync(runtime) + path.sep)) {
        throw new Error('Temporary cookies must remain inside prototype/.runtime/');
      }
      const directory = fs.mkdtempSync(path.join(parent, 'yt-dlp-'));
      const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
      try {
        restrict(directory, true);
        const temporary = path.join(directory, 'cookies.txt');
        fs.writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
        restrict(temporary);
        fs.writeFileSync(temporary, loaded.text, { mode: 0o600 });
        process.once('exit', cleanup);
        return await callback(['--cookies', temporary]);
      } finally {
        process.removeListener('exit', cleanup);
        cleanup();
      }
    },
  };
}

module.exports = { createCookieContext };
