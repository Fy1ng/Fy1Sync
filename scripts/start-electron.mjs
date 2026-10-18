import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const root = new URL('../', import.meta.url)
// Keep lazy Electron downloads inside the project, including restrictive environments.
const cache = fileURLToPath(new URL('.runtime-cache/electron', root))
mkdirSync(cache, { recursive: true })
process.env.electron_config_cache ??= cache
const require = createRequire(import.meta.url)
export function launchElectron(extraEnv = {}) {
  const electron = require('electron')
  const env = { ...process.env, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  return spawn(electron, [fileURLToPath(new URL('dist/electron/main.cjs', root))], { cwd: fileURLToPath(root), env, stdio: 'inherit', windowsHide: true })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = launchElectron()
  child.once('error', () => { console.error('无法启动 Electron'); process.exitCode = 1 })
  child.once('exit', (code) => { process.exitCode = code ?? 1 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill())
}
