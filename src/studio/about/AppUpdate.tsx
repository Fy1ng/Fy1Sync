import { useEffect, useRef, useState } from 'react'
import { apiClient, type ApiResult } from '../../app/apiClient'
import type { OnlineUpdateItemState, OnlineUpdateKind, OnlineUpdateSourceId, OnlineUpdateState } from '../../../electron/onlineUpdateContracts'
import { ErrorText, useErrorState } from '../../ui/ErrorDetails'
import { displayError } from '../../core/errorDetails'
import './about.css'

const SOURCE: Record<OnlineUpdateSourceId, string> = { github: 'GitHub', gitcode: 'GitCode' }
const RELEASE_PAGE: Record<OnlineUpdateSourceId, string> = {
  github: 'https://github.com/Fy1ng/Fy1Sync/releases', gitcode: 'https://gitcode.com/Fy1ng/Fy1Sync/releases',
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
function updateKind(state: OnlineUpdateState): OnlineUpdateKind | null {
  for (const phase of [['downloading'], ['available', 'ready'], ['error']]) {
    for (const kind of ['application', 'frontend'] as const) {
      if (state[kind].version !== null && phase.includes(state[kind].phase)) return kind
    }
  }
  return null
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
    const target = busy === 'download-frontend' || state?.frontend.phase === 'downloading' ? 'frontend' : 'application'
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
        if (result.value.phase === 'idle' && result.value[target].phase === 'available') setNotice('已取消下载')
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
  const kind = state ? busy === 'download-frontend' ? 'frontend' : busy === 'download-application' ? 'application' : updateKind(state) : null
  const item = state && kind ? state[kind] : null
  const total = item?.totalBytes != null && item.totalBytes > 0 ? item.totalBytes : null
  const status = busy === 'source' ? '正在保存来源…' : checking ? '正在检查更新…'
    : state?.phase === 'unconfigured' ? '此版本不支持在线更新' : state?.phase === 'error' ? state.message || '更新未完成'
      : downloading ? '正在下载并校验更新' : item?.phase === 'ready' ? '已下载并校验'
        : kind ? '有可用更新' : state?.frontend.phase === 'trial' ? '正在检查新界面'
          : state?.frontend.phase === 'rolled-back' ? state.frontend.message || '已回退到可用界面'
            : state && (state.frontend.phase === 'error' || state.application.phase === 'error') ? '更新未完成'
              : state && (state.frontend.phase === 'incompatible' || state.application.phase === 'incompatible') ? '在线更新不适用于当前应用'
                : state ? state.checkedAt === null ? '尚未检查更新' : '已是最新版本' : '正在读取更新状态…'
  const consequence = kind === 'application'
    ? item?.phase === 'ready' ? '将结束播放、退出应用并打开安装向导' : '下载后需退出应用并打开安装向导'
    : item?.phase === 'ready' ? '将结束播放并重启应用，启用新界面' : '下载后下次启动生效，也可立即重启应用'
  const incompatible = state && (state.application.phase === 'incompatible' ? state.application
    : !kind && state.frontend.phase === 'incompatible' ? state.frontend : null)

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
      <section className="about-update" aria-label="应用更新">
        <div className="row-split">
          <p className={`about-status is-${state?.phase === 'error' ? 'error' : item?.phase ?? 'idle'}`} role="status">
            {state?.phase === 'error' && !checking
              ? <ErrorText error={state.errorDetail ?? { message: status }} message={status} /> : status}
          </p>
          <button type="button" className="btn-quiet small" disabled={networkDisabled}
            onClick={() => void perform('check', () => apiClient.feature('checkOnlineUpdate', undefined))}>{checking ? '正在检查…' : '检查更新'}</button>
        </div>
        {kind && item && <div className="about-update-action">
          <button type="button" className="btn-solid small" disabled={disabled}
            onClick={() => void (item.phase === 'ready'
              ? perform('apply', () => apiClient.feature('applyOnlineUpdate', { kind }))
              : perform(`download-${kind}`, () => apiClient.feature('downloadOnlineUpdate', { kind })))}>更新到 {item.version}</button>
          <p className="muted">{consequence}</p>
        </div>}
        {downloading && <div className="about-update-progress">
          <progress aria-label="更新下载进度" max={100}
            value={item?.phase === 'downloading' && total ? Math.min(100, Math.max(0, item.downloadedBytes / total * 100)) : undefined} />
          <span className="num muted">{formatBytes(item?.downloadedBytes ?? 0)}{total ? ` / ${formatBytes(total)}` : ''}</span>
          <button type="button" className="btn-quiet small" disabled={cancelling}
            onClick={() => void cancel()}>{cancelling ? '正在取消…' : '取消下载'}</button>
        </div>}
        {state && (['frontend', 'application'] as const).map(failedKind => {
          const failed = state[failedKind] as OnlineUpdateItemState & { errorDetail?: unknown }
          if (failed.phase !== 'error') return null
          const summary = `${failedKind === 'frontend' ? '界面更新' : '完整应用更新'}失败：${failed.message || '请重试'}`
          return <p key={failedKind} className="form-error" role="alert">
            <ErrorText error={failed.errorDetail ?? { message: summary }} message={summary} />
          </p>
        })}
        {kind && state && (state.frontend.phase === 'trial' || state.frontend.phase === 'rolled-back') && <p className="about-status" role="status">
          {state.frontend.phase === 'trial' ? '正在检查新界面' : state.frontend.message || '已回退到可用界面'}
        </p>}
        {(state?.phase === 'unconfigured' || incompatible) && <p className="muted">
          {incompatible && <>{incompatible.message || '此更新不适用于当前应用'} </>}
          <a href={RELEASE_PAGE[state?.source ?? 'github']} target="_blank" rel="noreferrer">从发布页下载完整应用</a>
        </p>}
        {item?.notes && <details className="about-notes">
          <summary>更新说明</summary>
          <pre>{item.notes}</pre>
        </details>}
      </section>
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
