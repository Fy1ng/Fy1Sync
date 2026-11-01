import { useEffect, useRef, useState } from 'react'
import { apiClient, type ApiResult } from '../../app/apiClient'
import type { StylePackSourceId, StylePackSyncState } from '../../../electron/stylePackSyncContracts'

const PHASE: Record<StylePackSyncState['phase'], string> = {
  unconfigured: '尚未启用云端同步', idle: '等待同步', syncing: '正在同步样式包...',
  current: '样式包已是最新', updated: '样式包已更新', error: '同步失败, 继续使用已安装样式',
}
const SOURCE: Record<StylePackSourceId, string> = { github: 'GitHub', gitcode: 'GitCode' }

export function StylePackSyncSettings(): React.ReactNode {
  const [state, setState] = useState<StylePackSyncState | null>(null)
  const [busy, setBusy] = useState<'source' | 'sync' | null>(null)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const pending = useRef<object | null>(null)
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
    }).catch(() => {
      if (active && initialRevision === revision.current) setError('读取样式包同步状态失败, 请重新打开设置后重试.')
    })
    return () => { active = false; mounted.current = false; pending.current = null; release() }
  }, [])

  const perform = async (kind: 'source' | 'sync', request: () => Promise<ApiResult<StylePackSyncState>>): Promise<void> => {
    if (pending.current || !state || state.phase === 'syncing' || state.phase === 'unconfigured') return
    const token = {}
    pending.current = token
    const submittedRevision = ++revision.current
    setBusy(kind)
    setError('')
    try {
      const result = await request()
      if (!mounted.current || pending.current !== token) return
      // Main's pushed state can be newer than a delayed request response.
      if (result.ok) {
        if (submittedRevision === revision.current) setState(result.value)
      }
      else setError(result.message)
    } catch {
      if (mounted.current && pending.current === token) setError(kind === 'source' ? '保存样式包来源失败, 请重试.' : '刷新样式包失败, 请重试.')
    } finally {
      if (pending.current === token) {
        pending.current = null
        if (mounted.current) setBusy(null)
      }
    }
  }

  const changeSource = (source: string): void => {
    if ((source !== 'github' && source !== 'gitcode') || !state?.availableSources.includes(source) || source === state.source) return
    void perform('source', () => apiClient.setStylePackSyncSource(source))
  }
  const syncing = busy === 'sync' || state?.phase === 'syncing'
  const disabled = !state || busy !== null || syncing || state.phase === 'unconfigured'
  return (
    <section className="group" aria-label="赛事样式包">
      <h3>赛事样式包</h3>
      <p className="muted">启动后自动同步, 运行期间每 6 小时检查. 只下载有变化的赛事样式, 无需重新安装应用.</p>
      <label className="field-row">
        <span>样式包来源</span>
        <select className="text-input" aria-label="样式包来源" value={state?.source ?? 'github'} disabled={disabled}
          onChange={event => changeSource(event.target.value)}>
          {(Object.keys(SOURCE) as StylePackSourceId[]).map(source => <option key={source} value={source}
            disabled={!state?.availableSources.includes(source)}>{SOURCE[source]}</option>)}
        </select>
      </label>
      <p className="muted">切换只保存来源, 点击手动刷新即可立即检查. 只访问所选源, 失败时保留缓存, 不自动切换.</p>
      <div className="row-split">
        <p role="status">{busy === 'source' ? '正在保存来源...' : syncing ? PHASE.syncing : state ? PHASE[state.phase] : '正在读取...'}</p>
        <button type="button" className="btn-solid small" disabled={disabled}
          onClick={() => void perform('sync', () => apiClient.syncStylePacks())}>{syncing ? '正在刷新...' : '手动刷新'}</button>
      </div>
      {state && <p className="muted">当前来源: {SOURCE[state.source]} / 清单版本: {state.catalogRevision ?? '尚未安装'}</p>}
      {state && <p className="muted">已安装 {state.installed} 个云端样式包{state.checkedAt !== null
        ? ` / 上次检查: ${new Date(state.checkedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</p>}
      {state?.message && <p className={state.phase === 'error' ? 'note-warn' : 'muted'}>{state.message}</p>}
      {!!state?.incompatible && <p className="note-warn">还有 {state.incompatible} 个赛事样式需要新版客户端, 已有兼容版本继续保留.</p>}
      <p className="muted">更新不会打断当前对齐. 重新选择样式或下次打开应用时使用新版, 本机修改优先保留.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  )
}
