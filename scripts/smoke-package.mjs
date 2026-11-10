import { _electron } from '@playwright/test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packagingTarget } from './packaging-platform.mjs'

const root = fileURLToPath(new URL('../', import.meta.url)), target = packagingTarget()
await mkdir(path.join(root, '.runtime-cache'), { recursive: true })
const temporary = await mkdtemp(path.join(root, '.runtime-cache', 'package-smoke-'))
const executablePath = target.platform === 'win32' ? path.join(root, '.release', 'win-unpacked', 'Fy1Sync.exe')
  : target.platform === 'darwin' ? path.join(root, '.release', target.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Fy1Sync.app', 'Contents', 'MacOS', 'Fy1Sync')
    : path.join(root, '.release', target.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'fy1sync')
const { ELECTRON_RUN_AS_NODE: ignored, ...inherited } = process.env
const application = await _electron.launch({ executablePath, args: ['--mute-audio'], cwd: root, timeout: 60_000,
  env: { ...inherited, STREAM_SYNC_E2E: '1', STREAM_SYNC_E2E_VISIBLE: '0', STREAM_SYNC_OFFLINE_E2E: '1',
    STREAM_SYNC_USER_DATA_DIR: path.join(temporary, 'userData'), STREAM_SYNC_DATA_DIR: path.join(temporary, 'data'),
    TEMP: temporary, TMP: temporary, TMPDIR: temporary } })
try {
  const page = await application.firstWindow({ timeout: 60_000 })
  await page.waitForURL('app://app/**', { timeout: 60_000 })
  await page.waitForFunction(() => typeof window.streamSyncer?.invoke === 'function')
  await page.locator('.titlebar-name').filter({ hasText: 'Fy1Sync' }).waitFor({ timeout: 30_000 })
  await page.locator('.intake-title').filter({ hasText: '添加直播间' }).waitFor({ timeout: 30_000 })
  const actual = await application.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, data: app.getPath('userData') }))
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (!actual.packaged || actual.version !== version || path.resolve(actual.data) !== path.join(temporary, 'userData')) throw new Error('打包应用的版本或测试数据隔离不正确')
  const report = { target: target.target, version, packaged: true, startup: 'passed', ui: 'passed', isolatedData: true }
  const evidence = path.resolve(root, process.env.STREAM_SYNC_PACKAGE_EVIDENCE ?? temporary)
  if (!evidence.startsWith(path.join(root, '.runtime-cache') + path.sep)) throw new Error('Package evidence must stay under .runtime-cache')
  await mkdir(evidence, { recursive: true })
  await writeFile(path.join(evidence, `smoke-${target.target}.json`), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await application.close() }
