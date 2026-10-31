/**
 * Footage from a YouTube recording, for the countdown style editor.
 *
 * Two jobs, kept apart. Browsing plays the recording in a signed-in YouTube player that
 * main lays over this panel, and takes a still of the decoded frame at its real size: that
 * still is a training sample like any screenshot. Downloading saves a marked stretch (at
 * most three hours) as local footage, for the frame-by-frame work a page cannot give.
 *
 * The page itself never reaches this renderer. Main owns it and its cookies; this side
 * only tells main where the player goes and receives a state and stills.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { YtImportHeight } from '../../../electron/ytImport'
import type { GrabbedFrame } from '../../recognition/frameGrabber'
import { Switch } from '../kit'

/** Longest stretch one download may cover. */
export const MAX_CLIP_SECONDS = 3 * 60 * 60

export interface YouTubeBrowseState {
  videoId: string
  title: string
  duration: number
  currentTime: number
  playing: boolean
  /** What the page is actually decoding; the quality menu's label is not proof. */
  videoWidth: number
  videoHeight: number
  advert: boolean
  /** The player alone fills its view; until then main keeps the view hidden. */
  playerOnly: boolean
  error: YouTubeError | null
}

export type YouTubeError =
  | 'bot-challenge' | 'auth-required' | 'geo-restricted' | 'video-unavailable' | 'live-not-supported'
  | 'format-unavailable' | 'provider-failed' | 'network' | 'rate-limited' | 'disk-full' | 'too-long'
  | 'invalid-url' | 'cancelled' | 'failed'
  | 'busy' | 'not-ready' | 'ad-playing' | 'snapshot-unavailable' | 'snapshot-too-large' | 'closed'
  | 'origin-tainted' | 'player-only-failed'

export interface YouTubeStill {
  frame: GrabbedFrame
  /** The still is the video's own pixels, one to one; false when the page scaled it. */
  native: boolean
  videoId: string
  /** Seconds into the recording, approximate: a page capture has no frame timestamp. */
  approxTime: number
}

export interface YouTubeClipJob {
  assetId?: string
  jobId: string
  videoId: string
  title: string
  startSeconds: number
  endSeconds: number
  state: 'probing' | 'downloading' | 'ready' | 'failed' | 'cancelled'
  /** 0..1 while downloading, null while the size is unknown. */
  progress: number | null
  width?: number
  height?: number
  targetHeight?: YtImportHeight
  error?: YouTubeError
  /** Set once ready: a URL this page can play and seek. */
  mediaUrl?: string
}

/** Where the player goes, in this page's CSS pixels. */
export interface YouTubeViewport {
  x: number
  y: number
  width: number
  height: number
}

/** What the editor needs from main. Kept narrow so the wiring lives in one place. */
export interface YouTubeSource {
  open(url: string): Promise<{ ok: true } | { ok: false; error: YouTubeError }>
  close(): Promise<void>
  /** Place the player over `rect`, or hide it. */
  place(rect: YouTubeViewport, visible: boolean): Promise<void>
  /** The state, pushed about once a second and on every change. */
  subscribe(listener: (state: YouTubeBrowseState | null) => void): () => void
  /** The state right now, for marks that should not lag the pushed one. */
  now(): Promise<YouTubeBrowseState | null>
  still(): Promise<{ ok: true; still: YouTubeStill } | { ok: false; error: YouTubeError }>
  startClip(url: string, startSeconds: number, endSeconds: number, targetHeight: YtImportHeight): Promise<{ ok: true; jobId: string } | { ok: false; error: YouTubeError }>
  cancelClip(jobId: string): Promise<void>
  subscribeClips(listener: (jobs: YouTubeClipJob[]) => void): () => void
}

/** Plain words for each failure, in the editor's voice: what happened and what to do. */
export const YOUTUBE_ERROR_TEXT: Record<YouTubeError, string> = {
  'bot-challenge': 'YouTube 要求验证，请在 设置 › YouTube 重新登录后再试',
  'auth-required': '需要登录 YouTube，请在 设置 › YouTube 登录',
  'geo-restricted': '这段录像在当前地区不可看',
  'video-unavailable': '录像不存在、已设为私享或已删除',
  'live-not-supported': '还在直播的录像暂不支持按时间段下载，请等直播结束',
  'format-unavailable': '这段录像没有所选画质',
  'provider-failed': '取流验证失败，请稍后再试',
  network: '连不上 YouTube，请检查网络或代理',
  'rate-limited': 'YouTube 暂时限制了请求，请过几分钟再试',
  'disk-full': '磁盘空间不足',
  'too-long': '一次最多下载 3 小时',
  'invalid-url': '不是 YouTube 录像链接',
  cancelled: '已取消',
  failed: '操作没有完成，请重试',
  busy: '已有一段在下载，等它完成或取消后再试',
  'not-ready': '录像还没载入，稍等再试',
  'ad-playing': '正在播广告，结束后再截图',
  'snapshot-unavailable': '画面还没停稳或被遮住，请重试',
  'snapshot-too-large': '画面尺寸超出 8K，无法截取',
  closed: '录像窗口已关闭，请重新打开',
  'origin-tainted': '读不到视频画面，YouTube 可能换了播放方式',
  'player-only-failed': '无法只显示播放器，请重新打开录像',
}

function clipError(error: YouTubeError, targetHeight?: YtImportHeight): string {
  return error === 'format-unavailable' && targetHeight
    ? `这段录像没有 ${targetHeight}p，请换一档画质`
    : YOUTUBE_ERROR_TEXT[error]
}

/** The id from a watch, share or live link; null when the text is not one. */
export function youtubeVideoId(text: string): string | null {
  const value = text.trim()
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value
  let url: URL
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`) } catch { return null }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
  const id = host === 'youtu.be' ? url.pathname.split('/')[1]
    : host === 'youtube.com' ? (url.searchParams.get('v') ?? /^\/(?:live|shorts|embed)\/([^/?#]+)/.exec(url.pathname)?.[1])
      : undefined
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null
}

/** `h:mm:ss` or `m:ss`, the way YouTube writes time. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** True while an open popover or dialog of this page overlaps `box`: the player would cover it. */
function overlayCovers(box: DOMRect): boolean {
  for (const node of document.querySelectorAll(':popover-open, dialog[open]')) {
    const r = node.getBoundingClientRect()
    if (r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top) return true
  }
  return false
}

/**
 * Keeps main's player over `slot`: re-measured on resize, on scroll and when a popover or
 * dialog opens or closes, coalesced to one report per frame. The player is a native view
 * above this page, so it hides only while something of ours overlaps it.
 */
function usePlayerPlacement(source: YouTubeSource, slot: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const node = slot.current
    if (!active || !node) return
    let frame = 0
    let last = ''
    const report = (): void => {
      frame = 0
      const box = node.getBoundingClientRect()
      const visible = box.width > 0 && box.height > 0 && !overlayCovers(box)
      const rect = { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }
      const key = JSON.stringify([rect, visible])
      if (key === last) return
      last = key
      void source.place(rect, visible)
    }
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(report) }
    const observer = new ResizeObserver(schedule)
    // Watching the ancestors too: a note shown above moves the slot without resizing it.
    for (let element: Element | null = node; element; element = element.parentElement) observer.observe(element)
    window.addEventListener('resize', schedule)
    // Capture: scroll, popover `toggle` and dialog `close` do not bubble.
    for (const type of ['scroll', 'toggle', 'close']) document.addEventListener(type, schedule, true)
    schedule()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      for (const type of ['scroll', 'toggle', 'close']) document.removeEventListener(type, schedule, true)
      void source.place({ x: 0, y: 0, width: 0, height: 0 }, false)
    }
  }, [source, slot, active])
}

export function YouTubePanel({ source, onStill, onClipReady, autoStill, onAutoStillChange, active }: {
  source: YouTubeSource
  /** A still was taken: hand it to the editor as the current frame. `auto` when 自动取帧 took it. */
  onStill: (still: YouTubeStill, auto: boolean) => void | Promise<void>
  /** A downloaded clip is ready: open it as footage. */
  onClipReady: (job: YouTubeClipJob) => void
  /** 自动取帧, shared with the local footage's switch. */
  autoStill: boolean
  onAutoStillChange: (on: boolean) => void
  /** The panel is the footage on show; a hidden one never takes a still by itself. */
  active: boolean
}): React.ReactNode {
  const [link, setLink] = useState('')
  const [openedUrl, setOpenedUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<YouTubeBrowseState | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [taking, setTaking] = useState(false)
  const [targetHeight, setTargetHeight] = useState<YtImportHeight>(2160)
  const [mark, setMark] = useState<{ in: number | null; out: number | null }>({ in: null, out: null })
  const [jobs, setJobs] = useState<YouTubeClipJob[]>([])
  const announced = useRef(new Set<string>())
  const slot = useRef<HTMLDivElement | null>(null)

  useEffect(() => source.subscribe(setState), [source])
  useEffect(() => source.subscribeClips((next) => {
    setJobs(next)
    for (const job of next) {
      if (job.state === 'ready' && job.mediaUrl && !announced.current.has(job.jobId)) {
        announced.current.add(job.jobId)
        onClipReady(job)
      }
    }
  }), [source, onClipReady])
  // Leaving the editor ends the page and its signed-in session.
  useEffect(() => () => { void source.close() }, [source])
  usePlayerPlacement(source, slot, openedUrl !== null)

  const videoId = youtubeVideoId(link)
  const open = async (): Promise<void> => {
    if (!videoId || busy) return
    setBusy(true)
    setProblem(null)
    const url = `https://www.youtube.com/watch?v=${videoId}`
    const result = await source.open(url)
    setBusy(false)
    if (!result.ok) { setProblem(YOUTUBE_ERROR_TEXT[result.error]); return }
    setOpenedUrl(url)
    setMark({ in: null, out: null })
  }

  /** The recording last seen and where it stood still (`at`, null while it plays); null before any. */
  const stopped = useRef<{ videoId: string; at: string | null } | null>(null)
  const takingRef = useRef(false)
  const takeStill = useCallback(async (auto = false): Promise<void> => {
    if (takingRef.current) return
    takingRef.current = true
    setProblem(null)
    setTaking(true)
    try {
      const result = await source.still()
      if (!result.ok) {
        // Caught mid-seek: the next pushed state tries again, without a note.
        if (auto && result.error === 'snapshot-unavailable') {
          if (stopped.current) stopped.current = { ...stopped.current, at: null }
          return
        }
        setProblem(YOUTUBE_ERROR_TEXT[result.error])
        return
      }
      await onStill(result.still, auto)
    } finally { takingRef.current = false; setTaking(false) }
  }, [source, onStill])

  // 自动取帧: take the frame the player stops on, paused or moved while paused, once. Only a
  // stop seen while the switch is on and this panel is shown counts, so opening a recording,
  // coming back to this panel or turning the switch on never replaces the frame in use. The
  // state arrives about once a second, so a stop is taken within about a second.
  useEffect(() => {
    if (!state) { stopped.current = null; return }
    const at = state.playing ? null : state.currentTime.toFixed(3)
    const previous = stopped.current
    if (previous?.videoId === state.videoId && previous.at === at) return
    if (at !== null && takingRef.current) return
    stopped.current = { videoId: state.videoId, at }
    // The first look at a recording is where it opened, not where it was stopped.
    const fresh = previous?.videoId !== state.videoId
    if (at !== null && !fresh && autoStill && active && state.playerOnly && !state.advert && !state.error) void takeStill(true)
  }, [state, autoStill, active, takeStill])

  // The pushed state can be a second old; a mark reads the player now.
  const setPoint = async (which: 'in' | 'out'): Promise<void> => {
    const current = await source.now()
    if (current) setMark((m) => ({ ...m, [which]: current.currentTime }))
  }

  const length = mark.in !== null && mark.out !== null ? mark.out - mark.in : null
  const clipProblem = length === null ? null : length <= 0 ? '出点要在入点之后'
    : length > MAX_CLIP_SECONDS ? YOUTUBE_ERROR_TEXT['too-long'] : null
  const download = async (): Promise<void> => {
    if (!openedUrl || mark.in === null || mark.out === null || clipProblem) return
    setProblem(null)
    const result = await source.startClip(openedUrl, mark.in, mark.out, targetHeight)
    if (!result.ok) setProblem(clipError(result.error, targetHeight))
  }
  const running = jobs.some((job) => job.state === 'probing' || job.state === 'downloading')
  const native = state ? state.videoWidth === 3840 && state.videoHeight === 2160
    || state.videoWidth === 2560 && state.videoHeight === 1440
    || state.videoWidth === 1920 && state.videoHeight === 1080 : false
  const ready = state?.playerOnly === true

  return (
    <section className="yt-panel" aria-label="YouTube 录像">
      <form className="yt-link" onSubmit={(event) => { event.preventDefault(); void open() }}>
        <input className="text-input" value={link} onChange={(event) => setLink(event.target.value)}
          aria-label="YouTube 录像链接" placeholder="粘贴 YouTube 比赛录像链接" spellCheck={false} autoComplete="off" />
        <button type="submit" className="btn-solid small" disabled={!videoId || busy}>{busy ? '正在打开…' : '打开'}</button>
      </form>

      {openedUrl && (
        <>
          {/* Main lays the player over this box; what is drawn here shows only until it is up. */}
          <div className="yt-player" ref={slot} data-ready={ready}>
            {!ready && <span className="muted">{state?.error ? YOUTUBE_ERROR_TEXT[state.error] : '正在载入…'}</span>}
          </div>
          <div className="yt-status">
            <span className="num" data-native={native} title="YouTube 实际解码的尺寸">
              {state && state.videoWidth && state.videoHeight ? `${state.videoWidth}×${state.videoHeight}` : '未在播放'}
            </span>
            {state && !native && state.videoWidth > 0 && (
              <span className="note-warn">在播放器的画质菜单里选 2160p、1440p 或 1080p</span>
            )}
            {state?.advert && <span className="muted">正在播广告，结束后再截图</span>}
          </div>

          <div className="yt-actions">
            <button type="button" className="btn-solid small" disabled={!ready || state.advert || taking} onClick={() => void takeStill()}>
              {taking ? '正在截取…' : '截当前画面'}
            </button>
            <Switch label="自动取帧" checked={autoStill} onChange={onAutoStillChange} />
            <span className="yt-divider" aria-hidden="true" />
            <button type="button" className="btn-quiet small" disabled={!ready} onClick={() => void setPoint('in')}>
              设为入点{mark.in !== null ? ` ${clock(mark.in)}` : ''}
            </button>
            <button type="button" className="btn-quiet small" disabled={!ready} onClick={() => void setPoint('out')}>
              设为出点{mark.out !== null ? ` ${clock(mark.out)}` : ''}
            </button>
            <select className="text-input num yt-quality" aria-label="下载画质" value={targetHeight}
              onChange={(event) => setTargetHeight(Number(event.target.value) as YtImportHeight)}>
              <option value={2160}>2160p</option>
              <option value={1440}>1440p</option>
              <option value={1080}>1080p</option>
            </select>
            <button type="button" className="btn-solid small" disabled={length === null || clipProblem !== null || running}
              onClick={() => void download()}>
              下载这一段{length !== null && !clipProblem ? `（${clock(length)}）` : ''}
            </button>
          </div>
          {clipProblem && <p className="form-error">{clipProblem}</p>}
        </>
      )}

      {problem && <p className="form-error" role="alert">{problem}</p>}

      {jobs.length > 0 && (
        <ul className="yt-jobs" aria-label="下载">
          {jobs.map((job) => (
            <li key={job.jobId} className="yt-job" data-state={job.state}>
              <span className="yt-job-what">
                {job.title || job.videoId} <span className="muted num">{clock(job.startSeconds)}–{clock(job.endSeconds)}</span>
              </span>
              <span className="muted">
                {job.state === 'probing' ? `正在查找${job.targetHeight ? ` ${job.targetHeight}p` : '所选画质'}…`
                  : job.state === 'downloading' ? (job.progress !== null ? `正在下载 ${Math.round(job.progress * 100)}%` : '正在下载…')
                    : job.state === 'ready' ? `已下载${job.width ? ` · ${job.width}×${job.height}` : ''}`
                      : job.state === 'cancelled' ? '已取消'
                        : clipError(job.error ?? 'failed', job.targetHeight)}
              </span>
              {(job.state === 'probing' || job.state === 'downloading') && (
                <button type="button" className="btn-quiet small" onClick={() => void source.cancelClip(job.jobId)}>取消</button>
              )}
              {job.state === 'ready' && (
                <button type="button" className="btn-quiet small" onClick={() => onClipReady(job)}>打开</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
