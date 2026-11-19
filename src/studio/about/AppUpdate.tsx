import { useEffect, useRef, useState } from 'react'
import { apiClient, type ApiResult } from '../../app/apiClient'
import type { OnlineUpdateItemState, OnlineUpdateKind, OnlineUpdateSourceId, OnlineUpdateState } from '../../../electron/onlineUpdateContracts'
import { ErrorText, useErrorState } from '../../ui/ErrorDetails'
import { displayError } from '../../core/errorDetails'
import './about.css'

const SOURCE: Record<OnlineUpdateSourceId, string> = { github: 'GitHub', gitcode: 'GitCode' }
const ITEM_PHASE: Record<OnlineUpdateItemState['phase'], string> = {
  unavailable: '暂无可用更新', current: '已是最新版本', available: '有可用更新',
  incompatible: '不适用于当前应用', downloading: '正在下载', ready: '已下载并校验',
  trial: '正在检查新界面', 'rolled-back': '已回退到可用界面', error: '更新未完成',
}
type Operation = 'source' | 'check' | 'download-frontend' | 'download-application' | 'apply' | 'rollback' | 'read'
type UpdateResult = ApiResult<OnlineUpdateState | { accepted: boolean }>

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}
function formatBytes(bytes: number): string { return `${(bytes / 1_048_576).toFixed(1)} MB` }
function isDownloading(state: OnlineUpdateState | null): boolean {
  return state?.frontend.phase === 'downloading' || state?.application.phase === 'downloading'
}

export function AppUpdateSettings(): React.ReactNode {
  const [state, setState] = useState<OnlineUpdateState | null>(null)
  const [busy, setBusy] = useState<Operation | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError, errorDetail] = useErrorState('')
  const [notice, setNotice] = useState('')
  const lifetime = useRef<object | null>(null)
  const pending = useRef<object | null>(null)
  const cancelPending = useRef<object | null>(null)
  const revision = useRef(0)

  const reread = async (owner: object): Promise<void> => {
    const requestedRevision = ++revision.current
    try {
      const result = await apiClient.feature('getOnlineUpdateState', undefined)
      if (lifetime.current !== owner || requestedRevision !== revision.current) return
      if (result.ok) setState(result.value)
      else setError(current => current || result)
    } catch (caught) {
      if (lifetime.current === owner && requestedRevision === revision.current) setError(current => current || displayError(caught, '读取更新状态失败，请重试'))
    }
  }

  useEffect(() => {
    const owner = {}
    lifetime.current = owner
    const release = apiClient.subscribeFeatures(event => {
      if (lifetime.current !== owner || event.topic !== 'online-update') return
      ++revision.current
      setState(event.data as OnlineUpdateState)
    })
    void reread(owner)
    return () => { lifetime.current = null; pending.current = null; cancelPending.current = null; release() }
  }, [])

  const perform = async (operation: Operation, request: () => Promise<UpdateResult>): Promise<void> => {
    const owner = lifetime.current
    if (!owner || pending.current || cancelPending.current) return
    if (operation !== 'read' && (!state || state.phase === 'checking' || isDownloading(state))) return
    if (state?.phase === 'unconfigured' && (operation === 'source' || operation === 'check' || operation.startsWith('download-'))) return
    const token = {}
    pending.current = token
    const submittedRevision = ++revision.current
    setBusy(operation)
    setError('')
    setNotice('')
    try {
      const result = await request()
      if (lifetime.current !== owner || pending.current !== token) return
      if (!result.ok) {
        setError(result)
        if (operation !== 'read') await reread(owner)
      } else if ('accepted' in result.value) {
        if (!result.value.accepted) setNotice('操作已取消')
      } else if (submittedRevision === revision.current) {
        // A pushed state can be newer than a delayed command response.
        setState(result.value)
      }
    } catch (caught) {
      if (lifetime.current !== owner || pending.current !== token) return
      setError(displayError(caught, '更新操作未能完成，请重新读取状态后重试'))
      if (operation !== 'read') await reread(owner)
    } finally {
      if (pending.current === token) {
        pending.current = null
        if (lifetime.current === owner) setBusy(null)
      }
    }
  }

  const cancel = async (): Promise<void> => {
    const owner = lifetime.current
    if (!owner || cancelPending.current || (!isDownloading(state) && busy !== 'download-frontend' && busy !== 'download-application')) return
    const token = {}
    cancelPending.current = token
    const submittedRevision = ++revision.current
    setCancelling(true)
    setError('')
    try {
      const result = await apiClient.feature('cancelOnlineUpdate', undefined)
      if (lifetime.current !== owner || cancelPending.current !== token) return
      if (result.ok) {
        if (submittedRevision === revision.current) setState(result.value)
      } else { setError(result); await reread(owner) }
    } catch (caught) {
      if (lifetime.current === owner && cancelPending.current === token) {
        setError(displayError(caught, '取消下载失败，请重新读取状态后重试'))
        await reread(owner)
      }
    } finally {
      if (cancelPending.current === token) {
        cancelPending.current = null
        if (lifetime.current === owner) setCancelling(false)
      }
    }
  }

  const changeSource = (source: string): void => {
    if ((source !== 'github' && source !== 'gitcode') || !state?.availableSources.includes(source) || source === state.source) return
    void perform('source', () => apiClient.feature('setOnlineUpdateSource', { source }))
  }
  const downloading = isDownloading(state) || busy === 'download-frontend' || busy === 'download-application'
  const checking = busy === 'check' || state?.phase === 'checking'
  const disabled = !state || busy !== null || cancelling || checking || downloading
  const networkDisabled = disabled || state?.phase === 'unconfigured'
  const status = busy === 'source' ? '正在保存来源…' : checking ? '正在检查更新…'
    : state?.phase === 'unconfigured' ? '未配置更新来源' : state?.phase === 'error' ? '检查未完成'
      : state ? state.checkedAt === null ? '尚未检查更新' : '更新检查已完成' : '正在读取更新状态…'

  return (
    <>
      <dl className="facts about-version-facts">
        <div><dt>应用版本</dt><dd className="num">{state?.currentAppVersion ?? '-'}</dd></div>
        {state?.checkedAt != null && <div><dt>上次检查</dt><dd className="num">{formatTime(state.checkedAt)}</dd></div>}
        <div><dt>许可</dt><dd>GPL-3.0-or-later</dd></div>
      </dl>
      <label className="field-row">
        <span>更新来源</span>
        <select className="text-input" aria-label="更新来源" value={state?.source ?? 'github'} disabled={networkDisabled}
          onChange={event => changeSource(event.target.value)}>
          {(Object.keys(SOURCE) as OnlineUpdateSourceId[]).map(source => <option key={source} value={source}
            disabled={!state?.availableSources.includes(source)}>{SOURCE[source]}</option>)}
        </select>
      </label>
      <p className="muted">选择来源后，点击「检查更新」</p>
      <div className="row-split">
        <p className={`about-status is-${state?.phase ?? 'idle'}`} role="status">
          {state?.phase === 'error' && !checking ? <ErrorText error={state.errorDetail ?? state} message={status} /> : status}
          {state?.message && !checking && <span className="muted">{state.message}</span>}
        </p>
        <button type="button" className="btn-solid small" disabled={networkDisabled}
          onClick={() => void perform('check', () => apiClient.feature('checkOnlineUpdate', undefined))}>{checking ? '正在检查…' : '检查更新'}</button>
      </div>
      {state && <div className="about-update-channels">
        {(['frontend', 'application'] as const).map(kind => (
          <UpdateChannel key={kind} kind={kind} item={state[kind]} disabled={disabled}
            onDownload={() => void perform(`download-${kind}`, () => apiClient.feature('downloadOnlineUpdate', { kind }))}
            onApply={() => void perform('apply', () => apiClient.feature('applyOnlineUpdate', { kind }))} />
        ))}
      </div>}
      {downloading && <div className="row-end">
        <button type="button" className="btn-quiet small" disabled={cancelling}
          onClick={() => void cancel()}>{cancelling ? '正在取消…' : '取消下载'}</button>
      </div>}
      {state?.canRollbackFrontend && <div className="row-split">
        <p className="muted">回退会重启应用，本机数据保留</p>
        <button type="button" className="btn-quiet small" disabled={disabled}
          onClick={() => void perform('rollback', () => apiClient.feature('rollbackFrontendUpdate', undefined))}>回退界面</button>
      </div>}
      {notice && <p className="muted" role="status">{notice}</p>}
      {error && <div className="about-update-error">
        <p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>
        <button type="button" className="btn-quiet small" disabled={busy !== null || cancelling}
          onClick={() => void perform('read', () => apiClient.feature('getOnlineUpdateState', undefined))}>重新读取状态</button>
      </div>}
    </>
  )
}

function UpdateChannel({ kind, item, disabled, onDownload, onApply }: {
  kind: OnlineUpdateKind
  item: OnlineUpdateItemState & { errorDetail?: unknown }
  disabled: boolean
  onDownload: () => void
  onApply: () => void
}): React.ReactNode {
  const frontend = kind === 'frontend'
  const title = frontend ? '界面更新' : '完整应用更新'
  const canDownload = item.phase === 'available' || item.phase === 'error' && item.version !== null
  const total = item.totalBytes !== null && item.totalBytes > 0 ? item.totalBytes : null
  return (
    <section className="about-update-channel" aria-label={title}>
      <div className="row-split">
        <div className="about-update-heading">
          <h4>{title}</h4>
          {item.version && <span className="num muted">{item.version}{frontend && item.revision !== null ? ` / r${item.revision}` : ''}</span>}
        </div>
        {canDownload && <button type="button" className="btn-solid small" disabled={disabled} onClick={onDownload}>
          {frontend ? '下载界面更新' : '下载完整更新'}
        </button>}
        {item.phase === 'ready' && <button type="button" className="btn-solid small" disabled={disabled} onClick={onApply}>
          {frontend ? '应用并重启' : '安装完整更新'}
        </button>}
      </div>
      <p className={`about-status is-${item.phase}`} role="status">{item.phase === 'error' ? <ErrorText error={item.errorDetail ?? item} message={ITEM_PHASE[item.phase]} /> : ITEM_PHASE[item.phase]}
        {item.message && <span className="muted">{item.message}</span>}
      </p>
      {item.phase === 'downloading' && <div className="about-update-progress">
        <progress aria-label={`${title}下载进度`} max={100}
          value={total ? Math.min(100, Math.max(0, item.downloadedBytes / total * 100)) : undefined} />
        <span className="num muted">{formatBytes(item.downloadedBytes)}{total ? ` / ${formatBytes(total)}` : ''}</span>
      </div>}
      <p className="muted">{frontend
        ? '下次启动时生效。新界面启动失败会自动回退。'
        : '下载不影响播放，安装时将退出应用'}</p>
      {item.notes && <details className="about-notes">
        <summary>{title}说明</summary>
        <pre>{item.notes}</pre>
      </details>}
    </section>
  )
}
