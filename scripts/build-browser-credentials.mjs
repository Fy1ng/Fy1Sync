import { spawn } from 'node:child_process'
import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
export async function buildBrowserCredentials() {
  if (process.platform !== 'win32') return
  const manifest = path.join(root, 'crates', 'browser-credentials', 'Cargo.toml')
  const target = path.join(root, '.runtime-cache', 'browser-credentials-build')
  await new Promise((resolve, reject) => {
    const child = spawn('cargo', ['build', '--manifest-path', manifest, '--locked', '--release', '--target-dir', target],
      { cwd: root, windowsHide: true, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('浏览器凭据助手构建失败.')))
  })
  const destination = path.join(root, 'dist', 'native')
  await mkdir(destination, { recursive: true })
  const file = path.join(destination, 'browser-credentials.exe')
  await cp(path.join(target, 'release', 'fy1sync-browser-credentials.exe'), file)
  const bytes = await readFile(file)
  const lock = await readFile(path.join(root, 'crates', 'browser-credentials', 'Cargo.lock'))
  await writeFile(path.join(destination, 'browser-credentials.json'), JSON.stringify({ protocolVersion: 1, version: '0.1.0',
    file: 'browser-credentials.exe', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceLockSha256: createHash('sha256').update(lock).digest('hex') }, null, 2) + '\n')
  const metadata = await new Promise((resolve, reject) => {
    const child = spawn('cargo', ['metadata', '--manifest-path', manifest, '--locked', '--format-version', '1'],
      { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []; child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.resume()
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : reject(new Error('Native dependency metadata failed')))
  })
  const licenses = []
  for (const dependency of metadata.packages.filter(pkg => pkg.source)) {
    const directory = path.dirname(dependency.manifest_path)
    const names = (await readdir(directory)).filter(name => /^(LICENSE|COPYING)(?:[.-].*)?$/i.test(name))
    if (!names.length) throw new Error(`Native dependency license missing: ${dependency.name}`)
    const prefix = path.join('licenses', `${dependency.name}-${dependency.version}`)
    await mkdir(path.join(destination, prefix), { recursive: true })
    for (const name of names) await cp(path.join(directory, name), path.join(destination, prefix, `${name}.txt`))
    licenses.push({ name: dependency.name, version: dependency.version, license: dependency.license,
      files: names.map(name => `${prefix.split(path.sep).join('/')}/${name}.txt`) })
  }
  await writeFile(path.join(destination, 'licenses', 'index.json'), JSON.stringify(licenses, null, 2) + '\n')
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildBrowserCredentials()
