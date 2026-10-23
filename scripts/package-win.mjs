import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const env = { ...process.env,
  ELECTRON_BUILDER_CACHE: path.join(root, '.packaging', 'builder-cache'),
  ELECTRON_CACHE: path.join(root, '.packaging', 'electron-cache'),
  npm_config_cache: path.join(root, '.packaging', 'npm-cache'),
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
}
await mkdir(path.join(root, '.packaging'), { recursive: true })
function run(file, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: root, env, shell: false, windowsHide: true, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Local packaging step failed, exit ${code}`)))
  })
}
await run(path.join(root, 'scripts', 'prepare-tools.mjs'))
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
await run(npmCli, ['run', 'build'])
await run(path.join(root, 'scripts', 'prepare-package.mjs'))
await run(path.join(root, 'scripts', 'package-builder.cjs'), ['--config', 'electron-builder.config.cjs', '--win', '--x64', '--publish', 'never'])
