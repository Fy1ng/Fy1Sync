import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { linuxConfigure, linuxRuntimeFiles, packagingTarget } from './packaging-platform.mjs'
import { applyNativePatches, ensureInput, extract, fileIdentity, macRun as nativeRun, shellWords, sourceFiles, verifyIdentity } from './build-ffmpeg-mac.mjs'
import { writeFfmpegFixtures } from './ffmpeg-fixtures.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const json = value => JSON.stringify(value, null, 2) + '\n'
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const sourceLockPath = path.join(root, 'packaging', 'ffmpeg', 'build-lock.json')
const linuxLockPath = path.join(root, 'packaging', 'tools-linux-lock.json')

export function elfArchitecture(bytes) {
  assert(bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes[4] === 2 && bytes[5] === 1, 'Expected little-endian ELF64')
  const architecture = new Map([[62, 'x64'], [183, 'arm64']]).get(bytes.readUInt16LE(18))
  assert(architecture, 'Unsupported ELF CPU')
  return architecture
}

export function assertLinuxDependencies(text, runtimeFiles) {
  const dependencies = [...text.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(match => match[1])
  const system = new Set(['libc.so.6', 'libm.so.6', 'libpthread.so.0', 'libdl.so.2', 'librt.so.1', 'libgcc_s.so.1', 'libatomic.so.1', 'libgnutls.so.30', 'ld-linux-x86-64.so.2', 'ld-linux-aarch64.so.1'])
  assert(dependencies.length > 0 && dependencies.every(name => runtimeFiles.includes(name) || system.has(name)), 'Unexpected Linux shared-library dependency')
  const paths = [...text.matchAll(/\((?:RUNPATH|RPATH)\).*\[([^\]]+)\]/g)].map(match => match[1])
  assert(paths.length === 1 && paths[0] === '$ORIGIN', 'Linux tools must load bundled FFmpeg libraries from $ORIGIN')
  return dependencies
}

export function linuxBuildPaths(repo, buildId, arch) {
  packagingTarget('linux', arch)
  assert(/^[A-Za-z0-9.-]+$/.test(buildId), 'Invalid FFmpeg build identity')
  return { cache: path.join(repo, '.packaging', 'ffmpeg-build', 'downloads'),
    output: path.join(repo, '.packaging', 'ffmpeg-build', 'out', `${buildId}-linux-${arch}`),
    runtimeName: `fy1sync-ffmpeg-${buildId}-linux-${arch}.tar.gz`, sourceName: `fy1sync-ffmpeg-${buildId}-linux-${arch}-source.tar.gz` }
}

export async function verifyLinuxRuntime(directory, lock, arch, task) {
  const expected = linuxRuntimeFiles(lock), files = [], evidence = {}, capabilities = lock.capabilities
  assert(json((await readdir(directory)).sort()) === json(expected), 'Linux FFmpeg inventory differs')
  const env = { PATH: '/usr/bin:/bin', HOME: task, TMPDIR: task, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }
  for (const name of expected) {
    const file = path.join(directory, name), bytes = await readFile(file)
    assert(elfArchitecture(bytes) === arch, 'Linux FFmpeg CPU mismatch: ' + name)
    assert((await lstat(file)).mode & 0o111, 'Linux tool must be executable: ' + name)
    const dynamic = await nativeRun('/usr/bin/readelf', ['-d', file], { cwd: task, env })
    const imports = assertLinuxDependencies(dynamic, expected)
    if (name.startsWith('lib')) assert(dynamic.includes('[' + name + ']'), 'Linux library SONAME differs')
    files.push({ ...await fileIdentity(file), architecture: arch, imports })
    evidence[name + '-dynamic.txt'] = dynamic
    for (const privatePath of [root, process.env.HOME].filter(Boolean)) assert(!bytes.includes(Buffer.from(privatePath)), 'Private path embedded in Linux FFmpeg')
  }
  for (const name of ['ffmpeg', 'ffprobe']) {
    for (const [label, args] of [['version', ['-version']], ['license', ['-hide_banner', '-L']], ['buildconf', ['-hide_banner', '-buildconf']]]) {
      const text = await nativeRun(path.join(directory, name), args, { cwd: task, env })
      evidence[`${name}-${label}.txt`] = text
      if (label === 'version') {
        assert(text.split('\n')[0].split(' ')[2] === `${lock.revision}-${lock.extraVersion}`, 'Linux FFmpeg version differs')
        for (const [library, abi] of Object.entries(lock.abi)) {
          const match = text.match(new RegExp(`lib${library}\\s+(\\d+)\\.\\s*(\\d+)\\.\\s*(\\d+)\\s*/\\s*(\\d+)\\.\\s*(\\d+)\\.\\s*(\\d+)`))
          assert(match && match.slice(1, 4).join('.') === abi && match.slice(4, 7).join('.') === abi, 'Linux FFmpeg ABI differs')
        }
      }
      if (label === 'license') assert(/GNU Lesser General Public/.test(text) && /version 2\.1.*or/i.test(text), 'Linux FFmpeg must be LGPL 2.1+')
      if (label === 'buildconf') assert(json(shellWords(text.split('\n').filter(line => /^\s+--/.test(line)).join('\n'))) === json(linuxConfigure(lock, arch)), 'Linux FFmpeg configure differs')
    }
  }
  const executable = path.join(directory, 'ffmpeg')
  const tls = await nativeRun(executable, ['-hide_banner', '-h', 'protocol=tls'], { cwd: task, env })
  assert(/^\s+-tls_verify\s+.*\(default true\)/m.test(tls), 'Linux TLS certificate verification must default to true')
  evidence['tls-help.txt'] = tls
  for (const [kind, query] of Object.entries({ protocol: 'protocols', demuxer: 'demuxers', muxer: 'muxers', decoder: 'decoders', encoder: 'encoders', bsf: 'bsfs', filter: 'filters' })) {
    const text = await nativeRun(executable, ['-hide_banner', '-' + query], { cwd: task, env })
    let names
    if (kind === 'protocol') names = [...text.matchAll(/^ {2,}(\w+) *$/gm)].map(match => match[1])
    else if (kind === 'bsf') names = [...text.matchAll(/^(\w+) *$/gm)].map(match => match[1])
    else if (['demuxer', 'muxer'].includes(kind)) names = [...text.matchAll(/^\s*[D.E ]{1,3}\s+(\w+)(?:,\S+)*\s+/gm)].map(match => match[1])
    else if (kind === 'filter') names = [...text.matchAll(/^\s*[TSC.]{2,3}\s+(\w+)\s+\S+->/gm)].map(match => match[1])
    else names = [...text.matchAll(/^\s*[VAS][A-Z.]{5}\s+(\w+)\s+/gm)].map(match => match[1])
    assert(json([...new Set(names)].sort()) === json([...capabilities[kind], ...(kind === 'filter' ? ['abuffer', 'abuffersink', 'buffer', 'buffersink'] : [])].sort()), 'Linux FFmpeg capability differs: ' + kind)
    evidence[kind + '.txt'] = text
  }
  const fixture = await writeFfmpegFixtures(path.join(task, 'fixtures'))
  const gif = path.join(task, 'probe.gif'), copied = path.join(task, 'copy.mp4')
  await nativeRun(executable, ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', fixture.png, '-vf', 'format=rgb8', gif], { cwd: task, env })
  const bytes = await readFile(gif)
  assert(/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()) && bytes.readUInt16LE(6) === 16 && bytes.readUInt16LE(8) === 16 && bytes.at(-1) === 0x3b, 'Linux PNG/GIF smoke failed')
  await nativeRun(executable, ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', fixture.mp4, '-c', 'copy', copied], { cwd: task, env })
  const probe = JSON.parse(await nativeRun(path.join(directory, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', copied], { cwd: task, env }))
  assert(probe.streams?.length === 1 && probe.streams[0].codec_name === 'h264' && probe.streams[0].width === 160 && probe.streams[0].height === 90 && Number(probe.format?.duration) === 2, 'Linux MP4 copy/ffprobe smoke failed')
  return { files, capabilities, evidence, tlsDefaultVerify: true, license: 'LGPL-2.1-or-later' }
}

export async function loadLinuxBuild(lock, arch) {
  const paths = linuxBuildPaths(root, lock.buildId, arch), manifest = JSON.parse(await readFile(path.join(paths.output, 'build-manifest.json'), 'utf8'))
  assert(manifest.schemaVersion === 1 && manifest.target === `linux-${arch}` && manifest.buildId === lock.buildId && manifest.revision === lock.revision && manifest.extraVersion === lock.extraVersion, 'Linux FFmpeg manifest identity differs')
  await verifyIdentity(sourceLockPath, manifest.lock)
  await verifyIdentity(linuxLockPath, manifest.linuxLock)
  assert(json(manifest.configure) === json(linuxConfigure(lock, arch)) && json(manifest.assertions.capabilities) === json(lock.capabilities), 'Linux FFmpeg configuration differs')
  assert(json(manifest.archives.map(entry => entry.name).sort()) === json([paths.runtimeName, paths.sourceName].sort()), 'Linux FFmpeg archive inventory differs')
  for (const archive of manifest.archives) await verifyIdentity(path.join(paths.output, archive.name), archive)
  for (const patch of lock.patches) await verifyIdentity(path.join(root, 'packaging', 'ffmpeg', patch.file), patch)
  return { ...paths, manifest }
}

export async function buildLinuxFfmpeg(args = process.argv.slice(2)) {
  const target = packagingTarget()
  assert(target.platform === 'linux', 'Linux FFmpeg 必须在原生 Linux x64/arm64 主机上构建')
  assert(args.every(arg => arg === '--download-only'), '用法: npm run ffmpeg:build -- [--download-only]')
  const lock = JSON.parse(await readFile(sourceLockPath, 'utf8')), paths = linuxBuildPaths(root, lock.buildId, target.arch)
  await mkdir(path.join(root, '.runtime-cache'), { recursive: true })
  const work = await mkdtemp(path.join(root, '.runtime-cache', 'ffmpeg-linux-'))
  await mkdir(path.join(work, 'tmp'))
  const env = { PATH: '/usr/bin:/bin', HOME: work, TMPDIR: path.join(work, 'tmp'), SOURCE_DATE_EPOCH: String(lock.sourceDateEpoch),
    LC_ALL: lock.locale, LANG: lock.locale, TZ: lock.timezone, CC: '/usr/bin/gcc', CFLAGS: '-O3 -fPIC',
    ...Object.fromEntries(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'].filter(key => process.env[key]).map(key => [key, process.env[key]])) }
  await mkdir(paths.cache, { recursive: true })
  const inputs = {}
  for (const id of ['ffmpeg', 'zlib']) inputs[id] = await ensureInput(lock.assets.find(asset => asset.id === id), paths.cache, work, env)
  const series = (await readFile(path.join(root, 'packaging', 'ffmpeg', 'patches', 'series'), 'utf8')).trim().split(/\r?\n/)
  assert(json(series) === json(lock.patches.map(patch => path.basename(patch.file))), 'Linux patch series differs')
  for (const patch of lock.patches) await verifyIdentity(path.join(root, 'packaging', 'ffmpeg', patch.file), patch)
  if (args.includes('--download-only')) return
  assert(!await lstat(paths.output).catch(error => { if (error.code === 'ENOENT') return null; throw error }), 'Linux FFmpeg 输出已存在, 请复用已验证输出')
  const toolchain = { target: target.target, node: process.version }
  for (const tool of ['gcc', 'make', 'patchelf']) toolchain[tool] = (await nativeRun('/usr/bin/' + tool, ['--version'], { env })).trim().split('\n')[0]
  toolchain.gnutls = (await nativeRun('/usr/bin/pkg-config', ['--modversion', 'gnutls'], { env })).trim()
  toolchain.glibc = (await nativeRun('/usr/bin/getconf', ['GNU_LIBC_VERSION'], { env })).trim()
  await extract(inputs.ffmpeg, path.join(work, 'ffmpeg-unpack'), env)
  await rename(path.join(work, 'ffmpeg-unpack', 'FFmpeg-' + lock.commit), path.join(work, 'ffmpeg-source'))
  await extract(inputs.zlib, path.join(work, 'zlib-unpack'), env)
  await rename(path.join(work, 'zlib-unpack', 'zlib-1.3.2'), path.join(work, 'zlib-source'))
  await applyNativePatches(lock, work, env)
  await mkdir(path.join(work, 'logs'))
  const execute = async (name, executable, argv, cwd) => {
    console.log('执行 Linux 原生构建: ' + name)
    await writeFile(path.join(work, 'logs', name + '.txt'), await nativeRun(executable, argv, { cwd, env }))
  }
  await execute('zlib-configure', '/bin/sh', ['./configure', '--static', '--prefix=../zlib-prefix'], path.join(work, 'zlib-source'))
  for (const [name, argv] of [['make', ['-j' + lock.jobs]], ['test', ['test']], ['install', ['install']]]) await execute('zlib-' + name, '/usr/bin/make', argv, path.join(work, 'zlib-source'))
  await mkdir(path.join(work, 'build'))
  const configure = linuxConfigure(lock, target.arch)
  await execute('configure', '/bin/sh', ['../ffmpeg-source/configure', ...configure], path.join(work, 'build'))
  await execute('make', '/usr/bin/make', ['-j' + lock.jobs, 'REVISION=' + lock.revision], path.join(work, 'build'))
  await execute('install', '/usr/bin/make', ['REVISION=' + lock.revision, 'install'], path.join(work, 'build'))
  const definitions = (await Promise.all(['config.h', 'config_components.h'].map(name => readFile(path.join(work, 'build', name), 'utf8')))).join('\n')
  const config = Object.fromEntries([...definitions.matchAll(/^#define CONFIG_(\w+) ([01])$/gm)].map(match => [match[1], Number(match[2])]))
  for (const [key, value] of Object.entries({ ...lock.configAssertions, SCHANNEL: 0, GNUTLS: 1 })) assert(config[key] === value, 'Linux CONFIG_' + key + ' differs')
  const componentDefinitions = await readFile(path.join(work, 'build', 'config_components.h'), 'utf8')
  for (const [kind, expected] of Object.entries(lock.capabilities)) {
    const actual = [...componentDefinitions.matchAll(new RegExp(`^#define CONFIG_(\\w+)_${kind.toUpperCase()} 1$`, 'gm'))].map(match => match[1].toLowerCase()).sort()
    assert(json(actual) === json(expected), 'Linux configured capability differs: ' + kind)
  }
  const configureSource = await readFile(path.join(work, 'ffmpeg-source', 'configure'), 'utf8')
  const libraryList = name => {
    const value = configureSource.match(new RegExp(`^${name}="([\\s\\S]*?)"`, 'm'))?.[1]
    assert(value, 'Missing configure library list ' + name)
    return value.trim().split(/\s+/).flatMap(item => item.startsWith('$') ? libraryList(item.slice(1)) : [item])
  }
  const externalLibraries = [...new Set(['EXTERNAL_LIBRARY_LIST', 'EXTERNAL_AUTODETECT_LIBRARY_LIST', 'HWACCEL_LIBRARY_LIST', 'HWACCEL_AUTODETECT_LIBRARY_LIST'].flatMap(libraryList))].filter(name => config[name.toUpperCase()] === 1).sort()
  assert(json(externalLibraries) === json(['gnutls', 'zlib']), 'Unexpected Linux external library')
  const runtime = path.join(work, 'runtime')
  await mkdir(runtime)
  for (const name of linuxRuntimeFiles(lock)) {
    const source = await realpath(path.join(work, 'install', name.startsWith('lib') ? 'lib' : 'bin', name))
    assert(source.startsWith(path.join(work, 'install') + path.sep), 'Linux installed library link escapes private prefix')
    await cp(source, path.join(runtime, name))
    await nativeRun('/usr/bin/patchelf', ['--set-rpath', '$ORIGIN', path.join(runtime, name)], { env })
  }
  const assertions = await verifyLinuxRuntime(runtime, lock, target.arch, path.join(work, 'tmp'))
  assertions.externalLibraries = externalLibraries
  const materials = path.join(work, 'materials')
  await mkdir(path.join(materials, 'upstream'), { recursive: true })
  for (const file of Object.values(inputs)) await cp(file, path.join(materials, 'upstream', path.basename(file)))
  await cp(path.join(root, 'packaging', 'ffmpeg'), path.join(materials, 'packaging', 'ffmpeg'), { recursive: true })
  for (const platform of ['mac', 'linux']) await cp(path.join(root, 'packaging', `tools-${platform}-lock.json`), path.join(materials, 'packaging', `tools-${platform}-lock.json`))
  await mkdir(path.join(materials, 'scripts'))
  for (const name of ['build-ffmpeg-linux.mjs', 'build-ffmpeg-mac.mjs', 'packaging-platform.mjs', 'ffmpeg-fixtures.mjs']) await cp(path.join(root, 'scripts', name), path.join(materials, 'scripts', name))
  await mkdir(path.join(materials, 'build'))
  for (const name of ['config.h', 'config_components.h', 'libavutil/ffversion.h']) await cp(path.join(work, 'build', name), path.join(materials, 'build', path.basename(name)))
  await writeFile(path.join(materials, 'build', 'configure.json'), json(configure))
  await writeFile(path.join(materials, 'build', 'toolchain.json'), json(toolchain))
  await mkdir(path.join(materials, 'evidence'))
  for (const [name, text] of Object.entries(assertions.evidence)) await writeFile(path.join(materials, 'evidence', name), text)
  await mkdir(path.join(materials, 'licenses', 'ffmpeg'), { recursive: true })
  for (const name of (await readdir(path.join(work, 'ffmpeg-source'))).filter(name => /^(COPYING|LICENSE)/.test(name))) await cp(path.join(work, 'ffmpeg-source', name), path.join(materials, 'licenses', 'ffmpeg', name))
  await mkdir(path.join(materials, 'licenses', 'zlib'))
  await cp(path.join(work, 'zlib-source', 'LICENSE'), path.join(materials, 'licenses', 'zlib', 'LICENSE'))
  const next = path.join(work, 'out'), archives = []
  await mkdir(next)
  for (const [directory, name] of [[runtime, paths.runtimeName], [materials, paths.sourceName]]) {
    const files = await sourceFiles(directory)
    await nativeRun('/usr/bin/tar', ['-czf', path.join(next, name), '-C', directory, ...files.map(entry => entry.name)], { cwd: work, env })
    archives.push({ ...await fileIdentity(path.join(next, name)), files })
  }
  delete assertions.evidence
  const manifest = { schemaVersion: 1, target: target.target, buildId: lock.buildId, revision: lock.revision, extraVersion: lock.extraVersion,
    sourceDateEpoch: lock.sourceDateEpoch, lock: await fileIdentity(sourceLockPath), linuxLock: await fileIdentity(linuxLockPath), configure, toolchain, assertions, archives }
  await writeFile(path.join(next, 'build-manifest.json'), json(manifest))
  await mkdir(path.dirname(paths.output), { recursive: true })
  await rename(next, paths.output)
  console.log('Linux 原生 FFmpeg 构建及工具检查通过: ' + paths.output)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await buildLinuxFfmpeg() } catch (error) { console.error(error.stack); process.exitCode = 1 }
}
