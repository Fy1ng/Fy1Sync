/**
 * The player: one picture, edge to edge, with everything else out of the way until the
 * pointer moves.
 *
 * Like the page it replaces, it never renders a `<video>`: both elements belong to
 * `MediaEngine`, and the mounts below are containers it moves them into, so swapping the
 * big picture and the small one relocates live elements instead of remounting them.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useDockFold, useFullscreen, useMediaMount, useOverlayVisibility, usePublishedHeight } from '../app/hooks'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { SEEK_SHORTCUT_STEPS, shortcutActionFor, shortcutTitle } from '../app/shortcuts'
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
import { Icon, popoverTrigger } from './kit'
import { PipButton } from './PipButton'
import type { RecordsTab } from './records/DanmakuRecords'
import { ScheduleSheet } from './schedule/ScheduleSheet'
import { prefetchSchedule } from './schedule/store'
import { ErrorText } from '../ui/ErrorDetails'
import { setNoticeSink, syncLiveNotices } from './douyu/followingNotices'
import { SettingsSheet, type SettingsSection, type SettingsTarget } from './SettingsSheet'
import { SourceChip } from './SourceChip'
import { SourceLoaderProvider, ROLE_LABEL, useSourceLoader } from './sources'
import { ADD_STREAM_POPOVER, ExtraStreams } from './streams/ExtraStreams'
import { AutoAlign, nudgeStepFor, PlaybackRecoveryPrompt, startAutoAlign, SyncCapsule, useNudge } from './sync'
import { useComposer } from './composer'
import { Toasts } from './Toasts'
import { QualityMenu } from './QualityMenu'
import { DanmakuSwitch, PlayButton, Timeline, Volumes } from './transport'
import './studio.css'
import { remember, remembered } from '../app/remembered'
import { EmbeddedLoginOverlay, useEmbeddedLoginState } from './login/EmbeddedLogin'
import { Favorites } from './favorites/Favorites'
import { useDouyuLottery } from './douyu/douyuLottery'
import { usePlatformRoomActivities } from './PlatformRoomActivities'

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
  const platformRooms = usePlatformRoomActivities()
  const restrictedChatSources = SOURCE_ROLES.filter(role => {
    const source = snapshot.media[role]
    return source.status === 'ready' && (source.descriptor?.platform === 'youtube' || source.descriptor?.platform === 'twitch')
  })
  const chatRoom = snapshot.danmaku.room
  const douyuRoom = chatRoom && /^[1-9][0-9]{0,11}$/.test(chatRoom) ? chatRoom : null
  const lottery = useDouyuLottery(douyuRoom, snapshot.danmaku.connected, {
    read: room => apiClient.feature('getDouyuLottery', { room }),
    openOfficialRoom: (room, activityId) => apiClient.feature('openDouyuLotteryRoom', { room, activityId }),
    notify: text => {
      const id = session.notice('info', text)
      return () => session.dismissNotice(id)
    },
  })
  useLayoutEffect(() => {
    session.setDouyuLotteryCommandMatcher(lottery.matchCommand)
    return () => session.setDouyuLotteryCommandMatcher(null)
  }, [session, lottery.matchCommand])
  const embeddedLogin = useEmbeddedLoginState()
  const root = useRef<HTMLDivElement | null>(null)
  const fullscreen = useFullscreen(root)
  const camera = useCamera()
  const [cameraUpscale, setCameraUpscale] = useState(INITIAL_UPSCALE_STATE)
  const nudge = useNudge()
  const [intake, setIntake] = useState(false)
  const [favorites, setFavorites] = useState(false)
  const [settingsAt, setSettingsAt] = useState<SettingsTarget | null>(null)
  // The gear reopens 设置 where it was left; links that name a section go there.
  const openSettings = useCallback((section?: SettingsSection, account?: SettingsTarget['account']) =>
    setSettingsAt({ section: section ?? remembered<SettingsSection>('settings:section') ?? 'general', ...(account ? { account } : {}) }), [])
  const [tuning, setTuning] = useState(false)
  const [framing, setFraming] = useState(false)
  const [previewHidden, setPreviewHidden] = useState(false)
  const [addingStream, setAddingStream] = useState(false)
  // 赛程 opens over 添加直播间 or the player and closes back to whichever is behind it.
  const [scheduleFrom, setScheduleFrom] = useState<'intake' | 'source' | null>(null)
  const scheduleOpen = scheduleFrom !== null
  const openRecords = useCallback((tab: RecordsTab, uid?: string) => setSettingsAt({ section: 'records', records: { tab, uid } }), [])
  const loader = useSourceLoader()
  const composer = useComposer()
  usePlaybackHeartbeat()
  const theater = useRef<HTMLDivElement | null>(null)
  const primary = useRef<HTMLDivElement | null>(null)
  const dock = useRef<HTMLElement | null>(null)
  // The picture-in-picture, the danmaku panel and the local gift effects all keep clear of
  // the dock, whose height changes as it folds into two rows on a narrow window.
  usePublishedHeight(dock, theater, '--bar-clearance')
  const dockRow = useRef<HTMLDivElement | null>(null)
  const dockFold = useDockFold(dockRow)
  // The bars stay while the pointer rests on them, still or not.
  const [onChrome, setOnChrome] = useState(false)
  const chromeHover = { onPointerEnter: () => setOnChrome(true), onPointerLeave: () => setOnChrome(false) }

  const aligning = snapshot.autoSync.phase !== 'idle' && snapshot.autoSync.phase !== 'done' && snapshot.autoSync.phase !== 'failed'
  const busyChrome = favorites || intake || tuning || settingsAt !== null || addingStream || scheduleOpen
    || onChrome || (aligning && !fullscreen.active) || embeddedLogin !== null
  const chrome = useOverlayVisibility(3200, !snapshot.playing || busyChrome)
  // The drawer is the room's chat; with no room there is nothing to hold it open for.
  const hasRoom = snapshot.danmaku.connected || snapshot.danmaku.room !== null || platformRooms.hasBilibili || restrictedChatSources.length > 0
  const hasSidebar = hasRoom || (snapshot.settings.recognitionMode === 'basic' && snapshot.settings.basicRecognitionPanelVisible
    && SOURCE_ROLES.some(role => snapshot.media[role].status !== 'empty'))
  const chatOpen = snapshot.settings.sidebarVisible && hasSidebar
  const setChat = useCallback((open: boolean) => session.updateSettings({ sidebarVisible: open }), [session])

  const mainRole = snapshot.mainRole
  const otherRole: SourceRole = mainRole === 'official' ? 'commentary' : 'official'
  const mountMain = useMediaMount(mainRole)
  const mountOther = useMediaMount(otherRole)
  const empty = snapshot.media.official.status === 'empty' && snapshot.media.commentary.status === 'empty'

  useEffect(() => { void session.boot() }, [session])
  // Read the schedule now so 赛程 opens on data instead of waiting for Liquipedia.
  useEffect(() => { prefetchSchedule() }, [])
  // A 开播提醒 left on survives a reload of this window: take it from main, and send its notices
  // to the toast line even while 关注 has not been opened.
  useEffect(() => {
    setNoticeSink((text) => session.notice('info', text))
    void syncLiveNotices()
  }, [session])
  // Suspend, never dispose: the session is shared with the scene editor route.
  useEffect(() => () => session.suspend(), [session])
  useEffect(() => {
    const media = session.snapshot.media
    // 添加直播间 greets a fresh start only; once the viewer is in the player, only its button
    // brings it back (not an empty side or a return from the editor).
    // `studio:entered` lives for the window, so it survives the editor round trip, not a reload.
    if (!remembered('studio:entered') && media.official.status === 'empty' && media.commentary.status === 'empty') setIntake(true)
  }, [session])

  const closeIntake = useCallback(() => { remember('studio:entered', true); setIntake(false) }, [])

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
      if (embeddedLogin || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"], [role="alertdialog"]')) return
      const { shortcuts, smallStepSeconds, largeStepSeconds } = session.settings
      const action = shortcutActionFor(shortcuts, event.code)
      if (!action) return
      event.preventDefault()
      const step = nudgeStepFor(event.shiftKey, smallStepSeconds, largeStepSeconds)
      const seekStep = event.shiftKey ? SEEK_SHORTCUT_STEPS.shift : SEEK_SHORTCUT_STEPS.normal
      const seek = (seconds: number): void => {
        const role = session.snapshot.mainRole
        if (session.snapshot.media[role].status !== 'empty') void session.seekPlayback(role, seconds)
      }
      switch (action) {
        case 'togglePlayback': void session.togglePlaying(); break
        case 'seekBack': seek(-seekStep); break
        case 'seekForward': seek(seekStep); break
        case 'nudgeBack': nudge('late', step); break
        case 'nudgeForward': nudge('early', step); break
        case 'autoAlign': startAutoAlign(session, !fullscreen.active); break
        case 'toggleDanmaku': session.updateDanmakuSettings({ enabled: !session.settings.danmaku.enabled }); break
        case 'toggleSidebar': setChat(!session.settings.sidebarVisible); break
        case 'toggleFullscreen': fullscreen.toggle(); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [embeddedLogin, fullscreen, nudge, session, setChat])

  useEffect(() => {
    const ignoreFiles = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files') && !event.dataTransfer?.files.length) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('dragover', ignoreFiles, true)
    window.addEventListener('drop', ignoreFiles, true)
    return () => {
      window.removeEventListener('dragover', ignoreFiles, true)
      window.removeEventListener('drop', ignoreFiles, true)
    }
  }, [])

  return (
    <div
      className="studio"
      ref={root}
      data-chat={chatOpen ? 'open' : 'closed'}
    >
      <DanmakuActionsProvider onOpenRecords={openRecords}>
        <main className="theater" ref={theater} data-chrome={chrome.visible ? 'on' : 'off'} {...chrome.handlers}
          onKeyDown={(event) => {
            if (fullscreen.active && shortcutActionFor(snapshot.settings.shortcuts, event.code) === 'autoAlign') return
            chrome.handlers.onKeyDown()
          }}>
          <header className="topbar" {...chromeHover}>
            <div className="topbar-sources">
              <button type="button" className="icon-btn glass small" aria-label="收藏直播间" title="收藏直播间" onClick={() => setFavorites(true)}><Icon name="star" /></button>
              {SOURCE_ROLES.map((role) => (
                <SourceChip key={role} role={role}
                  onSchedule={role === 'official' ? () => setScheduleFrom('source') : undefined}
                  onShowPreview={previewHidden && role === otherRole && snapshot.media[role].status !== 'empty'
                    ? () => setPreviewHidden(false) : null} />
              ))}
              <button type="button" className="icon-btn glass small"
                {...popoverTrigger(ADD_STREAM_POPOVER, addingStream, () => setAddingStream((open) => !open))}
                aria-label="同屏观看其他直播间" title="同屏观看其他直播间">
                <Icon name="plus" />
              </button>
            </div>
            {/* With the chat open, 设置 lives in its header; without it, here. */}
            {!chatOpen && (
              <div className="topbar-tools">
                {hasSidebar && (
                  <button type="button" className="icon-btn glass" onClick={() => setChat(true)} aria-label="展开弹幕" title={shortcutTitle('弹幕列表', snapshot.settings.shortcuts.toggleSidebar)}>
                    <Icon name="chat" />
                  </button>
                )}
                <button type="button" className="icon-btn glass" onClick={() => openSettings()} aria-label="设置" title="设置">
                  <Icon name="gear" />
                </button>
              </div>
            )}
          </header>

          <ExtraStreams adding={addingStream} onAddingChange={setAddingStream} primaryRef={primary}>
            {(split) => <>
              <div className="theater-main" ref={mountMain} data-role={mainRole} />
              <DanmakuStage onReply={() => setChat(true)} />
              {camera.available && camera.config && <CameraOverlay key={camera.room} config={camera.config} onWindow={camera.setWindow} stageRef={primary} fitStage={split} onUpscaleState={setCameraUpscale} />}

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

              {empty && !intake && (
                <div className="theater-empty">
                  <button type="button" className="btn-glass" onClick={() => setIntake(true)}>添加直播间</button>
                </div>
              )}
            </>}
          </ExtraStreams>

          <Toasts hideAutoSync={fullscreen.active && !chrome.visible} />
          {fullscreen.error && <p className="toast is-error floating-error" role="alert"><ErrorText error={fullscreen.errorDetail ?? fullscreen.error} message={fullscreen.error} /></p>}

          <footer className="dock" ref={dock} {...chromeHover}>
            <PlaybackRecoveryPrompt />
            <Timeline />
            <div className="dock-row" ref={dockRow} data-fold={dockFold}>
              <div className="dock-left">
                <PlayButton />
                <Volumes />
              </div>
              <div className="dock-center">
                <SyncCapsule />
                <AutoAlign showRecognitionPanel={!fullscreen.active} />
              </div>
              <div className="dock-right">
                <QualityMenu />
                <CameraButton camera={camera} onFrame={() => setFraming(true)} upscale={cameraUpscale} />
                <CaptureControls source={() => session.engine.element(session.snapshot.mainRole)} />
                <PipButton />
                <DanmakuSwitch onTune={() => setTuning((open) => !open)} />
                <button type="button" className="icon-btn" onClick={fullscreen.toggle} aria-pressed={fullscreen.active}
                  aria-label={fullscreen.active ? '退出全屏' : '全屏'} title={shortcutTitle(fullscreen.active ? '退出全屏' : '全屏', snapshot.settings.shortcuts.toggleFullscreen)}>
                  <Icon name={fullscreen.active ? 'shrink' : 'expand'} />
                </button>
              </div>
            </div>
          </footer>

          {tuning && <DanmakuPanel onClose={() => setTuning(false)} />}
          {intake && <Intake onClose={closeIntake} onSchedule={() => setScheduleFrom('intake')} onFavorites={() => setFavorites(true)} />}
        </main>

        {chatOpen && (
          <ChatDrawer onClose={() => setChat(false)} onOpenSettings={openSettings} onOpenRecords={openRecords}
            douyuLottery={douyuRoom ? lottery : undefined} platformActivities={platformRooms.cards} restrictedChatSources={restrictedChatSources} />
        )}

        {favorites && <Favorites onClose={() => setFavorites(false)} />}
        {scheduleOpen && (
          <ScheduleSheet onWatch={(url) => void loader.loadInput('official', url)} onClose={() => setScheduleFrom(null)} />
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
            onRemove={camera.config ? () => {
              if (!camera.remove()) return false
              setFraming(false)
              return true
            } : null}
            onClose={() => setFraming(false)}
          />
        )}
        <EmbeddedLoginOverlay state={embeddedLogin} />
      </DanmakuActionsProvider>
    </div>
  )
}
