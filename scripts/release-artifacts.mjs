import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const directory = path.resolve(process.argv[2] ?? path.join(root, '.release'))
const expected = [`Fy1Sync-${version}-win-x64-nsis.exe`, `Fy1Sync-${version}-win-x64-portable.zip`,
  ...['x64', 'arm64'].flatMap(arch => ['dmg', 'zip'].map(ext => `Fy1Sync-${version}-mac-${arch}.${ext}`)),
  ...['x64', 'arm64'].flatMap(arch => ['deb', 'AppImage', 'tar.gz'].map(ext => `Fy1Sync-${version}-linux-${arch}.${ext}`))].sort()
const actual = (await readdir(directory)).filter(name => name !== 'SHA256SUMS.txt').sort()
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('发布产物必须完整且仅包含当前版本的 12 个安装/便携包')
const lines = []
for (const name of expected) {
  const file = path.join(directory, name), info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('发布产物不是有效的普通文件: ' + name)
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  lines.push(hash.digest('hex') + '  ' + name)
}
await writeFile(path.join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n')
console.log(`已校验 ${expected.length} 个 ${version} 产物并生成 SHA256SUMS.txt`)
