/**
 * The window's own title bar. Main hides the native one (`titleBarStyle: 'hidden'`) and no
 * longer draws the caption buttons, so this draws all of it: the name, a strip that drags the
 * window (double-click maximises, from the system), and minimise, maximise and close.
 *
 * The system buttons were dropped because on Windows 10 their hover tint is derived from the
 * overlay colour and is invisible on a background this dark; these buttons tint like the
 * system's own on a light theme. Main reports maximised/fullscreen/focus so the maximise glyph
 * and the dimmed inactive look follow the window. Hidden while the window is fullscreen.
 *
 * Without the desktop bridge (a plain browser, older main) it renders nothing, so every page is
 * still correct under the native frame.
 */

import { useEffect, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useRemembered } from '../app/remembered'
import type { DesktopMethods, WindowState } from '../../electron/contracts'

type Action = DesktopMethods['windowControl']['args']['action']

const INITIAL: WindowState = { maximized: false, fullscreen: false, focused: true }

export function TitleBar({ detail }: { detail?: string }): React.ReactNode {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [state, setState] = useRemembered<WindowState>('window-state', INITIAL)

  useEffect(() => {
    let live = true
    const off = apiClient.subscribeWindowState((next) => { if (live) setState(next) })
    void apiClient.getWindowState().then((result) => {
      if (!live) return
      setAvailable(result.ok)
      if (result.ok) setState(result.value)
    })
    return () => { live = false; off() }
  }, [])

  const drawn = available === true && !state.fullscreen
  useEffect(() => {
    document.documentElement.dataset.titlebar = drawn ? 'custom' : 'native'
  }, [drawn])
  if (!drawn) return null

  const act = (action: Action): void => {
    void apiClient.windowControl(action).then((result) => { if (result.ok) setState(result.value) })
  }

  return (
    <header className="titlebar" data-focused={state.focused}>
      <span className="titlebar-mark" aria-hidden="true" />
      <span className="titlebar-name">Fy1Sync</span>
      {detail && <span className="titlebar-detail">{detail}</span>}
      <div className="titlebar-controls">
        <button type="button" className="titlebar-btn" aria-label="最小化" title="最小化" onClick={() => act('minimize')}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" /></svg>
        </button>
        <button type="button" className="titlebar-btn" aria-label={state.maximized ? '向下还原' : '最大化'}
          title={state.maximized ? '向下还原' : '最大化'} onClick={() => act('toggle-maximize')}>
          {state.maximized
            ? <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 2.5h7v7h-7zM2.5 2.5v-2h7v7h-2" /></svg>
            : <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5h9v9h-9z" /></svg>}
        </button>
        <button type="button" className="titlebar-btn is-close" aria-label="关闭" title="关闭" onClick={() => act('close')}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
        </button>
      </div>
    </header>
  )
}
