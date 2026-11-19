import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import { remember } from '../../app/remembered'
import { Sheet } from '../kit'
import { refreshLoginStatus } from './status'
import type { LoginPlatform } from '../../../electron/cookies'
import { IMPORT_PLATFORMS, IMPORT_PLATFORM_NAMES, type BrowserImportAccount, type BrowserImportOutcome,
  type BrowserImportPreview, type BrowserImportProfile, type DouyuImportTarget } from '../../../electron/browserImportContracts'
import type { DouyuAccountSummary } from '../../../server/douyu/types'
import './browserImport.css'

interface ImportRequest { id: string; platform?: LoginPlatform; accountId?: string }
const ImportContext = createContext<{ open: (platform?: LoginPlatform, accountId?: string) => void } | null>(null)

export function BrowserLoginImportProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const [request, setRequest] = useState<ImportRequest | null>(null)
  return <ImportContext.Provider value={{ open: (platform, accountId) => setRequest({ id: crypto.randomUUID(), platform, accountId }) }}>
    {children}
    {request && <BrowserImportDialog key={request.id} request={request} onClose={() => setRequest(null)} />}
  </ImportContext.Provider>
}
export function BrowserImportButton({ platform, accountId, disabled = false, batch = false }: {
  platform?: LoginPlatform; accountId?: string; disabled?: boolean; batch?: boolean
}): React.ReactNode {
  const imports = useContext(ImportContext)
  return <button type="button" className={batch ? 'btn-quiet small browser-import-batch' : 'btn-quiet small'}
    disabled={disabled || !imports} onClick={() => imports?.open(platform, accountId)}>
    {batch ? '批量导入账号' : '从浏览器导入'}
  </button>
}
export function AccountAvatar({ username, avatar }: { username: string; avatar?: string }): React.ReactNode {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [avatar])
  return <span className="browser-account-avatar" aria-hidden={!avatar || failed ? 'true' : undefined}>
    {avatar && !failed ? <img src={avatar} alt={`${username}的头像`} onError={() => setFailed(true)} /> : username.trim().slice(0, 1) || '?'}
  </span>
}

async function refreshAccounts(): Promise<void> {
  await refreshLoginStatus()
  const result = await apiClient.listDouyuAccounts()
  if (result.ok) remember('douyu:accounts', result.value)
}

function BrowserImportDialog({ request, onClose }: { request: ImportRequest; onClose: () => void }): React.ReactNode {
  const [profiles, setProfiles] = useState<BrowserImportProfile[]>([])
  const [browserName, setBrowserName] = useState('')
  const [profileId, setProfileId] = useState('')
  const [phase, setPhase] = useState<'loading' | 'choose' | 'scanning' | 'preview' | 'importing' | 'result'>('loading')
  const [supported, setSupported] = useState(true)
  const [preview, setPreview] = useState<BrowserImportPreview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState('')
  const [outcomes, setOutcomes] = useState<BrowserImportOutcome[]>([])
  const [douyuAccounts, setDouyuAccounts] = useState<DouyuAccountSummary[]>([])
  const [douyuTarget, setDouyuTarget] = useState(request.accountId ?? 'auto')
  const live = useRef(true)
  const pending = useRef(false)
  const previewRef = useRef<BrowserImportPreview | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const cancelling = useRef(false)
  const [stopRequested, setStopRequested] = useState(false)

  const load = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setPhase('loading'); setError('')
    try {
      const result = await apiClient.listBrowserImportProfiles()
      if (!live.current) return
      if (!result.ok) { setError(result.message); return }
      setProfiles(result.value.profiles); setSupported(result.value.supported)
      const first = result.value.profiles.find(profile => profile.browserName === 'Microsoft Edge' && profile.isDefault) ?? result.value.profiles[0]
      setBrowserName(first?.browserName ?? ''); setProfileId(first?.id ?? '')
    } finally { pending.current = false; if (live.current) setPhase('choose') }
  }
  useEffect(() => {
    live.current = true
    void load()
    if (!request.platform || request.platform === 'douyu') void apiClient.listDouyuAccounts().then(result => {
      if (live.current && result.ok) setDouyuAccounts(result.value.accounts)
    })
    return () => { live.current = false; void apiClient.cancelBrowserImport(request.id) }
  }, [])

  const reset = (): void => {
    if (previewRef.current) void apiClient.cancelBrowserImport(previewRef.current.id)
    previewRef.current = null; setPreview(null); setSelected([]); setError(''); setOutcomes([]); setPhase('choose')
  }
  const scan = async (): Promise<void> => {
    if (pending.current || !profileId) return
    pending.current = true
    setPhase('scanning'); setError(''); setOutcomes([])
    try {
      const result = await apiClient.previewBrowserLogins({ requestId: request.id, profileId,
        platforms: request.platform ? [request.platform] : [...IMPORT_PLATFORMS] })
      if (!live.current) { if (result.ok) void apiClient.cancelBrowserImport(result.value.id); return }
      if (!result.ok) { setError(result.message); setPhase('choose'); return }
      previewRef.current = result.value; setPreview(result.value)
      setSelected(result.value.accounts.filter(account => account.state === 'ready').map(account => account.id))
      setPhase('preview')
    } finally { pending.current = false }
  }
  const apply = async (): Promise<void> => {
    if (pending.current || !preview || !selected.length) return
    pending.current = true; cancelling.current = false; setStopRequested(false); setPhase('importing'); setError('')
    const target: DouyuImportTarget = douyuTarget === 'auto' ? { kind: 'auto' } : douyuTarget === 'new' ? { kind: 'new' }
      : { kind: 'existing', accountId: douyuTarget }
    try {
      const result = await apiClient.importBrowserLogins({ previewId: preview.id, accountIds: selected,
        ...(preview.accounts.some(account => account.platform === 'douyu' && selected.includes(account.id)) ? { douyuTarget: target } : {}) })
      if (live.current) {
        if (result.ok) { setOutcomes(result.value.outcomes); setPhase('result') }
        else { setError(result.message); setPhase('preview') }
      }
      await refreshAccounts()
    } finally { pending.current = false }
  }
  const close = (): void => {
    if (phase !== 'importing') { onClose(); return }
    if (cancelling.current) return
    cancelling.current = true; setStopRequested(true); setError('')
    void apiClient.cancelBrowserImport(previewRef.current?.id ?? request.id).then(result => {
      if (live.current && !result.ok) { setError(result.message); cancelling.current = false; setStopRequested(false) }
    }).catch(() => {
      if (live.current) { setError('停止导入失败，请重试'); cancelling.current = false; setStopRequested(false) }
    })
  }
  useEffect(() => {
    if (phase !== 'importing') return
    const dialog = contentRef.current?.closest('dialog')
    const cancel = (event: Event): void => { event.preventDefault(); close() }
    dialog?.addEventListener('cancel', cancel)
    return () => dialog?.removeEventListener('cancel', cancel)
  }, [phase])
  const busy = phase === 'loading' || phase === 'scanning' || phase === 'importing'
  const choices = profiles.filter(profile => profile.browserName === browserName)
  const hasDouyu = preview?.accounts.some(account => account.platform === 'douyu' && selected.includes(account.id))
  const title = request.platform ? `从浏览器导入 ${IMPORT_PLATFORM_NAMES[request.platform]} 账号` : '批量导入账号'

  return <Sheet title={title} onClose={close}>
    <div className="browser-import-dialog" ref={contentRef}>
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
        <button type="button" className="btn-solid small" disabled={busy || !profileId || !supported} onClick={() => void scan()}>识别账号</button>
      </div>
      {phase === 'scanning' && <p role="status" className="browser-import-progress">正在识别账号。如出现 Windows 授权提示，请完成授权。</p>}
      {phase === 'loading' && <p role="status">正在查找浏览器用户…</p>}
      {preview && phase !== 'choose' && <>
        <div className="browser-import-list" aria-label="识别到的平台账号">
          {preview.accounts.map(account => <AccountChoice key={account.id} account={account}
            checked={selected.includes(account.id)} disabled={busy || phase === 'result'}
            onChange={checked => setSelected(current => checked ? [...current, account.id] : current.filter(id => id !== account.id))} />)}
        </div>
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
          onClick={() => void apply()}>{request.platform ? '导入账号' : `导入所选账号（${selected.length}）`}</button>
      </div>}
    </div>
  </Sheet>
}

function AccountChoice({ account, checked, disabled, onChange }: {
  account: BrowserImportAccount; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void
}): React.ReactNode {
  const name = IMPORT_PLATFORM_NAMES[account.platform]
  const username = account.username || name
  return <label className={`browser-import-account ${account.state === 'ready' ? '' : 'is-unavailable'}`}>
    <input type="checkbox" aria-label={`导入${name}`} checked={checked} disabled={disabled || account.state !== 'ready'}
      onChange={event => onChange(event.target.checked)} />
    <AccountAvatar username={username} avatar={account.avatar} />
    <span className="browser-import-account-text"><b>{name}</b><span>{account.username || (account.state === 'signed-out' ? '未登录' : '暂时无法确认')}</span>
      {account.message && <small>{account.message}</small>}</span>
    <span className="browser-import-account-state">{account.state === 'ready' ? '已验证' : account.state === 'signed-out' ? '未登录' : '不可用'}</span>
  </label>
}
