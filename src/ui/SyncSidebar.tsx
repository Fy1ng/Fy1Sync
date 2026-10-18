/**
 * The sync sidebar: the only place sync state is shown.
 *
 * docs/ui-layout.md is explicit that the player overlay stays about playback and sync
 * lives here. The manual slider spans -60…+60 s and applies live while dragging; holding
 * the fine-control modifier switches it from 0.5 s to 0.05 s steps. Not every keyboard
 * layout makes a modifier convenient, so a fallback button pins the fine grid on.
 *
 * The two numbers below the slider are different on purpose. "目标" is what the slider
 * asks for; "实际" is what the elements achieved. They diverge when a source runs out of
 * rewind head-room, and hiding that would let the UI claim an alignment that does not
 * exist.
 */

import { useEffect, useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { useModifierHeld } from '../app/hooks'
import { roleName } from '../app/session'
import {
  COARSE_STEP_SECONDS,
  FINE_STEP_SECONDS,
  MAX_OFFSET_SECONDS,
  SOURCE_ROLES,
} from '../core/types'
import { availableRewind, describeOffset, isAligned, snapOffset } from '../core/syncPlan'
import { AUTO_SYNC_PHASE_TEXT } from '../sync/autoSync'
import { DropUp } from './controls/DropUp'
import { Slider } from './controls/Slider'
import { Toggle } from './controls/Toggle'

export function SyncSidebar(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const { settings } = snapshot
  const modifierHeld = useModifierHeld(settings.fineKey)
  const fine = modifierHeld || settings.forceFineStep
  const step = fine ? FINE_STEP_SECONDS : COARSE_STEP_SECONDS

  // Local while dragging: the slider must stay where the pointer is even if a seek is
  // still settling, otherwise the thumb fights the user.
  const [draft, setDraft] = useState<number | null>(null)
  useEffect(() => setDraft(null), [snapshot.requestedOffsetSeconds])
  const shown = draft ?? snapshot.requestedOffsetSeconds

  const aligned = isAligned(snapshot.offsetSeconds)
  const drift = snapshot.requestedOffsetSeconds - snapshot.offsetSeconds

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h2>时间同步</h2>
        <button
          type="button"
          className="ghost small"
          onClick={() => session.updateSettings({ sidebarVisible: false })}
        >
          收起
        </button>
      </header>

      <section className="sync-status" aria-live="polite">
        <div className={`status-pill ${aligned ? 'is-aligned' : 'is-off'}`}>
          {describeOffset(snapshot.offsetSeconds)}
        </div>
        <dl className="status-grid">
          <div>
            <dt>目标偏移</dt>
            <dd>{snapshot.requestedOffsetSeconds.toFixed(2)} s</dd>
          </div>
          <div>
            <dt>实际偏移</dt>
            <dd>{snapshot.offsetSeconds.toFixed(2)} s</dd>
          </div>
        </dl>
        {Math.abs(drift) > 0.05 && (
          <p className="status-warning">
            还差 {drift.toFixed(2)} s 未能应用，通常是片源可回退的缓冲不够。
          </p>
        )}
      </section>

      <section className="sync-manual">
        <Slider
          label={`手动偏移${fine ? '（精调 0.05s）' : '（0.5s）'}`}
          value={shown}
          min={-MAX_OFFSET_SECONDS}
          max={MAX_OFFSET_SECONDS}
          step={step}
          formatValue={(value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)} s`}
          onInput={(value) => {
            const snapped = snapOffset(value, step)
            setDraft(snapped)
            // Live application while dragging, per the spec. Each call supersedes the
            // previous plan, so intermediate values cost a cancelled seek at most.
            void session.applyOffset(snapped)
          }}
          onSettle={(value) => void session.applyOffset(snapOffset(value, step))}
        />
        <div className="nudge-row">
          <button type="button" onClick={() => void session.nudgeOffset(-step)}>
            −{step}s
          </button>
          <button type="button" onClick={() => void session.nudgeOffset(step)}>
            +{step}s
          </button>
          <button type="button" className="ghost" onClick={() => void session.resetOffset()}>
            归零
          </button>
        </div>
        <Toggle
          label="始终使用精调步长"
          hint={`按住 ${FINE_KEY_TEXT[settings.fineKey]} 也可临时精调`}
          checked={settings.forceFineStep}
          onChange={(checked) => session.updateSettings({ forceFineStep: checked })}
        />
        <DropUp
          label="精调按键"
          align="left"
          value={settings.fineKey}
          options={[
            { value: 'shift', label: 'Shift' },
            { value: 'alt', label: 'Alt' },
            { value: 'ctrl', label: 'Ctrl' },
          ]}
          onChange={(value) => session.updateSettings({ fineKey: value })}
        />
        <p className="hint">
          正值表示官方画面回退，负值表示解说回退。两边都不会快进 —— 直播只能往回走。
        </p>
      </section>

      <section className="sync-headroom">
        <h3>可回退余量</h3>
        <ul>
          {SOURCE_ROLES.map((role) => {
            const media = snapshot.media[role]
            const snap = session.engine.snapshot(role)
            const room = snap ? availableRewind(snap) : 0
            return (
              <li key={role}>
                <span>{roleName(role)}</span>
                <span className={room < 5 ? 'is-tight' : ''}>
                  {media.timebase ? `${room.toFixed(1)} s` : '未加载'}
                </span>
                <span className="headroom-applied">已回退 {snapshot.appliedRewind[role].toFixed(2)} s</span>
              </li>
            )
          })}
          {/*
            docs/ui-layout.md counts the danmaku backlog as cache state alongside the two
            streams. It belongs next to them: when the official picture is rewound, danmaku
            wait in the timeline for their moment, so a growing queue is the offset working
            rather than a stall. Only shown while connected — a zero from a closed
            connection would read as "no danmaku arriving", which is a different problem.
          */}
          {snapshot.danmaku.connected && (
            <li>
              <span>弹幕队列</span>
              <span>{snapshot.danmaku.pending} 条待显示</span>
              {snapshot.danmaku.dropped > 0 && (
                <span className="headroom-applied">已过期 {snapshot.danmaku.dropped} 条</span>
              )}
            </li>
          )}
        </ul>
      </section>

      <AutoSyncSection />
    </aside>
  )
}

const FINE_KEY_TEXT = { shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl' } as const

function AutoSyncSection(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const { autoSync, settings } = snapshot
  const busy = autoSync.phase !== 'idle' && autoSync.phase !== 'done' && autoSync.phase !== 'failed'
  const profileReady = snapshot.profiles.official !== null || snapshot.profiles.commentary !== null

  return (
    <section className="auto-sync">
      <h3>自动同步</h3>
      <div className={`auto-phase phase-${autoSync.phase}`} aria-live="polite">
        {AUTO_SYNC_PHASE_TEXT[autoSync.phase]}
      </div>

      <DropUp
        label="识别场景"
        align="left"
        value={settings.profileId}
        disabled={snapshot.presets.length === 0}
        title={snapshot.presets.length === 0 ? '本机还没有已发布的识别场景' : undefined}
        options={[
          { value: '', label: '不使用' },
          ...snapshot.presets.map((preset) => ({
            value: preset.id,
            label: preset.name,
            // A preset with no templates parses and saves fine but recognises nothing, so
            // say so here rather than letting a run fail with no digits.
            hint: preset.templateChars > 0 ? `${preset.templateChars} 字形` : '缺模板',
            disabled: preset.templateChars === 0,
          })),
        ]}
        onChange={(id) => void session.selectProfile(id)}
      />

      {!profileReady && (
        <p className="hint">
          {snapshot.presets.length === 0 ? (
            <>
              尚未选择识别场景。到 <a href="/admin">场景配置器</a> 建好模板后即可识别倒计时。
            </>
          ) : (
            '选择上面的识别场景后即可识别倒计时。'
          )}
        </p>
      )}

      {autoSync.lastResult?.failure && (
        // Also posted as a notice, but the notice strip is dismissible and transient —
        // the reason a run failed belongs next to the button that failed.
        <p className="auto-failure">{autoSync.lastResult.failure.message}</p>
      )}

      {autoSync.lastResult && (
        <dl className="status-grid">
          <div>
            <dt>识别偏移</dt>
            <dd>
              {autoSync.lastResult.estimate
                ? `${autoSync.lastResult.estimate.totalOffsetSeconds.toFixed(2)} s`
                : '—'}
            </dd>
          </div>
          <div>
            <dt>识别到跳变</dt>
            <dd>
              官方 {autoSync.lastResult.jumps.official} / 解说{' '}
              {autoSync.lastResult.jumps.commentary}
            </dd>
          </div>
          {autoSync.lastResult.divergence !== null && (
            <div>
              <dt>校验残差</dt>
              <dd>{autoSync.lastResult.divergence.toFixed(2)} s</dd>
            </div>
          )}
        </dl>
      )}

      <div className="auto-actions">
        <button type="button" disabled={busy} onClick={() => void session.measureOnce()}>
          仅识别
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void session.syncNow()}>
          立即同步
        </button>
        {busy && (
          <button type="button" className="ghost" onClick={() => session.cancelAutoSync()}>
            取消
          </button>
        )}
      </div>

      <Toggle
        label="定时自动同步"
        hint={
          autoSync.nextRunInSeconds !== null
            ? `下次约 ${Math.max(0, Math.round(autoSync.nextRunInSeconds))} 秒后`
            : '关闭时只在你点击时识别'
        }
        checked={settings.autoSyncEnabled}
        onChange={(checked) => session.setAutoSyncEnabled(checked)}
      />

      <DropUp
        label="同步间隔"
        align="left"
        value={settings.autoSyncIntervalSeconds}
        options={[15, 30, 60, 120].map((seconds) => ({ value: seconds, label: `${seconds} 秒` }))}
        onChange={(seconds) => session.setAutoSyncInterval(seconds)}
      />

      <DropUp
        label="识别窗口"
        align="left"
        value={settings.detectWindowSeconds}
        options={[
          { value: 2, label: '2 秒', hint: '更快' },
          { value: 3, label: '3 秒', hint: '更稳' },
        ]}
        onChange={(seconds) => session.setDetectWindow(seconds)}
      />

      {!autoSync.authorized && (
        <p className="hint">手动调整过偏移，定时同步已暂停。点“立即同步”可重新授权。</p>
      )}
    </section>
  )
}
