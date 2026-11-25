/**
 * Backup pictures (备选画面) for the 画面 side.
 *
 * A commentator who switches between two matches shows a different official stream after the
 * switch. Each backup is an extra backend stream session marked `role: 'candidate'`; it never
 * gets a window, but keeps playing muted out of sight so its frames can be compared with the
 * commentary. The provider owns those videos, swaps a backup in as 画面 on request, and — in
 * 画面匹配 mode with `autoPickCandidate` on — periodically checks which picture the commentary
 * is actually showing.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import { useSession, useSessionSnapshot } from '../../app/SessionContext'
import { displayError, errorMessage } from '../../core/errorDetails'
import type { PlatformId } from '../../core/types'
import type { StreamSessionView, StreamSessionsSnapshot } from '../../../electron/streamSessions'
import { CandidateMatcher, CandidateStreak, CURRENT_PICTURE, bestCandidate, type MatcherPicture } from '../../sync/candidateMatcher'
import { parseRoomInput, useSourceLoader, type RoomPlatform } from '../sources'
import { descriptorFor, MediaRegistry } from './mediaRegistry'

export const MAX_CANDIDATES = 3
/** Background comparison cadence while automatic picking is on. */
const AUTO_PICK_INTERVAL_MS = 30_000
const EXTRA_ID = /^stream-[a-f0-9]{32}$/
const ROOM_PLATFORMS: readonly PlatformId[] = ['douyu', 'bilibili', 'huya', 'douyin']

export interface Candidate {
  id: string
  label: string
  phase: StreamSessionView['phase']
  error: string | null
}

export interface CandidateControls {
  candidates: Candidate[]
  full: boolean
  busy: boolean
  add(text: string, platform?: RoomPlatform): Promise<string | null>
  remove(id: string): Promise<void>
  promote(id: string): Promise<boolean>
}

const CandidateContext = createContext<CandidateControls | null>(null)

/** Null outside the player page (and in tests that render a panel on its own). */
export function useCandidates(): CandidateControls | null {
  return useContext(CandidateContext)
}

const isSnapshot = (value: unknown): value is StreamSessionsSnapshot =>
  !!value && typeof value === 'object' && Array.isArray((value as StreamSessionsSnapshot).sessions)

export const isCandidateView = (view: StreamSessionView): boolean => view.role === 'candidate'

/** What `loadInput` needs to load a backup as 画面: the text as typed and a bare room's platform. */
interface Origin { input: string; platform?: RoomPlatform }

function originFor(text: string, platform: RoomPlatform | undefined): { origin: Origin; open: { input: string; platform?: RoomPlatform } } {
  const trimmed = text.trim()
  const typed = parseRoomInput(trimmed)
  const bare = typed?.platform === null
  const origin: Origin = { input: trimmed, ...(bare && platform ? { platform } : {}) }
  if (typed) return { origin, open: { input: typed.room, platform: typed.platform ?? platform ?? 'douyu' } }
  return { origin, open: { input: trimmed } }
}

export function CandidateProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const [registry] = useState(() => new MediaRegistry())
  const [streams, setStreams] = useState<StreamSessionsSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const parked = useRef<HTMLDivElement | null>(null)
  const origins = useRef(new Map<string, Origin>())
  const closed = useRef(new Set<string>())
  const working = useRef(false)

  useEffect(() => {
    registry.hold()
    return () => registry.release()
  }, [registry])

  useEffect(() => {
    let live = true
    let pushed = false
    const off = apiClient.subscribeFeatures((event) => {
      if (live && event.topic === 'streams' && isSnapshot(event.data)) { pushed = true; setStreams(event.data) }
    })
    void apiClient.feature('getStreamSessions', undefined).then((result) => {
      if (live && !pushed && result.ok && isSnapshot(result.value)) setStreams(result.value)
    }).catch(() => { /* The 同屏 panel reports stream errors; backups stay empty. */ })
    return () => { live = false; off() }
  }, [])

  const views = useMemo(() => (streams?.sessions ?? [])
    .filter(view => EXTRA_ID.test(view.id) && isCandidateView(view) && !closed.current.has(view.id)), [streams])
  const allExtra = (streams?.sessions ?? []).filter(view => EXTRA_ID.test(view.id) && !closed.current.has(view.id)).length
  const full = views.length >= MAX_CANDIDATES
    || (streams !== null && streams.maxExtraStreams > 0 && allExtra >= streams.maxExtraStreams)

  // Keep every ready backup attached and playing muted; drop the videos of closed ones.
  useEffect(() => {
    registry.retain(new Set(views.map(view => view.id)))
    for (const view of views) {
      const entry = registry.acquire(view.id)
      if (!entry) continue
      const arrived = view.phase === 'ready' && entry.lastPhase !== 'ready'
      entry.lastPhase = view.phase
      if (arrived) entry.readyCount += 1
      entry.media.mount(parked.current)
      const source = view.stream
      if (view.phase !== 'ready' || !source) continue
      const key = `${entry.readyCount}|${source.kind}|${source.url}|${source.quality ?? ''}`
      if (entry.loadedKey === key) continue
      entry.loadedKey = key
      entry.media.video.muted = true
      void entry.media.load(descriptorFor(view, source))
        .then(() => { if (entry.loadedKey === key) return entry.media.video.play() })
        .catch(() => { if (entry.loadedKey === key) entry.loadedKey = null })
    }
  }, [registry, views])

  const open = useCallback(async (text: string, platform?: RoomPlatform): Promise<string | null> => {
    const { origin, open: input } = originFor(text, platform)
    const result = await apiClient.feature('openStreamSession', { ...input, role: 'candidate' })
    if (!result.ok) return errorMessage(result) || '备选画面打开失败'
    origins.current.set(result.value.id, origin)
    setStreams(value => value && !value.sessions.some(item => item.id === result.value.id)
      ? { ...value, sessions: [...value.sessions, result.value] } : value)
    return null
  }, [])

  const add = useCallback(async (text: string, platform?: RoomPlatform): Promise<string | null> => {
    if (!text.trim()) return '请输入直播间链接或房间号'
    if (full) return `最多添加 ${MAX_CANDIDATES} 个备选画面`
    try { return await open(text, platform) }
    catch (caught) { return displayError(caught, '备选画面打开失败').message }
  }, [full, open])

  const remove = useCallback(async (id: string): Promise<void> => {
    closed.current.add(id)
    origins.current.delete(id)
    registry.dispose(id)
    setStreams(value => value && { ...value, sessions: value.sessions.filter(item => item.id !== id) })
    await apiClient.feature('closeStreamSession', { id: id as StreamSessionView['id'] }).catch(() => undefined)
  }, [registry])

  /**
   * Load a backup as 画面, keep the picture it replaces as a backup, and align once both sides
   * are ready again. Resolves false when the backup could not be loaded; 画面 is then unchanged.
   */
  const promote = useCallback(async (id: string): Promise<boolean> => {
    const view = views.find(item => item.id === id)
    if (!view || working.current) return false
    working.current = true
    setBusy(true)
    try {
      const origin = origins.current.get(id) ?? { input: view.input }
      const previous = session.snapshot.media.official.descriptor
      const ok = await loader.loadInput('official', origin.input, origin.platform)
      if (!ok) return false
      await remove(id)
      if (previous?.input && previous.platform && !['file', 'test'].includes(previous.platform)) {
        const platform = ROOM_PLATFORMS.includes(previous.platform) ? previous.platform as RoomPlatform : undefined
        const problem = await open(previous.input, platform).catch(() => '备选画面打开失败')
        if (problem) session.notice('warn', `原画面未能保留为备选：${problem}`)
      }
      void session.realignAfterSwitch()
      return true
    } finally {
      working.current = false
      setBusy(false)
    }
  }, [loader, open, remove, session, views])

  // ---------------------------------------------------------------- matching

  const matcher = useRef<CandidateMatcher | null>(null)
  const streak = useRef(new CandidateStreak(2))
  const frameMode = snapshot.settings.recognitionMode === 'frame-hash'
  const sidesReady = snapshot.media.official.status === 'ready' && snapshot.media.commentary.status === 'ready'
  const readyIds = views.filter(view => view.phase === 'ready').map(view => view.id).join(',')

  // One matcher while backups exist in 画面匹配 mode; it follows the current list of pictures.
  useEffect(() => {
    if (!frameMode || !sidesReady || !readyIds || typeof Worker === 'undefined') {
      matcher.current?.dispose()
      matcher.current = null
      streak.current.reset()
      return
    }
    const revision = (role: 'official' | 'commentary'): string => {
      const state = session.engine.playbackSample(role)
      return `${session.sourceRevision(role)}:${state.observationRevision}:${state.discontinuities}`
    }
    matcher.current ??= new CandidateMatcher({
      commentary: () => session.engine.element('commentary'),
      commentaryRevision: () => revision('commentary'),
      config: () => ({ regions: session.settings.frameHashRegions, masks: session.settings.frameHashMasks }),
    })
    const pictures: MatcherPicture[] = [{ key: CURRENT_PICTURE, video: session.engine.element('official'), revision: () => revision('official') }]
    for (const id of readyIds.split(',')) {
      const entry = registry.peek(id)
      if (entry) pictures.push({ key: id, video: entry.media.video, revision: () => `${id}:${entry.readyCount}` })
    }
    matcher.current.sync(pictures)
  }, [frameMode, readyIds, registry, session, sidesReady])

  useEffect(() => () => { matcher.current?.dispose(); matcher.current = null }, [])

  /** One comparison; the winning backup id, or null. Null too when another one is running. */
  const compareOnce = useCallback(async (signal: { readonly aborted: boolean }): Promise<string | null> => {
    const current = matcher.current
    if (!current || current.size < 2 || working.current) return null
    working.current = true
    try {
      const result = await current.compare(signal)
      return signal.aborted ? null : bestCandidate(result.current, result.scores)
    } finally { working.current = false }
  }, [])

  const labelOf = useCallback((id: string): string => {
    const view = views.find(item => item.id === id)
    return view?.stream?.label || view?.input || '备选画面'
  }, [views])

  // Failure recovery asks once; a single clear win is enough when the current picture keeps failing.
  useEffect(() => {
    session.setCandidateRecovery(async () => {
      if (session.settings.recognitionMode !== 'frame-hash') return false
      const winner = await compareOnce({ aborted: false })
      if (!winner) return false
      const label = labelOf(winner)
      const ok = await promote(winner)
      if (ok) session.notice('info', `检测到解说切换到「${label}」，已切换画面`)
      return ok
    })
    return () => session.setCandidateRecovery(null)
  }, [compareOnce, labelOf, promote, session])

  const autoPick = frameMode && snapshot.settings.autoPickCandidate && sidesReady && readyIds !== ''
  const idle = !snapshot.refreshing && !['sampling', 'estimating', 'applying', 'verifying'].includes(snapshot.autoSync.phase)
  const idleRef = useRef(idle)
  idleRef.current = idle

  useEffect(() => {
    if (!autoPick) return
    const signal = { aborted: false }
    const timer = setInterval(() => {
      if (!idleRef.current) return
      void compareOnce(signal).then(async (winner) => {
        const decided = streak.current.observe(winner)
        if (!decided || signal.aborted) return
        const label = labelOf(decided)
        if (await promote(decided)) session.notice('info', `检测到解说切换到「${label}」，已切换画面`)
      })
    }, AUTO_PICK_INTERVAL_MS)
    return () => { signal.aborted = true; clearInterval(timer); streak.current.reset() }
  }, [autoPick, compareOnce, labelOf, promote, session])

  const candidates = useMemo<Candidate[]>(() => views.map(view => ({
    id: view.id, label: view.stream?.label || view.input, phase: view.phase, error: view.error,
  })), [views])

  const controls = useMemo<CandidateControls>(() => ({ candidates, full, busy, add, remove, promote }),
    [add, busy, candidates, full, promote, remove])

  return (
    <CandidateContext.Provider value={controls}>
      {children}
      {/* Backups must stay rendered to keep decoding frames; this keeps them out of sight. */}
      <div ref={parked} className="candidate-parked" aria-hidden="true"
        style={{ position: 'fixed', left: 0, top: 0, width: 2, height: 2, overflow: 'hidden', opacity: 0.01, pointerEvents: 'none' }} />
    </CandidateContext.Provider>
  )
}
