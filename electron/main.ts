import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync, watchFile, unwatchFile } from 'node:fs'
import { createDesktopService } from '../server/api'
import { resolveConfig } from '../server/config'
import { DanmakuRelay } from '../server/danmaku/relay'
import { MediaRegistry } from '../server/mediaProxy'
import { serveStatic, missingClientResponse } from '../server/static'
import { APP_URL, CONTENT_SECURITY_POLICY, isAppDocument, isAppOrigin } from './security'
import { installIpcHandlers } from './ipc'

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true,
} }])
app.setName('Stream Syncer')
if (process.env.STREAM_SYNC_USER_DATA_DIR) {
  const path = resolve(process.env.STREAM_SYNC_USER_DATA_DIR)
  mkdirSync(path, { recursive: true })
  app.setPath('userData', path)
  app.setPath('sessionData', path)
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
let window: BrowserWindow | null = null
let dispose: (() => void) | undefined

async function start(): Promise<void> {
  const clientDir = resolve(__dirname, '../client')
  const config = resolveConfig(process.env, resolve(__dirname, '../..'))
  // Desktop callers cannot opt out of private-address or port validation.
  const proxy = { ...config.proxy, allowNonLoopbackTargets: false, allowNonStandardPorts: false }
  const media = new MediaRegistry({ config: proxy })
  const e2e = process.env.STREAM_SYNC_E2E === '1'
  // Offline E2E drives events through the real IPC subscriptions, without a live room.
  const relay = e2e ? new DanmakuRelay({ createSocket: () => ({ send() {}, close() {}, addEventListener() {} }) }) : new DanmakuRelay()
  const service = createDesktopService({
    dataDir: process.env.STREAM_SYNC_DATA_DIR || app.getPath('userData'), proxy, relay, registerMedia: media.register,
  })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  protocol.handle('app', async (request) => {
    try {
      if (!isAppOrigin(request.url)) return new Response(null, { status: 403 })
      const url = new URL(request.url)
      let response: Response | null
      if (url.pathname.startsWith('/media/')) response = await media.handle(request)
      else response = await serveStatic(request, { root: clientDir })
      if (!response) response = url.pathname === '/' ? missingClientResponse(clientDir) : new Response(null, { status: 404 })
      response.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
      response.headers.set('X-Content-Type-Options', 'nosniff')
      return response
    } catch { return new Response('资源读取失败', { status: 500 }) }
  })
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 800, minHeight: 600,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
    },
  })
  const contents = window.webContents
  const handlers = installIpcHandlers(ipcMain, contents, service)
  if (e2e) Object.assign(globalThis, { __streamSyncerTest: { emitDanmaku: handlers.emitDanmaku } })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => { if (!isAppDocument(url)) event.preventDefault() })
  contents.on('will-redirect', (event, url) => { if (!isAppDocument(url)) event.preventDefault() })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('render-process-gone', (_event, details) => {
    console.error(`Renderer exited: ${details.reason}, exitCode ${details.exitCode}`)
  })
  const index = join(clientDir, 'index.html')
  if (process.env.STREAM_SYNC_DEV === '1') {
    watchFile(index, { interval: 500 }, () => { if (!contents.isDestroyed()) contents.reload() })
  }
  dispose = () => {
    unwatchFile(index)
    handlers.dispose()
    service.dispose()
    media.clear()
    protocol.unhandle('app')
    delete (globalThis as { __streamSyncerTest?: unknown }).__streamSyncerTest
    dispose = undefined
  }
  window.on('closed', () => { window = null; dispose?.() })
  await window.loadURL(APP_URL)
}
app.whenReady().then(start).catch(() => { console.error('应用启动失败, 请检查构建产物和数据目录'); app.exit(1) })
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => dispose?.())
