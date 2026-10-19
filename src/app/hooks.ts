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
    onPointerLeave: () => void
  }
} {
  // Starts shown, like every other player: a first paint with no controls leaves the user
  // guessing that moving the pointer is what reveals them. The idle timer below then takes
  // it away on its own.
  const [visible, setVisible] = useState(true)
  const [pinned, setPinned] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    timer.current = setTimeout(() => setVisible(false), idleMs)
  }, [clear, idleMs, pinned])

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

/** Close a popover on outside click or Escape. */
export function useDismiss(open: boolean, onClose: () => void): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const node = ref.current
      if (node && event.target instanceof Node && !node.contains(event.target)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    // Capture phase, so a click on a button that also opens a popover does not close it
    // and reopen it in the same gesture.
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  return ref
}

/** Element-level fullscreen with the state the browser actually reports. */
export function useFullscreen(target: React.RefObject<HTMLElement | null>): {
  active: boolean
  toggle: () => void
} {
  const [active, setActive] = useState(false)

  useEffect(() => {
    // `Boolean`, not `!== null`: where the unprefixed Fullscreen API is missing the property
    // reads `undefined`, which is not `null`, and the page would come up believing it is
    // already fullscreen — sidebar hidden, button stuck on 退出全屏, nothing to click back.
    const update = (): void => setActive(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', update)
    update()
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])

  const toggle = useCallback(() => {
    const node = target.current
    if (!node) return
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }
    // Rejected when the gesture was not user-initiated. Nothing to recover, and an
    // unhandled rejection in a click handler is noise.
    void node.requestFullscreen?.().catch(() => undefined)
  }, [target])

  return { active, toggle }
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
