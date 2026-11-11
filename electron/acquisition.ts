import { createDouyuRoomResolver, type ResolveDouyuRoom } from '../server/platforms/douyuRoom'
import type { AcquisitionService } from '../server/api'
import { createResolverDeps, sanitizedFailure } from '../server/api'
import { mediaRequestPolicy, type ProxyConfig } from '../server/config'
import type { MediaAccess } from '../server/mediaAccess'
import { detectPlatform, resolveStream, type PlatformKind, type ResolveResult, type ResolvedStream } from '../server/platforms'
import { checkUrlSyntax, ProxyError, type Resolver } from '../server/safeFetch'
import { networkContext, type NetworkContext } from '../server/networkPolicy'
import { StreamFailureError, classifyNetworkFailure, type StreamFailure } from '../server/networkFailure'
import { isStreamId, type StreamId } from './streamIdentity'
import type { BufferInput, BufferManager, BufferState } from './bufferManager'
import type { LoginManager } from './login'
import type { YtDlpDiagnostic } from './ytdlp'
import type { AcquisitionDiagnosticRecorder, DiagnosticAttemptSink } from './diagnosticContracts'
import { diagnosticCode } from './diagnosticSanitizer'

type Selection = { input: string; platform?: PlatformKind; quality?: string; preferAdaptive?: boolean; stream: ResolvedStream; readBytes?: () => number; mediaRevision?: number }

/** Only main-produced, checked inputs can reach the buffer's ffmpeg spawner. */
export class Acquisition implements AcquisitionService {
  private readonly selections = new Map<StreamId, Selection>()
  private readonly generations = new Map<StreamId, number>()
  private readonly activeGenerations = new Map<StreamId, number>()
  private readonly publicStreams = new Map<StreamId, ResolvedStream>()
  private generationSequence = 0
  private disposed = false
  constructor(private readonly deps: {
    buffer: Pick<BufferManager, 'start' | 'stop' | 'subscribe'>
    logins: Pick<LoginManager, 'login' | 'loginStatus' | 'logout' | 'cookieHeader'>
    runYtDlp: (url: string, adaptive?: boolean, network?: NetworkContext, diagnostic?: (event: YtDlpDiagnostic) => void) => Promise<unknown>
    diagnostics?: AcquisitionDiagnosticRecorder
    proxy: ProxyConfig
    network?: (platform: PlatformKind | null) => NetworkContext
    mediaInput?: (url: string, headers: Record<string,string> | undefined, network: NetworkContext, access?: MediaAccess) => Promise<{url:string;proxyUrl:string;readFailure?:()=>StreamFailure|undefined;readBytes?:()=>number}>
    fetchImpl?: typeof fetch
    resolveDouyuRoom?: ResolveDouyuRoom
    dns?: Resolver
    readyTimeoutMs?: number
    ensureTools?: (platform: PlatformKind | null) => Promise<void>
  }) {}

  async resolve(input: string, platform: PlatformKind | undefined, role: StreamId, quality?: string, preferAdaptive = false, confirmedRoom?: string): Promise<ResolveResult> {
    const diagnostic = detectPlatform(input, platform) === 'youtube' ? this.deps.diagnostics?.begin(role) : undefined
    try {
      const result = await this.resolveAttempt(input, platform, role, quality, preferAdaptive, confirmedRoom, diagnostic)
      diagnostic?.finish(result.ok ? 'resolved' : 'failed', result.ok
        ? { stage: 'buffer', status: 'resolved' }
        : { stage: 'resolve', status: 'failed', code: diagnosticCode(result.failure.reason ?? result.failure.code) })
      return result
    } catch (error) {
      diagnostic?.finish('failed', { stage: 'resolve', status: 'failed', code: errorDiagnosticCode(error) })
      throw error
    }
  }

  private async resolveAttempt(input: string, platform: PlatformKind | undefined, role: StreamId, quality?: string, preferAdaptive = false, confirmedRoom?: string, diagnostic?: DiagnosticAttemptSink): Promise<ResolveResult> {
    const cancelled = () => {
      diagnostic?.finish('cancelled', { stage: 'resolve', status: 'cancelled', code: 'cancelled' })
      return refusal('片源操作已被替换')
    }
    if (!isStreamId(role)) return refusal('播放会话无效')
    const generation = ++this.generationSequence
    this.generations.set(role, generation)
    if (this.disposed) return refusal('取流服务已关闭')
    // Local fixtures bypass acquisition but still release the previous producer.
    if (/^\/test-sources\/(?:[\w-]+\/)*[\w-]+\.(?:m3u8|mp4|webm|mov|mkv|ts)$/.test(input)
      && (platform === undefined || platform === 'direct')) {
      await this.deps.buffer.stop(role)
      if (generation !== this.generations.get(role) || this.disposed) return cancelled()
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
    const network = this.deps.network?.(detected) ?? networkContext(detected)
    let first: ResolveResult
    try { first = await this.resolveInput(input, platform, quality, preferAdaptive, false, confirmedRoom, network, diagnostic) }
    catch (error) { if (error instanceof ProxyError && error.reason !== 'dns-failed') throw error; return failedResult(classifyNetworkFailure(error, 'resolve')) }
    // A previously offered adaptive id can disappear when provider setup falls back
    // to the old extractor mode. Preserve playback instead of rejecting that switch.
    if (!first.ok && first.failure.code === 'unsupported-url' && detected === 'youtube' && requestedAdaptive?.height) {
      fallbackHeight = requestedAdaptive.height
      first = await this.resolveInput(input, platform, 'auto', false, true, undefined, network, diagnostic)
    }
    if (generation !== this.generations.get(role) || this.disposed) return cancelled()
    if (!first.ok) return { ...first, failure: { ...first.failure, stage: first.failure.stage ?? 'resolve', reason: first.failure.reason ?? first.failure.code } }
    if (detected !== 'youtube') await this.deps.ensureTools?.(detected)
    if (generation !== this.generations.get(role) || this.disposed) return cancelled()
    let initial = true
    const selection: Selection = { input, platform, quality, preferAdaptive, stream: retainAdaptiveQualities(sameSource, first.stream) }
    const prepare = async (hlsOnly = false): Promise<BufferInput> => {
      const reuse = initial && !hlsOnly
      const reconnect = !reuse && detected === 'youtube' ? this.deps.diagnostics?.begin(role, hlsOnly ? 'hls-recovery' : 'reconnect') : undefined
      let resolved: ResolveResult
      try {
        resolved = reuse ? first : await this.resolveInput(input, platform, hlsOnly ? 'auto' : quality, hlsOnly ? false : preferAdaptive, hlsOnly, selection.stream.sourceRoom, network, reconnect ?? diagnostic)
        reconnect?.finish(resolved.ok ? 'resolved' : 'failed', resolved.ok
          ? { stage: 'resolve', status: 'resolved', adaptive: Boolean(resolved.stream.adaptive) }
          : { stage: 'resolve', status: 'failed', code: diagnosticCode(resolved.failure.reason ?? resolved.failure.code) })
      } catch (error) {
        reconnect?.finish('failed', { stage: 'resolve', status: 'failed', code: errorDiagnosticCode(error) })
        throw error
      }
      initial = false
      if (generation !== this.activeGenerations.get(role) || this.disposed) throw new Error('片源操作已取消')
      if (!resolved.ok) throw new StreamFailureError({ stage: 'resolve', code: resolved.failure.code, message: resolved.failure.message })
      selection.stream = retainAdaptiveQualities(selection.stream, resolved.stream)
      const headers = resolved.stream.headers
        ?? (resolved.stream.platform === 'bilibili' ? { Referer: 'https://live.bilibili.com/' } : undefined)
      const media = !resolved.stream.adaptive && this.deps.mediaInput ? await this.deps.mediaInput(resolved.stream.url, headers, network, resolved.stream.mediaAccess) : undefined
      selection.readBytes = media?.readBytes
      selection.mediaRevision = (selection.mediaRevision ?? 0) + 1
      const route = media ? undefined : await network.route(resolved.stream.url)
      return { url: media?.url ?? resolved.stream.url, gatewayHls: Boolean(media && resolved.stream.kind === 'hls'), network, proxyUrl: media?.proxyUrl ?? route?.proxyUrl ?? '', readFailure: media?.readFailure, headers: media ? undefined : resolved.stream.headers
        ?? (!media && resolved.stream.platform === 'bilibili' ? { Referer: 'https://live.bilibili.com/' } : undefined),
        ...(resolved.stream.adaptive ? { adaptive: resolved.stream.adaptive } : {}),
        qualityHeight: resolved.stream.qualities?.find(option => option.id === resolved.stream.quality)?.height,
        ...(fallbackHeight ? { fallbackFromHeight: fallbackHeight } : {}),
      }
    }
    // Subscribe before start so a fast producer cannot race its first usable playlist.
    const readiness = this.waitUntilPlayable(role, generation, Boolean(first.stream.adaptive))
    diagnostic?.record({ stage: 'buffer', status: 'started', adaptive: Boolean(first.stream.adaptive) })
    try {
      readiness.activate()
      this.activeGenerations.set(role, generation)
      const local = await this.deps.buffer.start(role, prepare)
      await readiness.promise
      if (generation !== this.generations.get(role) || this.disposed) return cancelled()
      this.selections.set(role, selection)
      const { headers: _headers, adaptive: _adaptive, mediaAccess: _access, douyuWatchCdn: _cdn, ...publicStream } = selection.stream
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
      return failedResult(classifyNetworkFailure(error, 'playback-not-ready'))
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

  /** Internal watch authority and metrics. The renderer supplies neither room nor CDN. */
  watchSource(role: StreamId): { room: string; cdn: string; bytes: number; generation: string } | null {
    const selection = this.selections.get(role)
    if (!selection || selection.stream.platform !== 'douyu' || !selection.stream.sourceRoom || !selection.readBytes) return null
    const bytes = selection.readBytes()
    if (!Number.isSafeInteger(bytes) || bytes < 0) return null
    return { room: selection.stream.sourceRoom, cdn: selection.stream.douyuWatchCdn ?? '', bytes,
      generation: `${this.activeGenerations.get(role)}:${selection.mediaRevision}` }
  }

  async restart(role: StreamId): Promise<ResolveResult> {
    const selected = this.selections.get(role)
    if (!selected) return refusal('播放会话尚未就绪')
    return this.resolve(selected.input, selected.platform, role, selected.quality, selected.preferAdaptive, selected.stream.sourceRoom)
  }

  private async resolveInput(input: string, platform?: PlatformKind, quality?: string, preferAdaptive = false, hlsOnly = false, confirmedRoom?: string, network: NetworkContext = networkContext(detectPlatform(input, platform)), diagnostic?: DiagnosticAttemptSink): Promise<ResolveResult> {
    const resolver = createResolverDeps(this.deps.proxy, (url) => url, this.deps.fetchImpl, network)
    const detected = detectPlatform(input, platform)
    const result = await resolveStream(input, {
      ...resolver, quality, preferAdaptive, hlsOnly, resolveDouyuRoom: this.deps.resolveDouyuRoom ?? createDouyuRoomResolver(this.deps.proxy, this.deps.fetchImpl, this.deps.dns, network).resolve,
      ...(confirmedRoom ? { douyuRoomIdentity: { room: confirmedRoom, inputRoom: confirmedRoom } } : {}),
      runYtDlp: url => diagnostic ? this.deps.runYtDlp(url, !hlsOnly, network, event => diagnostic.record(event)) : this.deps.runYtDlp(url, !hlsOnly, network),
      douyuCookie: detected === 'douyu' ? await this.deps.logins.cookieHeader('douyu') : undefined,
      cookieHeader: detected === 'bilibili' || detected === 'huya'
        ? (cookiePlatform, requestUrl) => cookiePlatform === detected ? this.deps.logins.cookieHeader(cookiePlatform, requestUrl) : Promise.resolve('')
        : undefined,
      douyinCookieHeader: detected === 'douyin' ? requestUrl => this.deps.logins.cookieHeader('douyin', requestUrl) : undefined,
    }, platform)
    if (!result.ok) return sanitizedFailure(result)
    // Actual media connections own DNS and route validation; do not resolve the same target here.
    const checked = checkUrlSyntax(result.stream.url, mediaRequestPolicy(this.deps.proxy))
    if (!checked.ok) throw new ProxyError(checked.reason, '媒体地址未通过安全检查')
    if (checked.url.username || checked.url.password) throw new ProxyError('invalid-url', '媒体地址不能包含登录凭据')
    if (result.stream.adaptive) {
      for (const raw of [result.stream.adaptive.videoUrl, result.stream.adaptive.audioUrl]) {
        const target = checkUrlSyntax(raw, { ...this.deps.proxy, hosts: ['*.googlevideo.com'], allowNonStandardPorts: false })
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
      const timer = setTimeout(() => { release(); reject(new StreamFailureError({ stage: 'playback-not-ready', code: 'first-video-timeout', message: '解析成功, 但视频片段尚未就绪' })) }, this.deps.readyTimeoutMs ?? (adaptive ? 480_000 : 60_000))
      release = this.deps.buffer.subscribe((state) => {
        if (!active || state.role !== role) return
        if (generation !== this.generations.get(role) || this.disposed) { clearTimeout(timer); release(); reject(new Error('片源已替换')); return }
        if (state.state === 'failed') { clearTimeout(timer); release(); reject(new StreamFailureError(state.failure ?? { stage: 'playback-not-ready', code: state.reason ?? 'buffer-failed', message: '解析成功, 但拉流未能就绪' })) }
        else if (state.state === 'ready' && state.hasVideo === true && (state.completeSegments ?? 0) > 0 && state.seconds >= 4) {
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

function errorDiagnosticCode(error: unknown) {
  if (error instanceof StreamFailureError) return diagnosticCode(error.failure.code)
  if (error && typeof error === 'object' && 'code' in error) return diagnosticCode(error.code)
  if (error instanceof ProxyError) return diagnosticCode(error.reason)
  return 'unknown' as const
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

function failedResult(failure: StreamFailure): ResolveResult {
  return { ok: false, failure: { code: 'upstream-error', message: failure.message, stage: failure.stage, reason: failure.code, ...(failure.status ? { status: failure.status } : {}) } }
}
