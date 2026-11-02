import { cleanProxyEnvironment, networkContext, type NetworkContext } from '../server/networkPolicy'
import { StreamFailureError, classifyFfmpegStderr, classifyNetworkFailure } from '../server/networkFailure'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { locateTool, locateYouTubePotProvider, type ToolSettings, type ToolContext, type YouTubePotProvider } from './toolLocator'
import { killProcessTree } from './bufferManager'
import { youtubeAdaptiveFormats, youtubeFormats } from '../server/platforms/youtube'
import { prepareScriptOnlyPotPlugin, type PrivatePotPlugin } from './potPlugin'
import { DIAGNOSTIC_CODES, type DiagnosticCode, type DiagnosticEvent, type DiagnosticFormatSummary } from './diagnosticContracts'

// Keep the fields consumed by the selectors, without huge fragment/subtitle histories.
// yt-dlp's dictionary projection runs before the data reaches the bounded parent pipe.
export const YOUTUBE_METADATA_TEMPLATE = '{"metadata":%(.{id,is_live,live_status})j,"formats":%(formats.:.{format_id,url,protocol,height,fps,tbr,vcodec,acodec,ext})j}'
const MAX_METADATA_BYTES = 16 * 1_048_576

export interface YoutubeCookieAccess {
  withTemporaryCookies<T>(platform: 'youtube', callback: (path?: string) => Promise<T>): Promise<T>
}

export interface YtDlpDiagnostic extends Omit<DiagnosticEvent, 'at'> {}
type DiagnosticContext = { emit: (event: Omit<YtDlpDiagnostic, 'extractionId'>) => void }
type ChildStage = 'hls' | 'hls-fallback' | 'adaptive' | 'huya'
const fixedCodes = new Set<string>(DIAGNOSTIC_CODES)

function fixedCode(value: unknown, fallback: DiagnosticCode): DiagnosticCode {
  return typeof value === 'string' && (fixedCodes.has(value) || /^http-[45]\d{2}$/.test(value)) ? value as DiagnosticCode : fallback
}

function errorCode(error: unknown, fallback: DiagnosticCode): DiagnosticCode {
  if (error instanceof StreamFailureError) return fixedCode(error.failure.code, fallback)
  return error && typeof error === 'object' && 'code' in error ? fixedCode(error.code, fallback) : fallback
}

function heights(values: unknown[]): number[] {
  return [...new Set(values.filter((height): height is number => Number.isSafeInteger(height) && Number(height) > 0 && Number(height) <= 16384))]
    .sort((a, b) => b - a).slice(0, 16)
}

/** Reduce untrusted metadata to counters before passing anything to diagnostic observers. */
function formatSummary(info: { formats: unknown[] }, huya: boolean): DiagnosticFormatSummary {
  const summary: DiagnosticFormatSummary = { total: info.formats.length,
    protocols: { hls: 0, https: 0, dash: 0, other: 0 },
    videoCodecs: { h264: 0, vp9: 0, av1: 0, none: 0, other: 0 },
    audioCodecs: { aac: 0, opus: 0, none: 0, other: 0 }, muxedHls: 0, adaptivePairs: 0 }
  for (const raw of info.formats) {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const protocol = typeof item.protocol === 'string' ? item.protocol : ''
    summary.protocols[/^m3u8(?:_native)?$/.test(protocol) ? 'hls' : protocol === 'https' ? 'https'
      : protocol === 'http_dash_segments' ? 'dash' : 'other']++
    const video = typeof item.vcodec === 'string' ? item.vcodec : ''
    summary.videoCodecs[/^(?:avc1|h264)/i.test(video) ? 'h264' : /^vp0?9(?:\.|$)/i.test(video) ? 'vp9'
      : /^av01(?:\.|$)/i.test(video) ? 'av1' : video === 'none' ? 'none' : 'other']++
    const audio = typeof item.acodec === 'string' ? item.acodec : ''
    summary.audioCodecs[/^(?:mp4a|aac)/i.test(audio) ? 'aac' : /^opus(?:\.|$)/i.test(audio) ? 'opus' : audio === 'none' ? 'none' : 'other']++
  }
  if (!huya) { summary.muxedHls = youtubeFormats(info).length; summary.adaptivePairs = youtubeAdaptiveFormats(info, 0).length }
  return summary
}

/** This is evidence of a returned token-bearing media URL, not proof that a provider process ran. */
function observedToken(formats: unknown[]): boolean {
  return formats.some(raw => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    if (typeof item.url !== 'string') return false
    try {
      const url = new URL(item.url)
      return url.protocol === 'https:' && !url.username && !url.password && !url.port
        && /^(?:[a-z0-9-]+\.)+googlevideo\.com$/i.test(url.hostname) && url.pathname === '/videoplayback'
        && Boolean(url.searchParams.get('pot'))
    } catch { return false }
  })
}

/** Classify diagnostics without retaining paths, cookies, tokens or upstream URLs. */
function warningCodes(stderr: string): NonNullable<YtDlpDiagnostic['warnings']> {
  return [
    [/sign in|not a bot|login|required|members.only|private video/i, 'authentication'],
    [/po.?token|pot provider|bgutil/i, 'token-provider'],
    [/javascript|js challenge|challenge solver|js runtime/i, 'javascript-runtime'],
    [/timed?\s*out|timeout|connection|unable to download|HTTP Error/i, 'network'],
    [/no.*formats|requested format|only images/i, 'formats-unavailable'],
    [/no module|cannot find module|module.not.found|ENOENT/i, 'runtime-dependency'],
  ].flatMap(([pattern, code]) => (pattern as RegExp).test(stderr) ? [code as NonNullable<YtDlpDiagnostic['warnings']>[number]] : [])
}

function youtubeFailureCode(stderr: string): DiagnosticCode {
  if (/age.restricted|confirm your age/i.test(stderr)) return 'age-restricted'
  if (/not a bot/i.test(stderr)) return 'bot-check'
  if (/members.only/i.test(stderr)) return 'members-only'
  if (/geo.restricted|available in your country|available from your location/i.test(stderr)) return 'geo-restricted'
  if (/private video/i.test(stderr)) return 'private'
  if (/sign in|login|required/i.test(stderr)) return 'sign-in'
  if (/not (?:currently )?live|recording is not available|live (?:event|stream) (?:has ended|will begin)/i.test(stderr)) return 'not-live'
  return 'extractor-failed'
}

/**
 * A fixed label for why YouTube refused the run. The distinctions matter to the UI (a sign-in
 * can lift a bot check, a region cannot be lifted), so they must not collapse into one message.
 * youtube.ts maps these labels to user wording; the extractor's own text is never returned.
 */
function youtubeFailureLabel(stderr: string): string {
  if (/age.restricted|confirm your age/i.test(stderr)) return 'YouTube age restricted'
  if (/not a bot/i.test(stderr)) return 'YouTube bot check'
  if (/members.only/i.test(stderr)) return 'YouTube members only'
  if (/geo.restricted|available in your country|available from your location/i.test(stderr)) return 'YouTube geo restricted'
  if (/private video/i.test(stderr)) return 'YouTube private video'
  if (/sign in|login|required/i.test(stderr)) return 'YouTube sign in required'
  if (/not (?:currently )?live|recording is not available|live (?:event|stream) (?:has ended|will begin)/i.test(stderr)) return 'YouTube not currently live'
  return 'YouTube 取流失败, 请检查直播状态和网络'
}

/** Captured metadata is private and bounded; stderr is classified, never returned. */
export class YtDlpRunner {
  private readonly children = new Set<ChildProcess>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly terminations = new WeakMap<ChildProcess, Promise<void>>()
  private extractionSequence = 0
  private disposed = false
  constructor(private readonly options: {
    electronPath: string
    networkRuntimePath: string
    cookies: YoutubeCookieAccess
    settings?: ToolSettings
    toolContext?: ToolContext
    env?: NodeJS.ProcessEnv
    spawn?: typeof spawn
    timeoutMs?: number
    killTree?: (child: ChildProcess) => Promise<void>
    diagnostic?: (event: YtDlpDiagnostic) => void
  }) {}

  async resolve(url: string, adaptive = true, network: NetworkContext = networkContext(/huya\.com/.test(url) ? 'huya' : 'youtube'), diagnostic?: (event: YtDlpDiagnostic) => void): Promise<unknown> {
    const extractionId = ++this.extractionSequence
    const observers = new Set([this.options.diagnostic, diagnostic])
    const context: DiagnosticContext = { emit: event => {
      // Observers are isolated from both the acquisition and each other's mutable copies.
      for (const observer of observers) {
        try { observer?.(structuredClone({ ...event, extractionId })) } catch { /* Diagnostics must not affect extraction. */ }
      }
    } }
    context.emit({ stage: 'resolve', status: 'started', adaptive })
    const operation = this.run(url, adaptive, network, context)
    this.pending.add(operation)
    try {
      const result = await operation
      context.emit({ stage: 'resolve', status: 'resolved' })
      return result
    } catch (error) {
      context.emit({ stage: 'resolve', status: this.disposed ? 'cancelled' : 'failed', code: this.disposed ? 'cancelled' : errorCode(error, 'extractor-failed') })
      throw error
    } finally { this.pending.delete(operation) }
  }

  private async run(url: string, adaptive: boolean, network: NetworkContext, context: DiagnosticContext): Promise<unknown> {
    if (this.disposed) throw new Error('取流服务已关闭')
    context.emit({ stage: 'route', status: 'started' })
    let route: Awaited<ReturnType<NetworkContext['route']>>
    try { route = await network.route(url) }
    catch (error) {
      context.emit({ stage: 'route', status: 'failed', route: 'unknown', routeReason: 'proxy-resolution-failed',
        code: fixedCode(classifyNetworkFailure(error, 'proxy').code, 'proxy-failed') })
      throw error
    }
    context.emit({ stage: 'route', status: 'resolved', route: route.kind === 'http' ? 'http' : 'direct',
      ...(['socks-unsupported', 'proxy-type-unsupported'].includes(route.reason ?? '') ? { routeReason: route.reason } : {}) })
    const proxyUrl = route.proxyUrl ?? ''
    const executable = await locateTool('yt-dlp', this.options.settings, this.options.env, this.options.toolContext)
    if (/^https:\/\/www\.huya\.com\/[1-9]\d{0,15}$/.test(url)) {
      // Huya's last-resort extractor is anonymous and never loads YouTube cookies,
      // PO providers, external plugins or JavaScript runtimes. Reuse the bounded pipe.
      return this.runChild(executable, [
        '--ignore-config', '--no-cache-dir', '--no-playlist', '--no-progress',
        '--socket-timeout', '20', '--retries', '1', '--extractor-retries', '1',
        '--no-plugin-dirs', '--no-js-runtimes', '--no-remote-components',
        '--skip-download', '--print', YOUTUBE_METADATA_TEMPLATE, '--', url,
      ], 'huya', proxyUrl, context)
    }
    const provider = adaptive ? await locateYouTubePotProvider(this.options.env, this.options.toolContext) : undefined
    context.emit({ stage: 'provider', status: !adaptive ? 'skipped' : provider ? 'available' : 'unavailable',
      providerConfigured: Boolean(provider), providerOutcome: adaptive && provider ? 'unconfirmed' : 'not-requested' })
    return this.options.cookies.withTemporaryCookies('youtube', async (cookiePath) => {
      if (this.disposed) throw new Error('取流服务已关闭')
      const args = [
        '--ignore-config', '--no-cache-dir', '--no-playlist', '--no-progress',
        '--socket-timeout', '20', '--retries', '1', '--extractor-retries', '1',
        '--no-js-runtimes', '--js-runtimes', `node:${this.options.electronPath}`,
        '--no-remote-components', '--skip-download', '--print', YOUTUBE_METADATA_TEMPLATE,
        ...(cookiePath ? ['--cookies', cookiePath] : []), '--', url,
      ]
      if (provider) {
        // Client-specific extractions may expose disjoint HLS and adaptive formats.
        // Keep the existing HLS run unchanged and merge eligible adaptive additions.
        const hlsRun = this.runChild(executable, args, 'hls', proxyUrl, context)
        let plugin: PrivatePotPlugin | undefined
        const adaptiveRun = (async (): Promise<unknown> => {
          try {
            plugin = await prepareScriptOnlyPotPlugin(provider.pluginDir)
            context.emit({ stage: 'provider', status: 'prepared', client: 'web', providerConfigured: true, providerOutcome: 'unconfirmed' })
            const providerArgs = [
              '--no-plugin-dirs', '--plugin-dirs', plugin.pluginDir,
              '--extractor-args', `youtubepot-bgutilscript:server_home=${provider.serverHome}`,
              '--extractor-args', 'youtube:player_client=web;formats=incomplete',
            ]
            // generate_once.js is spawned by the plugin; never start the HTTP server.
            return await this.runChild(executable, [...args.slice(0, -2), ...providerArgs, ...args.slice(-2)], 'adaptive', proxyUrl, context)
          } catch {
            if (!plugin) {
              context.emit({ stage: 'provider', status: 'failed', client: 'web', code: 'provider-prepare-failed', providerConfigured: true, providerOutcome: 'warning' })
              context.emit({ stage: 'adaptive', status: 'skipped', client: 'web', code: 'provider-prepare-failed', providerConfigured: true, providerOutcome: 'warning' })
            }
            // A provider failure must not remove the existing cookie-aware HLS path.
            return undefined
          } finally {
            await plugin?.dispose()
          }
        })()
        const [hlsResult, adaptiveInfo] = await Promise.allSettled([hlsRun, adaptiveRun])
        if (this.disposed) throw new Error('yt-dlp 超时或已取消')
        if (hlsResult.status === 'rejected') throw hlsResult.reason
        const merged = mergeAdaptiveFormats(hlsResult.value, adaptiveInfo.status === 'fulfilled' ? adaptiveInfo.value : undefined)
        return this.recoverHls(executable, args, merged, proxyUrl, adaptive, context, provider)
      }
      context.emit({ stage: 'adaptive', status: 'skipped', client: 'web', providerConfigured: false, providerOutcome: 'not-requested' })
      return this.recoverHls(executable, args, await this.runChild(executable, args, 'hls', proxyUrl, context), proxyUrl, adaptive, context)
    })
  }

  /** Retry Safari once only when live metadata has no currently usable playback path. */
  private async recoverHls(executable: string, args: string[], info: unknown, proxyUrl: string, adaptive: boolean, context: DiagnosticContext, provider?: YouTubePotProvider): Promise<unknown> {
    const metadata = info as Record<string, unknown>
    if (metadata.is_live !== true || (typeof metadata.live_status === 'string' && metadata.live_status !== 'is_live')
      || typeof metadata.id !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(metadata.id) || youtubeFormats(info).length
      || (adaptive && youtubeAdaptiveFormats(info, 0).length)) return info
    let plugin: PrivatePotPlugin | undefined
    try {
      if (provider) {
        try {
          plugin = await prepareScriptOnlyPotPlugin(provider.pluginDir)
          context.emit({ stage: 'provider', status: 'prepared', client: 'web_safari', providerConfigured: true, providerOutcome: 'unconfirmed' })
        } catch { context.emit({ stage: 'provider', status: 'failed', client: 'web_safari', code: 'provider-prepare-failed', providerConfigured: true, providerOutcome: 'warning' }) }
      }
      const fallbackArgs = ['--no-plugin-dirs',
        ...(plugin && provider ? ['--plugin-dirs', plugin.pluginDir, '--extractor-args', `youtubepot-bgutilscript:server_home=${provider.serverHome}`] : []),
        '--extractor-args', 'youtube:player_client=web_safari']
      const recovered = await this.runChild(executable, [...args.slice(0, -2), ...fallbackArgs, ...args.slice(-2)], 'hls-fallback', proxyUrl, context)
      return mergeAdaptiveFormats(info, recovered)
    } catch (error) {
      if (this.disposed) throw error
      // Retain the original live metadata so the resolver can classify its format limitation.
      return info
    } finally { await plugin?.dispose().catch(() => {}) }
  }

  private runChild(executable: string, args: string[], stage: ChildStage, proxyUrl: string, context: DiagnosticContext): Promise<unknown> {
    const client = stage === 'adaptive' ? 'web' : stage === 'hls-fallback' ? 'web_safari' : stage === 'huya' ? 'huya' : 'default'
    const providerConfigured = args.includes('--plugin-dirs')
    const event = (value: Omit<YtDlpDiagnostic, 'stage' | 'client' | 'extractionId'>) => context.emit({ ...value, stage, client, providerConfigured })
    if (this.disposed) {
      event({ status: 'cancelled', code: 'cancelled', stopReason: 'cancelled', stopped: true })
      return Promise.reject(new Error('yt-dlp 超时或已取消'))
    }
    event({ status: 'started', providerOutcome: providerConfigured ? 'unconfirmed' : 'not-requested' })
    // Only this child (and its JS runtime) inherits Electron's Node mode.
    const env: NodeJS.ProcessEnv = { ...cleanProxyEnvironment(this.options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8',
      ...(this.options.toolContext?.providerCacheHome ? { XDG_CACHE_HOME: this.options.toolContext.providerCacheHome } : {}) }
    // The script provider forwards yt-dlp's proxy; its empty-proxy environment fallback is also cleared.
    if (proxyUrl) { env.HTTP_PROXY = proxyUrl; env.HTTPS_PROXY = proxyUrl; env.ALL_PROXY = proxyUrl }
    const runtime = this.options.networkRuntimePath
    if (!path.isAbsolute(runtime) || /["\r\n\0]/.test(runtime)) {
      event({ status: 'failed', code: 'runtime-unavailable' })
      return Promise.reject(new Error('取流网络运行时不可用'))
    }
    // Only this child tree inherits the bootstrap. Forward slashes keep Windows
    // paths intact in Node's NODE_OPTIONS parser, including paths with spaces.
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require="${runtime.replace(/\\/g, '/')}"`.trim()
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stdoutBytes = 0
      let stderr = ''
      let stopReason: YtDlpDiagnostic['stopReason']
      let settled = false
      let child: ChildProcess
      try {
        child = (this.options.spawn ?? spawn)(executable, ['--proxy', proxyUrl, ...args], {
          env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch {
        event({ status: 'failed', code: 'spawn-failed' })
        reject(new Error('无法启动 yt-dlp, 请检查工具路径'))
        return
      }
      this.children.add(child)
      const stop = (reason: NonNullable<YtDlpDiagnostic['stopReason']>) => {
        if (stopReason) return
        stopReason = reason
        stdout = ''
        void this.terminate(child)
      }
      const timer = setTimeout(() => stop('timeout'), this.options.timeoutMs ?? 120_000)
      const finish = () => { clearTimeout(timer); this.children.delete(child) }
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stopReason || this.disposed) return
        stdoutBytes += chunk.length
        if (stdoutBytes > MAX_METADATA_BYTES) { stop('output-limit'); return }
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-32_768) })
      child.once('error', () => {
        if (settled) return
        settled = true
        finish()
        event({ status: 'failed', code: 'spawn-failed' })
        reject(new Error('无法启动 yt-dlp, 请检查工具路径'))
      })
      child.once('close', (code) => {
        if (settled) return
        settled = true
        finish()
        const warnings = warningCodes(stderr)
        const completed = { exitCode: Number.isSafeInteger(code) ? code : null, warnings,
          providerOutcome: warnings.includes('token-provider') ? 'warning' as const : providerConfigured ? 'unconfirmed' as const : 'not-requested' as const }
        if (stopReason === 'output-limit') {
          event({ ...completed, status: 'failed', code: 'output-limit', stopped: true, stopReason })
          reject(new Error('yt-dlp 媒体信息超过大小限制')); return
        }
        if (stopReason || this.disposed) {
          const reason = stopReason ?? 'cancelled'
          event({ ...completed, status: reason === 'cancelled' ? 'cancelled' : 'failed', code: reason, stopped: true, stopReason: reason })
          reject(new Error('yt-dlp 超时或已取消')); return
        }
        if (code !== 0) {
          const classified = classifyFfmpegStderr(stderr)
          if (classified) {
            const failure = proxyUrl ? classifyNetworkFailure(new Error(stderr), 'proxy') : classified
            event({ ...completed, status: 'failed', code: fixedCode(failure.code, 'extractor-failed'), stopped: false })
            reject(new StreamFailureError(failure)); return
          }
          event({ ...completed, status: 'failed', code: youtubeFailureCode(stderr), stopped: false })
          if (stage === 'huya') {
            reject(new Error(/sign in|login|required|forbidden|restricted|geo.restrict|登录|封禁|整改/i.test(stderr)
              ? '虎牙访问受限, 当前暂不支持登录' : /not (?:currently )?live|offline|未开播/i.test(stderr)
                ? '虎牙房间当前未开播' : '虎牙取流失败, 请检查直播状态和网络'))
            return
          }
          reject(new Error(youtubeFailureLabel(stderr)))
          return
        }
        try {
          const result: unknown = JSON.parse(stdout)
          if (!result || typeof result !== 'object' || !('metadata' in result) || !result.metadata
            || typeof result.metadata !== 'object' || Array.isArray(result.metadata)
            || !('formats' in result) || !Array.isArray(result.formats)) throw new Error('invalid metadata envelope')
          const formats = result.formats
          const info = { ...result.metadata, formats }
          const adaptiveFormats = stage === 'huya' ? [] : youtubeAdaptiveFormats(info, 0)
          event({ ...completed, status: 'resolved', stopped: false,
            heights: heights(formats.map(format => format && typeof format === 'object' ? format.height : undefined)),
            adaptiveHeights: heights(adaptiveFormats.map(format => format.height)),
            formats: formatSummary(info, stage === 'huya'),
            providerOutcome: observedToken(formats) ? 'token-observed' : completed.providerOutcome })
          resolve(info)
        } catch {
          event({ ...completed, status: 'failed', code: 'invalid-metadata', stopped: false })
          reject(new Error('yt-dlp 返回无效的媒体信息'))
        }
      })
    })
  }

  private terminate(child: ChildProcess): Promise<void> {
    let pending = this.terminations.get(child)
    if (!pending) {
      // stdout, timeout and disposal can race while the native child is still closing.
      pending = Promise.resolve().then(() => (this.options.killTree ?? killProcessTree)(child))
        .catch(() => { try { child.kill() } catch { /* Already closed. */ } })
      this.terminations.set(child, pending)
    }
    return pending
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.children].map((child) => this.terminate(child)))
    await Promise.allSettled([...this.pending])
  }
}

/**
 * Keep default-client HLS when available, otherwise recover compatible HLS from the
 * same broadcast's web extraction. Append only supported adaptive video/audio pairs.
 */
export function mergeAdaptiveFormats(hlsInfo: unknown, adaptiveInfo: unknown): unknown {
  const hls = hlsInfo && typeof hlsInfo === 'object' ? hlsInfo as Record<string, unknown> : null
  const adaptive = adaptiveInfo && typeof adaptiveInfo === 'object' ? adaptiveInfo as Record<string, unknown> : null
  if (!hls || !adaptive || !Array.isArray(hls.formats) || !Array.isArray(adaptive.formats)) return hlsInfo
  // A channel can change broadcasts between independent extractions. Never pair
  // one live video's HLS fallback with another video's adaptive elementary streams.
  if (typeof hls.id !== 'string' || adaptive.id !== hls.id || adaptive.is_live !== true
    || (typeof adaptive.live_status === 'string' && adaptive.live_status !== 'is_live')) return hlsInfo
  let baseFormats = hls.formats as Record<string, unknown>[]
  let best = youtubeFormats(hlsInfo)[0]
  if (!best) {
    const recovered = youtubeFormats(adaptiveInfo)
    const recoveredIds = new Set(recovered.map(format => format.format_id))
    // Replace unusable entries with the same id rather than hiding the recovered rendition.
    if (recovered.length) baseFormats = [
      ...baseFormats.filter(format => !recoveredIds.has(String(format?.format_id))),
      ...(adaptive.formats as Record<string, unknown>[]).filter(format => recoveredIds.has(String(format?.format_id))),
    ]
    best = recovered[0]
  }
  const accepted = youtubeAdaptiveFormats(adaptiveInfo, best?.height ?? 0)
  if (!accepted.length) return baseFormats === hls.formats ? hlsInfo : { ...hls, formats: baseFormats }
  const ids = new Set(accepted.flatMap((format) => [format.format_id]))
  const audioUrl = accepted[0]!.adaptive!.audioUrl
  const extra = (adaptive.formats as Record<string, unknown>[]).filter((format) =>
    ids.has(String(format.format_id)) || format.url === audioUrl)
  const extraIds = new Set(extra.map(format => String(format.format_id)))
  return { ...hls, formats: [...baseFormats.filter(format => !extraIds.has(String(format.format_id))), ...extra] }
}
