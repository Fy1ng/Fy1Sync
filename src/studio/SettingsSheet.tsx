import { ErrorText, useErrorState } from '../ui/ErrorDetails'
import { displayError } from '../core/errorDetails'
/**
 * 设置: everything that is not watching, in one window. Sections run across the top; each
 * keeps its own pages down the left. Nothing here is needed to start watching.
 *
 * Frame matching regions are configured in place while both streams stay loaded.
 */

import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { createFeedbackReport } from '../app/diagnosticReport'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { DecoderPreferenceState } from '../../electron/decoderPreferences'
import type { NetworkPreferenceState } from '../../electron/networkPreferences'
import { DEFAULT_MEDIA_NETWORK, validMediaNetwork, validMediaSourceRule, type MediaNetworkOptions, type MediaSourceRule } from '../../server/mediaNetworkOptions'
import type { LoginPlatform, LoginStatus } from '../../electron/login'
import type { ToolsStatus } from '../../electron/toolsService'
import { DOUYIN_LOGIN_CHANGED_EVENT, type DouyinSendState } from '../core/douyinMessage'
import { subscribeLoginStateChanged } from '../core/loginEvents'
import { AppUpdateSettings } from './about/AppUpdate'
import { CaptureSettings } from './capture/Capture'
import { DouyuDesk } from './douyu/DouyuDesk'
import { RoomInsights } from './insights/RoomInsights'
import { PlatformRoomInsights } from './insights/PlatformRoomInsights'
import { DanmakuRecords, type RecordsTab } from './records/DanmakuRecords'
import { Segmented, Sheet, SideTabs, Switch } from './kit'
import { PipSettings } from './pip/PipSettings'
import { remember, useRemembered } from '../app/remembered'
import { FrameHashSettings } from './FrameHashSettings'
import { isReadOnlyDanmakuRoom } from '../../server/danmaku/types'
import { PlatformAccount } from './login/PlatformAccount'
import { refreshLoginStatus } from './login/status'
import { AccountAvatar, BrowserImportButton, BrowserLoginImportProvider } from './login/BrowserLoginImport'
import { ReadError } from './ReadError'
import { InlineConfirm } from './InlineConfirm'
import { ShortcutSettings } from './ShortcutSettings'

export type SettingsSection = 'accounts' | 'records' | 'insights' | 'frame-matching' | 'general'
export type GeneralPage = 'align' | 'shortcuts' | 'network' | 'decoding' | 'pip' | 'capture' | 'tools' | 'about'

/** Where 设置 opens, and for 弹幕记录 which page and user. */
export interface SettingsTarget { section: SettingsSection; general?: GeneralPage; account?: LoginPlatform; records?: { tab: RecordsTab; uid?: string } }

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'general', label: '通用' },
  { id: 'accounts', label: '账号' },
  { id: 'records', label: '弹幕记录' },
  { id: 'insights', label: '房间数据' },
  { id: 'frame-matching', label: '画面匹配' },
]

export function SettingsSheet({ target, room, onClose, onWatch, onFill }: {
  target: SettingsTarget
  /** The connected danmaku room; 房间数据 and 弹幕记录 are about it. */
  room: string | null
  onClose: () => void
  onWatch: (room: string) => void
  onFill: (text: string) => void
}): React.ReactNode {
  const [section, setSection] = useState<SettingsSection>(target.section)
  const networkDraft = useRef<NetworkDraftStatus | null>(null)
  const [leave, setLeave] = useState<(() => void) | null>(null)
  const requestLeave = (action: () => void): void => {
    if (networkDraft.current?.dirty || networkDraft.current?.pending) setLeave(() => action)
    else { setLeave(null); action() }
  }
  const close = (): void => requestLeave(onClose)
  const huya = isReadOnlyDanmakuRoom(room)
  useEffect(() => { if (target.section !== section) requestLeave(() => setSection(target.section)) }, [target])
  useEffect(() => { remember('settings:section', section) }, [section])
  return (
    <Sheet title="设置" onClose={close} wide>
      <SettingsCloseGuard onClose={close}>
        <nav className="settings-tabs" role="tablist" aria-label="设置分区">
          {SECTIONS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={section === item.id}
              className={section === item.id ? 'is-on' : undefined} onClick={() => { if (item.id !== section) requestLeave(() => setSection(item.id)) }}>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="settings-body" role="tabpanel" aria-label={SECTIONS.find((item) => item.id === section)?.label}>
          {section === 'general' && <General target={target} networkDraft={networkDraft} requestLeave={requestLeave} leave={leave} onContinue={() => setLeave(null)} />}
          {section === 'accounts' && <AccountSettings target={target} onWatch={(next) => { onWatch(next); onClose() }} />}
          {huya && section === 'records' && <p className="settings-empty">弹幕记录仅支持斗鱼</p>}
          {section === 'records' && !huya && (
            <DanmakuRecords initialTab={target.records?.tab ?? 'history'} initialUid={target.records?.uid} room={room}
              onFill={(text) => { onFill(text); onClose() }} />
          )}
          {section === 'insights' && <>
            {room && !huya && <RoomInsights room={room} />}
            <PlatformRoomInsights room={room} />
          </>}
          {section === 'frame-matching' && <div className="settings-page">
            <FrameHashSettings />
          </div>}
        </div>
      </SettingsCloseGuard>
    </Sheet>
  )
}

function SettingsCloseGuard({ onClose, children }: { onClose: () => void; children: React.ReactNode }): React.ReactNode {
  const root = useRef<HTMLDivElement | null>(null)
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    const dialog = root.current?.closest('dialog')
    if (!dialog) return
    const cancel = (event: Event): void => {
      if (event.target !== dialog) return
      event.preventDefault()
      latest.current()
    }
    dialog.addEventListener('cancel', cancel)
    return () => dialog.removeEventListener('cancel', cancel)
  }, [])
  return <div className="settings" ref={root}>{children}</div>
}

const ACCOUNT_PLATFORMS: { id: LoginPlatform; label: string }[] = [
  { id: 'douyu', label: '斗鱼' },
  { id: 'bilibili', label: '哔哩哔哩' },
  { id: 'huya', label: '虎牙' },
  { id: 'douyin', label: '抖音' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'twitch', label: 'Twitch' },
]

function AccountSettings({ target, onWatch }: { target: SettingsTarget; onWatch: (room: string) => void }): React.ReactNode {
  return <BrowserLoginImportProvider><AccountPages target={target} onWatch={onWatch} /></BrowserLoginImportProvider>
}
function AccountPages({ target, onWatch }: { target: SettingsTarget; onWatch: (room: string) => void }): React.ReactNode {
  const [saved, setPlatform] = useRemembered<LoginPlatform>('settings:account-platform', target.account ?? 'douyu')
  const platform = ACCOUNT_PLATFORMS.some(item => item.id === saved) ? saved : 'douyu'
  useEffect(() => { if (target.account) setPlatform(target.account) }, [target, setPlatform])
  const navigation = { label: '账号平台', tabs: ACCOUNT_PLATFORMS, value: platform, onChange: setPlatform }
  const aside = <BrowserImportButton batch />
  if (platform === 'douyu') return <DouyuDesk onWatch={onWatch} platformNavigation={navigation} accountAside={aside} />
  return <SideTabs {...navigation} aside={aside}>
    <div className="settings-page">
      {platform === 'youtube' ? <YouTubeAccount /> : platform === 'twitch' ? <TwitchAccount /> : platform === 'douyin' ? <DouyinAccount /> : <PlatformAccount key={platform} platform={platform} />}
    </div>
  </SideTabs>
}

const GENERAL: { id: GeneralPage; label: string }[] = [
  { id: 'align', label: '对齐' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'network', label: '网络' },
  { id: 'decoding', label: '解码' },
  { id: 'pip', label: '画中画' },
  { id: 'capture', label: '截图与 GIF' },
  { id: 'tools', label: '取流工具' },
  { id: 'about', label: '关于' },
]

interface NetworkDraftStatus { dirty: boolean; pending: boolean }
interface NetworkNavigation {
  target: SettingsTarget
  networkDraft: React.RefObject<NetworkDraftStatus | null>
  requestLeave: (action: () => void) => void
  leave: (() => void) | null
  onContinue: () => void
}

function General({ target, networkDraft, requestLeave, leave, onContinue }: NetworkNavigation): React.ReactNode {
  const [saved, setPage] = useRemembered<GeneralPage>('settings:general', target.general ?? 'align')
  const page = GENERAL.some(item => item.id === saved) ? saved : 'align'
  useEffect(() => { if (target.general) setPage(target.general) }, [target, setPage])
  return (
    <SideTabs label="通用" value={page} onChange={next => { if (next !== page) requestLeave(() => setPage(next)) }} tabs={GENERAL}>
      <div className="settings-page">
        {page === 'align' && <AlignPrefs />}
        {page === 'shortcuts' && <ShortcutSettings />}
        {page === 'network' && <Network networkDraft={networkDraft} leave={leave} onContinue={onContinue} />}
        {page === 'decoding' && <Decoding />}
        {page === 'pip' && <Group title="画中画"><PipSettings /></Group>}
        {page === 'capture' && <Group title="截图与 GIF"><CaptureSettings /></Group>}
        {page === 'tools' && <Tools />}
        {page === 'about' && <Group title="关于"><AppUpdateSettings /></Group>}
      </div>
    </SideTabs>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }): React.ReactNode {
  return (
    <section className="group" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function useMounted(): React.RefObject<boolean> {
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  return mounted
}

function YouTubeAccount(): React.ReactNode {
  const session = useSession()
  const { settings } = useSessionSnapshot()
  const mounted = useMounted()
  // Shown from the last read at once; the read on open only brings it up to date.
  const [status, setStatus] = useRemembered<LoginStatus | null>('login-status', null)
  const [checking, setChecking] = useState(() => status === null)
  const [loadError, setLoadError, loadErrorDetail] = useErrorState()
  const readRevision = useRef(0)
  const pending = useRef(false)
  const previousStatus = useRef(status)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError, errorDetail] = useErrorState()
  const refresh = async (): Promise<void> => {
    const started = ++readRevision.current
    if (mounted.current) { setChecking(true); setLoadError('') }
    let failed = false
    const next = await refreshLoginStatus((message, detail) => {
      failed = true
      if (mounted.current && started === readRevision.current) setLoadError({ message, detail })
    })
    if (!mounted.current || started !== readRevision.current) return
    if (next?.youtube) { setStatus(next); setLoadError('') }
    else if (!failed) setLoadError('账号状态读取失败，请重试')
    setChecking(false)
  }
  useEffect(() => {
    if (status !== previousStatus.current) {
      previousStatus.current = status
      if (status?.youtube) { setLoadError(''); setChecking(false) }
    }
  }, [status, setLoadError])
  useEffect(() => {
    void refresh()
    let refreshQueued = false
    const scheduleRefresh = (): void => {
      if (pending.current || refreshQueued) return
      refreshQueued = true
      queueMicrotask(() => {
        refreshQueued = false
        if (!mounted.current || pending.current) return
        setError('')
        setMessage('')
        void refresh()
      })
    }
    return subscribeLoginStateChanged(({ platforms }) => {
      if (!platforms || platforms.includes('youtube')) scheduleRefresh()
    })
  }, [])

  const act = async (logout: boolean): Promise<void> => {
    if (pending.current || busy) return
    pending.current = true
    setBusy(true)
    setError('')
    setMessage(logout ? '' : '请在弹出的浏览器窗口中登录，完成后关闭该窗口')
    try {
      const result = logout ? await apiClient.logout('youtube') : await apiClient.login('youtube')
      if (mounted.current) {
        if (result.ok || result.code === 'login-cancelled') setMessage(result.ok ? (logout ? '已退出' : '已登录，重新载入画面后生效') : '已取消登录')
        else { setMessage(''); setError(result) }
      }
      await refresh()
    } catch (error) {
      if (mounted.current) { setMessage(''); setError(displayError(error, '账号操作失败，请重试')) }
    } finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const youtube = status?.youtube

  return (
    <Group title="YouTube">
      <div className="row-split">
        <span className="account-identity">
          {youtube?.nickname && <><AccountAvatar username={youtube.nickname} avatar={youtube.avatar} /><b>{youtube.nickname}</b></>}
          {loadError ? '登录状态读取失败' : status === null ? '正在检查登录状态' : youtube?.loggedIn ? '已登录' : '未登录'}
          {youtube?.loggedIn && youtube.expiresAt ? <span className="muted">，{new Date(youtube.expiresAt * 1000).toLocaleDateString('zh-CN')} 到期</span> : null}
        </span>
        <span className="row-end">
          <BrowserImportButton platform="youtube" disabled={busy} />
          {youtube?.cookieCount ? <InlineConfirm label="退出" confirmLabel="确认退出" disabled={busy} danger={false} onConfirm={() => act(true)} /> : null}
          <button type="button" className="btn-solid small" disabled={busy || checking || status === null} onClick={() => void act(false)}>{youtube?.loggedIn ? '重新登录' : '登录'}</button>
        </span>
      </div>
      <p className="muted">观看会员直播或提示需要验证时，请登录 YouTube（支持系统 Chrome、Edge 或 Firefox 独立窗口）</p>
      {message && <p className="muted" role="status">{message}</p>}
      {loadError && <ReadError error={loadError} detail={loadErrorDetail} onRetry={() => void refresh()} />}
      {error && <p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>}
      <Switch label="自动使用最高画质" detail="网络较慢时可关闭"
        checked={settings.preferAdaptive} onChange={(preferAdaptive) => session.updateSettings({ preferAdaptive })} />
    </Group>
  )
}

function TwitchAccount(): React.ReactNode {
  const mounted = useMounted()
  const [status, setStatus] = useRemembered<LoginStatus | null>('login-status', null)
  const [checking, setChecking] = useState(() => status === null)
  const [loadError, setLoadError, loadErrorDetail] = useErrorState()
  const readRevision = useRef(0)
  const pending = useRef(false)
  const previousStatus = useRef(status)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError, errorDetail] = useErrorState()
  const refresh = async (): Promise<void> => {
    const started = ++readRevision.current
    if (mounted.current) { setChecking(true); setLoadError('') }
    let failed = false
    const next = await refreshLoginStatus((message, detail) => {
      failed = true
      if (mounted.current && started === readRevision.current) setLoadError({ message, detail })
    })
    if (!mounted.current || started !== readRevision.current) return
    if (next?.twitch) { setStatus(next); setLoadError('') }
    else if (!failed) setLoadError('账号状态读取失败，请重试')
    setChecking(false)
  }
  useEffect(() => {
    if (status !== previousStatus.current) {
      previousStatus.current = status
      if (status?.twitch) { setLoadError(''); setChecking(false) }
    }
  }, [status, setLoadError])
  useEffect(() => {
    void refresh()
    let refreshQueued = false
    const scheduleRefresh = (): void => {
      if (pending.current || refreshQueued) return
      refreshQueued = true
      queueMicrotask(() => {
        refreshQueued = false
        if (!mounted.current || pending.current) return
        setError('')
        setMessage('')
        void refresh()
      })
    }
    return subscribeLoginStateChanged(({ platforms }) => {
      if (!platforms || platforms.includes('twitch')) scheduleRefresh()
    })
  }, [])

  const act = async (logout: boolean): Promise<void> => {
    if (pending.current || busy) return
    pending.current = true
    setBusy(true)
    setError('')
    setMessage(logout ? '' : '请在弹出的浏览器窗口中登录，完成后关闭该窗口')
    try {
      const result = logout ? await apiClient.logout('twitch') : await apiClient.login('twitch')
      if (mounted.current) {
        if (result.ok || result.code === 'login-cancelled') setMessage(result.ok ? (logout ? '已退出' : '已登录，重新载入画面后生效') : '已取消登录')
        else { setMessage(''); setError(result) }
      }
      await refresh()
    } catch (error) {
      if (mounted.current) { setMessage(''); setError(displayError(error, '账号操作失败，请重试')) }
    } finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const twitch = status?.twitch

  return (
    <Group title="Twitch">
      <div className="row-split">
        <span className="account-identity">
          {twitch?.nickname && <><AccountAvatar username={twitch.nickname} avatar={twitch.avatar} /><b>{twitch.nickname}</b></>}
          {loadError ? '登录状态读取失败' : status === null ? '正在检查登录状态' : twitch?.loggedIn ? '已登录' : '未登录'}
          {twitch?.expiresAt ? <span className="muted">，{new Date(twitch.expiresAt * 1000).toLocaleDateString('zh-CN')} 到期</span> : null}
        </span>
        <span className="row-end">
          <BrowserImportButton platform="twitch" disabled={busy} />
          {twitch?.cookieCount ? <InlineConfirm label="退出" confirmLabel="确认退出" disabled={busy} danger={false} onConfirm={() => act(true)} /> : null}
          <button type="button" className="btn-solid small" disabled={busy || checking || status === null} onClick={() => void act(false)}>{twitch?.loggedIn ? '重新登录' : '登录'}</button>
        </span>
      </div>
      <p className="muted">获取 1440P 及以上画质直播流时，请登录或从浏览器导入 Twitch 账号（支持 Chrome、Edge、Firefox）</p>
      {message && <p className="muted" role="status">{message}</p>}
      {loadError && <ReadError error={loadError} detail={loadErrorDetail} onRetry={() => void refresh()} />}
      {error && <p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>}
    </Group>
  )
}

function DouyinAccount(): React.ReactNode {
  const mounted = useMounted()
  const [status, setStatus] = useRemembered<LoginStatus | null>('login-status', null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError, errorDetail] = useErrorState()
  const [online,setOnline] = useState<DouyinSendState|null>(null)
  const pending = useRef(false)
  const readRevision = useRef(0)
  /** Resolves with the verified send state, or null when it could not be read. */
  const refresh = async (force = false): Promise<DouyinSendState | null> => {
    const started = ++readRevision.current
    setChecking(true)
    try {
      const result = await apiClient.loginStatus()
      if (!mounted.current || started !== readRevision.current) return null
      if (result.ok && result.value?.douyin) {
        setStatus(result.value); setError('')
        const verified=await apiClient.getDouyinSendState(force)
        if (!mounted.current || started !== readRevision.current) return null
        if (verified.ok && typeof verified.value?.loggedIn==='boolean' && typeof verified.value?.canSend==='boolean') {
          setOnline(verified.value)
          if (verified.value.loginState === 'unavailable') setError(displayError(verified.value, verified.value.message || '暂时无法确认抖音登录状态'))
          return verified.value
        } else {
          setOnline(null)
          setError(verified.ok ? displayError({ code: 'invalid-login-state' }, '暂时无法确认抖音登录状态') : verified)
        }
      }
      else setError(result.ok ? '暂时无法读取抖音登录状态' : result)
    } catch (error) {
      if (mounted.current && started === readRevision.current) setError(displayError(error, '抖音登录状态读取失败，请重试'))
    } finally { if (mounted.current && started === readRevision.current) setChecking(false) }
    return null
  }
  useEffect(() => {
    void refresh()
    let refreshQueued = false
    const scheduleRefresh = (): void => {
      if (pending.current || refreshQueued) return
      refreshQueued = true
      queueMicrotask(() => {
        refreshQueued = false
        if (!mounted.current || pending.current) return
        setError('')
        setMessage('')
        void refresh(true)
      })
    }
    window.addEventListener(DOUYIN_LOGIN_CHANGED_EVENT, scheduleRefresh)
    const releaseLogin = subscribeLoginStateChanged(({ platforms }) => {
      if (!platforms || platforms.includes('douyin')) scheduleRefresh()
    })
    return () => {
      window.removeEventListener(DOUYIN_LOGIN_CHANGED_EVENT, scheduleRefresh)
      releaseLogin()
    }
  }, [])
  const act = async (logout: boolean): Promise<void> => {
    if (pending.current || busy) return
    pending.current = true
    setBusy(true)
    setError('')
    setMessage(logout ? '' : '正在登录抖音')
    try {
      const result = logout ? await apiClient.logout('douyin') : await apiClient.login('douyin')
      if (!mounted.current) return
      if (!result.ok) { setMessage(''); if (result.code !== 'login-cancelled') setError(result); return }
      if (logout) setOnline({ loggedIn: false, canSend: false, loginState: 'signed-out', message: '已退出抖音' })
      if (logout && status) setStatus({ ...status, douyin: { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false } })
      const signing=result.value as {signingReady?:boolean;signingProblem?:string}
      setMessage(logout ? '已退出抖音' : signing.signingReady===false
        ? '已登录，但暂时不能发送弹幕，请重新登录' : '已登录，正在检查能否发送弹幕')
      if (!logout && typeof signing.signingProblem==='string') setError({code:signing.signingProblem,message:'未能开启抖音弹幕发送'})
      const verified = await refresh(!logout)
      // The "checking" line describes work in progress; replace it with what the check found.
      if (!logout && mounted.current) setMessage(verified?.loggedIn !== true ? ''
        : verified.canSend ? '已登录，可以发送弹幕' : '已登录，但暂时不能发送弹幕，请重新登录')
    } catch (error) {
      if (mounted.current) { setMessage(''); setError(displayError(error, '抖音账号操作失败，请重试')) }
    } finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const douyin = status?.douyin
  const loggedIn=online?.loggedIn === true
  const label=checking ? '正在检查登录状态' : !online ? '登录状态暂时无法确认' : online.loginState==='expired' ? '登录已失效' : online.loginState==='unavailable' ? '登录状态暂时无法确认' : online.loginState==='authenticating' ? '正在登录' : loggedIn ? online.canSend ? '已登录' : '已登录，暂不能发弹幕' : '未登录'
  return (
    <Group title="抖音">
      <div className="row-split">
        <span className="account-identity">{douyin?.nickname && <><AccountAvatar username={douyin.nickname} avatar={douyin.avatar} /><b>{douyin.nickname}</b></>}
          {checking && !douyin ? '正在检查登录状态' : !douyin ? '登录状态未知' : label}
          {loggedIn && douyin?.expiresAt ? <span className="muted">，{new Date(douyin.expiresAt * 1000).toLocaleDateString('zh-CN')} 到期</span> : null}
        </span>
        <span className="row-end">
          <BrowserImportButton platform="douyin" disabled={busy} />
          {douyin?.cookieCount ? <InlineConfirm label="退出" confirmLabel="确认退出" disabled={busy || checking} danger={false} onConfirm={() => act(true)} /> : null}
          <button type="button" className="btn-solid small" disabled={busy || checking} onClick={() => void act(false)}>{douyin?.loggedIn || douyin?.authKeysPresent?.length ? '重新登录' : '登录'}</button>
        </span>
      </div>
      <p className="muted">退出或重新登录会清除原有的弹幕发送授权</p>
      {message && <p className="muted" role="status">{message}</p>}
      {error && <><p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>
        <button type="button" className="btn-quiet small" disabled={busy || checking} onClick={() => void refresh(true)}>重新检查登录状态</button></>}
    </Group>
  )
}

function AlignPrefs(): React.ReactNode {
  const session = useSession()
  const { settings } = useSessionSnapshot()
  return (
    <Group title="对齐">
      <div className="field-stack">
        <span className="field-label">单击步长</span>
        <Segmented label="单击步长" value={settings.largeStepSeconds}
          onChange={(seconds) => session.updateSettings({ largeStepSeconds: Math.max(seconds, settings.smallStepSeconds) })}
          options={[2, 5, 10].map((value) => ({ value, label: `${value} 秒` }))} />
      </div>
      <div className="field-stack">
        <span className="field-label">按住 Shift 步长</span>
        <Segmented label="按住 Shift 步长" value={settings.smallStepSeconds}
          onChange={(seconds) => session.updateSettings({ smallStepSeconds: seconds, largeStepSeconds: Math.max(seconds, settings.largeStepSeconds) })}
          options={[0.1, 0.25, 0.5, 1].map((value) => ({ value, label: `${value} 秒` }))} />
      </div>
      <div className="field-stack">
        <span className="field-label">保持对齐的跳转门槛</span>
        <Segmented label="保持对齐的跳转门槛" value={settings.seekThresholdSeconds} onChange={(seconds) => session.setSeekThreshold(seconds)}
          options={[1, 1.5, 2].map((value) => ({ value, label: `${value} 秒` }))} />
        <p className="muted">定时对齐时，偏差小于此值会变速，不直接跳转</p>
      </div>
    </Group>
  )
}

const modeName = (mode: DecoderPreferenceState['mode']): string => mode === 'software' ? '软件解码' : '硬件解码'

/** What the system proxy is, in the words a proxy app uses. */
const PROXY_NAME: Record<NetworkPreferenceState['systemProxy']['type'], string> = {
  direct: '未设置，直接连接', HTTP: 'HTTP 代理', SOCKS: 'SOCKS 代理', PAC: '自动配置脚本（PAC）',
}

interface SourceRuleDraft { origin: string; headers: string; verifyTls: boolean; verifyProxyTls: boolean }
const EMPTY_SOURCE_DRAFT: SourceRuleDraft = { origin: '', headers: '', verifyTls: true, verifyProxyTls: true }
const SOURCE_PROBLEM = '请输入有效的 HTTP/HTTPS 来源，请求头每行使用「名称: 值」，名称不能重复'

function sourceDraftRule(editor: SourceRuleDraft): MediaSourceRule {
  const source = new URL(editor.origin.trim())
  if (source.protocol !== 'http:' && source.protocol !== 'https:') throw new Error('source')
  const pairs = editor.headers.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const colon = line.indexOf(':')
    if (colon < 1) throw new Error('header')
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as const
  })
  if (new Set(pairs.map(([name]) => name.toLowerCase())).size !== pairs.length) throw new Error('duplicate header')
  const rule = { origin: source.origin, headers: Object.fromEntries(pairs), verifyTls: editor.verifyTls, verifyProxyTls: editor.verifyProxyTls }
  if (!validMediaSourceRule(rule)) throw new Error('source')
  return rule
}

function withSourceRule(media: MediaNetworkOptions, rule: MediaSourceRule): MediaNetworkOptions {
  return { ...media, sourceRules: [...(media.sourceRules ?? []).filter(item => item.origin !== rule.origin), rule] }
}

function networkDraftKey(domesticRouting: NetworkPreferenceState['domesticRouting'], media: MediaNetworkOptions): string {
  return JSON.stringify({ domesticRouting, media: { ...DEFAULT_MEDIA_NETWORK, ...media,
    sourceRules: [...(media.sourceRules ?? [])].sort((first, second) => first.origin.localeCompare(second.origin)).map(rule => ({ ...rule,
      headers: Object.fromEntries(Object.entries(rule.headers).sort(([first], [second]) => first.localeCompare(second))),
    })),
  } })
}

function SourceNetworkRules({ rules, onChange, disabled, editor, onEdit, onAdd, problem, originInput }: {
  rules: MediaSourceRule[]; onChange: (rules: MediaSourceRule[]) => void; disabled: boolean
  editor: SourceRuleDraft; onEdit: (editor: SourceRuleDraft) => void; onAdd: () => void; problem: string
  originInput: React.RefObject<HTMLInputElement | null>
}): React.ReactNode {
  const change = <K extends keyof SourceRuleDraft>(key: K, value: SourceRuleDraft[K]): void => onEdit({ ...editor, [key]: value })
  return <div className="field-stack">
    <span className="field-label">按来源配置</span>
    <p className="muted">请求头仅发往此来源（协议、域名和端口），点击保存时一并保存编辑框内容</p>
    {rules.map(rule => <div className="row-split" key={rule.origin}>
      <span title={rule.origin} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rule.origin}（{Object.keys(rule.headers).length} 个请求头）</span>
      <span className="row-end" style={{ flexShrink: 0 }}>
        <button className="btn-quiet small" type="button" aria-label={`编辑来源 ${rule.origin}`} disabled={disabled} onClick={() => {
          onEdit({ origin: rule.origin, headers: Object.entries(rule.headers).map(([name, value]) => `${name}: ${value}`).join('\n'),
            verifyTls: rule.verifyTls, verifyProxyTls: rule.verifyProxyTls })
        }}>编辑</button>
        <button className="btn-quiet small" type="button" aria-label={`移除来源 ${rule.origin}`} disabled={disabled} onClick={() => {
          onChange(rules.filter(item => item.origin !== rule.origin))
          if (URL.parse(editor.origin.trim())?.origin === rule.origin) onEdit({ ...EMPTY_SOURCE_DRAFT })
        }}>移除</button>
      </span>
    </div>)}
    <label className="field-stack"><span>来源地址</span><input className="text-input" ref={originInput} value={editor.origin} disabled={disabled}
      aria-invalid={!!problem} placeholder="https://example.com:8443" onChange={event => change('origin', event.target.value)} /></label>
    <label className="field-stack"><span>来源请求头</span><textarea className="text-input" value={editor.headers} disabled={disabled} rows={4}
      aria-invalid={!!problem} placeholder={'Referer: https://example.com/\nUser-Agent: MyPlayer'} onChange={event => change('headers', event.target.value)} spellCheck={false} /></label>
    <Switch label="校验该来源服务器证书" checked={editor.verifyTls} disabled={disabled} onChange={value => change('verifyTls', value)} />
    <Switch label="校验该来源 HTTPS 代理证书" checked={editor.verifyProxyTls} disabled={disabled} onChange={value => change('verifyProxyTls', value)} />
    <p className="muted">此处的证书设置也适用于带登录信息的取流连接</p>
    <button className="btn-quiet small" type="button" disabled={disabled || !editor.origin.trim()} onClick={onAdd}>加入来源设置</button>
    {problem && <p className="form-error" role="alert">{problem}</p>}
  </div>
}

function Network({ networkDraft, leave, onContinue }: Pick<NetworkNavigation, 'networkDraft' | 'leave' | 'onContinue'>): React.ReactNode {
  const mounted = useMounted()
  const [state, setState] = useRemembered<NetworkPreferenceState | null>('network', null)
  const [pending, setPending] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError, errorDetail] = useErrorState()
  const [loadError, setLoadError, loadErrorDetail] = useErrorState()
  const [draft, setDraft] = useState<MediaNetworkOptions>(() => ({ ...DEFAULT_MEDIA_NETWORK, ...state?.media }))
  const [domesticRouting, setDomesticRouting] = useState<NetworkPreferenceState['domesticRouting']>(() => state?.domesticRouting ?? 'direct')
  const [editor, setEditor] = useState<SourceRuleDraft>({ ...EMPTY_SOURCE_DRAFT })
  const [sourceProblem, setSourceProblem] = useState('')
  const [message, setMessage] = useState('')
  const originInput = useRef<HTMLInputElement | null>(null)
  const saving = useRef(false)
  const hasSourceDraft = !!editor.origin.trim() || !!editor.headers.trim() || !editor.verifyTls || !editor.verifyProxyTls
  let candidate = draft
  let invalidSource = false
  if (hasSourceDraft) {
    try { candidate = withSourceRule(draft, sourceDraftRule(editor)) }
    catch { invalidSource = true }
  }
  const dirty = loaded && !!state && (invalidSource || networkDraftKey(domesticRouting, candidate) !== networkDraftKey(state.domesticRouting, { ...DEFAULT_MEDIA_NETWORK, ...state.media }))
  networkDraft.current = { dirty, pending: saving.current }
  useEffect(() => () => { networkDraft.current = null }, [networkDraft])
  const reset = (value: NetworkPreferenceState): void => {
    setDraft({ ...DEFAULT_MEDIA_NETWORK, ...value.media })
    setDomesticRouting(value.domesticRouting)
    setEditor({ ...EMPTY_SOURCE_DRAFT })
    setSourceProblem('')
    setError('')
  }
  const refresh = async (): Promise<void> => {
    setPending(true)
    setLoadError('')
    try {
      const result = await apiClient.getNetworkPreferences()
      if (!mounted.current) return
      if (result.ok) { setState(result.value); reset(result.value); setLoaded(true) }
      else setLoadError(result)
    } catch (caught) {
      if (mounted.current) setLoadError(displayError(caught, '网络设置读取失败，请重试'))
    } finally { if (mounted.current) setPending(false) }
  }
  useEffect(() => { void refresh() }, [])
  const proxy = state?.systemProxy
  const change = <K extends keyof MediaNetworkOptions>(key: K, value: MediaNetworkOptions[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value })); setMessage(''); setError('')
  }
  const addSource = (): void => {
    try {
      setDraft(withSourceRule(draft, sourceDraftRule(editor)))
      setEditor({ ...EMPTY_SOURCE_DRAFT }); setSourceProblem(''); setMessage(''); setError('')
    } catch { setSourceProblem(SOURCE_PROBLEM); originInput.current?.focus() }
  }
  const discard = (): void => { if (state) reset(state); setMessage('') }
  const saveMedia = async (): Promise<boolean> => {
    if (pending || !state || saving.current || !dirty) return false
    if (invalidSource) { setSourceProblem(SOURCE_PROBLEM); originInput.current?.focus(); return false }
    if (!validMediaNetwork({ ...DEFAULT_MEDIA_NETWORK, sourceRules: candidate.sourceRules })) {
      setSourceProblem('来源设置总大小超出限制，请减少请求头内容'); originInput.current?.focus(); return false
    }
    if (!validMediaNetwork(candidate)) { setError('请检查代理地址和网络参数'); return false }
    saving.current = true
    networkDraft.current = { dirty, pending: true }
    setPending(true)
    setError('')
    setSourceProblem('')
    setMessage('')
    try {
      const result = await apiClient.setNetworkPreferences(domesticRouting, candidate)
      if (!mounted.current) return false
      if (result.ok) { setState(result.value); reset(result.value); setMessage('网络设置已保存'); return true }
      else setError(result)
      return false
    } catch (caught) {
      if (mounted.current) setError(displayError(caught, '网络设置保存失败，请重试'))
      return false
    } finally { saving.current = false; if (mounted.current) setPending(false) }
  }
  const finishLeave = async (save: boolean): Promise<void> => {
    if (saving.current) return
    const action = leave
    const success = save ? !dirty || await saveMedia() : true
    if (!save) discard()
    onContinue()
    if (success) action?.()
  }
  return (
    <Group title="网络">
      {leave && <div className="writes-confirm" role="alertdialog" aria-label="未保存的网络设置">
        <p>{pending ? '正在保存网络设置' : dirty ? '网络设置有未保存改动' : '网络设置已保存'}</p>
        <div className="row-end">
          <button className="btn-solid small" type="button" disabled={pending} onClick={() => void finishLeave(true)}>保存</button>
          <button className="btn-quiet small" type="button" disabled={pending} onClick={() => void finishLeave(false)}>放弃</button>
          <button className="btn-quiet small" type="button" disabled={pending} onClick={() => { onContinue(); originInput.current?.focus() }} autoFocus>继续编辑</button>
        </div>
      </div>}
      <div className="row-split">
        <span>系统代理</span>
        <span className="muted">{loadError ? '读取失败' : !loaded ? '正在读取' : proxy ? PROXY_NAME[proxy.type] : '正在读取'}</span>
      </div>
      {proxy?.fallbackReason === 'socks4-unsupported' && (
        <p className="note-warn">不支持 SOCKS4，请改用 HTTP 或 SOCKS5 代理</p>
      )}
      {proxy?.fallbackReason === 'proxy-type-unsupported' && (
        <p className="note-warn">不支持当前系统代理，请改用 HTTP 或 SOCKS5 代理</p>
      )}
      {proxy?.fallbackReason === 'proxy-resolution-failed' && <p className="note-warn">无法读取系统代理，请检查系统代理设置</p>}
      <p className="muted">选择「按平台连接」时，YouTube 和 Twitch 使用系统代理</p>
      {loaded && state && <>
      <Switch label="国内平台直接连接" detail="适用于按平台连接，保存后下次载入直播间生效"
        checked={domesticRouting === 'direct'} disabled={pending} onChange={on => { setDomesticRouting(on ? 'direct' : 'system'); setMessage(''); setError('') }} />
      <form className="field-stack" onSubmit={event => { event.preventDefault(); void saveMedia() }}>
        <span className="field-label">取流网络</span>
        <p className="muted">保存后需重新载入片源</p>
        <label className="field-stack">
          <span>取流连接方式</span>
          <select value={draft.routing} disabled={pending || !state} onChange={event => change('routing', event.target.value as MediaNetworkOptions['routing'])}>
            <option value="platform">按平台连接</option><option value="system">全部使用系统代理</option>
            <option value="direct">全部直接连接</option><option value="custom">自定义代理</option>
          </select>
        </label>
        {draft.routing === 'custom' && <label className="field-stack">
          <span>取流代理地址</span>
          <input className="text-input" aria-label="取流代理地址" value={draft.proxyUrl} placeholder="http://127.0.0.1:7890" disabled={pending || !state}
            onChange={event => change('proxyUrl', event.target.value)} />
          <small>支持 HTTP、HTTPS 和 SOCKS5，可在地址中指定代理账号</small>
        </label>}
        <Switch label="代理连接失败后允许直连" checked={draft.fallbackDirect} disabled={pending || !state}
          onChange={value => change('fallbackDirect', value)} />
        <Switch label="校验取流服务器证书" checked={draft.verifyTls} disabled={pending || !state}
          onChange={value => change('verifyTls', value)} />
        <Switch label="校验 HTTPS 代理证书" checked={draft.verifyProxyTls} disabled={pending || !state}
          onChange={value => change('verifyProxyTls', value)} />
        <Switch label="允许媒体访问本机和局域网" checked={draft.allowPrivate} disabled={pending || !state}
          onChange={value => change('allowPrivate', value)} />
        <p className="muted">关闭校验会降低连接安全性。带登录信息的取流连接默认校验证书，可按来源修改。</p>
        {([
          ['maxRedirects', '重定向次数', 1], ['requestTimeoutMs', '请求超时秒数', 1000],
          ['startupTimeoutMs', '首次播放等待秒数', 1000], ['stallTimeoutMs', '断流等待秒数', 1000],
          ['reconnectAttempts', '失败重试次数', 1],
          ['maxExtraStreams', '同屏直播数量上限', 1],
        ] as const).map(([key, label, scale]) => <label className="field-stack" key={key}>
          <span>{label}</span><input className="text-input" type="number" min="0" max={key === 'maxExtraStreams' ? Number.MAX_SAFE_INTEGER : Math.floor(2_147_483_647 / scale)} step="1"
            value={(draft[key] ?? 0) / scale} disabled={pending || !state}
            onChange={event => change(key, (Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0) * scale)} />
        </label>)}
        <small>0 表示不限</small>
        <SourceNetworkRules rules={draft.sourceRules ?? []} disabled={pending} onChange={rules => change('sourceRules', rules)} editor={editor}
          onEdit={next => { setEditor(next); setSourceProblem(''); setMessage(''); setError('') }} onAdd={addSource} problem={sourceProblem} originInput={originInput} />
        <div className="row-end">
          <button type="button" className="btn-quiet small" disabled={pending || (!dirty && !hasSourceDraft)} onClick={discard}>放弃改动</button>
          <button type="submit" className="btn small" disabled={pending || !dirty}>保存取流网络设置</button>
        </div>
      </form>
      </>}
      {message && <p className="muted" role="status">{message}</p>}
      {loadError && <ReadError error={loadError} detail={loadErrorDetail} onRetry={() => void refresh()} />}
      {error && <p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>}
    </Group>
  )
}

function Decoding(): React.ReactNode {
  const mounted = useMounted()
  const [state, setState] = useRemembered<DecoderPreferenceState | null>('decoder', null)
  const [pending, setPending] = useState(() => state === null)
  const [error, setError, errorDetail] = useErrorState()
  const [loadError, setLoadError, loadErrorDetail] = useErrorState()
  const refresh = async (): Promise<void> => {
    setPending(true)
    setLoadError('')
    try {
      const result = await apiClient.getDecoderPreferences()
      if (!mounted.current) return
      if (result.ok) setState(result.value)
      else setLoadError(result)
    } catch (caught) {
      if (mounted.current) setLoadError(displayError(caught, '解码设置读取失败，请重试'))
    } finally { if (mounted.current) setPending(false) }
  }
  useEffect(() => { void refresh() }, [])
  const save = async (software: boolean): Promise<void> => {
    if (pending || !state) return
    setPending(true)
    setError('')
    try {
      const result = await apiClient.setDecoderPreferences(software ? 'software' : 'auto')
      if (!mounted.current) return
      if (result.ok) setState(result.value)
      else setError(result)
    } finally { if (mounted.current) setPending(false) }
  }
  return (
    <Group title="解码">
      {!state && !loadError && <p className="muted" role="status">正在读取解码设置</p>}
      <Switch label="软件解码" detail="画面出现花屏、绿屏或黑屏时启用，重启应用后生效"
        checked={state?.mode === 'software'} disabled={pending || !state} onChange={(on) => void save(on)} />
      {state?.restartRequired && <p className="note-warn">重启后改为{modeName(state.mode)}，当前仍是{modeName(state.effectiveMode)}</p>}
      {state?.forcedByCommandLine && <p className="muted">本次启动强制使用软件解码</p>}
      {loadError && <ReadError error={loadError} detail={loadErrorDetail} onRetry={() => void refresh()} />}
      {error && <p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>}
    </Group>
  )
}

const SOURCE_NAME = { external: '自定义', managed: '已更新', bundled: '内置', PATH: '系统' } as const

function formatToolBytes(bytes: number): string {
  if (bytes < 1_048_576) return `${Math.max(0, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

function formatToolSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`
  if (bytesPerSecond < 1_048_576) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSecond / 1_048_576).toFixed(2)} MB/s`
}

export function Tools(): React.ReactNode {
  const session = useSession()
  const { playbackDiagnostics } = useSessionSnapshot()
  const mounted = useMounted()
  const [status, setStatus] = useRemembered<ToolsStatus | null>('tools-status', null)
  const [action, setAction] = useState<'update' | 'restore' | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError, errorDetail] = useErrorState()
  const [loadError, setLoadError, loadErrorDetail] = useErrorState()
  const exportPending = useRef(false)
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState('')
  const [exportError, setExportError, exportErrorDetail] = useErrorState()
  const updating = action === 'update' || (!!status && ['checking', 'downloading', 'verifying'].includes(status.update.phase))
  const running = action !== null || updating
  const refresh = async (): Promise<void> => {
    setLoadError('')
    try {
      const result = await apiClient.getToolsStatus()
      if (!mounted.current) return
      if (result.ok && Array.isArray(result.value?.tools) && result.value.update) setStatus(result.value)
      else setLoadError(result.ok ? '取流工具状态读取失败，请重试' : result)
    } catch (caught) {
      if (mounted.current) setLoadError(displayError(caught, '取流工具状态读取失败，请重试'))
    }
  }
  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    if (!updating) return
    const timer = setInterval(() => {
      void refresh()
    }, 400)
    return () => clearInterval(timer)
  }, [updating, mounted])
  const act = async (target?: 'previous' | 'bundled'): Promise<void> => {
    if (running) return
    setAction(target ? 'restore' : 'update')
    setError('')
    try {
      const result = target ? await apiClient.restoreYtdlp(target) : await apiClient.updateYtdlp()
      if (!mounted.current) return
      if (result.ok) setStatus(result.value)
      else setError(result)
    } finally { if (mounted.current) setAction(null) }
  }
  const cancel = async (): Promise<void> => {
    if (!updating || cancelling) return
    setCancelling(true)
    setError('')
    try {
      const result = await apiClient.cancelYtdlpUpdate()
      if (!mounted.current) return
      if (result.ok) setStatus(result.value)
      else setError(result)
    } catch (caught) {
      if (mounted.current) setError(displayError(caught, '取消更新失败，请重试'))
    } finally { if (mounted.current) setCancelling(false) }
  }
  const update = status?.update
  const determinate = update?.phase === 'verifying' || (update?.phase === 'downloading' && update.totalBytes > 0)
  const percent = update?.phase === 'verifying'
    ? 100
    : update?.phase === 'downloading' && update.totalBytes > 0
      ? Math.min(100, Math.max(0, Math.floor(update.downloadedBytes * 100 / update.totalBytes)))
      : undefined
  const progressTitle = update?.phase === 'downloading'
    ? (update.downloadedVersion ? `正在下载 yt-dlp ${update.downloadedVersion}` : update.message || '正在下载…')
    : update?.phase === 'verifying' ? '正在校验 yt-dlp…' : update?.message || '正在检查更新…'
  const exportReport = async (): Promise<void> => {
    if (exportPending.current) return
    exportPending.current = true
    setExporting(true)
    setExportMessage('')
    setExportError('')
    let url: string | undefined
    try {
      const result = await apiClient.getAcquisitionDiagnostics()
      if (!mounted.current) return
      if (!result.ok) { setExportError(displayError(result, '诊断报告暂时无法生成，请重试')); return }
      const report = createFeedbackReport(result.value, session.exportPlaybackDiagnostics())
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
      url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'Fy1Sync-diagnostics.json'
      link.click()
      setExportMessage('诊断报告已导出')
    } catch (error) {
      if (mounted.current) setExportError(displayError(error, '诊断报告导出失败，请重试'))
    } finally {
      if (url) URL.revokeObjectURL(url)
      exportPending.current = false
      if (mounted.current) setExporting(false)
    }
  }
  return (
    <Group title="取流工具">
      {!status && !loadError && <p className="muted" role="status">正在读取取流工具状态</p>}
      {status?.tools.length === 0 && !loadError && <p className="muted">暂无取流工具</p>}
      <dl className="facts">
        {status?.tools.map((tool) => (
          <div key={tool.name}><dt>{tool.name}</dt><dd className="num">{tool.version}<span className="muted"> · {SOURCE_NAME[tool.source]}</span></dd></div>
        ))}
      </dl>
      {status?.tools.some((tool) => tool.name === 'ffmpeg' && tool.source !== 'bundled') && (
        <p className="note-warn">正在使用外部 ffmpeg，请确认它会校验 HTTPS 证书</p>
      )}
      <div className="row-end">
        <button type="button" className="btn-quiet small" disabled={running || !update?.previousVersion} onClick={() => void act('previous')}>恢复上一版本</button>
        <button type="button" className="btn-quiet small" disabled={running || !update?.activeVersion} onClick={() => void act('bundled')}>恢复内置版本</button>
        <button type="button" className="btn-solid small" disabled={running || !status} onClick={() => void act()}>更新 yt-dlp</button>
      </div>
      {updating ? (
        <div className="tool-update-card">
          <div className="tool-update-head">
            <span className="tool-update-title" role="status">{progressTitle}</span>
            {percent !== undefined && <span className="tool-update-pct num">{percent}%</span>}
          </div>
          <div
            className={`tool-progress-track${determinate ? '' : ' is-indeterminate'}`}
            role="progressbar"
            aria-label="yt-dlp 更新进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="tool-progress-fill" style={percent !== undefined ? { width: `${percent}%` } : undefined} />
          </div>
          <div className="tool-update-foot">
            <span className="tool-update-stats num muted">
              {update?.phase === 'downloading' ? (
                <>
                  <span>{formatToolBytes(update.downloadedBytes)}{update.totalBytes > 0 ? ` / ${formatToolBytes(update.totalBytes)}` : ''}</span>
                  {update.bytesPerSecond && update.bytesPerSecond > 0 ? <span className="tool-update-speed">{formatToolSpeed(update.bytesPerSecond)}</span> : null}
                </>
              ) : update?.phase === 'verifying' ? '校验签名与可执行版本' : '正在连接 GitHub 官方发布源'}
            </span>
            <button type="button" className="btn-quiet small" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? '正在取消…' : '取消'}
            </button>
          </div>
        </div>
      ) : update && update.phase !== 'idle' && (
        <p className="muted" role="status">
          {update.phase === 'error' ? <ErrorText error={update.errorDetail ?? { message: update.message }} message={update.message} /> : update.message}
        </p>
      )}
      {loadError && <ReadError error={loadError} detail={loadErrorDetail} onRetry={() => void refresh()} />}
      {error && <p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>}
      {(playbackDiagnostics.official || playbackDiagnostics.commentary) && <dl className="facts">
        {(['official', 'commentary'] as const).map(role => {
          const stall = playbackDiagnostics[role]
          return stall && <div key={role}>
            <dt>{role === 'official' ? '画面' : '解说'}最近卡顿</dt>
            <dd>{(stall.durationMs / 1000).toFixed(1)} 秒{stall.ongoing ? '（尚未恢复）' : ''}，{stall.hint}</dd>
          </div>
        })}
      </dl>}
      <p className="muted">诊断报告仅保存到本机</p>
      <div className="row-end">
        <button type="button" className="btn-quiet small" disabled={exporting} onClick={() => void exportReport()}>
          {exporting ? '正在导出' : '导出诊断报告'}
        </button>
      </div>
      {exportMessage && <p className="muted" role="status">{exportMessage}</p>}
      {exportError && <p className="form-error" role="alert"><ErrorText error={exportErrorDetail ?? exportError} message={exportError} /></p>}
    </Group>
  )
}
