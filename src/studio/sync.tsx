/**
 * Lining the two streams up.
 *
 * The controls are named after what the viewer notices, not what the program does: the
 * commentator shouts before the play happens on screen — "解说早了" — or after it — "解说晚
 * 了". Everything is phrased from the voice's side because the voice is what people are
 * listening to while their eyes are on the picture.
 *
 * Underneath, a positive offset holds the official picture back and a negative one holds
 * the commentary back (see Session.applyOffset).
 *
 * The strip along the top is a clapperboard's stripes. It runs while an alignment is in
 * progress and stops when it lands, which is the one piece of motion in the chrome.
 */

import { useEffect, useRef, useState } from 'react'
import { navigate, routeLink } from '../app/navigate'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { MAX_OFFSET_SECONDS, SOURCE_ROLES, type SourceRole } from '../core/types'
import { AUTO_PROFILE_TEXT } from '../recognition/autoProfile'
import { HoldButton, Icon, Popover, Segmented, Switch, usePopover } from './kit'
import { ROLE_LABEL } from './sources'

const clampOffset = (value: number): number =>
  Math.round(Math.min(MAX_OFFSET_SECONDS, Math.max(-MAX_OFFSET_SECONDS, value)) * 100) / 100

/** Held presses switch from the small step to the large one after about a second. */
const stepFor = (held: number, small: number, large: number): number => (held >= 8 ? large : small)

type StripState = 'idle' | 'working' | 'locked' | 'short' | 'failed'

export function useNudge(): (direction: 'early' | 'late', size: number) => void {
  const session = useSession()
  // Holding a button steps faster than the session settles each offset, so build on a
  // running total rather than on the last value the session reported back.
  const pending = useRef<number | null>(null)
  const snapshot = useSessionSnapshot()
  useEffect(() => { pending.current = null }, [snapshot.requestedOffsetSeconds])
  return (direction, size) => {
    // An offset between two sides needs two sides; with one missing there is nothing to move.
    const media = session.snapshot.media
    if (media.official.status === 'empty' || media.commentary.status === 'empty') return
    const base = pending.current ?? session.snapshot.requestedOffsetSeconds
    // Commentary early → hold the commentary back (more negative). Late → hold the picture.
    const next = clampOffset(base + (direction === 'early' ? -size : size))
    if (next === base) return
    pending.current = next
    void session.applyOffset(next)
  }
}

export function SyncCapsule(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const nudge = useNudge()
  const editor = usePopover()
  const { settings, autoSync } = snapshot
  const requested = snapshot.requestedOffsetSeconds
  const shortfall = requested - snapshot.offsetSeconds
  const running = autoSync.phase !== 'idle' && autoSync.phase !== 'done' && autoSync.phase !== 'failed'
  const paired = snapshot.media.official.status !== 'empty' && snapshot.media.commentary.status !== 'empty'

  const state: StripState = running || session.offsetBusy ? 'working'
    : Math.abs(shortfall) > 0.05 ? 'short'
      : autoSync.phase === 'failed' ? 'failed'
        : autoSync.phase === 'done' && autoSync.authorized ? 'locked'
          : 'idle'

  const magnitude = Math.abs(requested)
  const caption = magnitude < 0.005 ? '未调整' : requested > 0 ? '画面延后' : '解说延后'

  return (
    <div className="capsule" data-state={state} role="group" aria-label="对齐">
      <span className="capsule-strip" aria-hidden="true" />
      <HoldButton
        className="capsule-nudge"
        label="回退画面"
        title={`画面相对解说回退 ${settings.smallStepSeconds} 秒（, 键，长按连续调整）`}
        disabled={!paired || requested >= MAX_OFFSET_SECONDS}
        onStep={(held) => nudge('late', stepFor(held, settings.smallStepSeconds, settings.largeStepSeconds))}
      >
        <Icon name="back" />
        <span>回退画面</span>
      </HoldButton>

      <div className="capsule-readout-wrap">
        <button type="button" className="capsule-readout" onClick={editor.toggle} disabled={!paired}
          aria-label={`${caption} ${magnitude.toFixed(1)} 秒，点击输入`} aria-expanded={editor.open}>
          <span className="capsule-value">{magnitude.toFixed(1)}</span>
          <span className="capsule-caption">
            {state === 'short' ? `缓冲不足，相差 ${Math.abs(shortfall).toFixed(1)}s` : state === 'locked' ? '已对齐' : caption}
          </span>
        </button>
        <Popover open={editor.open} onClose={editor.close} className="offset-editor" label="输入延后时间">
          <OffsetEditor value={requested} onDone={editor.close} />
        </Popover>
      </div>

      <HoldButton
        className="capsule-nudge"
        label="快进画面"
        title={`画面相对解说快进 ${settings.smallStepSeconds} 秒（. 键，长按连续调整）`}
        disabled={!paired || requested <= -MAX_OFFSET_SECONDS}
        onStep={(held) => nudge('early', stepFor(held, settings.smallStepSeconds, settings.largeStepSeconds))}
      >
        <span>快进画面</span>
        <Icon name="forward" />
      </HoldButton>
    </div>
  )
}

/** An exact value: which side waits, and for how long. */
function OffsetEditor({ value, onDone }: { value: number; onDone: () => void }): React.ReactNode {
  const session = useSession()
  const [side, setSide] = useState<SourceRole>(value >= 0 ? 'official' : 'commentary')
  const [text, setText] = useState(value === 0 ? '' : Math.abs(value).toFixed(2).replace(/\.?0+$/, ''))
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => { input.current?.select() }, [])
  const seconds = Number(text.replace('，', '.').trim() || '0')
  const valid = Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_OFFSET_SECONDS

  const apply = (): void => {
    if (!valid) return
    void session.applyOffset(clampOffset(side === 'official' ? seconds : -seconds))
    onDone()
  }

  return (
    <form onSubmit={(event) => { event.preventDefault(); apply() }} className="offset-form">
      <Segmented label="延后哪一路" value={side} onChange={setSide}
        options={[{ value: 'official', label: '画面延后' }, { value: 'commentary', label: '解说延后' }]} />
      <label className="offset-seconds">
        <input ref={input} inputMode="decimal" value={text} aria-label="秒数" aria-invalid={!valid}
          placeholder="0" onChange={(event) => setText(event.target.value)} />
        <span>秒</span>
      </label>
      {!valid && <p className="form-error">请输入 0 到 {MAX_OFFSET_SECONDS} 之间的数值</p>}
      <div className="row-end">
        <button type="button" className="btn-quiet" onClick={() => { void session.resetOffset(); onDone() }}>清零</button>
        <button type="submit" className="btn-solid" disabled={!valid}>应用</button>
      </div>
    </form>
  )
}

export function AutoAlign(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const menu = usePopover()
  const { autoSync, settings } = snapshot
  const running = autoSync.phase !== 'idle' && autoSync.phase !== 'done' && autoSync.phase !== 'failed'
  const busy = running || session.offsetBusy || snapshot.autoProfileBusy
  const bothReady = snapshot.media.official.status === 'ready' && snapshot.media.commentary.status === 'ready'
  const result = autoSync.lastResult

  return (
    <div className="align">
      {running ? (
        <button type="button" className="align-main is-running" onClick={() => session.cancelAutoSync()}
          title="停止对齐">
          <span className="align-phase">{PHASE[autoSync.phase]}</span>
          <Icon name="close" />
        </button>
      ) : (
        <button type="button" className="align-main" disabled={busy || !bothReady} onClick={() => void session.syncNow()}
          title={bothReady ? '识别两路画面中的比赛倒计时并自动对齐（A）' : '两路均载入后才能对齐'}>
          自动对齐
        </button>
      )}
      <button type="button" className="align-more" onClick={menu.toggle} aria-label="对齐选项" aria-expanded={menu.open}
        data-attention={!autoSync.authorized && settings.autoSyncEnabled ? 'true' : undefined}>
        <Icon name="chevron" />
      </button>
      <Popover open={menu.open} onClose={menu.close} className="align-menu" label="对齐选项">
        <Switch label="比赛中保持对齐" detail={autoSync.nextRunInSeconds !== null ? `${Math.max(0, Math.round(autoSync.nextRunInSeconds))} 秒后再次对齐` : undefined}
          checked={settings.autoSyncEnabled} onChange={(checked) => session.setAutoSyncEnabled(checked)} />
        {settings.autoSyncEnabled && (
          <Segmented label="间隔" value={settings.autoSyncIntervalSeconds}
            onChange={(seconds) => session.setAutoSyncInterval(seconds)}
            options={[15, 30, 60, 120].map((seconds) => ({ value: seconds, label: seconds < 60 ? `${seconds} 秒` : `${seconds / 60} 分` }))} />
        )}
        {settings.autoSyncEnabled && !autoSync.authorized && (
          <p className="note-warn">已手动调整，自动对齐已暂停。点击「自动对齐」恢复。</p>
        )}

        <div className="menu-rule" />
        <label className="field-row">
          <span>倒计时样式</span>
          <select value={settings.profileId} disabled={snapshot.presets.length === 0}
            onChange={(event) => void session.selectProfile(event.target.value)}>
            <option value="">自动识别</option>
            {snapshot.presets.map((preset) => (
              <option key={preset.id} value={preset.id} disabled={preset.templateChars === 0}>{preset.name}</option>
            ))}
          </select>
        </label>
        <div className="row-split">
          <button type="button" className="btn-quiet" disabled={busy || !bothReady} onClick={() => void session.measureOnce()}>
            仅测量
          </button>
          <a className="btn-quiet" {...routeLink('/admin')}>编辑倒计时样式</a>
        </div>

        {result && (
          <p className="menu-meta">
            {result.failure ? result.failure.message
              : result.estimate ? `上次测得偏差 ${result.estimate.totalOffsetSeconds.toFixed(2)} 秒${result.divergence !== null ? `，复核误差 ${result.divergence.toFixed(2)} 秒` : ''}`
                : '上次未能测得'}
          </p>
        )}
      </Popover>
    </div>
  )
}

const PHASE: Record<string, string> = {
  sampling: '识别倒计时…',
  estimating: '计算中…',
  applying: '调整中…',
  verifying: '复核中…',
}

/**
 * When a run had to find the countdown on its own, the found region waits for a yes. One
 * line per side, only while there is something to decide.
 */
export function CountdownPrompt(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const rows = SOURCE_ROLES.filter((role) => {
    const state = snapshot.autoProfiles[role]
    return (state.phase === 'ready' && !state.accepted) || state.phase === 'not-found' || state.phase === 'unsupported'
      || state.phase === 'locating' || state.phase === 'learning'
  })
  if (rows.length === 0) return null
  return (
    <div className="prompt-stack" aria-live="polite">
      {rows.map((role) => {
        const state = snapshot.autoProfiles[role]
        const working = state.phase === 'locating' || state.phase === 'learning'
        return (
          <div key={role} className="prompt" data-role={role}>
            <span className="prompt-text">
              <b>{ROLE_LABEL[role]}</b>
              {state.phase === 'ready' ? '已识别比赛倒计时' : working ? `正在识别比赛倒计时（${AUTO_PROFILE_TEXT[state.phase]}）` : state.reason ?? AUTO_PROFILE_TEXT[state.phase]}
            </span>
            {state.phase === 'ready' && <button type="button" className="btn-solid small" onClick={() => session.acceptAutoProfile(role)}>使用</button>}
            {!working && <button type="button" className="btn-quiet small" onClick={() => session.retryAutoProfile(role)}>重新识别</button>}
            {working && <button type="button" className="btn-quiet small" onClick={() => session.cancelAutoProfile(role)}>取消</button>}
            {!working && (
              <button type="button" className="btn-quiet small" onClick={() => {
                session.editAutoProfile(role)
                navigate('/admin')
              }}>手动框选</button>
            )}
          </div>
        )
      })}
    </div>
  )
}
