/**
 * The player: one picture, edge to edge, with everything else out of the way until the
 * pointer moves.
 *
 * Like the page it replaces, it never renders a `<video>`: both elements belong to
 * `MediaEngine`, and the mounts below are containers it moves them into, so swapping the
 * big picture and the small one relocates live elements instead of remounting them.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useFullscreen, useMediaMount, useOverlayVisibility, usePublishedHeight } from '../app/hooks'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { useCamera } from '../app/useCamera'
import type { SourceRole } from '../core/types'
import { CameraOverlay } from '../ui/CameraOverlay'
import { CameraFraming } from './CameraFraming'
import { ChatDrawer } from './ChatDrawer'
import { ComposerProvider } from './composer'
import { DanmakuPanel } from './DanmakuPanel'
import { DanmakuStage } from './DanmakuStage'
import { DouyuDesk } from './douyu/DouyuDesk'
import { Intake } from './Intake'
import { Icon, Popover, usePopover } from './kit'
import { SettingsSheet } from './SettingsSheet'
import { SourceChip } from './SourceChip'
import { SourceLoaderProvider, ROLE_LABEL } from './sources'
import { AutoAlign, CountdownPrompt, SyncCapsule, useNudge } from './sync'
import { Toasts } from './Toasts'
import { Balance, DanmakuSwitch, PlayButton, Timeline } from './transport'
import './studio.css'

type Desk = 'douyu' | 'settings' | null

export function Studio(): React.ReactNode {
  return (
    <SourceLoaderProvider>
      <ComposerProvider>
        <StudioView />
      </ComposerProvider>
    </SourceLoaderProvider>
  )
}

function StudioView(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const root = useRef<HTMLDivElement | null>(null)
  const fullscreen = useFullscreen(root)
  const camera = useCamera()
  const nudge = useNudge()
  const [intake, setIntake] = useState(false)
  const [droppedFile, setDroppedFile] = useState<File | null>(null)
  const [desk, setDesk] = useState<Desk>(null)
  const [tuning, setTuning] = useState(false)
  const [framing, setFraming] = useState(false)
  const [previewHidden, setPreviewHidden] = useState(false)
  const theater = useRef<HTMLDivElement | null>(null)
  const dock = useRef<HTMLElement | null>(null)
  // The picture-in-picture, the danmaku panel and the local gift effects all keep clear of
  // the dock, whose height changes as it folds into two rows on a narrow window.
  usePublishedHeight(dock, theater, '--bar-clearance')

  const busyChrome = intake || tuning || desk !== null
  const chrome = useOverlayVisibility(3200, !snapshot.playing || busyChrome)
  // The drawer is the room's chat; with no room there is nothing to hold it open for.
  const hasRoom = snapshot.danmaku.connected || snapshot.danmaku.room !== null
  const chatOpen = snapshot.settings.sidebarVisible && hasRoom
  const setChat = useCallback((open: boolean) => session.updateSettings({ sidebarVisible: open }), [session])

  const mainRole = snapshot.mainRole
  const otherRole: SourceRole = mainRole === 'official' ? 'commentary' : 'official'
  const mountMain = useMediaMount(mainRole)
  const mountOther = useMediaMount(otherRole)
  const empty = snapshot.media.official.status === 'empty' && snapshot.media.commentary.status === 'empty'

  useEffect(() => { void session.boot() }, [session])
  // Suspend, never dispose: the session is shared with the scene editor route.
  useEffect(() => () => session.suspend(), [session])
  useEffect(() => {
    const media = session.snapshot.media
    if (media.official.status === 'empty' && media.commentary.status === 'empty') setIntake(true)
  }, [session])

  const closeIntake = useCallback(() => { setIntake(false); setDroppedFile(null) }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const step = event.shiftKey ? snapshot.settings.largeStepSeconds : snapshot.settings.smallStepSeconds
      switch (event.code) {
        case 'Space': event.preventDefault(); void session.togglePlaying(); break
        case 'ArrowLeft': event.preventDefault(); nudge('early', step); break
        case 'ArrowRight': event.preventDefault(); nudge('late', step); break
        case 'KeyA': void session.syncNow(); break
        case 'KeyD': session.updateDanmakuSettings({ enabled: !session.settings.danmaku.enabled }); break
        case 'KeyC': setChat(!session.settings.sidebarVisible); break
        case 'KeyF': fullscreen.toggle(); break
        default: return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, nudge, session, setChat, snapshot.settings.largeStepSeconds, snapshot.settings.smallStepSeconds])

  return (
    <div
      className="studio"
      ref={root}
      data-chat={chatOpen ? 'open' : 'closed'}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
      onDrop={(event) => {
        const file = event.dataTransfer.files[0]
        if (!file) return
        event.preventDefault()
        setDroppedFile(file)
        setIntake(true)
      }}
    >
      <main className="theater" ref={theater} data-chrome={chrome.visible ? 'on' : 'off'} {...chrome.handlers}>
        <div className="theater-main" ref={mountMain} data-role={mainRole} />
        <DanmakuStage onReply={() => setChat(true)} />
        {camera.config && <CameraOverlay config={camera.config} onWindow={camera.setWindow} stageRef={theater} />}

        {snapshot.media[otherRole].status !== 'empty' && !previewHidden ? (
          <div className="pip" data-role={otherRole}>
            <button type="button" className="pip-swap" onClick={() => session.swapRoles()}
              aria-label={`将${ROLE_LABEL[otherRole]}切换为主画面`} title="切换为主画面">
              <span className="pip-mount" ref={mountOther} />
              <span className="pip-label">{ROLE_LABEL[otherRole]}</span>
            </button>
            <button type="button" className="pip-hide" onClick={() => setPreviewHidden(true)} aria-label="隐藏小画面">
              <Icon name="close" />
            </button>
          </div>
        ) : (
          // The other element still needs a parent while hidden, or it would be detached.
          <span className="pip-parked" ref={mountOther} aria-hidden="true" />
        )}

        <header className="topbar">
          <div className="topbar-sources">
            <SourceChip role="official" camera={camera} onEmpty={() => setIntake(true)} onFrameCamera={() => setFraming(true)} />
            <SourceChip role="commentary" camera={camera} onEmpty={() => setIntake(true)} onFrameCamera={() => setFraming(true)} />
            {previewHidden && snapshot.media[otherRole].status !== 'empty' && (
              <button type="button" className="btn-glass small" onClick={() => setPreviewHidden(false)}>显示小画面</button>
            )}
          </div>
          <div className="topbar-tools">
            {!chatOpen && hasRoom && (
              <button type="button" className="icon-btn glass" onClick={() => setChat(true)} aria-label="展开弹幕" title="弹幕列表（C）">
                <Icon name="chat" />
              </button>
            )}
            <MoreMenu onDesk={setDesk} />
          </div>
        </header>

        <Toasts />
        {fullscreen.error && <p className="toast is-error floating-error" role="alert">{fullscreen.error}</p>}

        <footer className="dock" ref={dock}>
          <CountdownPrompt />
          <Timeline />
          <div className="dock-row">
            <div className="dock-left">
              <PlayButton />
              <Balance />
            </div>
            <div className="dock-center">
              <SyncCapsule />
              <AutoAlign />
            </div>
            <div className="dock-right">
              <DanmakuSwitch onTune={() => setTuning((open) => !open)} />
              <button type="button" className="icon-btn" onClick={fullscreen.toggle} aria-pressed={fullscreen.active}
                aria-label={fullscreen.active ? '退出全屏' : '全屏'} title={`${fullscreen.active ? '退出全屏' : '全屏'}（F）`}>
                <Icon name={fullscreen.active ? 'shrink' : 'expand'} />
              </button>
            </div>
          </div>
        </footer>

        {empty && !intake && (
          <div className="theater-empty">
            <button type="button" className="btn-glass" onClick={() => setIntake(true)}>添加直播间</button>
          </div>
        )}

        {tuning && <DanmakuPanel onClose={() => setTuning(false)} />}
        {(intake || (empty && droppedFile)) && <Intake onClose={closeIntake} pendingFile={droppedFile} />}
      </main>

      {chatOpen && <ChatDrawer onClose={() => setChat(false)} onOpenDouyu={() => setDesk('douyu')} />}

      {desk === 'douyu' && <DouyuDesk onClose={() => setDesk(null)} />}
      {desk === 'settings' && <SettingsSheet onClose={() => setDesk(null)} />}
      {framing && (
        <CameraFraming
          key={camera.room}
          initial={camera.config?.crop ?? null}
          onSave={(crop) => { camera.save(crop); setFraming(false) }}
          onRemove={camera.config ? () => { camera.remove(); setFraming(false) } : null}
          onClose={() => setFraming(false)}
        />
      )}
    </div>
  )
}

function MoreMenu({ onDesk }: { onDesk: (desk: Desk) => void }): React.ReactNode {
  const menu = usePopover()
  const go = (desk: Desk): void => { menu.close(); onDesk(desk) }
  return (
    <div className="more">
      <button type="button" className="icon-btn glass" onClick={menu.toggle} aria-label="更多" aria-expanded={menu.open}>
        <Icon name="more" />
      </button>
      <Popover open={menu.open} onClose={menu.close} className="more-menu" label="更多">
        <button type="button" className="menu-item" onClick={() => go('douyu')}>斗鱼账号与任务</button>
        <a className="menu-item" href="/admin">倒计时样式编辑器</a>
        <button type="button" className="menu-item" onClick={() => go('settings')}>设置</button>
      </Popover>
    </div>
  )
}
