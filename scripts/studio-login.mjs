/**
 * Open this build with the login state of the installed / unpacked app, without sharing it.
 *
 * The packaged app keeps its logins in %APPDATA%\Fy1Sync (YouTube and Douyu cookie
 * files, the login windows' browser profiles, extra Douyu accounts). This copies those into a
 * profile of its own under .runtime-cache and starts the built app there, online and in
 * normal mode, so logging out or switching accounts here never touches the original.
 *
 *   npm run build              (or: npx vite build && node scripts/build-electron.mjs)
 *   node scripts/studio-login.mjs [--refresh] [--from <userData dir>] [--check]
 *
 * --refresh  copy the logins again (do this after logging in again in the other app)
 * --check    print what this build sees as logged in, then quit
 */

import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined }

const root = fileURLToPath(new URL('../', import.meta.url))
const source = option('from') ?? join(process.env.APPDATA ?? '', 'Fy1Sync')
const profile = join(root, '.runtime-cache', 'login-profile')
const exists = (path) => stat(path).then(() => true, () => false)

if (!await exists(join(source, 'cookies')) && !await exists(join(source, 'douyu'))) {
  console.error(`在 ${source} 里没找到登录信息。先在那边的应用里登录，或用 --from 指定目录。`)
  process.exit(1)
}

// Chromium's lock files must not travel: they would make the copy look in use.
const skip = (path) => /[\\/](lockfile|Singleton\w*|LOCK)$/i.test(path) || /[\\/](Cache|Code Cache|GPUCache|Crashpad)([\\/]|$)/i.test(path)

if (flag('refresh') || !await exists(profile)) {
  await rm(profile, { recursive: true, force: true })
  await mkdir(profile, { recursive: true })
  for (const entry of ['cookies', 'browser-profile', 'douyu']) {
    if (await exists(join(source, entry))) await cp(join(source, entry), join(profile, entry), { recursive: true, filter: (path) => !skip(path) })
  }
  // Copies inherit the folder's ACL, which the app rightly refuses for login data. Give every
  // copied item the same owner-only access the originals have.
  if (process.platform === 'win32') {
    // Full paths: a Git Bash on PATH brings its own `whoami`.
    const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    const sid = execFileSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim().split(',').at(-1).replaceAll('"', '')
    // The profile itself becomes owner-only; everything copied below then inherits just that.
    const icacls = (...args) => execFileSync(join(system32, 'icacls.exe'), args, { stdio: 'ignore' })
    icacls(profile, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`)
    icacls(join(profile, '*'), '/reset', '/T', '/C', '/Q')
  }
  console.log(`已从 ${source} 复制登录信息：${(await readdir(profile)).join('、')}`)
}

const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined
  && !/^STREAM_SYNC_/i.test(name) && !/^ELECTRON_RUN_AS_NODE$/i.test(name)))
env.STREAM_SYNC_USER_DATA_DIR = profile

// A dev build has no bundled tools and falls back to whatever yt-dlp is on PATH, without the
// PO-token provider YouTube now needs. Borrow the packaged build's yt-dlp and provider: copied,
// so a repackage elsewhere never finds its files held open by this app.
const packagedTools = option('tools') ?? await findPackagedTools()
if (packagedTools) {
  const tools = join(root, '.runtime-cache', 'tools')
  const lock = async (dir) => readFile(join(dir, 'tools-lock.json'), 'utf8').catch(() => '')
  if (await lock(packagedTools) !== await lock(tools)) {
    await rm(tools, { recursive: true, force: true })
    for (const entry of ['yt-dlp.exe', 'provider', 'tools-lock.json']) await cp(join(packagedTools, entry), join(tools, entry), { recursive: true })
    console.log(`已从 ${packagedTools} 复制 yt-dlp 和 YouTube 令牌组件。`)
  }
  env.STREAM_SYNC_YTDLP = join(tools, 'yt-dlp.exe')
  env.STREAM_SYNC_POT_PLUGIN_DIR = join(tools, 'provider', 'plugin')
  env.STREAM_SYNC_POT_SERVER_HOME = join(tools, 'provider', 'server')
} else {
  console.log('没有找到打包版的工具目录（.release/win-unpacked/resources/tools），YouTube 可能无法解析。可用 --tools 指定。')
}

/** The packaged tools of this checkout or of any other worktree of the same repository. */
async function findPackagedTools() {
  const inside = join('.release', 'win-unpacked', 'resources', 'tools')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const candidates = [join(root, inside)]
  try {
    const prefix = git('rev-parse', '--show-prefix')
    for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
      if (line.startsWith('worktree ')) candidates.push(join(line.slice('worktree '.length), prefix, inside))
    }
  } catch { /* not a git checkout: only this folder */ }
  for (const candidate of candidates) if (await exists(join(candidate, 'yt-dlp.exe'))) return candidate
  return null
}

if (flag('check')) {
  const { _electron } = await import('@playwright/test')
  const app = await _electron.launch({ args: [join(root, 'dist/electron/main.cjs')], cwd: root, env })
  const page = await app.firstWindow()
  await page.waitForFunction(() => typeof window.streamSyncer?.invoke === 'function', undefined, { timeout: 30_000 })
  const seen = await page.evaluate(async () => ({
    platforms: await window.streamSyncer.invoke('loginStatus', undefined),
    douyu: await window.streamSyncer.invoke('listDouyuAccounts', undefined),
    tools: await window.streamSyncer.invoke('getToolsStatus', undefined),
  }))
  console.log(JSON.stringify(seen, null, 2))
  await app.close()
  process.exit(0)
}

const electron = join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const child = spawn(electron, [join(root, 'dist/electron/main.cjs')], { cwd: root, env, stdio: 'ignore', detached: true })
child.unref()
console.log(`已用复制的登录信息打开（${profile}）。`)
