import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { macMinimumSystemVersion, macRuntimeFiles, nativeMacArch } from './packaging-platform.mjs'
import { assertMacDeploymentTarget, fileIdentity, macRun, machoArchitectures, verifyMacRuntime } from './build-ffmpeg-mac.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const { extractFile, listPackage, statFile } = require('@electron/asar')
const packagingRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const unzipper = packagingRequire('unzipper')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const forbidden = /(?:^|\/)(?:test-sources|cookies|browser-profile|\.runtime-cache|\.tools|\.git|\.env[^/]*)(?:\/|$)/i
function forbiddenPath(name) {
  if (/(?:^|\/)provider\/server\/node_modules\/undici\/lib\/web\/cookies(?:\/|$)/.test(name)) return false
  return forbidden.test(name)
}

export async function fingerprintMacApp(directory) {
  const supplied = path.resolve(directory), tree = new Map()
  assert((await lstat(supplied)).isDirectory() && !(await lstat(supplied)).isSymbolicLink(), 'macOS application must be a regular directory')
  const absolute = await realpath(supplied)
  async function walk(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name, file = path.join(folder, entry.name), info = await lstat(file)
      assert(!forbiddenPath(name), 'Forbidden macOS release path: ' + name)
      if (info.isSymbolicLink()) {
        // Electron Framework's version aliases are expected; tools/app resources must be regular files.
        assert(name.startsWith('Contents/Frameworks/'), 'Unexpected macOS release symlink: ' + name)
        const link = await readlink(file), resolved = await realpath(file)
        assert(!path.isAbsolute(link) && resolved.startsWith(absolute + path.sep), 'macOS Framework link escapes application')
        tree.set(name, { type: 'link', link })
      } else if (info.isDirectory()) {
        tree.set(name, { type: 'directory' })
        await walk(file, name + '/')
      } else {
        assert(info.isFile(), 'Non-regular macOS release file: ' + name)
        tree.set(name, { type: 'file', size: info.size, sha256: digest(await readFile(file)), executable: (info.mode & 0o111) !== 0 })
      }
    }
  }
  await walk(absolute)
  return tree
}

export function compareMacTrees(expected, actual) {
  assert(expected.size === actual.size, 'macOS ZIP file inventory differs')
  for (const [name, entry] of expected) assert(JSON.stringify(entry) === JSON.stringify(actual.get(name)), 'macOS ZIP differs from unpacked application: ' + name)
}

export async function preflightMacZip(file, expected) {
  const info = await stat(file)
  assert(info.size > 0 && info.size <= 2 * 1024 ** 3, 'macOS ZIP archive exceeds size limit')
  const archive = await unzipper.Open.file(file)
  assert(archive.files.length > 0 && archive.files.length <= 20_000, 'macOS ZIP entry count exceeds limit')
  const keys = new Set(), links = new Set()
  let total = 0
  for (const entry of archive.files) {
    const name = entry.path.replace(/\/$/, '')
    assert(name && !/[\\\x00-\x1f]/.test(name) && !name.startsWith('/') && !name.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe macOS ZIP entry path')
    assert(!keys.has(name), 'Duplicate macOS ZIP entry path')
    keys.add(name)
    assert(Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize >= 0 && entry.uncompressedSize <= 1024 ** 3, 'macOS ZIP member exceeds size limit')
    total += entry.uncompressedSize
    assert(total <= 4 * 1024 ** 3, 'macOS ZIP total exceeds size limit')
    if (name.startsWith('__MACOSX/')) {
      assert(entry.type === 'Directory' || path.posix.basename(name).startsWith('._'), 'Unexpected macOS ZIP resource-fork metadata')
      assert(((entry.externalFileAttributes >>> 16) & 0xf000) !== 0xa000, 'Metadata ZIP symlinks are forbidden')
      continue
    }
    assert(name === 'Fy1Sync.app' || name.startsWith('Fy1Sync.app/'), 'Unexpected root in macOS ZIP')
    if (name === 'Fy1Sync.app') { assert(entry.type === 'Directory', 'Application ZIP root must be directory'); continue }
    const relative = name.slice('Fy1Sync.app/'.length), original = expected.get(relative)
    assert(original, 'Unexpected macOS ZIP member: ' + relative)
    const kind = (entry.externalFileAttributes >>> 16) & 0xf000
    if (original.type === 'link') {
      assert(kind === 0xa000 && entry.uncompressedSize <= 1024, 'macOS ZIP symlink metadata differs')
      const target = (await entry.buffer()).toString('utf8')
      assert(target === original.link, 'macOS ZIP Framework symlink differs')
      links.add(name)
    } else assert(kind !== 0xa000 && (entry.type === 'Directory') === (original.type === 'directory'), 'macOS ZIP entry type differs')
  }
  for (const name of keys) {
    const parts = name.split('/')
    for (let index = 1; index < parts.length; index++) assert(!links.has(parts.slice(0, index).join('/')), 'macOS ZIP member traverses an archive symlink')
  }
}

async function checkSignedTool(file, entry, temporary) {
  const actual = await fileIdentity(file)
  if (actual.size === entry.size && actual.sha256 === entry.sha256) return 'original'
  assert(Number.isSafeInteger(entry.unsignedSize) && /^[a-f0-9]{64}$/.test(entry.unsignedSha256), 'Missing canonical signed-tool inventory')
  await macRun('/usr/bin/codesign', ['--verify', '--strict', file])
  const copy = path.join(temporary, path.basename(file) + '.unsigned')
  await cp(file, copy)
  await macRun('/usr/bin/codesign', ['--remove-signature', copy])
  const canonical = await fileIdentity(copy)
  await rm(copy, { force: true })
  assert(canonical.size === entry.unsignedSize && canonical.sha256 === entry.unsignedSha256, 'Packaged tool payload differs after removing code signature: ' + entry.file)
  return 'verified-signature-change'
}

export async function checkMacPackage() {
  const target = nativeMacArch(process.argv.slice(2))
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const release = path.join(root, '.release'), directory = path.join(release, target.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Fy1Sync.app')
  const resources = path.join(directory, 'Contents', 'Resources')
  await mkdir(path.join(root, '.runtime-cache'), { recursive: true })
  const temporary = await mkdtemp(path.join(root, '.runtime-cache', 'check-package-mac-'))
  const asarPath = path.join(resources, 'app.asar')
  const asar = listPackage(asarPath).map(name => name.replaceAll('\\', '/').replace(/^\//, ''))
  const metadata = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'))
  assert(metadata.name === 'fy1sync' && metadata.version === version, 'Unexpected macOS application metadata')
  for (const name of asar) assert(/^(?:package\.json|electron(?:\/(?:main|preload|login-card-preload|network-runtime)\.cjs)?|electron\/icon\.png|client(?:\/assets)?|client\/index\.html|client\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|wasm|woff2))$/.test(name), 'Unexpected macOS ASAR entry: ' + name)
  assert(extractFile(asarPath, 'electron/icon.png').equals(await readFile(path.join(root, 'packaging', 'icon.png'))), 'macOS runtime icon differs from release artwork')
  const network = statFile(asarPath, 'electron/network-runtime.cjs'), physical = await lstat(path.join(resources, 'app.asar.unpacked', 'electron', 'network-runtime.cjs'))
  assert(network.unpacked && physical.isFile() && !physical.isSymbolicLink() && physical.size === network.size && physical.size > 0, 'Physical macOS network runtime differs from ASAR')
  const executable = path.join(directory, 'Contents', 'MacOS', 'Fy1Sync'), info = await stat(executable)
  assert(info.isFile() && (info.mode & 0o111) !== 0 && machoArchitectures(await readFile(executable)).includes(target.arch), 'macOS application executable CPU/permission differs')
  const plist = JSON.parse(await macRun('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(directory, 'Contents', 'Info.plist')]))
  assert(plist.CFBundleIdentifier === 'cn.fy1ng.fy1sync' && plist.CFBundleShortVersionString === version, 'macOS bundle metadata differs')
  assert(plist.LSMinimumSystemVersion === macMinimumSystemVersion, 'macOS bundle minimum system version differs')
  for (const name of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) assert((await stat(path.join(directory, 'Contents', name))).size > 0, 'Electron license missing from macOS app')
  const lock = JSON.parse(await readFile(path.join(resources, 'tools', 'tools-lock.json'), 'utf8'))
  assert(lock.target === target.target && lock.ffmpegRuntimeOrigin === 'native-local-build', 'macOS packaged tools platform/architecture differs')
  assert(lock.minimumSystemVersion === macMinimumSystemVersion, 'macOS packaged tools minimum system version differs')
  const sourceLock = JSON.parse(await readFile(path.join(root, 'packaging', 'ffmpeg', 'build-lock.json'), 'utf8'))
  const binaries = new Set(['yt-dlp', ...macRuntimeFiles(sourceLock).map(name => 'ffmpeg/' + name)])
  const inventory = JSON.parse(await readFile(path.join(resources, 'tools', 'inventory.json'), 'utf8'))
  const tree = await fingerprintMacApp(directory), actualTools = [...tree].filter(([name, entry]) => name.startsWith('Contents/Resources/tools/') && entry.type === 'file').map(([name]) => name.slice('Contents/Resources/tools/'.length))
  const expected = new Set(inventory.map(entry => entry.file)); expected.add('inventory.json')
  assert(actualTools.length === expected.size && actualTools.every(name => expected.has(name)), 'macOS tool resource inventory differs')
  const signatureChanges = []
  for (const entry of inventory) {
    assert(typeof entry.file === 'string' && !entry.file.includes('\\') && !entry.file.startsWith('/') && !entry.file.split('/').some(part => !part || part === '.' || part === '..'), 'Invalid tool inventory entry')
    const file = path.join(resources, 'tools', entry.file)
    if (binaries.has(entry.file)) {
      const binaryInfo = await stat(file)
      assert((binaryInfo.mode & 0o111) !== 0 || entry.file.endsWith('.dylib'), 'Packaged macOS tool is not executable')
      const architectures = machoArchitectures(await readFile(file))
      assert(architectures.includes(target.arch) && (entry.file === 'yt-dlp' || architectures.length === 1), 'Packaged native tool CPU differs')
      if (entry.file.startsWith('ffmpeg/')) assertMacDeploymentTarget(await macRun('/usr/bin/otool', ['-l', file]))
      if (await checkSignedTool(file, entry, temporary) !== 'original') signatureChanges.push(entry.file)
    } else {
      const actual = await fileIdentity(file)
      assert(actual.size === entry.size && actual.sha256 === entry.sha256, 'macOS packaged tool hash differs: ' + entry.file)
    }
  }
  const smoke = path.join(temporary, 'runtime-smoke')
  await mkdir(smoke)
  await verifyMacRuntime(path.join(resources, 'tools', 'ffmpeg'), sourceLock, target.arch, smoke)
  const toolEnvironment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: smoke, TMPDIR: smoke, LC_ALL: 'C', LANG: 'C' }
  assert((await macRun(path.join(resources, 'tools', 'yt-dlp'), ['--ignore-config', '--no-cache-dir', '--version'], { cwd: smoke, env: toolEnvironment, timeout: 60_000 })).trim() === lock.ytdlpVersion, 'Packaged macOS yt-dlp failed to start or reported a different version')
  const artifacts = []
  for (const extension of ['dmg', 'zip']) {
    const name = `Fy1Sync-${version}-mac-${target.arch}.${extension}`, file = path.join(release, name)
    const artifact = { file, ...await fileIdentity(file) }
    if (extension === 'dmg') {
      await macRun('/usr/bin/hdiutil', ['verify', file], { cwd: temporary })
      const mount = path.join(temporary, 'dmg')
      await mkdir(mount)
      try {
        await macRun('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, file], { cwd: temporary })
        compareMacTrees(tree, await fingerprintMacApp(path.join(mount, 'Fy1Sync.app')))
      } finally {
        await macRun('/usr/bin/hdiutil', ['detach', mount], { cwd: temporary })
      }
      artifact.contents = { entries: tree.size, status: 'matches-unpacked-app' }
    } else {
      const extracted = path.join(temporary, 'zip')
      await preflightMacZip(file, tree)
      await mkdir(extracted)
      await macRun('/usr/bin/ditto', ['-x', '-k', file, extracted], { cwd: temporary })
      assert(JSON.stringify((await readdir(extracted)).sort()) === JSON.stringify(['Fy1Sync.app']), 'macOS ZIP must contain only Fy1Sync.app')
      compareMacTrees(tree, await fingerprintMacApp(path.join(extracted, 'Fy1Sync.app')))
      artifact.contents = { entries: tree.size, status: 'matches-unpacked-app' }
    }
    artifacts.push(artifact)
  }
  const report = { target: target.target, asarEntries: asar.length, toolFiles: actualTools.length, signatureChanges, artifacts,
    ffmpegBuildId: lock.ffmpegBuildId, status: 'local-evaluation-only', validation: 'macOS-native', runtimeSmoke: 'passed' }
  const evidence = process.env.STREAM_SYNC_PACKAGE_EVIDENCE ? path.resolve(root, process.env.STREAM_SYNC_PACKAGE_EVIDENCE) : temporary
  assert(evidence.startsWith(path.join(root, '.runtime-cache') + path.sep), 'Package evidence must stay under .runtime-cache')
  await mkdir(evidence, { recursive: true })
  await writeFile(path.join(evidence, `package-report-mac-${target.arch}.json`), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await checkMacPackage() } catch (error) { console.error(error.stack); process.exitCode = 1 }
}
