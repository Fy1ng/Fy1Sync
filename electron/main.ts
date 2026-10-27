import './networkRuntime'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, protocol, session, shell } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync, watchFile, unwatchFile } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createDouyuRoomResolver } from '../server/platforms/douyuRoom'
import { createDesktopService, createResolverDeps } from '../server/api'
import { resolveHuyaDanmakuRoom } from '../server/platforms/huyaDanmaku'
import { resolveConfig } from '../server/config'
import { DanmakuRelay } from '../server/danmaku/relay'
import { MediaRegistry } from '../server/mediaProxy'
import { serveStatic, missingClientResponse } from '../server/static'
import { APP_URL, CONTENT_SECURITY_POLICY, allowsAppPermission, isAppDocument, isAppOrigin } from './security'
import { installIpcHandlers } from './ipc'
import { BufferManager } from './bufferManager'
import { pullAdaptive, AdaptivePullError } from './adaptivePuller'
import { ChromeLoginDriver, findSystemChrome, LoginManager } from './login'
import { CookieStore } from './cookies'
import { Acquisition } from './acquisition'
import { YtDlpRunner, type YtDlpDiagnostic } from './ytdlp'
import { locateTool, type ToolSettings } from './toolLocator'
import { DecoderPreferences } from './decoderPreferences'
import { ManagedYtdlp } from './toolUpdater'
import { DesktopTools } from './toolsService'
import toolsLock from '../packaging/tools-lock.json'
import { NativePrivatePermissions, privateDirectory } from './privateStorage'
import { createHash } from 'node:crypto'
import { DouyuAccountError, DouyuAccountManager } from './douyuAccounts'
import { DouyuTaskManager } from './douyuTasks'
import { PrivateJsonStore } from './privateJsonStore'
import { DouyuActions } from '../server/douyu/actions'
import { DouyuMessageSender, NativeMessageSocket } from '../server/douyu/messageSender'
import { DouyuBackpackGateway } from '../server/douyu/backpackGateway'
import { DouyuRenewalService } from '../server/douyu/renewalService'
import type { DouyuBackpackDonation } from '../server/douyu/renewalTypes'
import type { DouyuMessageInput, DouyuRuntimeState, DouyuTaskStorage } from '../server/douyu/types'
import { isDouyuActivityKind } from '../server/douyu/types'
import { DanmakuFeatures, type DanmakuFeaturesStorage } from './danmakuFeatures'
import { ActivityPreferencesStore, type ActivityPreferences } from './activityPreferences'
import { createBackendRuntime } from './backendRuntime'
import { parseAppUpdateSource, type AppUpdateSource } from './appUpdateService'

const networkRuntimePath = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'network-runtime.cjs')
  : join(__dirname, 'network-runtime.cjs')

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true,
} }])
app.setName('Fy1Sync')
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
  let danmakuFeatures: DanmakuFeatures | undefined
  let activityPreferences: ActivityPreferencesStore | undefined
  let backend: ReturnType<typeof createBackendRuntime> | undefined
  let pipWindow: BrowserWindow | null = null
  let handlers: ReturnType<typeof installIpcHandlers> | undefined
  let backendConfig: { maxExtraStreams: number; updateSource: AppUpdateSource | null } = { maxExtraStreams: 16, updateSource: null }
  try {
    const danmakuStore = new PrivateJsonStore<DanmakuFeaturesStorage>(userDataDir, 'douyu/danmaku-features.json')
    danmakuFeatures = new DanmakuFeatures({ load: () => danmakuStore.load(), save: value => danmakuStore.save(value) })
    activityPreferences = new ActivityPreferencesStore(new PrivateJsonStore<ActivityPreferences>(userDataDir, 'douyu/activity-preferences.json'))
    const raw = new PrivateJsonStore<{ version: 1; maxExtraStreams?: number; updateSource?: unknown }>(userDataDir, 'backend.json').load()
    if (raw !== undefined) {
      if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1
        || Object.keys(raw).some(key => !['version', 'maxExtraStreams', 'updateSource'].includes(key))) throw new Error('Invalid backend configuration')
      const value = raw as { maxExtraStreams?: number; updateSource?: unknown }
      const maxExtraStreams = value.maxExtraStreams ?? 16
      if (!Number.isSafeInteger(maxExtraStreams) || maxExtraStreams < 1 || maxExtraStreams > 256) throw new Error('Invalid stream limit')
      backendConfig = { maxExtraStreams, updateSource: value.updateSource == null ? null : parseAppUpdateSource(value.updateSource) }
    }
  } catch { console.error('扩展功能本地配置不可用, 原文件已保留.'); danmakuFeatures = undefined; activityPreferences = undefined }
  const toolSettings: ToolSettings = await readFile(join(userDataDir, 'tools.json'), 'utf8')
    .then((text) => {
      const value = JSON.parse(text) as ToolSettings
      return { ffmpegPath: typeof value.ffmpegPath === 'string' ? value.ffmpegPath : undefined,
        ffprobePath: typeof value.ffprobePath === 'string' ? value.ffprobePath : undefined,
        ytdlpPath: typeof value.ytdlpPath === 'string' ? value.ytdlpPath : undefined }
    }).catch(() => ({}))
  const e2e = process.env.STREAM_SYNC_E2E === '1'
  const offlineE2e = e2e && process.env.STREAM_SYNC_OFFLINE_E2E === '1'
  let douyuToolsFixture = false
  const douyuSentFixture: DouyuMessageInput[] = []
  let douyuSendFixtureOutcome: 'succeeded' | 'waiting-user' = 'succeeded'
  let activityFixtureOutcome: 'scheduled' | 'waiting-user' | 'succeeded' = 'scheduled'
  const activityRunsFixture: Array<{ accountId: string; room: string; kind: string }> = []
  const officialRoomFixture: string[] = []
  let renewalFixture: { stock: number; outcome: 'receipt-received' | 'unknown' } | null = null
  const renewalDonationsFixture: Array<Omit<DouyuBackpackDonation, 'expectedUid'>> = []
  const browserLogin = new ChromeLoginDriver()
  const createLogin = (directory: string) => new LoginManager(directory, {
    findChrome: () => !app.isPackaged && offlineE2e && douyuToolsFixture ? process.execPath : findSystemChrome(),
    driver: { async login(executable, profile, platform, signal, destination) {
      if (!app.isPackaged && offlineE2e && douyuToolsFixture && platform === 'douyu') {
        if (signal.aborted) throw new Error('Fixture login cancelled')
        if (destination?.startsWith('room:') || destination?.startsWith('fish-act:')) officialRoomFixture.push(destination)
        return ['acf_uid', 'acf_biz', 'acf_stk', 'acf_ct', 'acf_ltkid'].map((name, index) => ({
          domain: '.douyu.com', path: '/', secure: true, session: true, name, value: String(index + 1),
        }))
      }
      return browserLogin.login(executable, profile, platform, signal, destination)
    } },
  })
  const logins = createLogin(userDataDir)
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
  let douyuAccounts: DouyuAccountManager | undefined
  let douyuTasks: DouyuTaskManager | undefined
  let douyuMessageSender: DouyuMessageSender | undefined
  let douyuRenewal: DouyuRenewalService | undefined
  let releaseAccountEvents: (() => void) | undefined
  try { douyuAccounts = new DouyuAccountManager(userDataDir, { defaultLogin: logins, createLogin }) }
  catch { console.error('斗鱼账号配置不可用, 原文件已保留.') }
  if (douyuAccounts) {
    try {
      const taskStore = new PrivateJsonStore<DouyuTaskStorage>(userDataDir, 'douyu/tasks.json')
      const actions = new DouyuActions({ proxy, cookieHeader: (id, url) => douyuAccounts!.cookieHeader(id, url),
        readFanEligibility: async (id, room, signal) => {
          const state = await douyuMessageSender!.inspect(id, room, signal, 'fan')
          return { accountId: id, uid: state.uid, room, checkedAt: state.checkedAt, source: state.source, eligible: state.fanEligible }
        },
      })
      douyuMessageSender = new DouyuMessageSender({ proxy, networkRuntimePath, cookieHeader: (id, url) => douyuAccounts!.cookieHeader(id, url), deliveryTracker: danmakuFeatures?.deliveries })
      douyuTasks = new DouyuTaskManager({
        load: () => taskStore.load(), save: value => taskStore.save(value),
        run: async (task, signal) => {
          if (!app.isPackaged && offlineE2e && douyuToolsFixture) {
            if (signal.aborted) throw new DOMException('Fixture activity cancelled', 'AbortError')
            if (isDouyuActivityKind(task.kind)) {
              if (activityRunsFixture.length >= 128) throw new Error('Fixture activity limit reached')
              activityRunsFixture.push({ accountId: task.accountId, room: task.room, kind: task.kind })
              if (activityFixtureOutcome === 'scheduled') return { status: 'scheduled', message: '离线活动状态: 等待官方时间', nextRunAt: Date.now() + 60_000 }
              return { status: activityFixtureOutcome, message: activityFixtureOutcome === 'waiting-user' ? '离线活动状态: 请完成人工验证' : '离线活动测试完成' }
            }
            return { status: 'succeeded', message: task.kind === 'yuba-sign' ? '离线鱼吧签到测试完成' : '离线签到测试完成' }
          }
          return actions.run(task, signal, { fishing: activityPreferences?.get().fishing, treasure: activityPreferences?.get().treasure })
        },
        sendMessage: async (input, signal) => {
          if (!app.isPackaged && offlineE2e && douyuToolsFixture) {
            if (signal.aborted) throw new DOMException('Fixture send cancelled', 'AbortError')
            if (douyuSentFixture.length >= 64) throw new Error('Fixture send limit reached')
            douyuSentFixture.push({ ...input })
            return { status: douyuSendFixtureOutcome, nextAllowedAt: null,
              message: douyuSendFixtureOutcome === 'succeeded' ? '离线弹幕发送回执' : '离线发送结果待核对' }
          }
          return douyuMessageSender!.send(input, signal)
        },
      })
      douyuTasks.setActiveAccount(douyuAccounts.activeAccountId)
      releaseAccountEvents = douyuAccounts.subscribe(event => {
        if (event.type === 'invalidated') {
          douyuTasks!.pauseAccount(event.accountId, '账号登录状态已变化, 请重新启动任务.')
          douyuRenewal?.invalidate(event.accountId)
        }
        douyuTasks!.setActiveAccount(douyuAccounts!.activeAccountId)
      })
    } catch {
      douyuTasks?.dispose()
      douyuMessageSender?.dispose()
      douyuTasks = undefined
      console.error('斗鱼任务配置不可用, 原文件已保留.')
    }
  }
  const playbackLogins = {
    login: (platform: 'youtube' | 'douyu') => platform === 'youtube' ? logins.login(platform)
      : douyuAccounts ? douyuAccounts.loginActive() : Promise.reject(new DouyuAccountError('storage-failed')),
    logout: (platform: 'youtube' | 'douyu') => platform === 'youtube' ? logins.logout(platform)
      : douyuAccounts ? douyuAccounts.logoutActive() : Promise.reject(new DouyuAccountError('storage-failed')),
    async loginStatus() {
      const status = await logins.loginStatus()
      return { ...status, douyu: douyuAccounts ? await douyuAccounts.activeLoginStatus()
        : { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false } }
    },
    cookieHeader: (_platform: 'douyu') => douyuAccounts ? douyuAccounts.activeCookieHeader() : Promise.resolve(''),
  }
  const providerCacheHome = privateDirectory(userDataDir, join(userDataDir, 'provider-cache'), new NativePrivatePermissions())
  const toolContext = {
    ...(app.isPackaged ? { bundledDir: join(process.resourcesPath, 'tools') } : {}),
    managedYtdlp: () => managedYtdlp.activePath(),
    providerCacheHome,
  }
  const tools = new DesktopTools(toolSettings, toolContext, managedYtdlp, process.env, !app.isPackaged)
  const youtubeDiagnostics: YtDlpDiagnostic[] = []
  const ytdlp = new YtDlpRunner({ electronPath: process.execPath, networkRuntimePath, cookies: logins, settings: toolSettings, toolContext,
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
  const acquisition = new Acquisition({ buffer, logins: playbackLogins, runYtDlp: (url, adaptive) => ytdlp.resolve(url, adaptive), proxy, resolveDouyuRoom: roomResolver.resolve,
    ensureTools: async (platform) => {
      if (offlineE2e) throw new Error('默认离线测试禁止真实平台取流')
      await locateTool('ffmpeg', toolSettings, process.env, toolContext)
      await locateTool('ffprobe', toolSettings, process.env, toolContext)
      if (platform === 'youtube') await locateTool('yt-dlp', toolSettings, process.env, toolContext)
    },
  })
  // Offline E2E drives events through the real IPC subscriptions, without a live room.
  const resolveHuyaRoom = (room: string) => {
    if (offlineE2e) return Promise.reject(new Error('默认离线测试禁止真实虎牙房间查询'))
    return resolveHuyaDanmakuRoom(room, createResolverDeps(proxy, media.register).fetchText)
  }
  const relay = new DanmakuRelay({ huya: { resolveRoom: resolveHuyaRoom },
    ...(e2e ? { createSocket: () => ({ send() {}, close() {}, addEventListener() {} }) } : {}) })
  if (douyuAccounts && douyuTasks) {
    const gateway = new DouyuBackpackGateway({ proxy, cookieHeader: (id, url) => douyuAccounts!.cookieHeader(id, url) })
    const fixtureEnabled = () => !app.isPackaged && offlineE2e && douyuToolsFixture && renewalFixture !== null
    douyuRenewal = new DouyuRenewalService({
      tasks: douyuTasks, resolveRoom: roomResolver.resolve,
      accountReady: id => douyuAccounts!.activeAccountId === id && !douyuAccounts!.isBusy(id),
      gateway: {
        async readBadges(accountId, signal) {
          if (!fixtureEnabled()) return gateway.readBadges(accountId, signal)
          if (signal.aborted) throw new DOMException('Fixture read cancelled', 'AbortError')
          return { uid: '1', html: '<table class="fans-badge-list"><tbody><tr data-fans-room="6979222"><td>测试粉丝牌</td></tr><tr data-fans-room="288016"><td>测试粉丝牌</td></tr></tbody></table>' }
        },
        async readBackpack(accountId, room, signal) {
          if (!fixtureEnabled()) return gateway.readBackpack(accountId, room, signal)
          if (signal.aborted) throw new DOMException('Fixture read cancelled', 'AbortError')
          return { uid: '1', payload: { list: renewalFixture!.stock ? [{ id: 268, name: '离线测试荧光棒', count: renewalFixture!.stock,
            met: -1, propType: 1, isClick: 1, isValuable: 0 }] : [] } }
        },
        async donate(input, signal) {
          if (!fixtureEnabled()) return gateway.donate(input, signal)
          if (signal.aborted || renewalFixture!.stock < input.quantity) return { status: 'not-submitted', message: '离线赠送未提交' }
          if (renewalDonationsFixture.length >= 64) throw new Error('Fixture donation limit reached')
          const { expectedUid: _uid, ...publicInput } = input
          renewalDonationsFixture.push(publicInput)
          renewalFixture!.stock -= input.quantity
          return { status: renewalFixture!.outcome, message: renewalFixture!.outcome === 'receipt-received' ? '离线背包赠送回执' : '离线赠送结果待核对' }
        },
      },
    })
  }
  if (danmakuFeatures && activityPreferences) backend = createBackendRuntime({
    userDataDir, proxy, acquisition, relay, danmaku: danmakuFeatures, accounts: douyuAccounts, tasks: douyuTasks,
    sender: douyuMessageSender, renewal: douyuRenewal, resolveRoom: roomResolver.resolve, activityPreferences, ...backendConfig,
    ffmpegPath: () => locateTool('ffmpeg', toolSettings, process.env, toolContext),
    validatePng: bytes => { const value = nativeImage.createFromBuffer(bytes); return !value.isEmpty() },
    chooseCaptureDestination: async kind => {
      const result = await dialog.showSaveDialog({ title: kind === 'png' ? '保存播放截图' : '保存 GIF',
        defaultPath: `Fy1Sync-${Date.now()}.${kind}`, filters: [{ name: kind.toUpperCase(), extensions: [kind] }] })
      return result.canceled || !result.filePath ? null : result.filePath
    },
    openExternal: url => shell.openExternal(url),
    notifyLive: event => {
      if (Notification.isSupported()) new Notification({ title: '斗鱼开播提醒', body: `关注的直播间 ${event.room} 已开播` }).show()
    },
    createPipWindow: () => {
      const created = new BrowserWindow({ show: false, width: 480, height: 270, minWidth: 240, minHeight: 135,
        autoHideMenuBar: true, alwaysOnTop: true, title: 'Fy1Sync - 画中画',
        webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
          nodeIntegration: false, webSecurity: true, backgroundThrottling: false } })
      pipWindow = created
      const contents = created.webContents
      contents.setAudioMuted(true)
      const unregister = handlers?.registerWindow(contents)
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const pipDocument = (url: string) => isAppOrigin(url) && ['/pip', '/pip/'].includes(new URL(url).pathname)
      contents.on('will-navigate', (event, url) => { if (!pipDocument(url)) event.preventDefault() })
      contents.on('will-redirect', (event, url) => { if (!pipDocument(url)) event.preventDefault() })
      contents.on('will-attach-webview', event => event.preventDefault())
      created.on('focus', () => refreshRuntime())
      created.on('blur', () => refreshRuntime())
      created.on('closed', () => { unregister?.(); if (pipWindow === created) pipWindow = null; refreshRuntime() })
      return { id: contents.id, load: () => created.loadURL('app://app/pip'), show: () => created.show(),
        close: () => { if (!created.isDestroyed()) created.close() },
        resize: (width, height) => { if (!created.isDestroyed()) created.setSize(width, height) },
        onClosed: listener => { created.on('closed', listener); return () => created.removeListener('closed', listener) } }
    },
  })
  const service = createDesktopService({
    dataDir: process.env.STREAM_SYNC_DATA_DIR || userDataDir, proxy, relay, resolveDouyuRoom: roomResolver.resolve, resolveHuyaRoom, registerMedia: media.register, acquisition, decoderPreferences, tools, douyuAccounts, douyuTasks, douyuRenewal,
    features: backend?.api,
  })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowsAppPermission(permission, {
      trustedWindow: !contents.isDestroyed() && ((!!window && !window.isDestroyed() && contents === window.webContents)
        || (!!pipWindow && !pipWindow.isDestroyed() && contents === pipWindow.webContents)),
      documentUrl: contents.isDestroyed() ? '' : contents.mainFrame.url,
      requestingUrl: details.requestingUrl, isMainFrame: details.isMainFrame,
    }))
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    return allowsAppPermission(permission, {
      trustedWindow: !!contents && !contents.isDestroyed() && ((!!window && !window.isDestroyed() && contents === window.webContents)
        || (!!pipWindow && !pipWindow.isDestroyed() && contents === pipWindow.webContents)),
      documentUrl: !contents || contents.isDestroyed() ? '' : contents.mainFrame.url,
      requestingUrl: details.requestingUrl, requestingOrigin, isMainFrame: details.isMainFrame,
    })
  })
  protocol.handle('app', async (request) => {
    try {
      if (!isAppOrigin(request.url)) return new Response(null, { status: 403 })
      const url = new URL(request.url)
      let response: Response | null
      if (url.pathname.startsWith('/media/')) response = await media.handle(request)
      else if (url.pathname.startsWith('/buffer/')) response = await buffer.handle(request)
      else if (url.pathname === '/pip' || url.pathname === '/pip/') response = await serveStatic(new Request(APP_URL, { method: request.method }), { root: clientDir })
      else response = await serveStatic(request, { root: clientDir })
      if (!response) response = url.pathname === '/' ? missingClientResponse(clientDir) : new Response(null, { status: 404 })
      response.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
      response.headers.set('X-Content-Type-Options', 'nosniff')
      return response
    } catch { return new Response('资源读取失败', { status: 500 }) }
  })
  Menu.setApplicationMenu(null)
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 800, minHeight: 600,
    title: 'Fy1Sync', titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0d0f', symbolColor: '#f3f0ea', height: 32 },
    backgroundColor: '#0d0d0f',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
    },
  })
  const contents = window.webContents
  const mainWindow = window
  const releasePipPresentation = backend?.pip.subscribe(state => {
    if (!mainWindow.isDestroyed()) {
      contents.setAudioMuted(state.audioOwner === 'pip')
      contents.backgroundThrottling = state.phase === 'ready' && state.options.lowPower
    }
    if (pipWindow && !pipWindow.isDestroyed()) pipWindow.webContents.setAudioMuted(state.audioOwner !== 'pip')
  })
  const isLocked = (): boolean => {
    try { return powerMonitor.getSystemIdleState(1) === 'locked' } catch { return true }
  }
  const runtime: DouyuRuntimeState = { foreground: false, locked: isLocked(), suspended: false }
  const refreshRuntime = () => {
    runtime.foreground = (!mainWindow.isDestroyed() && mainWindow.isFocused() && !mainWindow.isMinimized())
      || (!!pipWindow && !pipWindow.isDestroyed() && pipWindow.isFocused() && !pipWindow.isMinimized())
    douyuTasks?.setRuntime({ ...runtime })
  }
  const lock = () => { runtime.locked = true; refreshRuntime() }
  const unlock = () => { runtime.locked = false; refreshRuntime() }
  const suspend = () => { runtime.suspended = true; refreshRuntime() }
  const resume = () => { runtime.suspended = false; runtime.locked = isLocked(); refreshRuntime() }
  mainWindow.on('focus', refreshRuntime)
  mainWindow.on('blur', refreshRuntime)
  mainWindow.on('minimize', refreshRuntime)
  mainWindow.on('restore', refreshRuntime)
  mainWindow.on('show', refreshRuntime)
  mainWindow.on('hide', refreshRuntime)
  powerMonitor.on('lock-screen', lock)
  powerMonitor.on('unlock-screen', unlock)
  powerMonitor.on('suspend', suspend)
  powerMonitor.on('resume', resume)
  refreshRuntime()
  handlers = installIpcHandlers(ipcMain, contents, service, {
    allowMethod: (id, method, args) => backend?.pip.permits(id, method, args) === true,
    allowRoom: (id, room) => backend?.pip.permitsRoom(id, room) === true,
    allowEvent: (id, event) => {
      if (id !== backend?.pip.windowId()) return false
      if (event.topic === 'pip' || event.topic === 'danmaku-preferences') return true
      const value = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
      if (event.topic === 'buffer') return value.role === backend.pip.state().streamId
      return event.topic === 'insights' && value.room === backend.pip.state().source?.sourceRoom
    },
  })
  if (e2e) Object.assign(globalThis, { __streamSyncerTest: {
    ...(!app.isPackaged ? { setDouyuToolsFixture() {
      if (!offlineE2e) throw new Error('Douyu tools fixture is offline-only')
      douyuToolsFixture = true
    }, setDouyuCredentialsFixture(missingUsername: boolean) {
      if (!offlineE2e) throw new Error('Credential fixture is offline-only')
      const fields = { acf_uid: '42', dy_did: '1'.repeat(32), acf_username: 'fixture-user', acf_auth_wl: 'fixture-auth' }
      new CookieStore(userDataDir).write('douyu', Object.entries(fields).filter(([name]) => !missingUsername || name !== 'acf_username').flatMap(([name, value]) => [
        { domain: '.douyu.com', path: '/', secure: true, session: true, name, value: name === 'acf_uid' ? '99' : value },
        { domain: 'www.douyu.com', hostOnly: true, path: '/', secure: true, session: true, name, value },
      ]))
    }, setDouyuActivityFixtureOutcome(outcome: 'scheduled' | 'waiting-user' | 'succeeded') {
      if (!offlineE2e || !douyuToolsFixture || !['scheduled', 'waiting-user', 'succeeded'].includes(outcome)) throw new Error('Invalid activity fixture')
      activityFixtureOutcome = outcome
    }, getDouyuActivitiesFixture() {
      if (!offlineE2e || !douyuToolsFixture) throw new Error('Activity fixture unavailable')
      return { attempts: activityRunsFixture.map(item => ({ ...item })), rooms: [...officialRoomFixture] }
    }, setDouyuRenewalFixture(stock: number, outcome: 'receipt-received' | 'unknown' = 'receipt-received') {
      if (!offlineE2e || !douyuToolsFixture || !Number.isSafeInteger(stock) || stock < 0 || stock > 1000 || !['receipt-received', 'unknown'].includes(outcome)) throw new Error('Invalid renewal fixture')
      renewalFixture = { stock, outcome }
      renewalDonationsFixture.length = 0
    }, getDouyuRenewalDonationsFixture() {
      if (!offlineE2e || !douyuToolsFixture || !renewalFixture) throw new Error('Renewal fixture unavailable')
      return renewalDonationsFixture.map(input => ({ ...input }))
    }, createDouyuSocketFixture(url: string) {
      if (!offlineE2e || !/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/$/.test(url)) throw new Error('Invalid local socket fixture')
      return new NativeMessageSocket(url, networkRuntimePath, [new URL(url).hostname.replace(/^\[|\]$/g, '')])
    }, getDouyuSentFixture() {
      if (!offlineE2e || !douyuToolsFixture) throw new Error('Douyu send fixture is offline-only')
      return douyuSentFixture.map(input => ({ ...input }))
    }, setDouyuSendFixtureOutcome(outcome: 'succeeded' | 'waiting-user') {
      if (!offlineE2e || !douyuToolsFixture || !['succeeded', 'waiting-user'].includes(outcome)) throw new Error('Invalid send fixture')
      douyuSendFixtureOutcome = outcome
    }, setDouyuRoomFixture(mapping: Record<string, string | null>) {
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
    emitDanmaku: (room: string, event: string, data: unknown) => {
      if (offlineE2e && event === 'danmaku') backend?.observeFixture(data as Parameters<DanmakuFeatures['observe']>[0])
      return handlers!.emitDanmaku(room, event, data)
    },
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
    mainWindow.removeListener('focus', refreshRuntime)
    mainWindow.removeListener('blur', refreshRuntime)
    mainWindow.removeListener('minimize', refreshRuntime)
    mainWindow.removeListener('restore', refreshRuntime)
    mainWindow.removeListener('show', refreshRuntime)
    mainWindow.removeListener('hide', refreshRuntime)
    powerMonitor.removeListener('lock-screen', lock)
    powerMonitor.removeListener('unlock-screen', unlock)
    powerMonitor.removeListener('suspend', suspend)
    powerMonitor.removeListener('resume', resume)
    releaseAccountEvents?.()
    releasePipPresentation?.()
    await backend?.dispose()
    danmakuFeatures?.dispose()
    douyuRenewal?.dispose()
    douyuTasks?.dispose()
    douyuMessageSender?.dispose()
    unwatchFile(index)
    handlers?.dispose()
    service.dispose()
    acquisition.dispose()
    await Promise.all([ytdlp.dispose(), buffer.dispose(), logins.dispose(), douyuAccounts?.dispose()])
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
