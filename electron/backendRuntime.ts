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

export interface BackendRuntimeOptions {
  userDataDir: string
  proxy: ProxyConfig
  acquisition: Acquisition
  relay: DanmakuRelay
  danmaku: DanmakuFeatures
  accounts?: DouyuAccountManager
  tasks?: DouyuTaskManager
  sender?: DouyuMessageSender
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
  const esports = new EsportsService({ userDataDir: options.userDataDir, version: appPackage.version })
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
  api.register(createInsightsHandlers({ insights, gateway: insightsGateway, update, withAccount, lifetime: lifetime.signal }))
  const captureChanged = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try { return await run() } finally { api.publish({ topic: 'capture', data: capture.state() }) }
  }
  const operations: FeatureHandlers = {
    getCs2Schedule: args => esports.getCs2Schedule(args),
    getStreamTitles: args => esports.getStreamTitles(args),
    openAppReleasePage: async args => {
      noArgs(args)
      const url = update.state().releaseUrl
      if (!url) throw new FeatureApiError('not-available')
      await options.openExternal(url)
      return { opened: true }
    },
    getStreamSessions: args => { noArgs(args); return streams.snapshot() },
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
      return pip.report(context.senderId!, args)
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
      fields(args, ['accountId'], ['room']); const id = account(args.accountId)
      return withAccount(id, () => required(inventory).read(id, args.room))
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
    insights.subscribe(data => api.publish({ topic: 'insights', data })))
  if (automations) releases.push(automations.subscribe(data => api.publish({ topic: 'automations', data })))
  releases.push(options.relay.observe(event => {
    // Huya is receive-only: no delivery tracking, history, catalog fetch or Douyu statistics.
    if (event.platform === 'huya') return
    if (event.type === 'message' && (event.message.platform === 'huya' || event.message.room.startsWith('huya:'))) return
    if (event.type === 'signal' && event.signal.platform === 'huya') return
    if (event.type === 'state' && event.room.startsWith('huya:')) return
    if (event.type === 'message') { options.danmaku.observe(event.message); insights.observe(event.message) }
    else if (event.type === 'signal') {
      if (event.signal.kind !== 'viewers') insights.signal(event.signal)
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
    if (pip.state().streamId === state.role && (state.state === 'starting' || state.state === 'stopped')) pip.close()
  }))
  if (options.tasks) releases.push(options.tasks.subscribe(() => {
    if (pip.windowId() !== null) api.publish({ topic: 'pip', data: pip.state() })
  }))
  if (options.accounts) {
    let previous = options.accounts.activeAccountId
    releases.push(options.accounts.subscribe(event => {
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
    api, streams, pip, capture, automations, insights,
    observeFixture: (message: Parameters<DanmakuFeatures['observe']>[0]) => {
      if (message.platform === 'huya' || message.room.startsWith('huya:')) return
      options.danmaku.observe(message); insights.observe(message)
    },
    async dispose() {
      lifetime.abort()
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
function noArgs(args: unknown): void { if (args !== undefined) throw new FeatureApiError('invalid-arguments') }
function string(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new FeatureApiError('invalid-arguments')
  return value
}
function streamId(value: unknown): StreamId { if (!isStreamId(value)) throw new FeatureApiError('invalid-arguments'); return value }
function account(value: unknown): string { if (!isDouyuAccountId(value)) throw new FeatureApiError('invalid-arguments'); return value }
function room(value: unknown): string { if (typeof value !== 'string' || !/^[1-9][0-9]{0,11}$/.test(value)) throw new FeatureApiError('invalid-arguments'); return value }
