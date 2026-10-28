/**
 * The moving part of an overlay: scrolling danmaku nodes, their lanes and their runs.
 *
 * Both the main stage and the PiP window use it; each keeps its own subscription, filters
 * and (on the main stage) hover menu. The approach follows the mature web players rather
 * than inventing one:
 *
 * - Widths are measured, not estimated (DPlayer measures, weizhenye/Danmaku reads the box
 *   after a batched insert). A frame's new messages go into the layer in one fragment and
 *   are read back in one layout, so the lane check uses the real width with the real font,
 *   weight, emoji and count badge. An estimate that is short lets the next message into the
 *   lane early and it rides into the tail of this one.
 * - Each run is one linear Web Animation, so the compositor carries the motion.
 * - A speed change re-times the runs already on screen and the lanes with them (ArtPlayer
 *   resets the remaining path the same way); without that, faster newcomers catch slower
 *   ones in the same lane. A narrower picture pushes lane release back by the width lost.
 */

import { DanmakuLaneAllocator, estimateTextWidth, type LaneLayout } from '../core/danmakuLanes'

/** Room for the text shadow past the box, so a message is gone before its node is. */
const SHADOW_PX = 4

export interface LayerItem<T> {
  node: HTMLElement
  data: T
  /** Null where the platform has no Web Animations (jsdom). */
  run: Animation | null
  lane: number
  top: number
  /** Measured width, shadow included. */
  width: number
  /** Where the run started, the picture's right edge at spawn. */
  from: number
  /** px/s at spawn; the run's playback rate carries any later change. */
  speed: number
  held: boolean
  done: boolean
}

export interface LayerEntry<T> {
  data: T
  /** Text for the fallback width estimate where nothing is laid out (jsdom). */
  text: string
  fontSize: number
  build: () => HTMLElement
}

export class ScrollingLayer<T> {
  items: LayerItem<T>[] = []
  private readonly allocator: DanmakuLaneAllocator
  private layout: LaneLayout

  constructor(private readonly host: HTMLElement, layout: LaneLayout) {
    this.layout = layout
    this.allocator = new DanmakuLaneAllocator(layout)
  }

  setLayout(next: LaneLayout, nowMs: number): void {
    const previous = this.layout
    this.layout = next
    this.allocator.setLayout(next)
    const now = nowMs / 1000
    if (previous.speed > 0 && next.speed > 0 && previous.speed !== next.speed) {
      for (const item of this.items) item.run?.updatePlaybackRate(next.speed / item.speed)
      this.allocator.rescale(now, previous.speed / next.speed)
    }
    // A tail that had cleared the old right edge may still be past the new one.
    if (next.width < previous.width && next.speed > 0) this.allocator.delay((previous.width - next.width) / next.speed)
  }

  /** Place as many of this frame's messages as there are lanes for; the rest are dropped. */
  spawn(entries: readonly LayerEntry<T>[], nowMs: number): void {
    const { width, speed } = this.layout
    if (width <= 0 || speed <= 0 || entries.length === 0) return
    const now = nowMs / 1000
    // Build only what could get a lane: at 200 messages a second most would be thrown away.
    const taken = entries.slice(0, this.allocator.freeLanes(now))
    if (taken.length === 0) return
    const start = `translate3d(${width}px, 0, 0)`
    const nodes = taken.map((entry) => {
      const node = entry.build()
      node.style.transform = start
      node.style.visibility = 'hidden'
      return node
    })
    const fragment = document.createDocumentFragment()
    for (const node of nodes) fragment.appendChild(node)
    this.host.appendChild(fragment)
    // One layout for the whole batch: every read comes after every write.
    const widths = nodes.map((node, index) => {
      const box = node.getBoundingClientRect().width
      return Math.ceil(box > 0 ? box : estimateTextWidth(taken[index]!.text, taken[index]!.fontSize)) + SHADOW_PX
    })
    taken.forEach((entry, index) => {
      const node = nodes[index]!
      const itemWidth = widths[index]!
      const assignment = this.allocator.allocateScroll(now, itemWidth)
      if (!assignment) { node.remove(); return }
      const item: LayerItem<T> = {
        node, data: entry.data, run: null, lane: assignment.lane, top: assignment.top,
        width: itemWidth, from: width, speed, held: false, done: false,
      }
      const from = `translate3d(${width}px, ${assignment.top}px, 0)`
      node.style.transform = from
      node.style.visibility = ''
      if (typeof node.animate === 'function') {
        const run = node.animate([{ transform: from }, { transform: `translate3d(${-itemWidth}px, ${assignment.top}px, 0)` }],
          { duration: ((width + itemWidth) / speed) * 1000, easing: 'linear', fill: 'forwards' })
        // Timed from the frame that released it, so lanes stay as far apart as allocated.
        run.startTime = nowMs
        run.onfinish = () => { item.done = true; node.remove() }
        item.run = run
      }
      this.items.push(item)
    })
  }

  /**
   * The node's content grew (a count past what its badge reserves): run it further so the
   * tail still leaves the picture. Position over time is unchanged, so nothing jumps.
   */
  refit(item: LayerItem<T>): void {
    const measured = item.node.getBoundingClientRect().width
    if (!(measured > 0)) return
    const next = Math.ceil(measured) + SHADOW_PX
    if (next <= item.width) return
    const extra = next - item.width
    item.width = next
    this.allocator.extend(item.lane, extra / this.layout.speed)
    const effect = item.run?.effect
    if (typeof KeyframeEffect !== 'undefined' && effect instanceof KeyframeEffect) {
      effect.setKeyframes([{ transform: `translate3d(${item.from}px, ${item.top}px, 0)` }, { transform: `translate3d(${-next}px, ${item.top}px, 0)` }])
      effect.updateTiming({ duration: ((item.from + next) / item.speed) * 1000 })
    }
  }

  hold(item: LayerItem<T>): void {
    item.held = true
    item.run?.pause()
  }

  resume(item: LayerItem<T>): void {
    if (!item.held) return
    item.held = false
    item.run?.play()
  }

  /** Drop finished runs from the list; their nodes are already gone. */
  sweep(): void {
    if (this.items.some((item) => item.done)) this.items = this.items.filter((item) => !item.done)
  }

  remove(match: (item: LayerItem<T>) => boolean): void {
    const kept: LayerItem<T>[] = []
    for (const item of this.items) {
      if (match(item)) { item.run?.cancel(); item.node.remove() } else kept.push(item)
    }
    this.items = kept
  }

  clear(): void {
    for (const item of this.items) { item.run?.cancel(); item.node.remove() }
    this.items = []
    this.allocator.reset()
  }

  itemFor(node: Element): LayerItem<T> | undefined {
    return this.items.find((item) => item.node === node)
  }
}
