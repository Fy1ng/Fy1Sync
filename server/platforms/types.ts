/** Shared shapes for platform stream resolution. */

export type PlatformKind = 'youtube' | 'twitch' | 'douyu' | 'bilibili' | 'direct'

export type QualityOption = {
  id: string
  label: string
  height?: number
  fps?: number
  adaptive?: boolean
}

export type ResolvedStream = {
  platform: PlatformKind
  /** Playlist or progressive URL, already proxied when the platform needs it. */
  url: string
  kind: 'hls' | 'progressive'
  label: string
  /** Channel/room identifier that was resolved. */
  channel: string
  /** True when the URL must be loaded through this server's media proxy. */
  requiresProxy: boolean
  /** Extra info worth showing in the source dialog. */
  notes?: string[]
  /** Room id for platforms whose danmaku relay needs it. */
  danmakuRoom?: string
  qualities?: QualityOption[]
  /** The rendition actually returned, which may differ from the requested quality. */
  quality?: string
  /** Main-process-only input headers. Strip these before crossing IPC. */
  headers?: Record<string, string>
  /** Main-process-only signed inputs. Strip these before crossing IPC. */
  adaptive?: { videoUrl: string; audioUrl: string; videoContainer: 'webm' | 'mp4'; height: number }
}

export type ResolveFailureCode =
  | 'unsupported-url'
  | 'not-live'
  | 'room-not-found'
  | 'upstream-error'
  | 'restricted'
  | 'needs-manual-url'

export type ResolveFailure = {
  code: ResolveFailureCode
  message: string
  /** Actionable next step, shown verbatim in the UI. */
  hint?: string
}

export type ResolveResult =
  | { ok: true; stream: ResolvedStream }
  | { ok: false; failure: ResolveFailure }

export type ResolverDeps = {
  fetchJson: (url: string, init?: RequestInit) => Promise<unknown>
  fetchText: (url: string, init?: RequestInit) => Promise<string>
  /** Wraps a URL so the browser loads it from our origin. */
  proxify: (url: string) => string
  /** Main owns process launching, JS runtime setup and temporary cookie copies. */
  runYtDlp?: (url: string) => Promise<unknown>
  /** Main-process-only cookie header read from the private Douyu cookie store. */
  douyuCookie?: string
  quality?: string
  preferAdaptive?: boolean
  now?: () => number
}

export function failure(
  code: ResolveFailureCode,
  message: string,
  hint?: string,
): ResolveResult {
  return { ok: false, failure: { code, message, hint } }
}

export const MANUAL_URL_HINT =
  '可在源设置中直接粘贴 m3u8 / mp4 地址（例如从播放器开发者工具的网络面板复制）。'
