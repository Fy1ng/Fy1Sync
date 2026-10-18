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
): Promise<MediaAttachment> {
  video.loop = descriptor.loop

  if (descriptor.kind !== 'hls') {
    video.src = descriptor.url
    video.load()
    handlers.onLiveHint?.(false)
    return nativeAttachment(video)
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
    video.src = descriptor.url
    video.load()
    return nativeAttachment(video)
  }

  let module: HlsModule
  try {
    module = await hlsLoader.load()
  } catch (error) {
    // A chunk that failed to load is a broken deploy or a dropped network, not an
    // unsupported browser. Native playback may still work, so try it before giving up.
    if (canPlayNativeHls(video)) return attachNative()
    handlers.onError?.({
      fatal: true,
      message: `无法加载 HLS 播放器：${error instanceof Error ? error.message : String(error)}`,
    })
    return nativeAttachment(video)
  }

  const Hls = module.default
  if (!Hls.isSupported()) {
    if (canPlayNativeHls(video)) return attachNative()
    handlers.onError?.({
      fatal: true,
      message: '当前浏览器不支持 HLS 播放',
      hint: '请使用 Chrome、Edge 或 Firefox 的最新版本。',
    })
    return nativeAttachment(video)
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

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    handlers.onQualityOptions?.(describeLevels(hls.levels as unknown as RawLevel[]))
  })
  hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
    handlers.onLiveHint?.(Boolean(data.details.live))
  })
  hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
    handlers.onLevelSwitch?.(hls.autoLevelEnabled ? -1 : data.level, data.level)
  })
  hls.on(Hls.Events.ERROR, (_event, data) => {
    handlers.onError?.(translateHlsError(Hls, data))
    if (!data.fatal) return
    // Documented recovery ladder: network errors retry the load, media errors
    // recover the buffer, anything else is unrecoverable.
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
    else hls.destroy()
  })

  hls.loadSource(descriptor.url)
  hls.attachMedia(video)

  return {
    mode: 'hlsjs',
    setLevel(level: number) {
      hls.currentLevel = level
      if (level < 0) hls.nextLevel = -1
    },
    seekToLive() {
      if (hls.liveSyncPosition !== null && Number.isFinite(hls.liveSyncPosition)) {
        video.currentTime = hls.liveSyncPosition
      } else if (video.seekable.length > 0) {
        video.currentTime = video.seekable.end(video.seekable.length - 1)
      }
    },
    destroy() {
      hls.destroy()
    },
  }
}

function nativeAttachment(video: HTMLVideoElement): MediaAttachment {
  return {
    mode: 'native',
    setLevel() {
      // Native playback picks its own variant; nothing to switch.
    },
    seekToLive() {
      if (video.seekable.length > 0) {
        video.currentTime = video.seekable.end(video.seekable.length - 1)
      }
    },
    destroy() {
      video.removeAttribute('src')
      video.load()
    },
  }
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
