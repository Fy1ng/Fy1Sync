import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Electron 44 separates its verified native binary download from npm installation. */
export async function prepareElectron() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'node_modules', 'electron', 'install.js')], {
      cwd: root, env: process.env, shell: false, windowsHide: true, stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Electron 原生二进制准备失败, exit ' + code)))
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareElectron()
