/**
 * Playback controls along the bottom edge: play, the time line, the two volumes,
 * danmaku and fullscreen. Alignment sits in the middle of the same bar (see sync.tsx).
 */

import { useEffect, useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { seekableRange } from '../core/syncPlan'
import { SOURCE_ROLES, type SourceRole } from '../core/types'
import { Icon } from './kit'
import { ROLE_LABEL } from './sources'

/**
 * One slider for two volumes, like a crossfader: the middle plays both at full, each end
 * silences the other side. Watching a match means "mostly the commentator, a bit of the
 * arena" far more often than two independent levels.
 */
export function balanceOf(official: number, commentary: number): number {
  if (commentary >= official) return commentary === 0 ? 0 : 1 - official / commentary
  return -(1 - commentary / official)
}

export function volumesFor(balance: number): { official: number; commentary: number } {
  const b = Math.max(-1, Math.min(1, balance))
  return {
    official: Math.round((b <= 0 ? 1 : 1 - b) * 100) / 100,
    commentary: Math.round((b >= 0 ? 1 : 1 + b) * 100) / 100,
  }
}

/**
 * Two volumes, one per side, each with its own mute. The crossfader math above is kept for
 * what it was tested for; the dock now sets each level directly, because "how loud is the
 * arena" and "how loud is the commentator" are separate questions while watching.
 */
export function Volumes(): React.ReactNode {
  return (
    <div className="volumes">
      {SOURCE_ROLES.map((role) => <Volume key={role} role={role} />)}
    </div>
  )
}

function Volume({ role }: { role: SourceRole }): React.ReactNode {
  const session = useSession()
  const { media } = useSessionSnapshot()
  const state = media[role]
  const level = state.muted ? 0 : state.volume
  const percent = Math.round(level * 100)
  const label = ROLE_LABEL[role]
  // Unmuting at zero would be silent; bring it back to a usable level instead.
  const toggle = (): void => {
    if (level > 0) session.setMuted(role, true)
    else session.setVolume(role, state.volume > 0 ? state.volume : 0.6)
  }
  return (
    <div className="volume" data-role={role} data-empty={state.status === 'empty' || undefined}>
      <button type="button" className="volume-mute" onClick={toggle} aria-pressed={level === 0}
        aria-label={level === 0 ? `取消${label}静音` : `${label}静音`} title={level === 0 ? `取消${label}静音` : `${label}静音`}>
        <Icon name={level === 0 ? 'mute' : 'volume'} />
        <span className="volume-name">{label}</span>
      </button>
      <input type="range" min={0} max={100} step={1} value={percent} aria-label={`${label}音量`}
        aria-valuetext={`${percent}%`} style={{ '--fill': `${percent}%` } as React.CSSProperties}
        onChange={(event) => session.setVolume(role, Number(event.target.value) / 100)} />
    </div>
  )
}

/** The main picture's time line. A live stream's axis is its seekable window. */
export function Timeline(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const role = snapshot.mainRole
  const state = snapshot.media[role]
  const timebase = state.timebase
  const [drag, setDrag] = useState<number | null>(null)
  useEffect(() => setDrag(null), [role])
  if (!timebase) return <div className="timeline is-empty" />

  const range = seekableRange(timebase)
  const start = range.start
  const end = Math.max(range.end, start + 0.1)
  const position = drag ?? state.currentTime
  const behind = Math.max(0, end - state.currentTime)
  const pct = (value: number): string => `${Math.min(100, Math.max(0, ((value - start) / (end - start)) * 100))}%`
  const commit = (value: number): void => { void session.engine.seek(role, value); setDrag(null) }

  return (
    <div className="timeline">
      <div className="timeline-track">
        <span className="timeline-buffer" style={{ width: pct(state.bufferedEnd) }} />
        <span className="timeline-played" style={{ width: pct(position) }} />
        <input type="range" min={start} max={end} step={0.1} value={position} aria-label="播放进度"
          onChange={(event) => setDrag(Number(event.target.value))}
          onPointerUp={(event) => commit(Number(event.currentTarget.value))}
          onKeyUp={(event) => commit(Number(event.currentTarget.value))} />
      </div>
      <div className="timeline-meta">
        <span className="num">{clock(position - start)}</span>
        {state.isLive ? (
          behind < 2
            ? <span className="live-tag">直播</span>
            : <button type="button" className="live-tag is-behind" onClick={() => void session.returnPlaybackToLive(role)}>
                落后 {behind.toFixed(0)} 秒 · 回到直播
              </button>
        ) : <span className="num">{clock(end - start)}</span>}
      </div>
    </div>
  )
}

export function PlayButton(): React.ReactNode {
  const session = useSession()
  const { playing, media } = useSessionSnapshot()
  const nothing = media.official.status === 'empty' && media.commentary.status === 'empty'
  return (
    <button type="button" className="play" disabled={nothing} onClick={() => void session.togglePlaying()}
      aria-label={playing ? '暂停' : '播放'} title={`${playing ? '暂停' : '播放'}（空格）`}>
      <Icon name={playing ? 'pause' : 'play'} />
    </button>
  )
}

export function DanmakuSwitch({ onTune }: { onTune: () => void }): React.ReactNode {
  const session = useSession()
  const { settings } = useSessionSnapshot()
  const on = settings.danmaku.enabled
  return (
    <div className="dm-switch">
      <button type="button" className={`dm-toggle ${on ? 'is-on' : ''}`.trim()} aria-pressed={on}
        onClick={() => session.updateDanmakuSettings({ enabled: !on })} title="弹幕（D）">
        弹
      </button>
      <button type="button" className="icon-btn" onClick={onTune} aria-label="弹幕设置" title="弹幕设置">
        <Icon name="tune" />
      </button>
    </div>
  )
}

export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
