import { lstat, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fingerprintRelease } from './package-archive.mjs'
import { packagingTarget } from './packaging-platform.mjs'
import { elfArchitecture, verifyLinuxRuntime } from './build-ffmpeg-linux.mjs'
import { fileIdentity, macRun as nativeRun } from './build-ffmpeg-mac.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url), { extractFile, listPackage, statFile } = require('@electron/asar')
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const forbiddenPath = name => !/(?:^|\/)provider\/server\/node_modules\/undici\/lib\/web\/cookies(?:\/|$)/.test(name)
  && /(?:^|\/)(?:test-sources|cookies|browser-profile|\.runtime-cache|\.tools|\.git|\.env[^/]*)(?:\/|$)/i.test(name)

async function comparePayload(expected, directory, exact = false) {
  const actual = await fingerprintRelease(directory, { forbiddenPath })
  if (exact) assert(expected.files.size === actual.files.size, 'Linux archive file count differs')
  for (const [name, entry] of expected.files) {
    const other = actual.files.get(name)
    assert(other && entry.sha256 === other.sha256 && entry.size === other.size, 'Linux archive payload differs: ' + name)
  }
}

export async function checkLinuxPackage() {
  const target = packagingTarget()
  assert(target.platform === 'linux', 'Linux 包检查必须在原生 Linux 主机执行')
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const release = path.join(root, '.release'), directory = path.join(release, target.arch === 'x64' ? 'linux-unpacked' : 'linux-arm64-unpacked')
  const resources = path.join(directory, 'resources'), asarFile = path.join(resources, 'app.asar')
  const metadata = JSON.parse(extractFile(asarFile, 'package.json').toString('utf8'))
  assert(metadata.name === 'fy1sync' && metadata.version === version, 'Linux app metadata differs')
  assert(elfArchitecture(await readFile(path.join(directory, 'fy1sync'))) === target.arch, 'Linux app CPU differs')
  assert((await stat(path.join(directory, 'fy1sync'))).mode & 0o111, 'Linux app is not executable')
  for (const name of listPackage(asarFile).map(name => name.replaceAll('\\', '/').replace(/^\//, ''))) {
    assert(/^(?:package\.json|electron(?:\/(?:main|preload|login-card-preload|network-runtime)\.cjs)?|electron\/icon\.png|client(?:\/assets)?|client\/index\.html|client\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|wasm|woff2))$/.test(name), 'Unexpected Linux ASAR entry: ' + name)
  }
  const network = statFile(asarFile, 'electron/network-runtime.cjs')
  const physical = await lstat(path.join(resources, 'app.asar.unpacked', 'electron', 'network-runtime.cjs'))
  assert(network.unpacked && physical.isFile() && !physical.isSymbolicLink() && physical.size === network.size, 'Linux physical network runtime differs')
  const tree = await fingerprintRelease(directory, { forbiddenPath })
  const tools = path.join(resources, 'tools'), inventory = JSON.parse(await readFile(path.join(tools, 'inventory.json'), 'utf8'))
  const actual = [...tree.files.keys()].filter(name => name.startsWith('resources/tools/')).map(name => name.slice('resources/tools/'.length))
  assert(actual.length === inventory.length + 1 && actual.includes('inventory.json'), 'Linux tool inventory count differs')
  for (const entry of inventory) {
    assert(typeof entry.file === 'string' && !entry.file.includes('\\') && !entry.file.startsWith('/') && !entry.file.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe Linux tool inventory path')
    const identity = await fileIdentity(path.join(tools, entry.file))
    assert(identity.size === entry.size && identity.sha256 === entry.sha256, 'Linux tool hash differs: ' + entry.file)
  }
  const lock = JSON.parse(await readFile(path.join(tools, 'tools-lock.json'), 'utf8'))
  assert(lock.target === target.target && lock.ffmpegRuntimeOrigin === 'native-local-build', 'Linux tools target differs')
  await mkdir(path.join(root, '.runtime-cache'), { recursive: true })
  const temporary = await mkdtemp(path.join(root, '.runtime-cache', 'check-linux-'))
  const smoke = path.join(temporary, 'runtime-smoke')
  await mkdir(smoke)
  await verifyLinuxRuntime(path.join(tools, 'ffmpeg'), JSON.parse(await readFile(path.join(root, 'packaging', 'ffmpeg', 'build-lock.json'), 'utf8')), target.arch, smoke)
  const env = { PATH: '/usr/bin:/bin', HOME: smoke, TMPDIR: smoke, LC_ALL: 'C', LANG: 'C' }
  assert(elfArchitecture(await readFile(path.join(tools, 'yt-dlp'))) === target.arch, 'Packaged Linux yt-dlp CPU differs')
  assert((await nativeRun(path.join(tools, 'yt-dlp'), ['--ignore-config', '--no-cache-dir', '--version'], { cwd: smoke, env })).trim() === lock.ytdlpVersion, 'Packaged Linux yt-dlp version differs')
  const artifacts = []
  for (const extension of ['deb', 'AppImage', 'tar.gz']) {
    const name = `Fy1Sync-${version}-linux-${target.arch}.${extension}`, file = path.join(release, name)
    const destination = path.join(temporary, extension)
    await mkdir(destination)
    if (extension === 'deb') {
      const architecture = (await nativeRun('/usr/bin/dpkg-deb', ['--field', file, 'Architecture'])).trim()
      assert(architecture === (target.arch === 'x64' ? 'amd64' : 'arm64'), 'DEB CPU differs')
      assert((await nativeRun('/usr/bin/dpkg-deb', ['--field', file, 'Version'])).trim() === version, 'DEB version differs')
      await nativeRun('/usr/bin/dpkg-deb', ['--extract', file, destination])
      await comparePayload(tree, path.join(destination, 'opt', 'Fy1Sync'), true)
    } else if (extension === 'AppImage') {
      assert(elfArchitecture(await readFile(file)) === target.arch, 'AppImage CPU differs')
      await nativeRun(file, ['--appimage-extract'], { cwd: destination, timeout: 300_000 })
      // AppImage adds its launcher and desktop integration beside the identical application payload.
      for (const [relative, entry] of tree.files) {
        const actual = await fileIdentity(path.join(destination, 'squashfs-root', relative))
        assert(actual.size === entry.size && actual.sha256 === entry.sha256, 'AppImage application payload differs: ' + relative)
      }
    } else {
      const names = (await nativeRun('/usr/bin/tar', ['-tzf', file])).trim().split('\n')
      assert(names.length <= 30_000 && names.every(name => !name.startsWith('/') && !name.includes('\\') && !name.split('/').some(part => part === '..' || part === '.')), 'Unsafe Linux TAR path')
      assert(!/^[lh]/m.test(await nativeRun('/usr/bin/tar', ['-tvzf', file])), 'Linux TAR links are forbidden')
      const roots = new Set(names.map(name => name.split('/')[0]))
      assert(roots.size === 1, 'Linux TAR must have one application root')
      await nativeRun('/usr/bin/tar', ['-xzf', file, '--strip-components=1', '-C', destination])
      await comparePayload(tree, destination, true)
    }
    artifacts.push({ ...await fileIdentity(file), contents: 'matches-unpacked-app' })
  }
  const report = { target: target.target, version, artifacts, toolFiles: inventory.length, validation: 'linux-native', runtimeSmoke: 'passed' }
  const evidence = path.resolve(root, process.env.STREAM_SYNC_PACKAGE_EVIDENCE ?? temporary)
  assert(evidence.startsWith(path.join(root, '.runtime-cache') + path.sep), 'Linux package evidence must stay under .runtime-cache')
  await mkdir(evidence, { recursive: true })
  await writeFile(path.join(evidence, `package-report-linux-${target.arch}.json`), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await checkLinuxPackage() } catch (error) { console.error(error.stack); process.exitCode = 1 }
}
