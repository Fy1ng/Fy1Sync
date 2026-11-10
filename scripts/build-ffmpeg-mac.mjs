import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { macCapabilities, macConfigure, macMinimumSystemVersion, macNativeBuildEnvironment, macRuntimeFiles, packagingTarget } from './packaging-platform.mjs'
import { writeFfmpegFixtures } from './ffmpeg-fixtures.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const json = value => JSON.stringify(value, null, 2) + '\n'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const sourceLockPath = path.join(repo, 'packaging', 'ffmpeg', 'build-lock.json')
const macLockPath = path.join(repo, 'packaging', 'tools-mac-lock.json')

export function macBuildPaths(root, buildId, arch) {
  packagingTarget('darwin', arch)
  assert(/^[A-Za-z0-9.-]+$/.test(buildId), 'Invalid FFmpeg build identity')
  const cache = path.join(root, '.packaging', 'ffmpeg-build', 'downloads')
  const output = path.join(root, '.packaging', 'ffmpeg-build', 'out', `${buildId}-mac-${arch}`)
  return { cache, output, runtimeName: `fy1sync-ffmpeg-${buildId}-mac-${arch}.tar.gz`, sourceName: `fy1sync-ffmpeg-${buildId}-mac-${arch}-source.tar.gz` }
}

export async function fileIdentity(file, name = path.basename(file)) {
  const info = await lstat(file)
  assert(info.isFile() && !info.isSymbolicLink(), 'Expected regular build file: ' + name)
  return { name, size: info.size, sha256: sha256(await readFile(file)) }
}

export async function verifyIdentity(file, expected) {
  const actual = await fileIdentity(file)
  assert(actual.size === expected.size && actual.sha256 === expected.sha256, 'Build SHA256/size mismatch: ' + path.basename(file))
}

export async function macRun(executable, args, { cwd = repo, env = process.env, timeout = 1_800_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const output = []
    let bytes = 0
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 32 * 1048576) child.kill()
      else output.push(chunk)
    })
    const timer = setTimeout(() => child.kill(), timeout)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      const text = Buffer.concat(output).toString('utf8').replaceAll('\r\n', '\n')
      code === 0 && bytes <= 32 * 1048576 ? resolve(text) : reject(new Error(`${path.basename(executable)} failed (${code}): ${text.slice(-4096)}`))
    })
  })
}

export function machoArchitectures(bytes) {
  assert(bytes.length >= 8, 'Truncated Mach-O')
  const magic = bytes.readUInt32BE(0), machines = new Map([[0x01000007, 'x64'], [0x0100000c, 'arm64']])
  if (magic === 0xcffaedfe || magic === 0xfeedfacf) {
    assert(bytes.length >= 32, 'Truncated 64-bit Mach-O header')
    const machine = magic === 0xcffaedfe ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4)
    assert(machines.has(machine), 'Unsupported Mach-O CPU')
    return [machines.get(machine)]
  }
  assert([0xcafebabe, 0xcafebabf].includes(magic), 'Expected Mach-O executable/library')
  const count = bytes.readUInt32BE(4), stride = magic === 0xcafebabf ? 32 : 20
  assert(count > 0 && count <= 8 && bytes.length >= 8 + count * stride, 'Invalid universal Mach-O table')
  const found = []
  for (let index = 0; index < count; index++) {
    const offset = 8 + index * stride, machine = bytes.readUInt32BE(offset)
    const start = magic === 0xcafebabf ? Number(bytes.readBigUInt64BE(offset + 8)) : bytes.readUInt32BE(offset + 8)
    const size = magic === 0xcafebabf ? Number(bytes.readBigUInt64BE(offset + 16)) : bytes.readUInt32BE(offset + 12)
    assert(machines.has(machine) && Number.isSafeInteger(start) && Number.isSafeInteger(size) && start >= 8 + count * stride && size >= 8 && start + size <= bytes.length, 'Invalid universal Mach-O member')
    const member = machoArchitectures(bytes.subarray(start, start + size))
    assert(member.length === 1 && member[0] === machines.get(machine) && !found.includes(member[0]), 'Conflicting universal Mach-O CPU')
    found.push(member[0])
  }
  return found.sort()
}

export function machoHasSignature(bytes) {
  machoArchitectures(bytes)
  const magic = bytes.readUInt32BE(0)
  if ([0xcafebabe, 0xcafebabf].includes(magic)) {
    const stride = magic === 0xcafebabf ? 32 : 20
    for (let index = 0; index < bytes.readUInt32BE(4); index++) {
      const offset = 8 + index * stride
      const start = magic === 0xcafebabf ? Number(bytes.readBigUInt64BE(offset + 8)) : bytes.readUInt32BE(offset + 8)
      const size = magic === 0xcafebabf ? Number(bytes.readBigUInt64BE(offset + 16)) : bytes.readUInt32BE(offset + 12)
      if (machoHasSignature(bytes.subarray(start, start + size))) return true
    }
    return false
  }
  const read = offset => magic === 0xcffaedfe ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
  const commands = read(16), total = read(20)
  assert(commands <= 1024 && 32 + total <= bytes.length, 'Invalid Mach-O load-command bounds')
  let offset = 32, found = false
  for (let index = 0; index < commands; index++) {
    assert(offset + 8 <= 32 + total, 'Truncated Mach-O load command')
    const command = read(offset), length = read(offset + 4)
    assert(length >= 8 && offset + length <= 32 + total, 'Invalid Mach-O load command size')
    if (command === 0x1d) {
      assert(length === 16 && read(offset + 8) + read(offset + 12) <= bytes.length, 'Invalid Mach-O code-signature bounds')
      found = read(offset + 12) > 0
    }
    offset += length
  }
  assert(offset === 32 + total, 'Mach-O load-command inventory differs')
  return found
}

export function assertMacDependencies(text, runtimeFiles) {
  const dependencies = text.trim().split('\n').slice(1).map(line => line.trim().split(' (')[0])
  assert(dependencies.length > 0, 'Mach-O dependency table is empty')
  for (const dependency of dependencies) {
    assert((dependency.startsWith('@rpath/') && runtimeFiles.includes(dependency.slice(7)))
      || /^\/usr\/lib\/[^/]+\.dylib$/.test(dependency)
      || /^\/System\/Library\/Frameworks\/[A-Za-z0-9.]+\.framework\/Versions\/[A-Za-z0-9.]+\/[A-Za-z0-9.]+$/.test(dependency), 'Unexpected/non-relocatable native dependency: ' + dependency)
  }
  return dependencies
}

export function assertMacDeploymentTarget(text) {
  const modern = /cmd LC_BUILD_VERSION\b([\s\S]*?)(?=Load command \d+|$)/.exec(text)
  const legacy = /cmd LC_VERSION_MIN_MACOSX\b([\s\S]*?)(?=Load command \d+|$)/.exec(text)
  const version = modern ? /^\s*minos\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(modern[1])?.[1]
    : legacy ? /^\s*version\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(legacy[1])?.[1] : undefined
  assert(!modern || /^\s*platform\s+(?:1|macos)\s*$/im.test(modern[1]), 'Native Mach-O is not built for macOS')
  assert(version && version.split('.').map(Number).concat(0).slice(0, 3).join('.') === macMinimumSystemVersion + '.0', 'Native Mach-O minimum macOS version differs from ' + macMinimumSystemVersion)
  return macMinimumSystemVersion
}

export function assertMacBuildBaseline(manifest) {
  assert(manifest.minimumSystemVersion === macMinimumSystemVersion
    && manifest.toolchain?.minimumSystemVersion === macMinimumSystemVersion
    && json(manifest.buildEnvironment) === json(macNativeBuildEnvironment()), 'Native FFmpeg build minimum macOS version differs; rebuild with the locked baseline')
  assert(manifest.assertions?.minimumSystemVersion === macMinimumSystemVersion
    && Array.isArray(manifest.assertions.files) && manifest.assertions.files.length > 0
    && manifest.assertions.files.every(file => file.minimumSystemVersion === macMinimumSystemVersion), 'Native FFmpeg runtime minimum macOS evidence differs')
}

export function shellWords(text) {
  const words = []
  let word = '', quote = '', active = false
  for (const character of text.trim()) {
    if (quote) { if (character === quote) quote = ''; else word += character }
    else if (character === "'" || character === '"') { quote = character; active = true }
    else if (/\s/.test(character)) { if (active) { words.push(word); word = ''; active = false } }
    else { word += character; active = true }
  }
  assert(!quote, 'Unclosed configure quote')
  if (active) words.push(word)
  return words
}

export async function verifyMacRuntime(directory, lock, arch, task) {
  const expectedFiles = macRuntimeFiles(lock), evidence = {}, capabilities = macCapabilities(lock)
  assert(json((await readdir(directory)).sort()) === json(expectedFiles), 'Native FFmpeg runtime inventory differs')
  const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: task, TMPDIR: task, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }
  const files = []
  for (const name of expectedFiles) {
    const file = path.join(directory, name), bytes = await readFile(file)
    assert(json(machoArchitectures(bytes)) === json([arch]), 'Native FFmpeg CPU mismatch: ' + name)
    const imports = assertMacDependencies(await macRun('/usr/bin/otool', ['-L', file], { cwd: task, env: environment }), expectedFiles)
    if (name.endsWith('.dylib')) assert(imports[0] === '@rpath/' + name, 'Native FFmpeg library install name differs: ' + name)
    const privatePaths = [repo, process.env.HOME].filter(Boolean)
    for (const value of privatePaths) assert(!bytes.includes(Buffer.from(value)), 'Private path embedded in native runtime: ' + name)
    const loadCommands = await macRun('/usr/bin/otool', ['-l', file], { env: environment })
    const minimumSystemVersion = assertMacDeploymentTarget(loadCommands)
    if (!name.endsWith('.dylib')) assert(/path @executable_path \(offset \d+\)/.test(loadCommands), 'Native executable is missing a relocatable rpath')
    evidence[name + '-load-commands.txt'] = loadCommands
    files.push({ ...await fileIdentity(file), architectures: [arch], imports, minimumSystemVersion })
  }
  for (const name of ['ffmpeg', 'ffprobe']) {
    for (const [label, args] of [['version', ['-version']], ['license', ['-hide_banner', '-L']], ['buildconf', ['-hide_banner', '-buildconf']]]) {
      const text = await macRun(path.join(directory, name), args, { cwd: task, env: environment })
      evidence[`${name}-${label}.txt`] = text
      if (label === 'version') {
        assert(text.split('\n')[0].split(' ')[2] === `${lock.revision}-${lock.extraVersion}`, 'Native FFmpeg version differs')
        for (const [library, abi] of Object.entries(lock.abi)) {
          const match = text.match(new RegExp(`lib${library}\\s+(\\d+)\\.\\s*(\\d+)\\.\\s*(\\d+)\\s*/\\s*(\\d+)\\.\\s*(\\d+)\\.\\s*(\\d+)`))
          assert(match && match.slice(1, 4).join('.') === abi && match.slice(4, 7).join('.') === abi, 'Native FFmpeg ABI differs: ' + library)
        }
      }
      if (label === 'license') assert(/GNU Lesser General Public/.test(text) && /version 2\.1.*or/i.test(text), 'Native FFmpeg must be LGPL 2.1+')
      if (label === 'buildconf') assert(json(shellWords(text.split('\n').filter(line => /^\s+--/.test(line)).join('\n'))) === json(macConfigure(lock, arch)), 'Native FFmpeg configure differs')
    }
  }
  const executable = path.join(directory, 'ffmpeg')
  const tls = await macRun(executable, ['-hide_banner', '-h', 'protocol=tls'], { cwd: task, env: environment })
  assert(/^\s+-tls_verify\s+.*\(default true\)/m.test(tls), 'Native TLS server certificate verification must default to true')
  evidence['tls-help.txt'] = tls
  const runtimeCapabilities = {}
  for (const [kind, query] of Object.entries({ protocol: 'protocols', demuxer: 'demuxers', muxer: 'muxers', decoder: 'decoders', encoder: 'encoders', bsf: 'bsfs', filter: 'filters' })) {
    const text = await macRun(executable, ['-hide_banner', '-' + query], { cwd: task, env: environment })
    let names
    if (kind === 'protocol') names = [...text.matchAll(/^ {2,}(\w+) *$/gm)].map(match => match[1])
    else if (kind === 'bsf') names = [...text.matchAll(/^(\w+) *$/gm)].map(match => match[1])
    else if (['demuxer', 'muxer'].includes(kind)) names = [...text.matchAll(/^\s*[D.E ]{1,3}\s+(\w+)(?:,\S+)*\s+/gm)].map(match => match[1])
    else if (kind === 'filter') names = [...text.matchAll(/^\s*[TSC.]{2,3}\s+(\w+)\s+\S+->/gm)].map(match => match[1])
    else names = [...text.matchAll(/^\s*[VAS][A-Z.]{5}\s+(\w+)\s+/gm)].map(match => match[1])
    names = [...new Set(names)].sort()
    const expected = [...capabilities[kind], ...(kind === 'filter' ? ['abuffer', 'abuffersink', 'buffer', 'buffersink'] : [])].sort()
    assert(json(names) === json(expected), 'Native FFmpeg runtime capability differs: ' + kind)
    runtimeCapabilities[kind] = names
    evidence[kind + '.txt'] = text
  }
  const fixture = await writeFfmpegFixtures(path.join(task, 'fixtures'))
  const gif = path.join(task, 'probe.gif'), copied = path.join(task, 'copy.mp4')
  await macRun(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', fixture.png, '-vf', 'format=rgb8', gif], { cwd: task, env: environment })
  const bytes = await readFile(gif)
  assert(/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()) && bytes.readUInt16LE(6) === 16 && bytes.readUInt16LE(8) === 16 && bytes.at(-1) === 0x3b, 'Native PNG/GIF smoke failed')
  await macRun(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', fixture.mp4, '-c', 'copy', copied], { cwd: task, env: environment })
  const probe = JSON.parse(await macRun(path.join(directory, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', copied], { cwd: task, env: environment }))
  assert(probe.streams?.length === 1 && probe.streams[0].codec_name === 'h264' && probe.streams[0].width === 160 && probe.streams[0].height === 90 && Number(probe.format?.duration) === 2, 'Native MP4 copy/ffprobe smoke failed')
  return { files, capabilities, runtimeCapabilities, evidence, minimumSystemVersion: macMinimumSystemVersion, tlsDefaultVerify: true, license: 'LGPL-2.1-or-later' }
}

export async function loadMacBuild(lock, arch) {
  const paths = macBuildPaths(repo, lock.buildId, arch), manifest = JSON.parse(await readFile(path.join(paths.output, 'build-manifest.json'), 'utf8'))
  assert(manifest.schemaVersion === 1 && manifest.target === `darwin-${arch}` && manifest.buildId === lock.buildId
    && manifest.revision === lock.revision && manifest.extraVersion === lock.extraVersion, 'Local native FFmpeg manifest identity differs')
  await verifyIdentity(sourceLockPath, manifest.lock)
  await verifyIdentity(macLockPath, manifest.macLock)
  assertMacBuildBaseline(manifest)
  assert(json(manifest.configure) === json(macConfigure(lock, arch)), 'Native FFmpeg build configuration differs')
  assert(json(manifest.assertions.capabilities) === json(macCapabilities(lock)), 'Native FFmpeg manifest capabilities differ')
  assert(json(manifest.archives.map(entry => entry.name).sort()) === json([paths.runtimeName, paths.sourceName].sort()), 'Native archive manifest differs')
  for (const archive of manifest.archives) await verifyIdentity(path.join(paths.output, archive.name), archive)
  for (const patch of lock.patches) await verifyIdentity(path.join(repo, 'packaging', 'ffmpeg', patch.file), patch)
  return { ...paths, manifest }
}

export async function ensureInput(entry, cache, temporary, environment) {
  const destination = path.join(cache, entry.file)
  const existing = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (existing) { await verifyIdentity(destination, entry); return destination }
  const bundledSource = path.join(repo, 'upstream', entry.file)
  const bundled = await lstat(bundledSource).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (bundled) {
    await verifyIdentity(bundledSource, entry)
    await cp(bundledSource, destination, { force: false, errorOnExist: true })
    return destination
  }
  const download = path.join(temporary, entry.file + '.partial')
  // zlib moves historical releases into fossils; retain the exact locked bytes and hash.
  const url = entry.id === 'zlib' && entry.url === `https://zlib.net/${entry.file}` ? `https://zlib.net/fossils/${entry.file}` : entry.url
  await macRun('/usr/bin/curl', ['--disable', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--silent', '--show-error', '--max-time', '900', '--output', download, url], { env: environment })
  await verifyIdentity(download, entry)
  await cp(download, destination, { force: false, errorOnExist: true })
  return destination
}

export async function extract(archive, destination, environment) {
  const names = (await macRun('/usr/bin/tar', ['-tf', archive], { env: environment })).trim().split('\n')
  assert(names.length <= 30_000 && names.every(name => !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..')), 'Unsafe native source archive inventory')
  const details = await macRun('/usr/bin/tar', ['-tvf', archive], { env: environment })
  assert(!/^[lh]/m.test(details), 'Source archive links are forbidden')
  await mkdir(destination)
  await macRun('/usr/bin/tar', ['-xf', archive, '-C', destination], { env: environment })
}

export async function sourceFiles(directory, prefix = '') {
  const files = []
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name), info = await lstat(file)
    assert(!info.isSymbolicLink(), 'Source materials cannot contain symlinks')
    if (info.isDirectory()) files.push(...await sourceFiles(file, prefix + name + '/'))
    else if (info.isFile()) files.push(await fileIdentity(file, prefix + name))
  }
  return files
}

export async function applyNativePatches(lock, work, environment) {
  for (const patch of lock.patches) {
    const bytes = await readFile(path.join(repo, 'packaging', 'ffmpeg', patch.file))
    assert(bytes.length === patch.size && sha256(bytes) === patch.sha256, 'Native patch SHA256/size mismatch')
    // BSD patch preserves CR bytes, unlike GNU patch. Normalize only the verified private copy.
    const file = path.join(work, path.basename(patch.file))
    await writeFile(file, bytes.toString('utf8').replaceAll('\r\n', '\n'))
    await macRun('/usr/bin/patch', ['--batch', '--fuzz=0', '-p1', '-i', file], { cwd: path.join(work, 'ffmpeg-source'), env: environment })
  }
}

export async function buildMacFfmpeg(args = process.argv.slice(2)) {
  const target = packagingTarget()
  assert(target.platform === 'darwin', 'FFmpeg macOS 构建必须在 macOS arm64/x64 本机执行')
  assert(args.every(arg => arg === '--download-only'), '用法: npm run ffmpeg:build -- [--download-only]')
  const lock = JSON.parse(await readFile(sourceLockPath, 'utf8')), paths = macBuildPaths(repo, lock.buildId, target.arch)
  await mkdir(path.join(repo, '.runtime-cache'), { recursive: true })
  const work = await mkdtemp(path.join(repo, '.runtime-cache', 'ffmpeg-mac-'))
  await mkdir(path.join(work, 'tmp'))
  const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: work, TMPDIR: path.join(work, 'tmp'),
    SOURCE_DATE_EPOCH: String(lock.sourceDateEpoch), LC_ALL: lock.locale, LANG: lock.locale, TZ: lock.timezone,
    ...macNativeBuildEnvironment(),
    CFLAGS: macNativeBuildEnvironment().CFLAGS.replaceAll('@BUILD_WORK@', work),
    ...Object.fromEntries(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
  }
  await mkdir(paths.cache, { recursive: true })
  const inputs = {}
  for (const id of ['ffmpeg', 'zlib']) {
    const entry = lock.assets.find(asset => asset.id === id)
    assert(entry && /^[a-f0-9]{64}$/.test(entry.sha256), 'Missing fixed source input: ' + id)
    inputs[id] = await ensureInput(entry, paths.cache, work, environment)
    console.log('已验证固定源码: ' + entry.file)
  }
  const series = (await readFile(path.join(repo, 'packaging', 'ffmpeg', 'patches', 'series'), 'utf8')).trim().split(/\r?\n/)
  assert(json(series) === json(lock.patches.map(patch => path.basename(patch.file))), 'Patch series differs from source lock')
  for (const patch of lock.patches) await verifyIdentity(path.join(repo, 'packaging', 'ffmpeg', patch.file), patch)
  if (args.includes('--download-only')) return
  const previous = await lstat(paths.output).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  assert(!previous, 'Native FFmpeg 输出已存在, 不覆盖; tools:prepare 将重新校验并使用该输出: ' + paths.output)
  const toolchain = {}
  toolchain.clang = (await macRun('/usr/bin/clang', ['--version'], { env: environment })).trim()
  assert(/^Apple clang version /m.test(toolchain.clang), 'Apple clang from Xcode Command Line Tools is required')
  toolchain.sdkVersion = (await macRun('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version'], { env: environment })).trim()
  toolchain.osVersion = (await macRun('/usr/bin/sw_vers', ['-productVersion'], { env: environment })).trim()
  toolchain.make = (await macRun('/usr/bin/make', ['--version'], { env: environment })).split('\n')[0]
  toolchain.node = process.version
  toolchain.target = target.target
  toolchain.minimumSystemVersion = macMinimumSystemVersion
  await extract(inputs.ffmpeg, path.join(work, 'ffmpeg-unpack'), environment)
  await rename(path.join(work, 'ffmpeg-unpack', 'FFmpeg-' + lock.commit), path.join(work, 'ffmpeg-source'))
  await extract(inputs.zlib, path.join(work, 'zlib-unpack'), environment)
  await rename(path.join(work, 'zlib-unpack', 'zlib-1.3.2'), path.join(work, 'zlib-source'))
  await applyNativePatches(lock, work, environment)
  await mkdir(path.join(work, 'logs'))
  const execute = async (name, executable, argv, cwd) => {
    console.log('执行 macOS 原生构建: ' + name)
    const text = await macRun(executable, argv, { cwd, env: environment })
    await writeFile(path.join(work, 'logs', name + '.txt'), text)
  }
  await execute('zlib-configure', '/bin/sh', ['./configure', '--static', '--prefix=../zlib-prefix'], path.join(work, 'zlib-source'))
  await execute('zlib-make', '/usr/bin/make', ['-j' + lock.jobs], path.join(work, 'zlib-source'))
  await execute('zlib-test', '/usr/bin/make', ['test'], path.join(work, 'zlib-source'))
  await execute('zlib-install', '/usr/bin/make', ['install'], path.join(work, 'zlib-source'))
  await mkdir(path.join(work, 'build'))
  const configure = macConfigure(lock, target.arch)
  await execute('configure', '/bin/sh', ['../ffmpeg-source/configure', ...configure], path.join(work, 'build'))
  await execute('make', '/usr/bin/make', ['-j' + lock.jobs, 'REVISION=' + lock.revision], path.join(work, 'build'))
  await execute('install', '/usr/bin/make', ['REVISION=' + lock.revision, 'install'], path.join(work, 'build'))
  const definitions = (await Promise.all(['config.h', 'config_components.h'].map(name => readFile(path.join(work, 'build', name), 'utf8')))).join('\n')
  const config = Object.fromEntries([...definitions.matchAll(/^#define CONFIG_(\w+) ([01])$/gm)].map(match => [match[1], Number(match[2])]))
  for (const [key, value] of Object.entries({ ...lock.configAssertions, SCHANNEL: 0, SECURETRANSPORT: 1 })) assert(config[key] === value, 'Native CONFIG_' + key + ' differs')
  const componentDefinitions = await readFile(path.join(work, 'build', 'config_components.h'), 'utf8')
  for (const [kind, expected] of Object.entries(macCapabilities(lock))) {
    const actual = [...componentDefinitions.matchAll(new RegExp(`^#define CONFIG_(\\w+)_${kind.toUpperCase()} 1$`, 'gm'))].map(match => match[1].toLowerCase()).sort()
    assert(json(actual) === json(expected), 'Native configured capability differs: ' + kind)
  }
  const configureSource = await readFile(path.join(work, 'ffmpeg-source', 'configure'), 'utf8')
  const libraryList = name => {
    const value = configureSource.match(new RegExp(`^${name}="([\\s\\S]*?)"`, 'm'))?.[1]
    assert(value, 'Missing configure library list ' + name)
    return value.trim().split(/\s+/).flatMap(item => item.startsWith('$') ? libraryList(item.slice(1)) : [item])
  }
  const externalLibraries = [...new Set(['EXTERNAL_LIBRARY_LIST', 'EXTERNAL_AUTODETECT_LIBRARY_LIST', 'HWACCEL_LIBRARY_LIST', 'HWACCEL_AUTODETECT_LIBRARY_LIST'].flatMap(libraryList))].filter(name => config[name.toUpperCase()] === 1).sort()
  assert(json(externalLibraries) === json(['securetransport', 'zlib']), 'Unexpected native external library')
  const runtime = path.join(work, 'runtime')
  await mkdir(runtime)
  for (const name of macRuntimeFiles(lock)) {
    // Dereference FFmpeg's installed ABI symlinks into regular, relocatable runtime files.
    const source = path.join(work, 'install', name.endsWith('.dylib') ? 'lib' : 'bin', name)
    const resolved = await realpath(source)
    assert(resolved.startsWith(path.join(work, 'install') + path.sep), 'Installed FFmpeg link escapes private prefix')
    await cp(resolved, path.join(runtime, name))
    await macRun('/usr/bin/strip', ['-S', path.join(runtime, name)], { env: environment })
    await macRun('/usr/bin/codesign', ['--force', '--sign', '-', path.join(runtime, name)], { env: environment })
  }
  const assertions = await verifyMacRuntime(runtime, lock, target.arch, path.join(work, 'tmp'))
  const parser = path.join(work, 'parser-probe.c')
  await writeFile(parser, '#include <stdio.h>\n#include <libavcodec/avcodec.h>\nint main(void) { void *opaque = NULL; const AVCodecParser *p; while ((p = av_parser_iterate(&opaque))) puts(avcodec_get_name(p->codec_ids[0])); return 0; }\n')
  await macRun('/usr/bin/clang', ['parser-probe.c', '-mmacosx-version-min=' + macMinimumSystemVersion, '-Iinstall/include', '-Linstall/lib', '-lavcodec', '-lavutil', '-Wl,-rpath,' + runtime, '-o', 'parser-probe'], { cwd: work, env: environment })
  const parsers = await macRun(path.join(work, 'parser-probe'), [], { cwd: work, env: environment })
  assert(json(parsers.trim().split('\n').sort()) === json(lock.capabilities.parser), 'Native parser iterator differs')
  const materials = path.join(work, 'materials')
  await mkdir(path.join(materials, 'upstream'), { recursive: true })
  for (const file of Object.values(inputs)) await cp(file, path.join(materials, 'upstream', path.basename(file)))
  await cp(path.join(repo, 'packaging', 'ffmpeg'), path.join(materials, 'packaging', 'ffmpeg'), { recursive: true })
  await cp(macLockPath, path.join(materials, 'packaging', 'tools-mac-lock.json'))
  await mkdir(path.join(materials, 'scripts'))
  for (const name of ['build-ffmpeg-mac.mjs', 'packaging-platform.mjs', 'ffmpeg-fixtures.mjs']) await cp(path.join(repo, 'scripts', name), path.join(materials, 'scripts', name))
  await mkdir(path.join(materials, 'build'))
  for (const name of ['config.h', 'config_components.h', 'libavutil/ffversion.h']) await cp(path.join(work, 'build', name), path.join(materials, 'build', path.basename(name)))
  await writeFile(path.join(materials, 'build', 'configure.json'), json(configure))
  await writeFile(path.join(materials, 'build', 'toolchain.json'), json(toolchain))
  await cp(parser, path.join(materials, 'build', 'parser-probe.c'))
  await mkdir(path.join(materials, 'evidence'))
  for (const [name, text] of Object.entries({ ...assertions.evidence, 'parsers.txt': parsers })) await writeFile(path.join(materials, 'evidence', name), text)
  await mkdir(path.join(materials, 'licenses', 'ffmpeg'), { recursive: true })
  for (const name of (await readdir(path.join(work, 'ffmpeg-source'))).filter(name => /^(COPYING|LICENSE)/.test(name))) await cp(path.join(work, 'ffmpeg-source', name), path.join(materials, 'licenses', 'ffmpeg', name))
  await mkdir(path.join(materials, 'licenses', 'zlib'))
  await cp(path.join(work, 'zlib-source', 'LICENSE'), path.join(materials, 'licenses', 'zlib', 'LICENSE'))
  const next = path.join(work, 'out')
  await mkdir(next)
  const archives = []
  for (const [directory, name] of [[runtime, paths.runtimeName], [materials, paths.sourceName]]) {
    const files = await sourceFiles(directory)
    await macRun('/usr/bin/tar', ['-czf', path.join(next, name), '-C', directory, ...files.map(entry => entry.name)], { cwd: work, env: environment })
    archives.push({ ...await fileIdentity(path.join(next, name)), files })
  }
  delete assertions.evidence
  assertions.externalLibraries = externalLibraries
  const manifest = { schemaVersion: 1, target: target.target, buildId: lock.buildId, revision: lock.revision, extraVersion: lock.extraVersion,
    sourceDateEpoch: lock.sourceDateEpoch, minimumSystemVersion: macMinimumSystemVersion, buildEnvironment: macNativeBuildEnvironment(),
    lock: await fileIdentity(sourceLockPath), macLock: await fileIdentity(macLockPath), configure, toolchain, assertions, archives }
  await writeFile(path.join(next, 'build-manifest.json'), json(manifest))
  await mkdir(path.dirname(paths.output), { recursive: true })
  await rename(next, paths.output)
  console.log('macOS 原生 FFmpeg 构建和离线能力/许可/ABI/加载路径检查通过: ' + paths.output)
  console.log('Apple clang/SDK 版本已记录, 不宣称跨主机字节可复现. 日志: ' + path.join(work, 'logs'))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await buildMacFfmpeg() } catch (error) { console.error(error.stack); process.exitCode = 1 }
}
