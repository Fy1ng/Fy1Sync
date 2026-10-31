import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { cleanProxyEnvironment, networkContext, type NetworkContext } from '../server/networkPolicy'
import { killProcessTree } from './bufferManager'
import { locateTool, locateYouTubePotProvider, type ToolContext, type ToolSettings } from './toolLocator'
import { prepareScriptOnlyPotPlugin, type PrivatePotPlugin } from './potPlugin'
import type { YoutubeCookieAccess } from './ytdlp'

export type YtImportErrorCode = 'bot-challenge' | 'auth-required' | 'geo-restricted' | 'video-unavailable'
  | 'live-not-supported' | 'format-unavailable' | 'provider-failed' | 'network' | 'rate-limited'
  | 'disk-full' | 'too-long' | 'cancelled'
export type YtImportHeight = 2160 | 1440 | 1080
export interface YtImportRequest { url: string; startSeconds: number; endSeconds: number; targetHeight: YtImportHeight }
export interface YtImportFormat {
  videoFormatId: string; audioFormatId: string | null; width: number; height: number; fps: number
  videoCodec: string; audioCodec: string; container: 'mp4'
}
export interface YtImportMetadata {
  videoId: string; title: string; startSeconds: number; endSeconds: number; format: YtImportFormat
  sha256: string; size: number; downloadedAt: string
}
export interface YtImportJob {
  jobId: string; videoId: string; startSeconds: number; endSeconds: number; targetHeight?: YtImportHeight
  state: 'probing' | 'downloading' | 'ready' | 'failed' | 'cancelled'
  title?: string; duration?: number; format?: YtImportFormat; assetId?: string; mediaUrl?: string
  progress?: { downloadedBytes: number; totalBytes?: number; percent?: number; speedBytesPerSecond?: number; etaSeconds?: number }
  size?: number; sha256?: string; downloadedAt?: string; error?: { code: YtImportErrorCode; message: string }
}
const MAX_BYTES = 2 * 1024 ** 3
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FORMAT_ID = /^[a-zA-Z0-9_-]{1,80}$/
const MESSAGES: Record<YtImportErrorCode, string> = {
  'bot-challenge': 'YouTube 要求验证机器人, 请在现有登录流程重新验证.',
  'auth-required': '需要应用里已保存的 YouTube 登录, 请重新登录后重试.',
  'geo-restricted': '该录像在当前地区不可用.', 'video-unavailable': '该录像不可用或无法读取.',
  'live-not-supported': '仍在直播或尚未结束处理的录像暂不支持片段下载.',
  'format-unavailable': '所选画质不可用或无法无损封装, 未改用其他画质.',
  'provider-failed': 'YouTube 工具或 PO token provider 不可用, 请检查工具安装.',
  network: '下载网络失败或超时, 请检查网络和系统代理.', 'rate-limited': 'YouTube 请求受到限流, 请稍后重试.',
  'disk-full': '片段超过 2GiB 或磁盘剩余空间不足.', 'too-long': '单个片段最多 5 分钟.', cancelled: '下载已取消.',
}
export class YtImportError extends Error {
  constructor(readonly code: YtImportErrorCode) { super(MESSAGES[code]); this.name = 'YtImportError' }
}

/** Canonicalize a video identity, never a renderer-supplied request target. */
export function normalizeYtImportUrl(value: unknown): { videoId: string; url: string } {
  if (typeof value !== 'string' || value.length > 2048) throw new YtImportError('video-unavailable')
  let videoId = value
  if (!/^[\w-]{11}$/.test(value)) {
    let parsed: URL
    try { parsed = new URL(value) } catch { throw new YtImportError('video-unavailable') }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) throw new YtImportError('video-unavailable')
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(parsed.hostname) && parsed.pathname === '/watch') videoId = parsed.searchParams.get('v') ?? ''
    else if (parsed.hostname === 'youtu.be' && /^\/[\w-]{11}$/.test(parsed.pathname)) videoId = parsed.pathname.slice(1)
    else throw new YtImportError('video-unavailable')
  }
  if (!/^[\w-]{11}$/.test(videoId)) throw new YtImportError('video-unavailable')
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` }
}

/** Classify private stderr without returning a substring of it. */
export function classifyYtImportError(text: string): YtImportErrorCode {
  if (/no space left|disk full|ENOSPC|not enough space/i.test(text)) return 'disk-full'
  if (/not a bot|confirm.*bot|bot challenge/i.test(text)) return 'bot-challenge'
  if (/429|too many requests|rate.limit/i.test(text)) return 'rate-limited'
  if (/not available in your country|geo.restrict|geographic/i.test(text)) return 'geo-restricted'
  if (/sign.?in|login|required.*auth|members.only|private video|cookies.*expired/i.test(text)) return 'auth-required'
  if (/po.?token|pot.provider|bgutil|javascript|js challenge|js runtime|no module/i.test(text)) return 'provider-failed'
  if (/requested format|no.*formats|only images|unsupported codec|not supported.*container|Invalid argument/i.test(text)) return 'format-unavailable'
  if (/unavailable|removed|does not exist|copyright|404/i.test(text)) return 'video-unavailable'
  return 'network'
}
type Format = Record<string, unknown>
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
const safeText = (value: unknown, limit: number): string => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, limit) : ''

export const YT_IMPORT_METADATA_TEMPLATE = '{"metadata":%(.{id,title,duration,is_live,live_status})j,"formats":%(formats.:.{format_id,url,protocol,width,height,fps,tbr,abr,asr,vcodec,acodec,ext,filesize,filesize_approx,has_drm,quality})j}'

function selectFormats(info: unknown, videoId: string, start: number, end: number, targetHeight: YtImportHeight): { title: string; duration: number; format: YtImportFormat; estimatedBytes: number } {
  if (!info || typeof info !== 'object') throw new YtImportError('video-unavailable')
  const record = info as Record<string, unknown>
  const metadata = record.metadata as Record<string, unknown> | undefined
  if (!metadata || metadata.id !== videoId || !Array.isArray(record.formats)) throw new YtImportError('video-unavailable')
  if (metadata.is_live || !['not_live', 'was_live'].includes(String(metadata.live_status))) throw new YtImportError('live-not-supported')
  const duration = number(metadata.duration)
  if (!duration || start >= duration || end > duration + 0.05) throw new YtImportError('video-unavailable')
  const formats = record.formats.filter((item): item is Format => {
    if (!item || typeof item !== 'object') return false
    const format = item as Format
    return FORMAT_ID.test(String(format.format_id)) && !format.has_drm && typeof format.url === 'string' && !!format.url.trim()
  })
  const videos = formats.filter(format => format.vcodec && format.vcodec !== 'none' && number(format.width) && format.height === targetHeight)
  videos.sort((a, b) => number(b.width) - number(a.width)
    || number(b.fps) - number(a.fps) || number(b.quality) - number(a.quality) || number(b.tbr) - number(a.tbr))
  const video = videos[0]
  if (!video) throw new YtImportError('format-unavailable')
  const audios = formats.filter(format => format.acodec && format.acodec !== 'none' && (!format.vcodec || format.vcodec === 'none'))
  audios.sort((a, b) => number(b.abr ?? b.tbr) - number(a.abr ?? a.tbr) || number(b.asr) - number(a.asr))
  const audio = video.acodec && video.acodec !== 'none' ? undefined : audios[0]
  if ((!video.acodec || video.acodec === 'none') && !audio) throw new YtImportError('format-unavailable')
  // Rank first: unsupported delivery of the best track must not silently lower quality.
  const supportsSection = (format: Format): boolean => {
    if (!['https', 'http', 'm3u8_native', 'm3u8'].includes(String(format.protocol))) return false
    try { const url = new URL(String(format.url)); return url.protocol === 'https:' && !url.username && !url.password } catch { return false }
  }
  if (!supportsSection(video) || audio && !supportsSection(audio)) throw new YtImportError('format-unavailable')
  const videoCodec = safeText(video.vcodec, 80)
  const audioCodec = safeText(audio?.acodec ?? video.acodec, 80)
  // MP4 carries every codec YouTube serves (VP9, AV1, H.264, Opus, AAC) and is the one
  // container the bundled minimal FFmpeg can write; tracks are copied, never re-encoded.
  const container = 'mp4' as const
  const estimate = (format: Format): number => {
    const full = number(format.filesize) || number(format.filesize_approx)
    const bytesPerSecond = full ? full / duration : number(format.tbr ?? format.abr) * 1000 / 8
    if (!bytesPerSecond) throw new YtImportError('format-unavailable')
    // Reserve extra GOP lead-in and muxing overhead rather than promising an exact byte interval.
    return bytesPerSecond * Math.min(duration, end - start + 30) * 1.25
  }
  return { title: safeText(metadata.title, 300), duration,
    format: { videoFormatId: String(video.format_id), audioFormatId: audio ? String(audio.format_id) : null,
      width: number(video.width), height: number(video.height), fps: number(video.fps), videoCodec, audioCodec, container },
    estimatedBytes: Math.ceil(estimate(video) + (audio ? estimate(audio) : 0)) }
}

interface ActiveJob { job: YtImportJob; controller: AbortController; promise: Promise<void>; child?: ChildProcess }
export interface YtImportOptions {
  userDataDirectory: string; electronPath: string; networkRuntimePath: string; cookies: YoutubeCookieAccess
  settings?: ToolSettings; toolContext?: ToolContext; env?: NodeJS.ProcessEnv; network?: () => NetworkContext
  spawn?: typeof spawn; killTree?: (child: ChildProcess) => Promise<void>
  event?: (job: YtImportJob) => void; publish?: (assetId: string, file: string) => string
  freeBytes?: (directory: string) => Promise<number>; probeTimeoutMs?: number; downloadTimeoutMs?: number
}

/** Owns only import children. It never disposes or cancels the live resolver. */
export class YouTubeImportJobManager {
  private readonly jobs = new Map<string, YtImportJob>()
  private active?: ActiveJob
  private disposed = false
  private readonly terminations = new WeakMap<ChildProcess, Promise<void>>()
  readonly root: string
  constructor(private readonly options: YtImportOptions) { this.root = path.resolve(options.userDataDirectory, 'admin-media') }
  list(): YtImportJob[] { return [...this.jobs.values()].map(job => structuredClone(job)) }
  private emit(job: YtImportJob): void { try { this.options.event?.(structuredClone(job)) } catch { /* Consumers cannot break task ownership. */ } }

  start(request: YtImportRequest): YtImportJob {
    if (this.disposed) throw new YtImportError('cancelled')
    if (this.active) throw new Error('已有下载任务正在运行, 请等待完成或取消.')
    if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['url', 'startSeconds', 'endSeconds', 'targetHeight'].includes(key))
      || ![2160, 1440, 1080].includes(request.targetHeight)
      || typeof request.startSeconds !== 'number' || typeof request.endSeconds !== 'number'
      || !Number.isFinite(request.startSeconds) || !Number.isFinite(request.endSeconds)
      || request.startSeconds < 0 || request.endSeconds <= request.startSeconds || request.endSeconds > 1_000_000_000) throw new Error('选段参数无效.')
    if (request.endSeconds - request.startSeconds > 300) throw new YtImportError('too-long')
    const identity = normalizeYtImportUrl(request.url)
    const targetHeight = request.targetHeight
    const job: YtImportJob = { jobId: randomUUID(), videoId: identity.videoId, startSeconds: request.startSeconds,
      endSeconds: request.endSeconds, targetHeight, state: 'probing' }
    this.jobs.set(job.jobId, job)
    const active: ActiveJob = { job, controller: new AbortController(), promise: Promise.resolve() }
    this.active = active
    this.emit(job)
    active.promise = Promise.resolve().then(() => this.execute(active, identity.url, targetHeight)).finally(() => { if (this.active === active) this.active = undefined })
    return structuredClone(job)
  }
  async cancel(jobId: string): Promise<YtImportJob | undefined> {
    if (this.active?.job.jobId === jobId) {
      const active = this.active
      active.controller.abort()
      if (active.child) await this.terminate(active.child)
      await active.promise
    }
    const job = this.jobs.get(jobId)
    return job ? structuredClone(job) : undefined
  }
  async cancelAll(): Promise<void> { if (this.active) await this.cancel(this.active.job.jobId) }
  async dispose(): Promise<void> { this.disposed = true; await this.cancelAll() }
  private current(active: ActiveJob): void { if (this.disposed || active.controller.signal.aborted) throw new YtImportError('cancelled') }

  private async prepareRoot(): Promise<void> {
    await fs.promises.mkdir(this.root, { recursive: true })
    if ((await fs.promises.lstat(this.root)).isSymbolicLink() || path.relative(this.root, await fs.promises.realpath(this.root)) !== '') throw new YtImportError('disk-full')
  }

  private async execute(active: ActiveJob, url: string, targetHeight: YtImportHeight): Promise<void> {
    const job = active.job
    let plugin: PrivatePotPlugin | undefined
    try {
      this.current(active)
      await this.prepareRoot()
      const directory = path.join(this.root, job.jobId)
      await fs.promises.mkdir(directory, { mode: 0o700 })
      this.current(active)
      const [executable, ffmpeg, ffprobe, provider, route] = await Promise.all([
        locateTool('yt-dlp', this.options.settings, this.options.env, this.options.toolContext),
        locateTool('ffmpeg', this.options.settings, this.options.env, this.options.toolContext),
        locateTool('ffprobe', this.options.settings, this.options.env, this.options.toolContext),
        locateYouTubePotProvider(this.options.env, this.options.toolContext),
        (this.options.network?.() ?? networkContext('youtube')).route(url),
      ])
      if (!provider) throw new YtImportError('provider-failed')
      try { plugin = await prepareScriptOnlyPotPlugin(provider.pluginDir) } catch { throw new YtImportError('provider-failed') }
      const proxy = route.proxyUrl ?? ''
      const completed = await this.options.cookies.withTemporaryCookies('youtube', async cookieFile => {
        this.current(active)
        if (!cookieFile) throw new YtImportError('auth-required')
        const base = ['--proxy', proxy, '--ignore-config', '--no-cache-dir', '--no-playlist', '--socket-timeout', '30', '--retries', '1', '--extractor-retries', '1',
          '--no-plugin-dirs', '--plugin-dirs', plugin!.pluginDir, '--extractor-args', `youtubepot-bgutilscript:server_home=${provider.serverHome}`,
          '--no-js-runtimes', '--js-runtimes', `node:${this.options.electronPath}`, '--no-remote-components', '--cookies', cookieFile,
          '--ffmpeg-location', ffmpeg]
        const probe = await this.runChild(active, executable, [...base, '--no-progress', '--skip-download', '--print', YT_IMPORT_METADATA_TEMPLATE, '--', url], proxy, directory, 'probe')
        this.current(active)
        let parsed: unknown
        try { parsed = JSON.parse(probe) } catch { throw new YtImportError('video-unavailable') }
        const selected = selectFormats(parsed, job.videoId, job.startSeconds, job.endSeconds, targetHeight)
        const free = await (this.options.freeBytes?.(directory) ?? fs.promises.statfs(directory).then(stat => stat.bavail * stat.bsize))
        if (selected.estimatedBytes > MAX_BYTES || !Number.isFinite(free) || free < selected.estimatedBytes * 2 + 64 * 1024 ** 2) throw new YtImportError('disk-full')
        Object.assign(job, { title: selected.title, duration: selected.duration, format: selected.format, state: 'downloading', progress: { downloadedBytes: 0, totalBytes: selected.estimatedBytes } })
        this.emit(job)
        const ids = selected.format.videoFormatId + (selected.format.audioFormatId ? `+${selected.format.audioFormatId}` : '')
        await this.runChild(active, executable, [...base, '--format', ids, '--download-sections', `*${job.startSeconds}-${job.endSeconds}`,
          '--no-force-keyframes-at-cuts', '--downloader-args', 'ffmpeg_o:-c:v copy -c:a copy', '--merge-output-format', selected.format.container,
          '--remux-video', selected.format.container, '--no-write-info-json', '--no-write-thumbnail', '--no-write-subs', '--no-write-auto-subs',
          '--no-embed-metadata', '--no-embed-thumbnail', '--newline', '--progress', '--progress-delta', '1', '--output-na-placeholder', 'null',
          '--progress-template', 'download:FY1_PROGRESS:[%(progress.downloaded_bytes)j,%(progress.total_bytes)j,%(progress.speed)j,%(progress.eta)j]',
          '--output', path.join(directory, 'media.%(ext)s'), '--', url], proxy, directory, 'download')
        this.current(active)
        const file = path.join(directory, `media.${selected.format.container}`)
        const stat = await fs.promises.lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > MAX_BYTES) throw new YtImportError(stat.size > MAX_BYTES ? 'disk-full' : 'format-unavailable')
        const measured = await this.runChild(active, ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate', '-of', 'json', file], '', directory, 'verify')
        this.current(active)
        let streams: Array<Record<string, unknown>>
        try { streams = (JSON.parse(measured) as { streams: Array<Record<string, unknown>> }).streams } catch { throw new YtImportError('format-unavailable') }
        if (!Array.isArray(streams)) throw new YtImportError('format-unavailable')
        const video = streams.find(stream => stream.codec_type === 'video')
        const audio = streams.find(stream => stream.codec_type === 'audio')
        if (!video || !audio || video.width !== selected.format.width || video.height !== selected.format.height
          || !codecMatches(selected.format.videoCodec, String(video.codec_name)) || !codecMatches(selected.format.audioCodec, String(audio.codec_name))) throw new YtImportError('format-unavailable')
        const sha256 = await hashFile(file, active.controller.signal)
        this.current(active)
        const metadata: YtImportMetadata = { videoId: job.videoId, title: selected.title, startSeconds: job.startSeconds,
          endSeconds: job.endSeconds, format: selected.format, size: stat.size, sha256, downloadedAt: new Date().toISOString() }
        return { file, metadata }
      })
      // Commit after cookie-snapshot cleanup. No await can interleave a cancellation with publication.
      this.current(active)
      const sidecar = path.join(directory, 'metadata.json')
      fs.writeFileSync(sidecar, JSON.stringify(completed.metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      let mediaUrl: string
      try { mediaUrl = this.options.publish?.(job.jobId, completed.file) ?? `app://app/admin-media/${job.jobId}` }
      catch { fs.writeFileSync(sidecar, 'null\n'); throw new YtImportError('format-unavailable') }
      Object.assign(job, { state: 'ready', assetId: job.jobId, mediaUrl, size: completed.metadata.size, sha256: completed.metadata.sha256,
        downloadedAt: completed.metadata.downloadedAt, progress: { downloadedBytes: completed.metadata.size, totalBytes: completed.metadata.size, percent: 100 } })
      this.emit(job)
    } catch (error) {
      const code: YtImportErrorCode = active.controller.signal.aborted || this.disposed ? 'cancelled'
        : error instanceof YtImportError ? error.code : (error as NodeJS.ErrnoException)?.code === 'ENOSPC' ? 'disk-full'
          : error && typeof error === 'object' && 'tool' in error ? 'provider-failed'
            : error && typeof error === 'object' && 'code' in error && ['login-cancelled', 'cookie-storage-failed'].includes(String(error.code)) ? 'auth-required' : 'network'
      job.state = code === 'cancelled' ? 'cancelled' : 'failed'
      job.error = { code, message: code === 'format-unavailable' ? `${targetHeight}p 画质不可用或无法无损封装, 未改用其他画质.` : MESSAGES[code] }
      this.emit(job)
    } finally { await plugin?.dispose().catch(() => {}) }
  }

  private terminate(child: ChildProcess): Promise<void> {
    let pending = this.terminations.get(child)
    if (!pending) { pending = (this.options.killTree ?? killProcessTree)(child); this.terminations.set(child, pending); void pending.catch(() => {}) }
    return pending
  }

  private runChild(active: ActiveJob, executable: string, args: string[], proxy: string, directory: string, stage: 'probe' | 'download' | 'verify'): Promise<string> {
    this.current(active)
    const env: NodeJS.ProcessEnv = { ...cleanProxyEnvironment(this.options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8',
      ...(this.options.toolContext?.providerCacheHome ? { XDG_CACHE_HOME: this.options.toolContext.providerCacheHome } : {}) }
    if (proxy) { env.HTTP_PROXY = proxy; env.HTTPS_PROXY = proxy; env.ALL_PROXY = proxy }
    if (!path.isAbsolute(this.options.networkRuntimePath) || /["\r\n\0]/.test(this.options.networkRuntimePath)) throw new YtImportError('provider-failed')
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require="${this.options.networkRuntimePath.replace(/\\/g, '/')}"`.trim()
    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', stopped: YtImportErrorCode | undefined, settled = false, checking = false
      let bytes = 0
      const child = (this.options.spawn ?? spawn)(executable, args, { cwd: directory, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      active.child = child
      const stop = (code: YtImportErrorCode) => { if (!stopped && !settled) { stopped = code; void this.terminate(child).catch(() => {}) } }
      const abort = () => stop('cancelled')
      active.controller.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => stop('network'), stage === 'download' ? this.options.downloadTimeoutMs ?? 30 * 60_000 : this.options.probeTimeoutMs ?? 120_000)
      const poll = stage === 'download' ? setInterval(() => {
        if (checking || stopped) return
        checking = true
        void fs.promises.readdir(directory).then(async names => {
          const sizes = await Promise.all(names.filter(name => name.startsWith('media.')).map(name => fs.promises.lstat(path.join(directory, name)).then(stat => stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0)))
          const total = sizes.reduce((sum, size) => sum + size, 0)
          if (total > MAX_BYTES) { stop('disk-full'); return }
          if (!stopped && active.job.state === 'downloading' && total > (active.job.progress?.downloadedBytes ?? 0)) {
            active.job.progress = { ...active.job.progress, downloadedBytes: total }
            this.emit(active.job)
          }
        }).catch(() => stop('disk-full')).finally(() => { checking = false })
      }, 1000) : undefined
      const finish = (error?: YtImportError) => {
        if (settled) return
        settled = true; clearTimeout(timer); clearInterval(poll); active.controller.signal.removeEventListener('abort', abort)
        if (active.child === child) active.child = undefined
        if (error) reject(error); else resolve(stdout)
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stopped) return
        bytes += chunk.length
        if (bytes > (stage === 'download' ? 4 : 16) * 1024 ** 2) { stop('format-unavailable'); return }
        stdout += chunk.toString('utf8')
        if (stage === 'download') {
          let newline: number
          while ((newline = stdout.indexOf('\n')) >= 0) {
            const line = stdout.slice(0, newline).trim(); stdout = stdout.slice(newline + 1)
            if (!line.startsWith('FY1_PROGRESS:')) continue
            try {
              const values: unknown = JSON.parse(line.slice(13))
              if (!Array.isArray(values)) continue
              const downloadedBytes = number(values[0]), totalBytes = number(values[1]), speed = number(values[2]), eta = number(values[3])
              if (downloadedBytes > MAX_BYTES) { stop('disk-full'); return }
              active.job.progress = { downloadedBytes, ...(totalBytes ? { totalBytes, percent: Math.min(99.9, downloadedBytes / totalBytes * 100) } : {}),
                ...(speed ? { speedBytesPerSecond: speed } : {}), ...(eta ? { etaSeconds: eta } : {}) }
              this.emit(active.job)
            } catch { /* Ignore non-protocol output, never forward it. */ }
          }
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-32768) })
      child.once('error', () => finish(new YtImportError('provider-failed')))
      child.once('close', code => finish(stopped ? new YtImportError(stopped) : code !== 0 ? new YtImportError(classifyYtImportError(stderr)) : undefined))
      if (active.controller.signal.aborted) abort()
    })
  }

  /** Restore only completed, bounded, local assets; staging files are never registered. */
  async initialize(): Promise<void> {
    await this.prepareRoot()
    for (const entry of await fs.promises.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue
      try {
        const directory = path.join(this.root, entry.name)
        const sidecar = path.join(directory, 'metadata.json')
        const info = await fs.promises.lstat(sidecar)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) continue
        const metadata = JSON.parse(await fs.promises.readFile(sidecar, 'utf8')) as YtImportMetadata
        if (!validMetadata(metadata)) continue
        const file = path.join(directory, `media.${metadata.format.container}`)
        const stat = await fs.promises.lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== metadata.size) continue
        const sha256 = await hashFile(file)
        if (sha256 !== metadata.sha256) continue
        const mediaUrl = this.options.publish?.(entry.name, file) ?? `app://app/admin-media/${entry.name}`
        this.jobs.set(entry.name, { jobId: entry.name, videoId: metadata.videoId, title: metadata.title,
          startSeconds: metadata.startSeconds, endSeconds: metadata.endSeconds, format: metadata.format,
          sha256: metadata.sha256, size: metadata.size, downloadedAt: metadata.downloadedAt, state: 'ready', assetId: entry.name, mediaUrl,
          progress: { downloadedBytes: metadata.size, totalBytes: metadata.size, percent: 100 } })
      } catch { /* Incomplete or changed files are not capabilities. */ }
    }
  }
}

function codecMatches(expected: string, actual: string): boolean {
  return /^(vp9|vp0?9)/.test(expected) ? actual === 'vp9' : /^(av01|av1)/.test(expected) ? actual === 'av1'
    : /^(avc1|h264)/.test(expected) ? actual === 'h264' : /^(mp4a|aac)/.test(expected) ? actual === 'aac' : expected.split('.')[0] === actual
}
async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk)
  return hash.digest('hex')
}
function validMetadata(value: YtImportMetadata): boolean {
  const format = value?.format
  return !!value && Object.keys(value).every(key => ['videoId', 'title', 'startSeconds', 'endSeconds', 'format', 'sha256', 'size', 'downloadedAt'].includes(key))
    && /^[\w-]{11}$/.test(value.videoId) && typeof value.title === 'string' && value.title.length <= 300
    && Number.isFinite(value.startSeconds) && value.startSeconds >= 0 && Number.isFinite(value.endSeconds)
    && value.endSeconds > value.startSeconds && value.endSeconds - value.startSeconds <= 300
    && /^[0-9a-f]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_BYTES
    && typeof value.downloadedAt === 'string' && Number.isFinite(Date.parse(value.downloadedAt))
    && !!format && Object.keys(format).every(key => ['videoFormatId', 'audioFormatId', 'width', 'height', 'fps', 'videoCodec', 'audioCodec', 'container'].includes(key))
    && typeof format.videoFormatId === 'string' && FORMAT_ID.test(format.videoFormatId)
    && (format.audioFormatId === null || typeof format.audioFormatId === 'string' && FORMAT_ID.test(format.audioFormatId))
    && format.container === 'mp4' && Number.isSafeInteger(format.width) && format.width > 0
    && Number.isSafeInteger(format.height) && format.height > 0 && Number.isFinite(format.fps) && format.fps >= 0
    && typeof format.videoCodec === 'string' && format.videoCodec.length <= 80 && typeof format.audioCodec === 'string' && format.audioCodec.length <= 80
}
