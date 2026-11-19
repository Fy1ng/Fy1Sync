import { useCallback, useEffect, useRef, useState } from 'react'
import { ErrorText } from '../ui/ErrorDetails'
import { errorDetails, displayError, type ErrorDetails } from '../core/errorDetails'
import { apiClient } from '../app/apiClient'
import { DOUYIN_LOGIN_CHANGED_EVENT, DOUYIN_MESSAGE_LIMIT, douyinMessageText, type DouyinMessageOutcome, type DouyinSendState } from '../core/douyinMessage'

type AccountState = DouyinSendState & { detail?: ErrorDetails }
type MessageNotice = DouyinMessageOutcome & { detail?: ErrorDetails }

/** Independent of Douyu accounts, affixes, automation and write preferences. */
export function DouyinComposer({ room, connected, onLogin }: { room: string; connected: boolean; onLogin: () => void }): React.ReactNode {
  const [account, setAccount] = useState<AccountState | null>(null)
  const [accountFailure, setAccountFailure] = useState<unknown>(null)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<MessageNotice | null>(null)
  const [remaining, setRemaining] = useState(0)
  const mounted = useRef(false), reading = useRef(0), context = useRef(0), version = useRef(0)
  const inFlight = useRef(false), composing = useRef(false), deadline = useRef(0)
  const refreshing = useRef(false), lastAutomaticRead = useRef<number | null>(null)
  const identity = useRef<string | null>(null)
  const latest = useRef({ account, room, connected, draft })
  latest.current = { account, room, connected, draft }

  const refresh = useCallback(async (force = false) => {
    if (!force && (refreshing.current || lastAutomaticRead.current !== null && Date.now() - lastAutomaticRead.current < 2_500)) return
    const revision = ++reading.current
    refreshing.current = true
    lastAutomaticRead.current = Date.now()
    const result = await apiClient.getDouyinSendState(force).catch(caught => ({ ok: false as const, ...displayError(caught, '无法读取抖音账号状态，请刷新后重试') }))
    if (revision === reading.current) refreshing.current = false
    if (!mounted.current || revision !== reading.current) return
    const next: AccountState = result.ok ? result.value : { loggedIn:false, canSend:false, loginState:'unavailable', message:'无法读取抖音账号状态，请刷新后重试' }
    const uid = next.loggedIn ? next.uid ?? null : null
    const signedOut = next.loginState === 'signed-out' || !next.loginState && !next.loggedIn
    // A failed read is not an account transition. Preserve its draft and receipt until
    // a different verified identity or an explicit local logout establishes a change.
    if (identity.current !== null && (uid !== null && identity.current !== uid || signedOut)) {
      context.current++; version.current++; setDraft(''); setNotice(null)
    }
    if (uid !== null || signedOut) identity.current = uid
    setAccount(next)
    setAccountFailure(result.ok ? next.detail ?? null : result)
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh(true)
    const focus = () => { void refresh() }
    const changed = () => { context.current++; setNotice(null); void refresh(true) }
    window.addEventListener('focus', focus)
    window.addEventListener(DOUYIN_LOGIN_CHANGED_EVENT,changed)
    return () => { mounted.current = false; reading.current++; context.current++; window.removeEventListener('focus', focus); window.removeEventListener(DOUYIN_LOGIN_CHANGED_EVENT,changed) }
  }, [refresh])

  useEffect(() => {
    context.current++; version.current++; setNotice(null); deadline.current = 0; setRemaining(0)
  }, [room, connected])

  useEffect(() => {
    if (!notice?.nextAllowedAt) return
    const update = () => setRemaining(Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000)))
    update()
    const timer = window.setInterval(update, 250)
    return () => window.clearInterval(timer)
  }, [notice])

  const send = async () => {
    const current = latest.current, text = douyinMessageText(current.draft)
    if (!mounted.current || inFlight.current || !current.connected || !current.account?.canSend || !current.account.uid || !text || Date.now() < deadline.current) return
    inFlight.current = true
    setPending(true); setNotice(null)
    const operation = context.current, draftVersion = version.current
    try {
      const result = await apiClient.sendDouyinMessage({ room:current.room, expectedUid:current.account.uid, text })
      if (!mounted.current || context.current !== operation || latest.current.room !== current.room) return
      const value = result.ok ? result.value : { status:'waiting-user' as const, message:result.message, nextAllowedAt:null, detail:errorDetails(result) }
      if (!value || !['accepted','waiting-user','failed'].includes(value.status) || typeof value.message !== 'string') throw new Error('Unknown send result', { cause: { code: 'invalid-send-result' } })
      deadline.current = typeof value.nextAllowedAt === 'number' && Number.isFinite(value.nextAllowedAt) ? value.nextAllowedAt : 0
      setNotice(value)
      if (value.status === 'accepted' && version.current === draftVersion) { version.current++; setDraft('') }
      else if (value.status !== 'accepted') void refresh(true)
    } catch (caught) {
      if (mounted.current && context.current === operation) setNotice({ status:'waiting-user', message:'未能确认发送结果。请先到官方直播间核对，不要重复发送。', nextAllowedAt:null, detail:errorDetails(caught) })
    } finally { inFlight.current = false; if (mounted.current) setPending(false) }
  }
  const editable = connected && account?.loggedIn === true && account?.canSend === true
  const invalid = draft.length > 0 && !douyinMessageText(draft)
  const blocked = !editable || pending || !douyinMessageText(draft) || remaining > 0
  const signingUnavailable = account?.detail?.code === 'douyin-http-signing-unavailable'
  const needsSigningLogin = account?.detail?.code === 'douyin-signing-material-missing'
  return <form className="say" aria-label="抖音弹幕发送" onSubmit={event => { event.preventDefault(); if (!composing.current) void send() }}>
    <textarea rows={1} aria-label="抖音弹幕内容" value={draft} disabled={!editable} spellCheck={false}
      placeholder="弹幕内容"
      onFocus={() => { void refresh() }}
      onChange={event => { version.current++; setDraft(event.target.value) }}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDown={event => {
        if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
        event.preventDefault(); void send()
      }} />
    <button type="submit" className="say-send" disabled={blocked}>发送</button>
    <p className="say-meta">
      {account?.loggedIn && <span>{account.canSend ? `以 ${account.nickname || '当前抖音账号'} 发送` : `当前抖音账号：${account.nickname || '已验证'}`}</span>}
      {signingUnavailable && <button type="button" className="link-btn" onClick={onLogin}>抖音账号设置</button>}
      {needsSigningLogin && <button type="button" className="link-btn" onClick={onLogin}>重新登录抖音</button>}
      {account && !signingUnavailable && !needsSigningLogin && !account.loggedIn && account.loginState !== 'unavailable' && account.loginState !== 'authenticating'
        && <button type="button" className="link-btn" onClick={onLogin}>{account?.loggedIn || account?.loginState === 'expired' ? '重新登录抖音' : '登录抖音'}</button>}
      <button type="button" className="link-btn" onClick={() => { void refresh(true) }}>刷新账号</button>
      <span className="num">{draft.length}/{DOUYIN_MESSAGE_LIMIT}</span>
      {remaining > 0 && <span className="num">{remaining}s</span>}
    </p>
    {invalid && <p className="say-note is-warn">请输入不超过 {DOUYIN_MESSAGE_LIMIT} 字的单行弹幕</p>}
    {!editable && <p className="say-note">{!connected ? '弹幕未连接' : account && account.loginState !== 'authenticating'
      ? <ErrorText error={accountFailure ?? account.message} message={account.message} /> : '正在检查账号'}</p>}
    {notice && <p className="say-note" data-state={notice.status} role="status">{notice.status === 'accepted' ? notice.message : <ErrorText error={notice.detail ?? notice.diagnostic ?? notice.message} message={notice.message} />}</p>}
  </form>
}
