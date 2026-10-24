/**
 * Attaches a MediaDescriptor to a <video> element.
 *
 * hls.js is imported dynamically: it is the biggest dependency in the bundle and a
 * session that only plays local files or progressive MP4s never needs it. For HLS it is
 * preferred over the browser's own player wherever it can run, because level selection and
 * back-buffer control are both features this tool ships; native playback is the fallback for
 * browsers without Media Source Extensions. See `attachMedia` for why that order matters.
 */

import type { MediaDescriptor } from '../core/types'
import { describeLevels, type QualityOption, type RawLevel } from './quality'

export type AttachMode = 'native' | 'hlsjs'

export interface MediaError {
  fatal: boolean
  message: string
  /** What the user can do about it. */
  hint?: string
}

export interface AttachHandlers {
  onQualityOptions?: (options: QualityOption[]) => void
  onLevelSwitch?: (level: number, autoLevel: number) => void
  onError?: (error: MediaError) => void
  onLiveHint?: (isLive: boolean) => void
  /** Fired only after this attachment resumes usable media after a recovery. */
  onRecovered?: () => void
}

export interface MediaAttachment {
  mode: AttachMode
  /** -1 selects automatic level switching. */
  setLevel(level: number): void
  /** Jump to the live edge; no-op for VOD and native playback. */
  seekToLive(): void
  destroy(): void
}

type HlsModule = typeof import('hls.js')

let hlsModulePromise: Promise<HlsModule> | null = null
const MAX_HLS_RECOVERIES = 3
const STABLE_PLAYBACK_MS = 30_000

interface AttachmentOwner {
  current(): boolean
  destroy(): void
  cancelled: Promise<null>
  cleanups: Array<() => void>
}
const owners = new WeakMap<HTMLVideoElement, AttachmentOwner>()

/** Supersession releases the previous attachment before the next one touches video. */
function ownMedia(video: HTMLVideoElement, signal?: AbortSignal): AttachmentOwner {
  let destroyed = false
  let cancel = () => {}
  const cancelled = new Promise<null>(resolve => { cancel = () => resolve(null) })
  const owner: AttachmentOwner = {
    cleanups: [],
    cancelled,
    current: () => !destroyed && owners.get(video) === owner,
    destroy: () => {
      if (destroyed) return
      destroyed = true
      cancel()
      signal?.removeEventListener('abort', owner.destroy)
      for (const cleanup of owner.cleanups.splice(0).reverse()) cleanup()
      if (owners.get(video) === owner) owners.delete(video)
    },
  }
  if (signal?.aborted) { owner.destroy(); return owner }
  owners.get(video)?.destroy()
  owners.set(video, owner)
  signal?.addEventListener('abort', owner.destroy, { once: true })
  return owner
}

function emptyAttachment(): MediaAttachment {
  return { mode: 'native', setLevel() {}, seekToLive() {}, destroy() {} }
}

function loadHls(): Promise<HlsModule> {
  hlsModulePromise ??= import('hls.js')
  return hlsModulePromise
}

/** Overridable for tests, which must not load the real hls.js in jsdom. */
export const hlsLoader = { load: loadHls }

export function canPlayNativeHls(video: HTMLMediaElement): boolean {
  return (
    video.canPlayType('application/vnd.apple.mpegurl') !== '' ||
    video.canPlayType('application/x-mpegURL') !== ''
  )
}

export async function attachMedia(
  video: HTMLVideoElement,
  descriptor: MediaDescriptor,
  handlers: AttachHandlers = {},
  signal?: AbortSignal,
): Promise<MediaAttachment> {
  const owner = ownMedia(video, signal)
  if (!owner.current()) return emptyAttachment()
  video.loop = descriptor.loop

  if (descriptor.kind !== 'hls') {
    const attachment = nativeAttachment(video, descriptor.url, owner, handlers)
    handlers.onLiveHint?.(false)
    return attachment
  }

  /**
   * Native HLS, used only when hls.js cannot run.
   *
   * Chromium answers `canPlayType('application/x-mpegURL')` with "maybe" and does play the
   * playlist, so probing capability first would take this path on the primary target browser
   * — and it costs two things the tool is built around. Levels are never enumerated, so the
   * 画质 dropdown that V0.1 lists as a deliverable stays permanently disabled; and there is
   * no say over eviction, while sync rewinds up to 60 s and needs `backBufferLength` to have
   * kept the data. So hls.js wins wherever MSE exists, and this covers the rest: iOS Safari,
   * where hls.js has no MSE to attach to and the platform's own player is the only option.
   */
  const attachNative = (): MediaAttachment => {
    if (!owner.current()) return emptyAttachment()
    return nativeAttachment(video, descriptor.url, owner, handlers)
  }

  let module: HlsModule
  try {
    const loaded = await Promise.race([hlsLoader.load(), owner.cancelled])
    if (!loaded) return emptyAttachment()
    module = loaded
  } catch (error) {
    if (!owner.current()) return emptyAttachment()
    // A chunk that failed to load is a broken deploy or a dropped network, not an
    // unsupported browser. Native playback may still work, so try it before giving up.
    if (canPlayNativeHls(video)) return attachNative()
    handlers.onError?.({
      fatal: true,
      message: `无法加载 HLS 播放器：${error instanceof Error ? error.message : String(error)}`,
    })
    return { ...emptyAttachment(), destroy: owner.destroy }
  }

  if (!owner.current()) return emptyAttachment()
  const Hls = module.default
  if (!Hls.isSupported()) {
    if (canPlayNativeHls(video)) return attachNative()
    handlers.onError?.({
      fatal: true,
      message: '当前浏览器不支持 HLS 播放',
      hint: '请使用 Chrome、Edge 或 Firefox 的最新版本。',
    })
    return { ...emptyAttachment(), destroy: owner.destroy }
  }

  const hls = new Hls({
    // Low latency is not the goal: a stable, seekable buffer is, because sync
    // rewinds up to 60 s and needs the data to still be there.
    lowLatencyMode: false,
    backBufferLength: descriptor.url.includes('/buffer/') ? 180 : 90,
    // A deliberately rewound local live buffer must never catch up automatically.
    // hls.js only accepts liveMaxLatencyDurationCount together with an explicit
    // liveSyncDurationCount below it (it throws on construction otherwise), so the
    // default of 3 is spelled out.
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: Infinity,
    maxLiveSyncPlaybackRate: 1,
    maxBufferLength: 30,
    enableWorker: true,
  })
  owner.cleanups.push(() => hls.destroy())
  let recovering = false
  let recoveries = 0
  let stableSince: number | null = null
  let lastProgressTime = Number.NaN
  const onReady = () => {
    if (!owner.current() || video.error || video.readyState < video.HAVE_FUTURE_DATA) return
    if (recovering) { recovering = false; handlers.onRecovered?.() }
  }
  const resetStability = () => { stableSince = null; lastProgressTime = Number.NaN }
  const onProgress = () => {
    if (!owner.current() || recovering || video.error || video.paused || video.seeking
      || video.readyState < video.HAVE_FUTURE_DATA) { resetStability(); return }
    if (!Number.isFinite(video.currentTime) || video.currentTime <= lastProgressTime) stableSince = null
    lastProgressTime = video.currentTime
    stableSince ??= performance.now()
    if (performance.now() - stableSince >= STABLE_PLAYBACK_MS) recoveries = 0
  }
  for (const event of ['canplay', 'playing']) video.addEventListener(event, onReady)
  video.addEventListener('timeupdate', onProgress)
  for (const event of ['waiting', 'stalled', 'pause', 'seeking']) video.addEventListener(event, resetStability)
  owner.cleanups.push(() => {
    for (const event of ['canplay', 'playing']) video.removeEventListener(event, onReady)
    video.removeEventListener('timeupdate', onProgress)
    for (const event of ['waiting', 'stalled', 'pause', 'seeking']) video.removeEventListener(event, resetStability)
  })

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    if (!owner.current()) return
    handlers.onQualityOptions?.(describeLevels(hls.levels as unknown as RawLevel[]))
  })
  hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
    if (!owner.current()) return
    handlers.onLiveHint?.(Boolean(data.details.live))
  })
  hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
    if (!owner.current()) return
    handlers.onLevelSwitch?.(hls.autoLevelEnabled ? -1 : data.level, data.level)
  })
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!owner.current()) return
    const error = translateHlsError(Hls, data)
    if (!data.fatal) { handlers.onError?.(error); return }
    resetStability()
    const recoverable = data.type === Hls.ErrorTypes.NETWORK_ERROR || data.type === Hls.ErrorTypes.MEDIA_ERROR
    if (!recoverable || recoveries >= MAX_HLS_RECOVERIES) {
      handlers.onError?.({ ...error, hint: '自动恢复未成功, 请重新加载片源.' })
      owner.destroy()
      return
    }
    recoveries++
    recovering = true
    handlers.onError?.(error)
    if (!owner.current()) return
    // Documented recovery ladder: network errors retry the load, media errors
    // recover the buffer, anything else is unrecoverable.
    try {
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
      else hls.recoverMediaError()
    } catch {
      if (owner.current()) handlers.onError?.({ ...error, hint: '自动恢复未成功, 请重新加载片源.' })
      owner.destroy()
    }
  })

  try {
    hls.loadSource(descriptor.url)
    if (owner.current()) hls.attachMedia(video)
  } catch (error) { owner.destroy(); throw error }

  return {
    mode: 'hlsjs',
    setLevel(level: number) {
      if (!owner.current()) return
      hls.currentLevel = level
      if (level < 0) hls.nextLevel = -1
    },
    seekToLive() {
      if (!owner.current()) return
      if (hls.liveSyncPosition !== null && Number.isFinite(hls.liveSyncPosition)) {
        video.currentTime = hls.liveSyncPosition
      } else if (video.seekable.length > 0) {
        video.currentTime = video.seekable.end(video.seekable.length - 1)
      }
    },
    destroy: owner.destroy,
  }
}

function nativeAttachment(video: HTMLVideoElement, url: string, owner: AttachmentOwner, handlers: AttachHandlers): MediaAttachment {
  const expected = new URL(url, video.ownerDocument.baseURI).href
  const onError = () => {
    // load() clears MediaError. A queued error for the previous resource must not
    // become an error for the new generation sharing this same element.
    if (!owner.current() || !video.error || video.src !== expected || (video.currentSrc && video.currentSrc !== expected)) return
    const error = translateNativeError(video.error.code)
    if (error) handlers.onError?.(error)
  }
  video.addEventListener('error', onError)
  owner.cleanups.push(() => {
    video.removeEventListener('error', onError)
    video.removeAttribute('src')
    video.load()
  })
  video.src = url
  video.load()
  return {
    mode: 'native',
    setLevel() {
      // Native playback picks its own variant; nothing to switch.
    },
    seekToLive() {
      if (!owner.current()) return
      if (video.seekable.length > 0) {
        video.currentTime = video.seekable.end(video.seekable.length - 1)
      }
    },
    destroy: owner.destroy,
  }
}

function translateNativeError(code: number): MediaError | null {
  if (code === 1) return null // User/source cancellation is handled by the owner.
  if (code === 2) return { fatal: true, message: '媒体读取失败.', hint: '检查网络或文件是否仍可访问, 然后重新加载片源.' }
  if (code === 3) return { fatal: true, message: '媒体解码失败.', hint: '检查文件是否损坏, 或选择受支持的视频编码.' }
  if (code === 4) return { fatal: true, message: '不支持该媒体格式或编码.', hint: '检查文件或地址, 并选择受支持的媒体格式.' }
  return { fatal: true, message: '媒体播放失败.', hint: '请重新加载片源.' }
}

interface HlsErrorData {
  fatal: boolean
  type: string
  details: string
  response?: { code?: number }
}

export function translateHlsError(
  Hls: HlsModule['default'],
  data: HlsErrorData,
): MediaError {
  const status = data.response?.code
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    if (status === 403 || status === 401) {
      return {
        fatal: data.fatal,
        message: `拉流被拒绝 (HTTP ${status})`,
        hint: '播放地址通常带有有效期，请重新解析或改用本地代理。',
      }
    }
    if (data.details === 'manifestLoadError' || data.details === 'manifestParsingError') {
      return {
        fatal: data.fatal,
        message: '无法加载播放列表',
        hint: '检查地址是否有效，跨域来源需要通过本地代理。',
      }
    }
    return {
      fatal: data.fatal,
      message: `网络错误：${data.details}${status ? ` (HTTP ${status})` : ''}`,
      hint: data.fatal ? '正在重试加载。' : undefined,
    }
  }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    return {
      fatal: data.fatal,
      message: `解码错误：${data.details}`,
      hint: data.fatal ? '正在尝试恢复缓冲。' : undefined,
    }
  }
  return { fatal: data.fatal, message: `播放器错误：${data.details}` }
}
