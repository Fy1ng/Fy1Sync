/**
 * One source, as a tag in the top bar: which side, where from, whether it plays. Clicking it
 * opens what can be changed about that side — the link, the quality, and for the voice its
 * danmaku room and the streamer camera window.
 */

import { useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { CameraControls } from '../app/useCamera'
import type { SourceRole } from '../core/types'
import { bufferStatusText } from '../ui/bufferStatus'
import { Icon, Popover, Segmented, usePopover } from './kit'
import { PLATFORM_LABEL, ROLE_LABEL, useSourceLoader } from './sources'

export function SourceChip({ role, onEmpty, camera, onFrameCamera }: {
  role: SourceRole
  onEmpty: () => void
  camera: CameraControls
  onFrameCamera: () => void
}): React.ReactNode {
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const panel = usePopover()
  const state = snapshot.media[role]
  const descriptor = state.descriptor
  const status = loader.state[role].busy ? 'loading' : state.status
  const where = descriptor ? `${descriptor.platform ? PLATFORM_LABEL[descriptor.platform] : ''} ${descriptor.label}`.trim() : '还没有'

  return (
    <div className="chip-wrap">
      <button type="button" className="chip" data-role={role} data-status={status}
        onClick={state.status === 'empty' && !loader.state[role].busy ? onEmpty : panel.toggle}
        aria-expanded={panel.open} aria-label={`${ROLE_LABEL[role]}：${where}`}>
        <span className="chip-dot" aria-hidden="true" />
        <span className="chip-role">{ROLE_LABEL[role]}</span>
        <span className="chip-where">{where}</span>
        {snapshot.mainRole === role && state.status !== 'empty' && <span className="chip-main" title="正在大屏显示">大屏</span>}
      </button>
      <Popover open={panel.open} onClose={panel.close} className="source-pop" label={`${ROLE_LABEL[role]}片源`}>
        <SourcePanel role={role} camera={camera} onFrameCamera={() => { panel.close(); onFrameCamera() }} onDone={panel.close} />
      </Popover>
    </div>
  )
}

function SourcePanel({ role, camera, onFrameCamera, onDone }: {
  role: SourceRole
  camera: CameraControls
  onFrameCamera: () => void
  onDone: () => void
}): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const state = snapshot.media[role]
  const load = loader.state[role]
  const [input, setInput] = useState(state.descriptor?.input ?? '')
  const qualities = state.descriptor?.sourceQualities ?? []
  const buffer = snapshot.buffers[role]

  return (
    <div className="source-panel">
      <form className="link-row" onSubmit={(event) => {
        event.preventDefault()
        void loader.loadInput(role, input).then((ok) => { if (ok) onDone() })
      }}>
        <input value={input} onChange={(event) => setInput(event.target.value)} aria-label={`${ROLE_LABEL[role]}链接`}
          placeholder={role === 'official' ? 'YouTube 或 Twitch 直播间' : '斗鱼或 B 站直播间'} spellCheck={false} />
        <button type="submit" className="btn-solid" disabled={load.busy || input.trim() === ''}>
          {load.busy ? '载入中' : '换源'}
        </button>
      </form>
      {load.problem && (
        <p className="form-error" role="alert">{load.problem.message}{load.problem.hint ? ` ${load.problem.hint}` : ''}</p>
      )}
      {state.status === 'error' && state.error && <p className="form-error">{state.error.message}</p>}
      {load.notes.map((note) => <p key={note} className="muted">{note}</p>)}

      {qualities.length > 0 && (
        qualities.length <= 5
          ? <Segmented label="清晰度" value={state.descriptor?.sourceQuality ?? ''} disabled={snapshot.qualityBusy[role]}
              onChange={(quality) => void session.changeSourceQuality(role, quality)}
              options={qualities.map((option) => ({ value: option.id, label: option.label }))} />
          : <label className="field-row"><span>清晰度</span>
              <select value={state.descriptor?.sourceQuality ?? ''} disabled={snapshot.qualityBusy[role]}
                onChange={(event) => void session.changeSourceQuality(role, event.target.value)}>
                {qualities.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
      )}
      {qualities.length === 0 && state.quality.length > 1 && (
        <label className="field-row"><span>清晰度</span>
          <select value={state.level} onChange={(event) => session.engine.setLevel(role, Number(event.target.value))}>
            {state.quality.map((option) => <option key={option.level} value={option.level}>{option.label}</option>)}
          </select>
        </label>
      )}
      {buffer && <p className="muted">{bufferStatusText(buffer)}</p>}

      {role === 'commentary' && <DanmakuRoom />}
      {role === 'commentary' && camera.available && (
        <div className="row-split">
          <span className="muted">主播摄像头小窗</span>
          <span className="row-end">
            {camera.config && (
              <button type="button" className="btn-quiet small" onClick={() => camera.setEnabled(!camera.config!.enabled)}>
                {camera.config.enabled ? '隐藏' : '显示'}
              </button>
            )}
            <button type="button" className="btn-quiet small" onClick={onFrameCamera}>{camera.config ? '重新框选' : '框选'}</button>
          </span>
        </div>
      )}

      <div className="row-split panel-foot">
        <label className="btn-quiet small file-pick">
          <Icon name="file" /> 本地文件
          <input type="file" accept="video/*" disabled={load.busy} onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void loader.loadFile(role, file).then(onDone)
          }} />
        </label>
        {state.status !== 'empty' && (
          <button type="button" className="btn-quiet small is-danger" onClick={() => { session.unloadSource(role); onDone() }}>
            移除
          </button>
        )}
      </div>
    </div>
  )
}

/** The voice's danmaku usually come with its room; this is for watching one room's chat with another's video. */
function DanmakuRoom(): React.ReactNode {
  const session = useSession()
  const { danmaku } = useSessionSnapshot()
  const [editing, setEditing] = useState(false)
  const [room, setRoom] = useState('')

  if (!editing) {
    return (
      <div className="row-split">
        <span className="muted">
          弹幕 {danmaku.connected ? `来自房间 ${danmaku.room}` : danmaku.room ? `正在连接 ${danmaku.room}` : '未连接'}
        </span>
        <button type="button" className="btn-quiet small" onClick={() => setEditing(true)}>
          {danmaku.room ? '换房间' : '连接'}
        </button>
      </div>
    )
  }
  return (
    <form className="link-row" onSubmit={(event) => {
      event.preventDefault()
      const value = room.trim()
      if (value) { session.connectDanmaku(value); setEditing(false) }
    }}>
      <input value={room} autoFocus onChange={(event) => setRoom(event.target.value)} aria-label="弹幕房间号" placeholder="斗鱼房间号" />
      <button type="submit" className="btn-solid" disabled={room.trim() === ''}>连接</button>
      {danmaku.room && (
        <button type="button" className="btn-quiet" onClick={() => { session.disconnectDanmaku(); setEditing(false) }}>断开</button>
      )}
    </form>
  )
}
