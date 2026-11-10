import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeMacArch, npmCliPath, prepareBuilderCache } from './packaging-platform.mjs'
import { machoArchitectures } from './build-ffmpeg-mac.mjs'
import { prepareElectron } from './prepare-electron.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const target = nativeMacArch(process.argv.slice(2))
await prepareElectron()
const environment = { ...process.env,
  ELECTRON_BUILDER_CACHE: path.join(root, '.packaging', 'builder-cache'),
  ELECTRON_CACHE: path.join(root, '.packaging', 'electron-cache'),
  npm_config_cache: path.join(root, '.packaging', 'npm-cache'),
}
const electronMetadata = JSON.parse(await readFile(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'))
const { devDependencies } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
if (electronMetadata.version !== devDependencies.electron) throw new Error('Electron 版本与项目固定版本不一致, 请在 macOS 本机运行 npm ci')
if (!machoArchitectures(await readFile(path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'))).includes(target.arch)) throw new Error('Electron 二进制架构不一致, 请在目标 macOS 主机重新运行 npm ci')
await mkdir(path.join(root, '.packaging'), { recursive: true })
await prepareBuilderCache(environment.ELECTRON_BUILDER_CACHE)
function run(file, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: root, env: environment, shell: false, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`本地 macOS 打包步骤失败, exit ${code}`)))
  })
}
await run(path.join(root, 'scripts', 'prepare-tools.mjs'))
await run(path.join(root, 'scripts', 'prepare-team-logos.mjs'))
await run(npmCliPath(), ['run', 'build'])
await run(path.join(root, 'scripts', 'prepare-package.mjs'))
// The Windows NSIS adaptation is intentionally not loaded for macOS.
await run(path.join(root, 'node_modules', 'electron-builder', 'cli.js'), ['--config', 'electron-builder.config.cjs', '--mac', '--' + target.arch, '--publish', 'never'])
await run(path.join(root, 'scripts', 'check-package-mac.mjs'))
