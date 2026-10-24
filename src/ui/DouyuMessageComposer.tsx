import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import type { DouyuMessageOutcome, DouyuTasksSnapshot } from '../../server/douyu/types'
import './DouyuMessageComposer.css'

type ActiveAccount = { id: string; label: string; loggedIn: boolean; busy: boolean }
type MessageContext = { key: string; account: ActiveAccount | null; room: string | null; problem: string | null }
type SendOperation = { context: number; draftVersion: number | null }

const uncertain = '发送结果尚无法确认. 请在官方房间核对后再决定是否重试.'
const accountUnavailable = '请到片源设置登录并激活斗鱼账号.'

function textProblem(text: string): string | null {
  if (text.length > 500) return '弹幕最多支持 500 个字符.'
  if (/[\x00-\x1f\x7f-\x9f]/.test(text)
    || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) return '弹幕包含不支持的字符, 请修改后发送.'
  return text.trim() ? null : '请输入弹幕内容.'
}

/** One controller owns both the composer and all visible +1 buttons. */
export function useDouyuMessageComposer({ connected, room }: { connected: boolean; room: string | null }) {
  const [account, setAccount] = useState<ActiveAccount | null>(null)
  const [loading, setLoading] = useState(true)
  const [accountError, setAccountError] = useState('')
  const [draft, setDraftState] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<DouyuMessageOutcome | null>(null)
  const [nextAllowedAt, setNextAllowedAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now)
  const mounted = useRef(false)
  const accountRevision = useRef(0)
  const taskRevision = useRef(0)
  const taskAccount = useRef<string | null | undefined>(undefined)
  const displayedAccount = useRef<ActiveAccount | null>(null)
  const contextVersion = useRef(0)
  const draftRef = useRef('')
  const draftVersion = useRef(0)
  const inFlight = useRef<SendOperation | null>(null)
  const cooldown = useRef<number | null>(null)

  const resetContext = useCallback(() => {
    contextVersion.current++
    draftVersion.current++
    draftRef.current = ''
    cooldown.current = null
    setDraftState('')
    setNotice(null)
    setNextAllowedAt(null)
  }, [])

  const refreshAccounts = useCallback(async () => {
    if (!mounted.current) return
    const version = ++accountRevision.current
    setLoading(true)
    try {
      const result = await apiClient.listDouyuAccounts()
      if (!mounted.current || version !== accountRevision.current) return
      if (!result.ok || !Array.isArray(result.value?.accounts)) throw new Error('Unavailable account snapshot')
      const selected = result.value.accounts.find(item => item.id === result.value.activeAccountId)
      const current = selected && typeof selected.id === 'string' && typeof selected.label === 'string'
        ? { id: selected.id, label: selected.label, loggedIn: selected.login?.loggedIn === true, busy: selected.busy === true }
        : null
      displayedAccount.current = current
      setAccount(current)
      setAccountError('')
    } catch {
      if (!mounted.current || version !== accountRevision.current) return
      displayedAccount.current = null
      setAccount(null)
      setAccountError('无法确认当前账号, 请到片源设置刷新账号状态.')
    } finally {
      if (mounted.current && version === accountRevision.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    let active = true
    let requestedAccounts = false
    const initialTaskVersion = taskRevision.current
    const applyTaskAccount = (snapshot: DouyuTasksSnapshot, refresh: boolean) => {
      if (!active || !snapshot || (snapshot.activeAccountId !== null && typeof snapshot.activeAccountId !== 'string')) return
      const previous = taskAccount.current
      const next = snapshot.activeAccountId
      taskAccount.current = next
      const changed = previous !== undefined && previous !== next
        || displayedAccount.current !== null && displayedAccount.current.id !== next
      if (changed) {
        // Invalidate a reply immediately, before the account metadata refresh resolves.
        resetContext()
        displayedAccount.current = null
        setAccount(null)
      }
      if (refresh || changed) { requestedAccounts = true; void refreshAccounts() }
    }
    const unsubscribe = apiClient.subscribeDouyuTasks(snapshot => {
      taskRevision.current++
      applyTaskAccount(snapshot, true)
    })
    if (!requestedAccounts) void refreshAccounts()
    void apiClient.getDouyuTasks().then(result => {
      if (active && initialTaskVersion === taskRevision.current && result.ok) applyTaskAccount(result.value, false)
    }).catch(() => { /* Account reads remain available if task notifications are unavailable. */ })
    const refresh = () => { void refreshAccounts() }
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      mounted.current = false
      accountRevision.current++
      taskRevision.current++
      contextVersion.current++
      unsubscribe()
      window.removeEventListener('focus', refresh)
    }
  }, [refreshAccounts, resetContext])

  const problem = !connected || !room || !/^[1-9]\d{0,11}$/.test(room) ? '连接斗鱼弹幕后才能发送.'
    : loading ? '正在读取当前斗鱼账号...'
      : accountError || (!account?.loggedIn ? accountUnavailable : account.busy ? '账号正在处理登录操作, 请稍后发送.' : null)
  const key = JSON.stringify([connected, room, account?.id, account?.loggedIn, account?.busy])
  const currentContext = useRef<MessageContext>({ key, account, room, problem })
  useLayoutEffect(() => {
    if (currentContext.current.key !== key) resetContext()
    currentContext.current = { key, account, room, problem }
  }, [key, account, room, problem, resetContext])

  const cooling = nextAllowedAt !== null && nextAllowedAt > now
  useEffect(() => {
    if (!cooling) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [cooling, nextAllowedAt])

  const setDraft = useCallback((text: string) => {
    draftRef.current = text
    draftVersion.current++
    setDraftState(text)
  }, [])

  const send = useCallback(async (text: string, fromDraft: boolean) => {
    const current = currentContext.current
    if (!mounted.current || inFlight.current || current.problem || !current.account || !current.room
      || (cooldown.current !== null && cooldown.current > Date.now()) || textProblem(text)) return
    const operation: SendOperation = { context: contextVersion.current, draftVersion: fromDraft ? draftVersion.current : null }
    // Synchronous, so two clicks before React paints still dispatch only one IPC.
    inFlight.current = operation
    setPending(true)
    setNotice(null)
    const input = { accountId: current.account.id, room: current.room, text, color: 0 }
    try {
      const response = await apiClient.sendDouyuMessage(input)
      if (!mounted.current || operation.context !== contextVersion.current) return
      const value = response.ok ? response.value : { status: 'failed' as const, message: response.message, nextAllowedAt: null }
      if (!value || !['succeeded', 'waiting-user', 'failed'].includes(value.status) || typeof value.message !== 'string') throw new Error('Unknown send result')
      setNotice(value)
      const deadline = typeof value.nextAllowedAt === 'number' && Number.isFinite(value.nextAllowedAt) && value.nextAllowedAt > Date.now()
        ? value.nextAllowedAt : null
      cooldown.current = deadline
      setNextAllowedAt(deadline)
      setNow(Date.now())
      if (value.status === 'succeeded' && operation.draftVersion !== null && operation.draftVersion === draftVersion.current) setDraft('')
    } catch {
      if (mounted.current && operation.context === contextVersion.current) setNotice({ status: 'waiting-user', message: uncertain, nextAllowedAt: null })
    } finally {
      if (inFlight.current === operation) {
        inFlight.current = null
        if (mounted.current) setPending(false)
      }
    }
  }, [setDraft])

  const remaining = nextAllowedAt === null ? 0 : Math.max(0, Math.ceil((nextAllowedAt - now) / 1000))
  const blockedReason = problem || (pending ? '正在处理上一条发送...' : remaining > 0 ? `还需等待 ${remaining} 秒后发送.` : null)
  return {
    account, room, draft, setDraft, pending, notice, remaining, blockedReason, refreshAccounts,
    // Initial identity/room resolution resets the context. Do not accept typing
    // before that boundary; ordinary same-account refreshes can keep the editor live.
    canEdit: connected && !!room && /^[1-9]\d{0,11}$/.test(room) && account?.loggedIn === true && !account.busy,
    draftProblem: textProblem(draft),
    canSendText: (text: string) => !blockedReason && !textProblem(text),
    repeatProblem: (text: string) => blockedReason || textProblem(text),
    sendDraft: () => send(draftRef.current, true),
    repeat: (text: string) => send(text, false),
  }
}

export function DouyuMessageComposer({ controller }: { controller: ReturnType<typeof useDouyuMessageComposer> }): React.ReactNode {
  const inputId = useId()
  const hintId = useId()
  const composing = useRef(false)
  return <form className="douyu-message-composer" aria-label="发送斗鱼弹幕" onSubmit={event => {
    event.preventDefault()
    if (!composing.current) void controller.sendDraft()
  }}>
    <div className="douyu-message-heading"><strong>发送弹幕</strong><span>普通色</span></div>
    <p className="douyu-message-context">当前账号: {controller.account?.label ?? '未选择'} / 房间: {controller.room ?? '未连接'}</p>
    <label htmlFor={inputId}>弹幕内容</label>
    <textarea id={inputId} rows={2} value={controller.draft} aria-describedby={hintId} disabled={!controller.canEdit}
      placeholder="输入一条弹幕" spellCheck={false}
      onChange={event => controller.setDraft(event.target.value)}
      onFocus={() => { void controller.refreshAccounts() }}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={() => { composing.current = false }}
      onKeyDown={event => {
        if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
        event.preventDefault()
        void controller.sendDraft()
      }} />
    <div className="douyu-message-actions"><span>{controller.draft.length}/500</span>
      <button type="submit" disabled={!controller.canSendText(controller.draft)}>发送</button>
    </div>
    <p id={hintId} className="douyu-message-hint">+1 会立即复读对应弹幕一次.</p>
    {controller.blockedReason && <p className="douyu-message-hint">{controller.blockedReason}</p>}
    {controller.draft.length > 0 && controller.draftProblem && <p className="douyu-message-validation">{controller.draftProblem}</p>}
    {controller.notice && <p role="status" className="douyu-message-result" data-state={controller.notice.status}>{controller.notice.message}</p>}
  </form>
}
