import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ClockSearchAuthorStore } from './authorStore'

function argument(name: string): string | undefined {
  const marker = '--' + name + '='
  return process.argv.find(value => value.startsWith(marker))?.slice(marker.length)
}
function contained(parent: string, target: string): boolean {
  const distance = relative(resolve(parent), resolve(target))
  return distance !== '' && distance !== '..' && !distance.startsWith('..' + sep) && !isAbsolute(distance)
}

const rootArg = argument('project-root')
const profileArg = argument('profile-dir')
if (!rootArg || !profileArg || app.isPackaged) throw new Error('请使用项目中的 configure:clock-search 制作命令启动')
const projectRoot = resolve(rootArg)
const profileDir = resolve(profileArg)
if (!contained(tmpdir(), profileDir) && !contained(join(projectRoot, 'e2e', '.data'), profileDir)) {
  throw new Error('制作工具只允许使用独立临时资料目录')
}
const packageInfo = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { name?: string }
if (packageInfo.name !== 'fy1sync') throw new Error('项目目录不属于 Fy1Sync')
const frontend = join(projectRoot, '.runtime-cache', 'clock-search-authoring', 'client', 'index.html')
const documentUrl = pathToFileURL(frontend).href
const testOverride = process.env.STREAM_SYNC_E2E === '1' ? process.env.STREAM_SYNC_AUTHOR_CONFIG_PATH : undefined
const configPath = testOverride ? resolve(testOverride) : join(projectRoot, 'src', 'recognition', 'basicSearchRegion.json')
if (testOverride && !contained(tmpdir(), configPath) && !contained(join(projectRoot, 'e2e', '.data'), configPath)) {
  throw new Error('测试配置必须位于临时目录')
}
const store = new ClockSearchAuthorStore(configPath, process.argv.includes('--reset'))
app.setName('Fy1Sync Clock Search Author')
mkdirSync(profileDir, { recursive: true })
app.setPath('userData', profileDir)
app.setPath('sessionData', profileDir)
for (const [key, subdirectory] of [['logs', 'logs'], ['crashDumps', 'crash-dumps']] as const) {
  const target = join(profileDir, subdirectory)
  mkdirSync(target, { recursive: true })
  app.setPath(key, target)
}
let window: BrowserWindow | null = null
function trusted(event: IpcMainInvokeEvent): boolean {
  try {
    return !!window && !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === documentUrl
  } catch { return false }
}

void app.whenReady().then(async () => {
  const actualParent = await realpath(dirname(configPath))
  const actualRoot = await realpath(projectRoot)
  if (!testOverride && !contained(actualRoot, actualParent)) throw new Error('生产配置目录不能指向项目以外')
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
  window = new BrowserWindow({
    show: false, width: 1320, height: 940, minWidth: 760, minHeight: 620,
    autoHideMenuBar: true, title: 'Fy1Sync - 生产寻找区间设定',
    webPreferences: { preload: join(dirname(__filename), 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true },
  })
  window.setMenu(null)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== documentUrl) event.preventDefault() })
  window.webContents.on('will-redirect', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  ipcMain.handle('clock-search-author:get-state', async (event, args: unknown) => {
    if (!trusted(event)) throw new Error('仅允许制作工具的主窗口调用')
    if (args !== undefined) throw new Error('读取配置不接受额外参数')
    return store.getState()
  })
  ipcMain.handle('clock-search-author:save', async (event, roi: unknown) => {
    if (!trusted(event)) throw new Error('仅允许制作工具的主窗口调用')
    return store.save(roi)
  })
  window.once('ready-to-show', () => window?.show())
  window.on('closed', () => { window = null })
  await window.loadFile(frontend)
  window.show()
  window.focus()
}).catch(error => { console.error(error instanceof Error ? error.message : String(error)); app.exit(1) })
app.on('window-all-closed', () => app.quit())
