import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const require = createRequire(import.meta.url)
const { listPackage } = require('@electron/asar')
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
for (const name of asar) {
  if (!/^(?:package\.json|electron(?:\/(?:main|preload)\.cjs)?|client(?:\/assets)?|client\/index\.html|client\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|wasm))$/.test(name)) throw new Error('Unexpected ASAR entry: ' + name)
}
const actual = await walk(path.join(resources, 'tools'))
const inventory = JSON.parse(await readFile(path.join(resources, 'tools', 'inventory.json'), 'utf8'))
const expected = new Set(inventory.map(e => e.file)); expected.add('inventory.json')
if (actual.length !== expected.size || actual.some(name => !expected.has(name))) throw new Error('Tool resource inventory differs from packaged files')
for (const entry of inventory) {
  if (typeof entry.file !== 'string' || entry.file.includes('\\') || entry.file.startsWith('/') || entry.file.split('/').includes('..')) throw new Error('Invalid inventory entry')
  const file = path.join(resources, 'tools', entry.file)
  if ((await stat(file)).size !== entry.size || await hash(file) !== entry.sha256) throw new Error('Packaged tool hash mismatch: ' + entry.file)
}
const releaseFiles = (await readdir(path.join(root, '.release'))).filter(name => name.startsWith(`Stream-Syncer-${version}-`) && /\.(zip|exe)$/.test(name))
if (!releaseFiles.some(name => name.endsWith('.zip')) || !releaseFiles.some(name => name.endsWith('.exe'))) throw new Error('Both ZIP and NSIS artifacts are required')
const artifacts = []
for (const name of releaseFiles) {
  const file = path.join(root, '.release', name)
  artifacts.push({ file, size: (await stat(file)).size, sha256: await hash(file) })
  if (name.endsWith('.zip')) {
    const entries = await new Promise((resolve, reject) => {
      let output = ''; const child = spawn('tar.exe', ['-tf', file], { shell: false, windowsHide: true })
      child.stdout.on('data', chunk => { output += chunk })
      child.once('error', reject); child.once('close', code => code === 0 ? resolve(output.split(/\r?\n/).filter(Boolean)) : reject(new Error('Cannot inspect ZIP')))
    })
    if (entries.some(entry => forbiddenPath(entry) || entry.split('/').includes('..') || entry.startsWith('/'))) throw new Error('Forbidden path in ZIP')
    const unpacked = new Set(await walk(directory))
    const zipped = new Set(entries.filter(entry => !entry.endsWith('/')))
    if (zipped.size !== unpacked.size || [...zipped].some(entry => !unpacked.has(entry))) throw new Error('ZIP file list differs from verified unpacked release')
  }
}
const report = { asarEntries: asar, toolFiles: actual.length, artifacts, status: 'local-evaluation-only', licenseGap: 'Exact native dependency license/source mapping remains incomplete; see bundled THIRD-PARTY-NOTICES.md' }
await writeFile(path.join(evidence, 'package-report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
