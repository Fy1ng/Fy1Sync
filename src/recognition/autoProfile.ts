/** Source-local discovery and consent. Saved profiles are never mutated here. */
import type { RecognitionProfile, RoiRect } from '../core/profileSchema'
import { SOURCE_ROLES, type RecognitionOutcome, type SourceRole } from '../core/types'
import { RecognitionClient, type WorkerLike } from './client'
import { FrameGrabber, FULL_FRAME_ROI, startFrameLoop, type GrabbedFrame } from './frameGrabber'
import type { LearnResult, LocateResult } from './protocol'

export type AutoProfilePhase = 'idle' | 'locating' | 'learning' | 'ready' | 'not-found' | 'unsupported' | 'cancelled'
export interface AutoProfileState {
  phase: AutoProfilePhase
  candidate: RecognitionProfile | null
  accepted: boolean
  confidence: number
  learnedChars: string[]
  reason: string | null
}
export const AUTO_PROFILE_TEXT: Record<AutoProfilePhase, string> = {
  idle: '等待识别', locating: '定位中', learning: '学习中', ready: '已就绪',
  'not-found': '未找到倒计时', unsupported: '需要手动预设', cancelled: '已取消',
}
export const CLOCK_LOST_MS = 3000
export const AUTO_PROFILE_WINDOW_MS = 12_000

interface DiscoveryClient {
  locate(frames: GrabbedFrame[], options?: { retainForLearning?: boolean }): Promise<LocateResult>
  learn(frames: GrabbedFrame[], roi: RoiRect, options?: { windowId?: number }): Promise<LearnResult>
  cancel(): unknown
  dispose(): void
}
export interface AutoProfileDeps {
  client: (role: SourceRole) => DiscoveryClient
  capture: (role: SourceRole, signal: { aborted: boolean }) => Promise<GrabbedFrame[]>
  use: (role: SourceRole, profile: RecognitionProfile) => void
  changed?: () => void
  now?: () => number
}
interface Run { signal: { aborted: boolean }; promise: Promise<boolean>; finish: (accepted: boolean) => void }

export class AutoProfileController {
  private states: Record<SourceRole, AutoProfileState> = { official: initialAutoProfileState(), commentary: initialAutoProfileState() }
  private runs = new Map<SourceRole, Run>()
  private lostSince: Partial<Record<SourceRole, number>> = {}
  private retryAfter: Partial<Record<SourceRole, number>> = {}
  private disposed = false
  private readonly now: () => number
  constructor(private readonly deps: AutoProfileDeps) { this.now = deps.now ?? Date.now }
  state(role: SourceRole): AutoProfileState { return this.states[role] }
  get busy(): boolean { return this.runs.size > 0 }

  acquire(role: SourceRole): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    const pending = this.runs.get(role)
    if (pending) return pending.promise
    let finish!: (accepted: boolean) => void
    const promise = new Promise<boolean>(resolve => { finish = resolve })
    const run: Run = { signal: { aborted: false }, promise, finish }
    this.runs.set(role, run)
    this.patch(role, { phase: 'locating', reason: null })
    void this.discover(role, run)
    return promise
  }

  accept(role: SourceRole): void {
    const state = this.states[role]
    if (state.phase !== 'ready' || !state.candidate) return
    this.deps.use(role, state.candidate)
    this.patch(role, { accepted: true })
    delete this.lostSince[role]
    delete this.retryAfter[role]
    this.finish(role, true)
  }

  cancel(role: SourceRole): void {
    const run = this.runs.get(role)
    if (run) run.signal.aborted = true
    this.deps.client(role).cancel()
    this.patch(role, { phase: 'cancelled', reason: '已取消自动识别' })
    this.finish(role, false)
    // Cancellation suppresses background retries until a new explicit run/reset.
    this.retryAfter[role] = Infinity
  }

  reset(role: SourceRole): void {
    this.cancel(role)
    this.states[role] = initialAutoProfileState()
    delete this.lostSince[role]
    delete this.retryAfter[role]
    this.deps.changed?.()
  }

  observe(role: SourceRole, outcome: RecognitionOutcome): void {
    if (this.disposed || this.runs.has(role)) return
    if (outcome.status === 'success' && outcome.reading.confidence >= 0.82) { delete this.lostSince[role]; return }
    const now = this.now()
    this.lostSince[role] ??= now
    if (now - this.lostSince[role]! < CLOCK_LOST_MS || now < (this.retryAfter[role] ?? 0)) return
    // Existing session consent survives a scene change, not a source replacement.
    this.retryAfter[role] = now + AUTO_PROFILE_WINDOW_MS + CLOCK_LOST_MS
    void this.acquire(role)
  }

  dispose(): void {
    this.disposed = true
    for (const role of SOURCE_ROLES) this.cancel(role)
  }

  private async discover(role: SourceRole, run: Run): Promise<void> {
    const active = () => !this.disposed && !run.signal.aborted && this.runs.get(role) === run
    try {
      const frames = await this.deps.capture(role, run.signal)
      if (!active()) return
      if (frames.length < 24) { this.fail(role, '视频没有提供足够的连续画面, 请恢复两路播放后重新识别'); return }
      const client = this.deps.client(role)
      // The worker retains its bounded gray window, so learning transfers no second copy.
      const located = await client.locate(frames, { retainForLearning: true })
      if (!active()) return
      if (located.status !== 'success') { this.fail(role, located.reason, located.status === 'unsupported'); return }
      const [best, second] = located.candidates
      if (!best || best.score < 0.82) { this.fail(role, '未发现持续变化的倒计时, 请在比赛画面重试或手动编辑'); return }
      if (second && second.score >= best.score - 0.05) { this.fail(role, '发现多个相近的倒计时, 请手动选择识别区域'); return }
      this.patch(role, { phase: 'learning' })
      if (located.windowId === undefined) { this.fail(role, '当前识别引擎无法保留学习窗口, 请使用手动预设'); return }
      const learned = await client.learn([], best.roi, { windowId: located.windowId })
      if (!active()) return
      if (learned.status !== 'success') { this.fail(role, learned.reason, learned.status === 'unsupported'); return }
      if (!learned.profile || learned.report.confidence < 0.82) {
        this.fail(role, learned.report.reason ?? '字形证据不足, 请重新识别或手动编辑')
        return
      }
      const accepted = this.states[role].accepted
      const candidate = { ...learned.profile, id: `session/${role}`, name: role === 'official' ? '官方自动候选' : '解说自动候选' }
      this.patch(role, { phase: 'ready', candidate, confidence: learned.report.confidence,
        learnedChars: learned.report.learnedChars, reason: null })
      if (accepted) this.accept(role)
    } catch (error) {
      if (active()) this.fail(role, error instanceof Error ? error.message : String(error))
    }
  }
  private fail(role: SourceRole, reason: string, unsupported = false): void {
    this.deps.client(role).cancel()
    const reasons: Record<string, string> = {
      'insufficient-frames': '连续画面不足, 请恢复播放后重试',
      'invalid-frames': '采集画面不连续, 请重新识别',
      'no-glyph-sequence': '未找到稳定字形, 请手动编辑识别区域',
      'insufficient-decrements': '倒计时递减次数不足, 请在正常比赛画面重试',
      'no-consistent-countdown': '字形与倒计时顺序不一致, 请重新识别',
      'ambiguous-labels': '字形标签存在歧义, 请重新识别或手动编辑',
      // The WASM core's own spelling (crates/core/src/auto.rs); the short one is kept for the TS path.
      'ambiguous-countdown-labels': '字形标签存在歧义, 请重新识别或手动编辑',
      'auto-profile-unsupported': '当前识别后端不支持自动学习, 请使用手动预设',
      'worker-timeout': '自动识别超时, 请重新识别或使用手动预设',
      'invalid-window': '采集窗口无效, 请恢复播放后重新识别',
      'stale-window': '学习窗口已过期, 请重新识别',
      'window-unavailable': '学习窗口已释放, 请重新识别',
      'invalid-window-id': '学习窗口不匹配, 请重新识别',
    }
    const text = reasons[reason] ?? (/[\u3400-\u9fff]/u.test(reason) ? reason : '自动识别未完成, 请重新识别或使用手动预设')
    this.patch(role, { phase: unsupported ? 'unsupported' : 'not-found', reason: text })
    this.finish(role, false)
  }
  private finish(role: SourceRole, accepted: boolean): void {
    const run = this.runs.get(role)
    this.runs.delete(role)
    run?.finish(accepted)
    this.deps.changed?.()
  }
  private patch(role: SourceRole, patch: Partial<AutoProfileState>): void {
    this.states = { ...this.states, [role]: { ...this.states[role], ...patch } }
    this.deps.changed?.()
  }
}
export function initialAutoProfileState(): AutoProfileState {
  return { phase: 'idle', candidate: null, accepted: false, confidence: 0, learnedChars: [], reason: null }
}

/** Bounded video-frame windows and a sparse scene monitor, with independent workers. */
export class OnlineAutoProfiles {
  readonly controller: AutoProfileController
  private clients = new Map<SourceRole, RecognitionClient>()
  private monitors = new Map<SourceRole, () => void>()
  private disposed = false
  constructor(private readonly options: {
    createWorker: () => WorkerLike
    video: (role: SourceRole) => HTMLVideoElement | null
    profile: (role: SourceRole) => RecognitionProfile | null
    use: AutoProfileDeps['use']
    changed: () => void
  }) {
    this.controller = new AutoProfileController({
      client: role => this.client(role), capture: (role, signal) => this.capture(role, signal),
      use: (role, profile) => { options.use(role, profile); this.monitor(role) }, changed: options.changed,
    })
  }
  monitor(role: SourceRole): void {
    this.monitors.get(role)?.()
    const video = this.options.video(role)
    const profile = this.options.profile(role)
    if (!video || !profile || this.disposed) return
    const client = this.client(role)
    client.configure(profile, { automatic: profile.id.startsWith('session/') })
    const grabber = new FrameGrabber(() => performance.now())
    let last = -Infinity
    const stop = startFrameLoop(video, 4, mediaTime => {
      if (video.paused || video.seeking || this.controller.busy) return
      if (mediaTime < last) last = -Infinity
      if (mediaTime - last < 0.25 || client.busy) return
      last = mediaTime
      const frame = grabber.grab(video, this.options.profile(role)?.roi ?? profile.roi, mediaTime)
      if (frame.ok) client.submit(role, frame.frame)
    })
    this.monitors.set(role, () => { stop(); grabber.dispose(); client.cancel() })
  }
  reset(role: SourceRole): void {
    this.monitors.get(role)?.()
    this.monitors.delete(role)
    this.controller.reset(role)
  }
  suspend(): void {
    for (const stop of this.monitors.values()) stop()
    this.monitors.clear()
    for (const role of SOURCE_ROLES) if (this.controller.state(role).phase !== 'idle') this.controller.cancel(role)
  }
  dispose(): void {
    this.disposed = true
    this.suspend()
    this.controller.dispose()
    for (const client of this.clients.values()) client.dispose()
    this.clients.clear()
  }
  private client(role: SourceRole): RecognitionClient {
    let client = this.clients.get(role)
    if (!client) {
      client = new RecognitionClient({ createWorker: this.options.createWorker,
        onResult: message => this.controller.observe(role, message.outcome),
        onError: message => this.controller.observe(role, { status: 'failed', reason: 'decode-failed', detail: message }),
      })
      this.clients.set(role, client)
    }
    return client
  }
  private capture(role: SourceRole, signal: { aborted: boolean }): Promise<GrabbedFrame[]> {
    const video = this.options.video(role)
    if (!video || video.paused || video.readyState < 2) return Promise.resolve([])
    return new Promise(resolve => {
      const frames: GrabbedFrame[] = []
      const grabber = new FrameGrabber(() => performance.now())
      let last = -Infinity
      const deadline = performance.now() + AUTO_PROFILE_WINDOW_MS
      const stop = startFrameLoop(video, 8, mediaTime => {
        if (signal.aborted || video.seeking || mediaTime <= last || mediaTime - last < 0.125) return
        last = mediaTime
        const result = grabber.grabScaled(video, FULL_FRAME_ROI, 960, mediaTime)
        if (result.ok && frames.length < 100) frames.push(result.frame)
      })
      const timer = setInterval(() => {
        if (!signal.aborted && !this.disposed && performance.now() < deadline) return
        clearInterval(timer); stop(); grabber.dispose()
        resolve(signal.aborted || this.disposed ? [] : frames)
      }, 50)
    })
  }
}
