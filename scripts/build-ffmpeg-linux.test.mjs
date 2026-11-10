import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { assertLinuxDependencies, elfArchitecture, linuxBuildPaths } from './build-ffmpeg-linux.mjs'
import { linuxConfigure, linuxRuntimeFiles, validateToolAsset } from './packaging-platform.mjs'

const lock = JSON.parse(await readFile(new URL('../packaging/ffmpeg/build-lock.json', import.meta.url), 'utf8'))

test('ELF parser rejects truncated, wrong-endian, 32-bit and unsupported executables', () => {
  const bytes = Buffer.alloc(64)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  for (const [machine, arch] of [[62, 'x64'], [183, 'arm64']]) {
    bytes.writeUInt16LE(machine, 18)
    assert.equal(elfArchitecture(bytes), arch)
  }
  for (const invalid of [bytes.subarray(0, 63), Buffer.alloc(64)]) assert.throws(() => elfArchitecture(invalid))
  for (const [offset, value] of [[4, 1], [5, 2], [18, 3]]) {
    const invalid = Buffer.from(bytes)
    invalid[offset] = value
    assert.throws(() => elfArchitecture(invalid))
  }
})

test('Linux runtime requires origin-relative loading and rejects undeclared or absolute dependencies', () => {
  const valid = ' (NEEDED) Shared library: [libavcodec.so.62]\n (NEEDED) Shared library: [libc.so.6]\n (RUNPATH) Library runpath: [$ORIGIN]'
  assert.deepEqual(assertLinuxDependencies(valid, linuxRuntimeFiles(lock)), ['libavcodec.so.62', 'libc.so.6'])
  for (const invalid of [valid.replace('$ORIGIN', '/tmp/build'), valid.replace('libc.so.6', '/tmp/libc.so.6'), valid.replace('libc.so.6', 'libunknown.so'), valid.replace(' (RUNPATH) Library runpath: [$ORIGIN]', ''), valid + '\n (RPATH) Library rpath: [/tmp]']) {
    assert.throws(() => assertLinuxDependencies(invalid, linuxRuntimeFiles(lock)))
  }
})

test('Linux uses the locked media settings, LGPL TLS backend and separately verified CPU assets', async () => {
  for (const arch of ['x64', 'arm64']) {
    const configure = linuxConfigure(lock, arch)
    for (const option of ['--disable-gpl', '--disable-version3', '--disable-nonfree', '--enable-shared', '--disable-static', '--enable-gnutls', '--enable-pthreads']) assert.ok(configure.includes(option))
    assert.ok(!configure.includes('--enable-schannel'))
    assert.ok(linuxBuildPaths('/repo', lock.buildId, arch).output.endsWith('linux-' + arch))
  }
  assert.throws(() => linuxBuildPaths('/repo', '../escape', 'x64'))
  assert.throws(() => linuxConfigure(lock, 'ia32'))
  const native = JSON.parse(await readFile(new URL('../packaging/tools-linux-lock.json', import.meta.url), 'utf8'))
  assert.deepEqual(native.assets.map(asset => validateToolAsset(asset).name), ['yt-dlp_linux', 'yt-dlp_linux_aarch64'])
})
