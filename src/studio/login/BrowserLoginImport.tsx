import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import { remember, remembered } from '../../app/remembered'
import { Sheet } from '../kit'
import { refreshLoginStatus } from './status'
import { notifyLoginStateChanged } from '../../core/loginEvents'
import type { LoginPlatform, LoginStatus } from '../../../electron/cookies'
import { IMPORT_PLATFORMS, IMPORT_PLATFORM_NAMES, type BrowserImportAccount, type BrowserImportOutcome,
  type BrowserImportPreview, type BrowserImportProfile, type DouyuImportTarget } from '../../../electron/browserImportContracts'
import type { DouyuAccountSummary } from '../../../server/douyu/types'
import './browserImport.css'

function hasOfficialYoutubeLogin(status: LoginStatus | null | undefined): boolean {
  return Boolean(status?.youtube?.loggedIn && status.youtube.loginSource === 'official')
}

interface ImportRequest { id: string; platform?: LoginPlatform; accountId?: string; manual?: boolean }
const ImportContext = createContext<{ open: (platform?: LoginPlatform, accountId?: string, manual?: boolean) => void } | null>(null)

export function BrowserLoginImportProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const [request, setRequest] = useState<ImportRequest | null>(null)
  return <ImportContext.Provider value={{ open: (platform, accountId, manual) => setRequest({ id: crypto.randomUUID(), platform, accountId, manual }) }}>
    {children}
    {request && <BrowserImportDialog key={request.id} request={request} onClose={() => setRequest(null)} />}
  </ImportContext.Provider>
}
export function BrowserImportButton({ platform, accountId, disabled = false, batch = false }: {
  platform?: LoginPlatform; accountId?: string; disabled?: boolean; batch?: boolean
}): React.ReactNode {
  const imports = useContext(ImportContext)
  return <><button type="button" className={batch ? 'btn-quiet small browser-import-batch' : 'btn-quiet small'}
    title="支持从 Edge、Chrome 或 Firefox 导入已登录账号"
    disabled={disabled || !imports} onClick={() => imports?.open(platform, accountId)}>
    {batch ? '批量导入账号' : '从浏览器导入'}
  </button>{platform && <button type="button" className="btn-quiet small" disabled={disabled || !imports}
    onClick={() => imports?.open(platform, accountId, true)}>导入 Cookie</button>}</>
}
export function AccountAvatar({ username, avatar }: { username: string; avatar?: string }): React.ReactNode {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [avatar])
  return <span className="browser-account-avatar" aria-hidden={!avatar || failed ? 'true' : undefined}>
    {avatar && !failed ? <img src={avatar} alt={`${username}的头像`} onError={() => setFailed(true)} /> : username.trim().slice(0, 1) || '?'}
  </span>
}

async function refreshAccounts(outcomes?: readonly BrowserImportOutcome[]): Promise<DouyuAccountSummary[] | null> {
  const imported = outcomes?.filter(outcome => outcome.imported).map(outcome => outcome.platform) ?? []
  const [, result] = await Promise.all([refreshLoginStatus(), apiClient.listDouyuAccounts()])
  if (result.ok) remember('douyu:accounts', result.value)
  if (imported.length > 0) notifyLoginStateChanged(imported, 'import')
  return result.ok ? result.value.accounts : null
}

function BrowserImportDialog({ request, onClose }: { request: ImportRequest; onClose: () => void }): React.ReactNode {
  const [profiles, setProfiles] = useState<BrowserImportProfile[]>([])
  const [browserName, setBrowserName] = useState('')
  const [profileId, setProfileId] = useState('')
  const [phase, setPhase] = useState<'loading' | 'choose' | 'closing' | 'scanning' | 'preview' | 'importing' | 'result'>(request.manual ? 'choose' : 'loading')
  const [cookieText, setCookieText] = useState('')
  const fileRevision = useRef(0)
  const [supported, setSupported] = useState(true)
  const [preview, setPreview] = useState<BrowserImportPreview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)
  const [confirmYoutubeId, setConfirmYoutubeId] = useState<string | null>(null)
  const [youtubeOfficialLogin, setYoutubeOfficialLogin] = useState(() => hasOfficialYoutubeLogin(remembered<LoginStatus>('login-status')))
  const [outcomes, setOutcomes] = useState<BrowserImportOutcome[]>([])
  const [douyuAccounts, setDouyuAccounts] = useState<DouyuAccountSummary[]>([])
  const [douyuTarget, setDouyuTarget] = useState(request.accountId ?? 'auto')
  const live = useRef(true)
  const pending = useRef(false)
  const previewRef = useRef<BrowserImportPreview | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const closeRequestIdRef = useRef<string | null>(null)
  const closeTriggerRef = useRef<HTMLButtonElement | null>(null)
  const cancelCloseRef = useRef<HTMLButtonElement | null>(null)
  const restoreCloseFocusRef = useRef(false)
  const youtubeCheckboxRef = useRef<HTMLInputElement | null>(null)
  const cancelYoutubeConfirmRef = useRef<HTMLButtonElement | null>(null)
  const restoreYoutubeFocusRef = useRef(false)
  const cancelling = useRef(false)
  const [stopRequested, setStopRequested] = useState(false)

  const readYoutubeOfficialLogin = async (): Promise<boolean> => {
    if (request.platform && request.platform !== 'youtube') return false
    try {
      const result = await apiClient.loginStatus()
      if (result.ok && result.value?.youtube) {
        remember('login-status', result.value)
        const official = hasOfficialYoutubeLogin(result.value)
        if (live.current) setYoutubeOfficialLogin(official)
        return official
      }
    } catch { /* Fall back to last remembered login status. */ }
    const rememberedOfficial = hasOfficialYoutubeLogin(remembered<LoginStatus>('login-status'))
    if (live.current) setYoutubeOfficialLogin(rememberedOfficial)
    return rememberedOfficial
  }

  const load = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setPhase('loading'); setError(''); setErrorCode(''); setNotice(''); setConfirmClose(false); setConfirmYoutubeId(null)
    try {
      const result = await apiClient.listBrowserImportProfiles()
      if (!live.current) return
      if (!result.ok) { setError(result.message); setErrorCode(result.code); return }
      setProfiles(result.value.profiles); setSupported(result.value.supported)
      const first = result.value.profiles.find(profile => profile.browserName === 'Microsoft Edge' && profile.isDefault) ?? result.value.profiles[0]
      setBrowserName(first?.browserName ?? ''); setProfileId(first?.id ?? '')
    } finally { pending.current = false; if (live.current) setPhase('choose') }
  }
  useEffect(() => {
    live.current = true
    if (!request.manual) void load()
    void readYoutubeOfficialLogin()
    if (!request.platform || request.platform === 'douyu') void apiClient.listDouyuAccounts().then(result => {
      if (live.current && result.ok) setDouyuAccounts(result.value.accounts)
    })
    return () => {
      live.current = false
      fileRevision.current++
      void apiClient.cancelBrowserImport(request.id)
      if (closeRequestIdRef.current) void apiClient.cancelBrowserImport(closeRequestIdRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    if (confirmClose) {
      cancelCloseRef.current?.focus()
    } else if (restoreCloseFocusRef.current) {
      restoreCloseFocusRef.current = false
      closeTriggerRef.current?.focus()
    }
  }, [confirmClose])

  useLayoutEffect(() => {
    if (confirmYoutubeId) {
      cancelYoutubeConfirmRef.current?.focus()
    } else if (restoreYoutubeFocusRef.current) {
      restoreYoutubeFocusRef.current = false
      youtubeCheckboxRef.current?.focus()
    }
  }, [confirmYoutubeId])

  useEffect(() => {
    if (!confirmClose && !confirmYoutubeId) return
    const dialog = contentRef.current?.closest('dialog')
    const dismiss = (event: Event): void => {
      event.preventDefault()
      event.stopPropagation()
      if (confirmYoutubeId) {
        restoreYoutubeFocusRef.current = true
        setConfirmYoutubeId(null)
        return
      }
      restoreCloseFocusRef.current = true
      setConfirmClose(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss(event)
    }
    dialog?.addEventListener('keydown', onKey, true)
    dialog?.addEventListener('cancel', dismiss)
    return () => {
      dialog?.removeEventListener('keydown', onKey, true)
      dialog?.removeEventListener('cancel', dismiss)
    }
  }, [confirmClose, confirmYoutubeId])

  const reset = (): void => {
    if (previewRef.current) void apiClient.cancelBrowserImport(previewRef.current.id)
    previewRef.current = null; setPreview(null); setSelected([]); setError(''); setErrorCode(''); setNotice(''); setConfirmClose(false); setConfirmYoutubeId(null); setOutcomes([]); setPhase('choose')
  }
  const cancelCloseConfirm = (): void => {
    restoreCloseFocusRef.current = true
    setConfirmClose(false)
  }
  const cancelYoutubeConfirm = (): void => {
    restoreYoutubeFocusRef.current = true
    setConfirmYoutubeId(null)
  }
  const confirmYoutubeSelect = (): void => {
    if (!confirmYoutubeId) return
    const id = confirmYoutubeId
    restoreYoutubeFocusRef.current = true
    setConfirmYoutubeId(null)
    setSelected(current => current.includes(id) ? current : [...current, id])
  }
  const closeBrowser = async (): Promise<void> => {
    if (pending.current || !profileId) return
    pending.current = true
    restoreCloseFocusRef.current = false
    setConfirmClose(false)
    setConfirmYoutubeId(null)
    const previousPhase = phase === 'preview' || phase === 'result' ? phase : 'choose'
    const closeRequestId = crypto.randomUUID()
    closeRequestIdRef.current = closeRequestId
    setPhase('closing'); setError(''); setErrorCode(''); setNotice('')
    try {
      const result = await apiClient.closeImportBrowser({ requestId: closeRequestId, profileId })
      if (!live.current) return
      if (!result.ok) { setError(result.message); setErrorCode(result.code); setPhase(previousPhase); return }
      setNotice(result.value.status === 'closed'
        ? `已关闭 ${result.value.browserName}，现在可以点击「识别账号」继续`
        : `${result.value.browserName} 当前未运行，可直接点击「识别账号」`)
      setPhase(previousPhase)
    } finally {
      if (closeRequestIdRef.current === closeRequestId) closeRequestIdRef.current = null
      pending.current = false
    }
  }
  const scan = async (): Promise<void> => {
    if (pending.current || (request.manual ? !cookieText.trim() : !profileId)) return
    pending.current = true
    setPhase('scanning'); setError(''); setErrorCode(''); setNotice(''); setConfirmClose(false); setConfirmYoutubeId(null); setOutcomes([])
    try {
      const [result, officialYoutube] = await Promise.all([
        request.manual && request.platform
          ? apiClient.previewManualCookies({ requestId: request.id, platform: request.platform, text: cookieText })
          : apiClient.previewBrowserLogins({ requestId: request.id, profileId,
          platforms: request.platform ? [request.platform] : [...IMPORT_PLATFORMS] }),
        readYoutubeOfficialLogin(),
      ])
      if (!live.current) { if (result.ok) void apiClient.cancelBrowserImport(result.value.id); return }
      if (!result.ok) { setError(result.message); setErrorCode(result.code); setPhase('choose'); return }
      previewRef.current = result.value; setPreview(result.value)
      if (request.manual) setCookieText('')
      setSelected(result.value.accounts
        .filter(account => account.state === 'ready' && !(account.platform === 'youtube' && officialYoutube))
        .map(account => account.id))
      setPhase('preview')
    } catch {
      if (live.current) { setError('账号验证失败，请检查网络后重试'); setPhase('choose') }
    } finally { pending.current = false }
  }
  const apply = async (): Promise<void> => {
    if (pending.current || !preview || !selected.length) return
    pending.current = true; cancelling.current = false; setStopRequested(false); setPhase('importing'); setError(''); setErrorCode(''); setNotice(''); setConfirmClose(false); setConfirmYoutubeId(null)
    const target: DouyuImportTarget = douyuTarget === 'auto' ? { kind: 'auto' } : douyuTarget === 'new' ? { kind: 'new' }
      : { kind: 'existing', accountId: douyuTarget }
    try {
      const result = await apiClient.importBrowserLogins({ previewId: preview.id, accountIds: selected,
        ...(preview.accounts.some(account => account.platform === 'douyu' && selected.includes(account.id)) ? { douyuTarget: target } : {}) })
      const refreshedDouyu = await refreshAccounts(result.ok ? result.value.outcomes : undefined)
      if (live.current) {
        if (refreshedDouyu) setDouyuAccounts(refreshedDouyu)
        if (result.ok) { setOutcomes(result.value.outcomes); setPhase('result') }
        else { setError(result.message); setErrorCode(result.code); setPhase('preview') }
      }
    } catch {
      if (live.current) { setError('账号导入失败，请重试'); setPhase('preview') }
    } finally { pending.current = false }
  }
  const close = (): void => {
    if (phase !== 'importing') { onClose(); return }
    if (cancelling.current) return
    cancelling.current = true; setStopRequested(true); setError(''); setErrorCode('')
    void apiClient.cancelBrowserImport(previewRef.current?.id ?? request.id).then(result => {
      if (live.current && !result.ok) { setError(result.message); setErrorCode(result.code); cancelling.current = false; setStopRequested(false) }
    }).catch(() => {
      if (live.current) { setError('停止导入失败，请重试'); setErrorCode(''); cancelling.current = false; setStopRequested(false) }
    })
  }
  useEffect(() => {
    if (phase !== 'importing') return
    const dialog = contentRef.current?.closest('dialog')
    const cancel = (event: Event): void => { event.preventDefault(); close() }
    dialog?.addEventListener('cancel', cancel)
    return () => dialog?.removeEventListener('cancel', cancel)
  }, [phase])
  const busy = phase === 'loading' || phase === 'closing' || phase === 'scanning' || phase === 'importing'
  const choices = profiles.filter(profile => profile.browserName === browserName)
  const selectedProfile = profiles.find(profile => profile.id === profileId) ?? null
  const suggestClose = errorCode === 'browser-import-browser-in-use' || errorCode === 'browser-import-timeout'
  const hasDouyu = preview?.accounts.some(account => account.platform === 'douyu' && selected.includes(account.id))
  const title = request.manual && request.platform ? `导入 ${IMPORT_PLATFORM_NAMES[request.platform]} Cookie`
    : request.platform ? `从浏览器导入 ${IMPORT_PLATFORM_NAMES[request.platform]} 账号` : '批量导入账号'

  const readFile = async (file: File | undefined): Promise<void> => {
    const revision = ++fileRevision.current
    if (!file) return
    reset(); setCookieText('')
    if (file.size > 1024 * 1024) { setError('Cookie 文件不能超过 1 MB'); return }
    try {
      const text = await file.text()
      if (live.current && revision === fileRevision.current) setCookieText(text)
    } catch { if (live.current && revision === fileRevision.current) setError('Cookie 文件读取失败，请重新选择') }
  }

  return <Sheet title={title} onClose={close}>
    <div className="browser-import-dialog" ref={contentRef}>
      {request.manual ? <>
        {phase === 'choose' && <>
          <label>Cookie 文本<textarea className="text-input" aria-label="Cookie 文本" rows={7} value={cookieText} disabled={busy}
            spellCheck={false} autoComplete="off" onChange={event => { fileRevision.current++; setCookieText(event.target.value); setError('') }}
            placeholder="粘贴 Cookie: name=value; name2=value2，或 JSON / Netscape cookies.txt 内容" /></label>
          <label>选择 Cookie 文件<input type="file" aria-label="选择 Cookie 文件" accept=".txt,.json" disabled={busy}
            onChange={event => { void readFile(event.target.files?.[0]); event.target.value = '' }} /></label>
          <p className="muted">支持 Cookie 请求头、JSON 和 Netscape cookies.txt，最多 1 MB。请求头按所选平台保存为会话 Cookie，无法确定原始有效期。</p>
          <button type="button" className="btn-solid small" disabled={busy || !cookieText.trim()} onClick={() => void scan()}>验证账号</button>
        </>}
        {phase === 'scanning' && <p role="status">正在验证账号…</p>}
        {request.platform === 'douyin' && <p className="muted">仅导入 Cookie 无法补全弹幕发送授权，需通过登录补全设备签名授权</p>}
        {phase === 'preview' && <button type="button" className="btn-quiet small" onClick={reset}>重新输入 Cookie</button>}
      </> : <>
      <div className="browser-import-selectors">
        <label>浏览器<select className="text-input" aria-label="浏览器" value={browserName} disabled={busy || !profiles.length}
          onChange={event => { reset(); setBrowserName(event.target.value); setProfileId(profiles.find(profile => profile.browserName === event.target.value)?.id ?? '') }}>
          {!profiles.length && <option value="">暂无浏览器</option>}
          {[...new Set(profiles.map(profile => profile.browserName))].map(name => <option key={name} value={name}>{name}</option>)}
        </select></label>
        <label>浏览器用户<select className="text-input" aria-label="浏览器用户" value={profileId} disabled={busy || !choices.length}
          onChange={event => { reset(); setProfileId(event.target.value) }}>
          {!choices.length && <option value="">暂无浏览器用户</option>}
          {choices.map(profile => <option key={profile.id} value={profile.id}>{profile.name}{profile.isDefault ? '（默认）' : ''}</option>)}
        </select></label>
      </div>
      {!supported && <p role="status">仅支持在 Windows 导入浏览器账号</p>}
      {supported && !profiles.length && phase !== 'loading' && <p role="status">未找到浏览器用户。打开 Chrome、Edge 或 Firefox 后，请刷新浏览器列表。</p>}
      <div className="browser-import-toolbar">
        <button type="button" className="btn-quiet small" disabled={busy} onClick={() => void load()}>刷新浏览器列表</button>
        <div className="browser-import-toolbar-actions">
          <button type="button" ref={closeTriggerRef}
            className={suggestClose ? 'btn-quiet small is-danger' : 'btn-quiet small'}
            disabled={busy || !profileId || !supported}
            onClick={() => { setNotice(''); setConfirmYoutubeId(null); setConfirmClose(true) }}>关闭浏览器</button>
          <button type="button" className="btn-solid small" disabled={busy || !profileId || !supported} onClick={() => void scan()}>识别账号</button>
        </div>
      </div>
      {confirmClose && selectedProfile && <div className="writes-confirm browser-import-close-confirm" role="alertdialog" aria-label={`确认关闭 ${selectedProfile.browserName}`}>
        <p className="note-warn">将关闭所有正在运行的 {selectedProfile.browserName} 窗口和后台进程，未保存的页面内容可能会丢失。请先保存浏览内容后再确认。</p>
        <span className="row-end">
          <button type="button" ref={cancelCloseRef} className="btn-quiet small" disabled={busy} onClick={cancelCloseConfirm}>暂不关闭</button>
          <button type="button" className="btn-solid small is-danger" disabled={busy} onClick={() => void closeBrowser()}>确认关闭</button>
        </span>
      </div>}
      {phase === 'closing' && selectedProfile && <p role="status" className="browser-import-progress">正在关闭 {selectedProfile.browserName}…</p>}
      {phase === 'scanning' && <p role="status" className="browser-import-progress">正在识别账号。如出现 Windows 授权提示，请完成授权。</p>}
      {phase === 'loading' && <p role="status">正在查找浏览器用户…</p>}
      {notice && !busy && <p role="status" className="browser-import-notice">{notice}</p>}
      </>}
      {preview && phase !== 'choose' && <>
        <div className="browser-import-list" aria-label="识别到的平台账号">
          {preview.accounts.map(account => <AccountChoice key={account.id} account={account}
            checked={selected.includes(account.id)} disabled={busy || phase === 'result'}
            officialWarning={account.platform === 'youtube' && youtubeOfficialLogin}
            onChange={(checked, input) => {
              if (!checked) {
                if (confirmYoutubeId === account.id) setConfirmYoutubeId(null)
                setSelected(current => current.filter(id => id !== account.id))
                return
              }
              if (account.platform === 'youtube' && youtubeOfficialLogin) {
                youtubeCheckboxRef.current = input
                setConfirmClose(false)
                setConfirmYoutubeId(account.id)
                return
              }
              setSelected(current => current.includes(account.id) ? current : [...current, account.id])
            }} />)}
        </div>
        {confirmYoutubeId && phase === 'preview' && <div className="writes-confirm browser-import-close-confirm" role="alertdialog" aria-label="确认勾选 YouTube 浏览器导入">
          <p className="note-warn">检测到已有官方登录态，不建议使用浏览器导入。日常浏览器在后台会自动轮换 Google 登录凭据，导入后很容易失效并触发真人验证。</p>
          <span className="row-end">
            <button type="button" ref={cancelYoutubeConfirmRef} className="btn-quiet small" disabled={busy} onClick={cancelYoutubeConfirm}>暂不勾选</button>
            <button type="button" className="btn-solid small is-danger" disabled={busy} onClick={confirmYoutubeSelect}>确认勾选</button>
          </span>
        </div>}
        {hasDouyu && phase !== 'result' && <label className="browser-import-target">斗鱼导入到
          <select className="text-input" aria-label="斗鱼导入到" value={douyuTarget} disabled={busy} onChange={event => setDouyuTarget(event.target.value)}>
            <option value="auto">自动匹配账号</option><option value="new">添加新账号</option>
            {douyuAccounts.map(account => <option key={account.id} value={account.id}>替换：{account.login.nickname || account.label}</option>)}
          </select>
        </label>}
        {phase !== 'result' && <p className="muted">除斗鱼外，导入会替换对应平台的当前账号</p>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {phase === 'importing' && <p role="status">{stopRequested ? '正在停止剩余导入，已导入的账号会保留' : '正在导入所选账号…'}</p>}
      {phase === 'result' && <div className="browser-import-results" role="status">
        {outcomes.map(outcome => <p key={outcome.platform} className={outcome.imported ? '' : 'form-error'}>
          <b>{IMPORT_PLATFORM_NAMES[outcome.platform]}</b>: {outcome.message}
        </p>)}
      </div>}
      {phase !== 'result' && <div className="browser-import-footer">
        <button type="button" className="btn-quiet small" onClick={close} disabled={stopRequested}>取消</button>
        <button type="button" className="btn-solid small" disabled={busy || !preview || !selected.length || phase !== 'preview'}
          onClick={() => void apply()}>{request.manual ? '确认导入' : request.platform ? '导入账号' : `导入所选账号（${selected.length}）`}</button>
      </div>}
    </div>
  </Sheet>
}

function AccountChoice({ account, checked, disabled, officialWarning = false, onChange }: {
  account: BrowserImportAccount; checked: boolean; disabled: boolean; officialWarning?: boolean
  onChange: (checked: boolean, input: HTMLInputElement | null) => void
}): React.ReactNode {
  const name = IMPORT_PLATFORM_NAMES[account.platform]
  const username = account.username || name
  const note = account.message ?? (officialWarning && account.state === 'ready' ? '已有官方登录态，不建议使用浏览器导入' : undefined)
  return <label className={`browser-import-account ${account.state === 'ready' ? '' : 'is-unavailable'}`}>
    <input type="checkbox" aria-label={`导入${name}`} checked={checked} disabled={disabled || account.state !== 'ready'}
      onChange={event => onChange(event.target.checked, event.currentTarget)} />
    <AccountAvatar username={username} avatar={account.avatar} />
    <span className="browser-import-account-text"><b>{name}</b><span>{account.username || (account.state === 'signed-out' ? '未登录' : '暂时无法确认')}</span>
      {note && <small>{note}</small>}</span>
    <span className="browser-import-account-state">{account.state === 'ready' ? '已验证' : account.state === 'signed-out' ? '未登录' : '不可用'}</span>
  </label>
}
