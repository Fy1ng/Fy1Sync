/**
 * Moving between the player and the countdown style editor without reloading the page.
 *
 * Both routes share one `Session`, which owns the two media elements and the danmaku
 * relay. A real navigation reloads the renderer and loses all of it, and the main process
 * also drops the window's subscriptions on a cross-document load. So the switch is a
 * history entry plus the `popstate` that `main.tsx` already routes on.
 */

export function navigate(path: string): void {
  if (window.location.pathname === path) return
  window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/**
 * Props for an `<a>` that routes in place. The href stays real so the link reads and
 * behaves as a link; only a plain left click is taken over.
 */
export function routeLink(path: string, before?: () => void): {
  href: string
  onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void
} {
  return {
    href: path,
    onClick: (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      before?.()
      navigate(path)
    },
  }
}
