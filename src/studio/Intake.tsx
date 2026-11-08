/**
 * The first screen: one field, and under it the two sides. The viewer picks 画面 or 解说
 * first, then types into the field for that side; nothing is sorted by guessing from the
 * link. A bare room number asks for its platform as soon as it is typed, without waiting
 * for Enter.
 *
 * It steps aside by itself once both sides play, and can always be skipped: settings, the
 * Douyu desk and a single source are all reachable from the player without both links.
 */

import { useEffect, useRef, useState } from 'react'
import { useSessionSnapshot, useSession } from '../app/SessionContext'
import { SOURCE_ROLES, type SourceRole } from '../core/types'
import { Icon } from './kit'
import { LOGIN_LABEL, LoginOffer, PLATFORM_LABEL, ROLE_LABEL, SOURCE_HINT, SOURCE_KINDS, parseRoomInput, sourceTitle, spaced, useSourceLoader, type RoomPlatform } from './sources'
import { useSavedRooms, type SavedRoom } from './savedRooms'

const ROOM_PLATFORMS: RoomPlatform[] = ['douyu', 'bilibili', 'huya']

export function Intake({ onClose, pendingFile, onSchedule }: {
  onClose: () => void
  pendingFile: File | null
  /** Open 赛程, to pick the official broadcast by match. */
  onSchedule: () => void
}): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const media = snapshot.media
  // The side being filled. None until the viewer picks; the field waits for that.
  const [role, setRole] = useState<SourceRole | null>(null)
  const [text, setText] = useState('')
  const [roomPlatform, setRoomPlatform] = useState<RoomPlatform | null>(null)
  const handledFile = useRef<File | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  const bothReady = media.official.status === 'ready' && media.commentary.status === 'ready'
  const anyLoaded = SOURCE_ROLES.some((side) => media[side].status !== 'empty')
  const bare = parseRoomInput(text)?.platform === null ? parseRoomInput(text)!.room : null
  const canSubmit = role !== null && text.trim() !== '' && (bare === null || roomPlatform !== null) && !loader.state[role].busy

  useEffect(() => { if (role) field.current?.focus() }, [role])
  // Escape leaves from anywhere: after a choice button disappears, focus is no longer inside.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // Both playing is the whole point of this screen; leave without making them click.
  useEffect(() => {
    if (!bothReady) return
    const timer = setTimeout(() => { void session.setPlaying(true); onClose() }, 700)
    return () => clearTimeout(timer)
  }, [bothReady, onClose, session])

  const pick = (next: SourceRole): void => {
    setRole(next)
    loader.clearProblem(next)
  }
  const submit = (): void => {
    if (!canSubmit || !role) return
    const side = role
    void loader.loadInput(side, text.trim(), bare !== null ? roomPlatform! : undefined).then((ok) => {
      if (!ok) return
      // Ready for the other side, if it is still empty.
      const other = SOURCE_ROLES.find((next) => next !== side && media[next].status === 'empty')
      if (other) setRole(other)
    })
    setText('')
    setRoomPlatform(null)
  }

  // A file dropped on the window goes to the side being filled, or the only empty one.
  useEffect(() => {
    if (!pendingFile || handledFile.current === pendingFile) return
    const empty = SOURCE_ROLES.filter((side) => media[side].status === 'empty')
    const side = role ?? (empty.length === 1 ? empty[0]! : null)
    if (side) { handledFile.current = pendingFile; void loader.loadFile(side, pendingFile) }
  }, [pendingFile, role])

  const load = role ? loader.state[role] : null

  return (
    <div className="intake" role="dialog" aria-modal="true" aria-label="添加直播间">
      <div className="intake-body">
        <h1 className="intake-title">添加直播间</h1>
        <div className="intake-slots" role="radiogroup" aria-label="添加到">
          {SOURCE_ROLES.map((side) => <Slot key={side} role={side} selected={side === role} onPick={() => pick(side)} />)}
        </div>

        <form className="intake-field" data-disabled={role === null} onSubmit={(event) => { event.preventDefault(); submit() }}>
          <input ref={field} value={text} disabled={role === null}
            onChange={(event) => { setText(event.target.value); if (role) loader.clearProblem(role) }}
            aria-label="直播间链接" spellCheck={false} autoComplete="off"
            placeholder={role === null ? '先选择画面或解说' : SOURCE_HINT} />
          <button type="submit" className="intake-go" disabled={!canSubmit} aria-label="添加" title="添加（回车）">
            <Icon name="enter" />
          </button>
        </form>

        {bare !== null && role !== null && (
          <div className="intake-ask" role="radiogroup" aria-label="选择房间号所属平台">
            <span className="intake-ask-q">房间 {bare} 属于</span>
            {ROOM_PLATFORMS.map((platform) => (
              <button key={platform} type="button" role="radio" aria-checked={roomPlatform === platform}
                className={roomPlatform === platform ? 'btn-solid small' : 'btn-glass small'}
                onClick={() => { setRoomPlatform(platform); field.current?.focus() }}>{PLATFORM_LABEL[platform]}</button>
            ))}
          </div>
        )}

        {load?.problem && <p className="intake-error" role="alert">{load.problem.message}{load.problem.hint ? ` ${load.problem.hint}` : ''}</p>}

        {media.official.status === 'empty' && !loader.state.official.busy && (
          <button type="button" className="intake-find" onClick={onSchedule}>
            <Icon name="trophy" />
            <span>CS2 赛程</span>
            <small>按对阵选择官方直播，载入为画面</small>
          </button>
        )}

        <SavedRooms onPick={(room) => void loader.loadInput(room.role, room.input,
          room.platform === 'douyu' || room.platform === 'bilibili' || room.platform === 'huya' ? room.platform : undefined)} />

        <p className="intake-foot">
          <span>支持将视频文件或 M3U 频道列表拖入窗口</span>
          {!bothReady && (
            <button type="button" className="link-btn intake-skip" onClick={onClose}>{anyLoaded ? '开始观看' : '跳过'}</button>
          )}
        </p>
      </div>
    </div>
  )
}

function Slot({ role, selected, onPick }: { role: SourceRole; selected: boolean; onPick: () => void }): React.ReactNode {
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const state = snapshot.media[role]
  const load = loader.state[role]
  const status = load.busy ? 'loading' : state.status
  const descriptor = state.descriptor
  return (
    <div className="slot" data-role={role} data-status={status} data-selected={selected}>
      <button type="button" className="slot-pick" role="radio" aria-checked={selected} onClick={onPick}>
        <span className="slot-role">{ROLE_LABEL[role]}</span>
        <span className="slot-what">
          {load.loggingIn ? `在登录窗口中登录${load.login ? spaced(LOGIN_LABEL[load.login]) : ''}，完成后关闭窗口`
            : status === 'loading' ? '载入中…'
              : descriptor ? sourceTitle(descriptor)
                : SOURCE_KINDS}
        </span>
      </button>
      {/* The side being filled shows its problem under the field instead. */}
      {!selected && (load.problem || (state.status === 'error' && state.error)) && (
        <span className="slot-error" role="alert">{load.problem?.message ?? state.error?.message}</span>
      )}
      {selected && !load.problem && state.status === 'error' && state.error && <span className="slot-error" role="alert">{state.error.message}</span>}
      <LoginOffer role={role} />
    </div>
  )
}

/** Saved rooms, by side, for a side that is still empty: one click fills it. */
function SavedRooms({ onPick }: { onPick: (room: SavedRoom) => void }): React.ReactNode {
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const rooms = (useSavedRooms() ?? []).filter((room) => snapshot.media[room.role].status === 'empty' && !loader.state[room.role].busy)
  if (rooms.length === 0) return null
  return (
    <div className="intake-saved" role="group" aria-label="收藏的直播间">
      {SOURCE_ROLES.map((role) => {
        const mine = rooms.filter((room) => room.role === role)
        if (mine.length === 0) return null
        return (
          <div key={role} className="intake-saved-row">
            <span className="intake-saved-role">{ROLE_LABEL[role]}</span>
            {mine.map((room) => (
              <button key={room.id} type="button" className="btn-glass small" onClick={() => onPick(room)}>{room.label}</button>
            ))}
          </div>
        )
      })}
    </div>
  )
}
