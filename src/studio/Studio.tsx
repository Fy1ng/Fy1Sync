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
import { SOURCE_ROLES, type SourceRole } from '../core/types'
import { CameraOverlay } from '../ui/CameraOverlay'
import { INITIAL_UPSCALE_STATE } from '../ui/useCameraUpscale'
import { CameraButton } from './CameraButton'
import { CameraFraming } from './CameraFraming'
import { CaptureControls } from './capture/Capture'
import { ChatDrawer } from './ChatDrawer'
import { ComposerProvider } from './composer'
import { DanmakuActionsProvider } from './danmakuActions'
import { DanmakuPanel } from './DanmakuPanel'
import { DanmakuStage } from './DanmakuStage'
import { usePlaybackHeartbeat } from './insights/RoomInsights'
import { Intake } from './Intake'
import { Icon } from './kit'
import { PipButton } from './PipButton'
import type { RecordsTab } from './records/DanmakuRecords'
import { ScheduleSheet } from './schedule/ScheduleSheet'
import { prefetchSchedule } from './schedule/store'
import { SettingsSheet, type SettingsSection, type SettingsTarget } from './SettingsSheet'
import { SourceChip } from './SourceChip'
import { SourceLoaderProvider, ROLE_LABEL, useSourceLoader } from './sources'
import { ExtraStreams } from './streams/ExtraStreams'
import { AutoAlign, CountdownPrompt, SyncCapsule, useNudge } from './sync'
import { useComposer } from './composer'
import { Toasts } from './Toasts'
import { QualityMenu } from './QualityMenu'
import { DanmakuSwitch, PlayButton, Timeline, Volumes } from './transport'
import './studio.css'
import { remember, remembered } from '../app/remembered'

/** Seconds per ←/→ press, and with Shift. */
const SEEK_SMALL = 5
const SEEK_LARGE = 30

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
  const [cameraUpscale, setCameraUpscale] = useState(INITIAL_UPSCALE_STATE)
  const nudge = useNudge()
  const [intake, setIntake] = useState(false)
  const [droppedFile, setDroppedFile] = useState<File | null>(null)
  const [settingsAt, setSettingsAt] = useState<SettingsTarget | null>(null)
  // The gear reopens 设置 where it was left; links that name a section go there.
  const openSettings = useCallback((section?: SettingsSection) =>
    setSettingsAt({ section: section ?? remembered<SettingsSection>('settings:section') ?? 'general' }), [])
  const [tuning, setTuning] = useState(false)
  const [framing, setFraming] = useState(false)
  const [previewHidden, setPreviewHidden] = useState(false)
  const [addingStream, setAddingStream] = useState(false)
  // Where 赛程 was opened from: closing it, by choice or after a pick, goes back there.
  const [scheduleFrom, setScheduleFrom] = useState<'intake' | 'source' | null>(null)
  const scheduleOpen = scheduleFrom !== null
  const openRecords = useCallback((tab: RecordsTab, uid?: string) => setSettingsAt({ section: 'records', records: { tab, uid } }), [])
  const loader = useSourceLoader()
  const composer = useComposer()
  usePlaybackHeartbeat()
  const theater = useRef<HTMLDivElement | null>(null)
  const dock = useRef<HTMLElement | null>(null)
  // The picture-in-picture, the danmaku panel and the local gift effects all keep clear of
  // the dock, whose height changes as it folds into two rows on a narrow window.
  usePublishedHeight(dock, theater, '--bar-clearance')

  const busyChrome = intake || tuning || settingsAt !== null || addingStream || scheduleOpen
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
  // Read the schedule now so 赛程 opens on data instead of waiting for Liquipedia.
  useEffect(() => { prefetchSchedule() }, [])
  // Suspend, never dispose: the session is shared with the scene editor route.
  useEffect(() => () => session.suspend(), [session])
  useEffect(() => {
    const media = session.snapshot.media
    // 添加直播间 greets a fresh start only; once the viewer is in the player, only its button
    // brings it back (not an empty side, a dropped file or a return from the editor).
    // `studio:entered` lives for the window, so it survives the editor round trip, not a reload.
    if (!remembered('studio:entered') && media.official.status === 'empty' && media.commentary.status === 'empty') setIntake(true)
  }, [session])

  const closeIntake = useCallback(() => { remember('studio:entered', true); setIntake(false); setDroppedFile(null) }, [])

  // One side alone belongs on the big screen, not in the corner over an empty picture. The
  // swap made for that is undone once the empty side arrives; a swap the viewer made is kept.
  const autoSwapped = useRef(false)
  const mainStatus = snapshot.media[mainRole].status
  const otherStatus = snapshot.media[otherRole].status
  useEffect(() => {
    if (mainStatus === 'empty' && otherStatus !== 'empty') {
      autoSwapped.current = !autoSwapped.current
      session.swapRoles()
    } else if (autoSwapped.current && otherStatus !== 'empty' && mainStatus !== 'empty') {
      autoSwapped.current = false
      session.swapRoles()
    }
  }, [mainRole, mainStatus, otherStatus, session])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const step = event.shiftKey ? snapshot.settings.largeStepSeconds : snapshot.settings.smallStepSeconds
      // ←/→ move playback the way any player does. Both sides move together, so the
      // alignment between them is kept; the alignment itself is nudged with , and .
      const seek = (seconds: number): void => {
        for (const role of SOURCE_ROLES) if (session.snapshot.media[role].status !== 'empty') void session.seekPlayback(role, seconds)
      }
      switch (event.code) {
        case 'Space': event.preventDefault(); void session.togglePlaying(); break
        case 'ArrowLeft': event.preventDefault(); seek(event.shiftKey ? -SEEK_LARGE : -SEEK_SMALL); break
        case 'ArrowRight': event.preventDefault(); seek(event.shiftKey ? SEEK_LARGE : SEEK_SMALL); break
        // , and . sit under < and >: picture back, picture forward, like the two buttons.
        case 'Comma': event.preventDefault(); nudge('late', step); break
        case 'Period': event.preventDefault(); nudge('early', step); break
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
        if (intake) { setDroppedFile(file); return }
        // In the player a file goes straight to a side: an empty one, else the big picture.
        const media = session.snapshot.media
        const target = SOURCE_ROLES.find((role) => media[role].status === 'empty' && !loader.state[role].busy) ?? mainRole
        void loader.loadFile(target, file)
      }}
    >
      <DanmakuActionsProvider onOpenRecords={openRecords}>
        <main className="theater" ref={theater} data-chrome={chrome.visible ? 'on' : 'off'} {...chrome.handlers}>
          <div className="theater-main" ref={mountMain} data-role={mainRole} />
          <DanmakuStage onReply={() => setChat(true)} />
          <ExtraStreams adding={addingStream} onAddingChange={setAddingStream} />
          {camera.config && <CameraOverlay config={camera.config} onWindow={camera.setWindow} stageRef={theater} onUpscaleState={setCameraUpscale} />}

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
              {SOURCE_ROLES.map((role) => (
                <SourceChip key={role} role={role}
                  onSchedule={role === 'official' ? () => setScheduleFrom('source') : undefined}
                  onShowPreview={previewHidden && role === otherRole && snapshot.media[role].status !== 'empty'
                    ? () => setPreviewHidden(false) : null} />
              ))}
              <button type="button" className="icon-btn glass small" onClick={() => setAddingStream((open) => !open)}
                aria-label="同屏观看其他直播间" title="同屏观看其他直播间" aria-expanded={addingStream}>
                <Icon name="plus" />
              </button>
            </div>
            {/* With the chat open, 设置 lives in its header; without it, here. */}
            {!chatOpen && (
              <div className="topbar-tools">
                {hasRoom && (
                  <button type="button" className="icon-btn glass" onClick={() => setChat(true)} aria-label="展开弹幕" title="弹幕列表（C）">
                    <Icon name="chat" />
                  </button>
                )}
                <button type="button" className="icon-btn glass" onClick={() => openSettings()} aria-label="设置" title="设置">
                  <Icon name="gear" />
                </button>
              </div>
            )}
          </header>

          <Toasts />
          {fullscreen.error && <p className="toast is-error floating-error" role="alert">{fullscreen.error}</p>}

          <footer className="dock" ref={dock}>
            <CountdownPrompt />
            <Timeline />
            <div className="dock-row">
              <div className="dock-left">
                <PlayButton />
                <Volumes />
              </div>
              <div className="dock-center">
                <SyncCapsule />
                <AutoAlign />
              </div>
              <div className="dock-right">
                <QualityMenu />
                <CameraButton camera={camera} onFrame={() => setFraming(true)} upscale={cameraUpscale} />
                <CaptureControls source={() => session.engine.element(session.snapshot.mainRole)} />
                <PipButton />
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
          {intake && <Intake onClose={closeIntake} pendingFile={droppedFile} onSchedule={() => { closeIntake(); setScheduleFrom('intake') }} />}
        </main>

        {chatOpen && (
          <ChatDrawer onClose={() => setChat(false)} onOpenSettings={openSettings} onOpenRecords={openRecords} />
        )}

        {scheduleOpen && (
          <ScheduleSheet onWatch={(url) => loader.loadInput('official', url)} onClose={() => {
            if (scheduleFrom === 'intake') setIntake(true)
            setScheduleFrom(null)
          }} />
        )}
        {settingsAt && (
          <SettingsSheet target={settingsAt} room={snapshot.danmaku.room} onClose={() => setSettingsAt(null)}
            onWatch={(room) => void loader.loadInput('commentary', room, 'douyu')}
            onFill={(text) => { composer.fill(text); setChat(true) }} />
        )}
        {framing && (
          <CameraFraming
            key={camera.room}
            initial={camera.config?.crop ?? null}
            onSave={(crop) => { camera.save(crop); setFraming(false) }}
            onRemove={camera.config ? () => { camera.remove(); setFraming(false) } : null}
            onClose={() => setFraming(false)}
          />
        )}
      </DanmakuActionsProvider>
    </div>
  )
}
