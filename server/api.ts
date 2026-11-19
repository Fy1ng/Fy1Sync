/** Main-process services without Electron imports or a network listener. */

import { isDomesticRouting, type NetworkPreferencesService } from '../electron/networkPreferences'
import { timeoutSignal, validMediaNetwork } from './mediaNetworkOptions'
import { MAX_MEDIA_INPUT_LENGTH } from '../src/core/mediaInput'
import { types as utilTypes } from 'node:util'
import { diagnosticDetails } from './errorDetails'
import { httpErrorDetails } from './httpError'
import { type NetworkContext } from './networkPolicy'
import { StreamFailureError, classifyNetworkFailure, httpFailure, streamFailureForCode, streamFailureHint, type StreamFailure } from './networkFailure'
import appPackage from '../package.json'
import { createDouyuRoomResolver, type ResolveDouyuRoom } from './platforms/douyuRoom'
import { resolveHuyaDanmakuRoom, type HuyaDanmakuRoom } from './platforms/huyaDanmaku'
import { resolveDouyinDanmakuRoom } from './platforms/douyinDanmaku'
import { createNetworkSocket } from './danmaku/networkSocket'
import type { ApiResult } from '../src/app/apiClient'
import { mediaRequestPolicy, type ProxyConfig } from './config'
import { mediaChild, mediaEntry, type MediaAccess } from './mediaAccess'
import { DanmakuRelay } from './danmaku/relay'
import { resolveStream, type PlatformKind, type ResolveResult } from './platforms'
import { isYouTubeFormatFailure, isYouTubeRefusal, YOUTUBE_FORMAT_FAILURES, YOUTUBE_REFUSALS } from './platforms/youtube'
import { checkUrlSyntax, ProxyError, safeFetch } from './safeFetch'
import type { SourceRole } from '../src/core/types'
import type { BufferState } from '../electron/bufferManager'
import type { LoginPlatform, LoginResult, LoginStatus } from '../electron/login'
import { isLoginPlatform } from '../electron/cookies'
import { isDecoderMode, type DecoderPreferencesService } from '../electron/decoderPreferences'
import type { ToolsService } from '../electron/toolsService'
import type { AcquisitionDiagnosticsService } from '../electron/diagnosticContracts'
import { DouyuAccountError, isDouyuAccountId, type DouyuAccountManager } from '../electron/douyuAccounts'
import { DouyuTaskError, type DouyuTaskManager } from '../electron/douyuTasks'
import { DOUYU_TASK_KINDS, DOUYU_TASK_POLICIES, isDouyuActivityKind, type DouyuTaskKind, type DouyuTaskPolicy, type DouyuTasksSnapshot } from './douyu/types'
import { readMessageSchedule } from './douyu/taskConfig'
import { readPlatformBytes, readPlatformText } from './platformResponse'
import { DouyuRenewalError, readRenewalRooms, readRenewalQuantities, type DouyuRenewalService } from './douyu/renewalService'
import type { FeatureApi } from './featureApi'
import type { FeatureCallContext, FeatureEvent } from '../electron/featureContracts'
import type { DouyinMessageSender } from './douyin/messageSender'
import { douyinMessageRoom, douyinMessageText } from '../src/core/douyinMessage'

export interface AcquisitionService {
  resolve(input: string, platform: PlatformKind | undefined, role: SourceRole, quality?: string, preferAdaptive?: boolean): Promise<ResolveResult>
  switchQuality(role: SourceRole, quality: string): Promise<ResolveResult>
  stop(role: SourceRole): Promise<void>
  subscribe(listener: (state: BufferState) => void): () => void
  login(platform: LoginPlatform): Promise<LoginResult>
  loginStatus(): Promise<LoginStatus>
  logout(platform: LoginPlatform): Promise<void>
}

export type DesktopServiceDeps = {
  dataDir: string
  proxy: ProxyConfig
  relay?: DanmakuRelay
  fetchImpl?: typeof fetch
  registerMedia: (url: string, access?: MediaAccess, headers?: Record<string, string>) => string
  resolveDouyuRoom?: ResolveDouyuRoom
  resolveHuyaRoom?: (input: string) => Promise<HuyaDanmakuRoom>
  acquisition?: AcquisitionService
  decoderPreferences?: DecoderPreferencesService
  networkPreferences?: NetworkPreferencesService
  tools?: ToolsService
  diagnostics?: AcquisitionDiagnosticsService
  douyuAccounts?: DouyuAccountManager
  douyuTasks?: DouyuTaskManager
  douyuRenewal?: DouyuRenewalService
  douyinMessages?: Pick<DouyinMessageSender, 'state' | 'send'>
  features?: FeatureApi
}

export type DesktopService = {
  invoke: (method: unknown, args: unknown, context?: FeatureCallContext & { readonly isCurrent?: () => boolean }) => Promise<ApiResult<unknown>>
  relay: DanmakuRelay
  resolveDouyuRoom: ResolveDouyuRoom
  resolveHuyaRoom: (input: string) => Promise<HuyaDanmakuRoom>
  dispose: () => void
  subscribeBuffer?: (listener: (state: BufferState) => void) => () => void
  subscribeDouyuAccounts?: (listener: (state: import('./douyu/types').DouyuAccountsSnapshot) => void) => () => void
  subscribeDouyuTasks?: (listener: (state: DouyuTasksSnapshot) => void) => () => void
  subscribeFeatures?: (listener: (event: FeatureEvent) => void) => () => void
  setDouyuRoom?: (room: string | null) => void
}

const MAX_INPUT_LENGTH = 8_192
const MAX_ARGS_BYTES = 2 * 1_048_576 + 16_384
const MAX_VALUE_DEPTH = 32

function fail(code: string, message: string, detail?: unknown): ApiResult<never> {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail: diagnosticDetails(detail) }
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Reject executable/custom values before reading their properties or serializing them. */
function jsonData(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > MAX_VALUE_DEPTH) return false
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || (!Array.isArray(value) && !record(value)) || seen.has(value)) return false
  seen.add(value)
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor) || !jsonData(descriptor.value, seen, depth + 1)) return false
  }
  seen.delete(value)
  return true
}

function fields(args: unknown, required: string[], optional: string[] = []): args is Record<string, unknown> {
  return record(args)
    && required.every((key) => Object.hasOwn(args, key))
    && Object.keys(args).every((key) => required.includes(key) || optional.includes(key))
}

function isPlatform(value: unknown): value is PlatformKind {
  return value === 'youtube' || value === 'direct' || value === 'twitch' || value === 'douyu' || value === 'bilibili' || value === 'huya' || value === 'douyin'
}

function isRole(value: unknown): value is SourceRole { return value === 'official' || value === 'commentary' }

/** Only fixture-relative paths may bypass remote-media registration. */
function fixturePath(input: string): boolean {
  return /^\/test-sources\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:m3u8|m3u|mp4|webm|mov|mkv|ts)$/.test(input)
}

export function sanitizedFailure(result: ResolveResult): ResolveResult {
  if (result.ok) return result
  const detail = diagnosticDetails(result.failure.detail ?? result.failure)
  // YouTube's fixed refusal wording says what to do about it; the generic line below would hide that.
  const reason = result.failure.reason
  if (result.failure.code === 'restricted' && isYouTubeRefusal(reason)) {
    return { ok: false, failure: { code: 'restricted', reason, ...YOUTUBE_REFUSALS[reason], detail } }
  }
  if (result.failure.code === 'needs-manual-url' && isYouTubeFormatFailure(reason)) {
    return { ok: false, failure: { code: 'needs-manual-url', reason, ...YOUTUBE_FORMAT_FAILURES[reason], detail } }
  }
  const network = streamFailureForCode(reason)
    ?? (result.failure.code === 'upstream-error' && result.failure.stage ? classifyNetworkFailure(undefined, result.failure.stage) : undefined)
  if (network) return resolvedFailure({ ...network, detail })
  const messages = {
    'unsupported-url': '无法识别该媒体地址或平台',
    'not-live': '直播当前未开始或受限制',
    'room-not-found': '未找到该直播间',
    'upstream-error': '无法获取平台播放信息',
    'login-required': '平台要求登录或登录信息已失效',
    restricted: '平台限制了此媒体的访问',
    'needs-manual-url': '平台没有提供可播放地址',
  }
  return { ok: false, failure: {
    code: result.failure.code, message: messages[result.failure.code], detail,
    hint: result.failure.code === 'restricted' || result.failure.code === 'login-required'
      ? '请在「设置 > 账号」登录后重新载入，也可粘贴视频直链'
      : '请检查地址及开播状态，也可粘贴视频直链',
  } }
}

function resolvedFailure(failure: StreamFailure): ResolveResult {
  const safe = streamFailureForCode(failure.code) ?? classifyNetworkFailure(undefined, failure.stage)
  return { ok: false, failure: { code: 'upstream-error', stage: safe.stage, reason: safe.code, message: safe.message,
    hint: streamFailureHint(safe.code), detail: diagnosticDetails(failure.detail ?? failure), ...(safe.status === undefined ? {} : { status: safe.status }) } }
}

/** The Electron IPC boundary checks the sender before calling any service method. */
export function createDesktopService(deps: DesktopServiceDeps): DesktopService {
  const resolveHuyaRoom = deps.resolveHuyaRoom ?? (input => resolveHuyaDanmakuRoom(input, createResolverDeps(deps.proxy, deps.registerMedia, deps.fetchImpl).fetchText))
  const relay = deps.relay ?? new DanmakuRelay({ huya: { resolveRoom: resolveHuyaRoom },
    douyin: {
      resolveRoom: webRoom => resolveDouyinDanmakuRoom(webRoom, createResolverDeps(deps.proxy, deps.registerMedia, deps.fetchImpl)),
      createSocket: (url, headers) => createNetworkSocket(url, 'douyin', { headers }),
    },
  })
  let disposed = false
  const resolveRoom = deps.resolveDouyuRoom ?? createDouyuRoomResolver(deps.proxy, deps.fetchImpl).resolve

  return {
    relay,
    resolveHuyaRoom: input => disposed ? Promise.reject(new Error('本地服务已关闭')) : resolveHuyaRoom(input),
    resolveDouyuRoom: input => disposed ? Promise.resolve({ ok: false, failure: { code: 'upstream-error', message: '本地服务已关闭' } }) : resolveRoom(input),
    subscribeBuffer: deps.acquisition ? (listener) => deps.acquisition!.subscribe(listener) : undefined,
    subscribeDouyuAccounts: deps.douyuAccounts ? listener => deps.douyuAccounts!.subscribeSnapshots(listener) : undefined,
    subscribeDouyuTasks: deps.douyuTasks ? listener => deps.douyuTasks!.subscribe(listener) : undefined,
    subscribeFeatures: deps.features ? listener => {
      const emit = (event: FeatureEvent) => { if (!disposed) listener(event) }
      const releases = [deps.features?.subscribe(emit)]
      return () => { for (const release of releases) release?.() }
    } : undefined,
    setDouyuRoom: deps.douyuTasks ? room => deps.douyuTasks!.setRoom(room) : undefined,
    async invoke(method, args, context) {
      if (disposed) return fail('service-closed', '本地服务已关闭')
      if (typeof method !== 'string') return fail('not-found', '未知本地接口')
      try {
        if (!jsonData(args)) return fail('invalid-arguments', '接口参数必须是有效的数据对象')
        const serialized = JSON.stringify(args)
        const argumentLimit = method === 'savePlaybackScreenshot' || method === 'appendGifFrame' ? 12 * 1_048_576 : MAX_ARGS_BYTES
        if (serialized !== undefined && Buffer.byteLength(serialized) > argumentLimit) {
          return fail('too-large', '接口参数超过大小上限')
        }
        if (deps.features?.has(method)) return deps.features.invoke(method, args, context)

        switch (method) {
          case 'getDouyinSendState': {
            if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args)
              || Object.keys(args).length !== 1 || (args as { refresh?: unknown }).refresh !== true)) return fail('invalid-arguments', '抖音账号刷新参数无效')
            if (!deps.douyinMessages) return fail('not-available', '抖音发送服务不可用')
            return { ok:true, value:await deps.douyinMessages.state(undefined, args !== undefined) }
          }
          case 'sendDouyinMessage': {
            if (!fields(args, ['room','text','expectedUid']) || !douyinMessageRoom(args.room) || !douyinMessageText(args.text)
              || typeof args.expectedUid !== 'string' || !/^[1-9]\d{0,19}$/.test(args.expectedUid)) return fail('invalid-arguments', '抖音发送参数无效')
            if (!context?.isCurrent?.()) return fail('room-changed', '请先在当前窗口连接目标抖音房间')
            if (!deps.douyinMessages) return fail('not-available', '抖音发送服务不可用')
            return { ok:true, value:await deps.douyinMessages.send({ room:args.room, text:douyinMessageText(args.text)!, expectedUid:args.expectedUid }, undefined, context.isCurrent) }
          }
          case 'listDouyuAccounts': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            if (!deps.douyuAccounts) return fail('not-available', '斗鱼账号配置不可用，请检查本地配置后重试')
            return { ok: true, value: await deps.douyuAccounts.snapshot() }
          }
          case 'addDouyuAccount': {
            if (!fields(args, ['label']) || typeof args.label !== 'string') return fail('invalid-arguments', '账号名称无效')
            if (!deps.douyuAccounts) return fail('not-available', '斗鱼账号配置不可用')
            return { ok: true, value: await deps.douyuAccounts.add(args.label) }
          }
          case 'renameDouyuAccount': {
            if (!fields(args, ['id', 'label']) || !isDouyuAccountId(args.id) || typeof args.label !== 'string') return fail('invalid-arguments', '账号参数无效')
            if (!deps.douyuAccounts) return fail('not-available', '斗鱼账号配置不可用')
            return { ok: true, value: await deps.douyuAccounts.rename(args.id, args.label) }
          }
          case 'loginDouyuAccount':
          case 'loginDouyuYubaAccount':
          case 'activateDouyuAccount':
          case 'logoutDouyuAccount':
          case 'removeDouyuAccount': {
            if (!fields(args, ['id']) || !isDouyuAccountId(args.id)) return fail('invalid-arguments', '账号参数无效')
            const accounts = deps.douyuAccounts
            if (!accounts) return fail('not-available', '斗鱼账号配置不可用')
            if (!accounts.hasAccount(args.id)) return fail('account-not-found', '斗鱼账号不存在')
            if (accounts.isBusy(args.id)) return fail('account-busy', '账号正在登录或退出，请稍后重试')
            if (method === 'removeDouyuAccount') {
              deps.douyuTasks?.removeAccount(args.id)
              return { ok: true, value: await accounts.remove(args.id) }
            }
            const action = method === 'loginDouyuAccount' ? 'login' : method === 'loginDouyuYubaAccount' ? 'loginYuba'
              : method === 'activateDouyuAccount' ? 'activate' : 'logout'
            return { ok: true, value: await accounts[action](args.id) }
          }
          case 'openDouyuTaskRoom': {
            if (!fields(args, ['id']) || typeof args.id !== 'string' || args.id.length > 64) return fail('invalid-arguments', '任务参数无效')
            const accounts = deps.douyuAccounts
            const tasks = deps.douyuTasks
            if (!accounts || !tasks) return fail('not-available', '斗鱼任务管理不可用')
            const task = tasks.snapshot().tasks.find(item => item.id === args.id)
            if (!task || !isDouyuActivityKind(task.kind)) return fail('task-not-found', '活动任务不存在')
            if (task.accountId !== accounts.activeAccountId) return fail('no-active-account', '请先切换到任务所属账号')
            if (accounts.isBusy(task.accountId)) return fail('account-busy', '该账号的官方窗口已打开，请先完成并关闭窗口')
            tasks.pause(task.id, '官方房间已打开，完成人工处理后请手动启动任务')
            tasks.pauseAccount(task.accountId, '官方房间已打开，完成人工处理后请手动启动任务')
            return { ok: true, value: await accounts.openRoom(task.accountId, task.officialRoom ?? task.room, task.kind === 'auto-fish' ? 'fish-act' : 'room') }
          }
          case 'getDouyuTasks': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            if (!deps.douyuTasks) return fail('not-available', '斗鱼任务配置不可用，原文件已保留')
            return { ok: true, value: deps.douyuTasks.snapshot() }
          }
          case 'getDouyuRenewalTargets':
          case 'previewDouyuRenewal': {
            const preview = method === 'previewDouyuRenewal'
            if (!fields(args, preview ? ['accountId', 'rooms', 'quantity'] : ['accountId'], preview ? ['quantities'] : []) || !isDouyuAccountId(args.accountId)) return fail('invalid-arguments', '续牌赠送参数无效')
            const accountId = args.accountId
            const rooms = preview ? readRenewalRooms(args.rooms) : null
            const quantity = preview ? args.quantity : null
            const quantities = preview ? readRenewalQuantities(args.quantities, rooms!) : undefined
            if (preview && (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000)) return fail('invalid-arguments', '赠送数量无效')
            const accounts = deps.douyuAccounts
            if (!deps.douyuRenewal || !accounts || !deps.douyuTasks) return fail('not-available', '续牌赠送服务不可用')
            if (accounts.activeAccountId !== accountId || accounts.isBusy(accountId)) return fail('account-changed', '请先登录并激活所选账号')
            const originRoom = deps.douyuTasks.snapshot().currentRoom
            if (!(await accounts.activeLoginStatus()).loggedIn) return fail('login-required', '请先登录当前斗鱼账号')
            if (disposed) return fail('service-closed', '本地服务已关闭')
            if (accounts.activeAccountId !== accountId || accounts.isBusy(accountId) || deps.douyuTasks.snapshot().currentRoom !== originRoom) return fail('account-changed', '账号或房间已变化，请重新读取')
            return { ok: true, value: preview ? await deps.douyuRenewal.preview(accountId, rooms!, quantity as number, quantities)
              : await deps.douyuRenewal.targets(accountId) }
          }
          case 'executeDouyuRenewal':
          case 'cancelDouyuRenewal': {
            if (!fields(args, ['planId']) || typeof args.planId !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(args.planId)) return fail('invalid-arguments', '核对单无效，请重新生成')
            if (!deps.douyuRenewal) return fail('not-available', '续牌赠送服务不可用')
            return { ok: true, value: method === 'executeDouyuRenewal' ? await deps.douyuRenewal.execute(args.planId) : deps.douyuRenewal.cancel(args.planId) }
          }
          case 'sendDouyuMessage': {
            if (!fields(args, ['accountId', 'room', 'text', 'color']) || !isDouyuAccountId(args.accountId)
              || typeof args.room !== 'string' || !/^[1-9]\d{0,11}$/.test(args.room)
              || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 500
              || !Number.isInteger(args.color) || Number(args.color) < 0 || Number(args.color) > 6) {
              return fail('invalid-arguments', '弹幕参数无效')
            }
            const accounts = deps.douyuAccounts
            const tasks = deps.douyuTasks
            const message = { accountId: args.accountId, room: args.room, text: args.text, color: Number(args.color) }
            if (!accounts || !tasks) return fail('not-available', '斗鱼发送服务不可用')
            if (message.accountId !== accounts.activeAccountId) return fail('no-active-account', '当前账号已变化，请确认后重新操作')
            if (accounts.isBusy(message.accountId)) return fail('account-busy', '账号正在登录或退出，请稍后发送')
            if (tasks.snapshot().currentRoom !== message.room) return fail('room-changed', '当前房间已变化，请确认房间后重新操作')
            if (!(await accounts.activeLoginStatus()).loggedIn) return fail('login-required', '请到「设置 > 账号 > 斗鱼」登录当前账号')
            if (disposed) return fail('service-closed', '本地服务已关闭')
            if (message.accountId !== accounts.activeAccountId || accounts.isBusy(message.accountId)) return fail('no-active-account', '账号状态已变化，请确认后重新操作')
            return { ok: true, value: await tasks.sendMessage(message) }
          }
          case 'createDouyuTask': {
            if (!fields(args, ['accountId', 'roomInput', 'kind', 'policy', 'repeatMinutes'], ['message']) || !isDouyuAccountId(args.accountId)
              || typeof args.roomInput !== 'string' || args.roomInput.length > MAX_INPUT_LENGTH || !DOUYU_TASK_KINDS.includes(args.kind as DouyuTaskKind)
              || !DOUYU_TASK_POLICIES.includes(args.policy as DouyuTaskPolicy)) {
              return fail('invalid-arguments', '任务参数无效')
            }
            const message = args.kind === 'message-loop' ? readMessageSchedule(args.message) : null
            if (isDouyuActivityKind(args.kind) && args.repeatMinutes !== null) return fail('invalid-arguments', '活动任务按官方状态安排时间，不接受重复周期')
            if (args.kind === 'message-loop' ? !message || args.repeatMinutes !== null
              : Object.hasOwn(args, 'message') || (args.repeatMinutes !== null && (!Number.isInteger(args.repeatMinutes) || Number(args.repeatMinutes) < 60 || Number(args.repeatMinutes) > 43200))) {
              return fail('invalid-arguments', '任务参数无效')
            }
            const input = { accountId: args.accountId, kind: args.kind as DouyuTaskKind, policy: args.policy as DouyuTaskPolicy,
              repeatMinutes: args.repeatMinutes as number | null, ...(message ? { message } : {}) }
            if (!deps.douyuTasks || !deps.douyuAccounts) return fail('not-available', '斗鱼任务管理不可用')
            const resolved = await resolveRoom(args.roomInput)
            if (!resolved.ok) return fail(resolved.failure.code, resolved.failure.message)
            if (disposed) return fail('service-closed', '本地服务已关闭')
            if (!deps.douyuAccounts.hasAccount(input.accountId)) return fail('account-not-found', '斗鱼账号不存在')
            return { ok: true, value: deps.douyuTasks.create({ ...input, room: resolved.identity.room }) }
          }
          case 'setDouyuTaskPolicy': {
            if (!fields(args, ['id', 'policy']) || typeof args.id !== 'string' || args.id.length > 64
              || !DOUYU_TASK_POLICIES.includes(args.policy as DouyuTaskPolicy)) return fail('invalid-arguments', '任务参数无效')
            if (!deps.douyuTasks) return fail('not-available', '斗鱼任务管理不可用')
            return { ok: true, value: deps.douyuTasks.setPolicy(args.id, args.policy as DouyuTaskPolicy) }
          }
          case 'startDouyuTask':
          case 'pauseDouyuTask':
          case 'removeDouyuTask': {
            if (!fields(args, ['id']) || typeof args.id !== 'string' || args.id.length > 64) return fail('invalid-arguments', '任务参数无效')
            if (!deps.douyuTasks || !deps.douyuAccounts) return fail('not-available', '斗鱼任务管理不可用')
            if (method === 'startDouyuTask') {
              const task = deps.douyuTasks.snapshot().tasks.find(task => task.id === args.id)
              if (!task) return fail('task-not-found', '任务不存在')
              if (task.accountId !== deps.douyuAccounts.activeAccountId) return fail('no-active-account', '请先切换到任务所属账号')
              if (deps.douyuAccounts.isBusy(task.accountId)) return fail('account-busy', '账号正在登录或退出，请稍后启动任务')
              if (!(await deps.douyuAccounts.activeLoginStatus()).loggedIn) return fail('login-required', '请先登录当前斗鱼账号')
              if (disposed || task.accountId !== deps.douyuAccounts.activeAccountId || deps.douyuAccounts.isBusy(task.accountId)) return fail('no-active-account', '账号状态已变化，请重新操作')
              return { ok: true, value: deps.douyuTasks.start(args.id) }
            }
            return { ok: true, value: method === 'pauseDouyuTask' ? deps.douyuTasks.pause(args.id) : deps.douyuTasks.remove(args.id) }
          }
          case 'retainDouyuTaskRoom':
          case 'closeDouyuTaskRoom': {
            if (!fields(args, method === 'retainDouyuTaskRoom' ? ['room', 'retain'] : ['room'])
              || typeof args.room !== 'string' || !/^[1-9][0-9]{0,11}$/.test(args.room)
              || (method === 'retainDouyuTaskRoom' && typeof args.retain !== 'boolean')) return fail('invalid-arguments', '房间参数无效')
            if (!deps.douyuTasks) return fail('not-available', '斗鱼任务管理不可用')
            return { ok: true, value: method === 'retainDouyuTaskRoom' ? deps.douyuTasks.retainRoom(args.room, args.retain as boolean) : deps.douyuTasks.closeRoom(args.room) }
          }
          case 'resolveDouyuRoom': {
            if (!fields(args, ['input']) || typeof args.input !== 'string' || args.input.length > MAX_INPUT_LENGTH) return fail('invalid-arguments', '房间身份查询参数无效')
            return { ok: true, value: await resolveRoom(args.input) }
          }
          case 'getAcquisitionDiagnostics': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            if (!deps.diagnostics) return fail('not-available', '取流诊断不可用')
            return { ok: true, value: await deps.diagnostics.report() }
          }
          case 'getToolsStatus':
          case 'updateYtdlp': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            if (!deps.tools) return fail('not-available', '工具管理不可用')
            return { ok: true, value: await (method === 'getToolsStatus' ? deps.tools.status() : deps.tools.update()) }
          }
          case 'restoreYtdlp': {
            if (!fields(args, ['target']) || (args.target !== 'previous' && args.target !== 'bundled')) return fail('invalid-arguments', '恢复工具参数无效')
            if (!deps.tools) return fail('not-available', '工具管理不可用')
            return { ok: true, value: await deps.tools.restore(args.target) }
          }
          case 'getNetworkPreferences': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            return deps.networkPreferences ? { ok: true, value: await deps.networkPreferences.get() } : fail('not-available', '网络设置不可用')
          }
          case 'setNetworkPreferences': {
            if (!fields(args, ['domesticRouting'], ['media']) || !isDomesticRouting(args.domesticRouting)
              || args.media !== undefined && !validMediaNetwork(args.media)) return fail('invalid-arguments', '网络设置无效')
            return deps.networkPreferences ? { ok: true, value: await deps.networkPreferences.set(args.domesticRouting,
              ...(args.media === undefined ? [] : [args.media])) } : fail('not-available', '网络设置不可用')
          }
          case 'getDecoderPreferences': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            if (!deps.decoderPreferences) return fail('not-available', '解码设置不可用')
            return { ok: true, value: deps.decoderPreferences.get() }
          }
          case 'setDecoderPreferences': {
            if (!fields(args, ['mode']) || !isDecoderMode(args.mode)) return fail('invalid-arguments', '解码设置参数无效')
            if (!deps.decoderPreferences) return fail('not-available', '解码设置不可用')
            try { return { ok: true, value: await deps.decoderPreferences.set(args.mode) } }
            catch { return fail('settings-write-failed', '解码设置保存失败，请重试') }
          }
          case 'health': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            return { ok: true, value: { ok: true, version: appPackage.version, proxyEnabled: deps.proxy.enabled, danmakuRooms: relay.roomCount } }
          }
          case 'resolve': {
            if (!fields(args, ['input'], ['platform', 'role', 'quality', 'preferAdaptive'])) return fail('invalid-arguments', '媒体解析参数无效')
            if (typeof args.input !== 'string' || args.input.trim().length === 0) {
              return fail('missing-input', '缺少要解析的地址或频道名')
            }
            if (args.input.length > MAX_MEDIA_INPUT_LENGTH || (args.platform !== undefined && !isPlatform(args.platform))
              || (args.role !== undefined && !isRole(args.role))
              || (args.preferAdaptive !== undefined && typeof args.preferAdaptive !== 'boolean')
              || (args.quality !== undefined && (typeof args.quality !== 'string' || args.quality.length > 128))) {
              return fail('invalid-arguments', '媒体地址过长或平台参数无效')
            }
            const input = args.input.trim()
            if (deps.acquisition) return { ok: true, value: sanitizedFailure(await deps.acquisition.resolve(
              input, args.platform as PlatformKind | undefined, args.role as SourceRole ?? 'official', args.quality as string | undefined,
              ...(args.preferAdaptive === undefined ? [] : [args.preferAdaptive as boolean]),
            )) }
            if (fixturePath(input) && (args.platform === undefined || args.platform === 'direct')) {
              return { ok: true, value: { ok: true, stream: {
                platform: 'direct', url: input, kind: /\.m3u8?$/.test(input) ? 'hls' : 'progressive',
                label: '本地测试源', channel: 'fixture', requiresProxy: false,
              } } }
            }
            // Resolution owns this lookup only until it has checked the returned target.
            const registered = new Map<string, string>()
            const register = (url: string): string => {
              const opaque = `pending-media:${registered.size + 1}`
              registered.set(opaque, url)
              return opaque
            }
            const resolverDeps = { ...createResolverDeps(deps.proxy, register, deps.fetchImpl), resolveDouyuRoom: resolveRoom }
            const result = await resolveStream(input, resolverDeps, args.platform as PlatformKind | undefined)
            if (!result.ok) return { ok: true, value: sanitizedFailure(result) }
            const rawUrl = registered.get(result.stream.url) ?? result.stream.url
            const target = checkUrlSyntax(rawUrl, mediaRequestPolicy(deps.proxy))
            if (!target.ok) return fail(target.reason, streamFailureForCode(target.reason)?.message ?? '媒体地址被应用的安全策略拒绝')
            if (target.url.username || target.url.password) return fail('invalid-url', '媒体地址不能包含登录凭据')
            const url = deps.registerMedia(rawUrl, result.stream.mediaAccess, result.stream.headers)
            const { headers: _headers, adaptive: _adaptive, mediaAccess: _access, douyuWatchCdn: _cdn, ...publicStream } = result.stream
            return { ok: true, value: { ok: true, stream: { ...publicStream, url, requiresProxy: false, notes: [] } } }
          }
          case 'switchQuality': {
            if (!fields(args, ['role', 'quality']) || !isRole(args.role) || typeof args.quality !== 'string'
              || args.quality.length === 0 || args.quality.length > 128) return fail('invalid-arguments', '画质参数无效')
            if (!deps.acquisition) return fail('not-available', '取流服务不可用')
            return { ok: true, value: sanitizedFailure(await deps.acquisition.switchQuality(args.role, args.quality)) }
          }
          case 'stopBuffer': {
            if (!fields(args, ['role']) || !isRole(args.role)) return fail('invalid-arguments', '片源角色无效')
            await deps.acquisition?.stop(args.role)
            return { ok: true, value: { ok: true } }
          }
          case 'loginStatus': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            if (!deps.acquisition) return fail('not-available', '账号服务不可用')
            return { ok: true, value: await deps.acquisition.loginStatus() }
          }
          case 'login':
          case 'logout': {
            if (!fields(args, ['platform']) || !isLoginPlatform(args.platform)) {
              return fail('invalid-arguments', '不支持的登录平台')
            }
            if (!deps.acquisition) return fail('not-available', '账号服务不可用')
            if (method === 'login') return { ok: true, value: await deps.acquisition.login(args.platform) }
            await deps.acquisition.logout(args.platform)
            return { ok: true, value: { ok: true } }
          }
          default: return fail('not-found', '未知本地接口')
        }
      } catch (error) {
        const detail = diagnosticDetails(error)
        if (utilTypes.isProxy(error)) return fail('internal-error', '本地服务无法完成此操作', detail)
        if (error instanceof DouyuAccountError || error instanceof DouyuTaskError || error instanceof DouyuRenewalError) return fail(error.code, error.message, detail)
        if (error instanceof ProxyError) return fail(error.reason, classifyNetworkFailure(error).message, detail)
        // Tool errors contain only stable codes, never executable paths or child output.
        if (error instanceof Error && 'tool' in error && 'code' in error
          && ['tool-missing', 'tool-invalid-path', 'tool-not-executable'].includes(String(error.code))) {
          return fail(String(error.code), `找不到可用的 ${String(error.tool)}，请重新安装应用`, detail)
        }
        if (error instanceof Error && error.name === 'LoginError' && 'code' in error) {
          const messages: Record<string, string> = {
            'chrome-not-found': '未找到系统 Chrome，请安装 Chrome 后重试',
            'login-busy': '登录操作正在进行，请先完成当前登录页面',
            'login-cancelled': '登录操作已取消',
            'login-incomplete': '登录未完成，原账号已保留，请重试',
            'login-failed': record(args) && args.platform === 'douyin' ? '抖音内嵌登录未完成，请在应用内重试' : '平台登录失败，请关闭登录页面后重试',
            'cookie-storage-failed': '登录信息保存失败，请重试',
          }
          return fail(String(error.code), messages[String(error.code)] ?? '账号操作失败', detail)
        }
        if (method === 'resolve' || method === 'switchQuality') {
          return { ok: true, value: resolvedFailure(classifyNetworkFailure(error, 'resolve')) }
        }
        return fail('internal-error', '本地服务无法完成此操作', detail)
      }
    },
    dispose() {
      disposed = true
      deps.features?.dispose()
      relay.closeAll()
    },
  }
}

/** Platform requests keep the existing per-hop SSRF policy and fixed platform headers. */
export function createResolverDeps(proxy: ProxyConfig, registerMedia: (url: string) => string, fetchImpl?: typeof fetch, network?: NetworkContext) {
  let playlistAccess: MediaAccess | undefined
  const request = async (url: string, init?: RequestInit, mode: 'text' | 'binary' | 'page' = 'text') => {
    try {
      const signal = timeoutSignal(network?.media?.requestTimeoutMs ?? proxy.requestTimeoutMs, network?.signal)
      const { response, finalUrl } = await safeFetch(url, { ...proxy, enabled: true }, {
        method: init?.method ?? 'GET',
        headers: { accept: 'application/json, text/plain, */*', ...(init?.headers as Record<string, string> | undefined) },
        body: typeof init?.body === 'string' ? init.body : init?.body instanceof Uint8Array ? new Uint8Array(init.body) : undefined,
        signal,
        fetchImpl, network,
      })
      if (!response.ok) {
        throw new StreamFailureError(httpFailure(response.status, await httpErrorDetails(response)))
      }
      if (mode === 'binary') return await readPlatformBytes(response, signal)
      const text = await readPlatformText(response, signal)
      return mode === 'page' ? { text, finalUrl: finalUrl.href, setCookie: response.headers.getSetCookie() } : text
    } catch (error) {
      throw new StreamFailureError(classifyNetworkFailure(error))
    }
  }
  return {
    fetchJson: async (url: string, init?: RequestInit): Promise<unknown> => {
      const text = await request(url, init) as string
      try { return JSON.parse(text) as unknown } catch (error) { throw new Error('平台返回的数据格式无效', { cause: error }) }
    },
    fetchText: async (url: string, init?: RequestInit) => await request(url, init) as string,
    fetchBytes: async (url: string, init?: RequestInit) => await request(url, init, 'binary') as Uint8Array,
    fetchPage: async (url: string, init?: RequestInit) => await request(url, init, 'page') as import('./platforms/types').PlatformPage,
    fetchPlaylist: async (url: string) => {
      const signal = timeoutSignal(network?.media?.requestTimeoutMs ?? proxy.requestTimeoutMs, network?.signal)
      playlistAccess = mediaEntry(url)
      const { response, finalUrl } = await safeFetch(url, mediaRequestPolicy(proxy), { signal, fetchImpl, network, mediaAccess: playlistAccess })
      if (!response.ok) { await response.body?.cancel(); throw new StreamFailureError(httpFailure(response.status)) }
      return { text: await readPlatformText(response, signal), finalUrl: finalUrl.href }
    },
    mediaAccess: () => playlistAccess ? mediaChild(playlistAccess) : undefined,
    proxify: registerMedia,
  }
}
