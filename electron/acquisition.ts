import type { AcquisitionService } from '../server/api'
import { createResolverDeps, sanitizedFailure } from '../server/api'
import type { ProxyConfig } from '../server/config'
import { detectPlatform, resolveStream, type PlatformKind, type ResolveResult, type ResolvedStream } from '../server/platforms'
import { checkUrl, ProxyError, type Resolver } from '../server/safeFetch'
import type { SourceRole } from '../src/core/types'
import type { BufferInput, BufferManager, BufferState } from './bufferManager'
import type { LoginManager } from './login'

type Selection = { input: string; platform?: PlatformKind; quality?: string; stream: ResolvedStream }

/** Only main-produced, checked inputs can reach the buffer's ffmpeg spawner. */
export class Acquisition implements AcquisitionService {
  private readonly selections = new Map<SourceRole, Selection>()
  private readonly generations: Record<SourceRole, number> = { official: 0, commentary: 0 }
  private readonly activeGenerations: Partial<Record<SourceRole, number>> = {}
  private disposed = false
  constructor(private readonly deps: {
    buffer: Pick<BufferManager, 'start' | 'stop' | 'subscribe'>
    logins: Pick<LoginManager, 'login' | 'loginStatus' | 'logout' | 'cookieHeader'>
    runYtDlp: (url: string) => Promise<unknown>
    proxy: ProxyConfig
    fetchImpl?: typeof fetch
    dns?: Resolver
    readyTimeoutMs?: number
    ensureTools?: (platform: PlatformKind | null) => Promise<void>
  }) {}

  async resolve(input: string, platform: PlatformKind | undefined, role: SourceRole, quality?: string): Promise<ResolveResult> {
    const generation = ++this.generations[role]
    if (this.disposed) return refusal('取流服务已关闭')
    // Local fixtures bypass acquisition but still release the previous producer.
    if (/^\/test-sources\/(?:[\w-]+\/)*[\w-]+\.(?:m3u8|mp4|webm|mov|mkv|ts)$/.test(input)
      && (platform === undefined || platform === 'direct')) {
      await this.deps.buffer.stop(role)
      if (generation !== this.generations[role]) return refusal('片源操作已被替换')
      this.selections.delete(role)
      return { ok: true, stream: {
        platform: 'direct', channel: 'fixture', kind: input.endsWith('.m3u8') ? 'hls' : 'progressive',
        url: input, label: '本地测试源', requiresProxy: false,
      } }
    }
    if (!this.deps.proxy.enabled) return refusal('远程媒体读取已关闭')
    const detected = detectPlatform(input, platform)
    if (detected === 'youtube') await this.deps.ensureTools?.(detected)
    const first = await this.resolveInput(input, platform, quality)
    if (generation !== this.generations[role] || this.disposed) return refusal('片源操作已被替换')
    if (!first.ok) return first
    if (detected !== 'youtube') await this.deps.ensureTools?.(detected)
    if (generation !== this.generations[role] || this.disposed) return refusal('片源操作已被替换')
    let initial = true
    const prepare = async (): Promise<BufferInput> => {
      const resolved = initial ? first : await this.resolveInput(input, platform, quality)
      initial = false
      if (generation !== this.activeGenerations[role] || this.disposed) throw new Error('片源操作已取消')
      if (!resolved.ok) throw new Error('重新解析直播失败')
      return { url: resolved.stream.url, headers: resolved.stream.headers
        ?? (resolved.stream.platform === 'bilibili' ? { Referer: 'https://live.bilibili.com/' } : undefined) }
    }
    // Subscribe before start so a fast producer cannot race its first usable playlist.
    const readiness = this.waitUntilPlayable(role, generation)
    try {
      readiness.activate()
      this.activeGenerations[role] = generation
      const local = await this.deps.buffer.start(role, prepare)
      await readiness.promise
      if (generation !== this.generations[role] || this.disposed) return refusal('片源操作已被替换')
      const selection: Selection = { input, platform, quality, stream: first.stream }
      this.selections.set(role, selection)
      const { headers: _headers, ...publicStream } = first.stream
      return { ok: true, stream: {
        ...publicStream, url: local.url, kind: 'hls', requiresProxy: false,
        notes: ['主进程转封装为本地 HLS, 默认保留最近 180 秒', ...(first.stream.notes ?? [])],
      } }
    } catch (error) {
      if (generation === this.generations[role]) {
        this.selections.delete(role)
        await this.deps.buffer.stop(role)
      }
      // Preserve structured locator errors without passing subprocess diagnostics.
      if (error instanceof Error && 'tool' in error && 'code' in error) throw error
      return refusal('本地缓冲未能就绪, 请检查工具和直播状态')
    } finally { readiness.cancel() }
  }

  async switchQuality(role: SourceRole, quality: string): Promise<ResolveResult> {
    const selected = this.selections.get(role)
    if (!selected || !selected.stream.qualities?.some((option) => option.id === quality)) {
      return { ok: false, failure: { code: 'unsupported-url', message: '该片源没有此画质', hint: '请重新解析片源' } }
    }
    return this.resolve(selected.input, selected.platform, role, quality)
  }

  async stop(role: SourceRole): Promise<void> {
    ++this.generations[role]
    delete this.activeGenerations[role]
    this.selections.delete(role)
    await this.deps.buffer.stop(role)
  }
  subscribe(listener: (state: BufferState) => void): () => void { return this.deps.buffer.subscribe(listener) }
  login: AcquisitionService['login'] = (platform) => this.deps.logins.login(platform)
  loginStatus: AcquisitionService['loginStatus'] = () => this.deps.logins.loginStatus()
  logout: AcquisitionService['logout'] = (platform) => this.deps.logins.logout(platform)

  dispose(): void {
    this.disposed = true
    this.generations.official++
    this.generations.commentary++
    delete this.activeGenerations.official
    delete this.activeGenerations.commentary
    this.selections.clear()
  }

  private async resolveInput(input: string, platform?: PlatformKind, quality?: string): Promise<ResolveResult> {
    const resolver = createResolverDeps(this.deps.proxy, (url) => url, this.deps.fetchImpl)
    const result = await resolveStream(input, {
      ...resolver, quality, runYtDlp: this.deps.runYtDlp,
      douyuCookie: detectPlatform(input, platform) === 'douyu' ? await this.deps.logins.cookieHeader('douyu') : undefined,
    }, platform)
    if (!result.ok) return sanitizedFailure(result)
    const checked = await checkUrl(result.stream.url, this.deps.proxy, this.deps.dns)
    if (!checked.ok) throw new ProxyError(checked.reason, '媒体地址未通过安全检查')
    if (checked.url.username || checked.url.password) throw new ProxyError('invalid-url', '媒体地址不能包含登录凭据')
    return result
  }

  private waitUntilPlayable(role: SourceRole, generation: number) {
    let cancel = () => {}
    let active = false
    const promise = new Promise<void>((resolve, reject) => {
      let release = () => {}
      const timer = setTimeout(() => { release(); reject(new Error('缓冲超时')) }, this.deps.readyTimeoutMs ?? 60_000)
      release = this.deps.buffer.subscribe((state) => {
        if (!active || state.role !== role) return
        if (generation !== this.generations[role] || this.disposed) { clearTimeout(timer); release(); reject(new Error('片源已替换')); return }
        if (state.state === 'failed') { clearTimeout(timer); release(); reject(new Error('缓冲失败')) }
        else if (state.state === 'ready' || (state.state === 'buffering' && state.seconds >= 4)) {
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

function refusal(message: string): ResolveResult {
  return { ok: false, failure: { code: 'upstream-error', message, hint: '检查后重新加载, 或使用本地文件' } }
}
