import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packagingTarget } from './packaging-platform.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const target = packagingTarget()
const preparedLock = JSON.parse(await readFile(path.join(root, '.packaging', 'tools', 'tools-lock.json'), 'utf8'))
if (preparedLock.target !== target.target) throw new Error('预备工具与当前打包平台/架构不一致, 请重新运行 tools:prepare')
const destination = path.join(root, '.packaging', 'app')
if (path.dirname(destination) !== path.join(root, '.packaging')) throw new Error('Invalid staging destination')
await rm(destination, { recursive: true, force: true })
await mkdir(path.join(destination, 'electron'), { recursive: true })
await mkdir(path.join(destination, 'client', 'assets'), { recursive: true })
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
await writeFile(path.join(destination, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, description: pkg.description, license: pkg.license,
  main: 'electron/main.cjs',
}, null, 2) + '\n')
for (const name of ['main.cjs', 'preload.cjs', 'login-card-preload.cjs', 'network-runtime.cjs', 'icon.png']) await cp(path.join(root, 'dist', 'electron', name), path.join(destination, 'electron', name))
await cp(path.join(root, 'dist', 'client', 'index.html'), path.join(destination, 'client', 'index.html'))
const assets = path.join(root, 'dist', 'client', 'assets')
for (const entry of await readdir(assets, { withFileTypes: true })) {
  if (!entry.isFile() || !/^[A-Za-z0-9_.-]+\.(js|css|wasm|woff2)$/.test(entry.name)) continue
  await cp(path.join(assets, entry.name), path.join(destination, 'client', 'assets', entry.name))
}
const toolInventory = JSON.parse(await readFile(path.join(root, '.packaging', 'tools', 'inventory.json'), 'utf8'))
if (target.platform === 'win32') {
const longestRelative = Math.max(...toolInventory.map(entry => ('resources/tools/' + entry.file).length), 'resources/tools/inventory.json'.length)
// The legacy NSIS filesystem implementation cannot reliably uninstall > MAX_PATH files.
// Keep every installed resource path at <=248 UTF-16 units, with room for Windows suffixes.
const maximumDirectoryLength = 248 - 1 - longestRelative
if (maximumDirectoryLength < 40) throw new Error('Packaged resource paths are too deep for safe NSIS installation')
await writeFile(path.join(root, '.packaging', 'install-path-limit.nsh'), `!define STREAM_SYNC_MAX_INSTALL_DIR ${maximumDirectoryLength}\n`)
await writeFile(path.join(root, '.packaging', 'install-path-limit.json'), JSON.stringify({ longestRelative, maximumDirectoryLength, maximumInstalledPath: 248 }, null, 2) + '\n')
}
console.log('Prepared minimal release app: .packaging/app (no fixtures, source maps, cookies or profiles).')
