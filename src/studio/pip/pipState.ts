/**
 * Reading the enhanced PiP state and the danmaku display preferences, for both the `/pip`
 * window and the settings sheet in the main window.
 *
 * Both follow the handoff's order: subscribe first, then read the snapshot. A pushed event
 * that lands before the snapshot reply is newer than that reply, so the late reply is
 * dropped instead of rolling the state back.
 */

import { useCallback, useEffect, useState } from 'react'
import { useErrorState } from '../../ui/ErrorDetails'
import { displayError, type ErrorDetails } from '../../core/errorDetails'
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
  errorDetail?: ErrorDetails | null
  /** Take a state returned directly by a call (options change, recovery, re-read). */
  apply: (state: PipState) => void
}

export function usePipState(): PipStateView {
  const [state, setState] = useState<PipState | null>(null)
  const [error, setError, errorDetail] = useErrorState(null)

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
      if (pushed) return
      if (!result.ok) { setError(result); return }
      if (isPipState(result.value)) setState(result.value)
      else setError(displayError(result, '无法读取画中画状态'))
    }).catch(caught => { if (live && !pushed) setError(caught) })
    return () => { live = false; off() }
  }, [])

  const apply = useCallback((next: PipState) => { if (isPipState(next)) { setState(next); setError(null) } }, [setError])
  return { state, error, errorDetail, apply }
}

/** Read diagnostic fields without including the stream source or send context. */
export function pipFailure(state: PipState): unknown {
  const failure = state as PipState & { errorDetail?: unknown; detail?: unknown }
  return failure.errorDetail ?? failure.detail ?? { phase: state.phase, message: state.message }
}

/** Display preferences for this window's own danmaku processor. */
export function useDanmakuPreferences(onError?: (error: unknown) => void): DanmakuPreferences {
  const [preferences, setPreferences] = useState<DanmakuPreferences>(() => ({ ...DEFAULT_DANMAKU_PREFERENCES }))

  useEffect(() => {
    let live = true
    let pushed = false
    const take = (raw: unknown): boolean => {
      const parsed = readDanmakuPreferences(raw)
      if (parsed) { setPreferences(parsed); onError?.(null) }
      return !!parsed
    }
    const off = apiClient.subscribeFeatures((event) => {
      if (!live || event.topic !== 'danmaku-preferences' || !event.data || typeof event.data !== 'object') return
      if (take((event.data as { preferences?: unknown }).preferences)) pushed = true
    })
    void apiClient.feature('getDanmakuFeatures', undefined).then((result) => {
      if (!live || pushed) return
      if (!result.ok) { onError?.(result); return }
      if (!take(result.value.preferences)) onError?.(displayError({ code: 'invalid-preferences' }, '无法读取弹幕显示设置'))
    }).catch(caught => { if (live && !pushed) onError?.(caught) })
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
