import { FeatureApi, FeatureApiError, createDanmakuHandlers, createFeatureAccountGuard, createInsightsHandlers, type FeatureHandlers } from '../server/featureApi'
import type { ProxyConfig } from '../server/config'
import type { Acquisition } from './acquisition'
import { StreamSessions } from './streamSessions'
import { isStreamId, type StreamId } from './streamIdentity'
import { PipManager, type PipWindowPort } from './pipManager'
import { MediaCapture, encodeGifWithFfmpeg, type CaptureSettings } from './mediaCapture'
import { AppUpdateService, type AppUpdateSource } from './appUpdateService'
import { AutomationManager, type AutomationStorage } from './automationManager'
import type { ActivityPreferencesStore } from './activityPreferences'
import { PrivateJsonStore } from './privateJsonStore'
import type { DanmakuFeatures } from './danmakuFeatures'
import type { DouyuAccountManager } from './douyuAccounts'
import { isDouyuAccountId } from './douyuAccounts'
import type { DouyuTaskManager } from './douyuTasks'
import type { DanmakuRelay } from '../server/danmaku/relay'
import { isReadOnlyDanmakuPlatform, isReadOnlyDanmakuRoom } from '../server/danmaku/types'
import { DouyuModeration } from '../server/douyu/moderation'
import type { DouyuMessageSender } from '../server/douyu/messageSender'
import { DouyuInsightsGateway } from '../server/douyu/insightsGateway'
import { DouyuInsightsService } from '../server/douyu/insightsService'
import type { DouyuLiveNotification } from '../server/douyu/insightsTypes'
import type { DouyuGiftCatalog } from '../server/douyu/inventoryTypes'
import { DouyuCheckInActions } from '../server/douyu/checkInActions'
import { DouyuLevelRewardActions } from '../server/douyu/levelRewardActions'
import { DOUYU_CHECK_IN_KINDS } from '../server/douyu/automationTypes'
import type { DouyuRenewalService } from '../server/douyu/renewalService'
import { DouyuBackpackGateway } from '../server/douyu/backpackGateway'
import { DouyuInventoryService } from '../server/douyu/inventoryService'
import { DouyuGiftPurchaseGateway } from '../server/douyu/giftPurchaseGateway'
import { DouyuGiftPlanService } from '../server/douyu/giftPlanService'
import type { ResolveDouyuRoom } from '../server/platforms/douyuRoom'
import appPackage from '../package.json'
import { EsportsService } from '../server/esports/schedule'
import { DouyuReadCache } from '../server/douyu/readCache'
import { SavedRoomsStore } from './savedRooms'
import { DouyuGatewayCoordinator } from '../server/douyu/gatewayCoordinator'
import { DouyuWatchService, type DouyuWatchContext } from '../server/douyu/watchService'
import { DouyuWatchGateway } from '../server/douyu/watchGateway'
import type { DouyuWatchPlaybackReport } from '../server/douyu/watchTypes'
import { types as utilTypes } from 'node:util'

export interface BackendRuntimeOptions {
  userDataDir: string
  bundledLogoDir?: string
  proxy: ProxyConfig
  acquisition: Acquisition
  relay: DanmakuRelay
  danmaku: DanmakuFeatures
  accounts?: DouyuAccountManager
  tasks?: DouyuTaskManager
  sender?: DouyuMessageSender
  gatewayCoordinator?: DouyuGatewayCoordinator
  networkRuntimePath?: string
  watchEnabled?: boolean
  watchGateway?: Pick<DouyuWatchGateway, 'run'>
  renewal?: DouyuRenewalService
  resolveRoom: ResolveDouyuRoom
  activityPreferences: ActivityPreferencesStore
  maxExtraStreams?: number
  updateSource?: AppUpdateSource | null
  createPipWindow: () => PipWindowPort
  chooseCaptureDestination: (kind: 'png' | 'gif') => Promise<string | null>
  validatePng: (bytes: Buffer) => boolean
  ffmpegPath: () => Promise<string>
  openExternal: (url: string) => Promise<void>
  notifyLive: (event: DouyuLiveNotification) => void
}

export function createBackendRuntime(options: BackendRuntimeOptions) {
  const lifetime = new AbortController()
  const api = new FeatureApi()
  const esports = new EsportsService({ userDataDir: options.userDataDir, bundledLogoDir: options.bundledLogoDir,
    version: appPackage.version, onEvent: event => api.publish(event) })
  const savedRooms = new SavedRoomsStore(options.userDataDir)
  const readCache = new DouyuReadCache()
  const releases: (() => void)[] = []
  const required = <T>(service: T | undefined): T => { if (!service) throw new FeatureApiError('not-available'); return service }
  const accounts = () => required(options.accounts)
  const queue = () => required(options.tasks)
  const cookieHeader = (id: string, url: string) => accounts().cookieHeader(id, url)
  const accountReady = (id: string) => options.accounts?.activeAccountId === id && !options.accounts.isBusy(id)
  const withAccount = options.accounts ? createFeatureAccountGuard(options.accounts, lifetime.signal)
    : async <T>(_id: string, _run: (signal: AbortSignal) => T | Promise<T>): Promise<T> => { throw new FeatureApiError('not-available') }
  const streams = new StreamSessions(options.acquisition, options.maxExtraStreams)
  const pip = new PipManager({ createWindow: options.createPipWindow, source: id => streams.describe(id), sendContext: room => {
    const state = options.tasks?.snapshot()
    const id = options.accounts?.activeAccountId ?? null
    return { accountId: id, canAttempt: !!id && !!room && state?.currentRoom === room && state.runtime.foreground
      && !state.runtime.locked && !state.runtime.suspended && !options.accounts?.isBusy(id) }
  } })
  const captureStore = new PrivateJsonStore<CaptureSettings>(options.userDataDir, 'capture/settings.json')
  const capture = new MediaCapture({ root: options.userDataDir, load: () => captureStore.load(), save: value => captureStore.save(value),
    chooseDestination: options.chooseCaptureDestination, validatePng: options.validatePng,
    encode: async (input, signal) => encodeGifWithFfmpeg(await options.ffmpegPath(), input, signal) })
  const update = new AppUpdateService({ currentVersion: appPackage.version, source: options.updateSource ?? null })
  const insightsGateway = new DouyuInsightsGateway({ proxy: options.proxy, cookieHeader })
  const insights = new DouyuInsightsService({ gateway: insightsGateway, onNotification: options.notifyLive })
  const gatewayCoordinator = options.gatewayCoordinator ?? new DouyuGatewayCoordinator()
  const watchGateway = options.watchGateway ?? (options.networkRuntimePath && options.watchEnabled !== false
    ? new DouyuWatchGateway({ proxy: options.proxy, cookieHeader, networkRuntimePath: options.networkRuntimePath }) : undefined)
  const watch = new DouyuWatchService({ coordinator: gatewayCoordinator,
    run: (id, room, signal, stats, heartbeat) => required(watchGateway).run(id, room, signal, stats, heartbeat),
    readWatchTime: (id, room, signal) => insightsGateway.readWatchTime(id, room, signal),
    readFansWatchTime: (id, room, signal) => insightsGateway.readFansWatchTime(id, room, signal),
  })
  let watchLogin = false
  let watchContextRevision = 0
  let monitoredRoom: string | null = null
  let roomStatusController: AbortController | null = null
  let roomStatusRead: Promise<void> | null = null
  let roomStatusAt = 0
  const updateWatchContext = () => {
    const state = options.tasks?.snapshot()
    const room = state?.currentRoom ?? null
    const roomInfo = room ? insights.snapshot(room) : null
    const context: DouyuWatchContext = { accountId: options.accounts?.activeAccountId ?? null, room: state?.currentRoom ?? null,
      loggedIn: watchLogin, busy: !!options.accounts?.activeAccountId && options.accounts.isBusy(options.accounts.activeAccountId),
      locked: state?.runtime.locked ?? true, suspended: state?.runtime.suspended ?? false,
      live: roomInfo?.live ?? null, replay: roomInfo?.replay ?? null }
    watch.setContext(context)
  }
  const refreshRoomStatus = () => {
    const room = options.tasks?.snapshot().currentRoom ?? null
    if (room !== monitoredRoom) {
      roomStatusController?.abort()
      monitoredRoom = room; roomStatusAt = 0; roomStatusRead = null
    }
    if (!room || !watchGateway || lifetime.signal.aborted || roomStatusRead) return
    if (roomStatusAt && Date.now() - roomStatusAt < 60_000) return
    const controller = new AbortController()
    roomStatusController = controller
    const signal = AbortSignal.any([lifetime.signal, controller.signal])
    roomStatusAt = Date.now()
    const promise = insights.refreshRoom(room, signal).then(() => {
      if (!signal.aborted && monitoredRoom === room) updateWatchContext()
    }).catch(() => {
      if (!signal.aborted && monitoredRoom === room) updateWatchContext()
    }).finally(() => { if (roomStatusRead === promise) roomStatusRead = null })
    roomStatusRead = promise
  }
  const refreshWatchLogin = () => {
    const revision = ++watchContextRevision
    watchLogin = false
    updateWatchContext()
    if (!options.accounts) return
    void options.accounts.activeLoginStatus().then(status => {
      if (!lifetime.signal.aborted && revision === watchContextRevision) { watchLogin = status.loggedIn; updateWatchContext() }
    }).catch(() => {})
  }
  const reportWatch = (senderId: number, value: DouyuWatchPlaybackReport) =>
    watch.report(senderId, value, options.acquisition.watchSource?.(value.role) ?? null)
  refreshWatchLogin()
  refreshRoomStatus()
  const roomStatusTimer = setInterval(refreshRoomStatus, 60_000)
  roomStatusTimer.unref?.()
  releases.push(() => { clearInterval(roomStatusTimer); roomStatusController?.abort() })
  releases.push(insights.subscribe(event => {
    if (event.type === 'changed' && event.room === options.tasks?.snapshot().currentRoom) updateWatchContext()
  }))
  const moderation = options.tasks ? new DouyuModeration({ proxy: options.proxy, cookieHeader,
    runExclusive: (context, run, signal) => queue().runAccountOperation(context, run, signal) }) : undefined
  const actionDeps = { proxy: options.proxy, cookieHeader,
    readFollowedRooms: (id: string, signal: AbortSignal) => insightsGateway.readFollowedRooms(id, signal) }
  const checkIns = new DouyuCheckInActions(actionDeps)
  const rewards = new DouyuLevelRewardActions(actionDeps)
  const automationStore = new PrivateJsonStore<AutomationStorage>(options.userDataDir, 'douyu/automations.json')
  const automations = options.tasks ? new AutomationManager({ queue: options.tasks,
    load: () => automationStore.load(), save: value => automationStore.save(value),
    run: (request, signal) => (DOUYU_CHECK_IN_KINDS as readonly string[]).includes(request.kind)
      ? checkIns.run(request, signal) : rewards.run(request, signal),
    forget: id => { checkIns.forget(id); rewards.forget(id) },
  }) : undefined
  const backpack = new DouyuBackpackGateway({ proxy: options.proxy, cookieHeader })
  const purchase = new DouyuGiftPurchaseGateway({ proxy: options.proxy, cookieHeader }, async (id, room, signal) => {
    const state = await required(options.sender).inspect(id, room, signal, 'balance')
    return { uid: state.uid, checkedAt: state.checkedAt, balances: { YUCHI: state.balance.gold, YUWAN: state.balance.silver } }
  })
  const catalogFlights = new Map<string, Promise<DouyuGiftCatalog>>()
  const catalogAttempts = new Map<string, number>()
  const readCatalog = (room: string): Promise<DouyuGiftCatalog> => {
    const existing = catalogFlights.get(room)
    if (existing) return existing
    if (catalogFlights.size >= 4) return Promise.reject(new FeatureApiError('busy'))
    const work = purchase.readCatalog(room, lifetime.signal).then(catalog => {
      if (!lifetime.signal.aborted) insights.setRoomGiftPrices(room, catalog.items.flatMap(item => item.unitPrice?.currency === 'YUCHI'
        ? [{ kind: 'gift' as const, id: item.giftId, amountMinor: item.unitPrice.amountMinor, currency: 'YUCHI' as const,
          checkedAt: catalog.checkedAt, source: 'https://gift.douyucdn.cn/api/gift/v5/web/list' }] : []))
      return catalog
    }).finally(() => { if (catalogFlights.get(room) === work) catalogFlights.delete(room) })
    catalogFlights.set(room, work)
    return work
  }
  const inventory = options.tasks ? new DouyuInventoryService({ gateway: backpack, tasks: options.tasks, accountReady, resolveRoom: options.resolveRoom }) : undefined
  const gifts = options.tasks ? new DouyuGiftPlanService({ gateway: backpack, purchase, tasks: options.tasks, accountReady, resolveRoom: options.resolveRoom }) : undefined
  api.register(createDanmakuHandlers({ features: options.danmaku, moderation, tasks: options.tasks, withAccount, openExternal: options.openExternal }))
  api.register(createInsightsHandlers({ insights, gateway: insightsGateway, update, withAccount, lifetime: lifetime.signal, readCache }))
  const captureChanged = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try { return await run() } finally { api.publish({ topic: 'capture', data: capture.state() }) }
  }
  const operations: FeatureHandlers = {
    listSavedRooms: args => { noArgs(args); return savedRooms.list() },
    saveRoom: args => savedRooms.save(args),
    removeSavedRoom: args => savedRooms.remove(args),
    getCs2Schedule: args => esports.getCs2Schedule(args),
    getStreamTitles: args => esports.getStreamTitles(args),
    setCs2ScheduleFocus: args => esports.setScheduleFocus(args),
    openAppReleasePage: async args => {
      noArgs(args)
      const url = update.state().releaseUrl
      if (!url) throw new FeatureApiError('not-available')
      await options.openExternal(url)
      return { opened: true }
    },
    getStreamSessions: args => { noArgs(args); return streams.snapshot() },
    getDouyuWatchState: args => { noArgs(args); return watch.snapshot() },
    reportDouyuWatchPlayback: (args, context) => {
      const value = watchReportFields(args)
      if ((value.role !== 'official' && value.role !== 'commentary') || typeof value.playing !== 'boolean'
        || typeof value.currentTime !== 'number' || !Number.isFinite(value.currentTime) || value.currentTime < 0
        || ![value.decodedBytes, value.presentedFrames].every(metric => metric === null || (typeof metric === 'number' && Number.isSafeInteger(metric) && metric >= 0))) {
        throw new FeatureApiError('invalid-arguments')
      }
      if (!Number.isSafeInteger(context.senderId)) throw new FeatureApiError('forbidden')
      return reportWatch(context.senderId!, value as unknown as DouyuWatchPlaybackReport)
    },
    openStreamSession: args => streams.open(args),
    closeStreamSession: args => {
      const id = streamId(fields(args, ['id']).id)
      if (pip.state().streamId === id) pip.close()
      return streams.close(id)
    },
    switchStreamSessionQuality: args => { const v = fields(args, ['id', 'quality']); return streams.switchQuality(streamId(v.id), string(v.quality, 128)) },
    restartStreamSession: args => streams.restart(streamId(fields(args, ['id']).id)),
    getStreamPlayback: args => streams.describe(streamId(fields(args, ['id']).id)),
    getEnhancedPip: args => { noArgs(args); return pip.state() },
    openEnhancedPip: args => { fields(args, ['id'], ['options']); return pip.open(streamId(args.id), args.options) },
    setEnhancedPipOptions: args => pip.configure(args),
    closeEnhancedPip: args => { noArgs(args); return pip.close() },
    recoverEnhancedPip: args => { noArgs(args); return pip.recover() },
    reportEnhancedPip: (args, context) => {
      if (!Number.isSafeInteger(context.senderId)) throw new FeatureApiError('forbidden')
      const state = pip.report(context.senderId!, args)
      if (state.streamId === 'official' || state.streamId === 'commentary') reportWatch(context.senderId!, {
        role: state.streamId, playing: args.ready && state.phase === 'ready' && args.playing,
        currentTime: args.mediaTime, presentedFrames: args.frameCount, decodedBytes: null,
      })
      return state
    },
    getCaptureState: args => { noArgs(args); return capture.state() },
    setCaptureEnabled: args => { fields(args, ['enabled']); return captureChanged(() => capture.configure(args.enabled)) },
    savePlaybackScreenshot: args => { fields(args, ['png']); return capture.screenshot(args.png) },
    beginGifRecording: args => capture.begin(args),
    appendGifFrame: args => { fields(args, ['id', 'index', 'png']); return capture.append(string(args.id, 128), args.index, args.png) },
    finishGifRecording: args => captureChanged(() => capture.finish(string(fields(args, ['id']).id, 128))),
    cancelGifRecording: args => captureChanged(() => capture.cancel(string(fields(args, ['id']).id, 128))),
    getDouyuAutomations: args => { noArgs(args); return required(automations).snapshot() },
    createDouyuAutomation: args => {
      if (!args || !isDouyuAccountId(args.accountId) || !accounts().hasAccount(args.accountId)) throw new FeatureApiError('invalid-arguments')
      return required(automations).create(args)
    },
    startDouyuAutomation: args => {
      const id = string(fields(args, ['id']).id, 128)
      const task = required(automations).snapshot().tasks.find(item => item.id === id)
      if (!task) throw new FeatureApiError('not-found')
      return withAccount(task.accountId, () => required(automations).start(id))
    },
    pauseDouyuAutomation: args => required(automations).pause(string(fields(args, ['id']).id, 128)),
    removeDouyuAutomation: args => required(automations).remove(string(fields(args, ['id']).id, 128)),
    getDouyuActivityOptions: args => { noArgs(args); return options.activityPreferences.get() },
    setDouyuActivityOptions: args => options.activityPreferences.set(args),
    previewDouyuRenewalEqual: args => {
      fields(args, ['accountId', 'rooms']); const id = account(args.accountId)
      return withAccount(id, () => required(options.renewal).previewEqual(id, args.rooms))
    },
    getDouyuInventory: args => {
      fields(args, ['accountId'], ['room', 'refresh']); const id = account(args.accountId)
      if (args.refresh !== undefined && typeof args.refresh !== 'boolean') throw new FeatureApiError('invalid-arguments')
      const target = args.room === undefined ? queue().snapshot().currentRoom : room(args.room)
      if (!target) throw new FeatureApiError('invalid-arguments')
      return withAccount(id, () => readCache.read('inventory', id, target, args.refresh, () => required(inventory).read(id, target)))
    },
    getDouyuGiftCatalog: async args => {
      const catalog = await readCatalog(room(fields(args, ['room']).room))
      // YUCHI catalog units are nominal fish-fin units. Do not relabel them as cash cost.
      return catalog
    },
    previewDouyuInventoryGift: args => {
      fields(args, ['accountId', 'input']); const id = account(args.accountId)
      return withAccount(id, () => required(gifts).previewInventory(id, args.input))
    },
    previewDouyuPurchaseGift: args => {
      fields(args, ['accountId', 'input']); const id = account(args.accountId)
      return withAccount(id, () => required(gifts).previewPurchase(id, args.input))
    },
    executeDouyuGiftPlan: args => required(gifts).execute(string(fields(args, ['planId']).planId, 128)),
    cancelDouyuGiftPlan: args => required(gifts).cancel(string(fields(args, ['planId']).planId, 128)),
  }
  api.register(operations)
  releases.push(streams.subscribe(data => api.publish({ topic: 'streams', data })), pip.subscribe(data => api.publish({ topic: 'pip', data })),
    options.danmaku.subscribe(data => api.publish({ topic: 'danmaku-preferences', data })),
    insights.subscribe(data => api.publish({ topic: 'insights', data })),
    watch.subscribe(data => api.publish({ topic: 'douyu-watch', data })))
  let pipOwner: number | null = null
  releases.push(pip.subscribe(() => {
    const current = pip.windowId()
    if (pipOwner !== null && pipOwner !== current) watch.releaseSender(pipOwner)
    pipOwner = current
  }))
  if (automations) releases.push(automations.subscribe(data => api.publish({ topic: 'automations', data })))
  releases.push(options.relay.observe(event => {
    // Other platforms never enter Douyu delivery tracking, history, catalogs or statistics.
    if (isReadOnlyDanmakuPlatform(event.platform)) return
    if (event.type === 'message' && (isReadOnlyDanmakuPlatform(event.message.platform) || isReadOnlyDanmakuRoom(event.message.room))) return
    if (event.type === 'signal' && event.signal.platform === 'huya') return
    if (event.type === 'state' && isReadOnlyDanmakuRoom(event.room)) return
    if (event.type === 'message') { options.danmaku.observe(event.message); insights.observe(event.message) }
    else if (event.type === 'signal') {
      if (event.signal.kind !== 'viewers') insights.signal(event.signal)
      if (event.signal.kind === 'live') updateWatchContext()
    }
    else {
      insights.connection(event.room, event.state)
      if (event.state === 'connected' && Date.now() - (catalogAttempts.get(event.room) ?? 0) >= 60_000 && catalogFlights.size < 4) {
        if (catalogAttempts.size >= 64) catalogAttempts.delete(catalogAttempts.keys().next().value!)
        catalogAttempts.set(event.room, Date.now())
        void readCatalog(event.room).catch(() => {})
      }
    }
  }))
  releases.push(options.acquisition.subscribe(state => {
    if ((state.role === 'official' || state.role === 'commentary') && ['starting', 'stopped', 'failed'].includes(state.state)) watch.releaseSource(state.role)
    if (pip.state().streamId === state.role && (state.state === 'starting' || state.state === 'stopped')) pip.close()
  }))
  if (options.tasks) releases.push(options.tasks.subscribe(() => {
    updateWatchContext()
    refreshRoomStatus()
    // Includes scheduled/manual writes and late settlement after cancellation. Clearing on
    // other queue transitions is intentionally conservative; no write outcomes are cached.
    readCache.invalidate()
    if (pip.windowId() !== null) api.publish({ topic: 'pip', data: pip.state() })
  }))
  if (options.accounts) {
    let previous = options.accounts.activeAccountId
    releases.push(options.accounts.subscribe(event => {
      if (event.type === 'invalidated') watch.invalidateAccount(event.accountId)
      refreshWatchLogin()
      readCache.invalidate()
      const next = options.accounts!.activeAccountId
      const invalidated = event.type === 'invalidated' ? event.accountId : previous !== next ? previous : null
      if (invalidated) {
        options.danmaku.deliveries.cancelAccount(invalidated)
        insights.invalidateAccount(invalidated); automations?.invalidateAccount(invalidated)
        gifts?.invalidate(invalidated); inventory?.invalidate(invalidated)
      }
      previous = next
    }))
  }
  return {
    api, streams, pip, capture, automations, insights, watch,
    observeFixture: (message: Parameters<DanmakuFeatures['observe']>[0]) => {
      if (isReadOnlyDanmakuPlatform(message.platform) || isReadOnlyDanmakuRoom(message.room)) return
      options.danmaku.observe(message); insights.observe(message)
    },
    async dispose() {
      lifetime.abort()
      await watch.dispose()
      if (!options.gatewayCoordinator) gatewayCoordinator.dispose()
      readCache.invalidate()
      for (const release of releases) release()
      pip.dispose(); automations?.dispose(); gifts?.dispose(); inventory?.dispose(); insights.dispose(); update.dispose()
      api.dispose()
      await Promise.all([capture.dispose(), streams.dispose(), esports.dispose()])
    },
  }
}

function fields(raw: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || required.some(k => !Object.hasOwn(raw, k))
    || Object.keys(raw).some(k => !required.includes(k) && !optional.includes(k))) throw new FeatureApiError('invalid-arguments')
  return raw as Record<string, unknown>
}

function watchReportFields(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || utilTypes.isProxy(raw) || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw) as object | null)) throw new FeatureApiError('invalid-arguments')
  const names = ['role', 'playing', 'currentTime', 'decodedBytes', 'presentedFrames']
  if (Reflect.ownKeys(raw).length !== names.length) throw new FeatureApiError('invalid-arguments')
  const value: Record<string, unknown> = {}
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, name)
    if (!descriptor || !('value' in descriptor)) throw new FeatureApiError('invalid-arguments')
    value[name] = descriptor.value
  }
  return value
}
function noArgs(args: unknown): void { if (args !== undefined) throw new FeatureApiError('invalid-arguments') }
function string(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new FeatureApiError('invalid-arguments')
  return value
}
function streamId(value: unknown): StreamId { if (!isStreamId(value)) throw new FeatureApiError('invalid-arguments'); return value }
function account(value: unknown): string { if (!isDouyuAccountId(value)) throw new FeatureApiError('invalid-arguments'); return value }
function room(value: unknown): string { if (typeof value !== 'string' || !/^[1-9][0-9]{0,11}$/.test(value)) throw new FeatureApiError('invalid-arguments'); return value }
