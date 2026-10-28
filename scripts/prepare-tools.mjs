/** Fixed inputs only. Run explicitly at build time; application startup never invokes this. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProviderDependencies } from './provider-dependencies.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const lock = JSON.parse(await readFile(path.join(root, 'packaging', 'tools-lock.json'), 'utf8'))
const staging = path.join(root, '.packaging'), downloads = path.join(staging, 'downloads'), work = path.join(staging, 'work'), output = path.join(staging, 'tools')
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Tool preparation requires Windows x64')
if (lock.schema !== 1 || lock.target !== 'win32-x64' || !Array.isArray(lock.assets)) throw new Error('Invalid tool lock')
function run(executable, args, cwd = root, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = '', errors = ''
    child.stdout.on('data', bytes => { text += bytes; if (text.length > 8 * 1048576) child.kill() })
    child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-8192) })
    const timer = setTimeout(() => { child.kill() }, 300_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(text.trim()) : reject(new Error(`Tool preparation command failed (${path.basename(executable)}, exit ${code}): ${errors}`)) })
  })
}
async function hash(file) {
  const h = createHash('sha256')
  for await (const bytes of createReadStream(file)) h.update(bytes)
  return h.digest('hex')
}
async function valid(file, asset) {
  try { return (await stat(file)).size === asset.size && await hash(file) === asset.sha256 } catch { return false }
}
const allowedHosts = new Set(['github.com', 'codeload.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
async function download(asset, destination) {
  let current = asset.url
  const temporary = destination + '.partial'
  const signal = AbortSignal.timeout(180_000)
  try {
    for (let count = 0; count <= 4; count++) {
      const url = new URL(current)
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowedHosts.has(url.hostname)) throw new Error('Untrusted build download destination')
      const response = await fetch(current, { signal, redirect: 'manual', headers: { 'User-Agent': 'Fy1Sync-Reproducible-Build', 'Accept-Encoding': 'identity' } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location || count === 4) throw new Error('Too many build download redirects')
        current = new URL(location, current).href; continue
      }
      if (response.status !== 200 || !response.body) throw new Error('Build input unavailable; keep the verified local cache')
      const file = await open(temporary, 'w')
      let size = 0
      try {
        for await (const bytes of response.body) {
          size += bytes.length
          if (size > asset.size) throw new Error('Build download size exceeded')
          await file.writeFile(bytes)
        }
      } finally { await file.close() }
      if (!await valid(temporary, asset)) throw new Error('Build input SHA256/size mismatch')
      await rename(temporary, destination)
      return
    }
    throw new Error('Build input download failed')
  } finally { await rm(temporary, { force: true }) }
}
async function reset(directory) {
  if (path.dirname(directory) !== staging || !['work', 'tools'].includes(path.basename(directory))) throw new Error('Unsafe staging cleanup path')
  if ((await lstat(directory).catch(() => null))?.isSymbolicLink()) throw new Error('Staging cannot be a symlink')
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
}
async function extract(name, destination, expectedRoot) {
  await mkdir(destination, { recursive: true })
  const archive = path.join(downloads, name)
  const names = (await run('tar.exe', ['-tf', archive])).split(/\r?\n/)
  if (names.length > 30_000 || names.some(name => !name.startsWith(expectedRoot + '/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.') || /^[A-Za-z]:/.test(name))) throw new Error('Unexpected archive layout')
  await run('tar.exe', ['-xf', archive, '-C', destination])
  return path.join(destination, expectedRoot)
}
async function files(directory, prefix = '') {
  const result = []
  for (const e of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + e.name
    if (e.isSymbolicLink()) throw new Error('Symlink in prepared resources')
    if (e.isDirectory()) result.push(...await files(path.join(directory, e.name), relative + '/'))
    else if (e.isFile()) result.push(relative)
  }
  return result
}
async function pruneRuntime(directory) {
  for (const e of await readdir(directory, { withFileTypes: true })) {
    const destination = path.join(directory, e.name)
    if (e.isSymbolicLink()) throw new Error('Symlink in runtime dependencies')
    if ((e.isDirectory() && ['test', 'tests', '__tests__', 'coverage', '.cache', '.github'].includes(e.name)) || (e.isFile() && (/\.(map|tsbuildinfo)$/.test(e.name) || e.name === '.gitkeep'))) {
      await rm(destination, { recursive: e.isDirectory(), force: true })
    } else if (e.isDirectory()) await pruneRuntime(destination)
  }
}
async function retainLicenses(from, destination, checksums) {
  const names = (await readdir(from, { withFileTypes: true })).filter(e => e.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE)(?:$|[._-])/i.test(e.name)).map(e => e.name)
  if (!names.length) throw new Error('Missing original third-party license files: ' + path.basename(from))
  await mkdir(destination, { recursive: true })
  for (const name of names) {
    if (checksums && checksums[name] !== await hash(path.join(from, name))) throw new Error('Third-party license cache differs from locked source')
    await cp(path.join(from, name), path.join(destination, name))
  }
  return names
}
async function retainApplicationLicenses(licenses) {
  const npmLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8')), npmIndex = []
  for (const [relative, locked] of Object.entries(npmLock.packages)) {
    if (!relative || locked.dev) continue
    if (!relative.startsWith('node_modules/') || relative.split('/').includes('..')) throw new Error('Unexpected production dependency path')
    const installed = path.join(root, relative), metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'))
    if (metadata.version !== locked.version) throw new Error('Installed UI runtime version differs from lock')
    const licenseFiles = await retainLicenses(installed, path.join(licenses, 'application-npm', metadata.name.replaceAll('/', '__') + '-' + metadata.version))
    npmIndex.push({ name: metadata.name, version: metadata.version, license: metadata.license, licenseFiles, source: locked.resolved, integrity: locked.integrity })
  }
  await writeFile(path.join(licenses, 'application-npm-dependencies.json'), JSON.stringify(npmIndex, null, 2) + '\n')
  const cargoLock = await readFile(path.join(root, 'Cargo.lock'), 'utf8'), cargoIndex = []
  const crates = path.join(downloads, 'rust')
  await mkdir(crates, { recursive: true })
  for (const section of cargoLock.split('[[package]]').slice(1)) {
    if (!/^source = "registry\+/m.test(section)) continue
    const name = /^name = "([A-Za-z0-9_-]+)"/m.exec(section)?.[1], version = /^version = "([A-Za-z0-9.+_-]+)"/m.exec(section)?.[1], checksum = /^checksum = "([a-f0-9]{64})"/m.exec(section)?.[1]
    if (!name || !version || !checksum) throw new Error('Invalid locked Rust dependency')
    const archive = path.join(crates, `${name}-${version}.crate`)
    if (await hash(archive).catch(() => '') !== checksum) {
      const response = await fetch(`https://static.crates.io/crates/${name}/${name}-${version}.crate`, { redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { 'Accept-Encoding': 'identity' } })
      if (response.status !== 200 || !response.body) throw new Error('Locked Rust source unavailable: ' + name)
      const temporary = archive + '.partial', handle = await open(temporary, 'w')
      let length = 0
      try {
        for await (const bytes of response.body) { length += bytes.length; if (length > 16 * 1048576) throw new Error('Rust source exceeds size limit'); await handle.writeFile(bytes) }
      } finally { await handle.close() }
      if (!length || await hash(temporary) !== checksum) { await rm(temporary, { force: true }); throw new Error('Rust source checksum differs from Cargo.lock: ' + name) }
      await rename(temporary, archive)
    }
    const entryNames = (await run('tar.exe', ['-tf', archive])).split(/\r?\n/)
    const selected = entryNames.filter(item => item.startsWith(`${name}-${version}/`) && item.split('/').length === 2 && /^(LICENSE|LICENCE|COPYING|NOTICE)(?:$|[._-])/i.test(item.split('/')[1]))
    if (!selected.length) throw new Error('Rust source lacks expected license files: ' + name)
    const source = path.join(work, 'rust', `${name}-${version}`)
    await mkdir(path.dirname(source), { recursive: true })
    await run('tar.exe', ['-xf', archive, '-C', path.dirname(source), ...selected])
    const licenseFiles = await retainLicenses(source, path.join(licenses, 'application-rust', `${name}-${version}`))
    cargoIndex.push({ name, version, checksum, licenseFiles, source: `https://crates.io/crates/${name}/${version}` })
  }
  await writeFile(path.join(licenses, 'application-rust-dependencies.json'), JSON.stringify(cargoIndex, null, 2) + '\n')
}
await mkdir(downloads, { recursive: true })
for (const asset of lock.assets) {
  if (!/^[a-zA-Z0-9.-]+$/.test(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 256 * 1048576) throw new Error('Invalid locked asset')
  const destination = path.join(downloads, asset.name)
  if (!await valid(destination, asset)) await download(asset, destination)
  console.log(`Verified ${asset.name}: ${asset.sha256}`)
}
await reset(work)
await reset(output)
const ffmpeg = await extract('ffmpeg.zip', path.join(work, 'ffmpeg'), 'ffmpeg-n8.1.3-23-g5c4f5744cd-win64-lgpl-shared-8.1')
const ffmpegSource = await extract('ffmpeg-source.tar.gz', path.join(work, 'ffmpeg-source'), 'FFmpeg-5c4f5744cd60943125a78db692b728210102f255')
const provider = await extract('provider-source.tar.gz', path.join(work, 'provider'), 'bgutil-ytdlp-pot-provider-2.0.2')
const ytSource = await extract('yt-dlp-source.tar.gz', path.join(work, 'ytdlp-source'), 'yt-dlp')
await mkdir(path.join(output, 'ffmpeg'))
for (const e of await readdir(path.join(ffmpeg, 'bin'))) {
  if (/^(?:ffmpeg|ffprobe)\.exe$|^[A-Za-z0-9_-]+\.dll$/.test(e)) await cp(path.join(ffmpeg, 'bin', e), path.join(output, 'ffmpeg', e))
}
await cp(path.join(downloads, 'yt-dlp.exe'), path.join(output, 'yt-dlp.exe'))
const ffmpegVersion = await run(path.join(output, 'ffmpeg', 'ffmpeg.exe'), ['-version'])
const ffmpegLicense = await run(path.join(output, 'ffmpeg', 'ffmpeg.exe'), ['-L'])
const ffprobeVersion = await run(path.join(output, 'ffmpeg', 'ffprobe.exe'), ['-version'])
if (!ffmpegVersion.startsWith(`ffmpeg version ${lock.ffmpegVersion}`) || !ffprobeVersion.startsWith(`ffprobe version ${lock.ffmpegVersion}`)
  || /--enable-(gpl|nonfree)(?:\s|$)/.test(ffmpegVersion) || !/--enable-shared/.test(ffmpegVersion)
  || !/Lesser General Public License/.test(ffmpegLicense)) throw new Error('FFmpeg is not the locked LGPL shared build')
if (await run(path.join(output, 'yt-dlp.exe'), ['--ignore-config', '--no-cache-dir', '--version']) !== lock.ytdlpVersion) throw new Error('Unexpected yt-dlp version')
const server = path.join(provider, 'server')
const dependencyPatch = JSON.parse(await readFile(path.join(root, 'packaging', 'provider-dependency-patches.json'), 'utf8'))
if (dependencyPatch.schema !== 1 || dependencyPatch.providerVersion !== lock.providerVersion) throw new Error('Invalid provider dependency patch')
const providerPackage = JSON.parse(await readFile(path.join(server, 'package.json'), 'utf8'))
providerPackage.overrides = { ...providerPackage.overrides, ...dependencyPatch.overrides }
for (const name of dependencyPatch.removedDependencies) delete providerPackage.dependencies[name]
for (const name of dependencyPatch.removedAllowScripts) delete providerPackage.allowScripts[name]
await writeFile(path.join(server, 'package.json'), JSON.stringify(providerPackage, null, 2) + '\n')
await cp(path.join(root, 'packaging', 'provider-package-lock.json'), path.join(server, 'package-lock.json'))
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmEnvironment = { ...process.env, npm_config_cache: path.join(staging, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false' }
// The checked-in patched lock fixes every registry tarball and integrity. Do not run install scripts.
await run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], server, npmEnvironment)
await assertProviderDependencies(path.join(server, 'node_modules'))
await run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(server, 'tsconfig.json'), '--noCheck', '--incremental', 'false', '--sourceMap', 'false'])
const providerOut = path.join(output, 'provider')
await mkdir(path.join(providerOut, 'plugin'), { recursive: true })
await cp(path.join(downloads, 'provider-plugin.zip'), path.join(providerOut, 'plugin', 'bgutil-ytdlp-pot-provider.zip'))
await mkdir(path.join(providerOut, 'server'), { recursive: true })
for (const name of ['build', 'node_modules', 'package.json', 'package-lock.json']) await cp(path.join(server, name), path.join(providerOut, 'server', name), { recursive: true })
// Executable links are not needed by the provider's script-mode runtime.
await rm(path.join(providerOut, 'server', 'node_modules', '.bin'), { recursive: true, force: true })
await pruneRuntime(path.join(providerOut, 'server'))
await assertProviderDependencies(path.join(providerOut, 'server', 'node_modules'))
const licenses = path.join(output, 'licenses')
await mkdir(path.join(licenses, 'sources'), { recursive: true })
for (const name of ['ffmpeg-source.tar.gz', 'ffmpeg-build-recipes.tar.gz', 'provider-source.tar.gz', 'yt-dlp-source.tar.gz']) await cp(path.join(downloads, name), path.join(licenses, 'sources', name))
await cp(path.join(ffmpeg, 'LICENSE.txt'), path.join(licenses, 'FFmpeg-LGPLv3.txt'))
for (const [from, to] of [['COPYING.GPLv3', 'GPLv3.txt'], ['COPYING.LGPLv2.1', 'LGPLv2.1.txt']]) await cp(path.join(ffmpegSource, from), path.join(licenses, to))
await cp(path.join(provider, 'LICENSE'), path.join(licenses, 'provider-GPLv3.txt'))
await cp(path.join(ytSource, 'LICENSE'), path.join(licenses, 'yt-dlp-LICENSE.txt'))
await cp(path.join(root, 'LICENSE'), path.join(licenses, 'Fy1Sync-LICENSE.txt'))
await cp(path.join(root, 'packaging', 'THIRD-PARTY-NOTICES.md'), path.join(licenses, 'THIRD-PARTY-NOTICES.md'))
await cp(path.join(root, 'packaging', 'tools-lock.json'), path.join(output, 'tools-lock.json'))
await cp(path.join(root, 'packaging', 'provider-dependency-patches.json'), path.join(licenses, 'provider-dependency-patches.json'))
await retainApplicationLicenses(licenses)
await writeFile(path.join(licenses, 'FFmpeg-build.txt'), ffmpegVersion + '\n\n' + ffprobeVersion + '\n\n' + ffmpegLicense + '\n')
const dependencyLock = JSON.parse(await readFile(path.join(server, 'package-lock.json'), 'utf8'))
const dependencies = []
for (const [name, value] of Object.entries(dependencyLock.packages)) {
  if (!name || value.dev) continue
  dependencies.push({ package: name.replace(/^node_modules\//, ''), version: value.version, license: value.license ?? 'See package license', source: value.resolved, integrity: value.integrity })
}
await writeFile(path.join(licenses, 'provider-dependencies.json'), JSON.stringify(dependencies, null, 2) + '\n')
const inventory = await files(output)
await writeFile(path.join(output, 'inventory.json'), JSON.stringify(await Promise.all(inventory.map(async name => ({ file: name, size: (await stat(path.join(output, name))).size, sha256: await hash(path.join(output, name)) }))), null, 2) + '\n')
console.log(`Prepared ${inventory.length} verified runtime/license files under .packaging/tools. No network is needed at app startup.`)
