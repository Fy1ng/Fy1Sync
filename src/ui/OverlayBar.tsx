/**
 * The bottom overlay bar.
 *
 * Layout follows docs/ui-layout.md: play/pause and both volumes on the left, progress and
 * position in the middle, quality and danmaku controls on the right. Sync status is
 * deliberately absent — that lives only in the sidebar, so the bar stays about playback.
 */

import { useEffect, useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { seekableRange } from '../core/syncPlan'
import { DropUp } from './controls/DropUp'
import type { DropUpOption } from './controls/DropUp'
import type { SourceRole } from '../core/types'
import { bufferStatusText } from './bufferStatus'
import type { CameraControls } from '../app/useCamera'

interface Props {
  visible: boolean
  onPin: (pinned: boolean) => void
  fullscreenActive: boolean
  onToggleFullscreen: () => void
  onOpenDanmakuSettings: () => void
  camera: CameraControls
  onFrameCamera: () => void
  /**
   * The player measures the bar to work out how much of the stage bottom it covers. A plain
   * prop rather than `forwardRef` — React 19 passes `ref` through to function components on
   * its own, and naming it makes it obvious at the call site why the ref exists.
   */
  ref?: React.Ref<HTMLDivElement>
}

export function OverlayBar({
  visible,
  onPin,
  fullscreenActive,
  onToggleFullscreen,
  onOpenDanmakuSettings,
  camera,
  onFrameCamera,
  ref,
}: Props): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const main = snapshot.media[snapshot.mainRole]
  const { danmaku } = snapshot.settings

  // `quality` already leads with 自动; annotate it with whatever ABR actually picked.
  const autoLabel = main.quality.find((option) => option.level === main.autoLevel)?.label
  const levelOptions: DropUpOption<number>[] = main.quality.map((option) => ({
    value: option.level,
    label: option.label,
    hint: option.level === -1 ? (autoLabel ? `当前 ${autoLabel}` : undefined) : option.detail,
  }))

  return (
    <div
      ref={ref}
      className={`overlay-bar ${visible ? 'is-visible' : ''}`.trim()}
      onFocusCapture={() => onPin(true)}
      onBlurCapture={(event) => {
        // Keep the bar open only while focus is genuinely still inside it.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onPin(false)
      }}
    >
      <div className="overlay-left">
        <button
          type="button"
          className="play-button"
          onClick={() => void session.togglePlaying()}
          aria-label={snapshot.playing ? '暂停' : '播放'}
        >
          {snapshot.playing ? '❚❚' : '▶'}
        </button>
        <VolumeControl role="official" />
        <VolumeControl role="commentary" />
      </div>

      <ProgressBar />

      <div className="overlay-right">
        {(['official', 'commentary'] as const).map((role) => {
          const descriptor = snapshot.media[role].descriptor
          if (!descriptor?.sourceQualities?.length) return null
          return <DropUp key={role} label={role === 'official' ? '官方画质' : '解说画质'}
            value={descriptor.sourceQuality ?? ''}
            options={descriptor.sourceQualities.map((option) => ({ value: option.id, label: option.label }))}
            onChange={(quality) => void session.changeSourceQuality(role, quality)}
            disabled={snapshot.qualityBusy[role]} />
        })}
        {snapshot.buffers[snapshot.mainRole] && <span className="hint" role="status">
          {bufferStatusText(snapshot.buffers[snapshot.mainRole]!)}
        </span>}
        {!main.descriptor?.sourceQualities?.length &&
        <DropUp
          label="画质"
          value={main.level}
          options={levelOptions}
          onChange={(level) => session.engine.setLevel(snapshot.mainRole, level)}
          disabled={main.quality.length <= 1}
          title={main.quality.length <= 1 ? '当前片源没有可选画质' : undefined}
        />
        }
        {/*
          The camera crop comes from the commentary picture, so it follows that stream's
          quality (解说画质) rather than having one of its own. The menu turns it on or off and
          opens the framing dialog; the window itself is dragged on the stage.
        */}
        <DropUp
          label="摄像头"
          value={camera.config ? (camera.config.enabled ? 'on' : 'off') : 'none'}
          options={camera.config
            ? [
                { value: 'on', label: '显示小窗' },
                { value: 'off', label: '隐藏小窗' },
                { value: 'frame', label: '重新取景…' },
              ]
            : [
                { value: 'none', label: '未设置', disabled: true },
                { value: 'frame', label: '框选摄像头…' },
              ]}
          onChange={(value) => {
            if (value === 'frame') onFrameCamera()
            else if (value === 'on' || value === 'off') camera.setEnabled(value === 'on')
          }}
          disabled={!camera.available}
          title={camera.available ? undefined : '加载解说源后可以框选主播摄像头'}
        />
        <button
          type="button"
          className={`icon-button ${danmaku.enabled ? 'is-on' : ''}`.trim()}
          onClick={() => session.updateDanmakuSettings({ enabled: !danmaku.enabled })}
          aria-pressed={danmaku.enabled}
        >
          弹幕{danmaku.enabled ? '开' : '关'}
        </button>
        <button type="button" className="icon-button" onClick={onOpenDanmakuSettings}>
          弹幕设置
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onToggleFullscreen}
          aria-pressed={fullscreenActive}
        >
          {fullscreenActive ? '退出全屏' : '全屏'}
        </button>
      </div>
    </div>
  )
}

function VolumeControl({ role }: { role: SourceRole }): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const state = snapshot.media[role]
  const label = role === 'official' ? '官方' : '解说'

  return (
    <div className="volume-control">
      <button
        type="button"
        className="volume-icon"
        onClick={() => session.setMuted(role, !state.muted)}
        aria-label={`${label}${state.muted ? '取消静音' : '静音'}`}
      >
        {state.muted || state.volume === 0 ? '🔇' : '🔊'}
        <span className="volume-tag">{label}</span>
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={state.muted ? 0 : state.volume}
        aria-label={`${label}音量`}
        onChange={(event) => session.setVolume(role, Number(event.target.value))}
      />
    </div>
  )
}

/**
 * Progress and buffer for the main source.
 *
 * A live stream's meaningful axis is its seekable window, not `0..duration`, so the bar is
 * drawn against `timebase.seekableStart..seekableEnd` and the readout shows the distance
 * behind the live edge. Dragging is a plain seek — it is not sync, and it deliberately
 * bypasses the offset bookkeeping, which is why the session is not involved.
 */
function ProgressBar(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const role = snapshot.mainRole
  const state = snapshot.media[role]
  const timebase = state.timebase
  const [dragValue, setDragValue] = useState<number | null>(null)

  useEffect(() => setDragValue(null), [role])

  if (!timebase) {
    return <div className="overlay-middle is-empty">未加载片源</div>
  }

  const range = seekableRange(timebase)
  const start = range.start
  const end = Math.max(range.end, start + 0.1)
  const position = dragValue ?? state.currentTime
  const behindLive = Math.max(0, end - state.currentTime)

  return (
    <div className="overlay-middle">
      <div className="progress-track">
        <div
          className="progress-buffer"
          style={{ width: `${percent(start, end, state.bufferedEnd)}%` }}
          aria-hidden="true"
        />
        <div
          className="progress-played"
          style={{ width: `${percent(start, end, position)}%` }}
          aria-hidden="true"
        />
        <input
          type="range"
          min={start}
          max={end}
          step={0.1}
          value={position}
          aria-label="播放进度"
          onChange={(event) => setDragValue(Number(event.target.value))}
          onPointerUp={(event) => {
            void session.engine.seek(role, Number(event.currentTarget.value))
            setDragValue(null)
          }}
          onKeyUp={(event) => {
            void session.engine.seek(role, Number(event.currentTarget.value))
            setDragValue(null)
          }}
        />
      </div>
      <div className="progress-readout">
        <span>{formatClock(position - start)}</span>
        {state.isLive ? (
          <button
            type="button"
            className={`live-button ${behindLive < 2 ? 'is-live' : ''}`.trim()}
            onClick={() => session.engine.seekToLive(role)}
          >
            {behindLive < 2 ? '直播中' : `落后 ${behindLive.toFixed(1)}s`}
          </button>
        ) : (
          <span>{formatClock(end - start)}</span>
        )}
      </div>
    </div>
  )
}

function percent(start: number, end: number, value: number): number {
  if (end <= start) return 0
  return Math.min(100, Math.max(0, ((value - start) / (end - start)) * 100))
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`
}
