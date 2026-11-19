/**
 * Loading sources, shared by the intake screen and the source popovers.
 *
 * Per-role state (busy, last problem, resolver notes, a login that would lift the quality)
 * lives in one provider rather than in whichever component started the load, so closing a
 * popover mid-resolve does not lose what comes back.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { parseSourceInput, toDescriptor } from '../core/mediaSources'
import { basicClockFileKey } from '../core/basicClockMemory'
import { parseDouyinInput } from '../core/douyinInput'
import { SOURCE_ROLES, type MediaDescriptor, type PlatformId, type SourceRole } from '../core/types'
import { lastSource, loadLastSources, saveLastSources, type LastSources } from '../app/lastSources'
import type { LoginPlatform } from '../../electron/login'
import { streamFailureHint } from '../../server/networkFailure'
import { displayError, errorDetails, type ErrorDetails } from '../core/errorDetails'

export interface RoleLoad {
  busy: boolean
  problem: { message: string; hint?: string; detail?: ErrorDetails } | null
  notes: string[]
  /** Signing in to this platform would get the stream, or its top quality; null otherwise. */
  login: LoginPlatform | null
  /** `login` is a fresh sign-in for a platform that already has one: its stored login was refused. */
  signedIn: boolean
  /** A login window is open for `login`. */
  loggingIn: boolean
}

const IDLE: RoleLoad = { busy: false, problem: null, notes: [], login: null, signedIn: false, loggingIn: false }
const LOGIN_PLATFORMS: ReadonlySet<PlatformId> = new Set(['douyu', 'youtube', 'bilibili', 'huya', 'douyin'])
const canLogin = (platform: PlatformId): platform is LoginPlatform => LOGIN_PLATFORMS.has(platform)

export const LOGIN_LABEL: Record<LoginPlatform, string> = { douyu: '斗鱼', youtube: 'YouTube', bilibili: '哔哩哔哩', huya: '虎牙', douyin: '抖音' }

/** A Latin name sits in Chinese with a space either side, as elsewhere: 登录 YouTube 后重试. */
export const spaced = (name: string): string => /^[A-Za-z]/.test(name) ? ` ${name} ` : name

/** YouTube refusals a sign-in can lift. A region or a private video is not about who is watching. */
const SIGN_IN_REFUSALS = new Set(['bot-check', 'sign-in', 'members-only', 'age-restricted'])

export const ROLE_LABEL: Record<SourceRole, string> = { official: '画面', commentary: '解说' }

export const PLATFORM_LABEL: Record<PlatformId, string> = {
  youtube: 'YouTube', twitch: 'Twitch', douyu: '斗鱼', bilibili: '哔哩哔哩', huya: '虎牙', douyin: '抖音',
  direct: '直链', file: '本地文件', test: '测试片源',
}

export type RoomPlatform = 'douyu' | 'bilibili' | 'huya' | 'douyin'

/** What either side accepts: any side may play any source, so both say the same. */
export const SOURCE_HINT = '粘贴直播间链接或输入房间号'
export const SOURCE_KINDS = '未添加'

/**
 * A room typed on its own rather than as a link: `6979222`, or with a platform in front,
 * `b 21452505` / `斗鱼9999` / `虎牙 kpl`. Bare identifiers need a platform (`platform: null`).
 */
export function parseRoomInput(text: string): { room: string; platform: RoomPlatform | null } | null {
  const value = text.trim()
  if (/^[1-9]\d{0,19}$/.test(value)) return { room: value, platform: null }
  const douyin = /^(?:douyin\s*[:：]?\s*|抖音\s*[:：]?\s*)([1-9]\d{0,19})$/i.exec(value)
  if (douyin) return { room: douyin[1]!, platform: 'douyin' }
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
  const douyin = parseDouyinInput(input)
  if (douyin) return douyin.kind === 'room' ? douyin.room : null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`)
    if (/(^|\.)douyin\.com$|(^|\.)amemv\.com$/i.test(url.hostname)) return null
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
  if (descriptor.platform === 'douyin') {
    const input = parseDouyinInput(descriptor.input)
    const typed = parseRoomInput(descriptor.input)
    const room = input?.kind === 'room' ? input.room : typed?.platform === 'douyin' ? typed.room : null
    if (room) return `${platform} ${room}`
  }
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

/** Reflow sourceRoom is a live-session id; subscriptions require the public web room. */
export function douyinDanmakuRoom(descriptor: Pick<MediaDescriptor, 'input' | 'danmakuRoom'>): string | null {
  if (/^douyin:[1-9][0-9]{0,19}$/.test(descriptor.danmakuRoom ?? '')) return descriptor.danmakuRoom!
  const parsed = parseDouyinInput(descriptor.input)
  if (parsed?.kind === 'room') return `douyin:${parsed.room}`
  const typed = parseRoomInput(descriptor.input)
  return typed?.platform === 'douyin' ? `douyin:${typed.room}` : null
}

interface Loader {
  state: Record<SourceRole, RoleLoad>
  previousSources: LastSources
  restoring: boolean
  restoreProblem: string | null
  restorePrevious: () => Promise<boolean>
  /**
   * Resolve and load whatever was typed. `platform` settles a bare room number; without it
   * a bare number is Douyu's. Resolves false when nothing was loaded.
   */
  loadInput: (role: SourceRole, input: string, platform?: RoomPlatform) => Promise<boolean>
  loadFile: (role: SourceRole, file: File) => Promise<boolean>
  loadDescriptor: (role: SourceRole, descriptor: MediaDescriptor) => Promise<boolean>
  clearProblem: (role: SourceRole) => void
  /** Sign in for `state[role].login`, then load the same input again. */
  login: (role: SourceRole) => Promise<void>
  /** The danmaku room as the viewer knows it, while one is connected. */
  roomName: string | null
  connectRoom: (room: string, name?: string, followsCommentary?: boolean) => void
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
  const snapshot = useSessionSnapshot()
  const room = snapshot.danmaku.room
  const [previousSources, setPreviousSources] = useState(loadLastSources)
  const previous = useRef(previousSources)
  const [restoring, setRestoring] = useState(false)
  const restoringRef = useRef(false)
  const [restoreProblem, setRestoreProblem] = useState<string | null>(null)
  const live = useRef(state)
  const loads = useRef<Partial<Record<SourceRole, object>>>({})
  // What each side last asked for, so a login can retry it as typed.
  const asked = useRef<Partial<Record<SourceRole, { input: string; platform?: RoomPlatform }>>>({})
  const patch = useCallback((role: SourceRole, next: Partial<RoleLoad>) => {
    live.current = { ...live.current, [role]: { ...live.current[role], ...next } }
    setState(live.current)
  }, [])

  useEffect(() => {
    const next = { ...previous.current }
    for (const role of SOURCE_ROLES) {
      const media = snapshot.media[role]
      if (media.status !== 'ready' || !media.descriptor) continue
      const source = lastSource(media.descriptor)
      if (source) next[role] = source
      else delete next[role]
    }
    if (JSON.stringify(next) === JSON.stringify(previous.current)) return
    previous.current = next
    saveLastSources(next)
    setPreviousSources(next)
  }, [snapshot.media.official.status, snapshot.media.official.descriptor, snapshot.media.commentary.status, snapshot.media.commentary.descriptor])

  const connectRoom = useCallback((next: string, name?: string, followsCommentary = false) => {
    // Set before connecting: the relay may swap the typed number for the real id.
    setRoomAlias(name ?? next)
    session.connectDanmaku(next, followsCommentary)
  }, [session, setRoomAlias])
  const disconnectRoom = useCallback(() => { setRoomAlias(null); session.disconnectDanmaku() }, [session, setRoomAlias])

  const connectSourceRoom = useCallback((descriptor: MediaDescriptor) => {
    if (session.hasManualDanmakuRoom()) return
    if (descriptor.platform === 'douyin') {
      const roomKey = douyinDanmakuRoom(descriptor)
      if (roomKey) {
        try { connectRoom(roomKey, roomKey.slice('douyin:'.length), true) }
        catch (error) { session.notice('warn', '抖音弹幕连接失败，视频继续播放', error) }
      }
    } else if (descriptor.platform === 'huya') {
      const sourceRoom = descriptor.sourceRoom ?? roomFromInput(descriptor.input)
      if (sourceRoom) connectRoom(`huya:${sourceRoom}`, roomFromInput(descriptor.input) ?? sourceRoom, true)
    } else if (descriptor.platform === 'douyu' && descriptor.danmakuRoom) {
      connectRoom(descriptor.danmakuRoom, roomFromInput(descriptor.input) ?? descriptor.danmakuRoom, true)
    }
  }, [connectRoom, session])

  // Loading is a request to watch: start playback rather than leave a loaded, still picture.
  const play = useCallback(() => { void session.setPlaying(true) }, [session])

  const finishAttachment = useCallback(async (role: SourceRole, generation: number, request: object): Promise<boolean> => {
    const current = () => generation === session.sourceRevision(role) && loads.current[role] === request
    if (!current()) return false
    const status = () => session.engine.getState()[role].status
    if (status() === 'error') return false
    if (status() !== 'empty') play()
    if (status() !== 'loading') return true
    return new Promise(resolve => {
      const finish = (ok: boolean) => { clearTimeout(timer); release(); resolve(ok) }
      const release = session.subscribe(() => {
        if (!current()) finish(false)
        else if (status() !== 'loading') finish(status() !== 'error')
      })
      const timer = setTimeout(() => finish(current() && status() !== 'error'), 15_000)
    })
  }, [play, session])

  const loadDescriptor = useCallback(async (role: SourceRole, descriptor: MediaDescriptor) => {
    const request = {}
    loads.current[role] = request
    patch(role, { busy: true, problem: null, notes: [], login: null })
    if (role === 'commentary') session.disconnectCommentaryDanmaku()
    try {
      const loading = session.loadSource(role, descriptor)
      const generation = session.sourceRevision(role)
      await loading
      if (!await finishAttachment(role, generation, request) || generation !== session.sourceRevision(role) || loads.current[role] !== request) return false
      if (role === 'commentary') connectSourceRoom(descriptor)
      return true
    } catch (error) {
      if (loads.current[role] === request) patch(role, { problem: displayError(error, '片源载入失败，请重试') })
      return false
    } finally { if (loads.current[role] === request) patch(role, { busy: false }) }
  }, [connectSourceRoom, finishAttachment, patch, session])

  /**
   * Offer a login for the load that asked. A step-down only needs one from someone not signed in;
   * a refusal may need a fresh login even when stored cookies are still there.
   */
  const offerLogin = useCallback(async (role: SourceRole, platform: LoginPlatform, generation: number, refused: boolean) => {
    try {
      const status = await apiClient.loginStatus()
      if (generation !== session.sourceRevision(role)) return
      const signedIn = status.ok && Boolean(status.value[platform]?.loggedIn)
      if (signedIn && !refused) return
      patch(role, { login: platform, signedIn })
    } catch {
      if (refused && generation === session.sourceRevision(role)) patch(role, { login: platform, signedIn: false })
    }
  }, [patch, session])

  const loadInput = useCallback(async (role: SourceRole, input: string, platform?: RoomPlatform): Promise<boolean> => {
    const typed = parseRoomInput(input)
    const roomPlatform = typed?.platform ?? platform
    const roomInput = typed && roomPlatform === 'douyin' ? `https://live.douyin.com/${typed.room}`
      : typed && roomPlatform === 'huya' ? `https://www.huya.com/${typed.room}` : typed ? typed.room : input
    let parsed = parseSourceInput(roomInput)
    if (!parsed.ok) { patch(role, { problem: { message: parsed.message }, login: null }); return false }
    asked.current[role] = { input, platform }
    if (typed && roomPlatform === 'bilibili') {
      parsed = { ...parsed, platform: 'bilibili', label: `${PLATFORM_LABEL.bilibili} ${typed.room}` }
    }
    if (!parsed.needsResolve) return loadDescriptor(role, toDescriptor(parsed))

    const request = {}
    loads.current[role] = request
    patch(role, { busy: true, problem: null, notes: [], login: null })
    let generation = session.beginSourceChange(role)
    const platformOf = parsed.platform
    if (role === 'commentary' && platformOf === 'douyin') session.disconnectCommentaryDanmaku()
    try {
      const result = await apiClient.resolve(
        parsed.url, parsed.platform, role, undefined,
        session.settings.preferAdaptive || undefined,
      )
      if (generation !== session.sourceRevision(role)) return false
      if (!result.ok) {
        patch(role, { problem: { message: result.message, hint: streamFailureHint(result.code), detail: errorDetails(result) } })
        if (canLogin(platformOf) && (result.code === 'login-required' || (platformOf === 'douyin' && result.code === 'restricted'))) void offerLogin(role, platformOf, generation, true)
        return false
      }
      if (!result.value.ok) {
        const { failure } = result.value
        // A proxy that cannot be reached is not the platform's fault; say which to check.
        const hint = streamFailureHint(failure.reason) ?? failure.hint
        patch(role, { problem: { message: failure.message, hint, detail: errorDetails(failure) } })
        // Only an explicit authentication refusal offers Bilibili/Huya sign-in.
        const signInCanHelp = SIGN_IN_REFUSALS.has(failure.reason ?? '') || (!failure.reason && (platformOf === 'douyu' || platformOf === 'youtube'))
        if (canLogin(platformOf) && (failure.code === 'login-required' || (failure.code === 'restricted' && (signInCanHelp || platformOf === 'douyin')))) void offerLogin(role, platformOf, generation, true)
        return false
      }
      const stream = result.value.stream
      patch(role, { notes: stream.notes ?? [] })
      const sharedDouyin = parsed.platform === 'douyin' && parseDouyinInput(parsed.url)?.kind !== 'room'
      const webRoom = sharedDouyin ? douyinDanmakuRoom({ input: parsed.url, danmakuRoom: stream.danmakuRoom })?.slice('douyin:'.length) : null
      // Douyu is asked for 原画 (rate 0); another rate back is the anonymous step-down.
      if (stream.platform === 'douyu' && stream.quality !== undefined && stream.quality !== '0') void offerLogin(role, 'douyu', generation, false)
      const descriptor: MediaDescriptor = {
        ...toDescriptor(
          { ...parsed, kind: stream.kind, label: stream.label },
          { url: stream.url, viaProxy: stream.requiresProxy },
        ),
        input: webRoom ? `https://live.douyin.com/${webRoom}` : input.trim(),
        sourceQualities: stream.qualities,
        sourceQuality: stream.quality,
        sourceRoom: stream.sourceRoom ?? stream.danmakuRoom,
        danmakuRoom: stream.danmakuRoom,
      }
      if (role === 'commentary') session.disconnectCommentaryDanmaku()
      const loading = session.loadSource(role, descriptor)
      generation = session.sourceRevision(role)
      await loading
      // Removal and a newer source both invalidate any room that accompanied this load.
      if (!await finishAttachment(role, generation, request) || generation !== session.sourceRevision(role) || loads.current[role] !== request) return false
      // The commentary room's danmaku come along with it; nothing to set up separately.
      if (role === 'commentary') connectSourceRoom(descriptor)
      return true
    } catch (error) {
      if (generation === session.sourceRevision(role) && loads.current[role] === request) patch(role, { problem: displayError(error, '片源载入失败，请重试') })
      return false
    } finally {
      session.endSourceChange(role, generation)
      if (loads.current[role] === request) patch(role, { busy: false })
    }
  }, [connectSourceRoom, finishAttachment, loadDescriptor, offerLogin, patch, session])

  const login = useCallback(async (role: SourceRole) => {
    const platform = live.current[role].login
    const again = asked.current[role]
    if (!platform || live.current[role].loggingIn) return
    const generation = session.sourceRevision(role)
    const stillCurrent = (): boolean => generation === session.sourceRevision(role) && asked.current[role] === again
    patch(role, { loggingIn: true, problem: null })
    try {
      const result = await apiClient.login(platform)
      if (!result.ok) {
        if (stillCurrent()) patch(role, { problem: result.code === 'login-cancelled' ? null : displayError(result) })
        return
      }
    } catch (error) {
      if (stillCurrent()) patch(role, { problem: displayError(error, '登录暂时失败，请重试') })
      return
    } finally { patch(role, { loggingIn: false }) }
    if (again && stillCurrent()) await loadInput(role, again.input, again.platform)
  }, [loadInput, patch, session])

  const loadFile = useCallback((role: SourceRole, file: File) => loadDescriptor(role, {
    // An object URL keeps the file local; nothing is uploaded.
    kind: 'file', url: URL.createObjectURL(file), input: file.name, label: file.name,
    recognitionSourceKey: basicClockFileKey(file),
    loop: false, viaProxy: false, platform: 'file',
  }), [loadDescriptor])

  const clearProblem = useCallback((role: SourceRole) => patch(role, { problem: null }), [patch])

  const roomName = room ? roomAlias ?? room : null
  const restorePrevious = useCallback(async (): Promise<boolean> => {
    if (restoringRef.current) return false
    const saved = { ...previous.current }
    const roles = SOURCE_ROLES.filter(role => saved[role] && !live.current[role].busy
      && ['empty', 'error'].includes(session.snapshot.media[role].status))
    if (!roles.length) return false
    restoringRef.current = true
    setRestoring(true)
    setRestoreProblem(null)
    try {
      const failures = await Promise.all(roles.map(async role => {
        const source = saved[role]!
        const platform = ['douyu', 'bilibili', 'huya', 'douyin'].includes(source.platform) ? source.platform as RoomPlatform : undefined
        try { return await loadInput(role, source.input, platform) && session.snapshot.media[role].status !== 'error' ? null : role }
        catch { patch(role, { busy: false, problem: { message: '载入失败，请检查网络后重试' } }); return role }
      }))
      const messages = failures.filter((role): role is SourceRole => role !== null)
        .map(role => `${ROLE_LABEL[role]}：${live.current[role].problem?.message ?? session.snapshot.media[role].error?.message ?? '恢复未完成，请检查片源后重试'}`)
      if (messages.length) setRestoreProblem(messages.join('；'))
      return messages.length === 0
    } finally { restoringRef.current = false; setRestoring(false) }
  }, [loadInput, patch, session])

  const value = useMemo(() => ({ state, previousSources, restoring, restoreProblem, restorePrevious, loadInput, loadFile, loadDescriptor, clearProblem, login, roomName, connectRoom, disconnectRoom }),
    [state, previousSources, restoring, restoreProblem, restorePrevious, loadInput, loadFile, loadDescriptor, clearProblem, login, roomName, connectRoom, disconnectRoom])
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
  const text = !load.problem && load.login !== 'douyin' ? '登录后可尝试原画' : null
  return (
    <span className="slot-login">
      {text && <span>{text}</span>}
      <button type="button" className="btn-solid small" onClick={() => void loader.login(role)}>{load.signedIn ? `重新登录${name}并重试` : `登录${name}并重试`}</button>
    </span>
  )
}

