/**
 * Reading the enhanced PiP state and the danmaku display preferences, for both the `/pip`
 * window and the settings sheet in the main window.
 *
 * Both follow the handoff's order: subscribe first, then read the snapshot. A pushed event
 * that lands before the snapshot reply is newer than that reply, so the late reply is
 * dropped instead of rolling the state back.
 */

import { useCallback, useEffect, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { PipState } from '../../../electron/pipManager'
import { readDanmakuPreferences, DEFAULT_DANMAKU_PREFERENCES, type DanmakuPreferences } from '../../core/danmakuProcessing'

const PHASES = new Set<string>(['closed', 'opening', 'ready', 'failed'])

/** Enough shape checking that a malformed event cannot crash the page. */
export function isPipState(value: unknown): value is PipState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<PipState>
  return typeof state.phase === 'string' && PHASES.has(state.phase)
    && !!state.options && typeof state.options === 'object'
    && !!state.sendContext && typeof state.sendContext === 'object'
    && typeof state.recoveryRevision === 'number'
}

export interface PipStateView {
  state: PipState | null
  /** Why the first read failed, when it did. */
  error: string | null
  /** Take a state returned directly by a call (options change, recovery, re-read). */
  apply: (state: PipState) => void
}

export function usePipState(): PipStateView {
  const [state, setState] = useState<PipState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    let pushed = false
    const off = apiClient.subscribeFeatures((event) => {
      if (!live || event.topic !== 'pip' || !isPipState(event.data)) return
      pushed = true
      setState(event.data)
      setError(null)
    })
    void apiClient.feature('getEnhancedPip', undefined).then((result) => {
      if (!live) return
      if (!result.ok) { if (!pushed) setError(result.message); return }
      if (!pushed && isPipState(result.value)) setState(result.value)
    })
    return () => { live = false; off() }
  }, [])

  const apply = useCallback((next: PipState) => { if (isPipState(next)) setState(next) }, [])
  return { state, error, apply }
}

/** Display preferences for this window's own danmaku processor. */
export function useDanmakuPreferences(): DanmakuPreferences {
  const [preferences, setPreferences] = useState<DanmakuPreferences>(() => ({ ...DEFAULT_DANMAKU_PREFERENCES }))

  useEffect(() => {
    let live = true
    let pushed = false
    const take = (raw: unknown): boolean => {
      const parsed = readDanmakuPreferences(raw)
      if (parsed) setPreferences(parsed)
      return !!parsed
    }
    const off = apiClient.subscribeFeatures((event) => {
      if (!live || event.topic !== 'danmaku-preferences' || !event.data || typeof event.data !== 'object') return
      if (take((event.data as { preferences?: unknown }).preferences)) pushed = true
    })
    void apiClient.feature('getDanmakuFeatures', undefined).then((result) => {
      if (live && !pushed && result.ok) take(result.value.preferences)
    })
    return () => { live = false; off() }
  }, [])

  return preferences
}

export const PHASE_TEXT: Record<PipState['phase'], string> = {
  closed: '未打开',
  opening: '正在打开',
  ready: '已打开',
  failed: '已失败',
}
