import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { deflateRawSync, zstdDecompressSync } from 'node:zlib';

// This entry point deliberately does not import the product tool preparation code.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockDir = path.join(repo, 'packaging/ffmpeg');
const lock = JSON.parse(await fs.readFile(path.join(lockDir, 'build-lock.json'), 'utf8'));
const cache = path.join(repo, '.packaging/ffmpeg-build/downloads');
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return args[i + 1];
}
const slash = p => p.replaceAll('\\', '/');
const digest = data => createHash('sha256').update(data).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
function assert(ok, message) { if (!ok) throw new Error(message); }
async function exists(p) { try { await fs.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function exclusive(p, data) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, data, { flag: 'wx' }); }
async function identity(p, name = path.basename(p)) {
  const data = await fs.readFile(p);
  return { name, size: data.length, sha256: digest(data) };
}
async function verify(p, entry) {
  const stat = await fs.lstat(p);
  assert(stat.isFile() && !stat.isSymbolicLink(), `Not a regular file: ${p}`);
  const actual = await identity(p);
  assert(actual.size === entry.size && actual.sha256 === entry.sha256,
    `Integrity mismatch: ${p}; expected ${entry.size}/${entry.sha256}, got ${actual.size}/${actual.sha256}. Cache was not overwritten.`);
}
async function downloadAll(temp) {
  await fs.mkdir(cache, { recursive: true });
  // Validate every existing input before starting any new download.
  for (const a of lock.assets) if (await exists(path.join(cache, a.file))) await verify(path.join(cache, a.file), a);
  for (const p of lock.patches) await verify(path.join(lockDir, p.file), p);
  await Promise.all(lock.assets.map(async a => {
    const dest = path.join(cache, a.file);
    if (await exists(dest)) return;
    console.log(`下载 ${a.id}: ${a.url}`);
    const partial = path.join(temp, a.file + '.partial');
    await exclusive(partial, '');
    // Use the Windows bootstrap downloader, including its configured HTTPS proxy.
    await run(path.join(process.env.SystemRoot, 'System32/curl.exe'),
      ['--disable', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--silent', '--show-error', '--max-time', '900', '--output', partial, a.url],
      { env: { ...process.env, USERPROFILE: temp, APPDATA: temp, LOCALAPPDATA: temp, TEMP: temp, TMP: temp } });
    await verify(partial, a);
    // COPYFILE_EXCL protects a cache created concurrently by another process.
    await fs.copyFile(partial, dest, 1);
    console.log(`已验证 ${a.id}: ${a.sha256}`);
  }));
  for (const a of lock.assets) await verify(path.join(cache, a.file), a);
}

async function run(exe, argv, { cwd, env = process.env, log } = {}) {
  const child = spawn(exe, argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => chunks.push(b));
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const output = Buffer.concat(chunks).toString('utf8').replaceAll('\r\n', '\n');
  if (log) await exclusive(log, output);
  assert(status === 0, `${path.basename(exe)} failed (${status})${log ? `; ${log}` : ''}\n${output.slice(-4000)}`);
  return output;
}

async function extract(tar, archive, dest, env) {
  await fs.mkdir(dest);
  const tarPath = p => tar.includes('/git/') ? slash(p).replace(/^([a-z]):/i, (_, drive) => '/' + drive.toLowerCase()) : p;
  const names = (await run(tar, ['-tf', tarPath(archive)], { env })).trim().split('\n');
  for (const name of names) assert(!/^(?:\/|[a-z]:)/i.test(name) && !slash(name).split('/').includes('..'), `Unsafe archive member: ${name}`);
  const verbose = await run(tar, ['-tvf', tarPath(archive)], { env });
  assert(!/^[lh]/m.test(verbose), `Links are not allowed in input archive: ${archive}`);
  await run(tar, ['-xf', tarPath(archive), '-C', tarPath(dest)], { env });
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
async function build(temp) {
  const root = slash(path.resolve(option('--build-root', `${lock.defaultBuildParent}/${lock.buildId}`)));
  assert(new RegExp(`^C:/fy1-ffmpeg-[a-z0-9-]+/${lock.buildId.replaceAll('.', '\\.')}\$`).test(root), 'Build root must be C:/fy1-ffmpeg-<neutral-name>/<buildId>');
  const out = path.resolve(option('--output-dir', path.join(repo, '.packaging/ffmpeg-build/out', lock.buildId)));
  assert([path.join(repo, '.packaging/ffmpeg-build/out'), path.join(repo, '.runtime-cache')].some(p => slash(out).startsWith(slash(p) + '/')), 'Output must be inside the build output or .runtime-cache directory');
  assert(!await exists(root), `Build directory already exists: ${root}. It will not be reused or removed.`);
  assert(!await exists(out), `Output directory already exists: ${out}`);
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.mkdir(root);
  for (const d of ['tmp', 'home', 'appdata', 'localappdata', 'logs', 'build', 'runtime', 'zlib-build']) await fs.mkdir(path.join(root, d));
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
    COMSPEC: path.join(process.env.SystemRoot, 'System32/cmd.exe'),
    PATH: path.join(process.env.SystemRoot, 'System32'), TEMP: `${root}/tmp`, TMP: `${root}/tmp`,
    USERPROFILE: `${root}/home`, APPDATA: `${root}/appdata`, LOCALAPPDATA: `${root}/localappdata`,
    SOURCE_DATE_EPOCH: String(lock.sourceDateEpoch), LC_ALL: lock.locale, LANG: lock.locale, TZ: lock.timezone,
    MSYS2_PATH_TYPE: 'strict', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: `${root}/empty-gitconfig`,
    GIT_CEILING_DIRECTORIES: root };
  const inputs = Object.fromEntries(lock.assets.map(a => [a.id, path.join(cache, a.file)]));
  const systemTar = path.join(process.env.SystemRoot, 'System32/tar.exe');
  console.log('解压锁定工具链');
  await extract(systemTar, inputs.winlibs, `${root}/winlibs`, env);
  await run(inputs.portableGit, ['-y', `-o${root}/git`], { env, log: `${root}/logs/portable-git-extract.txt` });
  const makeTar = `${root}/make.tar`;
  await exclusive(makeTar, zstdDecompressSync(await fs.readFile(inputs.make)));
  await extract(systemTar, makeTar, `${root}/make`, env);
  const gccBin = `${root}/winlibs/mingw64/bin`;
  const gitBin = `${root}/git/usr/bin`;
  const makeBin = `${root}/make/usr/bin`;
  env.PATH = [makeBin, gccBin, gitBin, `${root}/git/mingw64/bin`, path.join(process.env.SystemRoot, 'System32')].join(';');
  const bash = `${gitBin}/bash.exe`;
  const tools = { gcc: `${gccBin}/gcc.exe`, ar: `${gccBin}/ar.exe`, ranlib: `${gccBin}/ranlib.exe`,
    ld: `${gccBin}/ld.exe`, objdump: `${gccBin}/objdump.exe`, strip: `${gccBin}/strip.exe`,
    nasm: `${gccBin}/nasm.exe`, cmake: `${gccBin}/cmake.exe`, ctest: `${gccBin}/ctest.exe`, ninja: `${gccBin}/ninja.exe`,
    make: `${makeBin}/make.exe`, bash, git: `${root}/git/cmd/git.exe`, node: process.execPath };
  const toolchain = {};
  for (const [name, exe] of Object.entries(tools)) {
    const output = await run(exe, ['--version'], { env });
    const expected = name === 'gcc' ? lock.toolchain.gccBanner : lock.toolchain[['ld','ar','ranlib','objdump','strip'].includes(name) ? 'binutils' : name === 'ctest' ? 'cmake' : name];
    if (expected) assert(output.split('\n')[0].includes(expected), `Wrong ${name} version: ${output}`);
    toolchain[name] = { ...(await identity(exe)), version: output.split('\n')[0] };
  }
  const target = (await run(tools.gcc, ['-dumpmachine'], { env })).trim();
  assert(target === lock.toolchain.target, `Wrong GCC target: ${target}`);
  assert((await run(tools.gcc, ['-dumpfullversion'], { env })).trim() === lock.toolchain.gcc, 'Wrong GCC full version');
  const gccVerbose = await run(tools.gcc, ['-v'], { env });
  assert(gccVerbose.includes('Thread model: posix'), 'POSIX toolchain required');
  await exclusive(`${root}/logs/gcc-verbose.txt`, gccVerbose);
  toolchain.target = target;
  toolchain.mingw = lock.toolchain.mingw;
  toolchain.bootstrapTar = { ...(await identity(systemTar)), version: (await run(systemTar, ['--version'], { env })).trim() };
  await exclusive(`${root}/probe.c`, '#include <_mingw.h>\n#if __MINGW64_VERSION_MAJOR != 12 || __MINGW64_VERSION_MINOR != 0\n#error Wrong MinGW version\n#endif\n#ifndef _UCRT\n#error UCRT required\n#endif\nint main(void) { return 0; }\n');
  await run(tools.gcc, ['probe.c', '-static-libgcc', '-o', 'probe.exe'], { cwd: root, env });
  await run(`${root}/probe.exe`, [], { env });
  await exclusive(`${root}/probe.asm`, 'bits 64\nsection .text\nglobal fy1_probe\nfy1_probe: ret\n');
  await run(tools.nasm, ['-f', 'win64', 'probe.asm', '-o', 'probe.obj'], { cwd: root, env });
  console.log('工具链身份和 C/NASM 探针通过');
  const lockedTar = `${gitBin}/tar.exe`;
  await extract(lockedTar, inputs.ffmpeg, `${root}/ffmpeg-unpack`, env);
  await fs.rename(`${root}/ffmpeg-unpack/FFmpeg-${lock.commit}`, `${root}/ffmpeg-source`);
  await extract(lockedTar, inputs.zlib, `${root}/zlib-unpack`, env);
  await fs.rename(`${root}/zlib-unpack/zlib-1.3.2`, `${root}/zlib-source`);
  await extract(lockedTar, inputs.mingwSource, `${root}/mingw-source`, env);
  const series = (await fs.readFile(path.join(lockDir, 'patches/series'), 'utf8')).trim().split(/\r?\n/);
  assert(json(series) === json(lock.patches.map(p => path.basename(p.file))), 'Patch series differs from lock');
  for (const patch of lock.patches) await run(`${gitBin}/patch.exe`, ['--batch', '--fuzz=0', '-p1', '-i', path.join(lockDir, patch.file)], { cwd: `${root}/ffmpeg-source`, env, log: `${root}/logs/${path.basename(patch.file)}.txt` });
  // All configure paths are relative, so a second neutral root gets identical buildconf.
  const script = [
    '#!/usr/bin/env bash', 'set -euo pipefail',
    'export PATH="$(cygpath -u "$FY1_ROOT/make/usr/bin"):$(cygpath -u "$FY1_ROOT/winlibs/mingw64/bin"):$(cygpath -u "$FY1_ROOT/git/usr/bin"):$(cygpath -u "$FY1_ROOT/git/mingw64/bin"):/c/Windows/System32"',
    'export TMPDIR="$(cygpath -u "$FY1_ROOT/tmp")"', 'cd "$(cygpath -u "$FY1_ROOT")/build"',
    `../ffmpeg-source/configure ${lock.configure.map(shellQuote).join(' ')} > ../logs/configure.txt 2>&1`,
    `make -j${lock.jobs} REVISION=${shellQuote(lock.revision)} > ../logs/make.txt 2>&1`,
    `make REVISION=${shellQuote(lock.revision)} install > ../logs/install.txt 2>&1`, ''
  ].join('\n');
  await exclusive(`${root}/build.sh`, script);
  await exclusive(`${root}/configure-command.txt`, `../ffmpeg-source/configure ${lock.configure.map(shellQuote).join(' ')}\nmake -j${lock.jobs} REVISION=${shellQuote(lock.revision)}\nmake REVISION=${shellQuote(lock.revision)} install\n`);
  console.log('构建 zlib 静态库');
  await run(tools.cmake, ['-G', 'Ninja', '-S', '../zlib-source', '-B', '.', '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF', '-DZLIB_BUILD_TESTING=ON', '-DZLIB_BUILD_SHARED=OFF', '-DZLIB_BUILD_STATIC=ON',
    `-DCMAKE_C_COMPILER=${tools.gcc}`, `-DCMAKE_MAKE_PROGRAM=${tools.ninja}`, `-DCMAKE_INSTALL_PREFIX=${root}/zlib-prefix`,
    '-DCMAKE_C_FLAGS=-march=x86-64 -static-libgcc', '-DCMAKE_EXE_LINKER_FLAGS=-Wl,--no-insert-timestamp'],
  { cwd: `${root}/zlib-build`, env, log: `${root}/logs/zlib-configure.txt` });
  await run(tools.cmake, ['--build', '.', '--parallel', String(lock.jobs)], { cwd: `${root}/zlib-build`, env, log: `${root}/logs/zlib-build.txt` });
  await run(tools.ctest, ['--output-on-failure'], { cwd: `${root}/zlib-build`, env, log: `${root}/logs/zlib-test.txt` });
  await run(tools.cmake, ['--install', '.'], { cwd: `${root}/zlib-build`, env, log: `${root}/logs/zlib-install.txt` });
  await fs.copyFile(`${root}/zlib-prefix/lib/libzs.a`, `${root}/zlib-prefix/lib/libz.a`, 1);
  console.log('构建 FFmpeg');
  await run(bash, ['--noprofile', '--norc', slash(`${root}/build.sh`)], { cwd: root, env: { ...env, FY1_ROOT: root }, log: `${root}/logs/build-driver.txt` });
  for (const name of lock.runtimeFiles) await fs.copyFile(`${root}/install/bin/${name}`, `${root}/runtime/${name}`, 1);
  const result = await assertions(root, tools, env);
  await packageBuild(root, out, inputs, toolchain, result);
  await exclusive(path.join(temp, 'result.json'), json({ buildRoot: root, output: out, buildId: lock.buildId }));
  console.log(`构建及全部断言通过: ${out}`);
}

function peImports(data) {
  const pe = data.readUInt32LE(0x3c);
  assert(data.readUInt32LE(pe) === 0x4550 && data.readUInt16LE(pe + 4) === 0x8664, 'PE x86-64 required');
  const opt = pe + 24;
  assert(data.readUInt16LE(opt) === 0x20b, 'PE32+ required');
  const sections = opt + data.readUInt16LE(pe + 20);
  function offset(rva) {
    for (let i = 0; i < data.readUInt16LE(pe + 6); i++) {
      const s = sections + i * 40;
      const va = data.readUInt32LE(s + 12), size = data.readUInt32LE(s + 16);
      if (rva >= va && rva < va + size) return rva - va + data.readUInt32LE(s + 20);
    }
    throw new Error(`Unmapped PE RVA ${rva}`);
  }
  function string(rva) { const start = offset(rva), end = data.indexOf(0, start); assert(end > start, 'Invalid PE string'); return data.toString('ascii', start, end); }
  const imports = [], delayImports = [];
  for (const [index, stride, nameOffset, dest] of [[1, 20, 12, imports], [13, 32, 4, delayImports]]) {
    const rva = data.readUInt32LE(opt + 112 + index * 8);
    if (!rva) continue;
    let p = offset(rva);
    for (let count = 0; count < 1000; count++, p += stride) {
      if (data.subarray(p, p + stride).every(b => b === 0)) break;
      if (index === 13) assert(data.readUInt32LE(p) === 1, 'Only RVA delay import descriptors are supported');
      dest.push(string(data.readUInt32LE(p + nameOffset)));
      assert(count < 999, 'Unterminated PE import table');
    }
  }
  const timestamp = data.readUInt32LE(pe + 8);
  assert(timestamp === lock.sourceDateEpoch, 'PE timestamp must equal SOURCE_DATE_EPOCH');
  return { imports: imports.sort(), delayImports: delayImports.sort(), machine: 'PE32+ x86-64', timestamp };
}

function shellWords(text) {
  const words = []; let word = '', quote = '', active = false;
  for (const c of text.trim()) {
    if (quote) { if (c === quote) quote = ''; else word += c; }
    else if (c === "'" || c === '"') { quote = c; active = true; }
    else if (/\s/.test(c)) { if (active) { words.push(word); word = ''; active = false; } }
    else { word += c; active = true; }
  }
  assert(!quote, 'Unclosed configure quote');
  if (active) words.push(word);
  return words;
}

async function assertions(root, tools, env) {
  const cfg = await fs.readFile(`${root}/build/config.h`, 'utf8');
  const components = await fs.readFile(`${root}/build/config_components.h`, 'utf8');
  const definitions = Object.fromEntries([...(`${cfg}\n${components}`).matchAll(/^#define CONFIG_(\w+) ([01])$/gm)].map(m => [m[1], Number(m[2])]));
  const componentDefinitions = Object.fromEntries([...components.matchAll(/^#define CONFIG_(\w+) ([01])$/gm)].map(m => [m[1], Number(m[2])]));
  for (const [key, value] of Object.entries(lock.configAssertions)) assert(definitions[key] === value, `CONFIG_${key} != ${value}`);
  const capabilities = {};
  for (const [kind, expected] of Object.entries(lock.capabilities)) {
    const suffix = '_' + kind.toUpperCase();
    const actual = Object.keys(componentDefinitions).filter(k => k.endsWith(suffix) && componentDefinitions[k] === 1).map(k => k.slice(0, -suffix.length).toLowerCase()).sort();
    assert(json(actual) === json(expected), `CONFIG ${kind} set differs: ${json(actual)}`);
    capabilities[kind] = actual;
  }
  const configure = await fs.readFile(`${root}/ffmpeg-source/configure`, 'utf8');
  function libraryList(name) {
    const value = configure.match(new RegExp(`^${name}="([\\s\\S]*?)"`, 'm'))?.[1];
    assert(value, `Missing configure library list ${name}`);
    return value.trim().split(/\s+/).flatMap(v => v.startsWith('$') ? libraryList(v.slice(1)) : [v]);
  }
  const external = [...new Set(['EXTERNAL_LIBRARY_LIST', 'EXTERNAL_AUTODETECT_LIBRARY_LIST', 'HWACCEL_LIBRARY_LIST', 'HWACCEL_AUTODETECT_LIBRARY_LIST'].flatMap(libraryList))].filter(v => definitions[v.toUpperCase()] === 1).sort();
  assert(json(external) === json(lock.externalLibraries), `Unexpected external libraries: ${external}`);
  const runtime = `${root}/runtime`;
  assert(json((await fs.readdir(runtime)).sort()) === json(lock.runtimeFiles), 'Runtime file inventory differs');
  const cleanEnv = { ...env, PATH: path.join(process.env.SystemRoot, 'System32') };
  const evidence = {};
  for (const exe of ['ffmpeg', 'ffprobe']) {
    for (const [label, argv] of [['version', ['-version']], ['license', ['-hide_banner', '-L']], ['buildconf', ['-hide_banner', '-buildconf']]]) {
      const output = await run(`${runtime}/${exe}.exe`, argv, { cwd: runtime, env: cleanEnv });
      evidence[`${exe}-${label}.txt`] = output;
      if (label === 'version') {
        assert(output.split('\n')[0].split(' ')[2] === `${lock.revision}-${lock.extraVersion}`, `${exe} version mismatch`);
        for (const [lib, abi] of Object.entries(lock.abi)) {
          const match = output.match(new RegExp(`lib${lib}\\s+(\\d+)\\.\\s*(\\d+)\\.\\s*(\\d+)\\s*/\\s*(\\d+)\\.\\s*(\\d+)\\.\\s*(\\d+)`));
          assert(match && match.slice(1, 4).join('.') === abi && match.slice(4, 7).join('.') === abi, `${exe}: ABI mismatch ${lib}`);
        }
      }
      if (label === 'license') assert(/GNU Lesser General Public/.test(output) && /version 2\.1.*or/i.test(output), `${exe} is not LGPL 2.1+`);
      if (label === 'buildconf') {
        const text = output.split('\n').filter(line => /^\s+--/.test(line)).join('\n');
        assert(json(shellWords(text)) === json(lock.configure), `${exe} buildconf differs from lock: ${text}`);
      }
    }
  }
  const tlsHelp = await run(`${runtime}/ffmpeg.exe`, ['-hide_banner', '-h', 'protocol=tls'], { cwd: runtime, env: cleanEnv });
  for (const name of ['tls_verify', 'verify']) assert(new RegExp(`^\\s+-${name}\\s+.*\\(default true\\)`, 'm').test(tlsHelp), `TLS ${name} default is not true`);
  evidence['tls-help.txt'] = tlsHelp;
  // This FFmpeg revision has no -parsers CLI option; query its public iterator.
  await exclusive(`${root}/parser-probe.c`, '#include <stdio.h>\n#include <libavcodec/avcodec.h>\nint main(void) { void *opaque = NULL; const AVCodecParser *p; while ((p = av_parser_iterate(&opaque))) puts(avcodec_get_name(p->codec_ids[0])); return 0; }\n');
  await run(tools.gcc, ['parser-probe.c', '-Iinstall/include', '-Linstall/lib', '-lavcodec', '-lavutil', '-static-libgcc', '-Wl,--no-insert-timestamp', '-o', 'parser-probe.exe'], { cwd: root, env });
  const parserOutput = await run(`${root}/parser-probe.exe`, [], { cwd: runtime, env: { ...cleanEnv, PATH: `${runtime};${cleanEnv.PATH}` } });
  const actualParsers = parserOutput.trim().split('\n').sort();
  assert(json(actualParsers) === json(lock.capabilities.parser), 'Runtime parser iterator differs from lock');
  evidence['parsers.txt'] = parserOutput;
  const listArgs = { protocol: 'protocols', demuxer: 'demuxers', muxer: 'muxers', decoder: 'decoders', encoder: 'encoders', bsf: 'bsfs', filter: 'filters' };
  const runtimeCapabilities = { parser: actualParsers };
  for (const [kind, query] of Object.entries(listArgs)) {
    const output = await run(`${runtime}/ffmpeg.exe`, ['-hide_banner', `-${query}`], { cwd: runtime, env: cleanEnv });
    evidence[`${query}.txt`] = output;
    let names;
    if (kind === 'protocol') names = [...output.matchAll(/^ {2,}(\w+) *$/gm)].map(m => m[1]);
    else if (kind === 'bsf') names = [...output.matchAll(/^(\w+) *$/gm)].map(m => m[1]);
    else if (['demuxer', 'muxer'].includes(kind)) names = [...output.matchAll(/^\s*[D.E ]{1,3}\s+(\w+)(?:,\S+)*\s+/gm)].map(m => m[1]);
    else if (kind === 'filter') names = [...output.matchAll(/^\s*[TSC.]{2,3}\s+(\w+)\s+\S+->/gm)].map(m => m[1]);
    else names = [...output.matchAll(/^\s*[VAS][A-Z.]{5}\s+(\w+)\s+/gm)].map(m => m[1]);
    names = [...new Set(names)].sort();
    const expected = [...lock.capabilities[kind], ...(kind === 'filter' ? ['abuffer', 'abuffersink', 'buffer', 'buffersink'] : [])].sort();
    assert(json(names) === json(expected), `Runtime ${kind} differs: ${json(names)}`);
    runtimeCapabilities[kind] = names;
  }
  const forbidden = [repo, process.env.USERPROFILE, 'C:/Users/', '/c/Users/'].filter(Boolean).map(slash);
  const checkPaths = (data, label) => {
    for (const text of [data.toString('latin1'), data.toString('utf16le')]) {
      const normalized = slash(text).toLowerCase();
      for (const p of forbidden) assert(!normalized.includes(p.toLowerCase()), `Private path in ${label}`);
    }
  };
  const files = [];
  const allowed = new Set([...lock.runtimeFiles, ...lock.systemImports].map(s => s.toLowerCase()));
  for (const name of lock.runtimeFiles) {
    const data = await fs.readFile(`${runtime}/${name}`);
    checkPaths(data, name);
    const pe = peImports(data);
    for (const dll of [...pe.imports, ...pe.delayImports]) assert(allowed.has(dll.toLowerCase()), `Unexpected DLL in ${name}: ${dll}`);
    files.push({ ...(await identity(`${runtime}/${name}`)), ...pe });
  }
  for (const [name, text] of Object.entries(evidence)) { checkPaths(Buffer.from(text), name); await exclusive(`${root}/evidence/${name}`, text); }
  const ffversion = await fs.readFile(`${root}/build/libavutil/ffversion.h`, 'utf8');
  assert(ffversion.includes(`"${lock.revision}-${lock.extraVersion}"`), 'ffversion.h mismatch');
  const result = { config: lock.configAssertions, externalLibraries: external, capabilities, runtimeCapabilities, files, tlsDefaultVerify: true, license: 'LGPL-2.1-or-later', privatePathsAbsent: true, cleanPath: true };
  await exclusive(`${root}/evidence/assertions.json`, json(result));
  return result;
}

// ZIP metadata is authored here rather than inherited from filesystem mtimes.
function crc32(data) {
  let crc = 0xffffffff;
  for (const b of data) { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
async function zip(entries, dest) {
  const local = [], central = [];
  let offset = 0;
  const date = new Date(lock.sourceDateEpoch * 1000);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const inventory = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    assert(!entry.name.startsWith('/') && !entry.name.split('/').includes('..'), 'Unsafe ZIP entry');
    const data = entry.data ?? await fs.readFile(entry.file), name = Buffer.from(entry.name), compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data), header = Buffer.alloc(30), dir = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); header.copy(dir, 6, 4, 30);
    dir.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(dir, name);
    offset += header.length + name.length + compressed.length;
    inventory.push({ name: entry.name, size: data.length, sha256: digest(data) });
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  await exclusive(dest, Buffer.concat([...local, directory, end]));
  return { ...(await identity(dest)), files: inventory };
}

async function walk(dir, prefix = '') {
  const files = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    const file = path.join(dir, name), entry = await fs.lstat(file);
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${file}`);
    if (entry.isDirectory()) files.push(...await walk(file, prefix + name + '/'));
    else if (entry.isFile()) files.push({ name: prefix + name, file });
  }
  return files;
}

async function packageBuild(root, out, inputs, toolchain, result) {
  const source = [{ name: '.gitattributes', file: path.join(repo, '.gitattributes') }];
  for (const id of ['ffmpeg', 'zlib', 'mingwSource']) source.push({ name: `upstream/${path.basename(inputs[id])}`, file: inputs[id] });
  for (const entry of await walk(lockDir)) source.push({ ...entry, name: `packaging/ffmpeg/${entry.name}` });
  source.push({ name: 'scripts/build-ffmpeg.mjs', file: fileURLToPath(import.meta.url) });
  for (const entry of await walk(path.join(repo, 'scripts/ffmpeg-smoke'))) source.push({ ...entry, name: `scripts/ffmpeg-smoke/${entry.name}` });
  for (const name of ['config.h', 'config_components.h', 'ffbuild/config.mak', 'libavutil/ffversion.h']) source.push({ name: `build/${name}`, file: `${root}/build/${name}` });
  source.push({ name: 'build/configure-command.txt', file: `${root}/configure-command.txt` }, { name: 'build/build.sh', file: `${root}/build.sh` });
  source.push({ name: 'build/parser-probe.c', file: `${root}/parser-probe.c` });
  for (const entry of await walk(`${root}/evidence`)) source.push({ ...entry, name: `evidence/${entry.name}` });
  for (const name of (await fs.readdir(`${root}/ffmpeg-source`)).filter(n => /^(?:COPYING|LICENSE)/.test(n))) source.push({ name: `licenses/ffmpeg/${name}`, file: `${root}/ffmpeg-source/${name}` });
  source.push({ name: 'licenses/zlib/LICENSE', file: `${root}/zlib-source/LICENSE` });
  const mingw = (await walk(`${root}/mingw-source`)).filter(e => /(?:^|\/)(?:COPYING[^/]*|LICENSE[^/]*|DISCLAIMER[^/]*)$/i.test(e.name));
  for (const entry of mingw) source.push({ ...entry, name: `licenses/mingw-w64/${entry.name}` });
  for (const id of ['gccLicense', 'gccRuntimeException']) source.push({ name: `licenses/gcc/${path.basename(inputs[id])}`, file: inputs[id] });
  source.push({ name: 'build/toolchain.json', data: Buffer.from(json(toolchain)) });
  source.push({ name: 'README.md', data: Buffer.from('# Fy1Sync FFmpeg 构建材料\n\n此归档包含原始源码包, 本地补丁, 构建锁, 构建脚本, 配置和许可原文.\n\n在 Windows x64 和 Node.js 24.15.0 下解压到新的目录, 运行 `node scripts/build-ffmpeg.mjs`. 入口会下载并验证锁定工具链. 中性构建目录及输出目录必须不存在. `--build-root C:/fy1-ffmpeg-rebuild/' + lock.buildId + '` 可用于第二次构建, `--output-dir .runtime-cache/rebuild-out` 指定独立输出.\n\n`libzs.a` 复制为私有前缀 `libz.a`, 静态链接 zlib 和 GCC/winpthreads runtime. FFmpeg 共享库采用 LGPL-2.1-or-later. 原始包内保留完整上游许可; licenses/ 额外展开许可原文. 这不是整个 GCC 工具链的源码重建包.\n\n构建日志保留在中性构建根目录的 logs/. configure 使用相对路径, REVISION 显式传入 make 和 install. 归档顺序和时间戳固定, 使用 Node.js 内置 deflate; 入口同时核对锁定 Node 版本.\n') });
  await fs.mkdir(out, { recursive: true });
  const runtime = await zip(lock.runtimeFiles.map(name => ({ name, file: `${root}/runtime/${name}` })), path.join(out, `fy1sync-ffmpeg-${lock.buildId}-win-x64.zip`));
  const materials = await zip(source, path.join(out, `fy1sync-ffmpeg-${lock.buildId}-source.zip`));
  const manifest = { schemaVersion: 1, buildId: lock.buildId, revision: lock.revision, extraVersion: lock.extraVersion,
    sourceDateEpoch: lock.sourceDateEpoch, lock: await identity(path.join(lockDir, 'build-lock.json')),
    toolchain, assertions: result, archives: [runtime, materials] };
  await exclusive(path.join(out, 'build-manifest.json'), json(manifest));
}

async function main() {
  assert(process.platform === 'win32' && process.arch === 'x64', 'Windows x64 is required');
  assert(process.version === `v${lock.toolchain.node}`, `Node.js ${lock.toolchain.node} is required for the locked archive codec`);
  const temp = path.resolve(option('--work-dir', path.join(repo, '.runtime-cache', `codex-ffmpeg-build-${new Date().toISOString().replace(/\D/g, '')}`)));
  assert(slash(temp).startsWith(slash(path.join(repo, '.runtime-cache')) + '/'), 'Work directory must be inside .runtime-cache');
  await fs.mkdir(path.dirname(temp), { recursive: true });
  await fs.mkdir(temp, { recursive: false });
  await downloadAll(temp);
  if (args.includes('--download-only')) return;
  await build(temp);
}
try { await main(); } catch (e) { console.error(e.stack); process.exitCode = 1; }
