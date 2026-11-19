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
import type { DouyinSendState } from '../core/douyinMessage'
import { AppUpdateSettings } from './about/AppUpdate'
import { CaptureSettings } from './capture/Capture'
import { DouyuDesk } from './douyu/DouyuDesk'
import { RoomInsights } from './insights/RoomInsights'
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

export type SettingsSection = 'accounts' | 'records' | 'insights' | 'frame-matching' | 'general'

/** Where 设置 opens, and for 弹幕记录 which page and user. */
export interface SettingsTarget { section: SettingsSection; account?: LoginPlatform; records?: { tab: RecordsTab; uid?: string } }

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
  const huya = isReadOnlyDanmakuRoom(room)
  useEffect(() => setSection(target.section), [target])
  useEffect(() => { remember('settings:section', section) }, [section])
  return (
    <Sheet title="设置" onClose={onClose} wide>
      <div className="settings">
        <nav className="settings-tabs" role="tablist" aria-label="设置分区">
          {SECTIONS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={section === item.id}
              className={section === item.id ? 'is-on' : undefined} onClick={() => setSection(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="settings-body" role="tabpanel" aria-label={SECTIONS.find((item) => item.id === section)?.label}>
          {section === 'general' && <General />}
          {section === 'accounts' && <AccountSettings target={target} onWatch={(next) => { onWatch(next); onClose() }} />}
          {huya && ['records', 'insights'].includes(section) && (
            <p className="settings-empty">{section === 'records' ? '弹幕记录仅支持斗鱼' : '房间数据仅支持斗鱼'}</p>
          )}
          {section === 'records' && !huya && (
            <DanmakuRecords initialTab={target.records?.tab ?? 'history'} initialUid={target.records?.uid} room={room}
              onFill={(text) => { onFill(text); onClose() }} />
          )}
          {section === 'insights' && !huya && (room
            ? <RoomInsights room={room} />
            : <p className="settings-empty">请先连接斗鱼弹幕</p>)}
          {section === 'frame-matching' && <div className="settings-page">
            <FrameHashSettings />
          </div>}
        </div>
      </div>
    </Sheet>
  )
}

const ACCOUNT_PLATFORMS: { id: LoginPlatform; label: string }[] = [
  { id: 'douyu', label: '斗鱼' },
  { id: 'bilibili', label: '哔哩哔哩' },
  { id: 'huya', label: '虎牙' },
  { id: 'douyin', label: '抖音' },
  { id: 'youtube', label: 'YouTube' },
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
      {platform === 'youtube' ? <YouTubeAccount /> : platform === 'douyin' ? <DouyinAccount /> : <PlatformAccount key={platform} platform={platform} />}
    </div>
  </SideTabs>
}

type GeneralPage = 'align' | 'network' | 'decoding' | 'pip' | 'capture' | 'tools' | 'about'
const GENERAL: { id: GeneralPage; label: string }[] = [
  { id: 'align', label: '对齐' },
  { id: 'network', label: '网络' },
  { id: 'decoding', label: '解码' },
  { id: 'pip', label: '画中画' },
  { id: 'capture', label: '截图与 GIF' },
  { id: 'tools', label: '取流工具' },
  { id: 'about', label: '关于' },
]

function General(): React.ReactNode {
  const [saved, setPage] = useRemembered<GeneralPage>('settings:general', 'align')
  const page = GENERAL.some(item => item.id === saved) ? saved : 'align'
  return (
    <SideTabs label="通用" value={page} onChange={setPage} tabs={GENERAL}>
      <div className="settings-page">
        {page === 'align' && <AlignPrefs />}
        {page === 'network' && <Network />}
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
  useEffect(() => { void refresh() }, [])

  const act = async (logout: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage(logout ? '' : '请在弹出的 Chrome 窗口中登录，完成后关闭该窗口')
    try {
      const result = logout ? await apiClient.logout('youtube') : await apiClient.login('youtube')
      if (mounted.current) {
        if (result.ok || result.code === 'login-cancelled') setMessage(result.ok ? (logout ? '已退出' : '已登录，重新载入画面后生效') : '已取消登录')
        else { setMessage(''); setError(result) }
      }
      await refresh()
    } catch (error) {
      if (mounted.current) { setMessage(''); setError(displayError(error, '账号操作失败，请重试')) }
    } finally { if (mounted.current) setBusy(false) }
  }
  const youtube = status?.youtube

  return (
    <Group title="YouTube">
      <div className="row-split">
        <span className="account-identity">
          {youtube?.nickname && <><AccountAvatar username={youtube.nickname} avatar={youtube.avatar} /><b>{youtube.nickname}</b></>}
          {loadError ? '登录状态读取失败' : status === null ? '正在检查登录状态' : youtube?.loggedIn ? '已登录' : '未登录'}
          {youtube?.expiresAt ? <span className="muted">，{new Date(youtube.expiresAt * 1000).toLocaleDateString('zh-CN')} 到期</span> : null}
        </span>
        <span className="row-end">
          <BrowserImportButton platform="youtube" disabled={busy} />
          {youtube?.cookieCount ? <button type="button" className="btn-quiet small" disabled={busy} onClick={() => void act(true)}>退出</button> : null}
          <button type="button" className="btn-solid small" disabled={busy || checking || status === null} onClick={() => void act(false)}>{youtube?.loggedIn ? '重新登录' : '登录'}</button>
        </span>
      </div>
      <p className="muted">观看会员直播或提示需要验证时，请登录 YouTube</p>
      {message && <p className="muted" role="status">{message}</p>}
      {loadError && <ReadError error={loadError} detail={loadErrorDetail} onRetry={() => void refresh()} />}
      {error && <p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>}
      <Switch label="自动使用最高画质" detail="网络较慢时可关闭"
        checked={settings.preferAdaptive} onChange={(preferAdaptive) => session.updateSettings({ preferAdaptive })} />
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
  const refresh = async (force = false): Promise<void> => {
    setChecking(true)
    try {
      const result = await apiClient.loginStatus()
      if (!mounted.current) return
      if (result.ok && result.value?.douyin) {
        setStatus(result.value); setError('')
        const verified=await apiClient.getDouyinSendState(force)
        if (!mounted.current) return
        if (verified.ok && typeof verified.value?.loggedIn==='boolean' && typeof verified.value?.canSend==='boolean') {
          setOnline(verified.value)
          if (verified.value.loginState === 'unavailable') setError(displayError(verified.value, verified.value.message || '暂时无法确认抖音登录状态'))
        } else {
          setOnline(null)
          setError(verified.ok ? displayError({ code: 'invalid-login-state' }, '暂时无法确认抖音登录状态') : verified)
        }
      }
      else setError(result.ok ? '暂时无法读取抖音登录状态' : result)
    } catch (error) {
      if (mounted.current) setError(displayError(error, '抖音登录状态读取失败，请重试'))
    } finally { if (mounted.current) setChecking(false) }
  }
  useEffect(() => { void refresh() }, [])
  const act = async (logout: boolean): Promise<void> => {
    if (busy) return
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
      await refresh()
    } catch (error) {
      if (mounted.current) { setMessage(''); setError(displayError(error, '抖音账号操作失败，请重试')) }
    } finally { if (mounted.current) setBusy(false) }
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
          {douyin?.cookieCount ? <button type="button" className="btn-quiet small" disabled={busy || checking} onClick={() => void act(true)}>退出</button> : null}
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
      <Switch label="显示基础识别面板" detail="在弹幕栏顶部显示识别状态和框选工具"
        checked={settings.basicRecognitionPanelVisible} onChange={(visible) => session.updateSettings({ basicRecognitionPanelVisible: visible })} />
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

function SourceNetworkRules({ rules, onChange, disabled }: { rules: MediaSourceRule[]; onChange: (rules: MediaSourceRule[]) => void; disabled: boolean }): React.ReactNode {
  const [origin, setOrigin] = useState('')
  const [headers, setHeaders] = useState('')
  const [verifyTls, setVerifyTls] = useState(true)
  const [verifyProxyTls, setVerifyProxyTls] = useState(true)
  const [problem, setProblem] = useState('')
  const apply = () => {
    try {
      const source = new URL(origin.trim()).origin
      const pairs = headers.split(/\r?\n/).filter(line => line.trim()).map(line => {
        const colon = line.indexOf(':')
        if (colon < 1) throw new Error('header')
        return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as const
      })
      if (new Set(pairs.map(([name]) => name.toLowerCase())).size !== pairs.length) throw new Error('duplicate header')
      const rule = { origin: source, headers: Object.fromEntries(pairs), verifyTls, verifyProxyTls }
      if (!validMediaSourceRule(rule)) throw new Error('source')
      onChange([...rules.filter(item => item.origin !== source), rule])
      setOrigin(''); setHeaders(''); setProblem('')
    } catch { setProblem('请输入有效的 HTTP/HTTPS 来源。请求头每行使用「名称: 值」，名称不能重复。') }
  }
  return <div className="field-stack">
    <span className="field-label">按来源配置</span>
    <p className="muted">请求头仅发往此来源（协议、域名和端口）。加入后须点击「保存取流网络设置」。</p>
    {rules.map(rule => <div className="row-split" key={rule.origin}>
      <span title={rule.origin} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rule.origin}（{Object.keys(rule.headers).length} 个请求头）</span>
      <span className="row-end" style={{ flexShrink: 0 }}>
        <button className="btn-quiet small" type="button" aria-label={`编辑来源 ${rule.origin}`} disabled={disabled} onClick={() => {
          setOrigin(rule.origin); setHeaders(Object.entries(rule.headers).map(([name, value]) => `${name}: ${value}`).join('\n'))
          setVerifyTls(rule.verifyTls); setVerifyProxyTls(rule.verifyProxyTls)
        }}>编辑</button>
        <button className="btn-quiet small" type="button" aria-label={`移除来源 ${rule.origin}`} disabled={disabled} onClick={() => onChange(rules.filter(item => item.origin !== rule.origin))}>移除</button>
      </span>
    </div>)}
    <label className="field-stack"><span>来源地址</span><input className="text-input" value={origin} disabled={disabled}
      placeholder="https://example.com:8443" onChange={event => setOrigin(event.target.value)} /></label>
    <label className="field-stack"><span>来源请求头</span><textarea className="text-input" value={headers} disabled={disabled} rows={4}
      placeholder={'Referer: https://example.com/\nUser-Agent: MyPlayer'} onChange={event => setHeaders(event.target.value)} spellCheck={false} /></label>
    <Switch label="校验该来源服务器证书" checked={verifyTls} disabled={disabled} onChange={setVerifyTls} />
    <Switch label="校验该来源 HTTPS 代理证书" checked={verifyProxyTls} disabled={disabled} onChange={setVerifyProxyTls} />
    <p className="muted">此处的证书设置也适用于带登录信息的取流连接</p>
    <button className="btn-quiet small" type="button" disabled={disabled || !origin.trim()} onClick={apply}>加入来源设置</button>
    {problem && <p className="form-error" role="alert">{problem}</p>}
  </div>
}

function Network(): React.ReactNode {
  const mounted = useMounted()
  const [state, setState] = useRemembered<NetworkPreferenceState | null>('network', null)
  const [pending, setPending] = useState(() => state === null)
  const [error, setError, errorDetail] = useErrorState()
  const [loadError, setLoadError, loadErrorDetail] = useErrorState()
  const [draft, setDraft] = useState<MediaNetworkOptions>({ ...DEFAULT_MEDIA_NETWORK })
  const refresh = async (): Promise<void> => {
    setPending(true)
    setLoadError('')
    try {
      const result = await apiClient.getNetworkPreferences()
      if (!mounted.current) return
      if (result.ok) { setState(result.value); setDraft({ ...DEFAULT_MEDIA_NETWORK, ...result.value.media }) }
      else setLoadError(result)
    } catch (caught) {
      if (mounted.current) setLoadError(displayError(caught, '网络设置读取失败，请重试'))
    } finally { if (mounted.current) setPending(false) }
  }
  useEffect(() => { void refresh() }, [])
  const save = async (direct: boolean): Promise<void> => {
    if (pending || !state) return
    setPending(true)
    setError('')
    try {
      const result = await apiClient.setNetworkPreferences(direct ? 'direct' : 'system')
      if (!mounted.current) return
      if (result.ok) setState(result.value)
      else setError(result)
    } finally { if (mounted.current) setPending(false) }
  }
  const proxy = state?.systemProxy
  const change = <K extends keyof MediaNetworkOptions>(key: K, value: MediaNetworkOptions[K]): void => setDraft(previous => ({ ...previous, [key]: value }))
  const saveMedia = async (): Promise<void> => {
    if (pending || !state) return
    if (!validMediaNetwork(draft)) { setError('请检查代理地址和网络参数'); return }
    setPending(true)
    setError('')
    try {
      const result = await apiClient.setNetworkPreferences(state.domesticRouting, draft)
      if (!mounted.current) return
      if (result.ok) { setState(result.value); setDraft({ ...DEFAULT_MEDIA_NETWORK, ...result.value.media }) }
      else setError(result)
    } finally { if (mounted.current) setPending(false) }
  }
  return (
    <Group title="网络">
      <div className="row-split">
        <span>系统代理</span>
        <span className="muted">{loadError ? '读取失败' : proxy ? PROXY_NAME[proxy.type] : '正在读取'}</span>
      </div>
      {proxy?.fallbackReason === 'socks4-unsupported' && (
        <p className="note-warn">不支持 SOCKS4，请改用 HTTP 或 SOCKS5 代理</p>
      )}
      {proxy?.fallbackReason === 'proxy-type-unsupported' && (
        <p className="note-warn">不支持当前系统代理，请改用 HTTP 或 SOCKS5 代理</p>
      )}
      {proxy?.fallbackReason === 'proxy-resolution-failed' && <p className="note-warn">无法读取系统代理，请检查系统代理设置</p>}
      <p className="muted">选择「按平台连接」时，YouTube 和 Twitch 使用系统代理</p>
      <Switch label="国内平台直接连接" detail="适用于按平台连接，下次载入直播间生效"
        checked={state?.domesticRouting === 'direct'} disabled={pending || !state} onChange={(on) => void save(on)} />
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
        <SourceNetworkRules rules={draft.sourceRules ?? []} disabled={pending || !state} onChange={rules => change('sourceRules', rules)} />
        <div className="row-end"><button type="submit" className="btn small" disabled={pending || !state}>保存取流网络设置</button></div>
      </form>
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

export function Tools(): React.ReactNode {
  const session = useSession()
  const mounted = useMounted()
  const [status, setStatus] = useRemembered<ToolsStatus | null>('tools-status', null)
  const [busy, setBusy] = useState(false)
  const [error, setError, errorDetail] = useErrorState()
  const [loadError, setLoadError, loadErrorDetail] = useErrorState()
  const exportPending = useRef(false)
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState('')
  const [exportError, setExportError, exportErrorDetail] = useErrorState()
  const running = busy || (!!status && ['checking', 'downloading', 'verifying'].includes(status.update.phase))
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
    if (!running) return
    const timer = setInterval(() => {
      void refresh()
    }, 750)
    return () => clearInterval(timer)
  }, [running, mounted])
  const act = async (target?: 'previous' | 'bundled'): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = target ? await apiClient.restoreYtdlp(target) : await apiClient.updateYtdlp()
      if (!mounted.current) return
      if (result.ok) setStatus(result.value)
      else setError(result)
    } finally { if (mounted.current) setBusy(false) }
  }
  const update = status?.update
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
      {update && update.phase !== 'idle' && (
        <p className="muted" role="status">
          {update.phase === 'error' ? <ErrorText error={update.errorDetail ?? { message: update.message }} message={update.message} /> : update.message}
          {update.phase === 'downloading' && update.totalBytes > 0 ? ` ${Math.floor(update.downloadedBytes * 100 / update.totalBytes)}%` : ''}
        </p>
      )}
      {loadError && <ReadError error={loadError} detail={loadErrorDetail} onRetry={() => void refresh()} />}
      {error && <p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>}
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
