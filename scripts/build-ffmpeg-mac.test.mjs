import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { assertMacBuildBaseline, assertMacDependencies, assertMacDeploymentTarget, fileIdentity, macBuildPaths, machoArchitectures, machoHasSignature, verifyIdentity } from './build-ffmpeg-mac.mjs'
import { macNativeBuildEnvironment } from './packaging-platform.mjs'

function thin(arch, signed = false) {
  const bytes = Buffer.alloc(signed ? 64 : 32)
  bytes.writeUInt32BE(0xcffaedfe)
  bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  if (signed) {
    bytes.writeUInt32LE(1, 16)
    bytes.writeUInt32LE(16, 20)
    bytes.writeUInt32LE(0x1d, 32)
    bytes.writeUInt32LE(16, 36)
    bytes.writeUInt32LE(48, 40)
    bytes.writeUInt32LE(16, 44)
  }
  return bytes
}

function universal() {
  const bytes = Buffer.alloc(112)
  bytes.writeUInt32BE(0xcafebabe)
  bytes.writeUInt32BE(2, 4)
  for (const [index, arch] of ['x64', 'arm64'].entries()) {
    const offset = 8 + index * 20, start = 48 + index * 32
    bytes.writeUInt32BE(arch === 'arm64' ? 0x0100000c : 0x01000007, offset)
    bytes.writeUInt32BE(start, offset + 8)
    bytes.writeUInt32BE(32, offset + 12)
    thin(arch).copy(bytes, start)
  }
  return bytes
}

test('Mach-O inspection accepts native thin and official universal executable shapes', () => {
  assert.deepEqual(machoArchitectures(thin('arm64')), ['arm64'])
  assert.deepEqual(machoArchitectures(thin('x64')), ['x64'])
  assert.deepEqual(machoArchitectures(universal()), ['arm64', 'x64'])
  assert.equal(machoHasSignature(thin('arm64')), false)
  assert.equal(machoHasSignature(thin('arm64', true)), true)
  assert.equal(machoHasSignature(universal()), false)
})

test('Mach-O inspection rejects PE, truncated or conflicting CPU tables and signature commands', () => {
  assert.throws(() => machoArchitectures(Buffer.from('MZnot-a-mac-binary')))
  assert.throws(() => machoArchitectures(thin('x64').subarray(0, 8)))
  const mismatched = universal(); mismatched.writeUInt32BE(0x0100000c, 8)
  assert.throws(() => machoArchitectures(mismatched))
  const outside = universal(); outside.writeUInt32BE(4096, 16)
  assert.throws(() => machoArchitectures(outside))
  const badSignature = thin('arm64', true); badSignature.writeUInt32LE(512, 44)
  assert.throws(() => machoHasSignature(badSignature))
})

test('native dependencies allow only bundled ABI libraries and Apple system libraries', () => {
  const allowed = ['ffmpeg', 'libavcodec.62.dylib']
  const native = '/tmp/ffmpeg:\n\t@rpath/libavcodec.62.dylib (compatibility version 62.0.0, current version 62.28.103)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\t/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0)'
  assert.equal(assertMacDependencies(native, allowed).length, 3)
  for (const dependency of ['/opt/homebrew/lib/libssl.dylib', '/Users/name/private/libz.dylib', '@rpath/libunknown.dylib', '@loader_path/../lib.dylib']) assert.throws(() => assertMacDependencies('/tmp/ffmpeg:\n\t' + dependency + ' (compatibility version 1.0.0)', allowed))
})

test('native Mach-O deployment evidence accepts macOS 13.0 and rejects host-default versions', () => {
  const modern = '/tmp/ffmpeg:\nLoad command 3\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos 13.0\n      sdk 15.0\nLoad command 4\n      cmd LC_MAIN\n'
  assert.equal(assertMacDeploymentTarget(modern), '13.0')
  assert.equal(assertMacDeploymentTarget(modern.replace('platform 1', 'platform macos').replace('minos 13.0', 'minos 13.0.0')), '13.0')
  assert.equal(assertMacDeploymentTarget('Load command 3\n      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version 13.0\n      sdk 13.0\n'), '13.0')
  for (const text of [modern.replace('minos 13.0', 'minos 14.0'), modern.replace('minos 13.0', 'minos 12.0'), modern.replace('platform 1', 'platform 2'), modern.replace('minos 13.0', 'minos 13.1'), 'cmd LC_MAIN\n']) assert.throws(() => assertMacDeploymentTarget(text))
})

test('native build reuse rejects missing/incorrect minimum system settings or runtime evidence', () => {
  const manifest = { minimumSystemVersion: '13.0', toolchain: { minimumSystemVersion: '13.0' }, buildEnvironment: macNativeBuildEnvironment(), assertions: { minimumSystemVersion: '13.0', files: [{ name: 'ffmpeg', minimumSystemVersion: '13.0' }] } }
  assertMacBuildBaseline(manifest)
  for (const invalid of [
    { ...manifest, minimumSystemVersion: undefined },
    { ...manifest, minimumSystemVersion: '14.0' },
    { ...manifest, toolchain: { minimumSystemVersion: '14.0' } },
    { ...manifest, buildEnvironment: { ...manifest.buildEnvironment, MACOSX_DEPLOYMENT_TARGET: '14.0' } },
    { ...manifest, buildEnvironment: { ...manifest.buildEnvironment, CFLAGS: '-O3' } },
    { ...manifest, assertions: { ...manifest.assertions, files: [{ name: 'ffmpeg', minimumSystemVersion: '14.0' }] } },
    { ...manifest, assertions: { files: [] } },
  ]) assert.throws(() => assertMacBuildBaseline(invalid))
})

test('macOS build outputs cannot collide with Windows or another macOS architecture', () => {
  const arm = macBuildPaths('/workspace', 'fixed.1', 'arm64'), intel = macBuildPaths('/workspace', 'fixed.1', 'x64')
  assert.notEqual(arm.output, intel.output)
  assert.match(arm.runtimeName, /mac-arm64\.tar\.gz$/)
  assert.match(intel.sourceName, /mac-x64-source\.tar\.gz$/)
  assert.throws(() => macBuildPaths('/workspace', '../escape', 'arm64'))
})

test('build input hash verification refuses modified cached inputs without overwriting them', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fy1sync-mac-lock-'))
  try {
    const file = path.join(temporary, 'input')
    await writeFile(file, 'fixed source')
    const locked = await fileIdentity(file)
    await verifyIdentity(file, locked)
    await writeFile(file, 'tampered source')
    await assert.rejects(verifyIdentity(file, locked), /SHA256\/size mismatch/)
    assert.equal(await readFile(file, 'utf8'), 'tampered source')
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
