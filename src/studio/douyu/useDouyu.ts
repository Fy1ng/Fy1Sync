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
import type { DouyuAccountsSnapshot, DouyuTasksSnapshot } from '../../../server/douyu/types'
import { remember, remembered, useRemembered } from '../../app/remembered'

export interface Lane {
  pending: string
  notice: string
  error: string
}

const IDLE: Lane = { pending: '', notice: '', error: '' }

const validAccounts = (value: unknown): value is DouyuAccountsSnapshot =>
  !!value && Array.isArray((value as DouyuAccountsSnapshot).accounts)
const validTasks = (value: unknown): value is DouyuTasksSnapshot =>
  !!value && Array.isArray((value as DouyuTasksSnapshot).tasks) && Array.isArray((value as DouyuTasksSnapshot).retainedRooms)

export function useDouyu() {
  // Last read first, so reopening the desk shows accounts and tasks at once; the reads below
  // and the pushed snapshots bring them up to date.
  const [accounts, setAccounts] = useRemembered<DouyuAccountsSnapshot | null>('douyu:accounts', null)
  const [tasks, setTasks] = useRemembered<DouyuTasksSnapshot | null>('douyu:tasks', null)
  const [accountLane, setAccountLane] = useState<Lane>(IDLE)
  const [taskLane, setTaskLane] = useState<Lane>(IDLE)
  const [loading, setLoading] = useState(() => remembered('douyu:accounts') === undefined)
  const mounted = useRef(false)
  const accountBusy = useRef(false)
  const taskBusy = useRef(false)
  const taskRevision = useRef(0)
  // Main's snapshot revision: a snapshot older than the one shown is dropped, so a slow first
  // read cannot overwrite a pushed one. -1 until anything has landed.
  const accountRevision = useRef(-1)
  const takeAccounts = useCallback((next: DouyuAccountsSnapshot): boolean => {
    const revision = typeof next.revision === 'number' ? next.revision : accountRevision.current + 1
    if (revision < accountRevision.current) return false
    accountRevision.current = revision
    // An unmounted view's setState is dropped, so the remembered copy is written directly too.
    remember('douyu:accounts', next)
    if (mounted.current) setAccounts(next)
    return true
  }, [setAccounts])

  useEffect(() => {
    mounted.current = true
    let live = true
    // Subscribe before the first read, so a change in between is not missed.
    const unsubscribeAccounts = apiClient.subscribeDouyuAccounts((snapshot) => {
      if (live && validAccounts(snapshot)) takeAccounts(snapshot)
    })
    const unsubscribe = apiClient.subscribeDouyuTasks((snapshot) => {
      if (!live || !validTasks(snapshot)) return
      taskRevision.current++
      setTasks(snapshot)
    })
    const firstTasks = taskRevision.current
    void Promise.all([
      apiClient.listDouyuAccounts().then((result) => {
        if (!live) return
        if (result.ok && validAccounts(result.value)) takeAccounts(result.value)
        else setAccountLane({ ...IDLE, error: result.ok ? '无法读取斗鱼账号' : result.message })
      }),
      apiClient.getDouyuTasks().then((result) => {
        if (!live || firstTasks !== taskRevision.current) return
        if (result.ok && validTasks(result.value)) setTasks(result.value)
        else setTaskLane({ ...IDLE, error: result.ok ? '无法读取任务' : result.message })
      }),
    ]).catch(() => {}).finally(() => { if (live) setLoading(false) })
    return () => { live = false; mounted.current = false; unsubscribe(); unsubscribeAccounts() }
  }, [])

  const accountAction = useCallback(async (
    pending: string,
    work: () => Promise<ApiResult<DouyuAccountsSnapshot>>,
    done: string | ((snapshot: DouyuAccountsSnapshot) => string),
  ): Promise<boolean> => {
    if (accountBusy.current) return false
    accountBusy.current = true
    setAccountLane({ pending, notice: '', error: '' })
    try {
      const result = await work()
      // Kept even when this view has gone: a login that finishes after the viewer left
      // 斗鱼 must not leave the remembered snapshot reading 处理中 for the next view.
      if (result.ok && validAccounts(result.value)) takeAccounts(result.value)
      if (!mounted.current) return false
      if (!result.ok) { setAccountLane({ ...IDLE, error: result.message }); return false }
      if (!validAccounts(result.value)) { setAccountLane({ ...IDLE, error: '无法读取斗鱼账号' }); return false }
      setAccountLane({ ...IDLE, notice: typeof done === 'function' ? done(result.value) : done })
      return true
    } catch {
      if (mounted.current) setAccountLane({ ...IDLE, error: '操作未完成，请重试' })
      return false
    } finally {
      accountBusy.current = false
    }
  }, [takeAccounts])

  const taskAction = useCallback(async (
    pending: string,
    work: () => Promise<ApiResult<DouyuTasksSnapshot>>,
    done: string,
  ): Promise<boolean> => {
    if (taskBusy.current) return false
    taskBusy.current = true
    const revision = taskRevision.current
    setTaskLane({ pending, notice: '', error: '' })
    try {
      const result = await work()
      if (!mounted.current) return false
      if (!result.ok) { setTaskLane({ ...IDLE, error: result.message }); return false }
      if (!validTasks(result.value)) { setTaskLane({ ...IDLE, error: '无法读取任务' }); return false }
      if (revision === taskRevision.current) setTasks(result.value)
      setTaskLane({ ...IDLE, notice: done })
      return true
    } catch {
      if (mounted.current) setTaskLane({ ...IDLE, error: '操作未完成，请重试' })
      return false
    } finally {
      taskBusy.current = false
    }
  }, [])

  const all = accounts?.accounts ?? []
  const active = all.find((account) => account.id === accounts?.activeAccountId) ?? null
  const accountsBusy = accountLane.pending !== '' || all.some((account) => account.busy)

  return { accounts, tasks, all, active, loading, accountLane, taskLane, accountsBusy, accountAction, taskAction }
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
