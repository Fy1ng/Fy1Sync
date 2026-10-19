/**
 * The player page: two video slots, an overlay bar, a sidebar and a source dialog.
 *
 * The important structural detail is that this component never renders a `<video>`. Both
 * elements belong to `MediaEngine`; the slots below are empty containers it moves them
 * into. Swapping main and preview therefore relocates a live element instead of
 * remounting one, which is what keeps the buffer, the hls.js attachment and the playhead
 * intact — the very things sync is measuring.
 */

import { useEffect, useRef, useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import {
  useFullscreen,
  useMediaMount,
  useOverlayVisibility,
  usePublishedHeight,
} from '../app/hooks'
import { roleName } from '../app/session'
import type { RoleStatus } from '../media/mediaEngine'
import type { SourceRole } from '../core/types'
import { useCamera } from '../app/useCamera'
import { CameraCropDialog } from './CameraCropDialog'
import { CameraOverlay } from './CameraOverlay'
import { DanmakuLayer } from './DanmakuLayer'
import { DanmakuSettingsPanel } from './DanmakuSettingsPanel'
import { NoticeStrip } from './NoticeStrip'
import { OverlayBar } from './OverlayBar'
import { SourceDialog } from './SourceDialog'
import { SyncSidebar } from './SyncSidebar'

export function PlayerPage(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const fullscreen = useFullscreen(stageRef)
  // The preview thumbnail and the danmaku settings panel both have to stay clear of the
  // overlay bar, and the bar's height depends on how many rows it folded into. Measured on
  // the stage so both of them can read it — they are inside it, and it is the element the
  // container queries that fold the bar are querying.
  usePublishedHeight(barRef, stageRef, '--bar-clearance')
  // Paused keeps the bar up: hiding the play button from someone who just paused is the
  // one moment they are certain to want it.
  const overlay = useOverlayVisibility(5000, !snapshot.playing)
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false)
  const [danmakuPanelOpen, setDanmakuPanelOpen] = useState(false)
  const [cameraDialogOpen, setCameraDialogOpen] = useState(false)
  const camera = useCamera()

  const mainRole = snapshot.mainRole
  const previewRole: SourceRole = mainRole === 'official' ? 'commentary' : 'official'
  const mountMain = useMediaMount(mainRole)
  const mountPreview = useMediaMount(previewRole)

  // Nothing is loaded on a cold start, so open the source dialog rather than presenting
  // an inert black rectangle.
  useEffect(() => {
    const media = session.snapshot.media
    if (media.official.status === 'empty' && media.commentary.status === 'empty') {
      setSourceDialogOpen(true)
    }
  }, [session])

  // The recognition profile lives on the server, so restoring the chosen one is a fetch
  // rather than part of constructing the session.
  useEffect(() => {
    void session.boot()
  }, [session])

  // Suspend, never dispose: the session is a singleton owned by `main.tsx` and shared
  // with the admin page, and its `MediaEngine` holds the two `<video>` elements this page
  // only borrows. Disposing from here would clear the engine's runtime map, and the very
  // next mount — StrictMode's remount, or coming back from /admin — would throw
  // `unknown role` out of the ref callback. `boot` above re-arms what this parks.
  useEffect(() => () => session.suspend(), [session])

  // Fullscreen hides the sidebar (docs/ui-layout.md) but keeps the overlay bar.
  const sidebarVisible = snapshot.settings.sidebarVisible && !fullscreen.active

  return (
    <div className={`player-page ${sidebarVisible ? '' : 'no-sidebar'}`.trim()}>
      <div className="stage" ref={stageRef} {...overlay.handlers}>
        <div className="stage-main" ref={mountMain} data-role={mainRole} />
        <DanmakuLayer />
        {camera.config && <CameraOverlay config={camera.config} onWindow={camera.setWindow} stageRef={stageRef} />}

        <button
          type="button"
          className="preview-slot"
          data-role={previewRole}
          onClick={() => session.swapRoles()}
          title={`点击切换到${roleName(previewRole)}`}
        >
          <span className="preview-mount" ref={mountPreview} />
          <span className="preview-caption">{roleName(previewRole)}</span>
        </button>

        <div className="stage-top">
          <span className="stage-title">
            {roleName(mainRole)}
            <span className="stage-subtitle">{STATUS_TEXT[snapshot.media[mainRole].status]}</span>
          </span>
          <button type="button" className="icon-button" onClick={() => setSourceDialogOpen(true)}>
            片源设置
          </button>
        </div>

        <NoticeStrip />

        <OverlayBar
          ref={barRef}
          visible={overlay.visible}
          onPin={overlay.pin}
          fullscreenActive={fullscreen.active}
          onToggleFullscreen={fullscreen.toggle}
          onOpenDanmakuSettings={() => setDanmakuPanelOpen(true)}
          camera={camera}
          onFrameCamera={() => setCameraDialogOpen(true)}
        />

        {danmakuPanelOpen && <DanmakuSettingsPanel onClose={() => setDanmakuPanelOpen(false)} />}
      </div>

      {sidebarVisible && <SyncSidebar />}

      {sourceDialogOpen && <SourceDialog onClose={() => setSourceDialogOpen(false)} />}

      {cameraDialogOpen && (
        <CameraCropDialog
          initial={camera.config?.crop ?? null}
          onSave={(crop) => { camera.save(crop); setCameraDialogOpen(false) }}
          onRemove={camera.config ? () => { camera.remove(); setCameraDialogOpen(false) } : null}
          onClose={() => setCameraDialogOpen(false)}
        />
      )}
    </div>
  )
}

const STATUS_TEXT: Record<RoleStatus, string> = {
  empty: '未加载',
  loading: '加载中',
  ready: '就绪',
  error: '加载失败',
}
