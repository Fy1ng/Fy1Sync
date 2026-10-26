/**
 * One source, as a tag in the top bar: which side, where from, whether it plays. Clicking it
 * opens what can be changed about that side — the link, and for the voice its danmaku room.
 * Quality (QualityMenu) and the streamer camera (CameraButton) are in the dock.
 */

import { useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { SourceRole } from '../core/types'
import { bufferStatusText } from '../ui/bufferStatus'
import { Icon, Popover, Segmented, usePopover } from './kit'
import { findLiveOfficial } from './officialLive'
import { PLATFORM_LABEL, ROLE_LABEL, parseRoomInput, sourceTitle, useSourceLoader, type RoomPlatform } from './sources'

export function SourceChip({ role, onEmpty, onShowPreview = null }: {
  role: SourceRole
  onEmpty: () => void
  /** Set while this side's small picture is hidden; offered when the pointer rests on the chip. */
  onShowPreview?: (() => void) | null
}): React.ReactNode {
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const panel = usePopover()
  const state = snapshot.media[role]
  const descriptor = state.descriptor
  const status = loader.state[role].busy ? 'loading' : state.status
  const where = descriptor ? sourceTitle(descriptor) : '未载入'

  return (
    <div className={`chip-wrap${onShowPreview && !panel.open ? ' has-drop' : ''}`}>
      <button type="button" className="chip" data-role={role} data-status={status}
        onClick={state.status === 'empty' && !loader.state[role].busy ? onEmpty : panel.toggle}
        aria-expanded={panel.open} aria-label={`${ROLE_LABEL[role]}：${where}`}>
        <span className="chip-dot" aria-hidden="true" />
        <span className="chip-role">{ROLE_LABEL[role]}</span>
        <span className="chip-where">{where}</span>
        {snapshot.mainRole === role && state.status !== 'empty' && <span className="chip-main" title="当前为主画面">主画面</span>}
      </button>
      {onShowPreview && !panel.open && (
        <div className="chip-drop">
          <button type="button" className="btn-glass small" onClick={onShowPreview}>显示小画面</button>
        </div>
      )}
      <Popover open={panel.open} onClose={panel.close} className="source-pop" label={`${ROLE_LABEL[role]}片源`}>
        <SourcePanel role={role} onDone={panel.close} />
      </Popover>
    </div>
  )
}

function SourcePanel({ role, onDone }: {
  role: SourceRole
  onDone: () => void
}): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const state = snapshot.media[role]
  const load = loader.state[role]
  const [input, setInput] = useState(state.descriptor?.input ?? '')
  const [roomPlatform, setRoomPlatform] = useState<RoomPlatform>(state.descriptor?.platform === 'bilibili' ? 'bilibili' : 'douyu')
  const bareRoom = parseRoomInput(input)?.platform === null
  const buffer = snapshot.buffers[role]

  return (
    <div className="source-panel">
      <form className="link-row" onSubmit={(event) => {
        event.preventDefault()
        void loader.loadInput(role, input, bareRoom ? roomPlatform : undefined).then((ok) => { if (ok) onDone() })
      }}>
        <input value={input} onChange={(event) => setInput(event.target.value)} aria-label={`${ROLE_LABEL[role]}链接`}
          placeholder={role === 'official' ? 'YouTube 或 Twitch 直播间链接' : '斗鱼或哔哩哔哩直播间链接、房间号'} spellCheck={false} />
        <button type="submit" className="btn-solid" disabled={load.busy || input.trim() === ''}>
          {load.busy ? '载入中' : '载入'}
        </button>
      </form>
      {role === 'official' && <FindOfficial onDone={onDone} />}
      {bareRoom && (
        <Segmented label="房间号所属平台" value={roomPlatform} onChange={setRoomPlatform}
          options={[{ value: 'douyu', label: PLATFORM_LABEL.douyu }, { value: 'bilibili', label: PLATFORM_LABEL.bilibili }]} />
      )}
      {load.problem && (
        <p className="form-error" role="alert">{load.problem.message}{load.problem.hint ? ` ${load.problem.hint}` : ''}</p>
      )}
      {state.status === 'error' && state.error && <p className="form-error">{state.error.message}</p>}
      {load.notes.map((note) => <p key={note} className="muted">{note}</p>)}

      {buffer && <p className="muted">{bufferStatusText(buffer)}</p>}

      {role === 'commentary' && <DanmakuRoom />}
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
  const { danmaku } = useSessionSnapshot()
  const { roomName, connectRoom, disconnectRoom } = useSourceLoader()
  const [editing, setEditing] = useState(false)
  const [room, setRoom] = useState('')

  if (!editing) {
    return (
      <div className="row-split">
        <span className="muted">
          弹幕：{danmaku.connected ? `房间 ${roomName}` : danmaku.room ? `正在连接房间 ${roomName}` : '未连接'}
        </span>
        <button type="button" className="btn-quiet small" onClick={() => setEditing(true)}>
          {danmaku.room ? '更换房间' : '连接'}
        </button>
      </div>
    )
  }
  return (
    <form className="link-row" onSubmit={(event) => {
      event.preventDefault()
      const value = room.trim()
      if (value) { connectRoom(value); setEditing(false) }
    }}>
      <input value={room} autoFocus onChange={(event) => setRoom(event.target.value)} aria-label="弹幕房间号" placeholder="斗鱼房间号" />
      <button type="submit" className="btn-solid" disabled={room.trim() === ''}>连接</button>
      {danmaku.room && (
        <button type="button" className="btn-quiet" onClick={() => { disconnectRoom(); setEditing(false) }}>断开</button>
      )}
    </form>
  )
}

/** Replace the picture with whichever CS2 event channel is live now. */
function FindOfficial({ onDone }: { onDone: () => void }): React.ReactNode {
  const loader = useSourceLoader()
  const [status, setStatus] = useState<string | null>(null)
  const [missed, setMissed] = useState(false)
  return (
    <div className="row-split">
      <span className="muted">{status ?? (missed ? '目前没有正在直播的 CS2 赛事官方频道' : 'CS2 赛事官方直播')}</span>
      <button type="button" className="btn-quiet small" disabled={status !== null} onClick={() => {
        setMissed(false)
        setStatus('正在查找')
        void findLiveOfficial((url) => loader.loadInput('official', url), (channel) => setStatus(`正在查找 ${channel.name}`))
          .then((found) => { setStatus(null); if (found) onDone(); else setMissed(true) })
      }}>查找正在直播的</button>
    </div>
  )
}
