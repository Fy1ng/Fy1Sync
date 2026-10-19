/**
 * The sync sidebar: the only place sync state is shown.
 *
 * docs/ui-layout.md is explicit that the player overlay stays about playback and sync
 * lives here. Manual adjustment is a row of step buttons around an editable readout (see
 * ManualOffsetControls); the step sizes are settings.
 *
 * The two numbers in the status card are different on purpose. "目标" is what the user
 * asked for; "实际" is what the elements achieved. They diverge when a source runs out of
 * rewind head-room, and hiding that would let the UI claim an alignment that does not
 * exist.
 */

import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { roleName } from '../app/session'
import { SOURCE_ROLES } from '../core/types'
import { availableRewind, describeOffset, isAligned } from '../core/syncPlan'
import { AUTO_SYNC_PHASE_TEXT } from '../sync/autoSync'
import { DropUp } from './controls/DropUp'
import { ManualOffsetControls } from './controls/ManualOffsetControls'
import { formatStep } from './controls/manualOffset'
import { Toggle } from './controls/Toggle'
import { AutoProfileCards } from './AutoProfileCards'

export function SyncSidebar(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const { settings } = snapshot

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

      <section className="sync-manual" aria-label="手动调整">
        <ManualOffsetControls
          value={snapshot.requestedOffsetSeconds}
          smallStep={settings.smallStepSeconds}
          largeStep={settings.largeStepSeconds}
          onChange={(offset) => void session.applyOffset(offset)}
          onReset={() => void session.resetOffset()}
        />
        <div className="step-settings">
          <DropUp
            label="小步长"
            align="left"
            value={settings.smallStepSeconds}
            options={stepOptions(SMALL_STEP_CHOICES, settings.smallStepSeconds)}
            onChange={(seconds) => session.updateSettings({
              smallStepSeconds: seconds,
              largeStepSeconds: Math.max(seconds, settings.largeStepSeconds),
            })}
          />
          <DropUp
            label="大步长"
            align="left"
            value={settings.largeStepSeconds}
            options={stepOptions(LARGE_STEP_CHOICES, settings.largeStepSeconds)
              .map((option) => ({ ...option, disabled: option.value < settings.smallStepSeconds }))}
            onChange={(seconds) => session.updateSettings({ largeStepSeconds: seconds })}
          />
        </div>
        <p className="hint">按住按钮连续调整，点中间数值可直接输入。</p>
        <p className="shortcut-row" aria-label="快捷键：方括号左右调整，加 Shift 用大步长，反斜杠归零">
          <span><kbd>[</kbd><kbd>]</kbd> 小步长</span>
          <span><kbd>Shift</kbd>+<kbd>[</kbd><kbd>]</kbd> 大步长</span>
          <span><kbd>\</kbd> 归零</span>
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

const SMALL_STEP_CHOICES = [0.05, 0.1, 0.25, 0.5, 1]
const LARGE_STEP_CHOICES = [1, 2, 5, 10, 15, 30]

/** The offered choices, plus the stored value if it came from an older build. */
function stepOptions(choices: number[], current: number): { value: number; label: string }[] {
  const values = choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b)
  return values.map((seconds) => ({ value: seconds, label: formatStep(seconds) }))
}

function AutoSyncSection(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const { autoSync, settings } = snapshot
  const busy = snapshot.autoProfileBusy || (autoSync.phase !== 'idle' && autoSync.phase !== 'done' && autoSync.phase !== 'failed')
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
          点击立即同步或仅识别, 将为两路分别定位并学习倒计时. 也可选择已有场景或到 <a href="/admin">场景配置器</a> 手动编辑.
        </p>
      )}

      <AutoProfileCards />

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

      <DropUp
        label="跳转阈值"
        align="left"
        value={settings.seekThresholdSeconds}
        options={[1, 1.5, 2].map(seconds => ({ value: seconds, label: `${seconds} 秒` }))}
        onChange={seconds => session.setSeekThreshold(seconds)}
      />

      {!autoSync.authorized && (
        <p className="hint">手动调整过偏移，定时同步已暂停。点“立即同步”可重新授权。</p>
      )}
    </section>
  )
}
