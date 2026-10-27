/**
 * This room's danmaku over the PiP picture.
 *
 * The same rule as the main player: a message is parked on a timeline keyed by the video's
 * media time and released only when playback reaches it, so it appears with the picture it
 * was written against. The window owns its own processor (duplicates, suspected bots),
 * configured from the shared display preferences.
 *
 * Deliberately lighter than the main stage: no hover menu, no gift notices, text only.
 * Nodes are positioned straight from the frame loop, like the main stage.
 */

import { useEffect, useRef } from 'react'
import { apiClient } from '../../app/apiClient'
import { AREA_FRACTION, DanmakuLaneAllocator, estimateTextWidth, type LaneLayout } from '../../core/danmakuLanes'
import { DanmakuProcessor, danmakuLaneHeight, type DanmakuPreferences } from '../../core/danmakuProcessing'
import { DanmakuTimeline, LiveEdgeClock, scheduleTimeFor, type DanmakuMessage } from '../../core/danmakuTimeline'
import { readTimebase } from '../../media/timebase'
import { colorForIndex } from '../../../server/danmaku/douyuProtocol'

const FONT_SIZE = 15
/** Seconds a message takes to cross the window, whatever its width. */
const CROSS_SECONDS = 7

interface Active {
  node: HTMLSpanElement
  groupId: string | null
  startMs: number
  fromX: number
  speed: number
  width: number
  top: number
}

export function PipDanmaku({ video, room, preferences, drawing, resetKey, onProblem }: {
  video: HTMLVideoElement | null
  /** Only this room is subscribed; null subscribes nothing. */
  room: string | null
  preferences: DanmakuPreferences
  /** False in low power: nothing is drawn and nothing is parked. */
  drawing: boolean
  /** Changes on each reload of the picture; the parked queue belongs to the old one. */
  resetKey: number
  onProblem: (problem: string | null) => void
}): React.ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const timeline = useRef(new DanmakuTimeline())
  const clock = useRef(new LiveEdgeClock())
  const processor = useRef(new DanmakuProcessor())
  const active = useRef<Active[]>([])
  const allocator = useRef<DanmakuLaneAllocator | null>(null)
  const size = useRef({ width: 0, height: 0 })
  const sequence = useRef(0)
  const pausedClock = useRef<{ media: number; wall: number } | null>(null)
  const gap = useRef(preferences.verticalGapPx)
  gap.current = preferences.verticalGapPx
  const drawingRef = useRef(drawing)
  drawingRef.current = drawing
  const problemRef = useRef(onProblem)
  problemRef.current = onProblem

  const layout = (): LaneLayout => {
    const { width, height } = size.current
    const laneHeight = danmakuLaneHeight(FONT_SIZE, gap.current)
    return { laneHeight, areaHeight: Math.max(laneHeight, height * AREA_FRACTION.half), width, speed: Math.max(60, width / CROSS_SECONDS) }
  }

  const flush = (): void => {
    for (const item of active.current) item.node.remove()
    active.current = []
    allocator.current?.reset()
  }
  const resetQueue = (): void => {
    timeline.current.clear()
    clock.current.reset()
    processor.current.reset()
    pausedClock.current = null
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = (): void => {
      size.current = { width: host.clientWidth, height: host.clientHeight }
      allocator.current?.setLayout(layout())
    }
    measure()
    allocator.current ??= new DanmakuLaneAllocator(layout())
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => { allocator.current?.setLayout(layout()) }, [preferences.verticalGapPx])
  // A new configuration resets the processor's duplicate groups by design.
  useEffect(() => { processor.current.configure(preferences) }, [preferences])
  useEffect(() => { resetQueue(); flush() }, [resetKey])
  useEffect(() => { if (!drawing) { resetQueue(); flush() } }, [drawing])

  // The subscription: one room, released on change and on unmount.
  useEffect(() => {
    problemRef.current(null)
    if (!room || !video) return
    resetQueue()
    flush()
    let off: () => void = () => {}
    try {
      off = apiClient.subscribeDanmaku(room, ({ event, data }) => {
        if (event === 'danmaku') ingest(data)
        else if (event === 'state' && data && typeof data === 'object') {
          const value = data as { state?: unknown; detail?: unknown }
          if (value.state === 'connected') problemRef.current(null)
          else if (value.state === 'closed') problemRef.current(typeof value.detail === 'string' ? value.detail : '弹幕连接已断开')
        } else if (event === 'error') problemRef.current('弹幕连接中断，正在重试')
      })
    } catch {
      problemRef.current('弹幕连接失败')
    }
    function ingest(data: unknown): void {
      if (!drawingRef.current || !video || !data || typeof data !== 'object') return
      const payload = data as { text?: unknown; username?: unknown; color?: unknown; system?: unknown; gift?: unknown; huyaGift?: unknown; dms?: unknown; platform?: unknown }
      // Gift and system notices are the main stage's business; this overlay is chat only.
      if (typeof payload.text !== 'string' || !payload.text.trim() || payload.system === true || payload.gift !== undefined || payload.huyaGift !== undefined) return
      const timebase = readTimebase(video)
      const scheduleTime = timebase
        ? scheduleTimeFor({ currentTime: video.currentTime, timebase }, { clock: clock.current, nowMs: Date.now() })
        : video.currentTime
      timeline.current.push({
        id: `p${++sequence.current}`,
        text: payload.text,
        user: typeof payload.username === 'string' ? payload.username : '',
        color: colorForIndex(typeof payload.color === 'number' ? payload.color : 0),
        ...(payload.platform === 'huya' ? { platform: 'huya' as const } : {}),
        ...(typeof payload.dms === 'number' && Number.isFinite(payload.dms) ? { dms: payload.dms } : {}),
        scheduleTime,
        receivedAt: Date.now(),
      })
    }
    return () => {
      off()
      resetQueue()
      flush()
    }
  }, [room, video])

  useEffect(() => {
    if (!drawing || !video || typeof requestAnimationFrame === 'undefined') return
    const onSeeking = (): void => { if (video.currentTime < timeline.current.playhead) timeline.current.handleSeek(video.currentTime) }
    video.addEventListener('seeking', onSeeking)

    const spawn = (message: DanmakuMessage, groupId: string | null, nowMs: number): void => {
      const host = hostRef.current
      const lanes = allocator.current
      const { width } = size.current
      if (!host || !lanes || width === 0) return
      const { speed } = layout()
      const textWidth = estimateTextWidth(message.text, FONT_SIZE)
      const lane = lanes.allocateScroll(nowMs / 1000, textWidth)
      // Every lane is still busy: drop rather than overlap.
      if (!lane) return
      const node = document.createElement('span')
      node.className = 'pip-dm'
      node.textContent = message.text
      if (message.color) node.style.color = message.color
      node.style.transform = `translate3d(${width}px, ${lane.top}px, 0)`
      host.appendChild(node)
      active.current.push({ node, groupId, startMs: nowMs, fromX: width, speed, width: textWidth, top: lane.top })
    }

    let frame = requestAnimationFrame(function tick(nowMs: number) {
      // A paused picture does not hold chat back; the duplicate window keeps time on the wall clock.
      let mediaTime = video.currentTime
      if (video.paused) {
        pausedClock.current ??= { media: mediaTime, wall: Date.now() }
        mediaTime = pausedClock.current.media + (Date.now() - pausedClock.current.wall) / 1000
      } else pausedClock.current = null
      const released = video.paused ? timeline.current.releaseAll() : timeline.current.advance(mediaTime)
      for (const message of released) {
        const result = processor.current.process({ text: message.text, room: room ?? undefined, platform: message.platform, ...(message.dms !== undefined ? { dms: message.dms } : {}) }, mediaTime)
        if (result.kind === 'hide') continue
        if (result.kind === 'merge') {
          for (const item of active.current) if (item.groupId === result.groupId) item.node.textContent = `${message.text} ×${result.count}`
          continue
        }
        spawn(message, result.groupId, nowMs)
      }
      let write = 0
      for (const item of active.current) {
        const x = item.fromX - ((nowMs - item.startMs) / 1000) * item.speed
        if (x < -item.width) { item.node.remove(); continue }
        item.node.style.transform = `translate3d(${x}px, ${item.top}px, 0)`
        active.current[write++] = item
      }
      active.current.length = write
      frame = requestAnimationFrame(tick)
    })
    return () => {
      cancelAnimationFrame(frame)
      video.removeEventListener('seeking', onSeeking)
    }
  }, [drawing, video, room])

  useEffect(() => () => flush(), [])

  return <div className="pip-danmaku" ref={hostRef} aria-hidden="true" />
}
