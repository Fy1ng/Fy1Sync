import { types as utilTypes } from 'node:util'
import type { ApiResult } from '../src/app/apiClient'
import { FEATURE_METHODS, type FeatureMethod, type FeatureMethods, type FeatureCallContext, type FeatureEvent } from '../electron/featureContracts'
import type { DanmakuFeatures } from '../electron/danmakuFeatures'
import { composeMessage } from '../src/core/messageComposition'
import { readHistoryQuery } from './danmaku/messageHistory'
import { normalizeDouyuUid } from '../src/core/douyuMetadata'
import { isDouyuAccountId, type DouyuAccountManager } from '../electron/douyuAccounts'
import type { DouyuTaskManager } from '../electron/douyuTasks'
import type { DouyuInsightsGateway } from './douyu/insightsGateway'
import { DOUYU_MUTE_MINUTES, type DouyuModeration } from './douyu/moderation'
import type { DouyuInsightsService } from './douyu/insightsService'
import type { AppUpdateService } from '../electron/appUpdateService'
import { DouyuReadCache } from './douyu/readCache'

export type { FeatureCallContext, FeatureEvent } from '../electron/featureContracts'
export type FeatureHandler<K extends FeatureMethod> = (args: FeatureMethods[K]['args'], context: FeatureCallContext) => FeatureMethods[K]['result'] | Promise<FeatureMethods[K]['result']>
export type FeatureHandlers = { [K in FeatureMethod]?: FeatureHandler<K> }
export type WithFeatureAccount = <T>(accountId: string, run: (signal: AbortSignal) => T | Promise<T>) => Promise<T>
const ERROR_TEXT = {
  'invalid-arguments': '扩展接口参数无效.', 'not-available': '该后端服务尚不可用.', 'not-found': '未找到该功能或记录.',
  'account-changed': '活动账号已变化, 请重新读取或操作.', 'account-busy': '账号正在登录或退出, 请稍后重试.',
  'login-required': '请先登录当前斗鱼账号.', 'room-changed': '当前操作房间已变化, 请重新选择.',
  forbidden: '当前窗口无权执行该操作.', cancelled: '操作已取消.', 'service-closed': '本地扩展服务已关闭.',
  'favorite-limit': '本地弹幕收藏已达到容量上限, 请先删除部分收藏.',
  'room-limit': '最多收藏100个直播间, 请先删除部分收藏.',
  'storage-failed': '本地设置读取或保存失败, 请检查配置后重试.',
  'account-not-found': '斗鱼账号不存在.', 'account-limit': '斗鱼账号数量已达到上限.',
  'no-active-account': '请先选择当前斗鱼账号.', disposed: '本地服务已关闭.',
  'task-not-found': '未找到该任务.', 'task-limit': '任务数量已达到上限.', 'task-exists': '该账号在此房间已有相同任务.',
  empty: '请输入弹幕内容.', 'too-long': '组合后的弹幕超过本地 500 字符或 2000 字节上限.',
  'invalid-text': '弹幕包含不支持的字符.', 'invalid-options': '弹幕文案配置无效.',
  'verification-required': '请在斗鱼官方页面完成账号验证.', unavailable: '暂时无法安全读取或操作斗鱼数据.',
  'invalid-data': '斗鱼返回的数据不完整或无法确认.', busy: '已有操作正在执行, 请稍后重试.',
  disabled: '截图和 GIF 功能已关闭.', 'capture-busy': '已有 GIF 录制任务.',
  'recording-not-found': 'GIF 录制不存在.', 'capture-failed': '图片保存或 GIF 编码失败.',
  'stream-limit': '直播会话数量已达到上限.', 'stream-not-found': '直播会话不存在.',
  'stream-cancelled': '直播会话已关闭.', 'source-unavailable': '直播源尚未就绪.',
  'inventory-changed': '可赠库存已变化, 已停止后续赠送.', 'price-changed': '礼物价格或可赠状态已变化, 已停止后续赠送.',
  'balance-changed': '余额未知, 不足或已变化, 已停止后续赠送.', 'stale-plan': '赠礼计划已过期或状态已变化, 请重新预览.',
} as const
export type FeatureErrorCode = keyof typeof ERROR_TEXT
export class FeatureApiError extends Error {
  constructor(readonly code: FeatureErrorCode) { super(ERROR_TEXT[code]); this.name = 'FeatureApiError' }
}
const invalid = (): never => { throw new FeatureApiError('invalid-arguments') }
const whitelist: ReadonlySet<string> = new Set(FEATURE_METHODS)
type StoredHandler = (args: never, context: FeatureCallContext) => unknown

/** Extension dispatch only. DesktopService validates JSON data/size before delegation. */
export class FeatureApi {
  private readonly handlers = new Map<string, StoredHandler>()
  private readonly listeners = new Set<(event: FeatureEvent) => void>()
  private disposed = false
  constructor(handlers: FeatureHandlers = {}) { this.register(handlers) }
  register(handlers: FeatureHandlers): void
  register<K extends FeatureMethod>(method: K, handler: FeatureHandler<K>): void
  register<K extends FeatureMethod>(methodOrMap: K | FeatureHandlers, handler?: FeatureHandler<K>): void {
    if (this.disposed) throw new FeatureApiError('service-closed')
    const entries = typeof methodOrMap === 'string' ? [[methodOrMap, handler] as const] : Object.entries(fields(methodOrMap, [], FEATURE_METHODS))
    for (const [method, callback] of entries) {
      if (!whitelist.has(method) || method === 'activateDouyuRoom' || typeof callback !== 'function') throw new FeatureApiError('invalid-arguments')
    }
    for (const [method, callback] of entries) this.handlers.set(method, callback as StoredHandler)
  }
  has(method: unknown): method is FeatureMethod { return !this.disposed && typeof method === 'string' && this.handlers.has(method) }
  async invoke(method: unknown, args: unknown, context: FeatureCallContext = {}): Promise<ApiResult<unknown>> {
    if (this.disposed) return { ok: false, code: 'service-closed', message: ERROR_TEXT['service-closed'] }
    if (typeof method !== 'string' || !this.handlers.has(method)) return { ok: false, code: 'not-found', message: ERROR_TEXT['not-found'] }
    try {
      const { senderId } = fields(context, [], ['senderId'])
      if (senderId !== undefined && (typeof senderId !== 'number' || !Number.isSafeInteger(senderId) || senderId < 1)) throw new FeatureApiError('forbidden')
      const trustedContext = Object.freeze(senderId === undefined ? {} : { senderId: senderId as number })
      const value = await this.handlers.get(method)!(args as never, trustedContext)
      if (this.disposed) throw new FeatureApiError('service-closed')
      return { ok: true, value }
    } catch (error) {
      // Domain errors may carry upstream/custom messages. Only fixed public codes/text cross IPC.
      const isError = !utilTypes.isProxy(error) && error instanceof Error
      const descriptor = isError ? Object.getOwnPropertyDescriptor(error, 'code') : undefined
      const code: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined
      if (typeof code === 'string' && Object.hasOwn(ERROR_TEXT, code)) return { ok: false, code, message: ERROR_TEXT[code as FeatureErrorCode] }
      const name = isError ? Object.getOwnPropertyDescriptor(error, 'name') : undefined
      if ((name && 'value' in name && name.value === 'AbortError') || (!name && isError && error instanceof DOMException && error.name === 'AbortError')) {
        return { ok: false, code: 'cancelled', message: ERROR_TEXT.cancelled }
      }
      return { ok: false, code: 'internal-error', message: '本地服务无法完成此操作.' }
    }
  }
  subscribe(listener: (event: FeatureEvent) => void): () => void {
    if (!this.disposed) this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  publish(event: FeatureEvent): void {
    if (this.disposed) return
    const value = fields(event, ['topic', 'data'])
    if (typeof value.topic !== 'string' || !/^[a-zA-Z][a-zA-Z0-9:._-]{0,63}$/.test(value.topic)) throw new FeatureApiError('invalid-arguments')
    let snapshot: FeatureEvent
    try { snapshot = structuredClone({ topic: value.topic, data: value.data }) } catch { return invalid() }
    for (const listener of this.listeners) try { listener(structuredClone(snapshot)) } catch { /* A destroyed view cannot block other recipients. */ }
  }
  dispose(): void { this.disposed = true; this.handlers.clear(); this.listeners.clear() }
}

function fields(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  try {
    if (!raw || typeof raw !== 'object' || utilTypes.isProxy(raw) || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw) as object | null)) return invalid()
    const keys = [...required, ...optional]
    if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key))) return invalid()
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key)
      if (!descriptor) { if (required.includes(key)) return invalid(); continue }
      if (!('value' in descriptor)) return invalid()
      result[key] = descriptor.value
    }
    return result
  } catch { return invalid() }
}
const room = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]{0,11}$/.test(value) ? value : invalid()
const account = (value: unknown): string => isDouyuAccountId(value) ? value : invalid()
const uid = (value: unknown): string => normalizeDouyuUid(value) || invalid()
const boundedText = (value: unknown, limit: number): string => typeof value === 'string' && !!value.trim() && value.length <= limit && !/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value) ? value : invalid()
const noArgs = (args: unknown): void => { if (args !== undefined) invalid() }
const requiredService = <T>(service: T | undefined): T => { if (!service) throw new FeatureApiError('not-available'); return service }
function query(raw: unknown) { try { return readHistoryQuery(fields(raw === undefined ? {} : raw, [], ['room', 'uid', 'query', 'page', 'pageSize'])) } catch { return invalid() } }

/** Reject promptly on invalidation even when an injected provider ignores AbortSignal. */
function abortable<T>(signal: AbortSignal, run: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new FeatureApiError('cancelled')) }
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    const settle = (finish: () => void) => { signal.removeEventListener('abort', aborted); if (signal.aborted) aborted(); else finish() }
    try { Promise.resolve(run()).then(value => settle(() => resolve(value)), error => settle(() => reject(error))) }
    catch (error) { settle(() => reject(error)) }
  })
}

/** Per-operation account generation guard, including switch-away-and-back and re-login. */
export function createFeatureAccountGuard(accounts: Pick<DouyuAccountManager, 'activeAccountId' | 'isBusy' | 'activeLoginStatus' | 'subscribe'>,
  lifetime?: AbortSignal): WithFeatureAccount {
  return async <T>(accountId: string, run: (signal: AbortSignal) => T | Promise<T>): Promise<T> => {
    account(accountId)
    if (accounts.activeAccountId !== accountId) throw new FeatureApiError('account-changed')
    if (accounts.isBusy(accountId)) throw new FeatureApiError('account-busy')
    const owner = new AbortController()
    const combined = lifetime ? AbortSignal.any([lifetime, owner.signal]) : owner.signal
    const release = accounts.subscribe(event => {
      if (event.type === 'changed' || accounts.activeAccountId !== accountId || accounts.isBusy(accountId)
        || (event.type === 'invalidated' && event.accountId === accountId)) owner.abort()
    })
    const current = () => {
      if (lifetime?.aborted) throw new FeatureApiError('cancelled')
      if (combined.aborted || accounts.activeAccountId !== accountId || accounts.isBusy(accountId)) throw new FeatureApiError('account-changed')
    }
    try {
      current()
      const status = await abortable(combined, () => accounts.activeLoginStatus())
      current()
      if (!status.loggedIn) throw new FeatureApiError('login-required')
      const value = await abortable(combined, () => run(combined))
      current()
      return value
    } catch (error) { current(); throw error }
    finally { release() }
  }
}

export interface DanmakuHandlerDependencies {
  features?: DanmakuFeatures
  moderation?: Pick<DouyuModeration, 'preflight' | 'mute'>
  tasks?: Pick<DouyuTaskManager, 'snapshot' | 'sendMessage'>
  withAccount: WithFeatureAccount
  openExternal: (url: string) => void | Promise<void>
}
export function createDanmakuHandlers(deps: DanmakuHandlerDependencies): FeatureHandlers {
  const features = () => requiredService(deps.features)
  const requireRoom = (target: string) => {
    if (requiredService(deps.tasks).snapshot().currentRoom !== target) throw new FeatureApiError('room-changed')
  }
  return {
    getDanmakuFeatures: args => { noArgs(args); return features().snapshot() },
    setDanmakuPreferences: args => features().updatePreferences(args),
    setMessageAffixes: args => features().updateAffixes(args),
    queryDanmakuHistory: args => features().searchHistory(query(args)),
    queryDanmakuFavorites: args => features().searchFavorites(query(args)),
    addDanmakuFavorite: args => {
      const value = fields(args, ['text'], ['room', 'uid', 'username'])
      return features().addFavorite({ text: boundedText(value.text, 2_000),
        ...(value.room === undefined ? {} : { room: room(value.room) }), ...(value.uid === undefined ? {} : { uid: uid(value.uid) }),
        ...(value.username === undefined ? {} : { username: boundedText(value.username, 128) }) })
    },
    updateDanmakuFavorite: args => {
      const value = fields(args, ['id', 'text'])
      return features().updateFavorite(boundedText(value.id, 160), { text: boundedText(value.text, 2_000) })
    },
    removeDanmakuFavorite: args => {
      const value = fields(args, ['id'])
      features().removeFavorite(boundedText(value.id, 160))
      return { removed: true }
    },
    getDanmakuRate: args => features().rate(room(fields(args, ['room']).room)),
    getDanmakuUserDetails: args => {
      const value = fields(args, ['room', 'uid'])
      return features().userDetails(room(value.room), uid(value.uid))
    },
    openDanmakuHistory: async args => {
      const value = fields(args, ['uid'])
      await deps.openExternal(features().externalHistoryUrl(uid(value.uid)))
      return { opened: true }
    },
    getDouyuDelivery: args => {
      const value = fields(args, ['accountId', 'id'])
      const id = boundedText(value.id, 160), accountId = account(value.accountId)
      return deps.withAccount(accountId, () => {
        const result = features().deliveries.get(id)
        return result?.accountId === accountId ? result : null
      })
    },
    sendComposedDouyuMessage: args => {
      const value = fields(args, ['accountId', 'room', 'text', 'color'], ['mode'])
      const accountId = account(value.accountId), target = room(value.room), mode = value.mode ?? 'message'
      if (mode !== 'message' && mode !== 'repeat') return invalid()
      if (typeof value.color !== 'number' || !Number.isInteger(value.color) || value.color < 0 || value.color > 6) return invalid()
      const text = composeMessage(boundedText(value.text, 500), { affixes: features().snapshot().affixes, mode })
      const color = value.color
      return deps.withAccount(accountId, () => {
        requireRoom(target)
        return requiredService(deps.tasks).sendMessage({ accountId, room: target, text, color })
      })
    },
    previewDouyuMute: args => {
      const value = fields(args, ['accountId', 'room'])
      const accountId = account(value.accountId), target = room(value.room)
      return deps.withAccount(accountId, signal => { requireRoom(target); return requiredService(deps.moderation).preflight({ accountId, room: target }, signal) })
    },
    muteDouyuUser: args => {
      const value = fields(args, ['accountId', 'room', 'username', 'minutes'])
      const accountId = account(value.accountId), target = room(value.room), username = boundedText(value.username, 64)
      if (typeof value.minutes !== 'number' || !(DOUYU_MUTE_MINUTES as readonly number[]).includes(value.minutes)) return invalid()
      const minutes = value.minutes
      return deps.withAccount(accountId, signal => { requireRoom(target); return requiredService(deps.moderation).mute({ accountId, room: target, username, minutes }, signal) })
    },
  }
}

export interface InsightsHandlerDependencies {
  insights?: Pick<DouyuInsightsService, 'snapshot' | 'refreshRoom' | 'reportPlayback' | 'setNotifications' | 'startFollowMonitor' | 'stopFollowMonitor'>
  gateway?: Pick<DouyuInsightsGateway, 'readFollowedRooms' | 'readBadgeAges' | 'readMonthlySpending' | 'readWatchTime'>
  update?: Pick<AppUpdateService, 'check' | 'state'>
  withAccount: WithFeatureAccount
  lifetime?: AbortSignal
  readCache?: DouyuReadCache
}
export function createInsightsHandlers(deps: InsightsHandlerDependencies): FeatureHandlers {
  const insights = () => requiredService(deps.insights)
  const gateway = () => requiredService(deps.gateway)
  const lifetime = deps.lifetime ?? new AbortController().signal
  const cache = deps.readCache ?? new DouyuReadCache()
  return {
    getDouyuRoomInsights: args => insights().snapshot(room(fields(args, ['room']).room)),
    refreshDouyuRoomInsights: args => insights().refreshRoom(room(fields(args, ['room']).room), lifetime),
    getDouyuFollowedRooms: args => {
      const value = fields(args, ['accountId'], ['refresh'])
      const id = account(value.accountId)
      if (value.refresh !== undefined && typeof value.refresh !== 'boolean') return invalid()
      return deps.withAccount(id, signal => cache.read('followed', id, '', value.refresh as boolean | undefined, () => gateway().readFollowedRooms(id, signal)))
    },
    getDouyuBadgeAges: args => {
      const id = account(fields(args, ['accountId']).accountId)
      return deps.withAccount(id, signal => gateway().readBadgeAges(id, signal))
    },
    getDouyuMonthlySpending: args => {
      const id = account(fields(args, ['accountId']).accountId)
      return deps.withAccount(id, signal => gateway().readMonthlySpending(id, signal))
    },
    getDouyuWatchTime: args => {
      const value = fields(args, ['accountId', 'room'], ['refresh'])
      const id = account(value.accountId), target = room(value.room)
      if (value.refresh !== undefined && typeof value.refresh !== 'boolean') return invalid()
      return deps.withAccount(id, signal => cache.read('watch', id, target, value.refresh as boolean | undefined, () => gateway().readWatchTime(id, target, signal)))
    },
    reportDouyuPlayback: (args, context) => {
      const value = fields(args, ['room', 'playing'])
      if (typeof value.playing !== 'boolean') return invalid()
      if (!Number.isSafeInteger(context.senderId) || context.senderId! < 1) throw new FeatureApiError('forbidden')
      return insights().reportPlayback(room(value.room), value.playing, 'window:' + context.senderId)
    },
    setDouyuLiveNotifications: args => {
      const value = fields(args, ['enabled'], ['rooms', 'accountId'])
      if (typeof value.enabled !== 'boolean') return invalid()
      const enabled = value.enabled
      if (value.rooms !== undefined && (!Array.isArray(value.rooms) || value.rooms.length > 64)) return invalid()
      const rawRooms = value.rooms as unknown[] | undefined ?? []
      if (utilTypes.isProxy(rawRooms) || Reflect.ownKeys(rawRooms).length !== rawRooms.length + 1) return invalid()
      const rooms = Array.from({ length: rawRooms.length }, (_, index) => {
        const entry = Object.getOwnPropertyDescriptor(rawRooms, String(index))
        return entry && 'value' in entry ? room(entry.value) : invalid()
      })
      if (new Set(rooms).size !== rooms.length) return invalid()
      const id = value.accountId === undefined ? null : account(value.accountId)
      const apply = () => {
        insights().setNotifications(enabled, rooms)
        if (enabled && id) insights().startFollowMonitor(id)
        else insights().stopFollowMonitor()
        return { enabled, rooms, followedAccountId: enabled ? id : null }
      }
      return enabled && id ? deps.withAccount(id, apply) : apply()
    },
    checkAppUpdate: args => { noArgs(args); return requiredService(deps.update).check() },
    getAppUpdateState: args => { noArgs(args); return requiredService(deps.update).state() },
  }
}
