/**
 * Picture-in-picture for the main picture, from the dock (handoff items 05, 06).
 *
 * Two kinds, one button: the system window is Chromium's own and shows only the video; the
 * enhanced window is the app's `/pip` page with this room's danmaku and a send box. The
 * system one must be requested inside the click itself (it needs the user gesture), so its
 * menu item calls `toggleNativePip` directly rather than through any async step first.
 */

import { useEffect, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { PipState } from '../../electron/pipManager'
import { PlaybackControls } from '../media/playbackControls'
import { Icon, Popover, usePopover } from './kit'

/** Why the system window did not open, by `NativePipResult.reason`. Shared with the extra-stream windows. */
export const NATIVE_REASON: Record<string, string> = {
  unsupported: '当前环境不支持系统画中画',
  'not-ready': '画面尚未就绪，请在画面出现后重试',
  'user-gesture-required': '请直接点击按钮打开系统画中画',
  failed: '系统画中画打开失败',
}

export function PipButton(): React.ReactNode {
  const session = useSession()
  const { media, mainRole } = useSessionSnapshot()
  const menu = usePopover()
  const [pip, setPip] = useState<PipState | null>(null)
  const [native, setNative] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const loaded = media[mainRole].status !== 'empty'

  useEffect(() => {
    let live = true
    const off = apiClient.subscribeFeatures((event) => {
      if (event.topic === 'pip' && event.data && typeof event.data === 'object') setPip(event.data as PipState)
    })
    void apiClient.feature('getEnhancedPip', undefined).then((result) => { if (live && result.ok) setPip(result.value) })
    return () => { live = false; off() }
  }, [])

  // The system window can also be closed from its own controls; follow it.
  useEffect(() => {
    const document = window.document
    const sync = (): void => setNative(document.pictureInPictureElement !== null)
    document.addEventListener('enterpictureinpicture', sync, true)
    document.addEventListener('leavepictureinpicture', sync, true)
    return () => {
      document.removeEventListener('enterpictureinpicture', sync, true)
      document.removeEventListener('leavepictureinpicture', sync, true)
    }
  }, [])

  if (!loaded) return null
  const enhancedOpen = pip !== null && pip.phase !== 'closed' && pip.phase !== 'failed'

  const toggleNative = (): void => {
    setProblem(null)
    const controls = new PlaybackControls(session.engine.element(mainRole))
    void controls.toggleNativePip().then((result) => {
      setNative(result.active)
      if (!result.ok && result.reason) setProblem(NATIVE_REASON[result.reason] ?? NATIVE_REASON.failed!)
      else menu.close()
      controls.dispose()
    })
  }

  const toggleEnhanced = async (): Promise<void> => {
    setProblem(null)
    const result = enhancedOpen
      ? await apiClient.feature('closeEnhancedPip', undefined)
      : await apiClient.feature('openEnhancedPip', { id: mainRole })
    if (!result.ok) { setProblem(result.message); return }
    setPip(result.value)
    if (result.value.phase === 'failed') setProblem(result.value.message ?? '画中画打开失败')
    else menu.close()
  }

  return (
    <div className="pip-control">
      <button type="button" className={`icon-btn ${native || enhancedOpen ? 'is-on' : ''}`.trim()} {...menu.trigger}
        aria-label="画中画" title="画中画">
        <Icon name="pip" />
      </button>
      <Popover {...menu.popover} className="pip-menu" label="画中画">
        <button type="button" className="menu-item" onClick={toggleNative}>
          {native ? '关闭系统画中画' : '系统画中画'}
          <span className="menu-note">仅画面</span>
        </button>
        <button type="button" className="menu-item" onClick={() => void toggleEnhanced()} disabled={pip?.phase === 'opening'}>
          {pip?.phase === 'opening' ? '正在打开…' : enhancedOpen ? '关闭增强画中画' : '增强画中画'}
          <span className="menu-note">含弹幕与发送</span>
        </button>
        {problem && <p className="form-error" role="alert">{problem}</p>}
      </Popover>
    </div>
  )
}
