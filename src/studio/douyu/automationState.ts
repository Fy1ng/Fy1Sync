/**
 * Live view of the account/batch automations. The `automations` topic is subscribed before
 * the first read, so a push that lands while the read is in flight wins over the older
 * reply. Actions share one in-flight guard; a reply is only applied if no push came in
 * while it was waiting. The renderer never schedules runs itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiClient, type ApiResult } from '../../app/apiClient'
import type { AutomationSnapshot } from '../../../electron/automationManager'
import type { Lane } from './useDouyu'

const IDLE: Lane = { pending: '', notice: '', error: '' }

export const validAutomations = (value: unknown): value is AutomationSnapshot =>
  !!value && typeof value === 'object' && Array.isArray((value as AutomationSnapshot).tasks)

export function useAutomations() {
  const [snapshot, setSnapshot] = useState<AutomationSnapshot | null>(null)
  const [lane, setLane] = useState<Lane>(IDLE)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(false)
  const busy = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    mounted.current = true
    let live = true
    const unsubscribe = apiClient.subscribeFeatures((event) => {
      if (!live || event.topic !== 'automations' || !validAutomations(event.data)) return
      revision.current++
      setSnapshot(event.data)
    })
    const first = revision.current
    void apiClient.feature('getDouyuAutomations', undefined).then((result) => {
      if (!live) return
      if (result.ok && validAutomations(result.value)) { if (first === revision.current) setSnapshot(result.value) }
      else setLane({ ...IDLE, error: result.ok ? '无法读取批量任务' : result.message })
    }).catch(() => {}).finally(() => { if (live) setLoading(false) })
    return () => { live = false; mounted.current = false; unsubscribe() }
  }, [])

  const act = useCallback(async (
    pending: string,
    work: () => Promise<ApiResult<AutomationSnapshot>>,
    done: string,
  ): Promise<boolean> => {
    if (busy.current) return false
    busy.current = true
    const before = revision.current
    setLane({ pending, notice: '', error: '' })
    try {
      const result = await work()
      if (!mounted.current) return false
      if (!result.ok) { setLane({ ...IDLE, error: result.message }); return false }
      if (!validAutomations(result.value)) { setLane({ ...IDLE, error: '无法读取批量任务' }); return false }
      if (before === revision.current) setSnapshot(result.value)
      setLane({ ...IDLE, notice: done })
      return true
    } catch {
      if (mounted.current) setLane({ ...IDLE, error: '操作未完成，请重试' })
      return false
    } finally {
      busy.current = false
    }
  }, [])

  return { snapshot, lane, loading, act }
}
