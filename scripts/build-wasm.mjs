import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const version = '0.2.105'
const tool = fileURLToPath(new URL('../.tools/wasm-bindgen/bin/wasm-bindgen' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url))
function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', shell: false, windowsHide: true })
    let output = ''
    if (capture) child.stdout.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve(output.trim()) : reject(new Error(command + ' failed: ' + (signal ?? code))))
  })
}
let pending
export function buildWasm() {
  return pending ??= (async () => {
    try { await access(tool) } catch {
      await run('cargo', ['install', '--root', '.tools/wasm-bindgen', 'wasm-bindgen-cli', '--version', '=' + version, '--locked'])
    }
    const actualVersion = await run(tool, ['--version'], true)
    if (actualVersion !== 'wasm-bindgen ' + version) throw new Error('Expected wasm-bindgen ' + version + ', got ' + actualVersion)
    await run('cargo', ['build', '-p', 'stream-syncer-wasm', '--target', 'wasm32-unknown-unknown', '--release', '--locked'])
    await run(tool, ['--target', 'web', '--out-dir', 'src/wasm/pkg', '--out-name', 'stream_syncer_wasm', 'target/wasm32-unknown-unknown/release/stream_syncer_wasm.wasm'])
  })()
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildWasm()
