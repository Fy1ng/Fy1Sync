import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync, watchFile, unwatchFile } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createDouyuRoomResolver } from '../server/platforms/douyuRoom'
import { createDesktopService } from '../server/api'
import { resolveConfig } from '../server/config'
import { DanmakuRelay } from '../server/danmaku/relay'
import { MediaRegistry } from '../server/mediaProxy'
import { serveStatic, missingClientResponse } from '../server/static'
import { APP_URL, CONTENT_SECURITY_POLICY, isAppDocument, isAppOrigin } from './security'
import { installIpcHandlers } from './ipc'
import { BufferManager } from './bufferManager'
import { pullAdaptive, AdaptivePullError } from './adaptivePuller'
import { LoginManager } from './login'
import { Acquisition } from './acquisition'
import { YtDlpRunner, type YtDlpDiagnostic } from './ytdlp'
import { locateTool, type ToolSettings } from './toolLocator'
import { DecoderPreferences } from './decoderPreferences'
import { ManagedYtdlp } from './toolUpdater'
import { DesktopTools } from './toolsService'
import toolsLock from '../packaging/tools-lock.json'
import { NativePrivatePermissions, privateDirectory } from './privateStorage'
import { createHash } from 'node:crypto'

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
const decoderPreferences = new DecoderPreferences(app.getPath('userData'),
  app.commandLine.hasSwitch('disable-accelerated-video-decode'))
if (decoderPreferences.get().effectiveMode === 'software') {
  app.commandLine.appendSwitch('disable-accelerated-video-decode')
}
let window: BrowserWindow | null = null
let dispose: (() => Promise<void>) | undefined

async function start(): Promise<void> {
  const clientDir = resolve(__dirname, '../client')
  const config = resolveConfig(process.env, resolve(__dirname, '../..'))
  // Desktop callers cannot opt out of private-address or port validation.
  const proxy = { ...config.proxy, allowNonLoopbackTargets: false, allowNonStandardPorts: false }
  const media = new MediaRegistry({ config: proxy })
  const userDataDir = app.getPath('userData')
  const toolSettings: ToolSettings = await readFile(join(userDataDir, 'tools.json'), 'utf8')
    .then((text) => {
      const value = JSON.parse(text) as ToolSettings
      return { ffmpegPath: typeof value.ffmpegPath === 'string' ? value.ffmpegPath : undefined,
        ffprobePath: typeof value.ffprobePath === 'string' ? value.ffprobePath : undefined,
        ytdlpPath: typeof value.ytdlpPath === 'string' ? value.ytdlpPath : undefined }
    }).catch(() => ({}))
  const logins = new LoginManager(userDataDir)
  const e2e = process.env.STREAM_SYNC_E2E === '1'
  const offlineE2e = e2e && process.env.STREAM_SYNC_OFFLINE_E2E === '1'
  const nativeFetch = globalThis.fetch
  if (offlineE2e) {
    globalThis.fetch = async (input, init) => {
      if (/^https?:/i.test(input instanceof Request ? input.url : String(input))) throw new Error('默认离线测试禁止网络请求')
      return nativeFetch(input, init)
    }
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
  }
  let fixtureRequest: ((url: string) => Promise<Response>) | undefined
  const managedYtdlp = new ManagedYtdlp(userDataDir, { baselineVersion: app.isPackaged ? toolsLock.ytdlpVersion : undefined,
    transport: (url, init) => fixtureRequest ? fixtureRequest(url) : globalThis.fetch(url, init),
  })
  mkdirSync(userDataDir, { recursive: true })
  const providerCacheHome = privateDirectory(userDataDir, join(userDataDir, 'provider-cache'), new NativePrivatePermissions())
  const toolContext = {
    ...(app.isPackaged ? { bundledDir: join(process.resourcesPath, 'tools') } : {}),
    managedYtdlp: () => managedYtdlp.activePath(),
    providerCacheHome,
  }
  const tools = new DesktopTools(toolSettings, toolContext, managedYtdlp, process.env, !app.isPackaged)
  const youtubeDiagnostics: YtDlpDiagnostic[] = []
  const ytdlp = new YtDlpRunner({ electronPath: process.execPath, cookies: logins, settings: toolSettings, toolContext,
    diagnostic: e2e ? event => { youtubeDiagnostics.push(event); if (youtubeDiagnostics.length > 100) youtubeDiagnostics.shift() } : undefined,
  })
  const bufferDiagnostics: unknown[] = []
  const trackStats = () => ({ segments: 0, bytes: 0, firstSq: null as number | null, lastSq: null as number | null, gaps: 0, repeated: 0, maxHeadLag: 0 })
  const adaptiveStats = { rounds: 0, statuses: {} as Record<string, number>, httpErrors: 0, probes: 0, reconnects: 0, fallback: false,
    video: trackStats(), audio: trackStats() }
  const diagnoseBuffer = (event: unknown) => {
    bufferDiagnostics.push(event)
    if (bufferDiagnostics.length > 1000) bufferDiagnostics.shift()
    if (!event || typeof event !== 'object') return
    const entry = event as Record<string, unknown>
    if (entry.phase === 'http-response' && typeof entry.status === 'number') {
      const key = String(entry.status)
      adaptiveStats.statuses[key] = (adaptiveStats.statuses[key] ?? 0) + 1
    }
    if (entry.phase === 'http-error') adaptiveStats.httpErrors++
    if (entry.track === 'probe') adaptiveStats.probes++
    if (entry.state === 'reconnecting') adaptiveStats.reconnects++
    if (entry.notice) adaptiveStats.fallback = true
    if (entry.phase === 'written' && (entry.track === 'video' || entry.track === 'audio')
      && typeof entry.sq === 'number' && typeof entry.head === 'number' && typeof entry.bytes === 'number') {
      const track = adaptiveStats[entry.track]
      track.firstSq ??= entry.sq
      if (track.lastSq !== null) {
        if (entry.sq > track.lastSq + 1) track.gaps += entry.sq - track.lastSq - 1
        if (entry.sq <= track.lastSq) track.repeated++
      }
      track.lastSq = entry.sq
      track.segments++
      track.bytes += entry.bytes
      track.maxHeadLag = Math.max(track.maxHeadLag, entry.head - entry.sq)
    }
  }
  const buffer = new BufferManager({ userDataDir, ffmpegPath: () => locateTool('ffmpeg', toolSettings, process.env, toolContext),
    pullAdaptive: e2e ? async (source, options) => {
      adaptiveStats.rounds++
      try { return await pullAdaptive(source, { ...options,
        progress: diagnoseBuffer,
        fetchImpl: async (input, init) => {
          const started = Date.now()
          const sq = Number(new URL(input instanceof Request ? input.url : input).searchParams.get('sq'))
          try {
            const response = await fetch(input, init)
            const rawHead = response.headers.get('x-head-seqnum')
            diagnoseBuffer({ phase: 'http-response', sq, status: response.status,
              head: rawHead && /^\d+$/.test(rawHead) ? Number(rawHead) : null, elapsedMs: Date.now() - started })
            return response
          } catch (error) {
            const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined
            const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(cause.code) ? cause.code : 'request-failed'
            diagnoseBuffer({ phase: 'http-error', sq, code, elapsedMs: Date.now() - started })
            throw error
          }
        },
      }) }
      catch (error) {
        if (error instanceof AdaptivePullError) diagnoseBuffer({ code: error.code, status: error.status })
        throw error
      }
    } : undefined,
  })
  if (e2e) buffer.subscribe(diagnoseBuffer)
  // Default offline tests inject identity metadata only at this main-process boundary.
  // Packaged/production builds expose no mapping or arbitrary-page injection capability.
  let roomFixture: ((room: string) => string) | undefined
  const roomResolver = createDouyuRoomResolver(proxy, async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!app.isPackaged && offlineE2e && /^https:\/\/m\.douyu\.com\/[1-9][0-9]{0,11}$/.test(url)) {
      if (!roomFixture) throw new Error('Identity fixture has not been installed')
      return new Response(roomFixture(new URL(url).pathname.slice(1)))
    }
    return globalThis.fetch(input, init)
  }, offlineE2e ? async () => ['8.8.8.8'] : undefined)
  const acquisition = new Acquisition({ buffer, logins, runYtDlp: (url, adaptive) => ytdlp.resolve(url, adaptive), proxy, resolveDouyuRoom: roomResolver.resolve,
    ensureTools: async (platform) => {
      if (offlineE2e) throw new Error('默认离线测试禁止真实平台取流')
      await locateTool('ffmpeg', toolSettings, process.env, toolContext)
      await locateTool('ffprobe', toolSettings, process.env, toolContext)
      if (platform === 'youtube') await locateTool('yt-dlp', toolSettings, process.env, toolContext)
    },
  })
  // Offline E2E drives events through the real IPC subscriptions, without a live room.
  const relay = e2e ? new DanmakuRelay({ createSocket: () => ({ send() {}, close() {}, addEventListener() {} }) }) : new DanmakuRelay()
  const service = createDesktopService({
    dataDir: process.env.STREAM_SYNC_DATA_DIR || userDataDir, proxy, relay, resolveDouyuRoom: roomResolver.resolve, registerMedia: media.register, acquisition, decoderPreferences, tools,
  })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  protocol.handle('app', async (request) => {
    try {
      if (!isAppOrigin(request.url)) return new Response(null, { status: 403 })
      const url = new URL(request.url)
      let response: Response | null
      if (url.pathname.startsWith('/media/')) response = await media.handle(request)
      else if (url.pathname.startsWith('/buffer/')) response = await buffer.handle(request)
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
  if (e2e) Object.assign(globalThis, { __streamSyncerTest: {
    ...(!app.isPackaged ? { setDouyuRoomFixture(mapping: Record<string, string | null>) {
      if (!offlineE2e || Object.keys(mapping).length > 128 || Object.entries(mapping).some(([key, value]) => !/^[1-9][0-9]{0,11}$/.test(key) || (value !== null && !/^[1-9][0-9]{0,11}$/.test(value)))) throw new Error('Invalid room fixture')
      roomFixture = room => {
        if (!Object.hasOwn(mapping, room)) throw new Error('Missing identity fixture')
        return '<script id="vike_pageContext" type="application/json">' + JSON.stringify({ pageProps: { room: { roomInfo: { roomInfo: mapping[room] ? { rid: Number(mapping[room]) } : {} } } } }) + '</script>'
      }
    }, setToolUpdateFixture(bytes: Uint8Array, outcome: 'success' | 'hash-mismatch' | 'network-error') {
      const content = Buffer.from(bytes)
      if (!content.length || content.length > 64 * 1048576 || !['success', 'hash-mismatch', 'network-error'].includes(outcome)) throw new Error('Invalid update fixture')
      const version = toolsLock.ytdlpVersion
      const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/`
      fixtureRequest = async url => {
        if (outcome === 'network-error') throw new Error('Offline fixture network failure')
        if (url === 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest') return new Response(JSON.stringify({ tag_name: version, draft: false, prerelease: false, assets: [
          { name: 'yt-dlp.exe', browser_download_url: base + 'yt-dlp.exe', size: content.length },
          { name: 'SHA2-256SUMS', browser_download_url: base + 'SHA2-256SUMS', size: 77 },
        ] }))
        if (url === base + 'SHA2-256SUMS') return new Response(`${outcome === 'hash-mismatch' ? '0'.repeat(64) : createHash('sha256').update(content).digest('hex')}  yt-dlp.exe\n`)
        if (url === base + 'yt-dlp.exe') return new Response(content)
        throw new Error('Unknown offline fixture request')
      }
    } } : {}),
    emitDanmaku: handlers.emitDanmaku,
    youtubeDiagnostics: () => youtubeDiagnostics,
    bufferDiagnostics: () => bufferDiagnostics,
    adaptiveStats: () => adaptiveStats,
    // A fixed fixture capability exists only in the main-process E2E harness.
    bufferFixture: () => buffer.start('official', async () => ({
      url: pathToFileURL(join(clientDir, 'test-sources/commentary-hls/index.m3u8')).href, realtime: true,
    })),
  } })
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
  let cleanup: Promise<void> | undefined
  dispose = () => cleanup ??= (async () => {
    unwatchFile(index)
    handlers.dispose()
    service.dispose()
    acquisition.dispose()
    await Promise.all([ytdlp.dispose(), buffer.dispose(), logins.dispose()])
    media.clear()
    protocol.unhandle('app')
    delete (globalThis as { __streamSyncerTest?: unknown }).__streamSyncerTest
    globalThis.fetch = nativeFetch
    if (offlineE2e) session.defaultSession.webRequest.onBeforeRequest(null)
    dispose = undefined
  })()
  window.on('closed', () => { window = null; void dispose?.() })
  await window.loadURL(APP_URL)
}
app.whenReady().then(start).catch(() => { console.error('应用启动失败, 请检查构建产物和数据目录'); app.exit(1) })
app.on('window-all-closed', () => app.quit())
let quitting = false
app.on('before-quit', (event) => {
  if (!dispose || quitting) return
  event.preventDefault()
  quitting = true
  void dispose().finally(() => app.quit())
})
