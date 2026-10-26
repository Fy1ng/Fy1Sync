/**
 * The window's own title bar, drawn by the page once the main process hides the native one
 * (`titleBarStyle: 'hidden'` with `titleBarOverlay`). The system still draws minimise,
 * maximise and close on the right; everything left of them is ours and drags the window.
 *
 * Until main enables the overlay, `windowControlsOverlay.visible` is false and this renders
 * nothing, so the page is correct under either window.
 */

import { useEffect, useState } from 'react'

interface Overlay extends EventTarget { visible: boolean }

function overlay(): Overlay | null {
  return (navigator as Navigator & { windowControlsOverlay?: Overlay }).windowControlsOverlay ?? null
}

export function TitleBar({ detail }: { detail?: string }): React.ReactNode {
  const [visible, setVisible] = useState(() => overlay()?.visible === true)
  useEffect(() => {
    const target = overlay()
    if (!target) return
    const update = (): void => setVisible(target.visible)
    target.addEventListener('geometrychange', update)
    update()
    return () => target.removeEventListener('geometrychange', update)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.titlebar = visible ? 'custom' : 'native'
  }, [visible])
  if (!visible) return null
  return (
    <header className="titlebar">
      <span className="titlebar-mark" aria-hidden="true" />
      <span className="titlebar-name">Stream Syncer</span>
      {detail && <span className="titlebar-detail">{detail}</span>}
    </header>
  )
}
