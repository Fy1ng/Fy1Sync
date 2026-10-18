/**
 * The session: one object owning everything that outlives a React render.
 *
 * `MediaEngine`, `AutoSyncController`, `RecognitionSampler` and the danmaku timeline all
 * hold real resources (video elements, workers, an SSE connection, timers) and all need
 * to survive re-renders and route changes. React holds a reference to this, never the
 * reverse: components read a plain snapshot and call methods.
 *
 * It is also where the sync bookkeeping lives, because manual and automatic sync must
 * agree on one number. `appliedRewind` is the authority: the slider computes a target
 * offset, the planner turns the difference into seeks, and whatever the seeks actually
 * achieved is written back. Automatic sync goes through the same path, so a run cannot
 * claim an alignment the elements did not reach.
 */

import { compileDanmakuFilter, type CompiledDanmakuFilter } from '../core/danmakuFilter'
import { DanmakuTimeline, scheduleTimeFor, type DanmakuMessage } from '../core/danmakuTimeline'
import type { MediaDescriptor } from '../core/types'
import { NO_REWIND, SOURCE_ROLES, type AppliedRewind, type SourceRole } from '../core/types'
import {
  offsetFromRewind,
  planOffsetChange,
  type OffsetPlan,
} from '../core/syncPlan'
import { MediaEngine, type EngineState } from '../media/mediaEngine'
import { RecognitionSampler } from '../recognition/sampler'
import { createRecognitionWorker } from '../recognition/createWorker'
import { parseProfile, type RecognitionProfile } from '../core/profileSchema'
import { AutoSyncController, type AutoSyncPhase, type AutoSyncRunResult } from '../sync/autoSync'
import { apiClient, type PresetSummary } from './apiClient'
import type { AppSettings } from './settings'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings'

/** What a component sees. Plain data, replaced wholesale on every change. */
export interface SessionSnapshot {
  media: EngineState
  settings: AppSettings
  appliedRewind: AppliedRewind
  /** Offset the two sources currently carry, derived from `appliedRewind`. */
  offsetSeconds: number
  /** Offset the slider is showing, which may be ahead of what was achieved. */
  requestedOffsetSeconds: number
  lastPlan: OffsetPlan | null
  autoSync: {
    phase: AutoSyncPhase
    authorized: boolean
    lastResult: AutoSyncRunResult | null
    /** Seconds until the scheduler's next run; null when it is off. */
    nextRunInSeconds: number | null
  }
  /** Which slot each role occupies. Swapping these never remounts an element. */
  mainRole: SourceRole
  playing: boolean
  danmaku: {
    connected: boolean
    room: string | null
    error: string | null
    pending: number
    dropped: number
  }
  profiles: Record<SourceRole, RecognitionProfile | null>
  /** Presets the server offers, so the player can pick one without opening the editor. */
  presets: PresetSummary[]
  notices: Notice[]
}

export interface Notice {
  id: number
  kind: 'info' | 'warn' | 'error'
  text: string
  at: number
}

export interface SessionOptions {
  engine?: MediaEngine
  storage?: Parameters<typeof loadSettings>[0]
  /** Injected so tests can drive the sampler without a real worker. */
  createSampler?: (session: Session) => RecognitionSampler | null
  now?: () => number
}

const MAX_NOTICES = 6

/** Relay states worth surfacing. `connected` is the absence of a problem, so it has no text. */
const DANMAKU_STATE_TEXT: Record<string, string> = {
  idle: '弹幕未连接',
  connecting: '正在连接弹幕服务器',
  reconnecting: '弹幕连接中断，正在重试',
  closed: '弹幕连接已关闭',
}

export class Session {
  readonly engine: MediaEngine
  readonly autoSync: AutoSyncController
  readonly timeline = new DanmakuTimeline()

  private sampler: RecognitionSampler | null = null
  private samplerFactory: ((session: Session) => RecognitionSampler | null) | null
  private settingsValue: AppSettings
  private readonly storage: SessionOptions['storage']
  private readonly now: () => number
  private readonly listeners = new Set<(snapshot: SessionSnapshot) => void>()

  private applied: AppliedRewind = { ...NO_REWIND }
  private requestedOffset = 0
  private planValue: OffsetPlan | null = null
  private mainRoleValue: SourceRole = 'official'
  private playingValue = false
  private noticeSeq = 0
  private noticeList: Notice[] = []
  private profileMap: Record<SourceRole, RecognitionProfile | null> = {
    official: null,
    commentary: null,
  }
  private danmakuState: SessionSnapshot['danmaku'] = {
    connected: false,
    room: null,
    error: null,
    pending: 0,
    dropped: 0,
  }
  private presetList: PresetSummary[] = []
  private danmakuSource: EventSource | null = null
  private filter: CompiledDanmakuFilter
  private schedulerDeadline: number | null = null
  private snapshotValue: SessionSnapshot
  private notifyQueued = false
  private disposed = false

  constructor(options: SessionOptions = {}) {
    this.engine = options.engine ?? new MediaEngine()
    this.storage = options.storage
    this.now = options.now ?? (() => Date.now())
    this.settingsValue = loadSettings(this.storage)
    this.filter = compileDanmakuFilter(this.settingsValue.danmaku.filter)
    this.samplerFactory = options.createSampler ?? defaultSamplerFactory

    this.autoSync = new AutoSyncController(
      {
        sample: (windowMs, onOutcome, signal) => {
          const sampler = this.ensureSampler()
          if (!sampler) return Promise.resolve()
          return sampler.sample(windowMs, onOutcome, signal)
        },
        snapshot: (role) => this.engine.snapshot(role),
        hasProfile: () => SOURCE_ROLES.some((role) => this.profileMap[role] !== null),
        seek: (role, target) => this.engine.seek(role, target),
        now: this.now,
      },
      {
        detectWindowSeconds: this.settingsValue.detectWindowSeconds,
        schedulerIntervalSeconds: this.settingsValue.autoSyncIntervalSeconds,
      },
    )

    this.engine.subscribe(() => this.notify())
    this.autoSync.onPhaseChange(() => this.notify())
    this.snapshotValue = this.buildSnapshot()
    this.applyAudioSettings()
  }

  get snapshot(): SessionSnapshot {
    return this.snapshotValue
  }

  get settings(): AppSettings {
    return this.settingsValue
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Rebuild the snapshot and tell React, at most once per microtask.
   *
   * Media events (`progress`, `timeupdate`) fire several times a second per source; a
   * synchronous notify per event would re-render the whole tree that often.
   */
  private notify(): void {
    if (this.disposed || this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      if (this.disposed) return
      this.snapshotValue = this.buildSnapshot()
      for (const listener of this.listeners) listener(this.snapshotValue)
    })
  }

  /** Force a synchronous rebuild. Used by tests and by imperative flows that must read back. */
  flush(): SessionSnapshot {
    this.snapshotValue = this.buildSnapshot()
    for (const listener of this.listeners) listener(this.snapshotValue)
    return this.snapshotValue
  }

  private buildSnapshot(): SessionSnapshot {
    const stats = this.timeline.stats()
    return {
      media: this.engine.getState(),
      settings: this.settingsValue,
      appliedRewind: { ...this.applied },
      offsetSeconds: offsetFromRewind(this.applied),
      requestedOffsetSeconds: this.requestedOffset,
      lastPlan: this.planValue,
      autoSync: {
        phase: this.autoSync.phase,
        authorized: this.autoSync.autoApplyAuthorized,
        lastResult: this.autoSync.result,
        nextRunInSeconds:
          this.schedulerDeadline === null
            ? null
            : Math.max(0, Math.round((this.schedulerDeadline - this.now()) / 1000)),
      },
      mainRole: this.mainRoleValue,
      playing: this.playingValue,
      danmaku: { ...this.danmakuState, pending: stats.pending, dropped: stats.expired },
      profiles: { ...this.profileMap },
      presets: this.presetList,
      notices: this.noticeList,
    }
  }

  notice(kind: Notice['kind'], text: string): void {
    const entry: Notice = { id: ++this.noticeSeq, kind, text, at: this.now() }
    // Newest first, oldest dropped: the notice strip shows a few lines, not a log.
    this.noticeList = [entry, ...this.noticeList].slice(0, MAX_NOTICES)
    this.notify()
  }

  dismissNotice(id: number): void {
    this.noticeList = this.noticeList.filter((notice) => notice.id !== id)
    this.notify()
  }

  private ensureSampler(): RecognitionSampler | null {
    if (this.sampler || !this.samplerFactory) return this.sampler
    this.sampler = this.samplerFactory(this)
    return this.sampler
  }

  profileFor(role: SourceRole): RecognitionProfile | null {
    return this.profileMap[role]
  }

  setProfile(role: SourceRole, profile: RecognitionProfile | null): void {
    this.profileMap = { ...this.profileMap, [role]: profile }
    this.notify()
  }

  /** Both roles share one countdown profile: it is the same on-screen clock. */
  setProfileForAll(profile: RecognitionProfile | null): void {
    this.profileMap = { official: profile, commentary: profile }
    this.notify()
  }

  /**
   * Select a server preset by id and remember the choice.
   *
   * The editor's 应用到播放器 only reaches an in-memory session, and 返回播放器 is a real
   * navigation that throws that session away — so without a persisted id the player would
   * come up with no profile every time and automatic sync could never run.
   */
  async selectProfile(id: string): Promise<boolean> {
    if (!id) {
      this.updateSettings({ profileId: '' })
      this.setProfileForAll(null)
      return true
    }
    const profile = await this.fetchProfile(id)
    if (!profile) return false
    this.updateSettings({ profileId: id })
    this.setProfileForAll(profile)
    return true
  }

  /**
   * Fetch and re-validate one preset.
   *
   * The server validates on write, but a preset file can be edited by hand between then
   * and now, and a malformed profile would fail inside the recognition worker where there
   * is nowhere useful to report it. `parseProfile` also migrates a v1 file forward.
   */
  private async fetchProfile(id: string): Promise<RecognitionProfile | null> {
    const result = await apiClient.getPreset(id)
    if (!result.ok) {
      this.notice('error', `识别场景 ${id} 载入失败：${result.message}`)
      return null
    }
    const parsed = parseProfile(result.value.profile)
    if (!parsed.profile) {
      const first = parsed.issues.find((issue) => issue.severity === 'error')
      this.notice('error', `识别场景 ${id} 格式无效：${first?.message ?? '未知问题'}`)
      return null
    }
    return parsed.profile
  }

  /**
   * Ask the server which presets exist, for the player's picker.
   *
   * Answers whether the list is now known. `boot` needs that distinction: an empty list
   * and an unanswered request look identical in `presetList`, but only the first one is
   * evidence that a stored preset is gone.
   */
  async refreshPresets(): Promise<boolean> {
    const result = await apiClient.listPresets()
    if (!result.ok) return false
    this.presetList = result.value.presets
    this.notify()
    return true
  }

  /**
   * Startup work that needs the network: list the presets and restore the chosen one.
   *
   * Called once from the player page. A preset that has since been deleted clears the
   * stored id rather than warning about it on every boot — but only when the server
   * actually said so, or restarting while it is down would throw the choice away.
   */
  async boot(): Promise<void> {
    // Before the first await, so re-entering the page resumes on the spot instead of
    // waiting on the network. This is also what restores a *persisted* toggle: settings
    // reload with `autoSyncEnabled: true`, but only `setAutoSyncEnabled` ever armed the
    // timer, so without this the switch read on while nothing was scheduled.
    if (this.settingsValue.autoSyncEnabled) this.startScheduler()
    const listed = await this.refreshPresets()
    const id = this.settingsValue.profileId
    if (!id) return
    if (listed && !this.presetList.some((preset) => preset.id === id)) {
      this.updateSettings({ profileId: '' })
      return
    }
    const profile = await this.fetchProfile(id)
    if (profile) this.setProfileForAll(profile)
  }

  // ---------------------------------------------------------------- settings

  updateSettings(patch: Partial<AppSettings>): void {
    this.settingsValue = { ...this.settingsValue, ...patch }
    saveSettings(this.settingsValue, this.storage)
    this.notify()
  }

  updateDanmakuSettings(patch: Partial<AppSettings['danmaku']>): void {
    const danmaku = { ...this.settingsValue.danmaku, ...patch }
    this.settingsValue = { ...this.settingsValue, danmaku }
    // Recompiling here rather than per frame means a bad regex is reported once, at the
    // moment it is typed, instead of being retried against every message.
    if (patch.filter) this.filter = compileDanmakuFilter(danmaku.filter)
    saveSettings(this.settingsValue, this.storage)
    this.notify()
  }

  get invalidPatterns(): CompiledDanmakuFilter['invalidPatterns'] {
    return this.filter.invalidPatterns
  }

  // ------------------------------------------------------------------- audio

  setVolume(role: SourceRole, volume: number): void {
    this.engine.setVolume(role, volume)
    // Dragging to zero is a mute and raising from zero is an unmute. The engine unmutes on
    // the way up by itself but does not mute on the way down, and the overlay reads its
    // `muted` — so tell it explicitly rather than only recording it, or the icon and the
    // next reload would disagree with the slider.
    this.engine.setMuted(role, volume === 0)
    const volumes = { ...this.settingsValue.volume, [role]: volume }
    const muted = { ...this.settingsValue.muted, [role]: volume === 0 }
    this.updateSettings({ volume: volumes, muted })
  }

  setMuted(role: SourceRole, muted: boolean): void {
    this.engine.setMuted(role, muted)
    this.updateSettings({ muted: { ...this.settingsValue.muted, [role]: muted } })
  }

  /** Push stored volumes into freshly created elements. */
  private applyAudioSettings(): void {
    for (const role of SOURCE_ROLES) {
      this.engine.setVolume(role, this.settingsValue.volume[role])
      this.engine.setMuted(role, this.settingsValue.muted[role])
    }
  }

  // ----------------------------------------------------------------- sources

  async loadSource(role: SourceRole, descriptor: MediaDescriptor): Promise<void> {
    await this.engine.load(role, descriptor)
    const state = this.engine.getState()[role]
    if (state.status === 'error') {
      this.notice('error', `${roleName(role)}加载失败：${state.error?.message ?? '未知错误'}`)
      return
    }
    // A new source starts at its own position, so whatever rewind the old one carried is
    // no longer applied to anything. Keeping the number would make the next plan compute
    // its move from a rewind that does not exist.
    this.applied = { ...this.applied, [role]: 0 }
    this.requestedOffset = offsetFromRewind(this.applied)
    this.autoSync.cancel(false)
    this.notice('info', `${roleName(role)}已载入：${descriptor.label}`)
    this.applyAudioSettings()
    this.notify()
  }

  unloadSource(role: SourceRole): void {
    this.engine.unload(role)
    this.applied = { ...this.applied, [role]: 0 }
    this.requestedOffset = offsetFromRewind(this.applied)
    this.notify()
  }

  swapRoles(): void {
    this.mainRoleValue = this.mainRoleValue === 'official' ? 'commentary' : 'official'
    this.notify()
  }

  setMainRole(role: SourceRole): void {
    if (this.mainRoleValue === role) return
    this.mainRoleValue = role
    this.notify()
  }

  // ---------------------------------------------------------------- playback

  async setPlaying(playing: boolean): Promise<void> {
    this.playingValue = playing
    await this.engine.setPlaying(playing)
    const state = this.engine.getState()
    // An autoplay refusal leaves the element paused; reporting "playing" would leave the
    // button in a state the user cannot correct.
    const stuck = SOURCE_ROLES.filter(
      (role) => state[role].status === 'ready' && state[role].paused,
    )
    if (playing && stuck.length > 0) this.playingValue = false
    this.notify()
  }

  togglePlaying(): Promise<void> {
    return this.setPlaying(!this.playingValue)
  }

  // -------------------------------------------------------------------- sync

  /**
   * Move to an absolute offset.
   *
   * The offset is a target, not an instruction: `planOffsetChange` turns the difference
   * from the currently applied rewind into per-source seeks, each clamped to what that
   * source's buffer can actually absorb. What the seeks achieve is written back, so a
   * clamped rewind leaves `appliedRewind` telling the truth rather than the request.
   */
  async applyOffset(nextOffset: number, options: { fromAuto?: boolean } = {}): Promise<OffsetPlan> {
    if (!options.fromAuto) {
      // Manual input wins over a scheduled run, and revokes its authorization: after a
      // human moves the slider the scheduler must not quietly overwrite that choice.
      this.autoSync.cancel(true)
    }
    this.requestedOffset = nextOffset
    const plan = planOffsetChange({
      nextOffset,
      applied: this.applied,
      snapshots: {
        official: this.engine.snapshot('official') ?? undefined,
        commentary: this.engine.snapshot('commentary') ?? undefined,
      },
    })
    this.planValue = plan

    for (const seek of plan.seeks) {
      const ok = await this.engine.seek(seek.role, seek.to)
      if (!ok) {
        // The element refused or landed elsewhere. Re-read where it truly is instead of
        // trusting the plan's arithmetic.
        const snapshot = this.engine.snapshot(seek.role)
        if (snapshot) {
          this.applied = {
            ...this.applied,
            [seek.role]: Math.max(0, this.applied[seek.role] + (seek.from - snapshot.currentTime)),
          }
        }
        this.notice('warn', `${roleName(seek.role)}未能跳转到目标位置`)
        continue
      }
      this.applied = { ...this.applied, [seek.role]: plan.rewindAfter[seek.role] }
    }

    // Roles the plan did not have to move keep whatever the planner decided for them,
    // which is how a source with nothing loaded gets reset to zero.
    for (const role of SOURCE_ROLES) {
      if (!plan.seeks.some((seek) => seek.role === role)) {
        this.applied = { ...this.applied, [role]: plan.rewindAfter[role] }
      }
    }

    if (plan.limitReason === 'buffer-limit') {
      this.notice('warn', '缓存长度不足，偏移已按可回退范围截断')
    } else if (plan.limitReason === 'not-ready') {
      this.notice('warn', '有源尚未就绪，偏移未完全应用')
    }

    // A rewound commentary source is showing older content, so danmaku parked for the
    // live edge must wait out the difference rather than being expired as stale.
    const commentary = this.engine.snapshot('commentary')
    if (commentary) this.timeline.handleSeek(commentary.currentTime)

    this.notify()
    return plan
  }

  /** Nudge by a step, from the slider's buttons and keyboard. */
  nudgeOffset(delta: number): Promise<OffsetPlan> {
    return this.applyOffset(this.requestedOffset + delta)
  }

  resetOffset(): Promise<OffsetPlan> {
    return this.applyOffset(0)
  }

  // --------------------------------------------------------------- auto sync

  /** Measure only. Allowed even when auto-apply has been revoked. */
  async measureOnce(): Promise<AutoSyncRunResult> {
    const result = await this.autoSync.dryRun(this.applied)
    this.reportAutoResult(result)
    return result
  }

  async syncNow(): Promise<AutoSyncRunResult> {
    this.autoSync.authorize()
    const result = await this.autoSync.run(this.applied)
    if (result.applied) {
      // The controller seeked through the engine, so the engine is authoritative for
      // where the sources ended up.
      this.applied = { ...(result.plan?.rewindAfter ?? this.applied) }
      this.requestedOffset = offsetFromRewind(this.applied)
      this.planValue = result.plan
    }
    this.reportAutoResult(result)
    this.notify()
    return result
  }

  private reportAutoResult(result: AutoSyncRunResult): void {
    if (result.failure) {
      this.notice(result.failure.kind === 'cancelled' ? 'info' : 'warn', result.failure.message)
      return
    }
    const estimate = result.estimate
    if (!estimate) return
    const total = estimate.totalOffsetSeconds.toFixed(2)
    this.notice(
      'info',
      result.dryRun
        ? `识别到目标偏移 ${total} 秒（未应用，实测差 ${estimate.residualSeconds.toFixed(2)} 秒）`
        : `已自动对齐，当前偏移 ${total} 秒`,
    )
  }

  setAutoSyncEnabled(enabled: boolean): void {
    this.updateSettings({ autoSyncEnabled: enabled })
    if (enabled) {
      this.autoSync.authorize()
      this.startScheduler()
    } else {
      this.stopScheduler()
    }
  }

  /** Seconds between scheduled runs. Restarts a running scheduler on the new period. */
  setAutoSyncInterval(seconds: number): void {
    this.updateSettings({ autoSyncIntervalSeconds: seconds })
    this.autoSync.configure({ schedulerIntervalSeconds: seconds })
    if (this.settingsValue.autoSyncEnabled) this.startScheduler()
  }

  /** 2 s or 3 s, per docs/sync-design.md: long enough to catch a tick, short enough to feel live. */
  setDetectWindow(seconds: number): void {
    this.updateSettings({ detectWindowSeconds: seconds })
    this.autoSync.configure({ detectWindowSeconds: seconds })
  }

  /** Abort an in-flight run; the button that calls this is the user's stop control. */
  cancelAutoSync(): void {
    this.autoSync.cancel()
    this.notify()
  }

  private startScheduler(): void {
    this.stopScheduler()
    const intervalMs = this.settingsValue.autoSyncIntervalSeconds * 1000
    this.schedulerDeadline = this.now() + intervalMs
    this.autoSync.startScheduler(() => {
      this.schedulerDeadline = this.now() + intervalMs
      return this.applied
    })
    this.notify()
  }

  private stopScheduler(): void {
    this.autoSync.stopScheduler()
    this.schedulerDeadline = null
    this.notify()
  }

  // ----------------------------------------------------------------- danmaku

  /**
   * Subscribe to a Douyu room through this server's SSE relay.
   *
   * Messages are scheduled against *commentary media time*, not arrival time, so the
   * overlay inherits the sync offset for free: rewind the commentary by 5 s and its
   * danmaku appear 5 s later, still matching what is on screen.
   */
  connectDanmaku(room: string): void {
    this.disconnectDanmaku()
    if (typeof EventSource === 'undefined') {
      this.danmakuState = { ...this.danmakuState, error: '当前环境不支持 SSE' }
      this.notify()
      return
    }
    const source = new EventSource(`/api/danmaku/douyu/${encodeURIComponent(room)}`)
    this.danmakuSource = source
    this.danmakuState = { ...this.danmakuState, room, error: null }

    source.addEventListener('open', () => {
      this.danmakuState = { ...this.danmakuState, connected: true, error: null }
      this.notify()
    })
    // Event name must match `DanmakuRelay.broadcast` on the server; a mismatch here drops
    // every message silently, because an EventSource ignores events nobody listens for.
    source.addEventListener('danmaku', (event) => this.ingestDanmaku(event as MessageEvent<string>))
    source.addEventListener('state', (event) => this.ingestDanmakuState(event as MessageEvent<string>))
    source.addEventListener('error', () => {
      // EventSource reconnects on its own; report the gap without tearing it down.
      this.danmakuState = { ...this.danmakuState, connected: false, error: '弹幕连接中断，正在重试' }
      this.notify()
    })
    this.notify()
  }

  disconnectDanmaku(): void {
    this.danmakuSource?.close()
    this.danmakuSource = null
    this.timeline.clear()
    this.danmakuState = { connected: false, room: null, error: null, pending: 0, dropped: 0 }
    this.notify()
  }

  /** Park one relayed message. Public so tests and the mock generator can feed it. */
  pushDanmaku(message: Pick<DanmakuMessage, 'text' | 'user' | 'color'>): void {
    if (this.filter.reject(message)) return
    const density = this.settingsValue.danmaku.density
    // Sampling on arrival, not on render: a dropped message never occupies a lane, so
    // density behaves as a real load control rather than a visual one.
    if (density < 1 && Math.random() > density) return
    const snapshot = this.engine.snapshot('commentary')
    const scheduleTime = snapshot
      ? scheduleTimeFor(snapshot)
      : this.timeline.playhead
    this.timeline.push({
      id: `d${++this.noticeSeq}`,
      text: message.text,
      user: message.user,
      color: message.color,
      scheduleTime,
      receivedAt: this.now(),
    })
  }

  private ingestDanmaku(event: MessageEvent<string>): void {
    let payload: { text?: unknown; user?: unknown; color?: unknown }
    try {
      payload = JSON.parse(event.data) as typeof payload
    } catch {
      return
    }
    if (typeof payload.text !== 'string' || payload.text.length === 0) return
    this.pushDanmaku({
      text: payload.text,
      user: typeof payload.user === 'string' ? payload.user : '匿名',
      color: typeof payload.color === 'string' ? payload.color : '#ffffff',
    })
  }

  /**
   * The relay's own view of the upstream socket. EventSource's `open` only says the SSE
   * pipe is up, which happens before the server has reached Douyu at all — so a room that
   * never connects would otherwise read as 连接成功 with no messages arriving.
   */
  private ingestDanmakuState(event: MessageEvent<string>): void {
    let payload: { state?: unknown; detail?: unknown }
    try {
      payload = JSON.parse(event.data) as typeof payload
    } catch {
      return
    }
    const state = typeof payload.state === 'string' ? payload.state : ''
    const detail = typeof payload.detail === 'string' ? payload.detail : null
    const connected = state === 'connected'
    this.danmakuState = {
      ...this.danmakuState,
      connected,
      error: connected ? null : (detail ?? DANMAKU_STATE_TEXT[state] ?? this.danmakuState.error),
    }
    this.notify()
  }

  /** Release everything due at the commentary playhead. Called once per animation frame. */
  drainDanmaku(): DanmakuMessage[] {
    const snapshot = this.engine.snapshot('commentary')
    const mediaTime = snapshot?.currentTime ?? this.timeline.playhead
    return this.timeline.advance(mediaTime)
  }

  /**
   * Park the work that runs on its own: the scheduler, an in-flight run, the danmaku relay.
   *
   * This is what leaving the player page calls, and it is deliberately *not* `dispose`.
   * The session outlives any single mount (`main.tsx` owns it), so a component tearing
   * down must not take the media elements with it — after `engine.dispose()` the runtime
   * map is empty and the next `mount` can only throw `unknown role`. Everything stopped
   * here comes back on the next `boot`, so the page can be left and re-entered.
   */
  suspend(): void {
    this.stopScheduler()
    // `false`: leaving the page is not the manual intervention that revokes auto-apply,
    // so coming back must not report 「手动调整过偏移」 the user never made.
    this.autoSync.cancel(false)
    this.disconnectDanmaku()
  }

  /** Tear the session down for good. Only its owner may call this. */
  dispose(): void {
    this.disposed = true
    this.stopScheduler()
    this.disconnectDanmaku()
    this.autoSync.dispose()
    this.sampler?.dispose()
    this.engine.dispose()
    this.listeners.clear()
  }
}

/**
 * The real sampler: one worker per role, reading the engine's own elements.
 *
 * `video` resolves at sample time rather than being captured, so a source swapped
 * between runs is picked up without rebuilding the sampler.
 */
function defaultSamplerFactory(session: Session): RecognitionSampler | null {
  if (typeof Worker === 'undefined') return null
  return new RecognitionSampler({
    createWorker: createRecognitionWorker,
    video: (role) => session.engine.element(role),
    profile: (role) => session.profileFor(role),
    onError: (role, message) => session.notice('warn', `${roleName(role)}识别线程错误：${message}`),
  })
}

export function roleName(role: SourceRole): string {
  return role === 'official' ? '官方画面' : '国内解说'
}

/** Re-exported so components do not each import from three modules. */
export { SOURCE_ROLES, DEFAULT_SETTINGS, saveSettings, planOffsetChange, scheduleTimeFor }
export type { AppliedRewind, DanmakuMessage, MediaDescriptor, SourceRole }
