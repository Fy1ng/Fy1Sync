import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmCliPath, packagingTarget, prepareBuilderCache } from './packaging-platform.mjs'
import { elfArchitecture } from './build-ffmpeg-linux.mjs'
import { prepareElectron } from './prepare-electron.mjs'

const root = fileURLToPath(new URL('../', import.meta.url)), target = packagingTarget()
if (target.platform !== 'linux' || process.argv.length !== 2) throw new Error('Linux 打包必须在目标架构的原生 Linux 主机上执行, 不接受交叉构建参数')
await prepareElectron()
if (elfArchitecture(await readFile(path.join(root, 'node_modules', 'electron', 'dist', 'electron'))) !== target.arch) throw new Error('Electron 与当前 Node 架构不一致, 请重新运行 npm ci')
const env = { ...process.env, ELECTRON_BUILDER_CACHE: path.join(root, '.packaging', 'builder-cache'),
  ELECTRON_CACHE: path.join(root, '.packaging', 'electron-cache'), npm_config_cache: path.join(root, '.packaging', 'npm-cache') }
await mkdir(path.join(root, '.packaging'), { recursive: true })
await prepareBuilderCache(env.ELECTRON_BUILDER_CACHE)
function run(file, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: root, env, shell: false, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Linux 打包步骤失败, exit ' + code)))
  })
}
await run(path.join(root, 'scripts', 'prepare-tools.mjs'))
await run(path.join(root, 'scripts', 'prepare-team-logos.mjs'))
await run(npmCliPath(), ['run', 'build'])
await run(path.join(root, 'scripts', 'prepare-package.mjs'))
await run(path.join(root, 'node_modules', 'electron-builder', 'cli.js'), ['--config', 'electron-builder.config.cjs', '--linux', '--' + target.arch, '--publish', 'never'])
await run(path.join(root, 'scripts', 'check-package-linux.mjs'))
