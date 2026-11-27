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
import { sourceDanmakuRoom } from '../core/sourceDanmaku'
import { NO_REWIND, SOURCE_ROLES, type AppliedRewind, type SourceRole } from '../core/types'
import {
  clampOffset,
  offsetFromRewind,
  planOffsetChange,
  rewindForOffset,
  seekableRange,
  type OffsetPlan,
} from '../core/syncPlan'
import { MediaEngine, type EngineState } from '../media/mediaEngine'
import type { ActiveProfile } from '../core/activeProfile'
import { AutoSyncController, type AutoSyncPhase, type AutoSyncRunResult } from '../sync/autoSync'
import { FrameHashSampler, type FrameMeasureRequest, type FrameMeasurement } from '../sync/frameHashSampler'
import { apiClient } from './apiClient'
import type { AppSettings } from './settings'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings'
import type { HuyaOfficialMatch } from '../../electron/featureContracts'
import type { BufferState } from '../../electron/bufferManager'
import { colorForIndex } from '../../server/danmaku/douyuProtocol'
import { danmakuRoom, isReadOnlyDanmakuPlatform, type ChatMessage } from '../../server/danmaku/types'
import { bilibiliColor, bilibiliId, copyBilibiliMetadata, type BilibiliMetadata } from '../core/bilibiliMetadata'
import { createBilibiliSuperChatState, updateBilibiliSuperChats } from '../core/bilibiliSuperChats'
import { huyaChatColorHex, readHuyaChatMetadata } from '../core/huyaChat'
import { readHuyaOnTvSnapshot } from '../core/huyaOnTv'
import type { HuyaOnTvSnapshot } from '../../server/platforms/huyaOnTv'
import { normalizeDouyuGift, normalizeDouyuSender } from '../core/douyuMetadata'
import { DanmakuProcessor, DEFAULT_DANMAKU_PREFERENCES, readDanmakuPreferences, type DanmakuPreferences } from '../core/danmakuProcessing'
import {
  clampLiveUserSeek,
  LIVE_SMOOTH_CATCHUP_MAX_SECONDS,
  LIVE_SMOOTH_CATCHUP_RATE,
  liveSyncTarget,
} from '../media/timebase'
import { createPlaybackProgress, observePlaybackProgress } from '../media/playbackProgress'
import { PlaybackDiagnostics, type PlaybackStallSummary } from '../media/playbackDiagnostics'
import { errorDetails, type ErrorDetails } from '../core/errorDetails'

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
    /** Playback can start before both sources have enough data for synchronization. */
    ready: boolean
    phase: AutoSyncPhase
    authorized: boolean
    lastResult: AutoSyncRunResult | null
    /** Seconds until the scheduler's next run; null when it is off. */
    nextRunInSeconds: number | null
  }
  /** Which slot each role occupies. Swapping these never remounts an element. */
  mainRole: SourceRole
  playing: boolean
  /** True while smoothly accelerating at 1.25x to catch up to the buffered live tail. */
  liveCatchingUp: boolean
  danmaku: {
    connected: boolean
    room: string | null
    roomName?: string
    error: string | null
    errorDetail?: ErrorDetails
    pending: number
    dropped: number
    huyaOnTv?: HuyaOnTvSnapshot | null
    bilibiliSuperChats?: ReturnType<typeof createBilibiliSuperChatState>
    connectionRevision?: number
  }
  profiles: Record<SourceRole, ActiveProfile | null>
  notices: Notice[]
  buffers: Record<SourceRole, BufferState | null>
  qualityBusy: Record<SourceRole, boolean>
  playbackRecovery: { kind: 'stall' | 'reconnect'; driftSeconds: number | null } | null
  huyaFallbackPrompt: (HuyaOfficialMatch & { role: SourceRole; sourceKey: string }) | null
  playbackDiagnostics: Record<SourceRole, PlaybackStallSummary | null>
}

export interface Notice {
  id: number
  kind: 'info' | 'warn' | 'error'
  text: string
  at: number
  detail?: ErrorDetails
}

type DanmakuSelection = { room: string; origin: SourceRole | 'manual'; name?: string; canonicalRoom?: string }

export interface SessionOptions {
  engine?: MediaEngine
  storage?: Parameters<typeof loadSettings>[0]
  /** Retained as a no-op option so existing non-recognition test harnesses require no churn. */
  createSampler?: (session: Session) => unknown
  /** Optional deterministic frame-matching seam for unit tests without a Web Worker. */
  measureFrames?: (request: FrameMeasureRequest) => Promise<FrameMeasurement>
  now?: () => number
  /** Timestamp domain used by injected recognition outcomes. */
  readingClock?: () => number
}

const MAX_NOTICES = 6
const FRAME_MATCH_WINDOW_SECONDS = 9
const PROXY_INSTABILITY_WINDOW_MS = 120_000
const PROXY_INSTABILITY_THRESHOLD = 2
const BUFFER_REVIVAL_COOLDOWN_MS = 2_500
/** How long a loaded source may play without presenting a frame before it is reported. */
const PICTURE_TIMEOUT_MS = 15_000

/** Relay states worth surfacing. `connected` is the absence of a problem, so it has no text. */
const DANMAKU_STATE_TEXT: Record<string, string> = {
  idle: '弹幕未连接',
  connecting: '正在连接弹幕服务器',
  reconnecting: '弹幕连接中断，正在重试',
  closed: '弹幕连接已关闭',
}

export class Session {
  private frameSampler: FrameHashSampler | null = null
  private frameStatus = '两路载入后开始积累共同画面'
  get frameSyncStatus(): string { return this.frameStatus }
  readonly engine: MediaEngine
  readonly autoSync: AutoSyncController
  readonly timeline = new DanmakuTimeline()
  private readonly liveEdge = new LiveEdgeClock()
  private pausedClock: { media: number; wall: number } | null = null

  private autoRequestRevision = 0
  private readonly measureFramesOverride?: (request: FrameMeasureRequest) => Promise<FrameMeasurement>
  private settingsValue: AppSettings
  private readonly storage: SessionOptions['storage']
  private readonly now: () => number
  private readonly listeners = new Set<(snapshot: SessionSnapshot) => void>()

  private applied: AppliedRewind = { ...NO_REWIND }
  private requestedOffset = 0
  private planValue: OffsetPlan | null = null
  private mainRoleValue: SourceRole = 'official'
  private playingValue = false
  private playbackIntentRevision = 0
  /** The danmaku room `suspend` disconnected, for `boot` to reconnect. */
  private danmakuSelection: DanmakuSelection | null = null
  private parkedDanmakuRoom: DanmakuSelection | null = null
  private pendingAutoDanmaku = false
  private suspended = false
  private readonly pictureTimers = new Set<ReturnType<typeof setTimeout>>()
  private noticeSeq = 0
  private noticeList: Notice[] = []
  private bufferStates: Record<SourceRole, BufferState | null> = { official: null, commentary: null }
  private qualityBusy: Record<SourceRole, boolean> = { official: false, commentary: false }
  private sourceGeneration: Record<SourceRole, number> = { official: 0, commentary: 0 }
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
  private liveCatchup: {
    roles: SourceRole[]
    generations: Record<SourceRole, number>
    preserveAlignment: boolean
    startedAt: number
    timer: ReturnType<typeof setInterval>
  } | null = null
  private pipPresentationReduced = false
  private readonly pendingQualityWaits = new Set<() => void>()
  private readonly revivingBuffer = new Set<SourceRole>()
  private readonly lastBufferRevivalAt: Record<SourceRole, number> = { official: -Infinity, commentary: -Infinity }
  private readonly pendingCodecFallbackRemount = new Set<SourceRole>()
  private readonly proxyInstabilityAt: Record<SourceRole, number[]> = { official: [], commentary: [] }
  private huyaFallbackPromptValue: SessionSnapshot['huyaFallbackPrompt'] = null
  private readonly dismissedHuyaPrompts = new Set<string>()
  private readonly queriedHuyaPrompts = new Set<string>()
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
  private unsubscribeDanmaku: (() => void) | null = null
  private danmakuGeneration = 0
  private danmakuConnectionRevision = 0
  private matchDouyuLotteryCommand: ((message: Pick<ChatMessage, 'room' | 'text' | 'receivedAt'>) => string | null) | null = null
  private matchPlatformActivity: ((message: ChatMessage) => string | null) | null = null
  private filter: CompiledDanmakuFilter
  private schedulerDeadline: number | null = null
  private progress = createPlaybackProgress()
  private diagnosticProgress = { official: createPlaybackProgress(), commentary: createPlaybackProgress() }
  private readonly diagnostics = new PlaybackDiagnostics()
  private playbackRecovery: SessionSnapshot['playbackRecovery'] = null
  private observationTimer: ReturnType<typeof setInterval> | null = null
  private observationAt: number | null = null
  private diagnosticNotifyAt = 0
  private continuity = { official: 0, commentary: 0 }
  private observationRevision = { official: 0, commentary: 0 }
  private reconnectPending = false
  private readonly changingSources = new Set<SourceRole>()
  private snapshotValue: SessionSnapshot
  private notifyQueued = false
  private disposed = false

  constructor(options: SessionOptions = {}) {
    this.engine = options.engine ?? new MediaEngine()
    this.storage = options.storage
    this.now = options.now ?? (() => Date.now())
    this.settingsValue = loadSettings(this.storage)
    this.filter = compileDanmakuFilter(this.settingsValue.danmaku.filter)
    this.measureFramesOverride = options.measureFrames

    this.autoSync = new AutoSyncController(
      {
        measureFrames: request => {
          if (this.measureFramesOverride) return this.measureFramesOverride(request)
          this.refreshFrameCapture()
          return this.frameSampler?.measure(request) ?? Promise.resolve({
            samples: { official: 0, commentary: 0 }, message: '画面匹配尚未就绪，请保持两路视频播放',
          })
        },
        sample: async () => {},
        snapshot: (role) => this.engine.snapshot(role),
        canStart: () => SOURCE_ROLES.every(role => this.isSyncReady(role)),
        hasProfile: () => true,
        seek: (role, target) => this.seekAutomatically(role, target, false),
        seekManual: (role, target) => this.seekAutomatically(role, target, true),
        setPlaybackRate: (role, rate) => { this.engine.element(role).playbackRate = rate },
        playbackState: role => this.engine.playbackSample(role),
        onAppliedRewind: rewind => {
          this.applied = { ...rewind }
          this.requestedOffset = offsetFromRewind(rewind)
          this.notify()
        },
        now: this.now,
        readingClock: options.readingClock ?? (() => performance.now()),
      },
      {
        detectWindowSeconds: FRAME_MATCH_WINDOW_SECONDS,
        schedulerIntervalSeconds: this.settingsValue.autoSyncIntervalSeconds,
        seekThresholdSeconds: this.settingsValue.seekThresholdSeconds,
      },
    )

    this.engine.subscribe(() => {
      if (this.pendingAutoDanmaku && !this.suspended && !this.changingSources.has(this.autoDanmakuRole())) this.syncAutoDanmaku()
      for (const role of SOURCE_ROLES) this.maybeReviveLocalBuffer(role)
      this.refreshFrameCapture()
      this.notify()
    })
    this.releaseBuffer = apiClient.subscribeBuffer((state) => {
      if (state.role !== 'official' && state.role !== 'commentary') return
      const previousState = this.bufferStates[state.role]
      const previousNotice = previousState?.notice
      const notice = state.notice
      const isNewFallback = notice?.code === 'youtube-adaptive-fallback'
        && (previousNotice?.code !== notice.code || previousNotice.fromHeight !== notice.fromHeight
          || previousNotice.toHeight !== notice.toHeight)
      if (isNewFallback && notice) {
        this.notice('warn', `${notice.fromHeight}p 取流失败，已回退到 ${notice.toHeight}p`)
        const current = this.engine.getState()[state.role].descriptor
        if (current?.kind === 'hls' && current.url.includes('/buffer/')) {
          this.pendingCodecFallbackRemount.add(state.role)
        }
      }
      this.bufferStates = { ...this.bufferStates, [state.role]: state }
      if (previousState?.state === 'ready' && (state.state === 'reconnecting' || state.state === 'stalled')) {
        this.recordProxyInstability(state.role)
      }
      if (state.state === 'ready' && this.pendingCodecFallbackRemount.delete(state.role)) {
        const descriptor = this.sourceDescriptor(state.role)
        if (descriptor) void this.reviveLocalBuffer(state.role, descriptor)
      } else {
        this.maybeReviveLocalBuffer(state.role)
      }
      this.notify()
    })
    this.autoSync.onPhaseChange(phase => {
      const result = this.autoSync.result
      this.resetPlaybackObservation()
      if (phase === 'done' && result?.applied && !result.failure && !result.dryRun) this.playbackRecovery = null
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
      if (this.disposed) return
      if (event.topic === 'danmaku-preferences' && event.data && typeof event.data === 'object') {
        this.configureDanmakuProcessing((event.data as { preferences?: unknown }).preferences)
      } else if (event.topic === 'pip' && event.data && typeof event.data === 'object') {
        const value = event.data as { phase?: string; options?: { lowPower?: boolean } }
        this.setPresentationReduced(value.phase === 'ready' && value.options?.lowPower === true)
      }
    })
    this.startPlaybackObservation()
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
        ready: SOURCE_ROLES.every(role => this.isSyncReady(role)),
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
      liveCatchingUp: this.liveCatchup !== null,
      danmaku: { ...this.danmakuState, pending: stats.pending, dropped: stats.expired },
      profiles: { official: null, commentary: null },
      notices: this.noticeList,
      buffers: { ...this.bufferStates },
      qualityBusy: { ...this.qualityBusy },
      playbackRecovery: this.playbackRecovery,
      huyaFallbackPrompt: this.huyaFallbackPromptValue,
      playbackDiagnostics: { official: this.diagnostics.summary('official'), commentary: this.diagnostics.summary('commentary') },
    }
  }

  notice(kind: Notice['kind'], text: string, detail?: unknown): number {
    const entry: Notice = { id: ++this.noticeSeq, kind, text, at: this.now(),
      ...(kind !== 'info' && detail != null ? { detail: errorDetails(detail) } : {}) }
    // Newest first, oldest dropped: the notice strip shows a few lines, not a log.
    this.noticeList = [entry, ...this.noticeList].slice(0, MAX_NOTICES)
    this.notify()
    return entry.id
  }

  dismissNotice(id: number): void {
    this.noticeList = this.noticeList.filter((notice) => notice.id !== id)
    this.notify()
  }

  private refreshFrameCapture(): void {
    const enabled = !this.disposed
      && typeof Worker !== 'undefined' && this.changingSources.size === 0
      && SOURCE_ROLES.every(role => this.engine.getState()[role].status === 'ready')
    if (!enabled) {
      this.frameSampler?.dispose()
      this.frameSampler = null
      return
    }
    if (this.frameSampler) return
    this.frameSampler = new FrameHashSampler({
      video: role => this.engine.element(role),
      revision: role => {
        const state = this.engine.playbackSample(role)
        return `${this.sourceGeneration[role]}:${state.observationRevision}:${state.discontinuities}`
      },
      config: () => ({ regions: this.settingsValue.frameHashRegions, masks: this.settingsValue.frameHashMasks }),
      paused: () => this.pipPresentationReduced || SOURCE_ROLES.some(role => this.changingSources.has(role)
        || this.qualityBusy[role] || (this.bufferStates[role] !== null && this.bufferStates[role]!.state !== 'ready')),
      onStatus: status => { this.frameStatus = status; this.notify() },
    })
  }

  profileFor(_role: SourceRole): ActiveProfile | null {
    return null
  }

  private maybeReviveLocalBuffer(role: SourceRole): void {
    if (this.disposed || this.changingSources.has(role) || this.qualityBusy[role] || this.revivingBuffer.has(role)) return
    const mediaState = this.engine.getState()[role]
    const buffer = this.bufferStates[role]
    const descriptor = this.sourceDescriptor(role)
    if (!descriptor?.url.includes('/buffer/') || mediaState.status !== 'error' || buffer?.state !== 'ready') return
    if (this.now() - this.lastBufferRevivalAt[role] < BUFFER_REVIVAL_COOLDOWN_MS) return
    void this.reviveLocalBuffer(role, descriptor)
  }

  private async reviveLocalBuffer(role: SourceRole, descriptor: MediaDescriptor): Promise<void> {
    if (this.revivingBuffer.has(role) || this.disposed) return
    const generation = this.sourceGeneration[role]
    const shouldPlay = this.playingValue
    this.revivingBuffer.add(role)
    this.lastBufferRevivalAt[role] = this.now()
    try {
      await this.engine.load(role, descriptor)
      if (this.disposed || generation !== this.sourceGeneration[role]) return
      this.applyAudioSettings()
      if (shouldPlay && this.engine.getState()[role].status !== 'error') {
        await this.engine.element(role).play().catch(() => {})
      }
      this.notify()
    } finally {
      this.revivingBuffer.delete(role)
    }
  }

  private recordProxyInstability(role: SourceRole): void {
    if (this.disposed || this.changingSources.has(role) || this.qualityBusy[role]) return
    const descriptor = this.sourceDescriptor(role)
    if (!descriptor || (descriptor.platform !== 'youtube' && descriptor.platform !== 'twitch')) return
    const now = this.now()
    const recent = this.proxyInstabilityAt[role].filter(at => now - at <= PROXY_INSTABILITY_WINDOW_MS)
    if (recent.length > 0 && now - recent[recent.length - 1]! < 1_500) return
    recent.push(now)
    this.proxyInstabilityAt[role] = recent
    if (recent.length < PROXY_INSTABILITY_THRESHOLD) return

    const qualities = descriptor.sourceQualities ?? []
    const currentOption = qualities.find(option => option.id === descriptor.sourceQuality)
    const currentHeight = currentOption?.height ?? this.engine.element(role).videoHeight
    if (currentHeight > 1080) {
      // Quality floor is strictly 1080p; never auto-downgrade to 720p or lower.
      const target1080 = qualities
        .filter(option => option.height === 1080 && option.id !== descriptor.sourceQuality)
        .sort((a, b) => Number(!b.adaptive) - Number(!a.adaptive) || (b.fps ?? 0) - (a.fps ?? 0))[0]
      if (target1080) {
        this.proxyInstabilityAt[role] = []
        this.notice('warn', `当前代理连接不稳，已自动切换至 ${target1080.label} 以保持流畅`)
        void this.changeSourceQuality(role, target1080.id)
        return
      }
    }

    const sourceKey = `${descriptor.platform}:${descriptor.sourceChannel ?? descriptor.input}`
    if (this.dismissedHuyaPrompts.has(sourceKey) || this.queriedHuyaPrompts.has(sourceKey)
      || this.huyaFallbackPromptValue?.sourceKey === sourceKey) return
    this.queriedHuyaPrompts.add(sourceKey)
    const generation = this.sourceGeneration[role]
    void apiClient.feature('findHuyaOfficialStream', {
      platform: descriptor.platform,
      input: descriptor.input,
      ...(descriptor.sourceChannel ? { channel: descriptor.sourceChannel } : {}),
    }).then(result => {
      if (this.disposed || generation !== this.sourceGeneration[role] || this.dismissedHuyaPrompts.has(sourceKey)) return
      if (!result.ok || !result.value) return
      this.huyaFallbackPromptValue = { ...result.value, role, sourceKey }
      this.notify()
    }).catch(() => {})
  }

  dismissHuyaFallbackPrompt(): void {
    if (!this.huyaFallbackPromptValue) return
    this.dismissedHuyaPrompts.add(this.huyaFallbackPromptValue.sourceKey)
    this.huyaFallbackPromptValue = null
    this.notify()
  }

  acceptHuyaFallbackPrompt(): void {
    if (!this.huyaFallbackPromptValue) return
    this.dismissedHuyaPrompts.add(this.huyaFallbackPromptValue.sourceKey)
    this.huyaFallbackPromptValue = null
    this.notify()
  }

  /** Restore playback observation, preferences and the persisted scheduler toggle. */
  async boot(): Promise<void> {
    this.suspended = false
    this.startPlaybackObservation()
    void apiClient.feature('getDanmakuFeatures', undefined).then(result => {
      if (!this.disposed && result?.ok) this.configureDanmakuProcessing(result.value.preferences)
    })
    // Before the first await, so re-entering the page resumes on the spot instead of
    // waiting on the network. This is also what restores a *persisted* toggle: settings
    // reload with `autoSyncEnabled: true`, but only `setAutoSyncEnabled` ever armed the
    // timer, so without this the switch read on while nothing was scheduled.
    if (this.settingsValue.autoSyncEnabled) this.startScheduler()
    const parked = this.parkedDanmakuRoom
    this.parkedDanmakuRoom = null
    if (parked && !this.danmakuState.room) this.subscribeDanmaku(parked)
    else if (this.pendingAutoDanmaku) this.syncAutoDanmaku()
    // A renderer remount can pause its media elements while the session still means to play.
    if (this.playingValue && SOURCE_ROLES.some((role) => this.engine.getState()[role].status === 'ready')) void this.setPlaying(true)
  }

  // ---------------------------------------------------------------- settings

  updateSettings(patch: Partial<AppSettings>): void {
    if (patch.recognitionMode !== undefined || patch.frameHashRegions || patch.frameHashMasks) {
      this.autoSync.cancel(false)
      this.frameSampler?.dispose()
      this.frameSampler = null
    }
    this.settingsValue = { ...this.settingsValue, ...patch }
    saveSettings(this.settingsValue, this.storage)
    this.refreshFrameCapture()
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
    this.cancelLiveCatchup()
    this.invalidateAutomaticWork(role)
    this.changingSources.add(role)
    this.disconnectAutoDanmakuForChange(role)
    return ++this.sourceGeneration[role]
  }
  endSourceChange(role: SourceRole, generation: number): void {
    if (generation !== this.sourceGeneration[role] || !this.changingSources.delete(role)) return
    this.syncAutoDanmaku()
    this.resetPlaybackObservation()
    this.notify()
  }
  sourceRevision(role: SourceRole): number { return this.sourceGeneration[role] }

  async loadSource(role: SourceRole, descriptor: MediaDescriptor): Promise<void> {
    this.cancelLiveCatchup()
    this.invalidateOffsetRequests()
    this.invalidateAutomaticWork(role)
    const generation = ++this.sourceGeneration[role]
    this.changingSources.add(role)
    this.disconnectAutoDanmakuForChange(role)
    try {
      if (!descriptor.url.includes('/buffer/')) {
        await apiClient.stopBuffer(role)
        this.bufferStates = { ...this.bufferStates, [role]: null }
      }
      if (generation !== this.sourceGeneration[role] || this.disposed) return
      await this.engine.load(role, descriptor)
      if (generation !== this.sourceGeneration[role] || this.disposed) return
      const state = this.engine.getState()[role]
      if (state.status === 'error') {
        this.notice('error', `${roleName(role)}载入失败：${state.error?.message ?? '未知错误'}`, state.error)
        return
      }
      // A new source starts at its own position, so whatever rewind the old one carried is
      // no longer applied to anything. Keeping the number would make the next plan compute
      // its move from a rewind that does not exist.
      this.applied = { ...this.applied, [role]: 0 }
      this.requestedOffset = offsetFromRewind(this.applied)
      this.autoSync.cancel(false)
      this.notice('info', `${roleName(role)}已载入：${descriptor.label}`)
      this.watchPicture(role, generation)
      this.applyAudioSettings()
      this.notify()
    } finally { this.endSourceChange(role, generation) }
  }

  /**
   * A buffer that has segments can still give a black picture (codec, a broken init
   * segment). Say so once the source has had time to show a frame, rather than leave a
   * loaded-looking side that never moves.
   */
  private watchPicture(role: SourceRole, generation: number): void {
    const timer = setTimeout(() => {
      if (generation !== this.sourceGeneration[role] || this.disposed) return
      const state = this.engine.getState()[role]
      if (state.status === 'empty' || state.status === 'error' || state.firstFrame) return
      // Waiting for the user to press play is not a broken picture.
      if (state.paused && !this.playingValue) return
      const qualities = state.descriptor?.sourceQualities?.length || state.quality.length
      this.notice('warn', `${roleName(role)}暂未出画面，${qualities > 1 ? '请切换清晰度或重新载入' : '请重新载入'}`)
    }, PICTURE_TIMEOUT_MS)
    this.pictureTimers.add(timer)
    setTimeout(() => this.pictureTimers.delete(timer), PICTURE_TIMEOUT_MS + 1)
  }

  unloadSource(role: SourceRole): void {
    const reevaluateDanmaku = role === this.autoDanmakuRole() || this.automaticDanmakuOrigin() === role
    this.cancelLiveCatchup()
    this.invalidateOffsetRequests()
    this.invalidateAutomaticWork(role)
    ++this.sourceGeneration[role]
    this.changingSources.delete(role)
    this.disconnectAutoDanmakuForChange(role, false)
    void apiClient.stopBuffer(role)
    this.bufferStates = { ...this.bufferStates, [role]: null }
    this.engine.unload(role)
    if (reevaluateDanmaku) this.syncAutoDanmaku()
    this.applied = { ...this.applied, [role]: 0 }
    this.requestedOffset = offsetFromRewind(this.applied)
    this.notify()
  }

  /** Restart just one producer, then make at most one explicit synchronization attempt. */
  async changeSourceQuality(role: SourceRole, quality: string): Promise<void> {
    const descriptor = this.sourceDescriptor(role)
    if (this.qualityBusy[role] || !descriptor?.sourceQualities?.some((option) => option.id === quality)
      || descriptor.sourceQuality === quality) return
    // Invalidate timing evidence before replacing the stream in either recognition mode.
    this.invalidateAutomaticWork(role)
    const generation = ++this.sourceGeneration[role]
    const wasPlaying = !this.engine.element(role).paused
    this.qualityBusy = { ...this.qualityBusy, [role]: true }
    let ownsBusy = true
    const releaseBusy = () => {
      if (!ownsBusy) return
      ownsBusy = false
      this.qualityBusy = { ...this.qualityBusy, [role]: false }
      this.notify()
    }
    this.notify()
    try {
      const response = await apiClient.switchQuality(role, quality)
      if (generation !== this.sourceGeneration[role] || this.disposed) return
      if (!response.ok) { this.notice('warn', response.message, response); return }
      if (!response.value.ok) {
        this.notice('warn', response.value.failure.message, response.value.failure)
        return
      }
      const stream = response.value.stream
      const replacement: MediaDescriptor = { ...descriptor, url: stream.url, kind: stream.kind,
        label: stream.label, sourceQualities: stream.qualities, sourceQuality: stream.quality,
        sourceRoom: stream.sourceRoom ?? descriptor.sourceRoom,
        danmakuRoom: stream.danmakuRoom ?? descriptor.danmakuRoom, sourceChannel: stream.channel ?? descriptor.sourceChannel }
      await this.loadSource(role, replacement)
      const loadedGeneration = this.sourceGeneration[role]
      if (this.engine.getState()[role].descriptor !== replacement || this.disposed) return
      if (this.engine.getState()[role].status === 'error') {
        this.notice('warn', '画质切换后播放失败，请重新载入片源')
        return
      }
      const hasBothSources = SOURCE_ROLES.every(item => this.engine.getState()[item].status !== 'empty')
      if (wasPlaying) {
        try { await this.engine.element(role).play() }
        catch { this.notice('warn', hasBothSources ? '请恢复两路播放后点击「自动对齐」' : '画质已切换，请恢复播放'); return }
      }
      releaseBusy()
      if (!hasBothSources) { this.notice('info', '画质已切换'); return }
      const available = await this.waitForQualityFrames(role, loadedGeneration)
      if (this.disposed || loadedGeneration !== this.sourceGeneration[role]) return
      if (!available) {
        this.notice('info', '两路就绪后，请点击「自动对齐」')
        return
      }
      if (SOURCE_ROLES.some((item) => this.engine.element(item).paused)) {
        this.notice('info', '请恢复两路播放后点击「自动对齐」')
        return
      }
      const result = await this.executeSync(false)
      if (!result.applied) this.notice('warn', '画质已切换，请点击「自动对齐」')
    } finally {
      releaseBusy()
    }
  }

  private waitForQualityFrames(role: SourceRole, generation: number): Promise<boolean> {
    const ready = () => SOURCE_ROLES.every((item) => this.isSyncReady(item))
    if (ready()) return Promise.resolve(true)
    if (SOURCE_ROLES.some((item) => this.engine.getState()[item].status === 'empty')) return Promise.resolve(false)
    return new Promise((resolve) => {
      const finish = (result: boolean) => { clearTimeout(timer); off(); this.pendingQualityWaits.delete(cancel); resolve(result) }
      const cancel = () => finish(false)
      const timer = setTimeout(cancel, 20_000)
      const off = this.subscribe(() => {
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
    if (!playing) this.cancelLiveCatchup()
    ++this.playbackIntentRevision
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

  /** True when both streams are ready and carrying an active manual or verified alignment. */
  isPairAligned(): boolean {
    const media = this.engine.getState()
    if (media.official.status !== 'ready' || media.commentary.status !== 'ready') return false
    const offset = offsetFromRewind(this.applied)
    const autoLocked = this.autoSync.phase === 'done' && this.autoSync.autoApplyAuthorized
      && this.autoSync.result?.applied === true && !this.autoSync.result.dryRun
    return autoLocked || Math.abs(offset) >= 0.05 || Math.abs(this.requestedOffset) >= 0.05
  }

  /** Real buffered live target for one role; null for VOD or unready media. */
  roleLiveTarget(role: SourceRole): number | null {
    const state = this.engine.getState()[role]
    const snap = this.engine.snapshot(role)
    if (!snap?.ready || snap.timebase.kind !== 'live') return null
    const video = this.engine.element(role)
    return liveSyncTarget(snap.timebase, {
      bufferedEnd: currentBufferedEnd(video),
      livePosition: this.engine.livePosition(role),
      currentTime: snap.currentTime,
      localBuffer: Boolean(state.descriptor?.url.includes('/buffer/')),
    })
  }

  private canSmoothCatchup(roles: SourceRole[], gapSeconds: number): boolean {
    return gapSeconds > 0.15 && gapSeconds <= LIVE_SMOOTH_CATCHUP_MAX_SECONDS && roles.every(role => {
      const state = this.engine.getState()[role]
      const video = this.engine.element(role)
      const bufferedEnd = currentBufferedEnd(video)
      return state.status === 'ready' && !video.paused && !video.seeking && !video.ended
        && video.readyState >= 3 && bufferedEnd !== null && bufferedEnd - video.currentTime >= Math.min(gapSeconds, 0.6)
    })
  }

  private startLiveCatchup(roles: SourceRole[], preserveAlignment: boolean): void {
    this.cancelLiveCatchup(false)
    this.playbackRecovery = null
    this.resetPlaybackObservation()
    if (preserveAlignment) {
      this.autoSync.cancel(false)
      ++this.autoRequestRevision
    } else {
      this.autoSync.cancel(true)
      ++this.autoRequestRevision
      this.invalidateOffsetRequests()
    }
    for (const role of roles) {
      try { this.engine.element(role).playbackRate = LIVE_SMOOTH_CATCHUP_RATE } catch { /* ignore detached */ }
    }
    const generations = { official: this.sourceGeneration.official, commentary: this.sourceGeneration.commentary }
    const timer = setInterval(() => this.tickLiveCatchup(), 80)
    this.liveCatchup = { roles, generations, preserveAlignment, startedAt: this.now(), timer }
    this.notify()
  }

  private tickLiveCatchup(): void {
    const active = this.liveCatchup
    if (!active || this.disposed) { this.cancelLiveCatchup(); return }
    const invalid = active.roles.some(role => {
      const video = this.engine.element(role)
      return this.sourceGeneration[role] !== active.generations[role]
        || video.paused || video.seeking || video.ended
    })
    if (invalid || this.now() - active.startedAt > 20_000) {
      this.finishLiveCatchup()
      return
    }
    const gaps = active.roles.map(role => {
      const target = this.roleLiveTarget(role)
      return target === null ? 0 : Math.max(0, target - this.engine.element(role).currentTime)
    })
    const remaining = active.preserveAlignment ? Math.min(...gaps) : (gaps[0] ?? 0)
    const starved = active.roles.some(role => {
      const video = this.engine.element(role)
      const bufferedEnd = currentBufferedEnd(video)
      return bufferedEnd === null || bufferedEnd - video.currentTime < 0.2
    })
    if (remaining <= 0.15 || starved) this.finishLiveCatchup()
  }

  private finishLiveCatchup(): void {
    const active = this.liveCatchup
    if (!active) return
    clearInterval(active.timer)
    this.liveCatchup = null
    for (const role of active.roles) {
      if (this.sourceGeneration[role] === active.generations[role]) {
        try { this.engine.element(role).playbackRate = 1 } catch { /* ignore detached */ }
      }
    }
    if (!active.preserveAlignment && active.roles.length === 1) {
      const role = active.roles[0]!
      if (this.sourceGeneration[role] === active.generations[role]) {
        this.applied = { ...this.applied, [role]: 0 }
        this.requestedOffset = offsetFromRewind(this.applied)
      }
    }
    const commentary = this.engine.snapshot('commentary')
    if (commentary) this.timeline.handleSeek(commentary.currentTime)
    this.resetPlaybackObservation()
    this.notify()
  }

  cancelLiveCatchup(notify = true): void {
    const active = this.liveCatchup
    if (!active) return
    clearInterval(active.timer)
    this.liveCatchup = null
    for (const role of active.roles) {
      try { this.engine.element(role).playbackRate = 1 } catch { /* ignore detached */ }
    }
    this.resetPlaybackObservation()
    if (notify) this.notify()
  }

  /** Manual playback navigation also invalidates automatic sync and updates its bookkeeping. */
  seekPlayback(role: SourceRole, deltaSeconds: number): Promise<boolean> {
    if (!Number.isFinite(deltaSeconds) || Math.abs(deltaSeconds) > 86_400) return Promise.resolve(false)
    return this.navigatePlayback(role, deltaSeconds)
  }
  /** Linked keyboard seek (← / →): moves both streams together so an aligned pair stays aligned. */
  seekLinkedPlayback(deltaSeconds: number): Promise<boolean> {
    if (!Number.isFinite(deltaSeconds) || Math.abs(deltaSeconds) > 86_400 || Math.abs(deltaSeconds) < 0.001) {
      return Promise.resolve(false)
    }
    const media = this.engine.getState()
    const officialLoaded = media.official.status !== 'empty' && Boolean(this.engine.snapshot('official')?.ready)
    const commentaryLoaded = media.commentary.status !== 'empty' && Boolean(this.engine.snapshot('commentary')?.ready)
    if (officialLoaded && commentaryLoaded) return this.navigateLinkedPlayback(deltaSeconds)
    const singleRole: SourceRole | null = media[this.mainRoleValue].status !== 'empty'
      ? this.mainRoleValue
      : SOURCE_ROLES.find(role => media[role].status !== 'empty') ?? null
    return singleRole ? this.seekPlayback(singleRole, deltaSeconds) : Promise.resolve(false)
  }
  /** A point picked on the time line, kept in the same bookkeeping as a relative seek. */
  seekPlaybackTo(role: SourceRole, target: number): Promise<boolean> {
    if (!Number.isFinite(target)) return Promise.resolve(false)
    return this.navigatePlayback(role, { to: target })
  }
  /**
   * DouyuEx-style "同步时间":
   * - Single / unaligned: catches `role` up to its real buffered tail (1.25x within 4s, seek above 4s).
   * - Paired & aligned: advances both streams together by their shared headroom, preserving alignment.
   */
  syncPlaybackToLive(role: SourceRole = this.mainRoleValue, options: { immediate?: boolean } = {}): Promise<boolean> {
    const immediate = options.immediate || this.liveCatchup !== null
    if (this.isPairAligned()) {
      const targetO = this.roleLiveTarget('official')
      const targetC = this.roleLiveTarget('commentary')
      if (targetO !== null && targetC !== null) {
        const gapO = Math.max(0, targetO - this.engine.element('official').currentTime)
        const gapC = Math.max(0, targetC - this.engine.element('commentary').currentTime)
        const sharedGap = Math.min(gapO, gapC)
        if (sharedGap <= 0.15) {
          this.cancelLiveCatchup()
          return Promise.resolve(false)
        }
        if (!immediate && this.canSmoothCatchup(['official', 'commentary'], sharedGap)) {
          this.startLiveCatchup(['official', 'commentary'], true)
          return Promise.resolve(true)
        }
        this.cancelLiveCatchup(false)
        return this.navigateLinkedPlayback(sharedGap, { silentAtEdge: true })
      }
    }
    const target = this.roleLiveTarget(role)
    if (target === null) return Promise.resolve(false)
    const gap = target - this.engine.element(role).currentTime
    if (gap <= 0.15) {
      this.cancelLiveCatchup()
      return Promise.resolve(false)
    }
    if (!immediate && this.canSmoothCatchup([role], gap)) {
      this.startLiveCatchup([role], false)
      return Promise.resolve(true)
    }
    this.cancelLiveCatchup(false)
    return this.navigatePlayback(role, 'live')
  }
  returnPlaybackToLive(role: SourceRole): Promise<boolean> { return this.syncPlaybackToLive(role) }
  /** Native PiP owns presentation; stop expensive recognition while the opt-in mode is active. */
  setPresentationReduced(reduced: boolean): void {
    if (this.disposed || this.pipPresentationReduced === reduced) return
    this.pipPresentationReduced = reduced
    this.resetPlaybackObservation()
    if (reduced) {
      this.cancelLiveCatchup(false)
      this.stopScheduler()
      this.autoSync.cancel(false)
    } else {
      if (this.settingsValue.autoSyncEnabled) this.startScheduler()
    }
    this.notify()
  }
  private navigateLinkedPlayback(deltaSeconds: number, options: { silentAtEdge?: boolean } = {}): Promise<boolean> {
    if (this.disposed || this.playbackPending >= 32) return Promise.resolve(false)
    const generations = { official: this.sourceGeneration.official, commentary: this.sourceGeneration.commentary }
    this.cancelLiveCatchup(false)
    this.playbackRecovery = null
    this.resetPlaybackObservation()
    this.autoSync.cancel(false)
    ++this.autoRequestRevision
    this.invalidateOffsetRequests()
    const automatic = this.automaticSeek
    const offsets = this.offsetDrain
    ++this.playbackPending
    const operation = this.playbackDrain.then(async () => {
      if (automatic) { await automatic.done; automatic.capture() }
      if (offsets) await offsets
      if (this.disposed || SOURCE_ROLES.some(role => generations[role] !== this.sourceGeneration[role])) return false
      const snapO = this.engine.snapshot('official')
      const snapC = this.engine.snapshot('commentary')
      if (!snapO?.ready || !snapC?.ready) return false
      const bounds = (role: SourceRole, snap: NonNullable<typeof snapO>) => {
        const range = seekableRange(snap.timebase)
        if (snap.timebase.kind !== 'live') return range
        const video = this.engine.element(role)
        const state = this.engine.getState()[role]
        const end = clampLiveUserSeek(snap.timebase.seekableEnd, snap.timebase, {
          bufferedEnd: currentBufferedEnd(video),
          livePosition: this.engine.livePosition(role),
          currentTime: snap.currentTime,
          localBuffer: Boolean(state.descriptor?.url.includes('/buffer/')),
        }).target
        return { start: range.start, end }
      }
      const rangeO = bounds('official', snapO)
      const rangeC = bounds('commentary', snapC)
      let actualDelta: number
      if (deltaSeconds < 0) {
        const backO = Math.max(0, snapO.currentTime - rangeO.start)
        const backC = Math.max(0, snapC.currentTime - rangeC.start)
        actualDelta = -Math.min(Math.abs(deltaSeconds), backO, backC)
        if (Math.abs(actualDelta) < 0.05) {
          if (!options.silentAtEdge) this.notice('info', '已到可回看起点')
          return false
        }
      } else {
        const fwdO = Math.max(0, rangeO.end - snapO.currentTime)
        const fwdC = Math.max(0, rangeC.end - snapC.currentTime)
        actualDelta = Math.min(deltaSeconds, fwdO, fwdC)
        if (actualDelta < 0.15) {
          if (!options.silentAtEdge) {
            const heldBack = Math.max(fwdO, fwdC) >= 1
            this.notice('info', heldBack ? '已在最新同步进度；调两路快慢请用中间对齐按钮' : '已到直播最新处')
          }
          return false
        }
      }
      const beforeO = snapO.currentTime
      const beforeC = snapC.currentTime
      const priorOffset = offsetFromRewind(this.applied)
      const priorRequested = this.requestedOffset
      const intent = this.playbackIntentRevision
      const held = SOURCE_ROLES.map(candidate => ({
        role: candidate,
        video: this.engine.element(candidate),
        generation: this.sourceGeneration[candidate],
      })).filter(item => !item.video.paused)
      for (const item of held) {
        try { item.video.pause() } catch { /* ignore detached */ }
      }
      let okO = false
      let okC = false
      let afterO = beforeO
      let afterC = beforeC
      try {
        ;[okO, okC] = await Promise.all([
          this.engine.seek('official', beforeO + actualDelta),
          this.engine.seek('commentary', beforeC + actualDelta),
        ])
        afterO = this.engine.snapshot('official')?.currentTime ?? beforeO
        afterC = this.engine.snapshot('commentary')?.currentTime ?? beforeC
      } finally {
        if (!this.disposed && intent === this.playbackIntentRevision) {
          await Promise.allSettled(held.filter(item =>
            item.generation === this.sourceGeneration[item.role]
            && item.video === this.engine.element(item.role),
          ).map(async item => item.video.play()))
        }
      }
      if (this.disposed || SOURCE_ROLES.some(role => generations[role] !== this.sourceGeneration[role])) return false
      const drift = (afterC - beforeC) - (afterO - beforeO)
      if (Math.abs(drift) >= 0.05) {
        const nextOffset = clampOffset(priorOffset + drift)
        this.applied = rewindForOffset(nextOffset)
        this.requestedOffset = offsetFromRewind(this.applied)
      } else {
        this.requestedOffset = priorRequested
      }
      this.timeline.handleSeek(afterC)
      this.danmakuProcessor.reset()
      this.notify()
      return okO && okC
    }).finally(() => { this.playbackPending-- })
    this.playbackDrain = operation.catch(() => {})
    return operation
  }
  private navigatePlayback(role: SourceRole, move: number | 'live' | { to: number }): Promise<boolean> {
    if (!SOURCE_ROLES.includes(role) || this.disposed || this.playbackPending >= 32) return Promise.resolve(false)
    const generation = this.sourceGeneration[role]
    this.cancelLiveCatchup(false)
    this.playbackRecovery = null
    this.resetPlaybackObservation()
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
      const video = this.engine.element(role)
      const state = this.engine.getState()[role]
      const liveOptions = {
        bufferedEnd: currentBufferedEnd(video),
        livePosition: this.engine.livePosition(role),
        currentTime: before.currentTime,
        localBuffer: Boolean(state.descriptor?.url.includes('/buffer/')),
      }
      const requested = move === 'live' ? liveSyncTarget(before.timebase, liveOptions)
        : typeof move === 'number' ? before.currentTime + move : move.to
      if (requested === null) return false
      const target = move === 'live'
        ? requested
        : clampLiveUserSeek(requested, before.timebase, liveOptions).target
      if (move === 'live' && target <= before.currentTime + 0.05) return false
      const capture = this.captureSeekMovement(role)
      const reached = await this.engine.seek(role, target)
      if (this.disposed || generation !== this.sourceGeneration[role]) return false
      capture()
      if (move === 'live') this.applied = { ...this.applied, [role]: 0 }
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
    nextOffset = clampOffset(nextOffset)
    this.cancelLiveCatchup(false)
    if (!options.fromAuto) {
      this.playbackRecovery = null
      this.resetPlaybackObservation()
      // Manual input wins over a scheduled run, and revokes its authorization: after a
      // human moves the slider the scheduler must not quietly overwrite that choice.
      this.autoSync.cancel(true)
      this.interruptedAutomaticSeek ??= this.automaticSeek
      ++this.autoRequestRevision
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

  private seekAutomatically(role: SourceRole, target: number, holdPair: boolean): Promise<boolean> {
    const capture = this.captureSeekMovement(role)
    const intent = this.playbackIntentRevision
    const held = holdPair ? SOURCE_ROLES.map(candidate => ({ role: candidate,
      video: this.engine.element(candidate), generation: this.sourceGeneration[candidate] }))
      .filter(item => !item.video.paused) : []
    for (const item of held) item.video.pause()
    let operation: Promise<boolean>
    try { operation = this.engine.seek(role, target) }
    catch (error) { operation = Promise.reject(error) }
    const seek = { capture, done: operation.finally(async () => {
      // Only restore the exact elements paused here. A later user pause, page exit
      // or source replacement owns playback and must win over this cleanup.
      if (this.disposed || intent !== this.playbackIntentRevision) return
      await Promise.allSettled(held.filter(item => item.generation === this.sourceGeneration[item.role]
        && item.video === this.engine.element(item.role)).map(async item => item.video.play()))
    }) }
    this.automaticSeek = seek
    return seek.done.finally(() => { if (this.automaticSeek === seek) this.automaticSeek = null })
  }

  private async applyOffsetRequest(nextOffset: number, boundary: number): Promise<OffsetPlan> {
    const active = () => !this.disposed && boundary === this.offsetBoundary
    const cancelled = () => {
      if (!this.pendingOffset) this.requestedOffset = offsetFromRewind(this.applied)
      this.notify()
      return this.currentOffsetPlan(offsetFromRewind(this.applied))
    }
    if (!active()) return cancelled()
    const plan = this.currentOffsetPlan(nextOffset)
    // Each source is replanned after the preceding native seek. Publish the moves
    // actually attempted, not limits from a live window that may have changed meanwhile.
    plan.seeks = []
    plan.missingRoles = []
    plan.limited = false
    delete plan.limitReason
    this.planValue = plan

    for (const role of SOURCE_ROLES) {
      if (!active()) return cancelled()
      const currentPlan = this.currentOffsetPlan(nextOffset)
      const seek = currentPlan.seeks.find(entry => entry.role === role)
      if (!seek) {
        this.applied = { ...this.applied, [role]: currentPlan.rewindAfter[role] }
        if (currentPlan.missingRoles.includes(role)) {
          plan.missingRoles.push(role)
          plan.limited = true
          plan.limitReason = 'not-ready'
        }
        continue
      }
      plan.seeks.push(seek)
      if (seek.clamped) {
        plan.limited = true
        if (plan.limitReason !== 'not-ready') plan.limitReason = 'buffer-limit'
      }
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
      this.notice('warn', describeBufferLimit(plan))
    } else if (plan.limitReason === 'not-ready') {
      this.notice('warn', '片源未就绪，未完全调整')
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

  private isSyncReady(role: SourceRole): boolean {
    const media = this.engine.getState()[role]
    if (media.status !== 'ready' || this.changingSources.has(role) || this.qualityBusy[role]
      || !this.engine.snapshot(role)?.ready || this.engine.element(role).readyState < 3) return false
    if (!media.descriptor?.url.includes('/buffer/')) return true
    const buffer = this.bufferStates[role]
    if (buffer) return buffer.state === 'ready' && buffer.seconds >= 4
    const timebase = media.timebase
    return !!timebase && (timebase.kind === 'vod' ? timebase.duration >= 4
      : timebase.seekableEnd - timebase.seekableStart >= 4)
  }

  private canObservePlayback(): boolean {
    return !this.disposed && !this.pipPresentationReduced && !this.autoSync.isRunning
      && !this.automaticSeek && !this.offsetDrain && this.playbackPending === 0 && !this.liveCatchup
      && this.changingSources.size === 0 && !SOURCE_ROLES.some(role => this.qualityBusy[role]
        || this.engine.playbackSample(role).busy)
  }

  private resetPlaybackObservation(): void {
    this.progress = createPlaybackProgress()
    this.diagnosticProgress = { official: createPlaybackProgress(), commentary: createPlaybackProgress() }
    this.reconnectPending = false
    for (const role of SOURCE_ROLES) {
      this.diagnostics.endStall(role)
      const sample = this.engine.playbackSample(role)
      this.continuity[role] = sample.discontinuities
      this.observationRevision[role] = sample.observationRevision
    }
  }

  private startPlaybackObservation(): void {
    if (this.observationTimer !== null || this.disposed) return
    this.observationAt = null
    this.observationTimer = setInterval(() => this.observePlayback(), 500)
  }

  private stopPlaybackObservation(): void {
    ++this.playbackIntentRevision
    if (this.observationTimer !== null) clearInterval(this.observationTimer)
    this.observationTimer = null
    this.resetPlaybackObservation()
  }

  private observePlayback(): void {
    const at = this.now()
    const timerLateMs = this.observationAt === null ? 0 : Math.max(0, at - this.observationAt - 500)
    this.observationAt = at
    const samples = { official: this.engine.playbackSample('official'), commentary: this.engine.playbackSample('commentary') }
    const enabled = this.canObservePlayback()
      && SOURCE_ROLES.every(role => samples[role].observationRevision === this.observationRevision[role])
    const media = this.engine.getState()
    const paired = enabled && SOURCE_ROLES.every(role => media[role].status === 'ready')
    let diagnosticChanged = false
    for (const role of SOURCE_ROLES) {
      const sample = samples[role]
      const observing = enabled && media[role].status === 'ready'
      this.diagnostics.record(role, { ...sample, at, timerLateMs, observing, localBuffer: this.bufferStates[role] })
      // A source's diagnostic clock remains useful when its peer is absent or paused.
      const individual = observePlaybackProgress(this.diagnosticProgress[role], { at, official: sample, commentary: sample }, observing)
      this.diagnosticProgress[role] = individual.state
      if (individual.started.length) {
        diagnosticChanged = true
        this.diagnostics.startStall(role)
        if (observing && this.playingValue && !sample.paused && !sample.seeking && !sample.ended) {
          this.recordProxyInstability(role)
        }
      }
      if (individual.ended.length || !observing || sample.paused || sample.seeking || sample.ended
        || timerLateMs > 1000) {
        if (individual.ended.length) diagnosticChanged = true
        this.diagnostics.endStall(role)
      }
      if (paired && !sample.paused && !sample.seeking && !sample.ended
        && sample.discontinuities > this.continuity[role]) this.reconnectPending = true
      this.continuity[role] = sample.discontinuities
      this.observationRevision[role] = sample.observationRevision
    }
    const result = observePlaybackProgress(this.progress, { at, ...samples }, paired)
    this.progress = result.state
    if (!paired || SOURCE_ROLES.some(role => samples[role].paused || samples[role].seeking || samples[role].ended)
      || timerLateMs > 1000) this.reconnectPending = false
    if (result.recovery || (this.reconnectPending && !result.state.episode)) {
      this.playbackRecovery = this.reconnectPending
        ? { kind: 'reconnect', driftSeconds: null }
        : { kind: 'stall', driftSeconds: result.recovery!.driftSeconds }
      this.reconnectPending = false
      this.notify()
      // Failure keeps the prompt. Neither this call nor a scheduler tick can re-arm it.
      if (this.settingsValue.autoSyncEnabled && this.autoSync.autoApplyAuthorized && this.canObservePlayback()) {
        this.startScheduler()
        void this.executeSync(false)
      }
    }
    if (diagnosticChanged || at - this.diagnosticNotifyAt >= 1000) {
      this.diagnosticNotifyAt = at
      this.notify()
    }
  }

  exportPlaybackDiagnostics(): ReturnType<PlaybackDiagnostics['export']> { return this.diagnostics.export() }

  private cancelledSyncResult(): AutoSyncRunResult {
    return { phase: 'failed', dryRun: false, estimate: null, plan: null, applied: false,
      failure: { kind: 'cancelled', message: '自动对齐已取消' }, divergence: null,
      samples: { official: 0, commentary: 0 }, jumps: { official: 0, commentary: 0 },
      startedAt: this.now(), finishedAt: this.now() }
  }

  /** Measure only. Allowed even when auto-apply has been revoked. */
  async measureOnce(): Promise<AutoSyncRunResult> {
    this.cancelLiveCatchup(false)
    const result = await this.autoSync.dryRun(this.applied)
    this.reportAutoResult(result)
    return result
  }

  async syncNow(options?: { silentSuccess?: boolean }): Promise<AutoSyncRunResult> {
    return this.executeSync(true, options)
  }

  /** Recovery shares the controller's scheduler gate, without granting authorization. */
  private async executeSync(authorize: boolean, options?: { silentSuccess?: boolean }): Promise<AutoSyncRunResult> {
    if (!authorize && (!this.autoSync.autoApplyAuthorized || this.autoSync.isRunning)) return this.cancelledSyncResult()
    this.cancelLiveCatchup(false)
    const revision = ++this.autoRequestRevision
    if (this.offsetDrain) await this.offsetDrain
    if (revision !== this.autoRequestRevision || this.disposed
      || (!authorize && !this.autoSync.autoApplyAuthorized)) return this.cancelledSyncResult()
    if (authorize) this.autoSync.authorize()
    const result = await this.autoSync.run(this.applied, authorize ? 'manual' : 'silent')
    if (revision !== this.autoRequestRevision || this.disposed) return result
    if (result.appliedRewind || result.applied) {
      // The controller seeked through the engine, so the engine is authoritative for
      // where the sources ended up.
      this.applied = { ...(result.appliedRewind ?? result.plan?.rewindAfter ?? this.applied) }
      this.requestedOffset = result.failure?.kind === 'buffer-limit' && result.estimate
        ? result.estimate.totalOffsetSeconds : offsetFromRewind(this.applied)
      this.planValue = result.plan
    }
    if (authorize) this.reportAutoResult(result, options)
    this.notify()
    return result
  }

  private reportAutoResult(result: AutoSyncRunResult, options?: { silentSuccess?: boolean }): void {
    if (result.failure) {
      this.notice(result.failure.kind === 'cancelled' ? 'info' : 'warn', result.failure.message, result.failure)
      return
    }
    if (options?.silentSuccess && !result.dryRun) return
    const estimate = result.estimate
    if (!estimate) return
    const difference = estimate.residualSeconds
    this.notice(
      'info',
      result.dryRun
        ? `仅测量，未调整；当前相差 ${Math.abs(difference).toFixed(2)} 秒`
        : '已自动对齐',
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

  /** 2 s or 3 s, per the sync design: long enough to catch a tick, short enough to feel live. */
  setDetectWindow(seconds: number): void {
    this.updateSettings({ detectWindowSeconds: seconds })
    this.autoSync.configure({ detectWindowSeconds: FRAME_MATCH_WINDOW_SECONDS })
  }

  setSeekThreshold(seconds: number): void {
    const threshold = Math.max(0.2, Math.min(2, seconds))
    this.updateSettings({ seekThresholdSeconds: threshold })
    this.autoSync.configure({ seekThresholdSeconds: threshold })
  }

  private invalidateAutomaticWork(role: SourceRole): void {
    this.frameSampler?.dispose()
    this.frameSampler = null
    this.pendingCodecFallbackRemount.delete(role)
    this.proxyInstabilityAt[role] = []
    if (this.huyaFallbackPromptValue?.role === role) this.huyaFallbackPromptValue = null
    this.playbackRecovery = null
    this.diagnostics.reset(role)
    this.continuity[role] = 0
    this.resetPlaybackObservation()
    ++this.autoRequestRevision
    this.autoSync.cancel(false)
  }

  /** Abort an in-flight run; the button that calls this is the user's stop control. */
  cancelAutoSync(): void {
    ++this.autoRequestRevision
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
   * Subscribe through main's shared room relay. Messages are scheduled against
   * commentary media time so rewinding commentary also delays its danmaku.
   */
  connectDanmaku(room: string, origin: DanmakuSelection['origin'] = 'manual', name?: string): void {
    const selection = { room, origin, name }
    if (this.isDanmakuRoom(room)) {
      this.danmakuSelection = selection
      this.danmakuState = { ...this.danmakuState, roomName: name ?? this.danmakuState.roomName }
      this.notify()
      return
    }
    this.subscribeDanmaku(selection)
  }

  private subscribeDanmaku(selection: DanmakuSelection): void {
    this.disconnectDanmaku()
    if (this.suspended) { this.parkedDanmakuRoom = selection; return }
    this.danmakuSelection = selection
    const room = selection.canonicalRoom ?? selection.room
    const generation = this.danmakuGeneration
    this.danmakuState = { ...this.danmakuState, room, roomName: selection.name ?? danmakuRoom(selection.room).room, error: null }
    try {
      this.unsubscribeDanmaku = apiClient.subscribeDanmaku(room, ({ event, data }) => {
        if (generation !== this.danmakuGeneration) return
        if (event === 'danmaku') this.ingestDanmaku(data)
        else if (event === 'state') this.ingestDanmakuState(data)
        else if (event === 'room-signal') this.ingestBilibiliSignal(data)
        else if (event === 'huya-on-tv') {
          const snapshot = readHuyaOnTvSnapshot(data, this.danmakuState.room)
          if (snapshot && this.danmakuState.connected) {
            this.danmakuState = { ...this.danmakuState, huyaOnTv: snapshot }
            this.notify()
          }
        }
        else if (event === 'error') {
          this.danmakuState = { ...this.danmakuState, connected: false, huyaOnTv: null, bilibiliSuperChats: undefined, error: '弹幕连接中断，正在重试', errorDetail: errorDetails(data) }
          this.notify()
        }
      })
    } catch (error) {
      this.danmakuState = {
        ...this.danmakuState,
        connected: false,
        error: '弹幕连接失败，请重试',
        errorDetail: errorDetails(error),
      }
    }
    this.notify()
  }

  isDanmakuRoom(room: string): boolean {
    return this.danmakuState.room === room || this.danmakuSelection?.room === room
  }

  async retryDanmaku(room: string): Promise<void> {
    const selection = this.danmakuSelection
    const activeRoom = this.danmakuState.room
    if (!selection || !activeRoom || !this.isDanmakuRoom(room)) return
    try {
      const result = await apiClient.reconnectDanmaku(activeRoom)
      if (selection !== this.danmakuSelection || result.ok) return
      if (result.code === 'room-not-subscribed') {
        this.subscribeDanmaku({ ...selection, canonicalRoom: activeRoom })
      } else this.notice('warn', result.message, result)
    } catch (error) {
      if (selection === this.danmakuSelection) this.notice('warn', '弹幕重连失败，请稍后重试', error)
    }
  }

  hasManualDanmakuRoom(): boolean {
    return (this.danmakuSelection ?? this.parkedDanmakuRoom)?.origin === 'manual'
  }

  private automaticDanmakuOrigin(): SourceRole | null {
    const origin = (this.danmakuSelection ?? this.parkedDanmakuRoom)?.origin
    return origin === 'official' || origin === 'commentary' ? origin : null
  }

  private autoDanmakuRole(): SourceRole {
    return this.changingSources.has('commentary') || this.engine.getState().commentary.descriptor ? 'commentary' : 'official'
  }

  private disconnectAutoDanmakuForChange(role: SourceRole, replacing = true): void {
    const origin = this.automaticDanmakuOrigin()
    if (origin && (role === origin || replacing && role === 'commentary')) this.disconnectDanmaku()
  }

  private syncAutoDanmaku(): void {
    if (this.disposed || this.hasManualDanmakuRoom()) return
    const role = this.autoDanmakuRole()
    const state = this.engine.getState()[role]
    if (this.changingSources.has(role)) return
    if (this.suspended) { this.pendingAutoDanmaku = true; return }
    this.pendingAutoDanmaku = state.status === 'loading'
    const room = state.status === 'ready' ? sourceDanmakuRoom(state.descriptor) : null
    if (room && (!this.isDanmakuRoom(room.key) || this.automaticDanmakuOrigin() !== role)) {
      this.connectDanmaku(room.key, role, room.name)
    }
  }

  disconnectDanmaku(): void {
    this.danmakuSelection = null
    this.parkedDanmakuRoom = null
    this.pendingAutoDanmaku = false
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
  setDouyuLotteryCommandMatcher(matcher: typeof this.matchDouyuLotteryCommand): void {
    this.matchDouyuLotteryCommand = matcher
  }

  setPlatformActivityMatcher(matcher: typeof this.matchPlatformActivity): void {
    this.matchPlatformActivity = matcher
  }

  private ingestBilibiliSignal(data: unknown): void {
    const room = this.danmakuState.room
    if (!room?.startsWith('bilibili:') || !data || typeof data !== 'object') return
    const event = data as { platform?: unknown; kind?: unknown; room?: unknown; ids?: unknown }
    if (event.platform !== 'bilibili' || event.kind !== 'super-chat-delete' || event.room !== room || !Array.isArray(event.ids)) return
    const ids = event.ids.slice(0, 512).flatMap(id => bilibiliId(id) ?? [])
    const state = this.danmakuState.bilibiliSuperChats ?? createBilibiliSuperChatState(room)
    this.danmakuState.bilibiliSuperChats = updateBilibiliSuperChats(state, {
      platform: 'bilibili', room: room as `bilibili:${string}`, kind: 'super-chat-delete', ids, receivedAt: this.now(),
    }, this.now())
    this.notify()
  }

  pushDanmaku(message: Pick<DanmakuMessage, 'text' | 'user' | 'color' | 'sender' | 'gift' | 'dms' | 'platform' | 'huyaGift' | 'system'
    | 'douyuLotteryActivityId' | 'platformActivityKey' | 'huyaChat' | 'douyin'> & BilibiliMetadata & Partial<Pick<DanmakuMessage, 'receivedAt'>>): void {
    const huya = message.platform === 'huya'
    const readOnly = isReadOnlyDanmakuPlatform(message.platform)
    const sender = readOnly ? null : normalizeDouyuSender(message.sender)
    const gift = readOnly ? null : normalizeDouyuGift(message.gift)
    const huyaGift = huya && message.huyaGift && /^[0-9]{1,20}$/.test(message.huyaGift.id)
      && Number.isSafeInteger(message.huyaGift.count) && message.huyaGift.count > 0
      ? { id: message.huyaGift.id, count: message.huyaGift.count,
        ...(typeof message.huyaGift.name === 'string' && message.huyaGift.name.length <= 256 ? { name: message.huyaGift.name } : {}) } : null
    if (message.gift !== undefined && !gift) return
    if (message.huyaGift !== undefined && !huyaGift) return
    const bilibili = message.platform === 'bilibili' ? copyBilibiliMetadata(message) : {}
    const isGift = !!gift || !!huyaGift || !!bilibili.bilibiliGift || message.douyin?.method === 'WebcastGiftMessage'
    const announcement = message.douyin?.method === 'WebcastRoomMessage'
    if (message.system && !isGift && !bilibili.superChat && !announcement) return
    if (isGift) {
      if (!this.settingsValue.danmaku.showGifts) return
      // Gift notices keep media-time alignment and user blocking, but are not chat text.
      const user = message.user.trim().toLowerCase()
      if (this.settingsValue.danmaku.filter.blockedUsers.some(blocked => blocked.trim().toLowerCase() === user)) return
    } else if (this.filter.reject(message)) return
    const density = this.settingsValue.danmaku.density
    // Sampling on arrival, not on render: a dropped message never occupies a lane, so
    // density behaves as a real load control rather than a visual one.
    if (!isGift && density < 1 && Math.random() > density) return
    const snapshot = this.engine.snapshot('commentary')
    const scheduleTime = snapshot
      ? scheduleTimeFor(snapshot, { clock: this.liveEdge, nowMs: this.now() })
      : this.timeline.playhead
    this.timeline.push({
      id: `d${++this.noticeSeq}`,
      text: message.text,
      user: message.user,
      color: message.color,
      ...(message.platform ? { platform: message.platform } : {}),
      ...(isGift || announcement ? { system: true } : {}),
      ...(sender ? { sender } : {}),
      ...(gift ? { gift } : {}),
      ...(huyaGift ? { huyaGift } : {}),
      ...bilibili,
      ...(message.huyaChat ? { huyaChat: message.huyaChat } : {}),
      ...(message.douyin ? { douyin: message.douyin } : {}),
      ...(message.platformActivityKey ? { platformActivityKey: message.platformActivityKey } : {}),
      ...(message.douyuLotteryActivityId ? { douyuLotteryActivityId: message.douyuLotteryActivityId } : {}),
      ...(!readOnly && typeof message.dms === 'number' && Number.isFinite(message.dms) ? { dms: message.dms } : {}),
      scheduleTime,
      room: this.danmakuState.room ?? undefined,
      receivedAt: message.receivedAt ?? this.now(),
    })
  }

  private ingestDanmaku(data: unknown): void {
    if (!data || typeof data !== 'object') return
    const payload = data as Partial<ChatMessage>
    if (typeof payload.text !== 'string' || payload.text.length === 0) return
    const platform = payload.platform ?? 'douyu'
    if (platform !== danmakuRoom(this.danmakuState.room ?? '').platform
      || (payload.room !== undefined && payload.room !== this.danmakuState.room)) return
    if (platform === 'douyin' && (payload.room !== this.danmakuState.room || payload.gift || payload.huyaGift
      || (payload.system && payload.douyin?.method !== 'WebcastGiftMessage' && payload.douyin?.method !== 'WebcastRoomMessage'))) return
    const receivedAt = typeof payload.receivedAt === 'number' && Number.isSafeInteger(payload.receivedAt) && payload.receivedAt >= 0
      ? payload.receivedAt : undefined
    if (isReadOnlyDanmakuPlatform(platform)) {
      const bilibili = platform === 'bilibili' ? copyBilibiliMetadata(payload) : {}
      const huya = platform === 'huya' ? readHuyaChatMetadata(payload.huyaChat) : null
      const douyin = platform === 'douyin' && payload.douyin ? payload.douyin : undefined
      const platformActivityKey = this.danmakuState.connected && receivedAt !== undefined && typeof payload.room === 'string'
        ? this.matchPlatformActivity?.(payload as ChatMessage) : null
      this.pushDanmaku({
        text: payload.text,
        user: typeof payload.username === 'string' ? payload.username.trim() || '匿名' : '匿名',
        color: platform === 'bilibili' ? bilibiliColor(payload.color) : huyaChatColorHex(huya?.bulletColor) ?? colorForIndex(0), platform, receivedAt,
        ...bilibili,
        ...(huya ? { huyaChat: huya } : {}),
        ...(douyin ? { douyin } : {}),
        ...(platformActivityKey ? { platformActivityKey } : {}),
        ...(payload.system === true ? { system: true } : {}),
        ...(platform === 'huya' && payload.huyaGift !== undefined ? { huyaGift: payload.huyaGift } : {}),
      })
      return
    }
    const gift = normalizeDouyuGift(payload.gift)
    if ((payload.system === true || payload.gift !== undefined) && !gift) return
    const sender = normalizeDouyuSender(payload.sender)
    const douyuLotteryActivityId = this.danmakuState.connected && !gift && typeof payload.room === 'string' && receivedAt !== undefined
      ? this.matchDouyuLotteryCommand?.({ room: payload.room, text: payload.text, receivedAt }) : null
    this.pushDanmaku({
      text: payload.text,
      user: typeof payload.username === 'string' ? payload.username.trim() || '匿名' : '匿名',
      color: colorForIndex(typeof payload.color === 'number' ? payload.color : 0),
      platform, receivedAt,
      ...(douyuLotteryActivityId ? { douyuLotteryActivityId } : {}),
      ...(sender ? { sender } : {}),
      ...(gift ? { gift } : {}),
      ...(typeof payload.dms === 'number' && Number.isFinite(payload.dms) ? { dms: payload.dms } : {}),
    })
  }

  /** Connection status describes the upstream room, not just the local IPC channel. */
  private ingestDanmakuState(data: unknown): void {
    if (!data || typeof data !== 'object') return
    const payload = data as { state?: unknown; detail?: unknown; errorDetail?: unknown; room?: unknown }
    const state = typeof payload.state === 'string' ? payload.state : ''
    const detail = typeof payload.detail === 'string' ? payload.detail : null
    const connected = state === 'connected'
    if (this.danmakuState.room?.startsWith('douyin:') && payload.room !== undefined && payload.room !== this.danmakuState.room) return
    if (connected && !this.danmakuState.connected) this.danmakuConnectionRevision++
    this.danmakuState = {
      ...this.danmakuState,
      connected,
      connectionRevision: this.danmakuConnectionRevision,
      ...(!connected ? { huyaOnTv: null } : {}),
      ...(typeof payload.room === 'string'
        && (this.danmakuState.room?.startsWith('douyin:') ? /^douyin:[1-9][0-9]{0,19}$/
          : this.danmakuState.room?.startsWith('huya:') ? /^huya:[1-9][0-9]{0,15}$/
            : this.danmakuState.room?.startsWith('bilibili:') ? /^bilibili:[1-9][0-9]{0,11}$/ : /^[1-9][0-9]{0,11}$/).test(payload.room)
        ? { room: payload.room } : {}),
      error: connected ? null : (detail ?? DANMAKU_STATE_TEXT[state] ?? this.danmakuState.error),
      errorDetail: connected ? undefined : errorDetails(payload.errorDetail ?? { state, detail: payload.detail }),
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
      if (message.superChat && message.room?.startsWith('bilibili:')) {
        const room = message.room as `bilibili:${string}`
        const state = this.danmakuState.bilibiliSuperChats ?? createBilibiliSuperChatState(room)
        this.danmakuState.bilibiliSuperChats = updateBilibiliSuperChats(state, {
          ...copyBilibiliMetadata(message), id: message.id, text: message.text, username: message.user,
          platform: 'bilibili', room, color: 0, level: 0, system: false, receivedAt: message.receivedAt,
        }, this.now())
        this.notify()
        continue
      }
      const result = this.danmakuProcessor.process(message, mediaTime)
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
    this.suspended = true
    this.cancelLiveCatchup(false)
    this.stopPlaybackObservation()
    // Remembered so the next boot reconnects it: the room is part of what was loaded.
    const parkedDanmakuRoom = this.danmakuSelection
      ? { ...this.danmakuSelection, canonicalRoom: this.danmakuState.room ?? undefined }
      : this.parkedDanmakuRoom
    const pendingAutoDanmaku = this.pendingAutoDanmaku
    ++this.autoRequestRevision
    this.stopScheduler()
    // `false`: leaving the page is not the manual intervention that revokes auto-apply,
    // so coming back must not report 「手动调整过偏移」 the user never made.
    this.autoSync.cancel(false)
    this.disconnectDanmaku()
    this.parkedDanmakuRoom = parkedDanmakuRoom
    this.pendingAutoDanmaku = pendingAutoDanmaku
  }

  /** Tear the session down for good. Only its owner may call this. */
  dispose(): void {
    if (this.disposed) return
    this.cancelLiveCatchup(false)
    this.stopPlaybackObservation()
    this.releaseFeatures?.()
    this.invalidateOffsetRequests()
    this.disposed = true
    this.releaseBuffer?.()
    for (const timer of this.pictureTimers) clearTimeout(timer)
    for (const cancel of this.pendingQualityWaits) cancel()
    for (const role of SOURCE_ROLES) {
      ++this.sourceGeneration[role]
      if (this.engine.getState()[role].descriptor?.url.includes('/buffer/')) void apiClient.stopBuffer(role)
    }
    this.stopScheduler()
    this.disconnectDanmaku()
    this.autoSync.dispose()
    this.frameSampler?.dispose()
    this.engine.dispose()
    this.listeners.clear()
  }
}

export function roleName(role: SourceRole): string {
  return role === 'official' ? '画面' : '解说'
}

function currentBufferedEnd(video: HTMLVideoElement): number | null {
  const { buffered, currentTime } = video
  if (!buffered || buffered.length === 0) return null
  for (let index = 0; index < buffered.length; index += 1) {
    if (currentTime >= buffered.start(index) - 0.25 && currentTime <= buffered.end(index)) {
      return buffered.end(index)
    }
  }
  return null
}

function describeBufferLimit(plan: OffsetPlan): string {
  const clamped = plan.seeks.find(seek => seek.clamped)
  const who = clamped ? roleName(clamped.role) : ''
  const missing = Math.abs(plan.requestedOffset - plan.effectiveOffset)
  return missing >= 0.1
    ? `${who}缓冲不足，还差 ${missing.toFixed(1)} 秒未调完，继续播放等一会儿再试（请勿刷新）`
    : `${who}缓冲不足，未完全调整，继续播放等一会儿再试（请勿刷新）`
}

/** Re-exported so components do not each import from three modules. */
export { SOURCE_ROLES, DEFAULT_SETTINGS, saveSettings, planOffsetChange, scheduleTimeFor }
export type { AppliedRewind, DanmakuMessage, MediaDescriptor, SourceRole }
