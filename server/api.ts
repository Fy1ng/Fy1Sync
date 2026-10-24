/** Main-process services without Electron imports or a network listener. */

import appPackage from '../package.json'
import { createDouyuRoomResolver, type ResolveDouyuRoom } from './platforms/douyuRoom'
import type { ApiResult } from '../src/app/apiClient'
import type { ProxyConfig } from './config'
import { DanmakuRelay } from './danmaku/relay'
import { resolveStream, type PlatformKind, type ResolveResult } from './platforms'
import { fileNameFor, MAX_PRESET_BYTES, PresetStore } from './presetStore'
import { checkUrl, ProxyError, safeFetch } from './safeFetch'
import type { SourceRole } from '../src/core/types'
import type { BufferState } from '../electron/bufferManager'
import type { LoginPlatform, LoginResult, LoginStatus } from '../electron/login'
import { isDecoderMode, type DecoderPreferencesService } from '../electron/decoderPreferences'
import type { ToolsService } from '../electron/toolsService'
import { DouyuAccountError, isDouyuAccountId, type DouyuAccountManager } from '../electron/douyuAccounts'
import { DouyuTaskError, type DouyuTaskManager } from '../electron/douyuTasks'
import { DOUYU_TASK_KINDS, DOUYU_TASK_POLICIES, isDouyuActivityKind, type DouyuTaskKind, type DouyuTaskPolicy, type DouyuTasksSnapshot } from './douyu/types'
import { readMessageSchedule } from './douyu/taskConfig'
import { readPlatformText } from './platformResponse'
import { DouyuRenewalError, readRenewalRooms, readRenewalQuantities, type DouyuRenewalService } from './douyu/renewalService'

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
  registerMedia: (url: string) => string
  resolveDouyuRoom?: ResolveDouyuRoom
  acquisition?: AcquisitionService
  decoderPreferences?: DecoderPreferencesService
  tools?: ToolsService
  douyuAccounts?: DouyuAccountManager
  douyuTasks?: DouyuTaskManager
  douyuRenewal?: DouyuRenewalService
}

export type DesktopService = {
  invoke: (method: unknown, args: unknown) => Promise<ApiResult<unknown>>
  relay: DanmakuRelay
  resolveDouyuRoom: ResolveDouyuRoom
  dispose: () => void
  subscribeBuffer?: (listener: (state: BufferState) => void) => () => void
  subscribeDouyuTasks?: (listener: (state: DouyuTasksSnapshot) => void) => () => void
  setDouyuRoom?: (room: string | null) => void
}

const MAX_INPUT_LENGTH = 8_192
const MAX_TOKEN_LENGTH = 4_096
const MAX_ARGS_BYTES = MAX_PRESET_BYTES + 16_384
const MAX_VALUE_DEPTH = 32

function fail(code: string, message: string, detail?: unknown): ApiResult<never> {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail }
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

function optionalToken(args: Record<string, unknown>): boolean {
  return args.token === undefined || (typeof args.token === 'string' && args.token.length <= MAX_TOKEN_LENGTH)
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && fileNameFor(id) !== null
}

function isPlatform(value: unknown): value is PlatformKind {
  return value === 'youtube' || value === 'direct' || value === 'twitch' || value === 'douyu' || value === 'bilibili'
}

function isRole(value: unknown): value is SourceRole { return value === 'official' || value === 'commentary' }

/** Only fixture-relative paths may bypass remote-media registration. */
function fixturePath(input: string): boolean {
  return /^\/test-sources\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:m3u8|m3u|mp4|webm|mov|mkv|ts)$/.test(input)
}

export function sanitizedFailure(result: ResolveResult): ResolveResult {
  if (result.ok) return result
  const messages = {
    'unsupported-url': '无法识别该媒体地址或平台',
    'not-live': '直播当前未开始或受限制',
    'room-not-found': '未找到该直播间',
    'upstream-error': '无法获取平台播放信息',
    restricted: '平台限制了此媒体的访问',
    'needs-manual-url': '平台没有提供可播放地址',
  }
  return { ok: false, failure: {
    code: result.failure.code, message: messages[result.failure.code],
    hint: result.failure.code === 'restricted'
      ? '请在账号区域登录对应平台后重新加载, 或使用可播放的媒体地址'
      : '请检查地址和直播状态, 或提供可播放的媒体地址',
  } }
}

/** The Electron IPC boundary checks the sender before calling any service method. */
export function createDesktopService(deps: DesktopServiceDeps): DesktopService {
  const relay = deps.relay ?? new DanmakuRelay()
  const presets = new PresetStore(deps.dataDir)
  let disposed = false
  const resolveRoom = deps.resolveDouyuRoom ?? createDouyuRoomResolver(deps.proxy, deps.fetchImpl).resolve

  return {
    relay,
    resolveDouyuRoom: input => disposed ? Promise.resolve({ ok: false, failure: { code: 'upstream-error', message: '本地服务已关闭' } }) : resolveRoom(input),
    subscribeBuffer: deps.acquisition ? (listener) => deps.acquisition!.subscribe(listener) : undefined,
    subscribeDouyuTasks: deps.douyuTasks ? listener => deps.douyuTasks!.subscribe(listener) : undefined,
    setDouyuRoom: deps.douyuTasks ? room => deps.douyuTasks!.setRoom(room) : undefined,
    async invoke(method, args) {
      if (disposed) return fail('service-closed', '本地服务已关闭')
      if (typeof method !== 'string') return fail('not-found', '未知本地接口')
      try {
        if (!jsonData(args)) return fail('invalid-arguments', '接口参数必须是有效的数据对象')
        const serialized = JSON.stringify(args)
        if (serialized !== undefined && Buffer.byteLength(serialized) > MAX_ARGS_BYTES) {
          return fail('too-large', '接口参数超过大小上限')
        }

        switch (method) {
          case 'listDouyuAccounts': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            if (!deps.douyuAccounts) return fail('not-available', '斗鱼账号配置不可用, 请检查本地配置后重试.')
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
            if (accounts.isBusy(args.id)) return fail('account-busy', '账号正在登录或退出, 请稍后重试.')
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
            if (accounts.isBusy(task.accountId)) return fail('account-busy', '该账号的官方窗口已打开, 请先完成并关闭窗口')
            tasks.pause(task.id, '官方房间已打开, 完成人工处理后请手动启动任务.')
            tasks.pauseAccount(task.accountId, '官方房间已打开, 完成人工处理后请手动启动任务.')
            return { ok: true, value: await accounts.openRoom(task.accountId, task.room, task.kind === 'auto-fish' ? 'fish-act' : 'room') }
          }
          case 'getDouyuTasks': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            if (!deps.douyuTasks) return fail('not-available', '斗鱼任务配置不可用, 原文件已保留.')
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
            if (accounts.activeAccountId !== accountId || accounts.isBusy(accountId) || deps.douyuTasks.snapshot().currentRoom !== originRoom) return fail('account-changed', '账号或房间已变化, 请重新读取')
            return { ok: true, value: preview ? await deps.douyuRenewal.preview(accountId, rooms!, quantity as number, quantities)
              : await deps.douyuRenewal.targets(accountId) }
          }
          case 'executeDouyuRenewal':
          case 'cancelDouyuRenewal': {
            if (!fields(args, ['planId']) || typeof args.planId !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(args.planId)) return fail('invalid-arguments', '赠送预览标识无效')
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
            if (message.accountId !== accounts.activeAccountId) return fail('no-active-account', '活动账号已变化, 请确认账号后重新操作')
            if (accounts.isBusy(message.accountId)) return fail('account-busy', '账号正在登录或退出, 请稍后发送')
            if (tasks.snapshot().currentRoom !== message.room) return fail('room-changed', '当前房间已变化, 请确认房间后重新操作')
            if (!(await accounts.activeLoginStatus()).loggedIn) return fail('login-required', '请先在片源设置中登录当前斗鱼账号')
            if (disposed) return fail('service-closed', '本地服务已关闭')
            if (message.accountId !== accounts.activeAccountId || accounts.isBusy(message.accountId)) return fail('no-active-account', '账号状态已变化, 请确认后重新操作')
            return { ok: true, value: await tasks.sendMessage(message) }
          }
          case 'createDouyuTask': {
            if (!fields(args, ['accountId', 'roomInput', 'kind', 'policy', 'repeatMinutes'], ['message']) || !isDouyuAccountId(args.accountId)
              || typeof args.roomInput !== 'string' || args.roomInput.length > MAX_INPUT_LENGTH || !DOUYU_TASK_KINDS.includes(args.kind as DouyuTaskKind)
              || !DOUYU_TASK_POLICIES.includes(args.policy as DouyuTaskPolicy)) {
              return fail('invalid-arguments', '任务参数无效')
            }
            const message = args.kind === 'message-loop' ? readMessageSchedule(args.message) : null
            if (isDouyuActivityKind(args.kind) && args.repeatMinutes !== null) return fail('invalid-arguments', '活动任务按官方状态安排时间, 不接受重复周期')
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
              if (deps.douyuAccounts.isBusy(task.accountId)) return fail('account-busy', '账号正在登录或退出, 请稍后启动任务.')
              if (!(await deps.douyuAccounts.activeLoginStatus()).loggedIn) return fail('login-required', '请先登录当前斗鱼账号')
              if (disposed || task.accountId !== deps.douyuAccounts.activeAccountId || deps.douyuAccounts.isBusy(task.accountId)) return fail('no-active-account', '账号状态已变化, 请重新操作')
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
          case 'getDecoderPreferences': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            if (!deps.decoderPreferences) return fail('not-available', '解码设置不可用')
            return { ok: true, value: deps.decoderPreferences.get() }
          }
          case 'setDecoderPreferences': {
            if (!fields(args, ['mode']) || !isDecoderMode(args.mode)) return fail('invalid-arguments', '解码设置参数无效')
            if (!deps.decoderPreferences) return fail('not-available', '解码设置不可用')
            try { return { ok: true, value: await deps.decoderPreferences.set(args.mode) } }
            catch { return fail('settings-write-failed', '解码设置保存失败, 请重试') }
          }
          case 'health': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            return { ok: true, value: { ok: true, version: appPackage.version, proxyEnabled: deps.proxy.enabled, danmakuRooms: relay.roomCount } }
          }
          case 'verifyAdmin': {
            if (!fields(args, ['token']) || typeof args.token !== 'string' || args.token.length > MAX_TOKEN_LENGTH) {
              return fail('invalid-arguments', '编辑器验证参数无效')
            }
            // A trusted local editor replaces the web-server token gate.
            return { ok: true, value: { ok: true } }
          }
          case 'resolve': {
            if (!fields(args, ['input'], ['platform', 'role', 'quality', 'preferAdaptive'])) return fail('invalid-arguments', '媒体解析参数无效')
            if (typeof args.input !== 'string' || args.input.trim().length === 0) {
              return fail('missing-input', '缺少要解析的地址或频道名')
            }
            if (args.input.length > MAX_INPUT_LENGTH || (args.platform !== undefined && !isPlatform(args.platform))
              || (args.role !== undefined && !isRole(args.role))
              || (args.preferAdaptive !== undefined && typeof args.preferAdaptive !== 'boolean')
              || (args.quality !== undefined && (typeof args.quality !== 'string' || args.quality.length > 128))) {
              return fail('invalid-arguments', '媒体地址过长或平台参数无效')
            }
            const input = args.input.trim()
            if (deps.acquisition) return { ok: true, value: await deps.acquisition.resolve(
              input, args.platform as PlatformKind | undefined, args.role as SourceRole ?? 'official', args.quality as string | undefined,
              ...(args.preferAdaptive === undefined ? [] : [args.preferAdaptive as boolean]),
            ) }
            if (fixturePath(input) && (args.platform === undefined || args.platform === 'direct')) {
              return { ok: true, value: { ok: true, stream: {
                platform: 'direct', url: input, kind: /\.m3u8?$/.test(input) ? 'hls' : 'progressive',
                label: '本地测试源', channel: 'fixture', requiresProxy: false,
              } } }
            }
            // Resolution owns this lookup only until it has checked the returned target.
            const registered = new Map<string, string>()
            const register = (url: string): string => {
              const opaque = deps.registerMedia(url)
              registered.set(opaque, url)
              return opaque
            }
            const resolverDeps = { ...createResolverDeps(deps.proxy, register, deps.fetchImpl), resolveDouyuRoom: resolveRoom }
            const result = await resolveStream(input, resolverDeps, args.platform as PlatformKind | undefined)
            if (!result.ok) return { ok: true, value: sanitizedFailure(result) }
            const rawUrl = registered.get(result.stream.url) ?? result.stream.url
            const target = await checkUrl(rawUrl, deps.proxy)
            if (!target.ok) return fail(target.reason, '媒体地址未通过安全检查')
            if (target.url.username || target.url.password) return fail('invalid-url', '媒体地址不能包含登录凭据')
            const url = registered.has(result.stream.url) ? result.stream.url : register(rawUrl)
            return { ok: true, value: { ok: true, stream: { ...result.stream, url, requiresProxy: false, notes: ['媒体通过本地主进程安全加载'] } } }
          }
          case 'switchQuality': {
            if (!fields(args, ['role', 'quality']) || !isRole(args.role) || typeof args.quality !== 'string'
              || args.quality.length === 0 || args.quality.length > 128) return fail('invalid-arguments', '画质参数无效')
            if (!deps.acquisition) return fail('not-available', '取流服务不可用')
            return { ok: true, value: await deps.acquisition.switchQuality(args.role, args.quality) }
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
            if (!fields(args, ['platform']) || (args.platform !== 'youtube' && args.platform !== 'douyu')) {
              return fail('invalid-arguments', '不支持的登录平台')
            }
            if (!deps.acquisition) return fail('not-available', '账号服务不可用')
            if (method === 'login') return { ok: true, value: await deps.acquisition.login(args.platform) }
            await deps.acquisition.logout(args.platform)
            return { ok: true, value: { ok: true } }
          }
          case 'listPresets': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            const records = await presets.list()
            return { ok: true, value: { presets: records.map((entry) => ({
              id: entry.id, name: entry.profile.name, updatedAt: entry.updatedAt,
              etag: entry.etag, templateChars: Object.keys(entry.profile.templates).length,
            })) } }
          }
          case 'getPreset': {
            if (!fields(args, ['id']) || !validId(args.id)) return fail('invalid-id', '预设 ID 无效')
            const entry = await presets.get(args.id)
            if (!entry) return fail('not-found', '预设不存在')
            return { ok: true, value: { profile: entry.profile, etag: entry.etag } }
          }
          case 'savePreset': {
            if (!fields(args, ['id', 'profile'], ['token', 'etag']) || !optionalToken(args)
              || (args.etag !== undefined && (typeof args.etag !== 'string' || args.etag.length > 128 || /[\r\n\0]/.test(args.etag)))) {
              return fail('invalid-arguments', '预设保存参数无效')
            }
            if (!validId(args.id)) return fail('invalid-id', '预设 ID 无效')
            const outcome = await presets.save(args.id, args.profile, args.etag as string | undefined)
            if (!outcome.ok) {
              switch (outcome.code) {
                case 'invalid': return fail('invalid-profile', '配置校验未通过', { issues: outcome.issues })
                case 'too-large': return fail('too-large', '预设超过大小上限')
                case 'conflict': return fail('conflict', '预设已被其他会话修改', { currentEtag: outcome.currentEtag })
                default: return fail('io-error', '无法写入预设')
              }
            }
            return { ok: true, value: { id: outcome.record.id, etag: outcome.record.etag, updatedAt: outcome.record.updatedAt } }
          }
          case 'deletePreset': {
            if (!fields(args, ['id'], ['token']) || !optionalToken(args)) return fail('invalid-arguments', '预设删除参数无效')
            if (!validId(args.id)) return fail('invalid-id', '预设 ID 无效')
            if (!await presets.remove(args.id)) return fail('not-found', '预设不存在')
            return { ok: true, value: { ok: true } }
          }
          default: return fail('not-found', '未知本地接口')
        }
      } catch (error) {
        if (error instanceof DouyuAccountError || error instanceof DouyuTaskError || error instanceof DouyuRenewalError) return fail(error.code, error.message)
        if (error instanceof ProxyError) return fail(error.reason, '媒体地址未通过安全检查')
        // Tool errors contain only stable codes, never executable paths or child output.
        if (error instanceof Error && 'tool' in error && 'code' in error
          && ['tool-missing', 'tool-invalid-path', 'tool-not-executable'].includes(String(error.code))) {
          return fail(String(error.code), `未找到可用的 ${String(error.tool)}, 请检查工具设置或环境变量`)
        }
        if (error instanceof Error && error.name === 'LoginError' && 'code' in error) {
          const messages: Record<string, string> = {
            'chrome-not-found': '未找到系统 Chrome, 请安装 Chrome 后重试',
            'login-busy': '登录操作正在进行, 请先完成当前窗口',
            'login-cancelled': '登录操作已取消',
            'login-failed': 'Chrome 登录失败, 请关闭专用窗口后重试',
            'cookie-storage-failed': '登录信息无法安全保存, 请检查本机文件权限',
          }
          return fail(String(error.code), messages[String(error.code)] ?? '账号操作失败')
        }
        // Never expose filesystem paths, signed media URLs, or upstream error bodies.
        return fail('internal-error', '本地服务无法完成此操作')
      }
    },
    dispose() {
      disposed = true
      relay.closeAll()
    },
  }
}

/** Platform requests keep the existing per-hop SSRF policy and fixed platform headers. */
export function createResolverDeps(proxy: ProxyConfig, registerMedia: (url: string) => string, fetchImpl?: typeof fetch) {
  const request = async (url: string, init?: RequestInit): Promise<string> => {
    try {
      const signal = AbortSignal.timeout(proxy.requestTimeoutMs)
      const { response } = await safeFetch(url, { ...proxy, enabled: true }, {
        method: init?.method ?? 'GET',
        headers: { accept: 'application/json, text/plain, */*', ...(init?.headers as Record<string, string> | undefined) },
        body: typeof init?.body === 'string' ? init.body : undefined,
        signal,
        fetchImpl,
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new Error('Upstream request failed')
      }
      return await readPlatformText(response, signal)
    } catch {
      throw new Error('平台请求失败')
    }
  }
  return {
    fetchJson: async (url: string, init?: RequestInit): Promise<unknown> => {
      const text = await request(url, init)
      try { return JSON.parse(text) as unknown } catch { throw new Error('平台返回的数据格式无效') }
    },
    fetchText: request,
    proxify: registerMedia,
  }
}
