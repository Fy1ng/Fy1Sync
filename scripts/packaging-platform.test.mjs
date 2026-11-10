import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { macCapabilities, macConfigure, macMinimumSystemVersion, macNativeBuildEnvironment, macRuntimeFiles, nativeMacArch, npmCliPath, packagingTarget, validateToolAsset } from './packaging-platform.mjs'

const lock = JSON.parse(await readFile(new URL('../packaging/ffmpeg/build-lock.json', import.meta.url), 'utf8'))
const config = createRequire(import.meta.url)('../electron-builder.config.cjs')
const windowsToolLock = JSON.parse(await readFile(new URL('../packaging/tools-lock.json', import.meta.url), 'utf8'))
const macToolLock = JSON.parse(await readFile(new URL('../packaging/tools-mac-lock.json', import.meta.url), 'utf8'))

test('all actual Windows/macOS tool assets pass the same preparation validation', () => {
  for (const asset of [...windowsToolLock.assets, ...macToolLock.assets]) assert.equal(validateToolAsset(asset), asset, asset.name)
  assert.ok(macToolLock.assets.some(asset => asset.name === 'yt-dlp_macos'))
})

test('tool asset validation rejects path traversal, separators, invalid lengths/hashes and sizes', () => {
  const asset = macToolLock.assets.find(entry => entry.name === 'yt-dlp_macos')
  for (const name of ['', '.', '..', '../yt-dlp_macos', 'nested/yt-dlp_macos', 'nested\\yt-dlp_macos', '/yt-dlp_macos', 'C:yt-dlp_macos', 'yt-dlp\n', null, 7, ['yt-dlp_macos']]) assert.throws(() => validateToolAsset({ ...asset, name }))
  for (const sha256 of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null, 12]) assert.throws(() => validateToolAsset({ ...asset, sha256 }))
  for (const size of [0, -1, 1.5, NaN, Infinity, '37180736', 256 * 1048576 + 1, Number.MAX_SAFE_INTEGER]) assert.throws(() => validateToolAsset({ ...asset, size }))
  assert.throws(() => validateToolAsset(null))
  assert.equal(validateToolAsset({ ...asset, size: 256 * 1048576 }).size, 256 * 1048576)
})

test('macOS app, supplementary lock and native clang/zlib/FFmpeg flags share the 13.0 baseline', () => {
  assert.equal(macMinimumSystemVersion, '13.0')
  assert.equal(macToolLock.minimumSystemVersion, macMinimumSystemVersion)
  assert.equal(config.mac.minimumSystemVersion, macMinimumSystemVersion)
  const environment = macNativeBuildEnvironment()
  assert.equal(environment.MACOSX_DEPLOYMENT_TARGET, macMinimumSystemVersion)
  assert.equal(environment.CC, '/usr/bin/clang')
  for (const key of ['CFLAGS', 'LDFLAGS']) assert.ok(environment[key].split(' ').includes('-mmacosx-version-min=13.0'))
  for (const arch of ['arm64', 'x64']) {
    const configure = macConfigure(lock, arch)
    for (const kind of ['cflags', 'ldflags']) assert.match(configure.find(value => value.startsWith('--extra-' + kind + '=')), /-mmacosx-version-min=13\.0(?: |$)/)
  }
})

test('native packaging accepts only the supported platform/architecture pairs', () => {
  assert.equal(packagingTarget('win32', 'x64').executableSuffix, '.exe')
  for (const arch of ['arm64', 'x64']) assert.equal(packagingTarget('darwin', arch).target, `darwin-${arch}`)
  for (const arch of ['arm64', 'x64']) assert.equal(packagingTarget('linux', arch).target, `linux-${arch}`)
  for (const [platform, arch] of [['linux', 'ia32'], ['win32', 'arm64'], ['darwin', 'ia32']]) assert.throws(() => packagingTarget(platform, arch))
})

test('macOS packaging rejects cross-architecture tools, universal and unsupported flags', () => {
  assert.equal(nativeMacArch([], 'arm64', 'darwin').arch, 'arm64')
  assert.equal(nativeMacArch(['--x64'], 'x64', 'darwin').arch, 'x64')
  assert.throws(() => nativeMacArch(['--x64'], 'arm64', 'darwin'))
  assert.throws(() => nativeMacArch(['--arm64'], 'x64', 'win32'))
  for (const args of [['--universal'], ['--arm64', '--x64'], ['dmg'], ['--publish']]) assert.throws(() => nativeMacArch(args, 'arm64', 'darwin'))
})

test('macOS configure keeps the locked LGPL/media settings and changes only native platform details', () => {
  for (const arch of ['arm64', 'x64']) {
    const options = macConfigure(lock, arch)
    for (const option of lock.configure.filter(value => /^--(?:enable-(?:protocol|demuxer|muxer|decoder|encoder|parser|bsf|filter)=|disable-(?:gpl|nonfree|version3|autodetect|everything)|enable-shared|disable-static)/.test(value))) assert.ok(options.includes(option), option)
    assert.ok(options.includes('--enable-securetransport'))
    assert.ok(options.includes('--disable-asm'))
    assert.ok(options.includes('--install-name-dir=@rpath'))
    assert.ok(options.includes('--arch=' + (arch === 'arm64' ? 'aarch64' : 'x86_64')))
    assert.ok(options.every(value => !/schannel|w32threads$|static-libgcc|winpthread|no-insert-timestamp/.test(value) || value === '--disable-w32threads'))
  }
  assert.deepEqual(macCapabilities(lock).protocol, ['crypto', 'file', 'http', 'httpproxy', 'https', 'pipe', 'tcp', 'tls'])
  assert.deepEqual(macCapabilities(lock).decoder, lock.capabilities.decoder)
  assert.equal(macRuntimeFiles(lock).length, 7)
  assert.ok(macRuntimeFiles(lock).includes('libavcodec.62.dylib'))
})

test('builder keeps Windows targets and exposes architecture-labelled macOS DMG/ZIP', () => {
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }])
  assert.equal(config.nsis.artifactName, 'Fy1Sync-${version}-win-x64-nsis.${ext}')
  assert.equal(config.artifactName, 'Fy1Sync-${version}-win-x64-portable.${ext}')
  assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }])
  assert.equal(config.mac.artifactName, 'Fy1Sync-${version}-mac-${arch}.${ext}')
  assert.ok(config.files.includes('electron/login-card-preload.cjs'))
})

test('npm CLI discovery uses a real npm entry without shell command construction', () => {
  const current = npmCliPath()
  assert.equal(npmCliPath({ npm_execpath: current }, '/missing/node'), current)
  assert.throws(() => npmCliPath({ npm_execpath: '/missing/npm-cli.js' }, '/missing/node'))
})
