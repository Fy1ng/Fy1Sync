/**
 * Small hooks shared by the player UI.
 *
 * Each one exists because the behaviour it wraps is easy to get subtly wrong in a
 * component body: a timer that survives a re-render, a listener attached to the document,
 * a mount point that must publish itself to a non-React owner.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SourceRole } from '../core/types'
import { useSession } from './SessionContext'

/**
 * Hand a DOM container to the `MediaEngine` so it can move the role's `<video>` in.
 *
 * The ref callback rather than an effect: it runs before paint and again with `null` on
 * unmount, which is exactly the mount/unmount pair the engine needs. Returning the video
 * to nowhere on unmount keeps the element alive — the engine still owns it.
 */
export function useMediaMount(role: SourceRole): (node: HTMLDivElement | null) => void {
  const session = useSession()
  return useCallback(
    (node: HTMLDivElement | null) => {
      session.engine.mount(role, node)
    },
    [session, role],
  )
}

/**
 * Show the overlay bar on pointer entry, hide it on exit or after `idleMs` of stillness.
 *
 * The timer restarts on movement, so a still pointer over the picture goes away and a
 * moving one does not. Keyboard focus inside the bar pins it open: a control being
 * tabbed through must not vanish mid-interaction.
 */
export function useOverlayVisibility(
  idleMs = 5000,
  /** Hold the bar open regardless of pointer idleness — the player passes `paused` here. */
  keepVisible = false,
): {
  visible: boolean
  pin: (pinned: boolean) => void
  handlers: {
    onPointerEnter: () => void
    onPointerMove: () => void
    onPointerDown: () => void
    onWheel: () => void
    onKeyDown: () => void
    onPointerLeave: () => void
  }
} {
  // Starts shown, like every other player: a first paint with no controls leaves the user
  // guessing that moving the pointer is what reveals them. The idle timer below then takes
  // it away on its own.
  const [visible, setVisible] = useState(true)
  const [pinned, setPinned] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressed = useRef(false)

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const show = useCallback(() => {
    clear()
    setVisible(true)
    if (pinned) return
    const arm = (): void => {
      timer.current = setTimeout(() => { if (pressed.current) arm(); else setVisible(false) }, idleMs)
    }
    arm()
  }, [clear, idleMs, pinned])

  const press = useCallback(() => {
    pressed.current = true
    show()
    const release = (): void => {
      pressed.current = false
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', release, true)
      show()
    }
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
  }, [show])

  // Arms the hide on mount, and again whenever `keepVisible` is released, so a bar held
  // open by a pause fades once playback resumes. Reuses `timer.current` rather than a
  // local handle so `show`/`onPointerLeave` can still cancel it.
  useEffect(() => {
    if (keepVisible) {
      clear()
      return
    }
    timer.current = setTimeout(() => setVisible(false), idleMs)
    return clear
  }, [clear, idleMs, keepVisible])

  return {
    visible: visible || pinned || keepVisible,
    pin: setPinned,
    handlers: {
      onPointerEnter: show,
      onPointerMove: show,
      // A click is activity too: pressing 回退画面 five times must not let the bar fade
      // mid-adjustment just because the pointer did not travel between presses.
      onPointerDown: press,
      onWheel: show,
      onKeyDown: show,
      onPointerLeave: () => {
        clear()
        if (!pinned) setVisible(false)
      },
    },
  }
}

/**
 * Publish `source`'s height onto `host` as a CSS custom property.
 *
 * The overlay bar is the caller: its height is not a constant the stylesheet can know. It
 * folds from one row to three as the stage narrows, and the row count also depends on the
 * text inside it — 画质 reading `1080p60` is wider than 自动, which can push the right group
 * onto another line at a width where 自动 still fit. Anything that has to stay clear of the
 * bar therefore needs the height it actually has, not a number per breakpoint.
 *
 * `offsetHeight`, not `contentRect.height`: the observer entry excludes padding, and the bar
 * carries 26px of it. Rounded up, because a fractional layout height would let a subpixel of
 * the bar show through above whatever is clearing it.
 */
export function usePublishedHeight(
  source: React.RefObject<HTMLElement | null>,
  host: React.RefObject<HTMLElement | null>,
  property: string,
): void {
  useEffect(() => {
    const node = source.current
    const target = host.current
    if (!node || !target) return
    const measure = (): void => {
      const height = node.offsetHeight
      // Zero means "not laid out yet" — jsdom always reports it, and so does a display:none
      // ancestor. Publishing it would collapse the clearance to nothing, so leave the
      // stylesheet's fallback in charge until there is a real measurement.
      if (height > 0) target.style.setProperty(property, `${Math.ceil(height)}px`)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      observer.disconnect()
      target.style.removeProperty(property)
    }
  }, [source, host, property])
}

export type DockFold = 'none' | 'two' | 'three'

/**
 * How many rows the dock needs, from what its three groups actually hold.
 *
 * A fixed breakpoint cannot know this: 画质 reading `2160p60` on both sides, the test badge
 * on 自动对齐 or an open chat drawer each change the width the row needs. Each group is
 * measured by its children (a group's own box is its grid column, not its content), so the
 * answer does not depend on the layout it picks and cannot flip back and forth.
 *
 * - none: one row, the centre group truly centred, so both sides get the wider one's width.
 * - two: the centre on its own row, playback and the rest share the one below.
 * - three: each group on its own row.
 */
export function useDockFold(row: React.RefObject<HTMLElement | null>, gap = 16): DockFold {
  const [fold, setFold] = useState<DockFold>('none')
  useEffect(() => {
    const node = row.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const groups = Array.from(node.children) as HTMLElement[]
    const contentWidth = (group: HTMLElement): number => {
      const items = Array.from(group.children) as HTMLElement[]
      const spacing = Number.parseFloat(getComputedStyle(group).columnGap) || 0
      // scrollWidth: a child allowed to shrink (min-width: 0) reports its squeezed box, not
      // what it holds, and the squeezed box is exactly what overlaps.
      return items.reduce((sum, item) => sum + Math.max(item.offsetWidth, item.scrollWidth), 0)
        + spacing * Math.max(0, items.length - 1)
    }
    const measure = (): void => {
      const available = node.clientWidth
      if (available <= 0 || groups.length < 3) return
      const [left, center, right] = groups.map(contentWidth) as [number, number, number]
      setFold(2 * Math.max(left, right) + center + 2 * gap <= available ? 'none'
        : left + right + gap <= available ? 'two' : 'three')
    }
    const resize = new ResizeObserver(measure)
    const watch = (): void => {
      resize.disconnect()
      resize.observe(node)
      for (const group of groups) for (const item of Array.from(group.children)) resize.observe(item)
    }
    // Controls come and go (画质 only with a ladder); watch the new ones as well.
    const mutations = new MutationObserver(() => { watch(); measure() })
    for (const group of groups) mutations.observe(group, { childList: true })
    watch()
    measure()
    return () => { resize.disconnect(); mutations.disconnect() }
  }, [row, gap])
  return fold
}

/** Element-level fullscreen with the state the browser actually reports. */
export function useFullscreen(target: React.RefObject<HTMLElement | null>): {
  active: boolean
  toggle: () => void
  error: string | null
} {
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    // `Boolean`, not `!== null`: where the unprefixed Fullscreen API is missing the property
    // reads `undefined`, which is not `null`, and the page would come up believing it is
    // already fullscreen — sidebar hidden, button stuck on 退出全屏, nothing to click back.
    const update = (): void => setActive(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', update)
    update()
    return () => { mounted.current = false; document.removeEventListener('fullscreenchange', update) }
  }, [])

  const toggle = useCallback(() => {
    const node = target.current
    if (!node) return
    setError(null)
    const fail = () => { if (mounted.current) setError('无法切换全屏. 请重试或使用窗口模式.') }
    try {
      if (document.fullscreenElement) void document.exitFullscreen().catch(fail)
      else if (node.requestFullscreen) void node.requestFullscreen().catch(fail)
      else fail()
    } catch { fail() }
  }, [target])

  return { active, toggle, error }
}

/** A requestAnimationFrame loop that keeps a stable callback identity. */
export function useAnimationFrame(callback: (nowMs: number) => void, active = true): void {
  const latest = useRef(callback)
  latest.current = callback

  useEffect(() => {
    if (!active || typeof requestAnimationFrame === 'undefined') return
    let frame = requestAnimationFrame(function tick(now: number) {
      latest.current(now)
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [active])
}
