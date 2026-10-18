/** Main-process services without Electron imports or a network listener. */

import type { ApiResult } from '../src/app/apiClient'
import type { ProxyConfig } from './config'
import { DanmakuRelay } from './danmaku/relay'
import { resolveStream, type PlatformKind, type ResolveResult } from './platforms'
import { fileNameFor, MAX_PRESET_BYTES, PresetStore } from './presetStore'
import { checkUrl, safeFetch } from './safeFetch'

export type DesktopServiceDeps = {
  dataDir: string
  proxy: ProxyConfig
  relay?: DanmakuRelay
  fetchImpl?: typeof fetch
  registerMedia: (url: string) => string
}

export type DesktopService = {
  invoke: (method: unknown, args: unknown) => Promise<ApiResult<unknown>>
  relay: DanmakuRelay
  dispose: () => void
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
  return value === 'direct' || value === 'twitch' || value === 'douyu' || value === 'bilibili'
}

/** Only fixture-relative paths may bypass remote-media registration. */
function fixturePath(input: string): boolean {
  return /^\/test-sources\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:m3u8|m3u|mp4|webm|mov|mkv|ts)$/.test(input)
}

function sanitizedFailure(result: ResolveResult): ResolveResult {
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
    hint: '请检查地址和直播状态, 或提供可播放的媒体地址',
  } }
}

/** The Electron IPC boundary checks the sender before calling any service method. */
export function createDesktopService(deps: DesktopServiceDeps): DesktopService {
  const relay = deps.relay ?? new DanmakuRelay()
  const presets = new PresetStore(deps.dataDir)
  let disposed = false

  return {
    relay,
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
          case 'health': {
            if (args !== undefined) return fail('invalid-arguments', '此接口不接受参数')
            return { ok: true, value: { ok: true, version: '0.1.0', proxyEnabled: deps.proxy.enabled, danmakuRooms: relay.roomCount } }
          }
          case 'verifyAdmin': {
            if (!fields(args, ['token']) || typeof args.token !== 'string' || args.token.length > MAX_TOKEN_LENGTH) {
              return fail('invalid-arguments', '编辑器验证参数无效')
            }
            // A trusted local editor replaces the web-server token gate.
            return { ok: true, value: { ok: true } }
          }
          case 'resolve': {
            if (!fields(args, ['input'], ['platform'])) return fail('invalid-arguments', '媒体解析参数无效')
            if (typeof args.input !== 'string' || args.input.trim().length === 0) {
              return fail('missing-input', '缺少要解析的地址或频道名')
            }
            if (args.input.length > MAX_INPUT_LENGTH || (args.platform !== undefined && !isPlatform(args.platform))) {
              return fail('invalid-arguments', '媒体地址过长或平台参数无效')
            }
            const input = args.input.trim()
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
            const resolverDeps = createResolverDeps(deps.proxy, register, deps.fetchImpl)
            const result = await resolveStream(input, resolverDeps, args.platform as PlatformKind | undefined)
            if (!result.ok) return { ok: true, value: sanitizedFailure(result) }
            const rawUrl = registered.get(result.stream.url) ?? result.stream.url
            const target = await checkUrl(rawUrl, deps.proxy)
            if (!target.ok) return fail(target.reason, '媒体地址未通过安全检查')
            if (target.url.username || target.url.password) return fail('invalid-url', '媒体地址不能包含登录凭据')
            const url = registered.has(result.stream.url) ? result.stream.url : register(rawUrl)
            return { ok: true, value: { ok: true, stream: { ...result.stream, url, requiresProxy: false, notes: ['媒体通过本地主进程安全加载'] } } }
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
      } catch {
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
function createResolverDeps(proxy: ProxyConfig, registerMedia: (url: string) => string, fetchImpl?: typeof fetch) {
  const request = async (url: string, init?: RequestInit): Promise<Response> => {
    try {
      const { response } = await safeFetch(url, { ...proxy, enabled: true }, {
        method: init?.method ?? 'GET',
        headers: { accept: 'application/json, text/plain, */*', ...(init?.headers as Record<string, string> | undefined) },
        body: typeof init?.body === 'string' ? init.body : undefined,
        fetchImpl,
      })
      if (!response.ok) throw new Error('Upstream request failed')
      return response
    } catch {
      throw new Error('平台请求失败')
    }
  }
  return {
    fetchJson: async (url: string, init?: RequestInit): Promise<unknown> => (await request(url, init)).json(),
    fetchText: async (url: string, init?: RequestInit): Promise<string> => (await request(url, init)).text(),
    proxify: registerMedia,
  }
}
