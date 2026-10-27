/**
 * The session: one object owning everything that outlives a React render.
 *
 * `MediaEngine`, `AutoSyncController`, `RecognitionSampler` and the danmaku timeline all
 * hold real resources (video elements, workers, an IPC subscription, timers) and all need
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
import { DanmakuTimeline, LiveEdgeClock, scheduleTimeFor, type DanmakuMessage } from '../core/danmakuTimeline'
import type { MediaDescriptor } from '../core/types'
import { MIN_SYNC_CONFIDENCE, NO_REWIND, SOURCE_ROLES, type AppliedRewind, type SourceRole } from '../core/types'
import {
  offsetFromRewind,
  planOffsetChange,
  type OffsetPlan,
} from '../core/syncPlan'
import { MediaEngine, type EngineState } from '../media/mediaEngine'
import { RecognitionSampler } from '../recognition/sampler'
import { OnlineAutoProfiles, initialAutoProfileState, type AutoProfileState } from '../recognition/autoProfile'
import { createRecognitionWorker } from '../recognition/createWorker'
import { parseProfile, type RecognitionProfile } from '../core/profileSchema'
import { AutoSyncController, type AutoSyncPhase, type AutoSyncRunResult } from '../sync/autoSync'
import { apiClient, type PresetSummary } from './apiClient'
import type { AppSettings } from './settings'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings'
import type { BufferState } from '../../electron/bufferManager'
import { colorForIndex, type ChatMessage } from '../../server/danmaku/douyuProtocol'
import { normalizeDouyuGift, normalizeDouyuSender } from '../core/douyuMetadata'
import { DanmakuProcessor, DEFAULT_DANMAKU_PREFERENCES, readDanmakuPreferences, type DanmakuPreferences } from '../core/danmakuProcessing'
import { clampSeek } from '../media/timebase'
import { latestPlayableTime } from '../media/playbackControls'

/** Released danmaku kept for the chat list. */
export const CHAT_HISTORY_LIMIT = 2000

/** What a component sees. Plain data, replaced wholesale on every change. */
export interface SessionSnapshot {
  media: EngineState
  settings: AppSettings
  danmakuPreferences: DanmakuPreferences
  pipPresentationReduced: boolean
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
  autoProfiles: Record<SourceRole, AutoProfileState>
  autoProfileBusy: boolean
  /** Presets the server offers, so the player can pick one without opening the editor. */
  presets: PresetSummary[]
  notices: Notice[]
  buffers: Record<SourceRole, BufferState | null>
  qualityBusy: Record<SourceRole, boolean>
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
  createAutoProfiles?: (options: ConstructorParameters<typeof OnlineAutoProfiles>[0]) => Pick<OnlineAutoProfiles, 'controller' | 'monitor' | 'reset' | 'suspend' | 'dispose'> | null
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
  private readonly liveEdge = new LiveEdgeClock()
  private pausedClock: { media: number; wall: number } | null = null

  private sampler: RecognitionSampler | null = null
  private autoProfiles: Pick<OnlineAutoProfiles, 'controller' | 'monitor' | 'reset' | 'suspend' | 'dispose'> | null = null
  private autoRequestRevision = 0
  private candidateToEdit: RecognitionProfile | null = null
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
  /** The danmaku room `suspend` disconnected, for `boot` to reconnect. */
  private parkedDanmakuRoom: string | null = null
  private noticeSeq = 0
  private noticeList: Notice[] = []
  private bufferStates: Record<SourceRole, BufferState | null> = { official: null, commentary: null }
  private qualityBusy: Record<SourceRole, boolean> = { official: false, commentary: false }
  private sourceGeneration: Record<SourceRole, number> = { official: 0, commentary: 0 }
  private profileRevision = 0
  private offsetBoundary = 0
  private offsetDrain: Promise<void> | null = null
  private pendingOffset: { target: number; boundary: number; finish: Array<(plan: OffsetPlan) => void>; fail: Array<(error: unknown) => void> } | null = null
  private automaticSeek: { done: Promise<boolean>; capture: () => void } | null = null
  private interruptedAutomaticSeek: typeof this.automaticSeek = null
  private releaseBuffer: (() => void) | undefined
  private releaseFeatures: (() => void) | undefined
  private danmakuPreferences: DanmakuPreferences = { ...DEFAULT_DANMAKU_PREFERENCES }
  private readonly danmakuProcessor = new DanmakuProcessor()
  private playbackDrain: Promise<unknown> = Promise.resolve()
  private playbackPending = 0
  private pipPresentationReduced = false
  private readonly pendingQualityWaits = new Set<() => void>()
  private profileMap: Record<SourceRole, RecognitionProfile | null> = {
    official: null,
    commentary: null,
  }
  private chatLog: DanmakuMessage[] = []
  private chatTotal = 0
  private readonly chatListeners = new Set<() => void>()
  private danmakuState: SessionSnapshot['danmaku'] = {
    connected: false,
    room: null,
    error: null,
    pending: 0,
    dropped: 0,
  }
  private presetList: PresetSummary[] = []
  private unsubscribeDanmaku: (() => void) | null = null
  private danmakuGeneration = 0
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
    if (options.createAutoProfiles || (typeof Worker !== 'undefined' && !options.createSampler)) {
      const autoOptions: ConstructorParameters<typeof OnlineAutoProfiles>[0] = {
        createWorker: createRecognitionWorker,
        video: role => this.engine.element(role),
        profile: role => this.profileFor(role),
        use: (role, profile) => {
          ++this.profileRevision
          this.profileMap = { ...this.profileMap, [role]: profile }
          this.notify()
        },
        changed: () => this.notify(),
      }
      this.autoProfiles = options.createAutoProfiles ? options.createAutoProfiles(autoOptions) : new OnlineAutoProfiles(autoOptions)
    }

    this.autoSync = new AutoSyncController(
      {
        sample: async (windowMs, onOutcome, signal) => {
          const sampler = this.ensureSampler()
          if (!sampler) return
          if (this.autoProfiles) {
            const acquired = await allAccepted(SOURCE_ROLES.map(role => this.profileFor(role)
              ? Promise.resolve(true) : this.autoProfiles!.controller.acquire(role)))
            if (signal.aborted || !acquired) return
          }
          const read = { official: false, commentary: false }
          const buffered: Array<Parameters<typeof onOutcome>> = []
          await sampler.sample(windowMs, (role, outcome) => {
            if (outcome.status === 'success' && outcome.reading.confidence >= MIN_SYNC_CONFIDENCE) read[role] = true
            buffered.push([role, outcome])
          }, signal)
          if (signal.aborted) return
          if (!this.autoProfiles) { for (const outcome of buffered) onOutcome(...outcome); return }
          const lost = SOURCE_ROLES.filter(role => !read[role])
          if (lost.length) {
            const acquired = await allAccepted(lost.map(role => this.autoProfiles!.controller.acquire(role)))
            if (!signal.aborted && acquired) await sampler.sample(windowMs, onOutcome, signal)
          } else for (const outcome of buffered) onOutcome(...outcome)
        },
        snapshot: (role) => this.engine.snapshot(role),
        hasProfile: () => this.autoProfiles !== null || SOURCE_ROLES.some((role) => this.profileMap[role] !== null),
        seek: (role, target) => {
          const capture = this.captureSeekMovement(role)
          const seek = { done: this.engine.seek(role, target), capture }
          this.automaticSeek = seek
          return seek.done.finally(() => { if (this.automaticSeek === seek) this.automaticSeek = null })
        },
        setPlaybackRate: (role, rate) => { this.engine.element(role).playbackRate = rate },
        onAppliedRewind: rewind => {
          this.applied = { ...rewind }
          this.requestedOffset = offsetFromRewind(rewind)
          this.notify()
        },
        now: this.now,
      },
      {
        detectWindowSeconds: this.settingsValue.detectWindowSeconds,
        schedulerIntervalSeconds: this.settingsValue.autoSyncIntervalSeconds,
        seekThresholdSeconds: this.settingsValue.seekThresholdSeconds,
      },
    )

    this.engine.subscribe(() => this.notify())
    this.releaseBuffer = apiClient.subscribeBuffer((state) => {
      if (state.role !== 'official' && state.role !== 'commentary') return
      const previousNotice = this.bufferStates[state.role]?.notice
      const notice = state.notice
      if (notice?.code === 'youtube-adaptive-fallback'
        && (previousNotice?.code !== notice.code || previousNotice.fromHeight !== notice.fromHeight
          || previousNotice.toHeight !== notice.toHeight)) {
        this.notice('warn', `${notice.fromHeight}p 取流失败, 已回退到 ${notice.toHeight}p`)
      }
      this.bufferStates = { ...this.bufferStates, [state.role]: state }
      this.notify()
    })
    this.autoSync.onPhaseChange(phase => {
      const result = this.autoSync.result
      if ((phase === 'done' || phase === 'failed') && result?.plan && result.appliedRewind && result.failure?.kind !== 'cancelled') {
        this.planValue = result.plan
        this.requestedOffset = result.failure?.kind === 'buffer-limit' && result.estimate
          ? result.estimate.totalOffsetSeconds : offsetFromRewind(this.applied)
      }
      this.notify()
    })
    this.snapshotValue = this.buildSnapshot()
    this.applyAudioSettings()
    this.releaseFeatures = apiClient.subscribeFeatures(event => {
      if (event.topic === 'danmaku-preferences' && event.data && typeof event.data === 'object') {
        this.configureDanmakuProcessing((event.data as { preferences?: unknown }).preferences)
      } else if (event.topic === 'pip' && event.data && typeof event.data === 'object') {
        const value = event.data as { phase?: string; options?: { lowPower?: boolean } }
        this.setPresentationReduced(value.phase === 'ready' && value.options?.lowPower === true)
      }
    })
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
    const media = this.engine.getState()
    for (const role of SOURCE_ROLES) {
      const descriptor = this.sourceDescriptor(role)
      if (descriptor !== media[role].descriptor) media[role] = { ...media[role], descriptor }
    }
    return {
      media,
      settings: this.settingsValue,
      danmakuPreferences: { ...this.danmakuPreferences },
      pipPresentationReduced: this.pipPresentationReduced,
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
      autoProfiles: {
        official: this.autoProfiles?.controller.state('official') ?? initialAutoProfileState(),
        commentary: this.autoProfiles?.controller.state('commentary') ?? initialAutoProfileState(),
      },
      autoProfileBusy: this.autoProfiles?.controller.busy ?? false,
      presets: this.presetList,
      notices: this.noticeList,
      buffers: { ...this.bufferStates },
      qualityBusy: { ...this.qualityBusy },
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
    ++this.profileRevision
    ++this.autoRequestRevision
    this.autoSync.cancel(false)
    this.autoProfiles?.reset(role)
    this.profileMap = { ...this.profileMap, [role]: profile }
    this.autoProfiles?.monitor(role)
    this.notify()
  }

  /** Both roles share one countdown profile: it is the same on-screen clock. */
  setProfileForAll(profile: RecognitionProfile | null): void {
    ++this.profileRevision
    ++this.autoRequestRevision
    this.autoSync.cancel(false)
    for (const role of SOURCE_ROLES) this.autoProfiles?.reset(role)
    this.profileMap = { official: profile, commentary: profile }
    for (const role of SOURCE_ROLES) this.autoProfiles?.monitor(role)
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
    const revision = ++this.profileRevision
    if (!id) {
      this.updateSettings({ profileId: '' })
      this.setProfileForAll(null)
      return true
    }
    const profile = await this.fetchProfile(id, revision)
    if (!profile || revision !== this.profileRevision || this.disposed) return false
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
  private async fetchProfile(id: string, revision: number): Promise<RecognitionProfile | null> {
    const result = await apiClient.getPreset(id)
    if (revision !== this.profileRevision || this.disposed) return null
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
    void apiClient.feature('getDanmakuFeatures', undefined).then(result => {
      if (!this.disposed && result?.ok) this.configureDanmakuProcessing(result.value.preferences)
    })
    const revision = this.profileRevision
    for (const role of SOURCE_ROLES) this.autoProfiles?.monitor(role)
    // Before the first await, so re-entering the page resumes on the spot instead of
    // waiting on the network. This is also what restores a *persisted* toggle: settings
    // reload with `autoSyncEnabled: true`, but only `setAutoSyncEnabled` ever armed the
    // timer, so without this the switch read on while nothing was scheduled.
    if (this.settingsValue.autoSyncEnabled) this.startScheduler()
    const parked = this.parkedDanmakuRoom
    this.parkedDanmakuRoom = null
    if (parked && !this.danmakuState.room) this.connectDanmaku(parked)
    // Removing a media element from the document pauses it, so coming back from the
    // editor finds both sides stopped although the session still means to play.
    if (this.playingValue && SOURCE_ROLES.some((role) => this.engine.getState()[role].status === 'ready')) void this.setPlaying(true)
    const listed = await this.refreshPresets()
    if (revision !== this.profileRevision || this.disposed) return
    const id = this.settingsValue.profileId
    if (!id) return
    if (SOURCE_ROLES.every(role => this.profileFor(role) !== null)) return
    if (listed && !this.presetList.some((preset) => preset.id === id)) {
      this.updateSettings({ profileId: '' })
      return
    }
    const profile = await this.fetchProfile(id, revision)
    if (profile && revision === this.profileRevision && !this.disposed) this.setProfileForAll(profile)
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

  /** Reflect a producer fallback without replacing the attachment or its playhead. */
  private sourceDescriptor(role: SourceRole): MediaDescriptor | null {
    const descriptor = this.engine.getState()[role].descriptor
    const notice = this.bufferStates[role]?.notice
    if (!descriptor || notice?.code !== 'youtube-adaptive-fallback') return descriptor
    const selected = descriptor.sourceQualities?.find(option => option.id === descriptor.sourceQuality)
    if (!selected?.adaptive || selected.height !== notice.fromHeight) return descriptor
    const actual = descriptor.sourceQualities?.filter(option => !option.adaptive && option.height === notice.toHeight)
      .sort((a, b) => (b.fps ?? 0) - (a.fps ?? 0))[0]
    return actual ? { ...descriptor, sourceQuality: actual.id } : descriptor
  }

  beginSourceChange(role: SourceRole): number {
    this.invalidateAutomaticWork(role)
    return ++this.sourceGeneration[role]
  }
  sourceRevision(role: SourceRole): number { return this.sourceGeneration[role] }

  async loadSource(role: SourceRole, descriptor: MediaDescriptor, options: { keepSessionProfile?: boolean } = {}): Promise<void> {
    this.invalidateOffsetRequests()
    this.invalidateAutomaticWork(role, options)
    const generation = ++this.sourceGeneration[role]
    if (!descriptor.url.includes('/buffer/')) {
      await apiClient.stopBuffer(role)
      this.bufferStates = { ...this.bufferStates, [role]: null }
    }
    if (generation !== this.sourceGeneration[role] || this.disposed) return
    await this.engine.load(role, descriptor)
    if (generation !== this.sourceGeneration[role] || this.disposed) return
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
    this.autoProfiles?.monitor(role)
    this.notify()
  }

  unloadSource(role: SourceRole): void {
    this.invalidateOffsetRequests()
    this.invalidateAutomaticWork(role)
    ++this.sourceGeneration[role]
    void apiClient.stopBuffer(role)
    this.bufferStates = { ...this.bufferStates, [role]: null }
    this.engine.unload(role)
    this.applied = { ...this.applied, [role]: 0 }
    this.requestedOffset = offsetFromRewind(this.applied)
    this.notify()
  }

  /** Restart just one producer, then make at most one explicit synchronization attempt. */
  async changeSourceQuality(role: SourceRole, quality: string): Promise<void> {
    const descriptor = this.sourceDescriptor(role)
    if (this.qualityBusy[role] || !descriptor?.sourceQualities?.some((option) => option.id === quality)
      || descriptor.sourceQuality === quality) return
    // Same broadcast, same scoreboard: the ROI is a fraction of the frame and the glyphs a
    // normalised mask, so a profile the user accepted this session still reads the new
    // rendition. Dropping it here would make the post-switch re-sync impossible.
    this.invalidateAutomaticWork(role, { keepSessionProfile: true })
    const generation = ++this.sourceGeneration[role]
    const wasPlaying = !this.engine.element(role).paused
    this.qualityBusy = { ...this.qualityBusy, [role]: true }
    this.notify()
    try {
      const response = await apiClient.switchQuality(role, quality)
      if (generation !== this.sourceGeneration[role] || this.disposed) return
      if (!response.ok) { this.notice('warn', response.message); return }
      if (!response.value.ok) {
        this.notice('warn', response.value.failure.message)
        return
      }
      const stream = response.value.stream
      const replacement: MediaDescriptor = { ...descriptor, url: stream.url, kind: stream.kind,
        label: stream.label, sourceQualities: stream.qualities, sourceQuality: stream.quality,
        sourceRoom: stream.sourceRoom ?? descriptor.sourceRoom }
      await this.loadSource(role, replacement, { keepSessionProfile: true })
      const loadedGeneration = this.sourceGeneration[role]
      if (this.engine.getState()[role].descriptor !== replacement || this.disposed) return
      if (this.engine.getState()[role].status === 'error') {
        this.notice('warn', '画质切换后播放失败, 请重新加载片源')
        return
      }
      if (wasPlaying) {
        try { await this.engine.element(role).play() }
        catch { this.notice('warn', '画质已切换, 请恢复播放后点击立即同步'); return }
      }
      const available = await this.waitForQualityFrames(role, loadedGeneration)
      if (this.disposed || loadedGeneration !== this.sourceGeneration[role]) return
      if (!available || !SOURCE_ROLES.some((item) => this.profileFor(item))) {
        this.notice('info', '画质已切换, 两路画面就绪并选择预设后请点击立即同步')
        return
      }
      if (SOURCE_ROLES.some((item) => this.engine.element(item).paused)) {
        this.notice('info', '画质已切换, 请恢复两路播放后点击立即同步')
        return
      }
      const result = await this.syncNow()
      if (!result.applied) this.notice('warn', '画质已切换, 自动同步未完成, 请点击立即同步')
    } finally {
      this.qualityBusy = { ...this.qualityBusy, [role]: false }
      this.notify()
    }
  }

  private waitForQualityFrames(role: SourceRole, generation: number): Promise<boolean> {
    const ready = () => SOURCE_ROLES.every((item) => this.engine.getState()[item].status === 'ready'
      && this.engine.element(item).readyState >= 2)
    if (ready()) return Promise.resolve(true)
    // No selected profile or other source means waiting cannot lead to synchronization.
    if (!SOURCE_ROLES.some((item) => this.profileFor(item))
      || SOURCE_ROLES.some((item) => this.engine.getState()[item].status === 'empty')) return Promise.resolve(false)
    return new Promise((resolve) => {
      const finish = (result: boolean) => { clearTimeout(timer); off(); this.pendingQualityWaits.delete(cancel); resolve(result) }
      const cancel = () => finish(false)
      const timer = setTimeout(cancel, 20_000)
      const off = this.engine.subscribe(() => {
        if (this.disposed || generation !== this.sourceGeneration[role] || ready()) {
          finish(!this.disposed && generation === this.sourceGeneration[role] && ready())
        }
      })
      this.pendingQualityWaits.add(cancel)
    })
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

  /** Manual playback navigation also invalidates automatic sync and updates its bookkeeping. */
  seekPlayback(role: SourceRole, deltaSeconds: number): Promise<boolean> {
    if (!Number.isFinite(deltaSeconds) || Math.abs(deltaSeconds) > 86_400) return Promise.resolve(false)
    return this.navigatePlayback(role, deltaSeconds)
  }
  returnPlaybackToLive(role: SourceRole): Promise<boolean> { return this.navigatePlayback(role, 'live') }
  /** Native PiP owns presentation; stop expensive recognition while the opt-in mode is active. */
  setPresentationReduced(reduced: boolean): void {
    if (this.disposed || this.pipPresentationReduced === reduced) return
    this.pipPresentationReduced = reduced
    if (reduced) {
      this.autoProfiles?.suspend()
      this.stopScheduler()
      this.autoSync.cancel(false)
    } else {
      for (const role of SOURCE_ROLES) this.autoProfiles?.monitor(role)
      if (this.settingsValue.autoSyncEnabled) this.startScheduler()
    }
    this.notify()
  }
  private navigatePlayback(role: SourceRole, move: number | 'live'): Promise<boolean> {
    if (!SOURCE_ROLES.includes(role) || this.disposed || this.playbackPending >= 32) return Promise.resolve(false)
    const generation = this.sourceGeneration[role]
    this.autoSync.cancel(true); ++this.autoRequestRevision
    this.invalidateOffsetRequests()
    const automatic = this.automaticSeek
    const offsets = this.offsetDrain
    ++this.playbackPending
    const operation = this.playbackDrain.then(async () => {
      if (automatic) { await automatic.done; automatic.capture() }
      if (offsets) await offsets
      if (this.disposed || generation !== this.sourceGeneration[role]) return false
      const before = this.engine.snapshot(role)
      if (!before?.ready) return false
      const requested = move === 'live' ? latestPlayableTime(before.timebase) : before.currentTime + move
      if (requested === null) return false
      const target = clampSeek(requested, before.timebase).target
      const capture = this.captureSeekMovement(role)
      const reached = await this.engine.seek(role, target)
      if (this.disposed || generation !== this.sourceGeneration[role]) return false
      capture()
      this.requestedOffset = offsetFromRewind(this.applied)
      const commentary = this.engine.snapshot('commentary')
      if (commentary) this.timeline.handleSeek(commentary.currentTime)
      this.danmakuProcessor.reset()
      this.notify()
      return reached
    }).finally(() => { this.playbackPending-- })
    this.playbackDrain = operation.catch(() => {})
    return operation
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
  get offsetBusy(): boolean { return this.offsetDrain !== null }

  applyOffset(nextOffset: number, options: { fromAuto?: boolean } = {}): Promise<OffsetPlan> {
    if (!options.fromAuto) {
      // Manual input wins over a scheduled run, and revokes its authorization: after a
      // human moves the slider the scheduler must not quietly overwrite that choice.
      this.autoSync.cancel(true)
      this.interruptedAutomaticSeek ??= this.automaticSeek
      ++this.autoRequestRevision
      for (const role of SOURCE_ROLES) if (this.autoProfiles?.controller.busy) this.autoProfiles.controller.cancel(role)
    }
    this.requestedOffset = nextOffset
    const promise = new Promise<OffsetPlan>((finish, fail) => {
      if (this.pendingOffset) {
        this.pendingOffset.target = nextOffset
        this.pendingOffset.finish.push(finish)
        this.pendingOffset.fail.push(fail)
      } else this.pendingOffset = { target: nextOffset, boundary: this.offsetBoundary, finish: [finish], fail: [fail] }
    })
    this.startOffsetDrain()
    this.notify()
    return promise
  }

  private startOffsetDrain(): void {
    if (this.offsetDrain || !this.pendingOffset) return
    // Queue the first step as well, so synchronous inputs coalesce before any seek.
    this.offsetDrain = Promise.resolve().then(async () => {
      while (this.pendingOffset) {
        const request = this.pendingOffset
        this.pendingOffset = null
        try {
          const interrupted = this.interruptedAutomaticSeek
          if (interrupted) {
            await interrupted.done
            if (this.interruptedAutomaticSeek === interrupted) this.interruptedAutomaticSeek = null
            interrupted.capture()
          }
          const plan = await this.applyOffsetRequest(request.target, request.boundary)
          request.finish.forEach(finish => finish(plan))
        } catch (error) { request.fail.forEach(fail => fail(error)) }
      }
    }).finally(() => {
      this.offsetDrain = null
      this.startOffsetDrain()
      this.notify()
    })
  }

  private currentOffsetPlan(target: number): OffsetPlan {
    return planOffsetChange({ nextOffset: target, applied: this.applied, snapshots: this.disposed ? {} : {
      official: this.engine.snapshot('official') ?? undefined,
      commentary: this.engine.snapshot('commentary') ?? undefined,
    } })
  }

  private invalidateOffsetRequests(): void {
    ++this.offsetBoundary
    const pending = this.pendingOffset
    this.pendingOffset = null
    this.interruptedAutomaticSeek = null
    if (pending) {
      const plan = this.currentOffsetPlan(offsetFromRewind(this.applied))
      pending.finish.forEach(finish => finish(plan))
    }
  }

  /** Account for the observed move, including the peer's progress during a slow seek. */
  private captureSeekMovement(role: SourceRole): () => void {
    const peer: SourceRole = role === 'official' ? 'commentary' : 'official'
    const before = this.engine.snapshot(role)
    const peerBefore = this.engine.snapshot(peer)
    const generation = this.sourceGeneration[role]
    const peerGeneration = this.sourceGeneration[peer]
    const carried = this.applied[role]
    return () => {
      if (this.disposed || generation !== this.sourceGeneration[role] || !before) return
      const after = this.engine.snapshot(role)
      if (!after) return
      const peerAfter = this.engine.snapshot(peer)
      const advance = peerGeneration === this.sourceGeneration[peer] && peerBefore && peerAfter
        ? peerAfter.currentTime - peerBefore.currentTime : 0
      this.applied = { ...this.applied, [role]: Math.round(Math.max(0, carried + before.currentTime - after.currentTime + advance) * 1000) / 1000 }
    }
  }

  private async applyOffsetRequest(nextOffset: number, boundary: number): Promise<OffsetPlan> {
    const active = () => !this.disposed && boundary === this.offsetBoundary
    const cancelled = () => {
      if (!this.pendingOffset) this.requestedOffset = offsetFromRewind(this.applied)
      this.notify()
      return this.currentOffsetPlan(offsetFromRewind(this.applied))
    }
    if (!active()) return cancelled()
    const plan = planOffsetChange({
      nextOffset,
      applied: this.applied,
      snapshots: {
        official: this.engine.snapshot('official') ?? undefined,
        commentary: this.engine.snapshot('commentary') ?? undefined,
      },
    })
    this.planValue = plan

    for (const role of SOURCE_ROLES) {
      if (!active()) return cancelled()
      const currentPlan = this.currentOffsetPlan(nextOffset)
      const seek = currentPlan.seeks.find(entry => entry.role === role)
      if (!seek) {
        this.applied = { ...this.applied, [role]: currentPlan.rewindAfter[role] }
        continue
      }
      if (currentPlan.limited) { plan.limited = true; plan.limitReason = currentPlan.limitReason }
      const capture = this.captureSeekMovement(role)
      const ok = await this.engine.seek(seek.role, seek.to)
      capture()
      if (!active()) return cancelled()
      if (!ok) {
        this.notice('warn', `${roleName(seek.role)}未能跳转到目标位置`)
      }
      // Finish the native seek, then skip obsolete remaining work for a newer target.
      if (this.pendingOffset) break
    }

    plan.rewindAfter = { ...this.applied }
    plan.effectiveOffset = offsetFromRewind(this.applied)

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
    const revision = ++this.autoRequestRevision
    if (this.offsetDrain) await this.offsetDrain
    if (revision !== this.autoRequestRevision || this.disposed) return {
      phase: 'failed', dryRun: false, estimate: null, plan: null, applied: false,
      failure: { kind: 'cancelled', message: '自动同步已取消' }, divergence: null,
      samples: { official: 0, commentary: 0 }, jumps: { official: 0, commentary: 0 },
      startedAt: this.now(), finishedAt: this.now(),
    }
    this.autoSync.authorize()
    const result = await this.autoSync.run(this.applied)
    if (revision !== this.autoRequestRevision || this.disposed) return result
    if (result.appliedRewind || result.applied) {
      // The controller seeked through the engine, so the engine is authoritative for
      // where the sources ended up.
      this.applied = { ...(result.appliedRewind ?? result.plan?.rewindAfter ?? this.applied) }
      this.requestedOffset = result.failure?.kind === 'buffer-limit' && result.estimate
        ? result.estimate.totalOffsetSeconds : offsetFromRewind(this.applied)
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

  setSeekThreshold(seconds: number): void {
    const threshold = Math.max(0.2, Math.min(5, seconds))
    this.updateSettings({ seekThresholdSeconds: threshold })
    this.autoSync.configure({ seekThresholdSeconds: threshold })
  }

  acceptAutoProfile(role: SourceRole): void { this.autoProfiles?.controller.accept(role) }
  retryAutoProfile(role: SourceRole): void {
    this.autoProfiles?.controller.cancel(role)
    void this.autoProfiles?.controller.acquire(role)
  }
  cancelAutoProfile(role: SourceRole): void {
    this.autoProfiles?.controller.cancel(role)
    this.autoSync.cancel(false)
  }
  editAutoProfile(role: SourceRole): void {
    this.candidateToEdit = this.autoProfiles?.controller.state(role).candidate ?? this.profileFor(role)
  }
  takeEditingCandidate(): RecognitionProfile | null {
    const candidate = this.candidateToEdit
    // React StrictMode can invoke a state initializer twice.
    return candidate ? structuredClone(candidate) : null
  }
  clearEditingCandidate(): void { this.candidateToEdit = null }
  async saveAutoProfile(role: SourceRole): Promise<boolean> {
    const candidate = this.autoProfiles?.controller.state(role).candidate
    if (!candidate) return false
    // A new id on every explicit save prevents silent replacement of an existing preset.
    const id = `auto/${role}-${this.now()}-${++this.noticeSeq}`
    const profile = { ...structuredClone(candidate), id, updatedAt: this.now() }
    const result = await apiClient.savePreset(id, profile)
    if (!result.ok) { this.notice('warn', `候选保存失败: ${result.message}`); return false }
    this.notice('info', '候选已另存为新预设')
    await this.refreshPresets()
    return true
  }
  private invalidateAutomaticWork(role: SourceRole, options: { keepSessionProfile?: boolean } = {}): void {
    ++this.autoRequestRevision
    this.autoSync.cancel(false)
    this.autoProfiles?.reset(role)
    if (!options.keepSessionProfile && this.profileMap[role]?.id.startsWith('session/')) {
      this.profileMap = { ...this.profileMap, [role]: null }
    }
  }

  /** Abort an in-flight run; the button that calls this is the user's stop control. */
  cancelAutoSync(): void {
    ++this.autoRequestRevision
    this.autoSync.cancel()
    for (const role of SOURCE_ROLES) this.autoProfiles?.controller.cancel(role)
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
   * Subscribe through main's shared room relay. Messages are scheduled against
   * commentary media time so rewinding commentary also delays its danmaku.
   */
  connectDanmaku(room: string): void {
    this.disconnectDanmaku()
    const generation = this.danmakuGeneration
    this.danmakuState = { ...this.danmakuState, room, error: null }
    try {
      this.unsubscribeDanmaku = apiClient.subscribeDanmaku(room, ({ event, data }) => {
        if (generation !== this.danmakuGeneration) return
        if (event === 'danmaku') this.ingestDanmaku(data)
        else if (event === 'state') this.ingestDanmakuState(data)
        else if (event === 'error') {
          this.danmakuState = { ...this.danmakuState, connected: false, error: '弹幕连接中断，正在重试' }
          this.notify()
        }
      })
    } catch (error) {
      this.danmakuState = {
        ...this.danmakuState,
        connected: false,
        error: `弹幕连接失败: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    this.notify()
  }

  disconnectDanmaku(): void {
    this.danmakuGeneration += 1
    this.unsubscribeDanmaku?.()
    this.unsubscribeDanmaku = null
    this.timeline.clear()
    this.liveEdge.reset()
    this.danmakuProcessor.reset()
    this.pausedClock = null
    this.chatLog = []
    for (const listener of this.chatListeners) listener()
    this.danmakuState = { connected: false, room: null, error: null, pending: 0, dropped: 0 }
    this.notify()
  }

  /** Park one relayed message. Public so tests and the mock generator can feed it. */
  pushDanmaku(message: Pick<DanmakuMessage, 'text' | 'user' | 'color' | 'sender' | 'gift' | 'dms'>): void {
    const sender = normalizeDouyuSender(message.sender)
    const gift = normalizeDouyuGift(message.gift)
    if (message.gift !== undefined && !gift) return
    if (gift) {
      if (!this.settingsValue.danmaku.showGifts) return
      // Gift notices keep media-time alignment and user blocking, but are not chat text.
      const user = message.user.trim().toLowerCase()
      if (this.settingsValue.danmaku.filter.blockedUsers.some(blocked => blocked.trim().toLowerCase() === user)) return
    } else if (this.filter.reject(message)) return
    const density = this.settingsValue.danmaku.density
    // Sampling on arrival, not on render: a dropped message never occupies a lane, so
    // density behaves as a real load control rather than a visual one.
    if (!gift && density < 1 && Math.random() > density) return
    const snapshot = this.engine.snapshot('commentary')
    const scheduleTime = snapshot
      ? scheduleTimeFor(snapshot, { clock: this.liveEdge, nowMs: this.now() })
      : this.timeline.playhead
    this.timeline.push({
      id: `d${++this.noticeSeq}`,
      text: message.text,
      user: message.user,
      color: message.color,
      ...(sender ? { sender } : {}),
      ...(gift ? { gift } : {}),
      ...(typeof message.dms === 'number' && Number.isFinite(message.dms) ? { dms: message.dms } : {}),
      scheduleTime,
      receivedAt: this.now(),
    })
  }

  private ingestDanmaku(data: unknown): void {
    if (!data || typeof data !== 'object') return
    const payload = data as Partial<ChatMessage>
    if (typeof payload.text !== 'string' || payload.text.length === 0) return
    const gift = normalizeDouyuGift(payload.gift)
    if ((payload.system === true || payload.gift !== undefined) && !gift) return
    const sender = normalizeDouyuSender(payload.sender)
    this.pushDanmaku({
      text: payload.text,
      user: typeof payload.username === 'string' ? payload.username.trim() || '匿名' : '匿名',
      color: colorForIndex(typeof payload.color === 'number' ? payload.color : 0),
      ...(sender ? { sender } : {}),
      ...(gift ? { gift } : {}),
      ...(typeof payload.dms === 'number' && Number.isFinite(payload.dms) ? { dms: payload.dms } : {}),
    })
  }

  /** Connection status describes the upstream room, not just the local IPC channel. */
  private ingestDanmakuState(data: unknown): void {
    if (!data || typeof data !== 'object') return
    const payload = data as { state?: unknown; detail?: unknown; room?: unknown }
    const state = typeof payload.state === 'string' ? payload.state : ''
    const detail = typeof payload.detail === 'string' ? payload.detail : null
    const connected = state === 'connected'
    this.danmakuState = {
      ...this.danmakuState,
      connected,
      ...(typeof payload.room === 'string' && /^[1-9][0-9]{0,11}$/.test(payload.room) ? { room: payload.room } : {}),
      error: connected ? null : (detail ?? DANMAKU_STATE_TEXT[state] ?? this.danmakuState.error),
    }
    this.notify()
  }

  /**
   * Release everything due at the commentary playhead. Called once per animation frame.
   * A paused commentary does not hold chat back: messages show as they arrive.
   */
  drainDanmaku(): DanmakuMessage[] {
    const snapshot = this.engine.snapshot('commentary')
    const paused = snapshot !== null && this.engine.getState().commentary.paused
    // While paused, media time stands still; the duplicate window keeps counting on the wall
    // clock from where playback stopped, or one merge group would swallow the whole pause.
    let mediaTime = snapshot?.currentTime ?? this.timeline.playhead
    if (paused) {
      this.pausedClock ??= { media: mediaTime, wall: this.now() }
      mediaTime = this.pausedClock.media + (this.now() - this.pausedClock.wall) / 1000
    } else this.pausedClock = null
    const released = paused ? this.timeline.releaseAll() : this.timeline.advance(mediaTime)
    const visible: DanmakuMessage[] = []
    let merged = false
    for (const message of released) {
      const result = this.danmakuProcessor.process({ ...message, room: this.danmakuState.room ?? undefined }, mediaTime)
      if (result.kind === 'hide') continue
      if (result.kind === 'merge') {
        const update = (value: DanmakuMessage) => value.duplicateGroupId === result.groupId ? { ...value, duplicateCount: result.count } : value
        for (let i = 0; i < visible.length; i++) visible[i] = update(visible[i]!)
        this.chatLog = this.chatLog.map(update)
        merged = true
      } else visible.push(result.groupId ? { ...message, duplicateGroupId: result.groupId, duplicateCount: result.count } : message)
    }
    if (visible.length > 0) this.recordChat(visible)
    else if (merged) for (const listener of this.chatListeners) listener()
    return visible
  }

  configureDanmakuProcessing(raw: unknown): void {
    const parsed = readDanmakuPreferences(raw)
    if (!parsed) return
    this.danmakuPreferences = parsed
    this.danmakuProcessor.configure(parsed)
    this.notify()
  }

  /**
   * Released messages, oldest first, for the chat list. Bounded: at a busy room this is
   * hundreds of messages a minute, and the list only ever shows the recent ones.
   *
   * Kept out of the snapshot on purpose. Snapshot subscribers re-render the whole page;
   * chat arrives every frame. The chat list subscribes here instead and reads the array.
   */
  chatHistory(): readonly DanmakuMessage[] {
    return this.chatLog
  }

  subscribeChat(listener: () => void): () => void {
    this.chatListeners.add(listener)
    return () => this.chatListeners.delete(listener)
  }

  private recordChat(messages: DanmakuMessage[]): void {
    const next = this.chatLog.concat(messages)
    this.chatLog = next.length > CHAT_HISTORY_LIMIT ? next.slice(next.length - CHAT_HISTORY_LIMIT) : next
    this.chatTotal += messages.length
    for (const listener of this.chatListeners) listener()
  }

  /** Messages ever released, including those that have scrolled out of the history. */
  chatCount(): number {
    return this.chatTotal
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
    // Remembered so the next boot reconnects it: the room is part of what was loaded.
    this.parkedDanmakuRoom = this.danmakuState.room ?? this.parkedDanmakuRoom
    ++this.autoRequestRevision
    this.autoProfiles?.suspend()
    this.stopScheduler()
    // `false`: leaving the page is not the manual intervention that revokes auto-apply,
    // so coming back must not report 「手动调整过偏移」 the user never made.
    this.autoSync.cancel(false)
    this.disconnectDanmaku()
  }

  /** Tear the session down for good. Only its owner may call this. */
  dispose(): void {
    this.releaseFeatures?.()
    this.invalidateOffsetRequests()
    this.disposed = true
    this.releaseBuffer?.()
    for (const cancel of this.pendingQualityWaits) cancel()
    for (const role of SOURCE_ROLES) {
      ++this.sourceGeneration[role]
      if (this.engine.getState()[role].descriptor?.url.includes('/buffer/')) void apiClient.stopBuffer(role)
    }
    this.stopScheduler()
    this.disconnectDanmaku()
    this.autoSync.dispose()
    this.autoProfiles?.dispose()
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
    clock: () => performance.now(),
    onError: (role, message) => session.notice('warn', `${roleName(role)}识别线程错误：${message}`),
  })
}

export function roleName(role: SourceRole): string {
  return role === 'official' ? '官方画面' : '国内解说'
}

/** One cancelled source ends the sync wait without cancelling the other source's candidate. */
function allAccepted(promises: Array<Promise<boolean>>): Promise<boolean> {
  if (!promises.length) return Promise.resolve(true)
  return new Promise(resolve => {
    let remaining = promises.length
    for (const promise of promises) void promise.then(accepted => {
      if (!accepted) resolve(false)
      remaining -= 1
      if (!remaining) resolve(true)
    }, () => resolve(false))
  })
}

/** Re-exported so components do not each import from three modules. */
export { SOURCE_ROLES, DEFAULT_SETTINGS, saveSettings, planOffsetChange, scheduleTimeFor }
export type { AppliedRewind, DanmakuMessage, MediaDescriptor, SourceRole }
