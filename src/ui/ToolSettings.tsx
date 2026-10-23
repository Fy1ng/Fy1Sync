import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import type { ToolsStatus } from '../../electron/toolsService'

const sourceName = { external: '外部配置', managed: '受控更新', bundled: '内置', PATH: 'PATH' }
export function ToolSettings({ onFixturesAvailableChange }: { onFixturesAvailableChange?: (available: boolean) => void } = {}): React.ReactNode {
  const [status, setStatus] = useState<ToolsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false), saving = useRef(false), revision = useRef(0)
  useEffect(() => {
    mounted.current = true
    void apiClient.getToolsStatus().then(r => {
      if (!mounted.current) return
      if (r.ok && Array.isArray(r.value?.tools)) { setStatus(r.value); onFixturesAvailableChange?.(r.value.fixturesAvailable) }
      else if (!r.ok) setError(r.message)
    })
    return () => { mounted.current = false }
  }, [onFixturesAvailableChange])
  useEffect(() => {
    if (!busy && !['checking', 'downloading', 'verifying'].includes(status?.update.phase ?? '')) return
    const id = setInterval(() => { const current = revision.current; void apiClient.getToolsStatus().then(r => {
      if (mounted.current && current === revision.current && r.ok && Array.isArray(r.value?.tools)) setStatus(r.value)
    }) }, 750)
    return () => clearInterval(id)
  }, [busy, status?.update.phase])
  const action = async (target?: 'previous' | 'bundled') => {
    if (saving.current) return
    saving.current = true
    revision.current++
    setBusy(true)
    setError('')
    try {
      const r = target ? await apiClient.restoreYtdlp(target) : await apiClient.updateYtdlp()
      revision.current++
      if (!mounted.current) return
      if (r.ok) setStatus(r.value); else setError(r.message)
    } finally { saving.current = false; if (mounted.current) setBusy(false) }
  }
  const running = busy || !!status && ['checking', 'downloading', 'verifying'].includes(status.update.phase)
  return <section className="account-section" aria-label="取流工具">
    <h3>取流工具</h3>
    {status?.tools.map(tool => <p className="hint" key={tool.name}>{tool.name}: {tool.version} ({sourceName[tool.source]})</p>)}
    {status && <p className="hint">PO token provider: {status.provider.version}. 内置 provider 随应用整包更新.</p>}
    <p className="hint">仅点击后检查 GitHub 官方 yt-dlp 稳定版, 校验 SHA256 后供下次取流使用. 当前播放继续.</p>
    {status?.externalYtdlp && <p className="hint">当前 yt-dlp 使用外部配置. 下载更新不会替换外部文件或改变其优先级.</p>}
    <div className="source-actions">
      <button type="button" disabled={running || !status} onClick={() => void action()}>检查并更新 yt-dlp</button>
      <button type="button" className="ghost" disabled={running || !status?.update.previousVersion} onClick={() => void action('previous')}>恢复上一版本</button>
      <button type="button" className="ghost" disabled={running || !status?.update.activeVersion} onClick={() => void action('bundled')}>{status?.bundledAvailable ? '恢复内置版本' : '恢复默认工具'}</button>
    </div>
    {status && <p className="hint" role="status">{status.update.message}
      {status.update.downloadedVersion ? ` 下载版本: ${status.update.downloadedVersion}.` : ''}
      {status.update.phase === 'downloading' && status.update.totalBytes > 0 ? ` ${Math.floor(status.update.downloadedBytes * 100 / status.update.totalBytes)}%.` : ''}
    </p>}
    {error && <p className="dialog-error" role="alert">{error}</p>}
  </section>
}
