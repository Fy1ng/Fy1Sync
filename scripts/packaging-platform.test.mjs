import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { macCapabilities, macConfigure, macMinimumSystemVersion, macNativeBuildEnvironment, macPackagingEnvironment, macRuntimeFiles, nativeMacArch, npmCliPath, packagingTarget, prepareBuilderCache, validateToolAsset } from './packaging-platform.mjs'
import { assertProviderDependencies } from './provider-dependencies.mjs'

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
  assert.ok(macRuntimeFiles(lock).includes('libavcodec.63.dylib'))
})

test('builder keeps Windows targets and exposes architecture-labelled macOS DMG/ZIP', () => {
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }])
  assert.equal(config.nsis.artifactName, 'Fy1Sync-${version}-win-x64-nsis.${ext}')
  assert.equal(config.artifactName, 'Fy1Sync-${version}-win-x64-portable.${ext}')
  assert.deepEqual(config.mac.target, ['dmg', 'zip'])
  assert.deepEqual(config.linux.target, ['deb', 'AppImage', 'tar.gz'])
  assert.equal(config.mac.artifactName, 'Fy1Sync-${version}-mac-${arch}.${ext}')
  assert.ok(config.files.includes('electron/login-card-preload.cjs'))
})

test('macOS builder config defaults to valid ad-hoc signing and switches cleanly for real certificates', async () => {
  const req = createRequire(import.meta.url)
  const configPath = req.resolve('../electron-builder.config.cjs')
  const { validateConfiguration } = req('../node_modules/app-builder-lib/out/util/config/config.js')
  const { log } = req('../node_modules/builder-util')
  const loadWithEnv = overrides => {
    const saved = { CSC_LINK: process.env.CSC_LINK, CSC_NAME: process.env.CSC_NAME, CSC_KEYCHAIN: process.env.CSC_KEYCHAIN }
    try {
      for (const key of Object.keys(saved)) delete process.env[key]
      Object.assign(process.env, overrides)
      delete req.cache[configPath]
      return req(configPath)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      delete req.cache[configPath]
    }
  }
  const adhoc = loadWithEnv({})
  await validateConfiguration({ ...adhoc }, log)
  assert.equal(adhoc.mac.identity, '-')
  assert.equal(adhoc.mac.hardenedRuntime, false)
  assert.equal(adhoc.mac.timestamp, 'none')
  assert.equal(adhoc.mac.extraFiles, undefined)
  assert.deepEqual(adhoc.mac.extraResources.map(entry => entry.to), ['LICENSE.electron.txt', 'LICENSES.chromium.html'])
  assert.equal(adhoc.dmg.background, 'packaging/dmg-background.png')
  assert.deepEqual(adhoc.dmg.contents, [
    { x: 140, y: 110, type: 'file', name: 'Fy1Sync.app' },
    { x: 400, y: 110, type: 'link', path: '/Applications' },
  ])
  const adhocIgnore = new RegExp(adhoc.mac.signIgnore[0])
  assert.equal(adhocIgnore.test('/tmp/Fy1Sync.app'), false)
  assert.equal(adhocIgnore.test('/tmp/Fy1Sync.app/Contents/MacOS/Fy1Sync'), false)
  assert.equal(adhocIgnore.test('/tmp/Fy1Sync.app/Contents/Frameworks/Fy1Sync Helper.app'), false)
  assert.equal(adhocIgnore.test('/tmp/Fy1Sync.app/Contents/Resources/tools/yt-dlp'), true)
  assert.equal(adhocIgnore.test('/tmp/Fy1Sync.app/Contents/Resources/tools/ffmpeg/ffmpeg'), true)

  const signed = loadWithEnv({ CSC_LINK: 'certificate.p12' })
  await validateConfiguration({ ...signed }, log)
  assert.equal(signed.mac.identity, undefined)
  assert.equal(signed.mac.hardenedRuntime, true)
  assert.equal(signed.mac.timestamp, undefined)
  assert.deepEqual(signed.dmg, {})
  const signedIgnore = new RegExp(signed.mac.signIgnore[0])
  assert.equal(signedIgnore.test('/tmp/Fy1Sync.app/Contents/Resources/tools/yt-dlp'), false)
  assert.equal(signedIgnore.test('/tmp/Fy1Sync.app/Contents/Resources/tools/yt-dlp-LICENSE.txt'), true)
  assert.equal(signedIgnore.test('/tmp/Fy1Sync.app/Contents/Resources/team-logos/events/logos/a.png'), true)
  assert.equal(signedIgnore.test('/tmp/Fy1Sync.app/Contents/Resources/tools/ffmpeg/ffmpeg'), false)
  assert.equal(signedIgnore.test('/tmp/Fy1Sync.app/Contents/Resources/tools/ffmpeg/libavcodec.63.dylib'), false)

  const bg1x = await readFile(fileURLPath('../packaging/dmg-background.png'))
  const bg2x = await readFile(fileURLPath('../packaging/dmg-background@2x.png'))
  const parsePngMetrics = bytes => {
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
    let cursor = 8, ppmX = 0, ppmY = 0, unit = 0
    while (cursor + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(cursor), type = bytes.toString('ascii', cursor + 4, cursor + 8)
      if (type === 'pHYs') {
        ppmX = bytes.readUInt32BE(cursor + 8)
        ppmY = bytes.readUInt32BE(cursor + 12)
        unit = bytes.readUInt8(cursor + 16)
      }
      assert.equal(['tEXt', 'zTXt', 'iTXt', 'tIME'].includes(type), false, 'Unexpected metadata chunk: ' + type)
      cursor += length + 12
    }
    return { width, height, ppmX, ppmY, unit }
  }
  const m1 = parsePngMetrics(bg1x), m2 = parsePngMetrics(bg2x)
  assert.deepEqual(m1, { width: 540, height: 436, ppmX: 2835, ppmY: 2835, unit: 1 })
  assert.deepEqual(m2, { width: 1080, height: 872, ppmX: 5670, ppmY: 5670, unit: 1 })
})

test('macOS packaging environment strips blank CI secrets and enables identity auto-discovery for CSC_LINK', async () => {
  const withoutSecrets = macPackagingEnvironment({
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    CSC_LINK: '',
    CSC_KEY_PASSWORD: '   ',
    APPLE_ID: '',
  }, '/repo')
  assert.equal(withoutSecrets.CSC_LINK, undefined)
  assert.equal(withoutSecrets.CSC_KEY_PASSWORD, undefined)
  assert.equal(withoutSecrets.APPLE_ID, undefined)
  assert.equal(withoutSecrets.CSC_IDENTITY_AUTO_DISCOVERY, 'false')

  const withCert = macPackagingEnvironment({
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    CSC_LINK: 'base64-p12',
    APPLE_ID: '',
  }, '/repo')
  assert.equal(withCert.CSC_LINK, 'base64-p12')
  assert.equal(withCert.APPLE_ID, undefined)
  assert.equal(withCert.CSC_IDENTITY_AUTO_DISCOVERY, 'true')

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fy1sync-provider-native-'))
  try {
    await mkdir(path.join(tempDir, 'quickjs-wasi', 'extensions', 'url'), { recursive: true })
    await writeFile(path.join(tempDir, 'quickjs-wasi', 'extensions', 'url', 'url.so'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
    await assertProviderDependencies(tempDir)
    await writeFile(path.join(tempDir, 'quickjs-wasi', 'extensions', 'url', 'elf.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))
    await assert.rejects(assertProviderDependencies(tempDir), /elf\.so/)
    await rm(path.join(tempDir, 'quickjs-wasi', 'extensions', 'url', 'elf.so'))
    await writeFile(path.join(tempDir, 'addon.dylib'), 'macho')
    await assert.rejects(assertProviderDependencies(tempDir), /addon\.dylib/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('downloaded CommonJS builder helpers execute beneath an ESM source project', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fy1sync-builder-cache-'))
  try {
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n')
    const cache = path.join(directory, 'cache'), bundle = path.join(cache, 'icons-bundle')
    await mkdir(bundle, { recursive: true })
    const helper = path.join(bundle, 'icon-tool.js')
    await writeFile(helper, 'console.log(require("node:fs").existsSync(process.argv[1]))\n')
    assert.notEqual(spawnSync(process.execPath, [helper], { encoding: 'utf8' }).status, 0)
    await prepareBuilderCache(cache)
    const outcome = spawnSync(process.execPath, [helper], { encoding: 'utf8' })
    assert.equal(outcome.status, 0, outcome.stderr)
    assert.equal(outcome.stdout.trim(), 'true')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('npm CLI discovery uses a real npm entry without shell command construction', () => {
  const current = npmCliPath()
  assert.equal(npmCliPath({ npm_execpath: current }, '/missing/node'), current)
  assert.throws(() => npmCliPath({ npm_execpath: '/missing/npm-cli.js' }, '/missing/node'))
})

test('NSIS customInit never silently quits interactive launches on long default paths', async () => {
  const installerNshPath = fileURLPath('../packaging/installer.nsh')
  const installerNsh = await readFile(installerNshPath, 'utf8')
  const customInitMatch = installerNsh.match(/!macro customInit\r?\n([\s\S]*?)!macroend/)
  assert.ok(customInitMatch, 'customInit macro must exist')
  const customInit = customInitMatch[1]
  assert.match(customInit, /\$\{If\}\s+\$\{isForAllUsers\}[\s\S]*?\$\{IfNot\}\s+\$\{Silent\}\s*\r?\n\s*MessageBox\s+MB_OK\|MB_ICONSTOP/)
  assert.match(customInit, /\$\{If\}\s+\$R8\s*>\s*\$\{STREAM_SYNC_MAX_INSTALL_DIR\}[\s\S]*?\$\{If\}\s+\$\{Silent\}\s*\r?\n\s*SetErrorLevel\s+2\s*\r?\n\s*Quit\s*\r?\n\s*\$\{EndIf\}/)
  assert.match(customInit, /\$\{If\}\s+\$\{isUpdated\}\s*\r?\n\s*MessageBox\s+MB_OK\|MB_ICONSTOP[\s\S]*?Quit\s*\r?\n\s*\$\{EndIf\}/)
  assert.match(customInit, /MessageBox\s+MB_OK\|MB_ICONEXCLAMATION/)

  if (process.platform !== 'win32') return
  const makensis = await findCachedFile(fileURLPath('../.packaging/builder-cache'), full => path.basename(full) === 'makensis.exe')
  const pluginsDir = await findCachedFile(fileURLPath('../.packaging/builder-cache'), full => path.basename(full) === 'StdUtils.dll' && full.includes('x86-unicode'))
  if (!makensis || !pluginsDir) return

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fy1sync-nsis-init-'))
  try {
    await mkdir(path.join(tempRoot, '.packaging'), { recursive: true })
    await writeFile(path.join(tempRoot, '.packaging', 'install-path-limit.nsh'), '!define STREAM_SYNC_MAX_INSTALL_DIR 100\n')
    const nsisInclude = fileURLPath('../node_modules/app-builder-lib/templates/nsis/include')
    const outExe = path.join(tempRoot, 'harness.exe')
    const scriptPath = path.join(tempRoot, 'harness.nsi')
    const script = [
      'Unicode true',
      'RequestExecutionLevel user',
      'InstallDir "$LOCALAPPDATA\\Programs\\Fy1Sync"',
      `OutFile "${outExe}"`,
      `!addincludedir "${nsisInclude}"`,
      `!addplugindir /x86-unicode "${path.dirname(pluginsDir)}"`,
      `!include "${path.join(nsisInclude, 'StdUtils.nsh')}"`,
      '!macro _isUpdated _a _b _t _f',
      '  ${StdUtils.TestParameter} $R9 "updated"',
      '  StrCmp "$R9" "true" `${_t}` `${_f}`',
      '!macroend',
      '!define isUpdated `"" isUpdated ""`',
      '!macro _isForAllUsers _a _b _t _f',
      '  ${StdUtils.TestParameter} $R9 "allusers"',
      '  StrCmp "$R9" "true" `${_t}` `${_f}`',
      '!macroend',
      '!define isForAllUsers `"" isForAllUsers ""`',
      `!include "${installerNshPath}"`,
      '!include "MUI2.nsh"',
      '!include "StrContains.nsh"',
      'Var isForceCurrentInstall',
      'Var newDesktopLink',
      'Var oldDesktopLink',
      'Var appExe',
      '!insertmacro customHeader',
      'Function .onInit',
      '  !insertmacro customInit',
      'FunctionEnd',
      'Section "noop"',
      'SectionEnd',
      '',
    ].join('\n')
    await writeFile(scriptPath, script)
    const compile = spawnSync(makensis, [
      `-DPROJECT_DIR=${tempRoot}`,
      '-DAPP_FILENAME=Fy1Sync',
      '-DAPP_DESCRIPTION=Fy1Sync',
      '-DAPP_ID=cn.fy1ng.fy1sync',
      scriptPath,
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(compile.status, 0, compile.stderr || compile.stdout)

    const shortRun = spawnSync(outExe, ['/S', '/D=C:\\Fy1Sync'], { windowsHide: true })
    assert.equal(shortRun.status, 0)
    const longRun = spawnSync(outExe, ['/S', `/D=C:\\${'a'.repeat(105)}\\Fy1Sync`], { windowsHide: true })
    assert.equal(longRun.status, 2)
    const allUsersRun = spawnSync(outExe, ['/S', '/allusers', '/D=C:\\Fy1Sync'], { windowsHide: true })
    assert.equal(allUsersRun.status, 2)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

function fileURLPath(relative) {
  return fileURLToPath(new URL(relative, import.meta.url))
}

async function findCachedFile(dir, predicate) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await findCachedFile(full, predicate)
      if (nested) return nested
    } else if (predicate(full)) {
      return full
    }
  }
  return null
}
