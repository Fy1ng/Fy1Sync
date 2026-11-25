/**
 * Accounts and tasks for the Douyu desk, as one live view.
 *
 * Account changes and task changes are separate lanes with their own in-flight guard, so a
 * login window left open never stops someone from pausing a running task. Task snapshots
 * also arrive pushed from the executor; an action's reply is only applied if nothing newer
 * came in while it was waiting.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiClient, type ApiResult } from '../../app/apiClient'
import type { DouyuAccountsSnapshot, DouyuAccountSummary, DouyuTasksSnapshot, DouyuTaskView } from '../../../server/douyu/types'
import { remember, remembered, useRemembered } from '../../app/remembered'
import { displayError, type DisplayError } from '../../core/errorDetails'
import { failedLane, IDLE, useTaskActions, withTaskWrites, type Lane } from './taskActions'

const validAccounts = (value: unknown): value is DouyuAccountsSnapshot =>
  !!value && Array.isArray((value as DouyuAccountsSnapshot).accounts)
const validTasks = (value: unknown): value is DouyuTasksSnapshot =>
  !!value && Array.isArray((value as DouyuTasksSnapshot).tasks) && Array.isArray((value as DouyuTasksSnapshot).retainedRooms)

export function roomTaskStartBlock(account: DouyuAccountSummary | undefined, activeId: string | null): string {
  return !account ? '账号已删除' : account.id !== activeId ? `请先在账号中将 ${account.label} 设为当前账号`
    : !account.login.loggedIn ? `请先登录 ${account.label}` : ''
}

export function useDouyu(writesEnabled: () => boolean = () => false) {
  // Last read first, so reopening the desk shows accounts and tasks at once; the reads below
  // and the pushed snapshots bring them up to date.
  const [accounts, setAccounts] = useRemembered<DouyuAccountsSnapshot | null>('douyu:accounts', null)
  const [tasks, setTasks] = useRemembered<DouyuTasksSnapshot | null>('douyu:tasks', null)
  const [accountLane, setAccountLane] = useState<Lane>(IDLE)
  const [accountWorking, setAccountWorking] = useState(false)
  const [loading, setLoading] = useState(() => remembered('douyu:accounts') === undefined)
  const [tasksLoading, setTasksLoading] = useState(() => remembered('douyu:tasks') === undefined)
  const [accountsReadFailure, setAccountsReadFailure] = useState<DisplayError | null>(null)
  const [tasksReadFailure, setTasksReadFailure] = useState<DisplayError | null>(null)
  const accountsReading = useRef(false)
  const tasksReading = useRef(false)
  const mounted = useRef(false)
  const accountBusy = useRef(false)
  const latestAccounts = useRef(accounts)
  latestAccounts.current = accounts
  const taskRevision = useRef(0)
  // Main's snapshot revision: a snapshot older than the one shown is dropped, so a slow first
  // read cannot overwrite a pushed one. -1 until anything has landed.
  const accountRevision = useRef(-1)
  useEffect(() => {
    if (accounts && typeof accounts.revision === 'number' && accounts.revision > accountRevision.current) {
      accountRevision.current = accounts.revision
    }
    if (accounts !== null && loading && !accountsReading.current) setLoading(false)
  }, [accounts, loading])
  const takeAccounts = useCallback((next: DouyuAccountsSnapshot): boolean => {
    const revision = typeof next.revision === 'number' ? next.revision : accountRevision.current + 1
    if (revision < accountRevision.current) return false
    accountRevision.current = revision
    latestAccounts.current = next
    // An unmounted view's setState is dropped, so the remembered copy is written directly too.
    remember('douyu:accounts', next)
    if (mounted.current) { setAccounts(next); setAccountsReadFailure(null) }
    return true
  }, [setAccounts])

  const reloadAccounts = useCallback(async (): Promise<void> => {
    if (accountsReading.current) return
    accountsReading.current = true
    const revision = accountRevision.current
    setLoading(true); setAccountsReadFailure(null)
    try {
      const result = await apiClient.listDouyuAccounts()
      if (!mounted.current) return
      if (result.ok && validAccounts(result.value)) takeAccounts(result.value)
      else if (revision === accountRevision.current) setAccountsReadFailure(displayError(result, result.ok ? '无法读取斗鱼账号' : undefined))
    } catch (error) {
      if (mounted.current && revision === accountRevision.current) setAccountsReadFailure(displayError(error, '无法读取斗鱼账号'))
    } finally {
      accountsReading.current = false
      if (mounted.current) setLoading(false)
    }
  }, [takeAccounts])

  const reloadTasks = useCallback(async (): Promise<void> => {
    if (tasksReading.current) return
    tasksReading.current = true
    const revision = taskRevision.current
    setTasksLoading(true); setTasksReadFailure(null)
    try {
      const result = await apiClient.getDouyuTasks()
      if (!mounted.current || revision !== taskRevision.current) return
      if (result.ok && validTasks(result.value)) setTasks(result.value)
      else setTasksReadFailure(displayError(result, result.ok ? '无法读取任务' : undefined))
    } catch (error) {
      if (mounted.current && revision === taskRevision.current) setTasksReadFailure(displayError(error, '无法读取任务'))
    } finally {
      tasksReading.current = false
      if (mounted.current) setTasksLoading(false)
    }
  }, [setTasks])

  useEffect(() => {
    mounted.current = true
    let live = true
    // Subscribe before the first read, so a change in between is not missed.
    const unsubscribeAccounts = apiClient.subscribeDouyuAccounts((snapshot) => {
      if (live && validAccounts(snapshot)) { takeAccounts(snapshot); setLoading(false) }
    })
    const unsubscribe = apiClient.subscribeDouyuTasks((snapshot) => {
      if (!live || !validTasks(snapshot)) return
      taskRevision.current++
      setTasks(snapshot)
      setTasksReadFailure(null); setTasksLoading(false)
    })
    void reloadAccounts()
    void reloadTasks()
    return () => { live = false; mounted.current = false; unsubscribe(); unsubscribeAccounts() }
  }, [])

  const accountAction = useCallback(async (
    pending: string,
    work: () => Promise<ApiResult<DouyuAccountsSnapshot>>,
    done: string | ((snapshot: DouyuAccountsSnapshot) => string | DisplayError),
    report: (lane: Lane) => void = setAccountLane,
  ): Promise<boolean> => {
    if (accountBusy.current) {
      if (report !== setAccountLane) report({ ...IDLE, error: '账号正在处理，请稍后重试' })
      return false
    }
    accountBusy.current = true
    setAccountWorking(true)
    report({ ...IDLE, pending })
    try {
      const result = await work()
      // Kept even when this view has gone: a login that finishes after the viewer left
      // 斗鱼 must not leave the remembered snapshot reading 处理中 for the next view.
      if (result.ok && validAccounts(result.value)) takeAccounts(result.value)
      if (!mounted.current) return false
      if (!result.ok) { report(failedLane(result)); return false }
      if (!validAccounts(result.value)) { report(failedLane(result, '无法读取斗鱼账号')); return false }
      const outcome = typeof done === 'function' ? done(result.value) : done
      if (typeof outcome !== 'string') {
        report(failedLane(outcome.detail ?? outcome, outcome.message))
        return false
      }
      report({ ...IDLE, notice: outcome })
      return true
    } catch (error) {
      if (mounted.current) report(failedLane(error, '操作未完成，请重试'))
      return false
    } finally {
      accountBusy.current = false
      if (mounted.current) setAccountWorking(false)
    }
  }, [takeAccounts])

  const taskActions = useTaskActions({ snapshot: tasks, valid: validTasks, revision: taskRevision, mounted, invalidMessage: '无法读取任务',
    apply: (value) => { if (value) setTasks(value); setTasksReadFailure(null) } })

  const startRoomTask = (task: DouyuTaskView): Promise<ApiResult<DouyuTasksSnapshot>> => withTaskWrites(writesEnabled, async () => {
    const current = latestAccounts.current
    const account = current?.accounts.find((item) => item.id === task.accountId)
    const blocked = roomTaskStartBlock(account, current?.activeAccountId ?? null)
    if (blocked) return { ok: false, code: 'account-unavailable', message: blocked }
    if (accountBusy.current || current?.accounts.some((item) => item.busy)) {
      return { ok: false, code: 'account-busy', message: '账号正在处理，请稍后启动任务' }
    }
    return apiClient.startDouyuTask(task.id)
  })

  const openTaskRoom = (id: string): Promise<boolean> => taskActions.run((report) =>
    accountAction('请在打开的官方窗口中处理，完成后关闭该窗口', () => apiClient.openDouyuTaskRoom(id),
      '官方窗口已关闭，请核对结果后手动启动', report), id)

  const all = accounts?.accounts ?? []
  const active = all.find((account) => account.id === accounts?.activeAccountId) ?? null
  const accountsBusy = accountWorking || all.some((account) => account.busy)

  return { accounts, tasks, all, active, loading, tasksLoading,
    accountsReadError: accountsReadFailure?.message ?? '', accountsReadDetail: accountsReadFailure?.detail,
    tasksReadError: tasksReadFailure?.message ?? '', tasksReadDetail: tasksReadFailure?.detail,
    reloadAccounts, reloadTasks, accountLane, accountsBusy, accountAction, taskActions, startRoomTask, openTaskRoom, writesEnabled }
}

export type DouyuData = ReturnType<typeof useDouyu>

/**
 * What an account is called on screen: its Douyu name once signed in. The built-in first
 * account's placeholder label is not a name, so before login it shows only its state; a
 * label the viewer gave is kept.
 */
export function accountName(account: { id: string; label: string; login: { loggedIn: boolean; nickname?: string } }): string {
  if (account.login.loggedIn && account.login.nickname) return account.login.nickname
  return account.id === 'default' && account.label === '默认账号' ? '' : account.label
}

export function accountState(account: { busy: boolean; login: { loggedIn: boolean; canSend?: boolean; expiresAt?: number | null } }): string {
  if (account.busy) return '处理中'
  if (!account.login.loggedIn) return '未登录'
  if (account.login.canSend === false) return '已登录 · 不能发送弹幕，请重新登录'
  const at = account.login.expiresAt ? new Date(account.login.expiresAt * 1000) : null
  return at && Number.isFinite(at.getTime()) ? `已登录 · ${at.toLocaleDateString('zh-CN')} 到期` : '已登录'
}
