/**
 * The send box's controller.
 *
 * It keeps the account and room guards of the old player's composer:
 * one send in flight, the draft cleared only when that
 * draft was the one sent, the gateway cooldown honoured, everything reset when the account
 * or room changes. What changes is the path out:
 *
 * - Sends go through `sendComposedDouyuMessage`. A typed message is `mode: 'message'`, so the
 *   prefix/suffix apply; a "+1" is `mode: 'repeat'` and goes out verbatim.
 * - Length is checked on the composed text, and against the platform's own limit once a
 *   send has reported it.
 * - After a send the delivery record is followed until its deadline: the gateway accepting a
 *   message and the message appearing in the room are two separate facts, and neither one
 *   is a reason to send again.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { composeMessage, DEFAULT_MESSAGE_AFFIXES, MessageCompositionError, type MessageAffixes } from '../core/messageComposition'
import type { DanmakuFeaturesSnapshot } from '../../electron/danmakuFeatures'
import type { DeliveryEvidence } from '../../server/danmaku/deliveryTracker'
import type { DouyuMessageOutcome, DouyuTasksSnapshot } from '../../server/douyu/types'

type ActiveAccount = { id: string; label: string; loggedIn: boolean; busy: boolean }
type SendMode = 'message' | 'repeat'
type SendOperation = { context: number; draftVersion: number | null }

const UNCERTAIN = '发送结果无法确认。请在官方直播间核对后再决定是否重发。'
const DELIVERY_POLL_MS = 1500

export function useStudioComposer({ connected, room }: { connected: boolean; room: string | null }) {
  const [account, setAccount] = useState<ActiveAccount | null>(null)
  const [loading, setLoading] = useState(true)
  const [accountError, setAccountError] = useState('')
  const [draft, setDraftState] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<DouyuMessageOutcome | null>(null)
  const [delivery, setDelivery] = useState<DeliveryEvidence | null>(null)
  const [nextAllowedAt, setNextAllowedAt] = useState<number | null>(null)
  const [serverLimit, setServerLimit] = useState<number | null>(null)
  const [affixes, setAffixes] = useState<MessageAffixes>({ ...DEFAULT_MESSAGE_AFFIXES })
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
  const deliveryWatch = useRef(0)

  const resetContext = useCallback(() => {
    contextVersion.current++
    draftVersion.current++
    deliveryWatch.current++
    draftRef.current = ''
    cooldown.current = null
    setDraftState('')
    setNotice(null)
    setDelivery(null)
    setNextAllowedAt(null)
  }, [])

  const refreshAccounts = useCallback(async () => {
    if (!mounted.current) return
    const version = ++accountRevision.current
    // Only the first read blocks sending. Later refreshes (focus, task events) re-check the
    // same account in the background; holding Enter hostage to a cookie read for a second or
    // two each time the box is focused made sending look broken.
    if (displayedAccount.current === null) setLoading(true)
    try {
      const result = await apiClient.listDouyuAccounts()
      if (!mounted.current || version !== accountRevision.current) return
      if (!result.ok || !Array.isArray(result.value?.accounts)) throw new Error('Unavailable account snapshot')
      const selected = result.value.accounts.find((item) => item.id === result.value.activeAccountId)
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
      setAccountError('无法确认当前账号，请在斗鱼账号中刷新状态。')
    } finally {
      if (mounted.current && version === accountRevision.current) setLoading(false)
    }
  }, [])

  // Accounts, and the active account switching underneath an open draft.
  useEffect(() => {
    mounted.current = true
    let active = true
    let requestedAccounts = false
    const initialTaskVersion = taskRevision.current
    const applyTaskAccount = (snapshot: DouyuTasksSnapshot, refresh: boolean): void => {
      if (!active || !snapshot || (snapshot.activeAccountId !== null && typeof snapshot.activeAccountId !== 'string')) return
      const previous = taskAccount.current
      const next = snapshot.activeAccountId
      taskAccount.current = next
      const changed = (previous !== undefined && previous !== next)
        || (displayedAccount.current !== null && displayedAccount.current.id !== next)
      if (changed) {
        // Invalidate a reply immediately, before the account metadata refresh resolves.
        resetContext()
        displayedAccount.current = null
        setAccount(null)
      }
      if (refresh || changed) { requestedAccounts = true; void refreshAccounts() }
    }
    const unsubscribe = apiClient.subscribeDouyuTasks((snapshot) => {
      taskRevision.current++
      applyTaskAccount(snapshot, true)
    })
    if (!requestedAccounts) void refreshAccounts()
    void apiClient.getDouyuTasks().then((result) => {
      if (active && initialTaskVersion === taskRevision.current && result.ok) applyTaskAccount(result.value, false)
    }).catch(() => { /* Account reads stay available without task notifications. */ })
    const refresh = (): void => { void refreshAccounts() }
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      mounted.current = false
      accountRevision.current++
      taskRevision.current++
      contextVersion.current++
      deliveryWatch.current++
      unsubscribe()
      window.removeEventListener('focus', refresh)
    }
  }, [refreshAccounts, resetContext])

  // Prefix and suffix: subscribe first, then read, and let a newer event win.
  useEffect(() => {
    let live = true
    let evented = false
    const off = apiClient.subscribeFeatures((event) => {
      if (event.topic !== 'danmaku-preferences' || !event.data || typeof event.data !== 'object') return
      const next = (event.data as Partial<DanmakuFeaturesSnapshot>).affixes
      if (next) { evented = true; setAffixes(next) }
    })
    void apiClient.feature('getDanmakuFeatures', undefined).then((result) => {
      if (live && !evented && result.ok) setAffixes(result.value.affixes)
    })
    return () => { live = false; off() }
  }, [])

  const problem = !connected || !room || !/^[1-9]\d{0,11}$/.test(room) ? '连接斗鱼弹幕后才能发送。'
    : loading ? '正在读取当前斗鱼账号…'
      : accountError || (!account?.loggedIn ? '请在斗鱼账号中登录并设为当前账号。' : account.busy ? '账号正在处理登录操作，请稍后发送。' : null)
  const key = JSON.stringify([connected, room, account?.id, account?.loggedIn, account?.busy])
  const currentContext = useRef({ key, account, room, problem })
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

  const composed = useCallback((text: string, mode: SendMode): { text: string | null; problem: string | null } => {
    try {
      const value = composeMessage(text, { affixes, mode })
      if (serverLimit !== null && value.length > serverLimit) return { text: value, problem: `超过平台当前允许的 ${serverLimit} 字。` }
      return { text: value, problem: null }
    } catch (error) {
      return { text: null, problem: error instanceof MessageCompositionError ? error.message : '弹幕内容无效。' }
    }
  }, [affixes, serverLimit])

  /** Follow one delivery record until it settles or its deadline passes. Never resends. */
  const watchDelivery = useCallback((accountId: string, id: string) => {
    const watch = ++deliveryWatch.current
    const poll = async (): Promise<void> => {
      if (!mounted.current || watch !== deliveryWatch.current) return
      const result = await apiClient.feature('getDouyuDelivery', { accountId, id })
      if (!mounted.current || watch !== deliveryWatch.current || !result.ok || !result.value) return
      const evidence = result.value
      setDelivery(evidence)
      const settled = evidence.roomEcho !== 'pending' || evidence.gateway === 'rejected'
      if (!settled && Date.now() < evidence.deadlineAt) window.setTimeout(() => void poll(), DELIVERY_POLL_MS)
    }
    void poll()
  }, [])

  const send = useCallback(async (text: string, mode: SendMode, fromDraft: boolean) => {
    const current = currentContext.current
    if (!mounted.current || inFlight.current || current.problem || !current.account || !current.room
      || (cooldown.current !== null && cooldown.current > Date.now()) || composed(text, mode).problem) return
    const operation: SendOperation = { context: contextVersion.current, draftVersion: fromDraft ? draftVersion.current : null }
    // Synchronous, so two clicks before React paints still dispatch only one IPC.
    inFlight.current = operation
    setPending(true)
    setNotice(null)
    setDelivery(null)
    deliveryWatch.current++
    const accountId = current.account.id
    try {
      const response = await apiClient.feature('sendComposedDouyuMessage', { accountId, room: current.room, text, color: 0, mode })
      if (!mounted.current || operation.context !== contextVersion.current) return
      const value = response.ok ? response.value : { status: 'failed' as const, message: response.message, nextAllowedAt: null }
      if (!value || !['succeeded', 'waiting-user', 'failed'].includes(value.status) || typeof value.message !== 'string') throw new Error('Unknown send result')
      setNotice(value)
      if (value.messageLimit) setServerLimit(value.messageLimit.effectiveMaximumUnits)
      const deadline = typeof value.nextAllowedAt === 'number' && Number.isFinite(value.nextAllowedAt) && value.nextAllowedAt > Date.now()
        ? value.nextAllowedAt : null
      cooldown.current = deadline
      setNextAllowedAt(deadline)
      setNow(Date.now())
      if (value.deliveryId) watchDelivery(accountId, value.deliveryId)
      if (value.status === 'succeeded' && operation.draftVersion !== null && operation.draftVersion === draftVersion.current) setDraft('')
    } catch {
      if (mounted.current && operation.context === contextVersion.current) setNotice({ status: 'waiting-user', message: UNCERTAIN, nextAllowedAt: null })
    } finally {
      if (inFlight.current === operation) {
        inFlight.current = null
        if (mounted.current) setPending(false)
      }
    }
  }, [composed, setDraft, watchDelivery])

  const remaining = nextAllowedAt === null ? 0 : Math.max(0, Math.ceil((nextAllowedAt - now) / 1000))
  const blockedReason = problem || (pending ? '正在处理上一条发送…' : remaining > 0 ? `请在 ${remaining} 秒后发送。` : null)
  const draftComposition = composed(draft, 'message')
  return {
    account, room, draft, setDraft, pending, notice, delivery, remaining, blockedReason, refreshAccounts, affixes,
    // Initial identity/room resolution resets the context. Do not accept typing before
    // that boundary; ordinary same-account refreshes keep the editor live.
    canEdit: connected && !!room && /^[1-9]\d{0,11}$/.test(room) && account?.loggedIn === true && !account.busy,
    draftProblem: draftComposition.problem,
    /** Length of what will actually be sent, prefix and suffix included. */
    composedLength: draftComposition.text?.length ?? draft.length,
    lengthLimit: serverLimit ?? 500,
    canSendText: (text: string) => !blockedReason && !composed(text, 'repeat').problem,
    repeatProblem: (text: string) => blockedReason || composed(text, 'repeat').problem,
    sendDraft: () => send(draftRef.current, 'message', true),
    repeat: (text: string) => send(text, 'repeat', false),
  }
}

export type StudioComposer = ReturnType<typeof useStudioComposer>

/** One line for the delivery record under the send box, or null when there is none. */
export function deliveryText(evidence: DeliveryEvidence | null): string | null {
  if (!evidence) return null
  const gateway = { pending: '等待平台受理', accepted: '平台已受理', rejected: '平台未受理', unknown: '平台受理情况未知' }[evidence.gateway]
  const echo = { pending: '正在确认房间内显示', observed: '已在房间中显示', 'not-observed': '未在房间中观察到（不代表被屏蔽）' }[evidence.roomEcho]
  return `${gateway} · ${echo}`
}
