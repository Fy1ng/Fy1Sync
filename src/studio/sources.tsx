/**
 * Loading sources, shared by the intake screen and the source popovers.
 *
 * Per-role state (busy, last problem, resolver notes) lives in one provider rather than in
 * whichever component started the load, so closing a popover mid-resolve does not lose the
 * error that comes back.
 *
 * `routeFor` is what lets the intake screen have a single paste field: the platform of a
 * link already says which side it belongs to. Only links that carry no such hint — a bare
 * m3u8, a local file — have to be asked about.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { parseSourceInput, toDescriptor } from '../core/mediaSources'
import type { MediaDescriptor, PlatformId, SourceRole } from '../core/types'

export interface RoleLoad {
  busy: boolean
  problem: { message: string; hint?: string } | null
  notes: string[]
}

const IDLE: RoleLoad = { busy: false, problem: null, notes: [] }

/** Which side a platform belongs to, or null when the link itself cannot say. */
export function routeFor(platform: PlatformId): SourceRole | null {
  if (platform === 'youtube' || platform === 'twitch') return 'official'
  if (platform === 'douyu' || platform === 'bilibili' || platform === 'huya') return 'commentary'
  return null
}

export const ROLE_LABEL: Record<SourceRole, string> = { official: '画面', commentary: '解说' }

export const PLATFORM_LABEL: Record<PlatformId, string> = {
  youtube: 'YouTube', twitch: 'Twitch', douyu: '斗鱼', bilibili: '哔哩哔哩', huya: '虎牙',
  direct: '直链', file: '本地文件', test: '测试片源',
}

export type RoomPlatform = 'douyu' | 'bilibili' | 'huya'

/**
 * A room typed on its own rather than as a link: `6979222`, or with a platform in front,
 * `b 21452505` / `斗鱼9999` / `虎牙 kpl`. Bare identifiers need a platform (`platform: null`).
 */
export function parseRoomInput(text: string): { room: string; platform: RoomPlatform | null } | null {
  const value = text.trim()
  if (/^[1-9]\d{0,11}$/.test(value)) return { room: value, platform: null }
  const huya = /^(?:(?:hy|huya)(?:\s*[:：]\s*|\s+)|虎牙\s*[:：]?\s*)([A-Za-z0-9_-]{1,64})$/i.exec(value)
  if (huya) return { room: huya[1]!, platform: 'huya' }
  const prefixed = /^(dy|douyu|斗鱼|b|bili|bilibili|b站|哔哩哔哩)\s*[:：]?\s*([1-9]\d{0,11})$/i.exec(value)
  if (!prefixed) return /^(?=.*[A-Za-z_-])[A-Za-z0-9_-]{1,64}$/.test(value) ? { room: value, platform: null } : null
  return { room: prefixed[2]!, platform: /^(dy|douyu|斗鱼)$/i.test(prefixed[1]!) ? 'douyu' : 'bilibili' }
}

/**
 * The room as the viewer wrote it. Douyu resolves a vanity number to the real room id, and
 * the real id is what the stream and the danmaku need — but it is not the number the viewer
 * knows the room by, so the display keeps what was typed.
 */
export function roomFromInput(input: string | undefined): string | null {
  if (!input) return null
  const typed = parseRoomInput(input)
  if (typed) return typed.room
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`)
    const rid = url.searchParams.get('rid')
    if (rid && /^\d{1,12}$/.test(rid)) return rid
    const segments = url.pathname.split('/').filter(Boolean).reverse()
    const numeric = segments.find((part) => /^\d{1,12}$/.test(part))
    if (numeric) return numeric
    if (/(^|\.)douyu\.com$/i.test(url.hostname)) return segments.find((part) => /^[A-Za-z0-9_]{1,32}$/.test(part)) ?? null
    if (/(^|\.)huya\.com$/i.test(url.hostname)) return segments.find((part) => /^[A-Za-z0-9_-]{1,64}$/.test(part)) ?? null
    return null
  } catch {
    return null
  }
}

/** How a loaded source is named in the top bar and on the intake screen. */
export function sourceTitle(descriptor: MediaDescriptor): string {
  const platform = descriptor.platform ? PLATFORM_LABEL[descriptor.platform] : ''
  if (descriptor.platform === 'douyu' || descriptor.platform === 'bilibili' || descriptor.platform === 'huya') {
    const room = roomFromInput(descriptor.input) ?? descriptor.sourceRoom
    if (room) return `${platform} ${room}`
  }
  // Resolver labels often carry the platform already ("斗鱼 6979222", "YouTube 直播").
  if (!platform || descriptor.platform === 'test' || descriptor.platform === 'file' || descriptor.label.startsWith(platform)) {
    return descriptor.label
  }
  return `${platform} ${descriptor.label}`
}

interface Loader {
  state: Record<SourceRole, RoleLoad>
  /**
   * Resolve and load whatever was typed. `platform` settles a bare room number; without it
   * a bare number is Douyu's. Resolves false when nothing was loaded.
   */
  loadInput: (role: SourceRole, input: string, platform?: RoomPlatform) => Promise<boolean>
  loadFile: (role: SourceRole, file: File) => Promise<void>
  loadDescriptor: (role: SourceRole, descriptor: MediaDescriptor) => Promise<void>
  clearProblem: (role: SourceRole) => void
  /** The danmaku room as the viewer knows it, while one is connected. */
  roomName: string | null
  connectRoom: (room: string, name?: string) => void
  disconnectRoom: () => void
}

const LoaderContext = createContext<Loader | null>(null)

/** The room name as typed, kept across player mounts like the session that holds the room. */
let rememberedAlias: string | null = null

export function SourceLoaderProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const session = useSession()
  const [state, setState] = useState<Record<SourceRole, RoleLoad>>({ official: IDLE, commentary: IDLE })
  const [roomAlias, setAlias] = useState<string | null>(() => rememberedAlias)
  const setRoomAlias = useCallback((alias: string | null) => { rememberedAlias = alias; setAlias(alias) }, [])
  const room = useSessionSnapshot().danmaku.room
  const live = useRef(state)
  const patch = useCallback((role: SourceRole, next: Partial<RoleLoad>) => {
    live.current = { ...live.current, [role]: { ...live.current[role], ...next } }
    setState(live.current)
  }, [])

  const connectRoom = useCallback((next: string, name?: string) => {
    // Set before connecting: the relay may swap the typed number for the real id.
    setRoomAlias(name ?? next)
    session.connectDanmaku(next)
  }, [session, setRoomAlias])
  const disconnectRoom = useCallback(() => { setRoomAlias(null); session.disconnectDanmaku() }, [session, setRoomAlias])

  // Loading is a request to watch: start playback rather than leave a loaded, still picture.
  const play = useCallback(() => { void session.setPlaying(true) }, [session])

  const loadDescriptor = useCallback(async (role: SourceRole, descriptor: MediaDescriptor) => {
    patch(role, { busy: true, problem: null, notes: [] })
    try {
      await session.loadSource(role, descriptor)
      if (role === 'commentary' && descriptor.platform === 'huya') disconnectRoom()
    } finally { patch(role, { busy: false }) }
    if (session.snapshot.media[role].status !== 'empty') play()
  }, [disconnectRoom, patch, play, session])

  const loadInput = useCallback(async (role: SourceRole, input: string, platform?: RoomPlatform): Promise<boolean> => {
    const typed = parseRoomInput(input)
    const roomPlatform = typed?.platform ?? platform
    let parsed = parseSourceInput(typed && roomPlatform === 'huya' ? `https://www.huya.com/${typed.room}` : typed ? typed.room : input)
    if (!parsed.ok) { patch(role, { problem: { message: parsed.message } }); return false }
    if (typed && roomPlatform === 'bilibili') {
      parsed = { ...parsed, platform: 'bilibili', label: `${PLATFORM_LABEL.bilibili} ${typed.room}` }
    }
    if (!parsed.needsResolve) { await loadDescriptor(role, toDescriptor(parsed)); return true }

    patch(role, { busy: true, problem: null, notes: [] })
    const generation = session.beginSourceChange(role)
    try {
      const result = await apiClient.resolve(
        parsed.url, parsed.platform, role, undefined,
        session.settings.preferAdaptive || undefined,
      )
      if (generation !== session.sourceRevision(role)) return false
      if (!result.ok) { patch(role, { problem: { message: result.message } }); return false }
      if (!result.value.ok) {
        const { failure } = result.value
        patch(role, { problem: { message: failure.message, hint: failure.hint } })
        return false
      }
      const stream = result.value.stream
      patch(role, { notes: stream.notes ?? [] })
      await session.loadSource(role, {
        ...toDescriptor(
          { ...parsed, kind: stream.kind, label: stream.label },
          { url: stream.url, viaProxy: stream.requiresProxy },
        ),
        input: input.trim(),
        sourceQualities: stream.qualities,
        sourceQuality: stream.quality,
        sourceRoom: stream.sourceRoom ?? stream.danmakuRoom,
      })
      // The commentary room's danmaku come along with it; nothing to set up separately.
      if (role === 'commentary') {
        if (parsed.platform === 'huya' || stream.platform === 'huya') disconnectRoom()
        else if (stream.danmakuRoom) connectRoom(stream.danmakuRoom, roomFromInput(input) ?? stream.danmakuRoom)
      }
      play()
      return true
    } finally {
      patch(role, { busy: false })
    }
  }, [connectRoom, disconnectRoom, loadDescriptor, patch, play, session])

  const loadFile = useCallback((role: SourceRole, file: File) => loadDescriptor(role, {
    // An object URL keeps the file local; nothing is uploaded.
    kind: 'file', url: URL.createObjectURL(file), input: file.name, label: file.name,
    loop: false, viaProxy: false, platform: 'file',
  }), [loadDescriptor])

  const clearProblem = useCallback((role: SourceRole) => patch(role, { problem: null }), [patch])

  const roomName = room ? roomAlias ?? room : null
  const value = useMemo(() => ({ state, loadInput, loadFile, loadDescriptor, clearProblem, roomName, connectRoom, disconnectRoom }),
    [state, loadInput, loadFile, loadDescriptor, clearProblem, roomName, connectRoom, disconnectRoom])
  return <LoaderContext.Provider value={value}>{children}</LoaderContext.Provider>
}

export function useSourceLoader(): Loader {
  const loader = useContext(LoaderContext)
  if (!loader) throw new Error('useSourceLoader outside SourceLoaderProvider')
  return loader
}

/** The fixtures from `npm run fixtures`; offered only when they exist on this machine. */
export const FIXTURES: Record<SourceRole, MediaDescriptor> = {
  official: {
    kind: 'test', url: '/test-sources/official.mp4', input: '/test-sources/official.mp4',
    label: '测试画面', loop: true, viaProxy: false, platform: 'test',
  },
  commentary: {
    kind: 'test', url: '/test-sources/commentary.mp4', input: '/test-sources/commentary.mp4',
    label: '测试解说（延迟 5 秒）', loop: true, viaProxy: false, platform: 'test',
  },
}
