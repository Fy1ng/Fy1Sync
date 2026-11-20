/**
 * Live view of the account/batch automations. The `automations` topic is subscribed before
 * the first read, so a push that lands while the read is in flight wins over the older
 * reply. Actions share one in-flight guard; a reply is only applied if no push came in
 * while it was waiting. The renderer never schedules runs itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { AutomationSnapshot } from '../../../electron/automationManager'
import { displayError, type DisplayError } from '../../core/errorDetails'
import { useTaskActions } from './taskActions'

export const validAutomations = (value: unknown): value is AutomationSnapshot =>
  !!value && typeof value === 'object' && Array.isArray((value as AutomationSnapshot).tasks)

export function useAutomations(enabled = true) {
  const [snapshot, setSnapshot] = useState<AutomationSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [readFailure, setReadFailure] = useState<DisplayError | null>(null)
  const reading = useRef(false)
  const mounted = useRef(false)
  const revision = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    if (reading.current) return
    reading.current = true
    const before = revision.current
    setLoading(true); setReadFailure(null)
    try {
      const result = await apiClient.feature('getDouyuAutomations', undefined)
      if (!mounted.current || before !== revision.current) return
      if (result.ok && validAutomations(result.value)) setSnapshot(result.value)
      else setReadFailure(displayError(result, result.ok ? '无法读取批量任务' : undefined))
    } catch (error) {
      if (mounted.current && before === revision.current) setReadFailure(displayError(error, '无法读取批量任务'))
    } finally {
      reading.current = false
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!enabled) return
    let live = true
    const unsubscribe = apiClient.subscribeFeatures((event) => {
      if (!live || event.topic !== 'automations' || !validAutomations(event.data)) return
      revision.current++
      setSnapshot(event.data)
      setReadFailure(null); setLoading(false)
    })
    void reload()
    return () => { live = false; unsubscribe() }
  }, [enabled, reload])

  const actions = useTaskActions({ snapshot, valid: validAutomations, revision, mounted, invalidMessage: '无法读取批量任务',
    apply: (value) => { if (value) setSnapshot(value); setReadFailure(null) } })

  return { snapshot, actions, loading, readError: readFailure?.message ?? '', readDetail: readFailure?.detail, reload }
}
