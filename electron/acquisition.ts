import { createDouyuRoomResolver, type ResolveDouyuRoom } from '../server/platforms/douyuRoom'
import type { AcquisitionService } from '../server/api'
import { createResolverDeps, sanitizedFailure } from '../server/api'
import type { ProxyConfig } from '../server/config'
import { detectPlatform, resolveStream, type PlatformKind, type ResolveResult, type ResolvedStream } from '../server/platforms'
import { checkUrl, ProxyError, safeFetch, type Resolver } from '../server/safeFetch'
import { readPlatformText } from '../server/platformResponse'
import { highestHlsVariant } from '../server/platforms/hlsVariant'
import { isStreamId, type StreamId } from './streamIdentity'
import type { BufferInput, BufferManager, BufferState } from './bufferManager'
import type { LoginManager } from './login'

type Selection = { input: string; platform?: PlatformKind; quality?: string; preferAdaptive?: boolean; stream: ResolvedStream }

/** Only main-produced, checked inputs can reach the buffer's ffmpeg spawner. */
export class Acquisition implements AcquisitionService {
  private readonly selections = new Map<StreamId, Selection>()
  private readonly generations = new Map<StreamId, number>()
  private readonly activeGenerations = new Map<StreamId, number>()
  private readonly publicStreams = new Map<StreamId, ResolvedStream>()
  private generationSequence = 0
  private disposed = false
  private readonly resolveRoom: ResolveDouyuRoom
  constructor(private readonly deps: {
    buffer: Pick<BufferManager, 'start' | 'stop' | 'subscribe'>
    logins: Pick<LoginManager, 'login' | 'loginStatus' | 'logout' | 'cookieHeader'>
    runYtDlp: (url: string, adaptive?: boolean) => Promise<unknown>
    proxy: ProxyConfig
    fetchImpl?: typeof fetch
    resolveDouyuRoom?: ResolveDouyuRoom
    dns?: Resolver
    readyTimeoutMs?: number
    ensureTools?: (platform: PlatformKind | null) => Promise<void>
  }) { this.resolveRoom = deps.resolveDouyuRoom ?? createDouyuRoomResolver(deps.proxy, deps.fetchImpl).resolve }

  async resolve(input: string, platform: PlatformKind | undefined, role: StreamId, quality?: string, preferAdaptive = false, confirmedRoom?: string): Promise<ResolveResult> {
    if (!isStreamId(role)) return refusal('播放会话无效')
    const generation = ++this.generationSequence
    this.generations.set(role, generation)
    if (this.disposed) return refusal('取流服务已关闭')
    // Local fixtures bypass acquisition but still release the previous producer.
    if (/^\/test-sources\/(?:[\w-]+\/)*[\w-]+\.(?:m3u8|mp4|webm|mov|mkv|ts)$/.test(input)
      && (platform === undefined || platform === 'direct')) {
      await this.deps.buffer.stop(role)
      if (generation !== this.generations.get(role) || this.disposed) return refusal('片源操作已被替换')
      this.selections.delete(role)
      const stream: ResolvedStream = {
        platform: 'direct', channel: 'fixture', kind: input.endsWith('.m3u8') ? 'hls' : 'progressive',
        url: input, label: '本地测试源', requiresProxy: false,
      }
      this.publicStreams.set(role, stream)
      return { ok: true, stream }
    }
    if (!this.deps.proxy.enabled) return refusal('远程媒体读取已关闭')
    const detected = detectPlatform(input, platform)
    if (detected === 'youtube') await this.deps.ensureTools?.(detected)
    const previous = this.selections.get(role)
    const sameSource = previous?.input === input && previous.platform === platform ? previous.stream : undefined
    const requestedAdaptive = sameSource?.qualities?.find(option => option.id === quality && option.adaptive)
    let fallbackHeight: number | undefined
    let first = await this.resolveInput(input, platform, quality, preferAdaptive, false, confirmedRoom)
    // A previously offered adaptive id can disappear when provider setup falls back
    // to the old extractor mode. Preserve playback instead of rejecting that switch.
    if (!first.ok && first.failure.code === 'unsupported-url' && detected === 'youtube' && requestedAdaptive?.height) {
      fallbackHeight = requestedAdaptive.height
      first = await this.resolveInput(input, platform, 'auto', false, true)
    }
    if (generation !== this.generations.get(role) || this.disposed) return refusal('片源操作已被替换')
    if (!first.ok) return first
    if (detected !== 'youtube') await this.deps.ensureTools?.(detected)
    if (generation !== this.generations.get(role) || this.disposed) return refusal('片源操作已被替换')
    let initial = true
    const selection: Selection = { input, platform, quality, preferAdaptive, stream: retainAdaptiveQualities(sameSource, first.stream) }
    const prepare = async (hlsOnly = false): Promise<BufferInput> => {
      const resolved = initial && !hlsOnly ? first : await this.resolveInput(input, platform, hlsOnly ? 'auto' : quality, hlsOnly ? false : preferAdaptive, hlsOnly, selection.stream.sourceRoom)
      initial = false
      if (generation !== this.activeGenerations.get(role) || this.disposed) throw new Error('片源操作已取消')
      if (!resolved.ok) throw new Error('重新解析直播失败')
      selection.stream = retainAdaptiveQualities(selection.stream, resolved.stream)
      return { url: resolved.stream.url, headers: resolved.stream.headers
        ?? (resolved.stream.platform === 'bilibili' ? { Referer: 'https://live.bilibili.com/' } : undefined),
        ...(resolved.stream.adaptive ? { adaptive: resolved.stream.adaptive } : {}),
        qualityHeight: resolved.stream.qualities?.find(option => option.id === resolved.stream.quality)?.height,
        ...(fallbackHeight ? { fallbackFromHeight: fallbackHeight } : {}),
      }
    }
    // Subscribe before start so a fast producer cannot race its first usable playlist.
    const readiness = this.waitUntilPlayable(role, generation, Boolean(first.stream.adaptive))
    try {
      readiness.activate()
      this.activeGenerations.set(role, generation)
      const local = await this.deps.buffer.start(role, prepare)
      await readiness.promise
      if (generation !== this.generations.get(role) || this.disposed) return refusal('片源操作已被替换')
      this.selections.set(role, selection)
      const { headers: _headers, adaptive: _adaptive, ...publicStream } = selection.stream
      const publicSelection: ResolvedStream = {
        ...publicStream, url: local.url, kind: 'hls', requiresProxy: false,
        notes: ['主进程转封装为本地 HLS, 默认保留最近 180 秒', ...(selection.stream.notes ?? [])],
      }
      this.publicStreams.set(role, publicSelection)
      return { ok: true, stream: publicSelection }
    } catch (error) {
      if (generation === this.generations.get(role)) {
        this.selections.delete(role)
        this.publicStreams.delete(role)
        await this.deps.buffer.stop(role)
      }
      // Preserve structured locator errors without passing subprocess diagnostics.
      if (error instanceof Error && 'tool' in error && 'code' in error) throw error
      return refusal('本地缓冲未能就绪, 请检查工具和直播状态')
    } finally { readiness.cancel() }
  }

  async switchQuality(role: StreamId, quality: string): Promise<ResolveResult> {
    const selected = this.selections.get(role)
    if (!selected || !selected.stream.qualities?.some((option) => option.id === quality)) {
      return { ok: false, failure: { code: 'unsupported-url', message: '该片源没有此画质', hint: '请重新解析片源' } }
    }
    return this.resolve(selected.input, selected.platform, role, quality, selected.preferAdaptive, selected.stream.sourceRoom)
  }

  async stop(role: StreamId): Promise<void> {
    if (!isStreamId(role)) return
    const stoppedGeneration = ++this.generationSequence
    this.generations.set(role, stoppedGeneration)
    this.activeGenerations.delete(role)
    this.selections.delete(role)
    this.publicStreams.delete(role)
    try { await this.deps.buffer.stop(role) }
    finally { if (this.generations.get(role) === stoppedGeneration) this.generations.delete(role) }
  }
  subscribe(listener: (state: BufferState) => void): () => void { return this.deps.buffer.subscribe(listener) }
  login: AcquisitionService['login'] = (platform) => this.deps.logins.login(platform)
  loginStatus: AcquisitionService['loginStatus'] = () => this.deps.logins.loginStatus()
  logout: AcquisitionService['logout'] = (platform) => this.deps.logins.logout(platform)

  dispose(): void {
    this.disposed = true
    this.generations.clear()
    this.activeGenerations.clear()
    this.selections.clear()
    this.publicStreams.clear()
  }

  describe(role: StreamId): ResolvedStream | null {
    const value = this.publicStreams.get(role)
    return value ? structuredClone(value) : null
  }

  async restart(role: StreamId): Promise<ResolveResult> {
    const selected = this.selections.get(role)
    if (!selected) return refusal('播放会话尚未就绪')
    return this.resolve(selected.input, selected.platform, role, selected.quality, selected.preferAdaptive, selected.stream.sourceRoom)
  }

  private async resolveInput(input: string, platform?: PlatformKind, quality?: string, preferAdaptive = false, hlsOnly = false, confirmedRoom?: string): Promise<ResolveResult> {
    const resolver = createResolverDeps(this.deps.proxy, (url) => url, this.deps.fetchImpl)
    const result = await resolveStream(input, {
      ...resolver, quality, preferAdaptive, resolveDouyuRoom: this.resolveRoom,
      ...(confirmedRoom ? { douyuRoomIdentity: { room: confirmedRoom, inputRoom: confirmedRoom } } : {}), runYtDlp: hlsOnly ? url => this.deps.runYtDlp(url, false) : this.deps.runYtDlp,
      douyuCookie: detectPlatform(input, platform) === 'douyu' ? await this.deps.logins.cookieHeader('douyu') : undefined,
    }, platform)
    if (!result.ok) return sanitizedFailure(result)
    const checked = await checkUrl(result.stream.url, this.deps.proxy, this.deps.dns)
    if (!checked.ok) throw new ProxyError(checked.reason, '媒体地址未通过安全检查')
    if (checked.url.username || checked.url.password) throw new ProxyError('invalid-url', '媒体地址不能包含登录凭据')
    if (result.stream.platform === 'twitch' && result.stream.kind === 'hls') {
      // FFmpeg maps one video track into the local rolling buffer. Select the best
      // rendition here; renderer HLS selection cannot recover a discarded variant.
      const signal = AbortSignal.timeout(this.deps.proxy.requestTimeoutMs)
      const { response, finalUrl } = await safeFetch(checked.url.href, this.deps.proxy, {
        signal, fetchImpl: this.deps.fetchImpl, resolve: this.deps.dns,
        headers: { Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain' },
      })
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('Twitch playlist request failed') }
      const variant = highestHlsVariant(await readPlatformText(response, signal), finalUrl)
      const selected = await checkUrl(variant?.url ?? finalUrl.href, this.deps.proxy, this.deps.dns)
      if (!selected.ok) throw new ProxyError(selected.reason, '媒体地址未通过安全检查')
      if (selected.url.username || selected.url.password) throw new ProxyError('invalid-url', '媒体地址不能包含登录凭据')
      result.stream = { ...result.stream, url: selected.url.href }
    }
    if (result.stream.adaptive) {
      for (const raw of [result.stream.adaptive.videoUrl, result.stream.adaptive.audioUrl]) {
        const target = await checkUrl(raw, { ...this.deps.proxy, hosts: ['*.googlevideo.com'], allowNonLoopbackTargets: false, allowNonStandardPorts: false }, this.deps.dns)
        if (!target.ok || target.url.protocol !== 'https:' || target.url.port || target.url.username || target.url.password) {
          throw new ProxyError('host-not-allowed', '自适应媒体地址未通过安全检查')
        }
      }
    }
    return result
  }

  private waitUntilPlayable(role: StreamId, generation: number, adaptive = false) {
    let cancel = () => {}
    let active = false
    const promise = new Promise<void>((resolve, reject) => {
      let release = () => {}
      // The adaptive budget includes segment retries, token refresh and HLS fallback.
      // Keep the established HLS timeout unchanged.
      const timer = setTimeout(() => { release(); reject(new Error('缓冲超时')) }, this.deps.readyTimeoutMs ?? (adaptive ? 480_000 : 60_000))
      release = this.deps.buffer.subscribe((state) => {
        if (!active || state.role !== role) return
        if (generation !== this.generations.get(role) || this.disposed) { clearTimeout(timer); release(); reject(new Error('片源已替换')); return }
        if (state.state === 'failed') { clearTimeout(timer); release(); reject(new Error('缓冲失败')) }
        else if ((state.state === 'ready' || state.state === 'buffering') && state.seconds >= 4) {
          clearTimeout(timer); release(); resolve()
        }
      })
      cancel = () => { clearTimeout(timer); release(); resolve() }
    })
    // start() itself can fail before the caller reaches its await.
    void promise.catch(() => {})
    return { promise, cancel: () => cancel(), activate: () => { active = true } }
  }
}

/** Keep offered retry options for this broadcast, never expired input URLs. */
function retainAdaptiveQualities(previous: ResolvedStream | undefined, current: ResolvedStream): ResolvedStream {
  if (previous?.platform !== 'youtube' || current.platform !== 'youtube' || previous.channel !== current.channel) return current
  const ids = new Set(current.qualities?.map(option => option.id))
  const retained = previous.qualities?.filter(option => option.adaptive && !ids.has(option.id)) ?? []
  if (!retained.length) return current
  return { ...current, qualities: [...current.qualities ?? [], ...retained]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.fps ?? 0) - (a.fps ?? 0)) }
}

function refusal(message: string): ResolveResult {
  return { ok: false, failure: { code: 'upstream-error', message, hint: '检查后重新加载, 或使用本地文件' } }
}
