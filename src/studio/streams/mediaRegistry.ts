/**
 * One `IndependentMedia` per extra stream id, owned outside React's render so that dragging,
 * resizing, restacking or re-rendering a window never creates a second video.
 *
 * `IndependentMedia.dispose()` is final, and StrictMode runs every effect's cleanup once
 * before running the effect again. So the owner's release is deferred by a microtask and a
 * hold in the meantime cancels it: the simulated unmount keeps the same elements, and only
 * a real unmount disposes them.
 */

import type { MediaDescriptor } from '../../core/types'
import { IndependentMedia } from '../../media/independentMedia'
import type { StreamSessionView } from '../../../electron/streamSessions'

export interface MediaEntry {
  readonly media: IndependentMedia
  /** What is currently attached, so a repeated effect does not reload the same source. */
  loadedKey: string | null
  /** Counts arrivals at `ready`: a restart can hand back the same URL with a new producer. */
  readyCount: number
  lastPhase: StreamSessionView['phase'] | null
}

export class MediaRegistry {
  private readonly entries = new Map<string, MediaEntry>()
  /** Ids already disposed. Backend ids are never reused, so these never come back. */
  private readonly retired = new Set<string>()
  private holders = 0
  private pending = false
  private closed = false

  /** The entry for an id, created on first use. Null once the id was closed. */
  acquire(id: string): MediaEntry | null {
    if (this.closed || this.retired.has(id)) return null
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { media: new IndependentMedia(id), loadedKey: null, readyCount: 0, lastPhase: null }
      this.entries.set(id, entry)
    }
    return entry
  }

  peek(id: string): MediaEntry | null {
    return this.entries.get(id) ?? null
  }

  dispose(id: string): void {
    this.retired.add(id)
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    entry.media.dispose()
  }

  /** Dispose every id not in `live`. */
  retain(live: ReadonlySet<string>): void {
    for (const id of [...this.entries.keys()]) if (!live.has(id)) this.dispose(id)
  }

  hold(): void {
    this.holders += 1
    this.closed = false
  }

  release(): void {
    this.holders = Math.max(0, this.holders - 1)
    if (this.pending) return
    this.pending = true
    void Promise.resolve().then(() => {
      this.pending = false
      if (this.holders > 0) return
      this.closed = true
      for (const id of [...this.entries.keys()]) this.dispose(id)
    })
  }
}

/** Turn the backend's controlled stream into what the player attaches. */
export function descriptorFor(view: StreamSessionView, stream: NonNullable<StreamSessionView['stream']>): MediaDescriptor {
  const room = stream.sourceRoom ?? stream.danmakuRoom
  return {
    kind: stream.kind,
    url: stream.url,
    input: view.input,
    label: stream.label,
    loop: false,
    viaProxy: stream.requiresProxy,
    platform: stream.platform,
    ...(stream.qualities ? { sourceQualities: stream.qualities } : {}),
    ...(stream.quality ? { sourceQuality: stream.quality } : {}),
    ...(room ? { sourceRoom: room } : {}),
  }
}
