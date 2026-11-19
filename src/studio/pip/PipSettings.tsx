/**
 * Enhanced PiP options in the settings sheet (handoff item 07). The sheet wraps this in
 * its "画中画" group; this renders only the body.
 *
 * Options live in main and apply to the next window as well as an open one, so the
 * switches work whether or not a window is open.
 */

import { useEffect, useRef, useState } from 'react'
import { ErrorText, useErrorState } from '../../ui/ErrorDetails'
import { displayError } from '../../core/errorDetails'
import { apiClient, type ApiResult } from '../../app/apiClient'
import type { PipOptions, PipState } from '../../../electron/pipManager'
import { Switch } from '../kit'
import { PHASE_TEXT, isPipState, pipFailure, usePipState } from './pipState'
import './pip.css'

export function PipSettings(): React.ReactNode {
  const { state, error, errorDetail, apply } = usePipState()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem, problemDetail] = useErrorState(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const run = async (call: () => Promise<ApiResult<PipState>>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      const result = await call()
      if (!mounted.current) return
      if (!result.ok) setProblem(result)
      else if (isPipState(result.value)) apply(result.value)
      else setProblem(displayError({ code: 'invalid-pip-state' }, '无法读取画中画状态'))
    } catch (caught) {
      if (mounted.current) setProblem(caught)
    } finally { if (mounted.current) setBusy(false) }
  }
  const setOption = (patch: Partial<Pick<PipOptions, 'lowPower' | 'recoverStalls'>>): void => {
    void run(() => apiClient.feature('setEnhancedPipOptions', patch))
  }

  const options = state?.options
  const phase = state?.phase ?? null
  const unavailable = !state || busy

  return (
    <div className="pip-settings">
      <div className="row-split">
        <span>增强画中画</span>
        <span className="muted" role="status">{phase ? PHASE_TEXT[phase] : (error ? '状态不可用' : '正在读取')}</span>
      </div>
      <Switch label="低功耗" detail="暂停主窗口识别、自动对齐和小窗弹幕"
        checked={options?.lowPower ?? false} disabled={unavailable}
        onChange={(lowPower) => setOption({ lowPower })} />
      <Switch label="卡顿时自动恢复" detail="卡顿时尝试重新载入"
        checked={options?.recoverStalls ?? true} disabled={unavailable}
        onChange={(recoverStalls) => setOption({ recoverStalls })} />
      {phase === 'ready' && (
        <div className="row-split">
          <span className="muted">{state && state.recoveryAttempts > 0 ? `已恢复 ${state.recoveryAttempts} 次，剩余 ${Math.max(0, 3 - state.recoveryAttempts)} 次` : '剩余 3 次'}</span>
          <button type="button" className="btn-quiet small" disabled={busy}
            onClick={() => void run(() => apiClient.feature('recoverEnhancedPip', undefined))}>恢复画面</button>
        </div>
      )}
      {phase === 'failed' && state && <p className="note-warn"><ErrorText error={pipFailure(state)} message={state.message ?? '画中画已失败'} /></p>}
      {(problem || error) && <p className="note-warn" role="alert"><ErrorText error={problem ? problemDetail ?? problem : errorDetail ?? error} message={problem || error} /></p>}
    </div>
  )
}
