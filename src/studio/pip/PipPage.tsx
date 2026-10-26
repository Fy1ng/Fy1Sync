/**
 * The enhanced picture-in-picture window's page, route `/pip` (handoff items 06, 07).
 *
 * A restricted window that shows one stream: one stable video, this room's danmaku and a
 * send bar. It never builds the player's Session; main decides what it may call (its own
 * PiP state, the selected stream's local playback, the selected room) and the page asks
 * for nothing else.
 *
 * Order, per the handoff: read the state, load the allowed local source, report ready only
 * once the picture really plays (main shows the window then and hands it the audio), keep
 * reporting real progress, reload in place on `recoveryRevision`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { PipState } from '../../../electron/pipManager'
import { Icon } from '../kit'
import { PipDanmaku } from './PipDanmaku'
import { usePipLoad, usePipMedia, usePipReporter, usePipSource } from './pipPlayback'
import { isPipState, useDanmakuPreferences, usePipState } from './pipState'
import './pip.css'

const OUTCOME_MS = 4_000

/** Why the send bar is off, or null when a send may be attempted. */
export function sendBlock(context: PipState['sendContext'] | null | undefined): string | null {
  if (!context) return '正在读取发送状态'
  if (!context.room) return '未关联斗鱼直播间'
  if (!context.accountId) return '未登录斗鱼账号'
  if (!context.canAttempt) return '当前不可发送'
  return null
}

export default function PipPage(): React.ReactNode {
  const { state, error, apply } = usePipState()
  const preferences = useDanmakuPreferences()
  const media = usePipMedia()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const active = state?.phase === 'opening' || state?.phase === 'ready'
  const { source, problem: sourceProblem } = usePipSource(state)
  const [reloads, setReloads] = useState(0)
  const onReload = useCallback(() => setReloads(value => value + 1), [])
  const loadProblem = usePipLoad(media, source, state?.recoveryRevision ?? 0, active, onReload)
  const ready = usePipReporter(media, active, apply)
  const [danmakuProblem, setDanmakuProblem] = useState<string | null>(null)

  useEffect(() => { media?.mount(hostRef.current) }, [media])

  // Low power applies once the window is ready, the same moment main reads it.
  const reduced = state?.phase === 'ready' && state.options.lowPower
  const room = active ? state?.sendContext.room ?? null : null

  const status = statusText(state, error, ready, sourceProblem ?? loadProblem)

  return (
    <div className="pip-page" data-phase={state?.phase ?? 'loading'}>
      <div className="pip-video" ref={hostRef} />
      <PipDanmaku video={media?.video ?? null} room={room} preferences={preferences}
        drawing={!reduced} resetKey={reloads} onProblem={setDanmakuProblem} />
      {(status || (danmakuProblem && active)) && (
        <p className="pip-status" role="status">{status ?? danmakuProblem}</p>
      )}
      <PipControls video={media?.video ?? null} state={state} apply={apply} />
      <SendBar context={state?.sendContext ?? null} apply={apply} />
    </div>
  )
}

function statusText(state: PipState | null, error: string | null, ready: boolean, problem: string | null): string | null {
  if (!state) return error ?? null
  if (state.phase === 'failed') return state.message ?? '画中画已失败'
  if (state.phase === 'closed') return '画中画已关闭'
  if (problem) return problem
  if (state.message) return state.message
  if (state.phase === 'opening' && !ready) return '正在载入画面'
  return null
}

function PipControls({ video, state, apply }: {
  video: HTMLVideoElement | null
  state: PipState | null
  apply: (state: PipState) => void
}): React.ReactNode {
  const [paused, setPaused] = useState(true)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    if (!video) return
    const sync = (): void => {
      setPaused(video.paused)
      setVolume(video.volume)
      setMuted(video.muted)
    }
    sync()
    const events = ['play', 'pause', 'playing', 'ended', 'volumechange', 'emptied']
    for (const name of events) video.addEventListener(name, sync)
    return () => { for (const name of events) video.removeEventListener(name, sync) }
  }, [video])

  const toggle = (): void => {
    if (!video) return
    if (video.paused) void video.play().catch(() => {})
    else video.pause()
  }

  const call = async (method: 'recoverEnhancedPip' | 'closeEnhancedPip'): Promise<void> => {
    setProblem(null)
    const result = await apiClient.feature(method, undefined)
    if (!mounted.current) return
    if (result.ok) { if (isPipState(result.value)) apply(result.value) } else setProblem(result.message)
  }

  const live = state?.phase === 'ready'
  return (
    <div className="pip-controls" role="toolbar" aria-label="画中画控制">
      <button type="button" className="pip-icon" disabled={!video || !live} onClick={toggle}
        aria-label={paused ? '播放' : '暂停'} title={paused ? '播放' : '暂停'}>
        <Icon name={paused ? 'play' : 'pause'} />
      </button>
      <button type="button" className="pip-icon" disabled={!video} aria-label={muted ? '取消静音' : '静音'}
        title={muted ? '取消静音' : '静音'} onClick={() => { if (video) video.muted = !video.muted }}>
        <Icon name={muted || volume === 0 ? 'mute' : 'volume'} />
      </button>
      <input type="range" className="pip-volume" min={0} max={1} step={0.05} aria-label="音量"
        value={muted ? 0 : volume} disabled={!video}
        onChange={(event) => {
          if (!video) return
          video.volume = Number(event.target.value)
          video.muted = video.volume === 0
        }} />
      <span className="pip-spacer" />
      {problem && <span className="pip-control-note" role="alert">{problem}</span>}
      <button type="button" className="pip-text-btn" disabled={!live} onClick={() => void call('recoverEnhancedPip')}>恢复画面</button>
      <button type="button" className="pip-icon" aria-label="关闭画中画" title="关闭画中画"
        onClick={() => void call('closeEnhancedPip')}>
        <Icon name="close" />
      </button>
    </div>
  )
}

function SendBar({ context, apply }: {
  context: PipState['sendContext'] | null
  apply: (state: PipState) => void
}): React.ReactNode {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ text: string; ok: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  const show = (value: string, ok: boolean): void => {
    if (!mounted.current) return
    setOutcome({ text: value, ok })
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; setOutcome(null) }, OUTCOME_MS)
  }

  const block = sendBlock(context)

  const send = async (): Promise<void> => {
    const draft = text
    if (busy || block || !draft.trim()) return
    setBusy(true)
    try {
      // The account or the room may have changed since the bar was drawn.
      const fresh = await apiClient.feature('getEnhancedPip', undefined)
      if (!mounted.current) return
      if (!fresh.ok || !isPipState(fresh.value)) { show(fresh.ok ? '无法读取发送状态' : fresh.message, false); return }
      apply(fresh.value)
      const current = fresh.value.sendContext
      const reason = sendBlock(current)
      if (reason || !current.accountId || !current.room) { show(reason ?? '当前不可发送', false); return }
      // Main verifies this window still matches its operation room without switching it.
      const activated = await apiClient.feature('activateDouyuRoom', { room: current.room })
      if (!mounted.current) return
      if (!activated.ok) { show(activated.message, false); return }
      const result = await apiClient.feature('sendComposedDouyuMessage', {
        accountId: current.accountId, room: current.room, text: draft, color: 0, mode: 'message',
      })
      if (!mounted.current) return
      if (!result.ok) { show(result.message, false); return }
      const succeeded = result.value.status === 'succeeded'
      show(result.value.message || (succeeded ? '已发送' : '发送未完成'), succeeded)
      if (succeeded) setText(value => value === draft ? '' : value)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <form className="pip-send" data-outcome={outcome ? 'shown' : undefined}
      onSubmit={(event) => { event.preventDefault(); void send() }}>
      {outcome && <p className={`pip-outcome ${outcome.ok ? '' : 'is-bad'}`.trim()} role="status">{outcome.text}</p>}
      <div className="pip-send-row">
        <input className="pip-input" type="text" aria-label="发送弹幕" maxLength={500}
          placeholder={block ?? '发送弹幕'} value={text} disabled={!!block}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            // Enter that confirms an IME candidate is not a send.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            event.preventDefault()
            void send()
          }} />
        <button type="submit" className="pip-send-btn" disabled={!!block || busy || !text.trim()}>发送</button>
      </div>
    </form>
  )
}
