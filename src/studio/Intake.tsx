/**
 * The first screen: one field. A link names its own side (see `routeFor`), so the viewer
 * pastes the match and the commentator in either order and never picks a slot. Only a link
 * that cannot say — a bare stream URL, a dropped file — asks.
 *
 * It steps aside by itself once both sides play, and can always be skipped: settings, the
 * Douyu desk and a single source are all reachable from the player without both links.
 */

import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { parseSourceInput } from '../core/mediaSources'
import { SOURCE_ROLES, type SourceRole } from '../core/types'
import { findLiveOfficial } from './officialLive'
import { Icon } from './kit'
import { FIXTURES, PLATFORM_LABEL, ROLE_LABEL, parseRoomInput, routeFor, sourceTitle, useSourceLoader, type RoomPlatform } from './sources'

type Pending = { kind: 'text'; value: string } | { kind: 'file'; file: File } | { kind: 'room'; value: string; room: string }

export function Intake({ onClose, pendingFile }: { onClose: () => void; pendingFile: File | null }): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const [text, setText] = useState('')
  const [ask, setAsk] = useState<Pending | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fixtures, setFixtures] = useState(false)
  const [finding, setFinding] = useState<string | null>(null)
  const findRun = useRef(0)
  const field = useRef<HTMLInputElement | null>(null)
  const media = snapshot.media
  const bothReady = media.official.status === 'ready' && media.commentary.status === 'ready'
  const anyLoaded = SOURCE_ROLES.some((role) => media[role].status !== 'empty')

  useEffect(() => { field.current?.focus() }, [])
  // Escape leaves from anywhere: after a choice button disappears, focus is no longer inside.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    let live = true
    void apiClient.getToolsStatus().then((result) => { if (live && result.ok) setFixtures(result.value.fixturesAvailable) })
    return () => { live = false }
  }, [])
  // Both playing is the whole point of this screen; leave without making them click.
  useEffect(() => {
    if (!bothReady) return
    const timer = setTimeout(() => { void session.setPlaying(true); onClose() }, 700)
    return () => clearTimeout(timer)
  }, [bothReady, onClose, session])

  const freeSlot = (): SourceRole | null =>
    SOURCE_ROLES.find((role) => media[role].status === 'empty' && !loader.state[role].busy) ?? null

  const place = (pending: Pending, role: SourceRole, platform?: RoomPlatform): void => {
    setAsk(null)
    setError(null)
    // Back to the field, ready for the other side's link.
    field.current?.focus()
    if (pending.kind === 'file') void loader.loadFile(role, pending.file)
    else void loader.loadInput(role, pending.value, platform)
  }

  const route = (pending: Pending): void => {
    setError(null)
    if (pending.kind === 'text') {
      // A bare number could be either platform's room; the viewer knows which.
      const typed = parseRoomInput(pending.value)
      if (typed?.platform === null) { setAsk({ kind: 'room', value: pending.value, room: typed.room }); return }
      if (typed) { place(pending, 'commentary', typed.platform ?? undefined); return }
      const parsed = parseSourceInput(pending.value)
      if (!parsed.ok) { setError(parsed.message); return }
      const role = routeFor(parsed.platform)
      if (role) { place(pending, role); return }
    }
    // No hint in the link itself: fill the only empty side, otherwise ask.
    const empty = SOURCE_ROLES.filter((role) => media[role].status === 'empty' && !loader.state[role].busy)
    if (empty.length === 1) place(pending, empty[0]!)
    else setAsk(pending)
  }

  // A file dropped on the window while this screen is up is routed like a paste.
  useEffect(() => { if (pendingFile) route({ kind: 'file', file: pendingFile }) }, [pendingFile])

  return (
    <div className="intake" role="dialog" aria-modal="true" aria-label="添加直播间">
      <div className="intake-body">
        <h1 className="intake-title">添加直播间</h1>
        <form className="intake-field" onSubmit={(event) => {
          event.preventDefault()
          const value = text.trim()
          if (!value) return
          route({ kind: 'text', value })
          setText('')
        }}>
          <input ref={field} value={text} onChange={(event) => { setText(event.target.value); setError(null) }}
            aria-label="直播间链接" placeholder="粘贴直播间链接或输入房间号，按回车添加" spellCheck={false} autoComplete="off" />
        </form>
        {error && <p className="intake-error" role="alert">{error}</p>}

        {ask?.kind === 'room' ? (
          <div className="intake-ask" role="group" aria-label="选择房间号所属平台">
            <span>房间号 {ask.room}</span>
            <span className="intake-ask-q">属于</span>
            {/* Focused, so a second Enter takes the common case. */}
            <button type="button" className="btn-solid small" autoFocus onClick={() => place(ask, 'commentary', 'douyu')}>{PLATFORM_LABEL.douyu}</button>
            <button type="button" className="btn-solid small" onClick={() => place(ask, 'commentary', 'bilibili')}>{PLATFORM_LABEL.bilibili}</button>
          </div>
        ) : ask && (
          <div className="intake-ask" role="group" aria-label="选择添加位置">
            <span>{ask.kind === 'file' ? ask.file.name : ask.value}</span>
            <span className="intake-ask-q">添加到</span>
            <button type="button" className="btn-solid small" onClick={() => place(ask, 'official')}>画面</button>
            <button type="button" className="btn-solid small" onClick={() => place(ask, 'commentary')}>解说</button>
          </div>
        )}

        {media.official.status === 'empty' && !loader.state.official.busy && (
          <button type="button" className="intake-find" disabled={finding !== null} onClick={() => {
            const run = ++findRun.current
            setError(null)
            setFinding('正在查找')
            void findLiveOfficial(
              (url) => loader.loadInput('official', url),
              (channel) => { if (findRun.current === run) setFinding(`正在查找 ${channel.name}`) },
              undefined,
              () => findRun.current !== run,
            ).then((found) => {
              if (findRun.current !== run) return
              setFinding(null)
              if (!found) setError('目前没有正在直播的 CS2 赛事官方频道')
            })
          }}>
            <Icon name="trophy" />
            <span>{finding ?? '正在进行的 CS2 赛事'}</span>
            <small>自动查找 YouTube 官方直播间并载入为画面</small>
          </button>
        )}

        <ul className="intake-slots">
          {SOURCE_ROLES.map((role) => <Slot key={role} role={role} />)}
        </ul>

        <p className="intake-foot">
          <span>支持将视频文件拖入窗口</span>
          {fixtures && freeSlot() && (
            <button type="button" className="link-btn" onClick={() => {
              for (const role of SOURCE_ROLES) if (media[role].status === 'empty') void loader.loadDescriptor(role, FIXTURES[role])
            }}>载入测试片源</button>
          )}
          {!bothReady && (
            <button type="button" className="link-btn intake-skip" onClick={onClose}>{anyLoaded ? '开始观看' : '跳过'}</button>
          )}
        </p>
      </div>
    </div>
  )
}

function Slot({ role }: { role: SourceRole }): React.ReactNode {
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const state = snapshot.media[role]
  const load = loader.state[role]
  const status = load.busy ? 'loading' : state.status
  const descriptor = state.descriptor
  return (
    <li className="slot" data-role={role} data-status={status}>
      <span className="slot-role">{ROLE_LABEL[role]}</span>
      <span className="slot-what">
        {status === 'loading' ? '载入中…'
          : descriptor ? sourceTitle(descriptor)
            : role === 'official' ? 'YouTube、Twitch' : '斗鱼、哔哩哔哩'}
      </span>
      {(load.problem || (state.status === 'error' && state.error)) && (
        <span className="slot-error" role="alert">{load.problem?.message ?? state.error?.message}</span>
      )}
    </li>
  )
}
