import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprintRelease, verifyPackageArchive } from './package-archive.mjs'
const require = createRequire(import.meta.url)
const { extractFile, listPackage, statFile } = require('@electron/asar')
const root = fileURLToPath(new URL('../', import.meta.url))
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const evidence = path.resolve(root, process.env.STREAM_SYNC_PACKAGE_EVIDENCE ?? '.runtime-cache/p7-20261023')
if (!evidence.startsWith(path.join(root, '.runtime-cache') + path.sep)) throw new Error('Package evidence must be under the local runtime cache')
await mkdir(evidence, { recursive: true })
const directory = path.join(root, '.release', 'win-unpacked')
const resources = path.join(directory, 'resources')
const forbidden = /(?:^|\/)(?:test-sources|cookies|browser-profile|\.runtime-cache|\.tools|\.git|\.env[^/]*)(?:\/|$)/i
function forbiddenPath(name) {
  // This is locked undici implementation code, not browser/account cookie data.
  if (/^(?:resources\/tools\/)?provider\/server\/node_modules\/undici\/lib\/web\/cookies(?:\/|$)/.test(name)) return false
  return forbidden.test(name)
}
async function hash(file) { const h = createHash('sha256'); for await (const bytes of createReadStream(file)) h.update(bytes); return h.digest('hex') }
async function walk(dir, prefix = '') {
  const result = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw new Error('Symlink in release')
    const relative = prefix + e.name
    if (forbiddenPath(relative)) throw new Error('Forbidden release path: ' + relative)
    if (e.isDirectory()) result.push(...await walk(path.join(dir, e.name), relative + '/'))
    else result.push(relative)
  }
  return result
}
const asar = listPackage(path.join(resources, 'app.asar')).map(name => name.replaceAll('\\', '/').replace(/^\//, ''))
const applicationMetadata = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json').toString('utf8'))
if (applicationMetadata.name !== 'fy1sync' || applicationMetadata.version !== version) throw new Error('Unexpected Fy1Sync application metadata')
if (!(await stat(path.join(directory, 'Fy1Sync.exe'))).isFile()) throw new Error('Fy1Sync executable is missing')
for (const name of asar) {
  if (!/^(?:package\.json|electron(?:\/(?:main|preload|network-runtime)\.cjs)?|client(?:\/assets)?|client\/index\.html|client\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|wasm|woff2))$/.test(name)) throw new Error('Unexpected ASAR entry: ' + name)
}
const networkEntry = statFile(path.join(resources, 'app.asar'), 'electron/network-runtime.cjs')
const networkRuntime = await lstat(path.join(resources, 'app.asar.unpacked', 'electron', 'network-runtime.cjs'))
if (!networkEntry.unpacked || !networkRuntime.isFile() || networkRuntime.isSymbolicLink() || !networkRuntime.size || networkRuntime.size !== networkEntry.size) throw new Error('The physical network runtime is missing or differs from its ASAR entry')
const actual = await walk(path.join(resources, 'tools'))
const inventory = JSON.parse(await readFile(path.join(resources, 'tools', 'inventory.json'), 'utf8'))
const expected = new Set(inventory.map(e => e.file)); expected.add('inventory.json')
if (actual.length !== expected.size || actual.some(name => !expected.has(name))) throw new Error('Tool resource inventory differs from packaged files')
for (const entry of inventory) {
  if (typeof entry.file !== 'string' || entry.file.includes('\\') || entry.file.startsWith('/') || entry.file.split('/').includes('..')) throw new Error('Invalid inventory entry')
  const file = path.join(resources, 'tools', entry.file)
  if ((await stat(file)).size !== entry.size || await hash(file) !== entry.sha256) throw new Error('Packaged tool hash mismatch: ' + entry.file)
}
const releaseFiles = (await readdir(path.join(root, '.release'))).filter(name => name.startsWith(`Fy1Sync-${version}-`) && /\.(zip|exe)$/.test(name))
const expectedArtifacts = new Set([`Fy1Sync-${version}-win-x64-portable.zip`, `Fy1Sync-${version}-win-x64-nsis.exe`])
if (releaseFiles.length !== expectedArtifacts.size || releaseFiles.some(name => !expectedArtifacts.has(name))) throw new Error('The named Fy1Sync ZIP and NSIS artifacts are required')
const artifacts = []
const unpacked = await fingerprintRelease(directory, { forbiddenPath })
for (const name of releaseFiles) {
  const file = path.join(root, '.release', name)
  const artifact = { file, size: (await stat(file)).size, sha256: await hash(file) }
  artifacts.push(artifact)
  if (name.endsWith('.zip')) {
    artifact.contents = await verifyPackageArchive(file, unpacked, { forbiddenPath })
  }
}
const report = { asarEntries: asar, toolFiles: actual.length, artifacts, status: 'local-evaluation-only', licenseGap: 'Exact native dependency license/source mapping remains incomplete; see bundled THIRD-PARTY-NOTICES.md' }
await writeFile(path.join(evidence, 'package-report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
