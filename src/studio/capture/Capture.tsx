/**
 * Screenshot and GIF of the playing picture (handoff item 15). `CaptureControls` sits in the
 * player's dock and renders nothing while capture is switched off; `CaptureSettings` is the
 * on/off block in settings.
 *
 * Frames come from the video element's current playhead only. GIF frames are appended one at
 * a time, each waiting for the previous append to return, so base64 frames never pile up in
 * IPC. The destination file is always chosen by the main process's own save dialog.
 */

import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { GifOptions, GifRecording, MediaCapture } from '../../../electron/mediaCapture'
import { captureVideoFrame } from '../../media/frameCapture'
import { Icon, Popover, Switch, usePopover } from '../kit'
import './capture.css'

type CaptureState = ReturnType<MediaCapture['state']>

const LIMITS = {
  fps: { min: 1, max: 15, initial: 10 },
  seconds: { min: 1, max: 30, initial: 5 },
  width: { min: 160, max: 1280, initial: 640 },
} as const

function isCaptureState(value: unknown): value is CaptureState {
  const settings = (value as CaptureState | null)?.settings
  return !!settings && typeof settings.enabled === 'boolean' && Array.isArray((value as CaptureState).recordings)
}

/** Subscribe first, then read the snapshot; an event that arrives first wins over it. */
function useCaptureState(): [CaptureState | null, (state: CaptureState) => void, string] {
  const [state, setState] = useState<CaptureState | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    let heard = false
    const off = apiClient.subscribeFeatures((event) => {
      if (event.topic !== 'capture' || !isCaptureState(event.data)) return
      heard = true
      setState(event.data)
    })
    void apiClient.feature('getCaptureState', undefined).then((result) => {
      if (!live || heard) return
      if (result.ok && isCaptureState(result.value)) setState(result.value)
      else if (!result.ok) setError(result.message)
    })
    return () => { live = false; off() }
  }, [])
  return [state, setState, error]
}

const errorText = (error: unknown): string => error instanceof Error && error.message ? error.message : '当前视频帧不可用'

type Job = {
  id: string
  cancelled: boolean
  stopping: boolean
  /** Ends the wait between two frames early, on stop or cancel. */
  wake: (() => void) | null
}

type Live = Pick<GifRecording, 'id' | 'frames' | 'maxFrames' | 'phase'>
type Note = { text: string; tone: 'ok' | 'error' | 'plain' }

export function CaptureControls({ source }: {
  /** The video element currently shown as the main picture, read at the moment of use. */
  source: () => HTMLVideoElement | null
}): React.ReactNode {
  const [state] = useCaptureState()
  const enabled = state?.settings.enabled === true
  const menu = usePopover()
  const [shooting, setShooting] = useState(false)
  const [live, setLive] = useState<Live | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [form, setForm] = useState({ fps: String(LIMITS.fps.initial), seconds: String(LIMITS.seconds.initial), width: String(LIMITS.width.initial) })
  const [formError, setFormError] = useState('')
  const [starting, setStarting] = useState(false)
  const job = useRef<Job | null>(null)
  const mounted = useRef(true)
  const sourceRef = useRef(source)
  sourceRef.current = source

  // Short-lived status next to the buttons.
  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => setNote(null), note.tone === 'error' ? 6000 : 3500)
    return () => clearTimeout(timer)
  }, [note])

  const say = (text: string, tone: Note['tone']): void => { if (mounted.current) setNote({ text, tone }) }

  const abandon = (current: Job): void => {
    current.cancelled = true
    current.wake?.()
    if (job.current === current) job.current = null
    if (mounted.current) setLive(null)
    void apiClient.feature('cancelGifRecording', { id: current.id })
  }

  // Leaving the player cancels whatever is being recorded or encoded.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const current = job.current
      if (current) abandon(current)
    }
  }, [])

  // Turning capture off in the main process already cancelled the job there.
  useEffect(() => {
    if (state && !state.settings.enabled && job.current) {
      const current = job.current
      current.cancelled = true
      current.wake?.()
      job.current = null
      setLive(null)
      say('截图与 GIF 已关闭，录制已取消', 'plain')
    }
  }, [state])

  // The main picture can be closed or swapped while encoding or between two frames.
  const active = live !== null
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      const current = job.current
      if (current && !sourceRef.current()) { abandon(current); say('画面已关闭，录制已取消', 'plain') }
    }, 1000)
    return () => clearInterval(timer)
  }, [active])

  const screenshot = async (): Promise<void> => {
    if (shooting) return
    const video = sourceRef.current()
    if (!video) { say('当前没有可截取的画面', 'error'); return }
    let png: string
    try { png = captureVideoFrame(video) } catch (error) { say(errorText(error), 'error'); return }
    setShooting(true)
    try {
      const result = await apiClient.feature('savePlaybackScreenshot', { png })
      if (!result.ok) say(result.message, 'error')
      else if (result.value.status === 'saved') say('截图已保存', 'ok')
      else say('已取消保存', 'plain')
    } finally { if (mounted.current) setShooting(false) }
  }

  const readForm = (): GifOptions | null => {
    const values = { fps: Number(form.fps), seconds: Number(form.seconds), width: Number(form.width) }
    for (const key of ['fps', 'seconds', 'width'] as const) {
      const value = values[key]
      const { min, max } = LIMITS[key]
      if (!Number.isInteger(value) || value < min || value > max) {
        setFormError(`${FIELD_NAME[key]}须为 ${min} 至 ${max} 之间的整数`)
        return null
      }
    }
    setFormError('')
    return values
  }

  const record = async (): Promise<void> => {
    if (job.current || starting) return
    const options = readForm()
    if (!options) return
    if (!sourceRef.current()) { setFormError('当前没有可录制的画面'); return }
    setStarting(true)
    const begun = await apiClient.feature('beginGifRecording', options)
    if (mounted.current) setStarting(false)
    if (!mounted.current) {
      if (begun.ok) void apiClient.feature('cancelGifRecording', { id: begun.value.id })
      return
    }
    if (!begun.ok) { setFormError(begun.message); return }
    const current: Job = { id: begun.value.id, cancelled: false, stopping: false, wake: null }
    job.current = current
    const maxFrames = begun.value.maxFrames
    setLive({ id: current.id, frames: 0, maxFrames, phase: 'recording' })

    const interval = 1000 / options.fps
    let due = performance.now()
    let index = 0
    while (index < maxFrames && !current.cancelled && !current.stopping) {
      const video = sourceRef.current()
      if (!video) { abandon(current); say('画面已关闭，录制已取消', 'plain'); return }
      let png: string
      try { png = captureVideoFrame(video, options.width) } catch (error) { abandon(current); say(errorText(error), 'error'); return }
      const appended = await apiClient.feature('appendGifFrame', { id: current.id, index, png })
      if (current.cancelled) return
      if (!appended.ok) { abandon(current); say(appended.message, 'error'); return }
      index += 1
      if (mounted.current) setLive({ id: current.id, frames: appended.value.frames, maxFrames, phase: 'recording' })
      if (index >= maxFrames || current.stopping) break
      due += interval
      const wait = due - performance.now()
      if (wait > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { current.wake = null; resolve() }, wait)
          current.wake = () => { clearTimeout(timer); current.wake = null; resolve() }
        })
      } else due = performance.now() // Behind schedule: do not burst to catch up.
    }
    if (current.cancelled) return
    if (index < 2) { abandon(current); say('GIF 至少需要 2 帧，录制已取消', 'error'); return }

    if (mounted.current) setLive({ id: current.id, frames: index, maxFrames, phase: 'encoding' })
    const finished = await apiClient.feature('finishGifRecording', { id: current.id })
    // A cancel during encoding must not be followed by a success message.
    if (current.cancelled) return
    job.current = null
    if (!mounted.current) return
    setLive(null)
    if (!finished.ok) say(finished.message, 'error')
    else if (finished.value.status === 'saved') say('GIF 已保存', 'ok')
    else say('已取消保存', 'plain')
  }

  const stop = (): void => {
    const current = job.current
    if (!current || current.stopping) return
    current.stopping = true
    current.wake?.()
  }

  const cancel = (): void => {
    const current = job.current
    if (!current) return
    abandon(current)
    say('录制已取消', 'plain')
  }

  if (!enabled) return null

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>): void => {
    setForm((value) => ({ ...value, [key]: event.target.value }))
  }
  const progress = live ? (live.phase === 'encoding' ? '编码中' : `录制中 ${live.frames}/${live.maxFrames}`) : ''

  return (
    <div className="capture-control">
      <button type="button" className="icon-btn" onClick={() => void screenshot()} disabled={shooting}
        aria-label="截图" title="截取当前画面">
        <Icon name="camera" />
      </button>
      <button type="button" className={`icon-btn ${live ? 'is-recording' : ''}`.trim()} onClick={menu.toggle}
        aria-label="GIF 录制" aria-expanded={menu.open} title="GIF 录制">
        <Icon name="record" />
      </button>
      {live && <button type="button" className="capture-live num" onClick={menu.toggle}>{progress}</button>}
      {note && !menu.open && <p className={`capture-note is-${note.tone}`} role="status">{note.text}</p>}
      <Popover open={menu.open} onClose={menu.close} className="capture-pop" label="GIF 录制">
        {live ? (
          <>
            <div className="row-split">
              <strong>{live.phase === 'encoding' ? '编码中' : '录制中'}</strong>
              {live.phase === 'recording' && <span className="num" aria-label="录制进度">{live.frames}/{live.maxFrames}</span>}
            </div>
            <div className="capture-meter" aria-hidden="true">
              <span style={{ width: `${live.phase === 'encoding' ? 100 : Math.round(live.frames * 100 / live.maxFrames)}%` }} />
            </div>
            {live.phase === 'encoding' && <p className="muted">编码完成后将弹出保存对话框。</p>}
            <div className="row-end">
              <button type="button" className="btn-quiet small" onClick={cancel}>取消</button>
              {live.phase === 'recording' && (
                <button type="button" className="btn-solid small" onClick={stop} disabled={live.frames < 2}>停止并保存</button>
              )}
            </div>
          </>
        ) : (
          <form className="capture-form" noValidate onSubmit={(event) => { event.preventDefault(); void record() }}>
            {(['fps', 'seconds', 'width'] as const).map((key) => (
              <label key={key} className="field-row">
                <span className="field-label">{FIELD_NAME[key]}</span>
                <span className="capture-field">
                  <input className="text-input num" type="number" inputMode="numeric" step={1} aria-label={FIELD_NAME[key]}
                    min={LIMITS[key].min} max={LIMITS[key].max} value={form[key]} onChange={set(key)} />
                  <span className="muted">{FIELD_UNIT[key]}</span>
                </span>
              </label>
            ))}
            <p className="muted">帧率 1–15，时长 1–30 秒，宽度 160–1280 像素。</p>
            <div className="row-end">
              <button type="submit" className="btn-solid small" disabled={starting}>开始录制</button>
            </div>
          </form>
        )}
        {formError && <p className="form-error" role="alert">{formError}</p>}
        {note && <p className={`capture-note-inline is-${note.tone}`} role="status">{note.text}</p>}
      </Popover>
    </div>
  )
}

const FIELD_NAME = { fps: '帧率', seconds: '时长', width: '宽度' } as const
const FIELD_UNIT = { fps: '帧/秒', seconds: '秒', width: '像素' } as const

export function CaptureSettings(): React.ReactNode {
  const [state, setState, loadError] = useCaptureState()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const toggle = async (enabled: boolean): Promise<void> => {
    if (pending) return
    setPending(true)
    setError('')
    try {
      const result = await apiClient.feature('setCaptureEnabled', { enabled })
      if (!mounted.current) return
      if (result.ok) setState(result.value)
      else setError(result.message)
    } finally { if (mounted.current) setPending(false) }
  }

  return (
    <>
      <Switch label="启用截图与 GIF" checked={state?.settings.enabled === true} disabled={pending || !state}
        onChange={(enabled) => void toggle(enabled)} />
      <p className="muted">仅截取正在播放的画面，不截取桌面。</p>
      {(error || loadError) && <p className="form-error" role="alert">{error || loadError}</p>}
    </>
  )
}
