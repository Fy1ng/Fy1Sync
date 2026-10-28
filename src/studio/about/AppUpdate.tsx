/**
 * Version and manual update check in settings (handoff item 88). The main process only
 * reads release metadata; nothing is downloaded or installed. There is no update topic, so
 * the page reads `getAppUpdateState` on mount and otherwise waits on `checkAppUpdate`.
 */

import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { AppUpdateState } from '../../../electron/appUpdateService'
import './about.css'

const PHASE: Record<AppUpdateState['phase'], string> = {
  unconfigured: '未配置发布源',
  idle: '尚未检查',
  checking: '正在检查',
  current: '已是最新版本',
  available: '有可用更新',
  error: '检查失败',
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

export function AppUpdateSettings(): React.ReactNode {
  const [state, setState] = useState<AppUpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [openError, setOpenError] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void apiClient.feature('getAppUpdateState', undefined).then((result) => {
      if (!mounted.current) return
      if (result.ok) setState((current) => current ?? result.value)
      else setError(result.message)
    })
    return () => { mounted.current = false }
  }, [])

  const check = async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    setError('')
    setOpenError('')
    setState((current) => current && current.phase !== 'unconfigured' ? { ...current, phase: 'checking' } : current)
    try {
      const result = await apiClient.feature('checkAppUpdate', undefined)
      if (!mounted.current) return
      if (result.ok) setState(result.value)
      else {
        setError(result.message)
        // Restore what the main process holds rather than leaving "正在检查" on screen.
        const reread = await apiClient.feature('getAppUpdateState', undefined)
        if (mounted.current && reread.ok) setState(reread.value)
      }
    } finally { if (mounted.current) setChecking(false) }
  }

  const openRelease = async (): Promise<void> => {
    setOpenError('')
    const result = await apiClient.feature('openAppReleasePage', undefined)
    if (mounted.current && !result.ok) setOpenError(result.message)
  }

  const phase = checking ? 'checking' : state?.phase
  const available = state?.phase === 'available' && !checking

  return (
    <>
      <dl className="facts">
        <div><dt>当前版本</dt><dd className="num">{state?.currentVersion ?? '—'}</dd></div>
        {available && state.latestVersion && <div><dt>最新版本</dt><dd className="num">{state.latestVersion}</dd></div>}
        {state?.checkedAt != null && <div><dt>上次检查</dt><dd className="num">{formatTime(state.checkedAt)}</dd></div>}
        <div><dt>许可</dt><dd>GPL-3.0-or-later</dd></div>
      </dl>
      <div className="row-split">
        <p className={`about-status is-${phase ?? 'idle'}`} role="status">
          {phase ? PHASE[phase] : '正在读取'}
          {state?.message && phase !== 'checking' && <span className="muted">{state.message}</span>}
        </p>
        <span className="row-end">
          {available && <button type="button" className="btn-solid small" onClick={() => void openRelease()}>打开发布页</button>}
          <button type="button" className={`${available ? 'btn-quiet' : 'btn-solid'} small`} disabled={checking || !state}
            onClick={() => void check()}>{checking ? '正在检查…' : '检查更新'}</button>
        </span>
      </div>
      {available && state.releaseNotes && (
        <section className="about-notes" aria-label="发布说明">
          <h4>发布说明</h4>
          <pre>{state.releaseNotes}</pre>
        </section>
      )}
      <p className="muted">仅检查版本信息，不会自动下载或安装。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {openError && <p className="form-error" role="alert">{openError}</p>}
    </>
  )
}
