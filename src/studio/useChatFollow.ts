import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const END_SLACK = 1
interface Layout { top: number; height: number; width: number; viewport: number }
interface ScrollPort { scrollToEnd: () => void; cancelScroll: () => void }
const read = (node: HTMLElement): Layout => ({ top: node.scrollTop, height: node.scrollHeight, width: node.clientWidth, viewport: node.clientHeight })
const atEnd = (layout: Layout) => layout.height - layout.viewport - layout.top <= END_SLACK
const sameSize = (a: Layout, b: Layout) => a.height === b.height && a.viewport === b.viewport && a.width === b.width

/** Following is user intent, not a transient gap while measured rows or the viewport resize. */
export function useChatFollow(scroller: RefObject<HTMLDivElement | null>, port: ScrollPort, total: number, count: number, room: string | null) {
  const following = useRef(true)
  const intentUp = useRef(false)
  const dragging = useRef(false)
  const lastLayout = useRef<Layout | null>(null)
  const pendingFrame = useRef<number | null>(null)
  const seen = useRef({ total, room })
  const [unread, setUnread] = useState(0)

  const restore = useCallback(() => {
    const node = scroller.current
    if (!node) return
    if (following.current && !dragging.current && !atEnd(read(node))) port.scrollToEnd()
    lastLayout.current = read(node)
  }, [port, scroller])
  const scheduleRestore = useCallback(() => {
    if (pendingFrame.current !== null) return
    pendingFrame.current = requestAnimationFrame(() => { pendingFrame.current = null; restore() })
  }, [restore])
  const pause = useCallback(() => {
    following.current = false
    intentUp.current = true
    port.cancelScroll()
  }, [port])
  const jump = useCallback(() => {
    following.current = true
    intentUp.current = false
    setUnread(0)
    port.scrollToEnd()
    restore()
    scheduleRestore()
  }, [port, restore, scheduleRestore])

  const onScroll = useCallback(() => {
    const node = scroller.current
    if (!node) return
    const next = read(node), previous = lastLayout.current
    if (!atEnd(next)) {
      // A plain scrollbar/API move changes the offset, not the layout. Reflow and
      // virtualizer compensation must not turn off a previously pinned viewport.
      if (dragging.current || previous && sameSize(previous, next) && next.top < previous.top - END_SLACK) following.current = false
      if (!following.current) intentUp.current = false
    } else if (!intentUp.current) {
      following.current = true
      setUnread(0)
    }
    lastLayout.current = next
    if (following.current) scheduleRestore()
  }, [scroller, scheduleRestore])

  useLayoutEffect(() => {
    const arrived = Math.max(0, total - seen.current.total)
    if (room !== seen.current.room || count === 0) {
      following.current = true
      intentUp.current = false
      setUnread(0)
    } else if (!following.current && arrived > 0) setUnread(value => value + arrived)
    seen.current = { total, room }
  }, [total, count, room])

  // Every committed measurement can move the end, even with a fixed-length trimmed history.
  useLayoutEffect(restore)
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0) return
      if (event.deltaY < 0 && node.scrollHeight > node.clientHeight + END_SLACK) pause()
      else if (event.deltaY > 0) { intentUp.current = false; if (atEnd(read(node))) jump() }
    }
    const key = (event: KeyboardEvent) => {
      if (event.target !== node || event.altKey || event.metaKey) return
      if (event.key === 'End') { event.preventDefault(); jump() }
      else if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) pause()
      else if (['ArrowDown', 'PageDown', ' '].includes(event.key)) intentUp.current = false
    }
    const pointer = (event: PointerEvent) => {
      const bounds = node.getBoundingClientRect()
      const scrollbar = event.clientX >= bounds.right - Math.max(16, node.offsetWidth - node.clientWidth)
      if (event.pointerType === 'touch' || event.button === 1 || scrollbar) { dragging.current = true; pause() }
    }
    const release = () => {
      if (!dragging.current) return
      dragging.current = false
      intentUp.current = false
      onScroll()
    }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleRestore)
    resize?.observe(node)
    node.addEventListener('wheel', wheel, { passive: true })
    node.addEventListener('keydown', key)
    node.addEventListener('pointerdown', pointer)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      resize?.disconnect()
      node.removeEventListener('wheel', wheel)
      node.removeEventListener('keydown', key)
      node.removeEventListener('pointerdown', pointer)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current)
      pendingFrame.current = null
    }
  }, [scroller, pause, jump, onScroll, scheduleRestore])

  return { unread, jump, onScroll }
}
