import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { StylePackSyncState } from '../../../electron/stylePackSyncContracts'

const PHASE: Record<StylePackSyncState['phase'], string> = {
  unconfigured: '尚未启用云端同步', idle: '等待同步', syncing: '正在同步样式包...',
  current: '样式包已是最新', updated: '样式包已更新', error: '同步失败, 继续使用已安装样式',
}

export function StylePackSyncSettings(): React.ReactNode {
  const [state, setState] = useState<StylePackSyncState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const pending = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    mounted.current = true
    let active = true
    const initialRevision = revision.current
    const release = apiClient.subscribeFeatures(event => {
      if (!active || event.topic !== 'stylepacks-state') return
      ++revision.current
      setState(event.data as StylePackSyncState)
    })
    void apiClient.getStylePackSyncState().then(result => {
      if (!active || initialRevision !== revision.current) return
      if (result.ok) setState(result.value)
      else setError(result.message)
    })
    return () => { active = false; mounted.current = false; release() }
  }, [])

  const sync = async (): Promise<void> => {
    if (pending.current || state?.phase === 'syncing') return
    pending.current = true
    ++revision.current
    setBusy(true)
    setError('')
    try {
      const result = await apiClient.syncStylePacks()
      if (!mounted.current) return
      if (result.ok) setState(result.value)
      else setError(result.message)
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const syncing = busy || state?.phase === 'syncing'
  return (
    <section className="group" aria-label="赛事样式包">
      <h3>赛事样式包</h3>
      <p className="muted">启动后自动同步, 运行期间每 6 小时检查. 只下载有变化的赛事样式, 无需重新安装应用.</p>
      <div className="row-split">
        <p role="status">{syncing ? PHASE.syncing : state ? PHASE[state.phase] : '正在读取...'}</p>
        <button type="button" className="btn-solid small" disabled={!state || syncing || state.phase === 'unconfigured'}
          onClick={() => void sync()}>{syncing ? '正在同步...' : '立即同步样式包'}</button>
      </div>
      {state && <p className="muted">已安装 {state.installed} 个云端样式包{state.checkedAt !== null
        ? ` / 上次检查: ${new Date(state.checkedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</p>}
      {state?.message && <p className={state.phase === 'error' ? 'note-warn' : 'muted'}>{state.message}</p>}
      {!!state?.incompatible && <p className="note-warn">还有 {state.incompatible} 个赛事样式需要新版客户端, 已有兼容版本继续保留.</p>}
      <p className="muted">更新不会打断当前对齐. 重新选择样式或下次打开应用时使用新版, 本机修改优先保留.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  )
}
