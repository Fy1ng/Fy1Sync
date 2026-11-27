/**
 * One source, as a tag in the top bar: which side, where from, whether it plays. Clicking it
 * opens what can be changed about that side — the link, and for the voice its danmaku room.
 * An empty side opens the same panel, to add its link there rather than in 添加直播间.
 * Quality (QualityMenu) and the streamer camera (CameraButton) are in the dock.
 */

import { useState } from 'react'
import { ErrorText } from '../ui/ErrorDetails'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { draftFromDirectOptions, EMPTY_DIRECT_DRAFT, hasDirectOptions, parseDirectDraft, type DirectStreamDraft } from '../core/directStream'
import { isCommercialBreakActive, TWITCH_COMMERCIAL_BREAK_NOTICE } from '../core/commercialBreak'
import type { SourceRole } from '../core/types'
import { bufferStatusText } from '../ui/bufferStatus'
import { DirectStreamFields } from './DirectStreamFields'
import { Icon, Popover, Segmented, Switch, usePopover } from './kit'
import { LoginOffer, PLATFORM_LABEL, ROLE_LABEL, SourceIssue, parseDanmakuRoomInput, parseRoomInput, sourceTitle, useSourceLoader, type RoomPlatform, SOURCE_HINT } from './sources'
import { sourceDanmakuRoom } from '../core/sourceDanmaku'
import { danmakuRoom } from '../../server/danmaku/types'
import { canSave, removeSavedRoom, saveRoom, savedFor, useSavedRooms, useSavedRoomsState, type SavedRoom } from './savedRooms'
import { RoomSummary } from './favorites/Favorites'
import { ReadError } from './ReadError'

export function SourceChip({ role, onSchedule, onShowPreview = null, previewToggle = null }: {
  role: SourceRole
  /** Open 赛程; offered on the picture's panel. */
  onSchedule?: () => void
  onShowPreview?: (() => void) | null
  previewToggle?: { visible: boolean; onChange: (visible: boolean) => void } | null
}): React.ReactNode {
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const panel = usePopover()
  const state = snapshot.media[role]
  const descriptor = state.descriptor
  const status = loader.state[role].busy ? 'loading' : state.status
  const where = descriptor ? sourceTitle(descriptor) : '未载入'

  return (
    <div className="chip-wrap">
      <button type="button" className="chip" data-role={role} data-status={status}
        {...panel.trigger} aria-label={`${ROLE_LABEL[role]}：${where}`}>
        <span className="chip-dot" aria-hidden="true" />
        <span className="chip-role">{ROLE_LABEL[role]}</span>
        <span className="chip-where">{where}</span>
        {snapshot.mainRole === role && state.status !== 'empty' && <span className="chip-main" title="当前为主画面">主画面</span>}
      </button>
      {onShowPreview && (
        <button type="button" className="icon-btn glass small" aria-label="显示小画面" title="显示小画面" onClick={onShowPreview}>
          <Icon name="pip" />
        </button>
      )}
      <Popover {...panel.popover} className="source-pop" label={`${ROLE_LABEL[role]}片源`}>
        <SourcePanel role={role} onDone={panel.close} onSchedule={onSchedule} previewToggle={previewToggle} />
      </Popover>
    </div>
  )
}

function SourcePanel({ role, onDone, onSchedule, previewToggle }: {
  role: SourceRole
  onSchedule?: () => void
  onDone: () => void
  previewToggle: { visible: boolean; onChange: (visible: boolean) => void } | null
}): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const state = snapshot.media[role]
  const load = loader.state[role]
  const [input, setInput] = useState(state.descriptor?.input ?? '')
  const initialDirect = state.descriptor?.platform === 'direct'
    ? draftFromDirectOptions({
        ...(state.descriptor.customLabel ? { label: state.descriptor.label } : {}),
        ...(state.descriptor.directHeaders ? { headers: state.descriptor.directHeaders } : {}),
      })
    : { ...EMPTY_DIRECT_DRAFT }
  const [directDraft, setDirectDraft] = useState<DirectStreamDraft>(initialDirect)
  const [directOpen, setDirectOpen] = useState(false)
  const [directProblem, setDirectProblem] = useState<string | null>(null)
  const [chatRetrying, setChatRetrying] = useState(false)
  const [roomPlatform, setRoomPlatform] = useState<RoomPlatform>(state.descriptor?.platform === 'douyin' ? 'douyin' : state.descriptor?.platform === 'huya' ? 'huya' : state.descriptor?.platform === 'bilibili' ? 'bilibili' : 'douyu')
  const bareRoom = parseRoomInput(input)?.platform === null
  const buffer = snapshot.buffers[role]
  const chat = sourceDanmakuRoom(state.descriptor)
  const activeRoom = snapshot.danmaku.room
  const selectedChat = chat !== null && session.isDanmakuRoom(chat.key)

  return (
    <div className="source-panel">
      <form className="link-row" onSubmit={(event) => {
        event.preventDefault()
        if (load.busy) return
        const parsedDirect = parseDirectDraft(directDraft)
        if (!parsedDirect.ok) {
          setDirectProblem(parsedDirect.message)
          setDirectOpen(true)
          return
        }
        setDirectProblem(null)
        void loader.loadInput(
          role,
          input,
          bareRoom ? roomPlatform : undefined,
          ...(hasDirectOptions(parsedDirect.options) ? [parsedDirect.options] : []),
        ).then((ok) => { if (ok) onDone() })
      }}>
        <input value={input} onChange={(event) => { setInput(event.target.value); setDirectProblem(null) }} aria-label={`${ROLE_LABEL[role]}链接`}
          placeholder={SOURCE_HINT} spellCheck={false} />
        {load.busy
          ? <button key="cancel" type="button" className="btn-quiet" onClick={() => loader.cancelLoad(role)}>
            {state.descriptor ? '停止此片源' : '取消载入'}
          </button>
          : <button key="submit" type="submit" className="btn-solid" disabled={input.trim() === ''}>载入</button>}
      </form>
      {!bareRoom && (
        <DirectStreamFields
          input={input}
          draft={directDraft}
          open={directOpen}
          disabled={load.busy}
          onToggle={() => setDirectOpen(open => !open)}
          onChange={next => { setDirectDraft(next); setDirectProblem(null) }}
        />
      )}
      {directProblem && <p className="form-error" role="alert">{directProblem}</p>}
      <SavedList role={role} onPick={(room) => {
        const platform = room.platform === 'douyu' || room.platform === 'bilibili' || room.platform === 'huya' || room.platform === 'douyin' ? room.platform : undefined
        const directOptions = room.platform === 'direct'
          ? { ...(room.label ? { label: room.label } : {}), ...(room.headers ? { headers: room.headers } : {}) }
          : undefined
        setInput(room.input)
        if (platform) setRoomPlatform(platform)
        if (directOptions) setDirectDraft(draftFromDirectOptions(directOptions))
        void loader.loadInput(role, room.input, platform, ...(hasDirectOptions(directOptions) ? [directOptions] : []))
          .then((ok) => { if (ok) onDone() })
      }} />
      {role === 'official' && onSchedule && (
        <div className="row-split">
          <span className="muted">从 CS2 赛程选直播</span>
          <button type="button" className="btn-quiet small" onClick={() => { onDone(); onSchedule() }}>打开赛程</button>
        </div>
      )}
      {bareRoom && (
        <Segmented label="房间号所属平台" value={roomPlatform} onChange={setRoomPlatform}
          options={[{ value: 'douyu', label: PLATFORM_LABEL.douyu }, { value: 'bilibili', label: PLATFORM_LABEL.bilibili }, { value: 'huya', label: PLATFORM_LABEL.huya }, { value: 'douyin', label: PLATFORM_LABEL.douyin }]} />
      )}
      <SourceIssue role={role} className="form-error" />
      {!load.problem && !(state.status === 'error' && state.error) && <LoginOffer role={role} />}
      {load.notes.map((note) => <p key={note} className="muted">{note}</p>)}

      {buffer && !buffer.failure && buffer.state !== 'failed' && <p className="muted">{bufferStatusText(buffer)}</p>}
      {isCommercialBreakActive({
        platform: state.descriptor?.platform,
        status: state.status,
        commercialBreak: buffer?.commercialBreak,
        bufferSeconds: buffer?.seconds,
        currentTime: state.currentTime,
        timebase: state.timebase,
      }) && <p className="note-warn" role="status">{TWITCH_COMMERCIAL_BREAK_NOTICE}</p>}

      {chat && !selectedChat && <p className="muted" role="status">{PLATFORM_LABEL[chat.platform]}弹幕：未选择此房间</p>}
      <DanmakuRoom />
      {chat && (!selectedChat || !session.hasManualDanmakuRoom()) && (
        <button type="button" className="btn-quiet small" onClick={() => loader.connectRoom(chat.key, chat.name)}>选择此房间弹幕</button>
      )}
      {selectedChat && activeRoom && <button type="button" className="btn-quiet small" disabled={chatRetrying} onClick={() => {
        setChatRetrying(true)
        void session.retryDanmaku(chat.key).finally(() => setChatRetrying(false))
      }}>重新连接此房间弹幕</button>}
      {previewToggle && (
        <Switch label="显示小画面" checked={previewToggle.visible} onChange={previewToggle.onChange} />
      )}
      <div className="row-split panel-foot">
        <SaveButton role={role} />
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
  const [platform, setPlatform] = useState<RoomPlatform>('douyu')
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bare = parseRoomInput(room)?.platform === null
  const parsed = parseDanmakuRoomInput(room, platform)

  if (!editing) {
    return (
      <div className="row-split">
        <span className="muted" role="status">
          {danmaku.room ? `${PLATFORM_LABEL[danmakuRoom(danmaku.room).platform]}弹幕` : '弹幕'}：{
            danmaku.connected ? `已连接房间 ${roomName}` : danmaku.error
              ? <ErrorText error={danmaku.errorDetail} message={danmaku.error} />
              : danmaku.room ? `正在连接房间 ${roomName}` : '未连接'}
        </span>
        <button type="button" className="btn-quiet small" onClick={() => setEditing(true)}>
          {danmaku.room ? '更换房间' : '连接'}
        </button>
        {danmaku.room && <button type="button" className="btn-quiet small" onClick={disconnectRoom}>断开</button>}
      </div>
    )
  }
  return (
    <div className="field-stack">
      <form className="link-row" onSubmit={(event) => {
        event.preventDefault()
        if (!parsed || resolving) return
        setError(null)
        if (parsed.douyuLookup) {
          setResolving(true)
          void apiClient.resolveDouyuRoom(parsed.douyuLookup).then(result => {
            if (!result.ok) {
              setError(result.message)
            } else if (!result.value.ok) {
              setError(result.value.failure.message)
            } else {
              connectRoom(result.value.identity.room, parsed.name)
              setEditing(false)
            }
          }).catch(() => setError('弹幕房间查询失败，请重试')).finally(() => setResolving(false))
          return
        }
        connectRoom(parsed.key, parsed.platform === 'douyu' ? undefined : parsed.name)
        setEditing(false)
      }}>
        <input value={room} autoFocus onChange={(event) => { setRoom(event.target.value); setError(null) }}
          aria-label="弹幕房间号" placeholder="房间号或斗鱼/B站/虎牙/抖音链接" />
        <button type="submit" className="btn-solid" disabled={!parsed || resolving}>{resolving ? '查询中' : '连接'}</button>
        {danmaku.room && (
          <button type="button" className="btn-quiet" onClick={() => { disconnectRoom(); setEditing(false) }}>断开</button>
        )}
      </form>
      {bare && (
        <Segmented label="弹幕房间所属平台" value={platform} onChange={next => { setPlatform(next); setError(null) }}
          options={[
            { value: 'douyu', label: PLATFORM_LABEL.douyu },
            { value: 'bilibili', label: PLATFORM_LABEL.bilibili },
            { value: 'huya', label: PLATFORM_LABEL.huya },
            { value: 'douyin', label: PLATFORM_LABEL.douyin },
          ]} />
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  )
}

/** Keep this side's link, or let it go; offered once the link is one that can be loaded again. */
function SaveButton({ role }: { role: SourceRole }): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const rooms = useSavedRooms()
  const [busy, setBusy] = useState(false)
  const descriptor = snapshot.media[role].descriptor
  if (!canSave(descriptor) || snapshot.media[role].status === 'empty') return null
  const saved = savedFor(rooms, role, descriptor)
  return (
    <button type="button" className="btn-quiet small" aria-pressed={saved !== null} disabled={busy || rooms === null}
      onClick={() => {
        setBusy(true)
        void (saved ? removeSavedRoom(saved.id) : saveRoom(role, descriptor)).then(problem => {
          if (problem) session.notice('warn', problem)
        }).catch(() => session.notice('warn', '收藏操作失败，请稍后重试')).finally(() => setBusy(false))
      }}>
      <Icon name="star" />{saved ? '已收藏' : '收藏'}
    </button>
  )
}

/** This side's saved rooms, one click to load; the one already playing is marked. */
function SavedList({ role, onPick }: { role: SourceRole; onPick: (room: SavedRoom) => void }): React.ReactNode {
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const saved = useSavedRoomsState()
  if (saved.error) return <ReadError error={saved.error} onRetry={saved.retry} />
  if (saved.rooms === null) return <p className="muted" role="status">正在读取收藏</p>
  const rooms = saved.rooms.filter((room) => room.role === role)
  if (rooms.length === 0) return null
  const current = snapshot.media[role].status === 'ready' ? snapshot.media[role].descriptor : null
  return (
    <div className="saved" role="group" aria-label="收藏的直播间">
      <span className="muted">收藏</span>
      <ul className="saved-list">
        {rooms.map((room) => {
          const playing = current?.platform === room.platform && current?.input === room.input
          return (
            <li key={room.id}>
              <button type="button" className="saved-room" disabled={playing || loader.state[role].busy}
                aria-current={playing || undefined} onClick={() => onPick(room)}>
                <RoomSummary room={room} />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
