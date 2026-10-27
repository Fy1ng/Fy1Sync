import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { locateTool, locateYouTubePotProvider, type ToolSettings, type ToolContext } from './toolLocator'
import { killProcessTree } from './bufferManager'
import { youtubeAdaptiveFormats, youtubeFormats } from '../server/platforms/youtube'
import { prepareScriptOnlyPotPlugin, type PrivatePotPlugin } from './potPlugin'

// Keep the fields consumed by the selectors, without huge fragment/subtitle histories.
// yt-dlp's dictionary projection runs before the data reaches the bounded parent pipe.
export const YOUTUBE_METADATA_TEMPLATE = '{"metadata":%(.{id,is_live,live_status})j,"formats":%(formats.:.{format_id,url,protocol,height,fps,tbr,vcodec,acodec,ext})j}'
const MAX_METADATA_BYTES = 16 * 1_048_576

export interface YoutubeCookieAccess {
  withTemporaryCookies<T>(platform: 'youtube', callback: (path?: string) => Promise<T>): Promise<T>
}

export interface YtDlpDiagnostic {
  stage: 'provider' | 'hls' | 'adaptive' | 'huya'
  status: 'available' | 'unavailable' | 'prepared' | 'failed' | 'resolved'
  exitCode?: number | null
  stopped?: boolean
  stopReason?: 'timeout' | 'output-limit'
  warnings?: string[]
  heights?: number[]
  adaptiveHeights?: number[]
}

/** Classify diagnostics without retaining paths, cookies, tokens or upstream URLs. */
function warningCodes(stderr: string): string[] {
  return [
    [/sign in|not a bot|login|required|members.only|private video/i, 'authentication'],
    [/po.?token|pot provider|bgutil/i, 'token-provider'],
    [/javascript|js challenge|challenge solver|js runtime/i, 'javascript-runtime'],
    [/timed?\s*out|timeout|connection|unable to download|HTTP Error/i, 'network'],
    [/no.*formats|requested format|only images/i, 'formats-unavailable'],
    [/no module|cannot find module|module.not.found|ENOENT/i, 'runtime-dependency'],
  ].flatMap(([pattern, code]) => (pattern as RegExp).test(stderr) ? [code as string] : [])
}

/** Captured metadata is private and bounded; stderr is classified, never returned. */
export class YtDlpRunner {
  private readonly children = new Set<ChildProcess>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly terminations = new WeakMap<ChildProcess, Promise<void>>()
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

  async resolve(url: string, adaptive = true): Promise<unknown> {
    const operation = this.run(url, adaptive)
    this.pending.add(operation)
    try { return await operation } finally { this.pending.delete(operation) }
  }

  private async run(url: string, adaptive: boolean): Promise<unknown> {
    if (this.disposed) throw new Error('取流服务已关闭')
    const executable = await locateTool('yt-dlp', this.options.settings, this.options.env, this.options.toolContext)
    if (/^https:\/\/www\.huya\.com\/[1-9]\d{0,15}$/.test(url)) {
      // Huya's last-resort extractor is anonymous and never loads YouTube cookies,
      // PO providers, external plugins or JavaScript runtimes. Reuse the bounded pipe.
      return this.runChild(executable, [
        '--ignore-config', '--no-cache-dir', '--no-playlist', '--no-progress',
        '--socket-timeout', '20', '--retries', '1', '--extractor-retries', '1',
        '--no-plugin-dirs', '--no-js-runtimes', '--no-remote-components',
        '--skip-download', '--print', YOUTUBE_METADATA_TEMPLATE, '--', url,
      ], 'huya')
    }
    const provider = adaptive ? await locateYouTubePotProvider(this.options.env, this.options.toolContext) : undefined
    this.options.diagnostic?.({ stage: 'provider', status: provider ? 'available' : 'unavailable' })
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
        const hlsRun = this.runChild(executable, args, 'hls')
        let plugin: PrivatePotPlugin | undefined
        const adaptiveRun = (async (): Promise<unknown> => {
          try {
            plugin = await prepareScriptOnlyPotPlugin(provider.pluginDir)
            this.options.diagnostic?.({ stage: 'provider', status: 'prepared' })
            const providerArgs = [
              '--no-plugin-dirs', '--plugin-dirs', plugin.pluginDir,
              '--extractor-args', `youtubepot-bgutilscript:server_home=${provider.serverHome}`,
              '--extractor-args', 'youtube:player_client=web;formats=incomplete',
            ]
            // generate_once.js is spawned by the plugin; never start the HTTP server.
            return await this.runChild(executable, [...args.slice(0, -2), ...providerArgs, ...args.slice(-2)], 'adaptive')
          } catch {
            // A provider failure must not remove the existing cookie-aware HLS path.
            return undefined
          } finally {
            await plugin?.dispose()
          }
        })()
        const [hlsResult, adaptiveInfo] = await Promise.allSettled([hlsRun, adaptiveRun])
        if (this.disposed) throw new Error('yt-dlp 超时或已取消')
        if (hlsResult.status === 'rejected') throw hlsResult.reason
        return mergeAdaptiveFormats(hlsResult.value, adaptiveInfo.status === 'fulfilled' ? adaptiveInfo.value : undefined)
      }
      return this.runChild(executable, args, 'hls')
    })
  }

  private runChild(executable: string, args: string[], stage: 'hls' | 'adaptive' | 'huya'): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('yt-dlp 超时或已取消'))
    // Only this child (and its JS runtime) inherits Electron's Node mode.
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8',
      ...(this.options.toolContext?.providerCacheHome ? { XDG_CACHE_HOME: this.options.toolContext.providerCacheHome } : {}) }
    const runtime = this.options.networkRuntimePath
    if (!path.isAbsolute(runtime) || /["\r\n\0]/.test(runtime)) return Promise.reject(new Error('取流网络运行时不可用'))
    // Only this child tree inherits the bootstrap. Forward slashes keep Windows
    // paths intact in Node's NODE_OPTIONS parser, including paths with spaces.
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require="${runtime.replace(/\\/g, '/')}"`.trim()
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stdoutBytes = 0
      let stderr = ''
      let stopReason: YtDlpDiagnostic['stopReason']
      const child = (this.options.spawn ?? spawn)(executable, args, {
        env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      })
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
      child.once('error', () => { finish(); reject(new Error('无法启动 yt-dlp, 请检查工具路径')) })
      child.once('close', (code) => {
        finish()
        this.options.diagnostic?.({ stage, status: code === 0 && !stopReason ? 'resolved' : 'failed', exitCode: code,
          stopped: Boolean(stopReason), ...(stopReason ? { stopReason } : {}), warnings: warningCodes(stderr) })
        if (stopReason === 'output-limit') { reject(new Error('yt-dlp 媒体信息超过大小限制')); return }
        if (stopReason || this.disposed) { reject(new Error('yt-dlp 超时或已取消')); return }
        if (code !== 0) {
          if (stage === 'huya') {
            reject(new Error(/sign in|login|required|forbidden|restricted|geo.restrict|登录|封禁|整改/i.test(stderr)
              ? '虎牙访问受限, 当前暂不支持登录' : /not (?:currently )?live|offline|未开播/i.test(stderr)
                ? '虎牙房间当前未开播' : '虎牙取流失败, 请检查直播状态和网络'))
            return
          }
          reject(new Error(/sign in|not a bot|login|required|members.only|private video/i.test(stderr)
            ? 'YouTube sign in required' : /not (?:currently )?live|recording is not available|live (?:event|stream) (?:has ended|will begin)/i.test(stderr)
              ? 'YouTube not currently live' : 'YouTube 取流失败, 请检查直播状态和网络'))
          return
        }
        try {
          const result: unknown = JSON.parse(stdout)
          if (!result || typeof result !== 'object' || !('metadata' in result) || !result.metadata
            || typeof result.metadata !== 'object' || Array.isArray(result.metadata)
            || !('formats' in result) || !Array.isArray(result.formats)) throw new Error('invalid metadata envelope')
          const formats = result.formats
          const info = { ...result.metadata, formats }
          this.options.diagnostic?.({ stage, status: 'resolved',
            heights: [...new Set(formats.map(format => format?.height).filter((height): height is number => Number.isSafeInteger(height) && height > 0))].sort((a, b) => b - a),
            adaptiveHeights: stage === 'huya' ? [] : youtubeAdaptiveFormats(info, 0).map(format => format.height),
          })
          resolve(info)
        } catch { reject(new Error('yt-dlp 返回无效的媒体信息')) }
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
 * The HLS extraction with the adaptive run's VP9/AV1 video and AAC audio formats appended.
 * Only formats the adaptive selector would accept are taken over; everything else about the
 * stream (live status, id, HLS formats) comes from the HLS run, so a broken provider can at
 * worst add nothing.
 */
export function mergeAdaptiveFormats(hlsInfo: unknown, adaptiveInfo: unknown): unknown {
  const hls = hlsInfo && typeof hlsInfo === 'object' ? hlsInfo as Record<string, unknown> : null
  const adaptive = adaptiveInfo && typeof adaptiveInfo === 'object' ? adaptiveInfo as Record<string, unknown> : null
  if (!hls || !adaptive || !Array.isArray(hls.formats) || !Array.isArray(adaptive.formats)) return hlsInfo
  // A channel can change broadcasts between independent extractions. Never pair
  // one live video's HLS fallback with another video's adaptive elementary streams.
  if (typeof hls.id !== 'string' || adaptive.id !== hls.id || adaptive.is_live !== true
    || (typeof adaptive.live_status === 'string' && adaptive.live_status !== 'is_live')) return hlsInfo
  const best = youtubeFormats(hlsInfo)[0]
  if (!best) return hlsInfo
  const accepted = youtubeAdaptiveFormats(adaptiveInfo, best.height)
  if (!accepted.length) return hlsInfo
  const ids = new Set(accepted.flatMap((format) => [format.format_id]))
  const audioUrl = accepted[0]!.adaptive!.audioUrl
  const extra = (adaptive.formats as Record<string, unknown>[]).filter((format) =>
    ids.has(String(format.format_id)) || format.url === audioUrl)
  const existing = new Set((hls.formats as Record<string, unknown>[]).map((format) => String(format.format_id)))
  return { ...hls, formats: [...hls.formats, ...extra.filter((format) => !existing.has(String(format.format_id)))] }
}
