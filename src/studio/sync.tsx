/**
 * Lining the two streams up.
 *
 * The controls describe the picture's position relative to the commentary, regardless
 * of which stream is held back to achieve it.
 *
 * Underneath, a positive offset holds the official picture back and a negative one holds
 * the commentary back (see Session.applyOffset).
 *
 * The strip along the top is a clapperboard's stripes. It runs while an alignment is in
 * progress and stops when it lands, which is the one piece of motion in the chrome.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { shortcutTitle } from '../app/shortcuts'
import type { Session } from '../app/session'
import { MAX_OFFSET_SECONDS, type SourceRole } from '../core/types'
import { HoldButton, Icon, Popover, Segmented, Switch, usePopover } from './kit'
import { ErrorText } from '../ui/ErrorDetails'
import { useSourceLoader } from './sources'

const clampOffset = (value: number): number =>
  Math.round(Math.min(MAX_OFFSET_SECONDS, Math.max(-MAX_OFFSET_SECONDS, value)) * 100) / 100

export const nudgeStepFor = (shift: boolean, small: number, large: number): number => shift ? small : large

function useNudgeModifier() {
  const [shift, setShift] = useState(false)
  const current = useRef(false)
  const update = useCallback((next: boolean) => { current.current = next; setShift(next) }, [])
  useEffect(() => {
    const change = (event: KeyboardEvent): void => update(event.shiftKey
      || (event.type === 'keydown' && (event.key === 'Shift' || event.code.startsWith('Shift'))))
    const reset = (): void => update(false)
    window.addEventListener('keydown', change)
    window.addEventListener('keyup', change)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', change)
      window.removeEventListener('keyup', change)
      window.removeEventListener('blur', reset)
    }
  }, [update])
  return { shift, current, update }
}

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
  const modifier = useNudgeModifier()
  const editor = usePopover()
  const { settings, autoSync } = snapshot
  const requested = snapshot.requestedOffsetSeconds
  const shortfall = requested - snapshot.offsetSeconds
  const incomplete = Math.abs(shortfall) > 0.05
  const bufferLimited = incomplete && snapshot.lastPlan?.limited === true && snapshot.lastPlan.limitReason === 'buffer-limit'
  const running = autoSync.phase !== 'idle' && autoSync.phase !== 'done' && autoSync.phase !== 'failed'
  const paired = snapshot.media.official.status !== 'empty' && snapshot.media.commentary.status !== 'empty'
  const step = nudgeStepFor(modifier.shift, settings.smallStepSeconds, settings.largeStepSeconds)
  const stepLabel = `${Number(step.toFixed(2))}s`
  const move = (direction: 'early' | 'late', keys?: { shiftKey: boolean }): void => {
    if (keys) modifier.update(keys.shiftKey)
    nudge(direction, nudgeStepFor(modifier.current.current, settings.smallStepSeconds, settings.largeStepSeconds))
  }

  const state: StripState = running || session.offsetBusy ? 'working'
    : bufferLimited ? 'short'
      : incomplete || autoSync.phase === 'failed' ? 'failed'
        : autoSync.phase === 'done' && autoSync.authorized && autoSync.lastResult?.applied && !autoSync.lastResult.dryRun ? 'locked'
          : 'idle'

  const magnitude = Math.abs(requested)
  const caption = magnitude < 0.005 ? '未调整' : requested > 0 ? '画面延后' : '解说延后'

  return (
    <div className="capsule" data-state={state} role="group" aria-label="对齐">
      <span className="capsule-strip" aria-hidden="true" />
      <HoldButton
        className="capsule-nudge"
        label="回退画面"
        title={`${shortcutTitle(`回退画面 ${stepLabel}`, settings.shortcuts.nudgeBack, settings.shortcutsEnabled)}；按住 Shift 微调，长按连调`}
        disabled={!paired || requested >= MAX_OFFSET_SECONDS}
        onPointerEnter={event => modifier.update(event.shiftKey)}
        onStep={(_held, keys) => move('late', keys)}
      >
        <span className="capsule-nudge-main" aria-hidden="true">
          <Icon name="back" />
          <span className="capsule-nudge-copy">
            <span className="capsule-nudge-label">回退画面</span>
            <span className="capsule-nudge-step" data-fine={modifier.shift || undefined}><span className="capsule-nudge-value">{stepLabel}</span></span>
          </span>
        </span>
      </HoldButton>

      <div className="capsule-readout-wrap">
        <button type="button" className="capsule-readout" {...editor.trigger} disabled={!paired}
          aria-label={`${caption} ${magnitude.toFixed(1)} 秒，点击输入`}>
          <span className="capsule-value">{magnitude.toFixed(1)}</span>
          <span className="capsule-caption">
            {state === 'short' ? `缓冲不足，还差 ${Math.abs(shortfall).toFixed(1)} 秒未调`
              : state === 'failed' && incomplete ? snapshot.lastPlan?.limitReason === 'not-ready'
                ? '片源未就绪，未完全调整' : `还差 ${Math.abs(shortfall).toFixed(1)} 秒未调`
                : state === 'locked' ? '已对齐' : caption}
          </span>
        </button>
        <Popover {...editor.popover} className="offset-editor" label="输入画面偏移">
          <OffsetEditor value={requested} onDone={editor.close} />
        </Popover>
      </div>

      <HoldButton
        className="capsule-nudge"
        label="回退解说"
        title={`${shortcutTitle(`回退解说 ${stepLabel}`, settings.shortcuts.nudgeForward, settings.shortcutsEnabled)}；按住 Shift 微调，长按连调`}
        disabled={!paired || requested <= -MAX_OFFSET_SECONDS}
        onPointerEnter={event => modifier.update(event.shiftKey)}
        onStep={(_held, keys) => move('early', keys)}
      >
        <span className="capsule-nudge-main" aria-hidden="true">
          <span className="capsule-nudge-copy">
            <span className="capsule-nudge-label">回退解说</span>
            <span className="capsule-nudge-step" data-fine={modifier.shift || undefined}><span className="capsule-nudge-value">{stepLabel}</span></span>
          </span>
          <Icon name="forward" />
        </span>
      </HoldButton>
    </div>
  )
}

/** An exact alignment offset: which stream waits and by how many seconds. */
function OffsetEditor({ value, onDone }: { value: number; onDone: () => void }): React.ReactNode {
  const session = useSession()
  const [side, setSide] = useState<SourceRole>(value >= 0 ? 'official' : 'commentary')
  const [text, setText] = useState(value === 0 ? '' : Math.abs(value).toFixed(2).replace(/\.?0+$/, ''))
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => { input.current?.select() }, [])
  const seconds = Number(text.replace('，', '.').trim() || '0')
  const valid = Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_OFFSET_SECONDS

  const stepDraft = (delta: number): void => {
    const base = valid ? seconds : 0
    const next = clampOffset((side === 'official' ? base : -base) + (side === 'official' ? delta : -delta))
    const nextSide: SourceRole = next === 0 ? side : next > 0 ? 'official' : 'commentary'
    const abs = Math.abs(next)
    setSide(nextSide)
    setText(abs === 0 ? '0' : abs.toFixed(2).replace(/\.?0+$/, ''))
  }

  const apply = (): void => {
    if (!valid) return
    void session.applyOffset(clampOffset(side === 'official' ? seconds : -seconds))
    onDone()
  }

  return (
    <form onSubmit={(event) => { event.preventDefault(); apply() }} className="offset-form">
      <Segmented label="画面偏移方向" value={side} onChange={setSide}
        options={[{ value: 'official', label: '画面延后' }, { value: 'commentary', label: '解说延后' }]} />
      <p className="muted offset-hint">哪边快了就延后哪边</p>
      <label className="offset-seconds">
        <input ref={input} inputMode="decimal" value={text} aria-label="秒数" aria-invalid={!valid}
          placeholder="0" onChange={(event) => setText(event.target.value)} />
        <span>秒</span>
      </label>
      <div className="offset-quick" role="group" aria-label="快捷步进">
        {([-5, -0.5, 0.5, 5] as const).map((delta) => (
          <button key={delta} type="button" className="btn-quiet small" onClick={() => stepDraft(delta)}>
            {delta > 0 ? `+${delta}s` : `${delta}s`}
          </button>
        ))}
      </div>
      {!valid && <p className="form-error">请输入 0 到 {MAX_OFFSET_SECONDS} 之间的数值</p>}
      <div className="row-end">
        <button type="button" className="btn-quiet" onClick={() => { void session.resetOffset(); onDone() }}>清零</button>
        <button type="submit" className="btn-solid" disabled={!valid}>应用</button>
      </div>
    </form>
  )
}

export function startAutoAlign(session: Session): void {
  if (!session.snapshot.autoSync.ready) return
  void session.syncNow()
}

export function AutoAlign({ onOpenFrameSettings }: { onOpenFrameSettings?: () => void } = {}): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const menu = usePopover()
  const { autoSync, settings } = snapshot
  const running = autoSync.phase !== 'idle' && autoSync.phase !== 'done' && autoSync.phase !== 'failed'
  const busy = running || session.offsetBusy
  const bothReady = autoSync.ready
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
        <button type="button" className="align-main" disabled={busy || !bothReady} onClick={() => startAutoAlign(session)}
          title={bothReady ? shortcutTitle('自动对齐', settings.shortcuts.autoAlign, settings.shortcutsEnabled) : '等待两路播放和缓冲就绪'}>
          {bothReady ? '自动对齐' : '准备中'}
        </button>
      )}
      <button type="button" className="align-more" {...menu.trigger} aria-label="对齐选项"
        data-attention={!autoSync.authorized && settings.autoSyncEnabled ? 'true' : undefined}>
        <Icon name="chevron" />
      </button>
      <Popover {...menu.popover} className="align-menu" label="对齐选项">
        <Switch label="比赛中保持对齐" detail={autoSync.nextRunInSeconds !== null ? `${Math.max(0, Math.round(autoSync.nextRunInSeconds))} 秒后再次对齐` : undefined}
          checked={settings.autoSyncEnabled} onChange={(checked) => session.setAutoSyncEnabled(checked)} />
        {settings.autoSyncEnabled && (
          <Segmented label="间隔" value={settings.autoSyncIntervalSeconds}
            onChange={(seconds) => session.setAutoSyncInterval(seconds)}
            options={[15, 30, 60, 120].map((seconds) => ({ value: seconds, label: seconds < 60 ? `${seconds} 秒` : `${seconds / 60} 分钟` }))} />
        )}
        {settings.autoSyncEnabled && !autoSync.authorized && (
          <p className="note-warn">已手动调整，自动对齐已暂停。点击「自动对齐」恢复。</p>
        )}

        <div className="menu-rule" />
        <div className="menu-meta" role="status"><p>两路需有相同视角，可在「画面匹配」设置中调整范围</p>
          <p>{session.frameSyncStatus}</p></div>
        <div className="row-split">
          <button type="button" className="btn-quiet" disabled={busy || !bothReady} onClick={() => void session.measureOnce()}>
            仅测量
          </button>
          {settings.recognitionMode === 'frame-hash' && onOpenFrameSettings && (
            <button type="button" className="btn-quiet" onClick={() => { menu.close(); onOpenFrameSettings() }}>
              调整匹配区域
            </button>
          )}
        </div>

        {result && (
          <p className="menu-meta">
            {result.failure ? <ErrorText error={result.failure} />
              : result.estimate ? `${result.dryRun ? '仅测量，未调整；' : ''}上次测得偏差 ${result.estimate.totalOffsetSeconds.toFixed(2)} 秒`
                : '上次未能测得'}
          </p>
        )}
      </Popover>
    </div>
  )
}

const PHASE: Record<string, string> = {
  sampling: '匹配画面…',
  estimating: '计算中…',
  applying: '调整中…',
  verifying: '复核中…',
}

export function HuyaFallbackPrompt(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const prompt = snapshot.huyaFallbackPrompt
  if (!prompt) return null
  const busy = loader.state[prompt.role].busy || snapshot.qualityBusy[prompt.role]
  return (
    <div className="prompt" role="status" aria-label="切换虎牙官方流提示">
      <span className="prompt-text">当前代理观看较卡，是否切换至虎牙官方流（{prompt.nickname}）？</span>
      <button type="button" className="btn-solid small" disabled={busy}
        onClick={() => {
          session.acceptHuyaFallbackPrompt()
          void loader.loadInput(prompt.role, prompt.url, 'huya')
        }}>切换虎牙官方流</button>
      <button type="button" className="btn-quiet small" disabled={busy}
        onClick={() => session.dismissHuyaFallbackPrompt()}>暂不切换</button>
    </div>
  )
}

export function PlaybackRecoveryPrompt(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const recovery = snapshot.playbackRecovery
  if (!recovery) return null
  const busy = session.autoSync.isRunning || session.offsetBusy
  const ready = snapshot.autoSync.ready
  return (
    <div className="prompt" role="status">
      <span className="prompt-text">{recovery.kind === 'reconnect'
        ? '重新连接后，两路可能错开了'
        : `画面刚卡顿，两路可能错开了约 ${recovery.driftSeconds?.toFixed(1)} 秒`}</span>
      <button type="button" className="btn-quiet small" disabled={busy || !ready}
        onClick={() => startAutoAlign(session)}>重新对齐</button>
    </div>
  )
}
