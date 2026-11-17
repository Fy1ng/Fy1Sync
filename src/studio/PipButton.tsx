import { ErrorText, useErrorState } from '../ui/ErrorDetails'
import { displayError } from '../core/errorDetails'
/**
 * Picture-in-picture from the dock (handoff items 05, 06).
 *
 * Two kinds, one button: the system window is Chromium's own and shows only the main video;
 * the enhanced window is the app's `/pip` page with that room's danmaku and a send box. The
 * system one must be requested inside the click itself (it needs the user gesture), so its
 * menu item calls `toggleNativePip` directly rather than through any async step first.
 *
 * The enhanced window plays the commentary whenever one is loaded, whichever side is on the
 * big screen: it takes over the sound and main mutes its whole window meanwhile, so it must
 * carry what was being heard. Its picture is the commentary stream itself, no camera crop.
 */

import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { PipState } from '../../electron/pipManager'
import type { SourceRole } from '../core/types'
import { PlaybackControls } from '../media/playbackControls'
import { Icon, Popover, usePopover } from './kit'
import { pipFailure } from './pip/pipState'

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
  const [problem, setProblem, problemDetail] = useErrorState()
  const revision = useRef(0)
  const loaded = media[mainRole].status !== 'empty'
  const enhancedRole: SourceRole = media.commentary.status !== 'empty' ? 'commentary' : mainRole

  useEffect(() => {
    let live = true
    const before = revision.current
    const off = apiClient.subscribeFeatures((event) => {
      if (live && event.topic === 'pip' && event.data && typeof event.data === 'object') { revision.current++; setPip(event.data as PipState) }
    })
    void apiClient.feature('getEnhancedPip', undefined).then((result) => {
      if (!live || before !== revision.current) return
      if (result.ok) setPip(result.value)
      else setProblem(result)
    }).catch(caught => { if (live && before === revision.current) setProblem(caught) })
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
      if (!result.ok && result.reason) setProblem(displayError(result, NATIVE_REASON[result.reason] ?? NATIVE_REASON.failed!))
      else menu.close()
    }).catch(caught => setProblem(displayError(caught, '系统画中画操作失败'))).finally(() => controls.dispose())
  }

  const toggleEnhanced = async (): Promise<void> => {
    setProblem(null)
    const result = enhancedOpen
      ? await apiClient.feature('closeEnhancedPip', undefined)
      : await apiClient.feature('openEnhancedPip', { id: enhancedRole })
    if (!result.ok) { setProblem(result); return }
    revision.current++
    setPip(result.value)
    if (result.value.phase === 'failed') setProblem(displayError(pipFailure(result.value), result.value.message ?? '画中画打开失败'))
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
        <button type="button" className="menu-item" onClick={() => void toggleEnhanced().catch(setProblem)} disabled={pip?.phase === 'opening'}>
          {pip?.phase === 'opening' ? '正在打开…' : enhancedOpen ? '关闭增强画中画' : '增强画中画'}
          <span className="menu-note">{enhancedRole === mainRole ? '含弹幕与发送' : '播放解说，含弹幕与发送'}</span>
        </button>
        {problem && <p className="form-error" role="alert"><ErrorText error={problemDetail ?? problem} message={problem} /></p>}
      </Popover>
    </div>
  )
}
