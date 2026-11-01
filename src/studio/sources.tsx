/**
 * Loading sources, shared by the intake screen and the source popovers.
 *
 * Per-role state (busy, last problem, resolver notes, a login that would lift the quality)
 * lives in one provider rather than in whichever component started the load, so closing a
 * popover mid-resolve does not lose what comes back.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { parseSourceInput, toDescriptor } from '../core/mediaSources'
import type { MediaDescriptor, PlatformId, SourceRole } from '../core/types'
import type { LoginPlatform } from '../../electron/login'

export interface RoleLoad {
  busy: boolean
  problem: { message: string; hint?: string } | null
  notes: string[]
  /** Signing in to this platform would get the stream, or its top quality; null otherwise. */
  login: LoginPlatform | null
  /** `login` is a fresh sign-in for a platform that already has one: its stored login was refused. */
  signedIn: boolean
  /** A login window is open for `login`. */
  loggingIn: boolean
}

const IDLE: RoleLoad = { busy: false, problem: null, notes: [], login: null, signedIn: false, loggingIn: false }

export const LOGIN_LABEL: Record<LoginPlatform, string> = { douyu: '斗鱼', youtube: 'YouTube' }

/** A Latin name sits in Chinese with a space either side, as elsewhere: 登录 YouTube 后重试. */
export const spaced = (name: string): string => /^[A-Za-z]/.test(name) ? ` ${name} ` : name

/** YouTube refusals a sign-in can lift. A region or a private video is not about who is watching. */
const SIGN_IN_REFUSALS = new Set(['bot-check', 'sign-in', 'members-only', 'age-restricted'])

export const ROLE_LABEL: Record<SourceRole, string> = { official: '画面', commentary: '解说' }

export const PLATFORM_LABEL: Record<PlatformId, string> = {
  youtube: 'YouTube', twitch: 'Twitch', douyu: '斗鱼', bilibili: '哔哩哔哩', huya: '虎牙',
  direct: '直链', file: '本地文件', test: '测试片源',
}

export type RoomPlatform = 'douyu' | 'bilibili' | 'huya'

/** What either side accepts: any side may play any source, so both say the same. */
export const SOURCE_HINT = '斗鱼、哔哩哔哩、虎牙、YouTube、Twitch 链接或房间号'
export const SOURCE_KINDS = '斗鱼、哔哩哔哩、虎牙、YouTube、Twitch'

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
  /** Sign in for `state[role].login`, then load the same input again. */
  login: (role: SourceRole) => Promise<void>
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
  const loads = useRef<Partial<Record<SourceRole, object>>>({})
  // What each side last asked for, so a login can retry it as typed.
  const asked = useRef<Partial<Record<SourceRole, { input: string; platform?: RoomPlatform }>>>({})
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
    const request = {}
    loads.current[role] = request
    patch(role, { busy: true, problem: null, notes: [] })
    try {
      const loading = session.loadSource(role, descriptor)
      const generation = session.sourceRevision(role)
      await loading
      if (generation !== session.sourceRevision(role) || loads.current[role] !== request) return
      if (role === 'commentary' && descriptor.platform === 'huya') {
        const sourceRoom = descriptor.sourceRoom ?? roomFromInput(descriptor.input)
        if (sourceRoom) connectRoom(`huya:${sourceRoom}`, roomFromInput(descriptor.input) ?? sourceRoom)
        else disconnectRoom()
      }
      if (session.snapshot.media[role].status !== 'empty') play()
    } finally { if (loads.current[role] === request) patch(role, { busy: false }) }
  }, [connectRoom, disconnectRoom, patch, play, session])

  /**
   * Offer a login for the load that asked. A step-down only needs one from someone not signed in;
   * a refusal may need a fresh login even when stored cookies are still there.
   */
  const offerLogin = useCallback(async (role: SourceRole, platform: LoginPlatform, generation: number, refused: boolean) => {
    const status = await apiClient.loginStatus()
    if (generation !== session.sourceRevision(role)) return
    const signedIn = status.ok && Boolean(status.value[platform]?.loggedIn)
    if (signedIn && !refused) return
    patch(role, { login: platform, signedIn })
  }, [patch, session])

  const loadInput = useCallback(async (role: SourceRole, input: string, platform?: RoomPlatform): Promise<boolean> => {
    const typed = parseRoomInput(input)
    const roomPlatform = typed?.platform ?? platform
    let parsed = parseSourceInput(typed && roomPlatform === 'huya' ? `https://www.huya.com/${typed.room}` : typed ? typed.room : input)
    if (!parsed.ok) { patch(role, { problem: { message: parsed.message }, login: null }); return false }
    asked.current[role] = { input, platform }
    if (typed && roomPlatform === 'bilibili') {
      parsed = { ...parsed, platform: 'bilibili', label: `${PLATFORM_LABEL.bilibili} ${typed.room}` }
    }
    if (!parsed.needsResolve) { await loadDescriptor(role, toDescriptor(parsed)); return true }

    const request = {}
    loads.current[role] = request
    patch(role, { busy: true, problem: null, notes: [], login: null })
    let generation = session.beginSourceChange(role)
    const platformOf = parsed.platform
    try {
      const result = await apiClient.resolve(
        parsed.url, parsed.platform, role, undefined,
        session.settings.preferAdaptive || undefined,
      )
      if (generation !== session.sourceRevision(role)) return false
      if (!result.ok) { patch(role, { problem: { message: result.message } }); return false }
      if (!result.value.ok) {
        const { failure } = result.value
        // A proxy that cannot be reached is not the platform's fault; say which to check.
        const hint = failure.stage === 'proxy' ? '请确认代理软件已开启，可在 设置 › 网络 查看系统代理' : failure.hint
        patch(role, { problem: { message: failure.message, hint } })
        // A refusal with no reason is Douyu's; YouTube's say which kind, and only a sign-in kind gets the offer.
        const signInCanHelp = !failure.reason || SIGN_IN_REFUSALS.has(failure.reason)
        if (failure.code === 'restricted' && (platformOf === 'douyu' || platformOf === 'youtube') && signInCanHelp) void offerLogin(role, platformOf, generation, true)
        return false
      }
      const stream = result.value.stream
      patch(role, { notes: stream.notes ?? [] })
      // Douyu is asked for 原画 (rate 0); another rate back is the anonymous step-down.
      if (stream.platform === 'douyu' && stream.quality !== undefined && stream.quality !== '0') void offerLogin(role, 'douyu', generation, false)
      const loading = session.loadSource(role, {
        ...toDescriptor(
          { ...parsed, kind: stream.kind, label: stream.label },
          { url: stream.url, viaProxy: stream.requiresProxy },
        ),
        input: input.trim(),
        sourceQualities: stream.qualities,
        sourceQuality: stream.quality,
        sourceRoom: stream.sourceRoom ?? stream.danmakuRoom,
      })
      generation = session.sourceRevision(role)
      await loading
      // Removal and a newer source both invalidate any room that accompanied this load.
      if (generation !== session.sourceRevision(role) || loads.current[role] !== request) return false
      // The commentary room's danmaku come along with it; nothing to set up separately.
      if (role === 'commentary') {
        if (parsed.platform === 'huya' || stream.platform === 'huya') {
          const sourceRoom = stream.sourceRoom ?? stream.danmakuRoom ?? roomFromInput(input)
          if (sourceRoom) connectRoom(`huya:${sourceRoom}`, roomFromInput(input) ?? sourceRoom)
          else disconnectRoom()
        }
        else if (stream.danmakuRoom) connectRoom(stream.danmakuRoom, roomFromInput(input) ?? stream.danmakuRoom)
      }
      play()
      return true
    } finally {
      session.endSourceChange(role, generation)
      if (loads.current[role] === request) patch(role, { busy: false })
    }
  }, [connectRoom, disconnectRoom, loadDescriptor, offerLogin, patch, play, session])

  const login = useCallback(async (role: SourceRole) => {
    const platform = live.current[role].login
    const again = asked.current[role]
    if (!platform || live.current[role].loggingIn) return
    patch(role, { loggingIn: true, problem: null })
    try {
      const result = await apiClient.login(platform)
      if (!result.ok) { patch(role, { problem: { message: result.message } }); return }
    } finally { patch(role, { loggingIn: false }) }
    if (again) await loadInput(role, again.input, again.platform)
  }, [loadInput, patch])

  const loadFile = useCallback((role: SourceRole, file: File) => loadDescriptor(role, {
    // An object URL keeps the file local; nothing is uploaded.
    kind: 'file', url: URL.createObjectURL(file), input: file.name, label: file.name,
    loop: false, viaProxy: false, platform: 'file',
  }), [loadDescriptor])

  const clearProblem = useCallback((role: SourceRole) => patch(role, { problem: null }), [patch])

  const roomName = room ? roomAlias ?? room : null
  const value = useMemo(() => ({ state, loadInput, loadFile, loadDescriptor, clearProblem, login, roomName, connectRoom, disconnectRoom }),
    [state, loadInput, loadFile, loadDescriptor, clearProblem, login, roomName, connectRoom, disconnectRoom])
  return <LoaderContext.Provider value={value}>{children}</LoaderContext.Provider>
}

export function useSourceLoader(): Loader {
  const loader = useContext(LoaderContext)
  if (!loader) throw new Error('useSourceLoader outside SourceLoaderProvider')
  return loader
}

/** The sign-in line under a side. The intake slot and the source panel both show this wording. */
export function LoginOffer({ role }: { role: SourceRole }): React.ReactNode {
  const loader = useSourceLoader()
  const load = loader.state[role]
  if (!load.login || load.busy || load.loggingIn) return null
  const name = spaced(LOGIN_LABEL[load.login])
  // Without a problem this asks for a login only to get the top quality; with one, the login is needed to play.
  const text = !load.problem ? `登录${name}可看最高画质` : load.signedIn ? `重新登录${name}后重试` : `登录${name}后重试`
  return (
    <span className="slot-login">
      <span>{text}</span>
      <button type="button" className="btn-solid small" onClick={() => void loader.login(role)}>{load.signedIn ? '重新登录' : '登录'}</button>
    </span>
  )
}

