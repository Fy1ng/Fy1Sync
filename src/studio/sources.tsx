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
import { hasDirectOptions, validateDirectOptions, type DirectStreamOptions } from '../core/directStream'
import { parseSourceInput, toDescriptor } from '../core/mediaSources'
import { parseDouyinInput } from '../core/douyinInput'
import { douyinDanmakuRoom, parseRoomInput, roomFromInput, type RoomPlatform } from '../core/sourceDanmaku'
import { SOURCE_ROLES, type MediaDescriptor, type PlatformId, type SourceRole } from '../core/types'
import { lastSource, loadLastSources, saveLastSources, type LastSources } from '../app/lastSources'
import type { LoginPlatform } from '../../electron/login'
import { streamFailureHint } from '../../server/networkFailure'
import { displayError, errorDetails, type ErrorDetails } from '../core/errorDetails'
import { notifyLoginStateChanged, subscribeLoginStateChanged } from '../core/loginEvents'
import { refreshLoginStatus } from './login/status'

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
const LOGIN_PLATFORMS: ReadonlySet<PlatformId> = new Set(['douyu', 'youtube', 'twitch', 'bilibili', 'huya', 'douyin'])
const canLogin = (platform: PlatformId): platform is LoginPlatform => LOGIN_PLATFORMS.has(platform)

export const LOGIN_LABEL: Record<LoginPlatform, string> = { douyu: '斗鱼', youtube: 'YouTube', twitch: 'Twitch', bilibili: '哔哩哔哩', huya: '虎牙', douyin: '抖音' }

/** A Latin name sits in Chinese with a space either side, as elsewhere: 登录 YouTube 后重试. */
export const spaced = (name: string): string => /^[A-Za-z]/.test(name) ? ` ${name} ` : name

/** YouTube refusals a sign-in can lift. A region or a private video is not about who is watching. */
const SIGN_IN_REFUSALS = new Set(['cookies-invalidated', 'bot-check', 'sign-in', 'members-only', 'age-restricted'])

export const ROLE_LABEL: Record<SourceRole, string> = { official: '画面', commentary: '解说' }

export const PLATFORM_LABEL: Record<PlatformId, string> = {
  youtube: 'YouTube', twitch: 'Twitch', douyu: '斗鱼', bilibili: '哔哩哔哩', huya: '虎牙', douyin: '抖音',
  direct: '直链', file: '本地文件', test: '测试片源',
}

export { douyinDanmakuRoom, parseDanmakuRoomInput, parseRoomInput, roomFromInput, type RoomPlatform } from '../core/sourceDanmaku'

/** What either side accepts: any side may play any source, so both say the same. */
export const SOURCE_HINT = '粘贴直播间链接、房间号或 m3u8 / flv 直播流地址'
export const SOURCE_KINDS = '未添加'

/** How a loaded source is named in the top bar and on the intake screen. */
export function sourceTitle(descriptor: MediaDescriptor): string {
  const platform = descriptor.platform ? PLATFORM_LABEL[descriptor.platform] : ''
  if (descriptor.platform === 'direct' && descriptor.customLabel) {
    return descriptor.label
  }
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
  loadInput: (role: SourceRole, input: string, platform?: RoomPlatform, direct?: DirectStreamOptions) => Promise<boolean>
  loadDescriptor: (role: SourceRole, descriptor: MediaDescriptor) => Promise<boolean>
  clearProblem: (role: SourceRole) => void
  /** Sign in for `state[role].login`, then load the same input again. */
  login: (role: SourceRole) => Promise<void>
  /** The danmaku room as the viewer knows it, while one is connected. */
  roomName: string | null
  connectRoom: (room: string, name?: string) => void
  disconnectRoom: () => void
}

const LoaderContext = createContext<Loader | null>(null)

export function SourceLoaderProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const session = useSession()
  const [state, setState] = useState<Record<SourceRole, RoleLoad>>({ official: IDLE, commentary: IDLE })
  const snapshot = useSessionSnapshot()
  const [previousSources, setPreviousSources] = useState(loadLastSources)
  const previous = useRef(previousSources)
  const [restoring, setRestoring] = useState(false)
  const restoringRef = useRef(false)
  const [restoreProblem, setRestoreProblem] = useState<string | null>(null)
  const live = useRef(state)
  const loads = useRef<Partial<Record<SourceRole, object>>>({})
  // What each side last asked for, so a login can retry it as typed.
  const asked = useRef<Partial<Record<SourceRole, { input: string; platform?: RoomPlatform; direct?: DirectStreamOptions }>>>({})
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

  const connectRoom = useCallback((next: string, name?: string) => { session.connectDanmaku(next, 'manual', name) }, [session])
  const disconnectRoom = useCallback(() => { session.disconnectDanmaku() }, [session])

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
    try {
      const loading = session.loadSource(role, descriptor)
      const generation = session.sourceRevision(role)
      await loading
      if (!await finishAttachment(role, generation, request) || generation !== session.sourceRevision(role) || loads.current[role] !== request) return false
      return true
    } catch (error) {
      if (loads.current[role] === request) patch(role, { problem: displayError(error, '片源载入失败，请重试') })
      return false
    } finally { if (loads.current[role] === request) patch(role, { busy: false }) }
  }, [finishAttachment, patch, session])

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

  const loadInput = useCallback(async (role: SourceRole, input: string, platform?: RoomPlatform, rawDirect?: DirectStreamOptions): Promise<boolean> => {
    const validatedDirect = validateDirectOptions(rawDirect)
    if (validatedDirect === null) {
      patch(role, { problem: { message: '直链名称或请求头格式无效，请检查后重试' }, login: null })
      return false
    }
    const typed = parseRoomInput(input)
    const roomPlatform = typed?.platform ?? platform
    const roomInput = typed && roomPlatform === 'douyin' ? `https://live.douyin.com/${typed.room}`
      : typed && roomPlatform === 'huya' ? `https://www.huya.com/${typed.room}` : typed ? typed.room : input
    let parsed = parseSourceInput(roomInput)
    if (!parsed.ok) { patch(role, { problem: { message: parsed.message }, login: null }); return false }
    const direct = parsed.platform === 'direct' ? validatedDirect : undefined
    asked.current[role] = { input, platform, ...(direct ? { direct } : {}) }
    if (typed && roomPlatform === 'bilibili') {
      parsed = { ...parsed, platform: 'bilibili', label: `${PLATFORM_LABEL.bilibili} ${typed.room}` }
    }
    if (!parsed.needsResolve) {
      const base = toDescriptor(parsed)
      return loadDescriptor(role, direct?.label ? { ...base, label: direct.label, customLabel: true } : base)
    }

    const request = {}
    loads.current[role] = request
    patch(role, { busy: true, problem: null, notes: [], login: null })
    let generation = session.beginSourceChange(role)
    const platformOf = parsed.platform
    try {
      const result = await apiClient.resolve(
        parsed.url, parsed.platform, role, undefined,
        session.settings.preferAdaptive || undefined,
        ...(hasDirectOptions(direct) ? [direct] : []),
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
        if (platformOf === 'youtube' && failure.reason === 'cookies-invalidated') {
          void refreshLoginStatus().then(() => notifyLoginStateChanged(['youtube'], 'logout'))
        }
        // Only an explicit authentication refusal offers Bilibili/Huya sign-in.
        const signInCanHelp = SIGN_IN_REFUSALS.has(failure.reason ?? '') || (!failure.reason && (platformOf === 'douyu' || platformOf === 'youtube' || platformOf === 'twitch'))
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
            { ...parsed, platform: stream.platform, kind: stream.kind, label: stream.label },
          { url: stream.url, viaProxy: stream.requiresProxy },
        ),
        input: webRoom ? `https://live.douyin.com/${webRoom}` : input.trim(),
        sourceQualities: stream.qualities,
        sourceQuality: stream.quality,
        sourceRoom: stream.sourceRoom ?? stream.danmakuRoom,
        sourceChannel: stream.channel,
        danmakuRoom: stream.danmakuRoom,
        ...(stream.platform === 'direct' && direct?.headers ? { directHeaders: direct.headers } : {}),
        ...(stream.platform === 'direct' && direct?.label ? { customLabel: true } : {}),
      }
      const loading = session.loadSource(role, descriptor)
      generation = session.sourceRevision(role)
      await loading
      // Removal and a newer source both invalidate any room that accompanied this load.
      if (!await finishAttachment(role, generation, request) || generation !== session.sourceRevision(role) || loads.current[role] !== request) return false
      return true
    } catch (error) {
      if (generation === session.sourceRevision(role) && loads.current[role] === request) patch(role, { problem: displayError(error, '片源载入失败，请重试') })
      return false
    } finally {
      session.endSourceChange(role, generation)
      if (loads.current[role] === request) patch(role, { busy: false })
    }
  }, [finishAttachment, loadDescriptor, offerLogin, patch, session])

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
      void refreshLoginStatus()
    } catch (error) {
      if (stillCurrent()) patch(role, { problem: displayError(error, '登录暂时失败，请重试') })
      return
    } finally { patch(role, { loggingIn: false }) }
    if (again && stillCurrent()) await loadInput(role, again.input, again.platform, ...(again.direct ? [again.direct] : []))
  }, [loadInput, patch, session])

  useEffect(() => {
    let active = true
    let queued = false
    let pendingPlatforms: Set<LoginPlatform> | 'all' | null = null
    const flush = async (): Promise<void> => {
      const scope = pendingPlatforms
      pendingPlatforms = null
      queued = false
      if (!active || !scope) return
      const candidates = SOURCE_ROLES.flatMap((role) => {
        const currentLoad = live.current[role]
        const platform = currentLoad.login
        if (!platform || currentLoad.busy || currentLoad.loggingIn) return []
        if (scope !== 'all' && !scope.has(platform)) return []
        return [{ role, platform, generation: session.sourceRevision(role), again: asked.current[role] }]
      })
      if (!candidates.length) return
      const status = await apiClient.loginStatus().catch(() => null)
      if (!active || !status?.ok) return
      for (const { role, platform, generation, again } of candidates) {
        if (!status.value?.[platform]?.loggedIn) continue
        if (generation !== session.sourceRevision(role) || asked.current[role] !== again) continue
        const currentLoad = live.current[role]
        if (currentLoad.login !== platform || currentLoad.busy || currentLoad.loggingIn) continue
        if (currentLoad.problem && again) void loadInput(role, again.input, again.platform, ...(again.direct ? [again.direct] : []))
        else patch(role, { login: null, signedIn: true })
      }
    }
    return subscribeLoginStateChanged(({ platforms, action }) => {
      if (action === 'logout') return
      if (!platforms) pendingPlatforms = 'all'
      else if (pendingPlatforms !== 'all') {
        pendingPlatforms ??= new Set()
        for (const platform of platforms) pendingPlatforms.add(platform)
      }
      if (!queued) {
        queued = true
        queueMicrotask(() => { void flush() })
      }
    })
  }, [loadInput, patch, session])

  const clearProblem = useCallback((role: SourceRole) => patch(role, { problem: null }), [patch])

  const roomName = snapshot.danmaku.roomName ?? snapshot.danmaku.room
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
        const directOptions = source.platform === 'direct' && source.customLabel && source.label
          ? { label: source.label }
          : undefined
        try {
          return await loadInput(role, source.input, platform, ...(directOptions ? [directOptions] : []))
            && session.snapshot.media[role].status !== 'error' ? null : role
        }
        catch { patch(role, { busy: false, problem: { message: '载入失败，请检查网络后重试' } }); return role }
      }))
      const messages = failures.filter((role): role is SourceRole => role !== null)
        .map(role => `${ROLE_LABEL[role]}：${live.current[role].problem?.message ?? session.snapshot.media[role].error?.message ?? '恢复未完成，请检查片源后重试'}`)
      if (messages.length) setRestoreProblem(messages.join('；'))
      return messages.length === 0
    } finally { restoringRef.current = false; setRestoring(false) }
  }, [loadInput, patch, session])

  const value = useMemo(() => ({ state, previousSources, restoring, restoreProblem, restorePrevious, loadInput, loadDescriptor, clearProblem, login, roomName, connectRoom, disconnectRoom }),
    [state, previousSources, restoring, restoreProblem, restorePrevious, loadInput, loadDescriptor, clearProblem, login, roomName, connectRoom, disconnectRoom])
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

