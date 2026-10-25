/**
 * The danmaku overlay.
 *
 * Two rules from docs/danmaku.md shape this component:
 *
 * 1. A message's motion is fixed when it spawns. Changing the speed setting must not
 *    retime what is already on screen — a comment that suddenly accelerates mid-flight
 *    breaks the reading. So each active item captures its own `pxPerSecond` at spawn.
 * 2. Positions come from the lane allocator, not from CSS. Overlap avoidance needs text
 *    width and lane occupancy, which CSS cannot compute.
 *
 * Rendering is direct DOM writes inside a `requestAnimationFrame` loop rather than React
 * state. At 24 px on a full screen this is 30-40 moving nodes updated 60 times a second;
 * reconciling that through the virtual DOM would dominate the frame budget for no gain,
 * since nothing else in the tree depends on a scrolling comment's x position.
 */

import { useCallback, useEffect, useRef } from 'react'
import { AREA_FRACTION, DanmakuLaneAllocator, estimateTextWidth } from '../core/danmakuLanes'
import type { DanmakuMessage } from '../core/danmakuTimeline'
import { useAnimationFrame } from '../app/hooks'
import { useSession, useSessionSnapshot } from '../app/SessionContext'

interface ActiveItem {
  node: HTMLSpanElement
  /** Captured at spawn so a later speed change leaves this one alone. */
  pxPerSecond: number
  startMs: number
  fromX: number
  top: number
  width: number
}

export function DanmakuLayer(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const { danmaku } = snapshot.settings

  const hostRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<ActiveItem[]>([])
  const sizeRef = useRef({ width: 0, height: 0 })
  const allocatorRef = useRef<DanmakuLaneAllocator | null>(null)

  // The render loop reads settings through a ref so it is not torn down and rebuilt on
  // every settings keystroke.
  const settingsRef = useRef(danmaku)
  settingsRef.current = danmaku

  const layoutFor = useCallback((): {
    laneHeight: number
    areaHeight: number
    width: number
    speed: number
  } => {
    const settings = settingsRef.current
    const { width, height } = sizeRef.current
    const laneHeight = settings.fontSize * 1.4
    return {
      laneHeight,
      areaHeight: Math.max(laneHeight, height * AREA_FRACTION[settings.area]),
      width,
      speed: settings.speed,
    }
  }, [])

  /** Clear everything on screen. Used when the overlay is switched off or changes room. */
  const flush = useCallback(() => {
    for (const item of activeRef.current) item.node.remove()
    activeRef.current = []
    allocatorRef.current?.reset()
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = (): void => {
      sizeRef.current = { width: host.clientWidth, height: host.clientHeight }
      // The allocator caches lane geometry, so it has to be told about a resize or a
      // fullscreen transition would keep laying out for the old height.
      allocatorRef.current?.setLayout(layoutFor())
    }
    measure()
    allocatorRef.current ??= new DanmakuLaneAllocator(layoutFor())
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [layoutFor])

  // Font size and area change lane geometry; speed changes only affect future spawns.
  useEffect(() => {
    allocatorRef.current?.setLayout(layoutFor())
  }, [danmaku.fontSize, danmaku.area, danmaku.speed, layoutFor])

  useEffect(() => {
    if (!danmaku.enabled) flush()
  }, [danmaku.enabled, flush])

  useEffect(() => { flush() }, [snapshot.danmaku.room, flush])

  useEffect(() => flush, [flush])

  const spawn = useCallback((message: DanmakuMessage, nowMs: number): void => {
    const host = hostRef.current
    const allocator = allocatorRef.current
    if (!host || !allocator) return
    const settings = settingsRef.current
    const { width } = sizeRef.current
    if (width === 0) return

    if (message.gift) return
    const textWidth = estimateTextWidth(message.text, settings.fontSize)
    // The allocator thinks in seconds; the frame clock is in ms.
    const assignment = allocator.allocateScroll(nowMs / 1000, textWidth)
    // Every lane still busy. Dropping beats stacking one comment on another.
    if (!assignment) return

    const node = document.createElement('span')
    node.className = 'danmaku-item'
    node.textContent = message.text
    node.style.fontSize = `${settings.fontSize}px`
    node.style.opacity = String(settings.opacity)
    // No background box, per docs/ui-layout.md; the stylesheet's text-shadow carries
    // readability over a bright scene without covering the picture.
    if (message.color) node.style.color = message.color
    node.style.transform = `translate3d(${width}px, ${assignment.top}px, 0)`
    host.appendChild(node)

    activeRef.current.push({
      node,
      pxPerSecond: settings.speed,
      startMs: nowMs,
      fromX: width,
      top: assignment.top,
      width: textWidth,
    })
  }, [])

  useAnimationFrame((nowMs) => {
    // Pull whatever the timeline has released for the current commentary media time.
    // Draining continues with the overlay off: the chat list reads the same releases,
    // and an undrained timeline would expire its backlog as stale instead.
    const released = session.drainDanmaku()
    if (!settingsRef.current.enabled) return

    for (const message of released) {
      spawn(message, nowMs)
    }

    const active = activeRef.current
    let writeIndex = 0
    for (const item of active) {
      const x = item.fromX - ((nowMs - item.startMs) / 1000) * item.pxPerSecond
      if (x < -item.width) {
        item.node.remove()
        continue
      }
      item.node.style.transform = `translate3d(${x}px, ${item.top}px, 0)`
      active[writeIndex] = item
      writeIndex += 1
    }
    active.length = writeIndex
  })

  return <div className="danmaku-layer" ref={hostRef} aria-hidden="true" />
}
