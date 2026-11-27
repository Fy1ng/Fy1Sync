import { ErrorText, useErrorState } from '../../ui/ErrorDetails'
import { displayError } from '../../core/errorDetails'
/**
 * Other live rooms on the same screen (handoff items 01, 05, 06, 09).
 *
 * The backend owns the sessions; this follows its `streams` snapshot, gives each extra stream
 * a pane or floating window, and keeps the viewer's layout. The two
 * synchronized roles are not here: these streams have no offset and no alignment, only their
 * own playback.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { apiClient } from '../../app/apiClient'
import { useOptionalSession } from '../../app/SessionContext'
import { loadSettings, youtubeResolveQuality, type AppSettings } from '../../app/settings'
import { EMPTY_DIRECT_DRAFT, hasDirectOptions, parseDirectDraft, type DirectStreamDraft, type DirectStreamOptions } from '../../core/directStream'
import { parseSourceInput } from '../../core/mediaSources'
import type { PipState } from '../../../electron/pipManager'
import type { OpenStreamInput, StreamSessionView, StreamSessionsSnapshot } from '../../../electron/streamSessions'
import { DirectStreamFields } from '../DirectStreamFields'
import { Popover, Segmented } from '../kit'
import { PLATFORM_LABEL, parseRoomInput, type RoomPlatform } from '../sources'
import { arrangeStreams, clampRect, defaultRect, pruneLayout, readLayout, readLayoutPreference, selectLayoutMode,
  writeLayout, writeLayoutPreference, type Bounds, type Layout, type Rect, type StreamLayoutMode } from './layout'
import { MediaRegistry } from './mediaRegistry'
import { StreamWindow } from './StreamWindow'
import './streams.css'

const EXTRA_ID = /^stream-[a-f0-9]{32}$/

const isSnapshot = (value: unknown): value is StreamSessionsSnapshot =>
  !!value && typeof value === 'object' && Array.isArray((value as StreamSessionsSnapshot).sessions)
const isPipState = (value: unknown): value is PipState =>
  !!value && typeof value === 'object' && typeof (value as PipState).phase === 'string'

/** The 同屏观看 panel's id, which the top bar's + button names as its popover target. */
export const ADD_STREAM_POPOVER = 'add-stream'

export function ExtraStreams({ adding, onAddingChange, primaryRef, children }: {
  /** The "同屏观看" form is open. */
  adding: boolean
  onAddingChange: (adding: boolean) => void
  primaryRef?: React.Ref<HTMLDivElement>
  children?: (split: boolean) => React.ReactNode
}): React.ReactNode {
  const [registry] = useState(() => new MediaRegistry())
  const [snapshot, setSnapshot] = useState<StreamSessionsSnapshot | null>(null)
  const [pip, setPip] = useState<PipState | null>(null)
  const [streamError, setStreamError, streamDetail] = useErrorState()
  const [pipError, setPipError, pipDetail] = useErrorState()
  const [layout, setLayout] = useState<Layout>(readLayout)
  const [preference, setPreference] = useState(readLayoutPreference)
  const [order, setOrder] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [bounds, setBounds] = useState<Bounds>({ w: 0, h: 0 })
  const stage = useRef<HTMLDivElement | null>(null)
  const splitDrag = useRef<{ pointerId: number; offset: number } | null>(null)
  const savedLayout = useRef(layout)
  const previousIds = useRef<ReadonlySet<string>>(new Set())
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
      if (event.topic === 'streams' && isSnapshot(event.data)) { pushedStreams = true; setSnapshot(event.data); setStreamError(null) }
      else if (event.topic === 'pip' && isPipState(event.data)) { pushedPip = true; setPip(event.data); setPipError(null) }
    })
    void apiClient.feature('getStreamSessions', undefined).then((result) => {
      if (!live || pushedStreams) return
      if (!result.ok) setStreamError(result)
      else if (isSnapshot(result.value)) setSnapshot(result.value)
      else setStreamError(displayError({ code: 'invalid-stream-snapshot' }, '无法读取同屏播放状态'))
    }).catch(caught => { if (live && !pushedStreams) setStreamError(caught) })
    void apiClient.feature('getEnhancedPip', undefined).then((result) => {
      if (!live || pushedPip) return
      if (!result.ok) setPipError(result)
      else if (isPipState(result.value)) setPip(result.value)
      else setPipError(displayError({ code: 'invalid-pip-state' }, '无法读取画中画状态'))
    }).catch(caught => { if (live && !pushedPip) setPipError(caught) })
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
  const arrangement = arrangeStreams(preference, sessions.length, bounds)
  const split = arrangement.kind === 'split' ? arrangement : null
  const floating = arrangement.kind === 'floating'

  // A stream that is gone takes its video, its saved window and its place in the stack with it.
  useEffect(() => {
    if (!snapshot) return
    const live = new Set(idsKey ? idsKey.split(',') : [])
    const previous = previousIds.current
    previousIds.current = live
    registry.retain(live)
    setLayout((value) => pruneLayout(value, new Set(Object.keys(value).filter(id => !previous.has(id) || live.has(id)))))
    setOrder((value) => value.every((id) => live.has(id)) ? value : value.filter((id) => live.has(id)))
    setSelected((value) => value && !live.has(value) ? null : value)
  }, [idsKey, registry, snapshot])

  // A new window gets a place once the theater has a size, and keeps it.
  useEffect(() => {
    if (!floating || bounds.w <= 0 || bounds.h <= 0 || !idsKey) return
    const ids = idsKey.split(',')
    setLayout((value) => {
      const missing = ids.filter((id) => !value[id])
      if (missing.length === 0) return value
      const next = { ...value }
      for (const id of missing) next[id] = defaultRect(ids.indexOf(id), bounds)
      return next
    })
  }, [bounds, floating, idsKey])

  useEffect(() => {
    if (savedLayout.current === layout) return
    writeLayout(layout)
    savedLayout.current = layout
  }, [layout])

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

  const full = snapshot !== null && snapshot.maxExtraStreams > 0 && sessions.length >= snapshot.maxExtraStreams
  const changeMode = (mode: StreamLayoutMode): void => {
    const next = selectLayoutMode(preference, mode)
    setPreference(next)
    writeLayoutPreference(next)
  }
  const setRatio = (ratio: number): void => {
    if (!split || split.min === split.max) return
    const next = { ...preference, ratio: Math.min(split.max, Math.max(split.min, ratio)) }
    setPreference(next)
    writeLayoutPreference(next)
  }
  const positionOnAxis = (event: PointerEvent): number => {
    const box = stage.current!.getBoundingClientRect()
    return split?.direction === 'side-by-side' ? event.clientX - box.left : event.clientY - box.top
  }

  return (
    <div className="streams-stage" ref={stage} data-split={split?.direction}
      style={split ? {
        '--xs-primary': `${split.ratio}fr`, '--xs-secondary': `${1 - split.ratio}fr`,
        '--xs-divider': `${split.divider}px`, '--xs-stream-share': `${split.streamShare * 100}%`,
      } as CSSProperties : undefined}>
      <div className="streams-primary" ref={primaryRef}>
        {children?.(split !== null)}
        {(streamError || pipError) && <div className="extra-streams">
          {streamError && <p className="xs-state-error" role="alert"><ErrorText error={streamDetail ?? streamError} message={streamError} /></p>}
          {pipError && <p className="xs-state-error" role="alert"><ErrorText error={pipDetail ?? pipError} message={pipError} /></p>}
        </div>}
      </div>
      {split && (split.divider > 0 ? (
        <div className="xs-divider" role="separator" aria-label="分屏分隔线"
          aria-orientation={split.direction === 'side-by-side' ? 'vertical' : 'horizontal'}
          aria-valuemin={Math.round(split.min * 100)} aria-valuemax={Math.round(split.max * 100)} aria-valuenow={Math.round(split.ratio * 100)}
          aria-disabled={split.min === split.max || undefined} tabIndex={split.min < split.max ? 0 : undefined}
          onPointerDown={(event) => {
            if (event.button !== 0 || split.min === split.max) return
            const space = (split.direction === 'side-by-side' ? bounds.w : bounds.h) - split.divider
            splitDrag.current = { pointerId: event.pointerId, offset: positionOnAxis(event) - split.ratio * space }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const drag = splitDrag.current
            if (!drag || drag.pointerId !== event.pointerId) return
            const space = (split.direction === 'side-by-side' ? bounds.w : bounds.h) - split.divider
            if (space > 0) setRatio((positionOnAxis(event) - drag.offset) / space)
          }}
          onLostPointerCapture={() => { splitDrag.current = null }}
          onKeyDown={(event) => {
            const [back, forward] = split.direction === 'side-by-side' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
            const ratio = event.key === back ? split.ratio - 0.02 : event.key === forward ? split.ratio + 0.02
              : event.key === 'Home' ? split.min : event.key === 'End' ? split.max : null
            if (ratio === null) return
            event.preventDefault()
            setRatio(ratio)
          }} />
      ) : <div aria-hidden="true" />)}
      <div className={split ? 'xs-split-streams' : 'extra-streams'}>
        {sessions.map((view, index) => {
          const stacked = order.indexOf(view.id)
          return (
            <StreamWindow
              key={view.id}
              view={view}
              placement={floating ? { rect: clampRect(layout[view.id] ?? defaultRect(index, bounds), bounds), bounds, z: stacked < 0 ? 1 : stacked + 2 } : null}
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
      </div>
      <Popover id={ADD_STREAM_POPOVER} open={adding} onOpen={() => onAddingChange(true)} onClose={() => onAddingChange(false)} className="xs-add" label="同屏观看">
        <AddStreamForm
          mode={preference.mode}
          onModeChange={changeMode}
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
export function openInputFor(
  text: string,
  roomPlatform: RoomPlatform,
  direct?: DirectStreamOptions,
  youtubeSettings?: Pick<AppSettings, 'youtubeDefaultQuality' | 'preferAdaptive'>,
): OpenStreamInput {
  const typed = parseRoomInput(text)
  if (typed) return { input: typed.room, platform: typed.platform ?? roomPlatform }
  const trimmed = text.trim()
  const parsed = parseSourceInput(trimmed)
  if (parsed.ok && parsed.platform === 'direct') {
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : parsed.url
    return {
      input: normalized,
      ...(normalized !== trimmed || hasDirectOptions(direct) ? { platform: 'direct' } : {}),
      ...(hasDirectOptions(direct) ? { direct } : {}),
    }
  }
  if (parsed.ok && parsed.platform === 'youtube' && youtubeSettings) {
    const resolved = youtubeResolveQuality(youtubeSettings)
    return {
      input: trimmed,
      ...(resolved.quality ? { quality: resolved.quality } : {}),
      ...(resolved.preferAdaptive ? { preferAdaptive: true } : {}),
    }
  }
  return { input: trimmed }
}

function AddStreamForm({ full, mode, onModeChange, onOpened }: {
  full: boolean
  mode: StreamLayoutMode
  onModeChange: (mode: StreamLayoutMode) => void
  onOpened: (view: StreamSessionView) => void
}): React.ReactNode {
  const session = useOptionalSession()
  const [text, setText] = useState('')
  const [roomPlatform, setRoomPlatform] = useState<RoomPlatform>('douyu')
  const [directDraft, setDirectDraft] = useState<DirectStreamDraft>({ ...EMPTY_DIRECT_DRAFT })
  const [directOpen, setDirectOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem, problemDetail] = useErrorState()
  const bareRoom = parseRoomInput(text)?.platform === null

  return (
    <form className="xs-add-form" onSubmit={(event) => {
      event.preventDefault()
      if (busy || full || !text.trim()) return
      const parsedDirect = parseDirectDraft(directDraft)
      if (!parsedDirect.ok) {
        setProblem(parsedDirect.message)
        setDirectOpen(true)
        return
      }
      setBusy(true)
      setProblem(null)
      void apiClient.feature('openStreamSession', openInputFor(text, roomPlatform, parsedDirect.options, session?.settings ?? loadSettings())).then((result) => {
        setBusy(false)
        if (result.ok) onOpened(result.value)
        else setProblem(result)
      }).catch(caught => { setBusy(false); setProblem(displayError(caught, '同屏直播间打开失败')) })
    }}>
      <p className="xs-add-title">同屏观看</p>
      <Segmented label="同屏布局" value={mode} onChange={onModeChange}
        options={[{ value: 'side-by-side', label: '左右分屏' }, { value: 'stacked', label: '上下分屏' },
          { value: 'custom', label: '自定义' }, { value: 'floating', label: '悬浮窗' }]} />
      <div className="link-row">
        <input value={text} autoFocus spellCheck={false} onChange={(event) => { setText(event.target.value); setProblem(null) }}
          aria-label="直播间房间号或链接" placeholder="直播间链接、房间号或 m3u8 / flv 直链" />
        <button type="submit" className="btn-solid" disabled={busy || full || text.trim() === ''}>
          {busy ? '打开中' : '打开'}
        </button>
      </div>
      {!bareRoom && (
        <DirectStreamFields
          input={text}
          draft={directDraft}
          open={directOpen}
          disabled={busy || full}
          onToggle={() => setDirectOpen(open => !open)}
          onChange={next => { setDirectDraft(next); setProblem(null) }}
        />
      )}
      {bareRoom && (
        <Segmented label="房间号所属平台" value={roomPlatform} onChange={setRoomPlatform}
          options={[{ value: 'douyu', label: PLATFORM_LABEL.douyu }, { value: 'bilibili', label: PLATFORM_LABEL.bilibili }, { value: 'huya', label: PLATFORM_LABEL.huya }, { value: 'douyin', label: PLATFORM_LABEL.douyin }]} />
      )}
      {full && <p className="muted">同屏已满，关闭一路后可继续添加</p>}
      {problem && <p className="form-error" role="alert"><ErrorText error={problemDetail ?? problem} message={problem} /></p>}
    </form>
  )
}
