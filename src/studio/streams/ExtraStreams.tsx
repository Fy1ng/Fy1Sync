/**
 * Other live rooms on the same screen (handoff items 01, 05, 06, 09).
 *
 * The backend owns the sessions; this follows its `streams` snapshot, gives each extra stream
 * a floating window over the theater, and keeps where the viewer put each window. The two
 * synchronized roles are not here: these streams have no offset and no alignment, only their
 * own playback.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { PipState } from '../../../electron/pipManager'
import type { OpenStreamInput, StreamSessionView, StreamSessionsSnapshot } from '../../../electron/streamSessions'
import { Popover, Segmented } from '../kit'
import { PLATFORM_LABEL, parseRoomInput, type RoomPlatform } from '../sources'
import { clampRect, defaultRect, pruneLayout, readLayout, writeLayout, type Bounds, type Layout, type Rect } from './layout'
import { MediaRegistry } from './mediaRegistry'
import { StreamWindow } from './StreamWindow'
import './streams.css'

const EXTRA_ID = /^stream-[a-f0-9]{32}$/

const isSnapshot = (value: unknown): value is StreamSessionsSnapshot =>
  !!value && typeof value === 'object' && Array.isArray((value as StreamSessionsSnapshot).sessions)
const isPipState = (value: unknown): value is PipState =>
  !!value && typeof value === 'object' && typeof (value as PipState).phase === 'string'

export function ExtraStreams({ adding, onAddingChange }: {
  /** The "同屏观看" form is open. */
  adding: boolean
  onAddingChange: (adding: boolean) => void
}): React.ReactNode {
  const [registry] = useState(() => new MediaRegistry())
  const [snapshot, setSnapshot] = useState<StreamSessionsSnapshot | null>(null)
  const [pip, setPip] = useState<PipState | null>(null)
  const [layout, setLayout] = useState<Layout>(readLayout)
  const [order, setOrder] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [bounds, setBounds] = useState<Bounds>({ w: 0, h: 0 })
  const stage = useRef<HTMLDivElement | null>(null)
  // Windows closed here; a late response must not bring one back.
  const closed = useRef(new Set<string>())

  useEffect(() => {
    registry.hold()
    return () => registry.release()
  }, [registry])

  // Subscribe first, then read: a push that lands before the read answers is newer than it.
  useEffect(() => {
    let live = true
    let pushedStreams = false
    let pushedPip = false
    const off = apiClient.subscribeFeatures((event) => {
      if (!live) return
      if (event.topic === 'streams' && isSnapshot(event.data)) { pushedStreams = true; setSnapshot(event.data) }
      else if (event.topic === 'pip' && isPipState(event.data)) { pushedPip = true; setPip(event.data) }
    })
    void apiClient.feature('getStreamSessions', undefined).then((result) => {
      if (live && !pushedStreams && result.ok && isSnapshot(result.value)) setSnapshot(result.value)
    })
    void apiClient.feature('getEnhancedPip', undefined).then((result) => {
      if (live && !pushedPip && result.ok && isPipState(result.value)) setPip(result.value)
    })
    return () => { live = false; off() }
  }, [])

  useLayoutEffect(() => {
    const node = stage.current
    if (!node) return
    const measure = (): void => setBounds((value) =>
      value.w === node.clientWidth && value.h === node.clientHeight ? value : { w: node.clientWidth, h: node.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const sessions = (snapshot?.sessions ?? []).filter((view) => EXTRA_ID.test(view.id) && !closed.current.has(view.id))
  const idsKey = sessions.map((view) => view.id).join(',')

  // A stream that is gone takes its video, its saved window and its place in the stack with it.
  useEffect(() => {
    if (!snapshot) return
    const live = new Set(idsKey ? idsKey.split(',') : [])
    registry.retain(live)
    setLayout((value) => pruneLayout(value, live))
    setOrder((value) => value.every((id) => live.has(id)) ? value : value.filter((id) => live.has(id)))
    setSelected((value) => value && !live.has(value) ? null : value)
  }, [idsKey, registry, snapshot])

  // A new window gets a place once the theater has a size, and keeps it.
  useEffect(() => {
    if (bounds.w <= 0 || bounds.h <= 0 || !idsKey) return
    const ids = idsKey.split(',')
    setLayout((value) => {
      const missing = ids.filter((id) => !value[id])
      if (missing.length === 0) return value
      const next = { ...value }
      for (const id of missing) next[id] = defaultRect(ids.indexOf(id), bounds)
      return next
    })
  }, [bounds, idsKey])

  const known = snapshot !== null
  useEffect(() => { if (known) writeLayout(layout) }, [known, layout])

  const select = useCallback((id: string) => {
    setSelected(id)
    setOrder((value) => value.at(-1) === id ? value : [...value.filter((item) => item !== id), id])
  }, [])

  const commitRect = useCallback((id: string, rect: Rect) => setLayout((value) => ({ ...value, [id]: rect })), [])

  /** Results of open/switch/restart update only a session that is still listed. */
  const applyView = useCallback((view: StreamSessionView, insert = false) => {
    if (closed.current.has(view.id)) return
    setSnapshot((value) => {
      if (!value) return insert ? { maxExtraStreams: Number.MAX_SAFE_INTEGER, sessions: [view] } : value
      const present = value.sessions.some((item) => item.id === view.id)
      if (!present && !insert) return value
      return { ...value, sessions: present ? value.sessions.map((item) => item.id === view.id ? view : item) : [...value.sessions, view] }
    })
  }, [])

  const removeLocal = useCallback((id: string) => {
    closed.current.add(id)
    registry.dispose(id)
    setSnapshot((value) => value && { ...value, sessions: value.sessions.filter((item) => item.id !== id) })
  }, [registry])

  const full = snapshot !== null && sessions.length >= snapshot.maxExtraStreams

  return (
    <div className="extra-streams" ref={stage}>
      {sessions.map((view, index) => {
        const rect = clampRect(layout[view.id] ?? defaultRect(index, bounds), bounds)
        const stacked = order.indexOf(view.id)
        return (
          <StreamWindow
            key={view.id}
            view={view}
            rect={rect}
            bounds={bounds}
            z={stacked < 0 ? 1 : stacked + 2}
            selected={selected === view.id}
            pip={pip}
            registry={registry}
            onSelect={select}
            onRect={commitRect}
            onView={applyView}
            onClosed={removeLocal}
            onPip={setPip}
          />
        )
      })}
      <Popover open={adding} onClose={() => onAddingChange(false)} className="xs-add" label="同屏观看">
        <AddStreamForm
          full={full}
          onOpened={(view) => {
            applyView(view, true)
            select(view.id)
            onAddingChange(false)
          }}
        />
      </Popover>
    </div>
  )
}

/** What to send for what was typed: a bare room needs its platform, a link speaks for itself. */
export function openInputFor(text: string, roomPlatform: RoomPlatform): OpenStreamInput {
  const typed = parseRoomInput(text)
  if (typed) return { input: typed.room, platform: typed.platform ?? roomPlatform }
  return { input: text.trim() }
}

function AddStreamForm({ full, onOpened }: {
  full: boolean
  onOpened: (view: StreamSessionView) => void
}): React.ReactNode {
  const [text, setText] = useState('')
  const [roomPlatform, setRoomPlatform] = useState<RoomPlatform>('douyu')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const bareRoom = parseRoomInput(text)?.platform === null

  return (
    <form className="xs-add-form" onSubmit={(event) => {
      event.preventDefault()
      if (busy || full || !text.trim()) return
      setBusy(true)
      setProblem(null)
      void apiClient.feature('openStreamSession', openInputFor(text, roomPlatform)).then((result) => {
        setBusy(false)
        if (result.ok) onOpened(result.value)
        else setProblem(result.message)
      })
    }}>
      <p className="xs-add-title">同屏观看</p>
      <div className="link-row">
        <input value={text} autoFocus spellCheck={false} onChange={(event) => setText(event.target.value)}
          aria-label="直播间房间号或链接" placeholder="房间号，或斗鱼、哔哩哔哩、YouTube、Twitch 链接" />
        <button type="submit" className="btn-solid" disabled={busy || full || text.trim() === ''}>
          {busy ? '打开中' : '打开'}
        </button>
      </div>
      {bareRoom && (
        <Segmented label="房间号所属平台" value={roomPlatform} onChange={setRoomPlatform}
          options={[{ value: 'douyu', label: PLATFORM_LABEL.douyu }, { value: 'bilibili', label: PLATFORM_LABEL.bilibili }]} />
      )}
      {full && <p className="muted">已达到同屏数量上限</p>}
      {problem && <p className="form-error" role="alert">{problem}</p>}
    </form>
  )
}
