/**
 * Owns the two <video> elements, outside React.
 *
 * The main/preview swap moves a source between two very different boxes on screen.
 * If React owned the elements, that swap would unmount and remount them: the buffer
 * would be thrown away, hls.js would re-attach, and the playhead would jump — which
 * destroys the very thing this app measures. So the elements are created once here
 * and only ever moved between mount points with `appendChild`, which keeps decoding,
 * buffering and the playhead untouched.
 *
 * The engine also happens to be exactly the three things `AutoSyncDeps` needs
 * (`video`, `snapshot`, `seek`), so automatic sync binds straight to it.
 */

import type { MediaDescriptor, MediaSnapshot, SourceRole, Timebase } from '../core/types'
import { SOURCE_ROLES } from '../core/types'
import { attachMedia, type AttachMode, type MediaAttachment, type MediaError } from './hlsController'
import { AUTO_QUALITY, type QualityOption } from './quality'
import { clampSeek, readTimebase, seekReached, SEEK_TOLERANCE_SECONDS } from './timebase'

export type RoleStatus = 'empty' | 'loading' | 'ready' | 'error'

export interface RoleState {
  role: SourceRole
  descriptor: MediaDescriptor | null
  status: RoleStatus
  error: MediaError | null
  timebase: Timebase | null
  currentTime: number
  paused: boolean
  /** Stalled waiting for data, as opposed to deliberately paused. */
  buffering: boolean
  seeking: boolean
  /**
   * End of the buffered range containing the playhead, in media time.
   *
   * Only the range under the playhead is useful to a progress bar: `buffered` can hold
   * several disjoint ranges after seeking around, and the last one may sit far ahead of
   * where playback actually is.
   */
  bufferedEnd: number
  volume: number
  muted: boolean
  quality: QualityOption[]
  /** -1 means automatic level selection. */
  level: number
  /** Level hls.js actually picked while on automatic. */
  autoLevel: number
  isLive: boolean
  attachMode: AttachMode | null
}

export type EngineState = Record<SourceRole, RoleState>

export interface MediaEngineOptions {
  /** How long a seek may take before it is reported as failed. */
  seekTimeoutMs?: number
  seekToleranceSeconds?: number
}

/** A live stream that has to re-buffer after a rewind can take a while to answer. */
const DEFAULT_SEEK_TIMEOUT_MS = 8000

/** Events that can change anything the UI shows about a source. */
const MEDIA_EVENTS = [
  'loadedmetadata',
  'durationchange',
  'progress',
  'timeupdate',
  'play',
  'pause',
  'playing',
  'waiting',
  'stalled',
  'seeking',
  'seeked',
  'ratechange',
  'volumechange',
  'ended',
  'emptied',
] as const

function initialRoleState(role: SourceRole): RoleState {
  return {
    role,
    descriptor: null,
    status: 'empty',
    error: null,
    timebase: null,
    currentTime: 0,
    paused: true,
    buffering: false,
    seeking: false,
    bufferedEnd: 0,
    // Both sources start muted: two streams playing at once would be unusable, and
    // the commentary track is unmuted explicitly once the user picks an audio source.
    volume: 1,
    muted: true,
    quality: [AUTO_QUALITY],
    level: -1,
    autoLevel: -1,
    isLive: false,
    attachMode: null,
  }
}

/**
 * End of the buffered range covering `time`, or `time` itself when none does.
 *
 * A small tolerance on the start bound keeps the answer stable: right after a seek the
 * playhead can sit a few milliseconds before the range that was just filled for it.
 */
function bufferedEndAt(buffered: TimeRanges, time: number): number {
  for (let index = 0; index < buffered.length; index += 1) {
    if (time >= buffered.start(index) - 0.25 && time <= buffered.end(index)) {
      return buffered.end(index)
    }
  }
  return time
}

function createElement(role: SourceRole): HTMLVideoElement {
  const video = document.createElement('video')
  video.dataset.role = role
  video.playsInline = true
  video.preload = 'auto'
  video.muted = true
  // Frames are read back into a canvas for countdown recognition; without this a
  // cross-origin frame taints the canvas and `getImageData` throws.
  video.crossOrigin = 'anonymous'
  video.className = 'media-element'
  return video
}

/** Runtime bits that are not part of the observable state. */
interface RoleRuntime {
  element: HTMLVideoElement
  attachment: MediaAttachment | null
  attachmentAbort: AbortController | null
  /** Bumped on every load/unload so a slow attach cannot revive a stale source. */
  generation: number
  liveHint: boolean | undefined
  detach: (() => void) | null
  pendingSeek: {
    target: number
    settle: (ok: boolean) => void
    timer: ReturnType<typeof setTimeout>
  } | null
}

export class MediaEngine {
  private readonly state: EngineState
  private readonly runtime: Map<SourceRole, RoleRuntime> = new Map()
  private readonly listeners = new Set<(state: EngineState) => void>()
  private readonly seekTimeoutMs: number
  private readonly seekTolerance: number
  private notifyQueued = false
  private disposed = false

  constructor(options: MediaEngineOptions = {}) {
    this.seekTimeoutMs = options.seekTimeoutMs ?? DEFAULT_SEEK_TIMEOUT_MS
    this.seekTolerance = options.seekToleranceSeconds ?? SEEK_TOLERANCE_SECONDS
    this.state = {
      official: initialRoleState('official'),
      commentary: initialRoleState('commentary'),
    }
    for (const role of SOURCE_ROLES) {
      const element = createElement(role)
      const runtime: RoleRuntime = {
        element,
        attachment: null,
        attachmentAbort: null,
        generation: 0,
        liveHint: undefined,
        detach: null,
        pendingSeek: null,
      }
      runtime.detach = this.listen(role, element)
      this.runtime.set(role, runtime)
    }
  }

  private listen(role: SourceRole, element: HTMLVideoElement): () => void {
    const onEvent = (event: Event) => {
      if (event.type === 'seeked') this.resolveSeek(role)
      this.readElement(role)
    }
    for (const type of MEDIA_EVENTS) element.addEventListener(type, onEvent)
    return () => {
      for (const type of MEDIA_EVENTS) element.removeEventListener(type, onEvent)
    }
  }

  /** Pull everything observable off the element into state, then notify. */
  private readElement(role: SourceRole): void {
    const runtime = this.runtime.get(role)
    if (!runtime || this.disposed) return
    const { element } = runtime
    const previous = this.state[role]
    if (previous.status === 'empty') {
      // Volume and mute live on the element, which exists long before a source does, and the
      // overlay's sliders are live from first paint. Skipping them here left the slider
      // snapping back to 0 with a 🔇 icon while the level was in fact taken. Everything below
      // would only be a guess without media, so the empty state takes the audio fields alone.
      if (previous.volume === element.volume && previous.muted === element.muted) return
      this.state[role] = { ...previous, volume: element.volume, muted: element.muted }
      this.notify()
      return
    }

    const timebase = readTimebase(element, runtime.liveHint)
    this.state[role] = {
      ...previous,
      timebase,
      currentTime: element.currentTime,
      paused: element.paused,
      // `readyState` below HAVE_FUTURE_DATA while unpaused is a stall, not a pause.
      buffering: !element.paused && element.readyState < element.HAVE_FUTURE_DATA,
      seeking: element.seeking,
      bufferedEnd: bufferedEndAt(element.buffered, element.currentTime),
      volume: element.volume,
      muted: element.muted,
      isLive: timebase?.kind === 'live',
      // Metadata arriving is what turns a loading source into a usable one.
      status:
        previous.status === 'loading' && element.readyState >= element.HAVE_METADATA
          ? 'ready'
          : previous.status,
    }
    this.notify()
  }

  /**
   * Coalesce bursts into one notification. `progress` and `timeupdate` fire several
   * times per second per source; re-rendering the whole page each time is waste.
   */
  private notify(): void {
    if (this.notifyQueued || this.disposed) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      if (this.disposed) return
      const snapshot = this.getState()
      for (const listener of this.listeners) listener(snapshot)
    })
  }

  getState(): EngineState {
    return { official: this.state.official, commentary: this.state.commentary }
  }

  subscribe(listener: (state: EngineState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The recognition sampler grabs frames straight off these. */
  element(role: SourceRole): HTMLVideoElement {
    const runtime = this.runtime.get(role)
    if (!runtime) throw new Error(`unknown role: ${role}`)
    return runtime.element
  }

  /**
   * Move a role's element into `container`. Called on every main/preview swap;
   * `appendChild` relocates the node without tearing down its media state.
   */
  mount(role: SourceRole, container: HTMLElement | null): void {
    // Tolerant rather than `element(role)`: React detaches refs while unmounting, so on a
    // disposed engine this runs with nothing left to move. A throw from a ref callback is
    // uncatchable by the component, and there is no work to do here anyway — unlike
    // `element`, which stays strict because its callers need a real element back.
    const runtime = this.runtime.get(role)
    if (!runtime) return
    const { element } = runtime
    if (!container) {
      element.remove()
      return
    }
    if (element.parentElement === container) return
    container.appendChild(element)
  }

  async load(role: SourceRole, descriptor: MediaDescriptor): Promise<void> {
    const runtime = this.runtime.get(role)
    if (!runtime || this.disposed) return
    const generation = ++runtime.generation
    this.teardown(role)
    const controller = new AbortController()
    runtime.attachmentAbort = controller
    runtime.liveHint = undefined

    this.state[role] = {
      ...this.state[role],
      descriptor,
      status: 'loading',
      error: null,
      timebase: null,
      currentTime: 0,
      quality: [AUTO_QUALITY],
      level: -1,
      autoLevel: -1,
      attachMode: null,
    }
    this.notify()

    /** A source swapped during `await attachMedia` must not be written back. */
    const current = () => runtime.generation === generation && !this.disposed

    try {
      const attachment = await attachMedia(runtime.element, descriptor, {
        onQualityOptions: (options) => {
          if (!current()) return
          this.state[role] = { ...this.state[role], quality: options }
          // Official YouTube/Twitch streams play their top rendition from the start. The list
          // is highest-first after 自动, so options[1] is it. Commentary keeps ABR: a
          // streamer's restream is what a slow connection should give up first.
          const top = options[1]
          if (top && (descriptor.platform === 'youtube' || descriptor.platform === 'twitch')) {
            queueMicrotask(() => { if (current()) this.setLevel(role, top.level) })
          }
          this.notify()
        },
        onLevelSwitch: (level, autoLevel) => {
          if (!current()) return
          this.state[role] = { ...this.state[role], level, autoLevel }
          this.notify()
        },
        onError: (error) => {
          if (!current()) return
          this.state[role] = {
            ...this.state[role],
            error,
            // A non-fatal error is recoverable, so the source stays usable.
            status: error.fatal ? 'error' : this.state[role].status,
          }
          this.notify()
        },
        onLiveHint: (isLive) => {
          if (!current()) return
          runtime.liveHint = isLive
          this.readElement(role)
        },
        onRecovered: () => {
          if (!current() || this.state[role].status !== 'error') return
          this.state[role] = { ...this.state[role], error: null, status: 'loading' }
          this.readElement(role)
        },
      }, controller.signal)
      if (!current()) {
        attachment.destroy()
        return
      }
      runtime.attachment = attachment
      this.state[role] = { ...this.state[role], attachMode: attachment.mode }
      this.readElement(role)
    } catch (error) {
      if (!current()) return
      this.state[role] = {
        ...this.state[role],
        status: 'error',
        error: {
          fatal: true,
          message: error instanceof Error ? error.message : '加载失败',
          hint: '检查地址是否可访问，或改用媒体代理。',
        },
      }
      this.notify()
    }
  }

  /** Release the attachment and the element's buffer, keeping the element itself. */
  private teardown(role: SourceRole): void {
    const runtime = this.runtime.get(role)
    if (!runtime) return
    this.resolveSeek(role, false)
    runtime.attachmentAbort?.abort()
    runtime.attachmentAbort = null
    runtime.attachment?.destroy()
    runtime.attachment = null
    runtime.element.pause()
    runtime.element.playbackRate = 1
    runtime.element.removeAttribute('src')
    // Without an explicit load() the old buffer is kept and the next source can
    // briefly show the previous frame.
    runtime.element.load()
  }

  unload(role: SourceRole): void {
    const runtime = this.runtime.get(role)
    if (!runtime) return
    runtime.generation += 1
    this.teardown(role)
    runtime.liveHint = undefined
    this.state[role] = {
      ...initialRoleState(role),
      volume: this.state[role].volume,
      muted: this.state[role].muted,
    }
    this.notify()
  }

  snapshot(role: SourceRole): MediaSnapshot | null {
    const runtime = this.runtime.get(role)
    if (!runtime) return null
    const state = this.state[role]
    if (!state.descriptor) return null
    const timebase = readTimebase(runtime.element, runtime.liveHint)
    if (!timebase) return null
    return {
      role,
      currentTime: runtime.element.currentTime,
      timebase,
      ready: state.status === 'ready' && runtime.element.readyState >= runtime.element.HAVE_METADATA,
    }
  }

  /**
   * Seek and report whether the element actually got there.
   *
   * `AutoSyncDeps.seek` awaits this and refuses to claim an alignment on a false, so
   * "resolved" has to mean "confirmed by a `seeked` event landing within tolerance",
   * never "we assigned currentTime and hoped". A target outside the DVR window is
   * clamped first — the shortfall is the plan's business, not the element's.
   */
  seek(role: SourceRole, target: number): Promise<boolean> {
    const runtime = this.runtime.get(role)
    if (!runtime || this.disposed) return Promise.resolve(false)
    const { element } = runtime
    if (element.readyState < element.HAVE_METADATA) return Promise.resolve(false)
    const timebase = readTimebase(element, runtime.liveHint)
    if (!timebase) return Promise.resolve(false)

    const { target: clamped } = clampSeek(target, timebase)
    // A no-op seek fires no `seeked` event in some browsers, so it would hang.
    if (seekReached(element.currentTime, clamped, this.seekTolerance) && !element.seeking) {
      return Promise.resolve(true)
    }

    // A superseded seek is not a success: whoever awaited it asked for a position
    // this element is no longer heading to.
    this.resolveSeek(role, false)

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        runtime.pendingSeek = null
        resolve(false)
      }, this.seekTimeoutMs)
      runtime.pendingSeek = {
        target: clamped,
        timer,
        settle: (ok) => {
          clearTimeout(timer)
          resolve(ok)
        },
      }
      try {
        element.currentTime = clamped
      } catch {
        runtime.pendingSeek = null
        clearTimeout(timer)
        resolve(false)
      }
    })
  }

  /** Settle a pending seek. `ok` omitted means "judge it by where we landed". */
  private resolveSeek(role: SourceRole, ok?: boolean): void {
    const runtime = this.runtime.get(role)
    const pending = runtime?.pendingSeek
    if (!runtime || !pending) return
    runtime.pendingSeek = null
    pending.settle(
      ok ?? seekReached(runtime.element.currentTime, pending.target, this.seekTolerance),
    )
  }

  /**
   * Start or stop both sources together. Playing them separately would drift them
   * apart by however long the user took between the two clicks.
   */
  async setPlaying(playing: boolean): Promise<void> {
    const targets = SOURCE_ROLES.filter((role) => this.state[role].descriptor !== null)
    if (!playing) {
      for (const role of targets) this.element(role).pause()
      return
    }
    const results = await Promise.allSettled(targets.map((role) => this.element(role).play()))
    results.forEach((result, index) => {
      const role = targets[index]
      if (result.status !== 'rejected' || !role) return
      // Autoplay is the usual cause, and it is the user's to fix, not a load failure.
      this.state[role] = {
        ...this.state[role],
        error: {
          fatal: false,
          message: '浏览器拒绝了自动播放。',
          hint: '点击播放按钮，或在站点设置中允许该页面播放媒体。',
        },
      }
      this.notify()
    })
  }

  setVolume(role: SourceRole, volume: number): void {
    const element = this.element(role)
    element.volume = Math.min(1, Math.max(0, volume))
    // Raising the volume of a muted source looks broken, so unmute with it.
    if (element.volume > 0 && element.muted) element.muted = false
    this.readElement(role)
  }

  setMuted(role: SourceRole, muted: boolean): void {
    this.element(role).muted = muted
    this.readElement(role)
  }

  /** Exactly one source carries audio; the other is always muted. */
  setAudioRole(role: SourceRole): void {
    for (const candidate of SOURCE_ROLES) {
      this.element(candidate).muted = candidate !== role
    }
    for (const candidate of SOURCE_ROLES) this.readElement(candidate)
  }

  setLevel(role: SourceRole, level: number): void {
    const runtime = this.runtime.get(role)
    if (!runtime) return
    runtime.attachment?.setLevel(level)
    this.state[role] = { ...this.state[role], level }
    this.notify()
  }

  seekToLive(role: SourceRole): void {
    this.runtime.get(role)?.attachment?.seekToLive()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const role of SOURCE_ROLES) {
      const runtime = this.runtime.get(role)
      if (!runtime) continue
      this.resolveSeek(role, false)
      runtime.element.playbackRate = 1
      runtime.attachmentAbort?.abort()
      runtime.attachmentAbort = null
      runtime.attachment?.destroy()
      runtime.detach?.()
      runtime.element.remove()
    }
    this.runtime.clear()
    this.listeners.clear()
  }
}
