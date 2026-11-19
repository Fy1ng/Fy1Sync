/**
 * The experimental gate for everything that acts on Douyu as the viewer: sending, +1, reply,
 * mute, gifts, room and batch tasks, badge renewal. Off by default for the first release;
 * reading (accounts, followed rooms, the backpack, spending, records) never depends on it.
 */

import { useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { apiClient } from '../app/apiClient'
import { displayError } from '../core/errorDetails'
import { Switch } from './kit'
import { ReadError } from './ReadError'

async function runningTasks(): Promise<{ rooms: string[]; batches: string[] }> {
  const [rooms, batches] = await Promise.all([
    apiClient.getDouyuTasks(), apiClient.feature('getDouyuAutomations', undefined),
  ])
  if (!rooms.ok) throw rooms
  if (!batches.ok) throw batches
  if (!Array.isArray(rooms.value?.tasks) || !Array.isArray(batches.value?.tasks)) throw new Error('无法读取正在运行的任务')
  const active = (task: { status: string; nextRunAt: number | null }): boolean =>
    task.status === 'running' || task.status === 'queued' || task.nextRunAt !== null
  return { rooms: rooms.value.tasks.filter(active).map(task => task.id), batches: batches.value.tasks.filter(active).map(task => task.id) }
}

export function useDouyuWrites(): boolean {
  return useSessionSnapshot().settings.douyuWrites
}

/** The switch, with the risk spelled out before it turns on. */
export function DouyuWritesPane(): React.ReactNode {
  const session = useSession()
  const on = useDouyuWrites()
  const [asking, setAsking] = useState(false)
  const [closingCount, setClosingCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const close = async (confirmed: boolean): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const tasks = await runningTasks()
      const count = tasks.rooms.length + tasks.batches.length
      if (count > 0 && !confirmed) { setClosingCount(count); return }
      const replies = await Promise.allSettled([
        ...tasks.rooms.map(id => apiClient.pauseDouyuTask(id)),
        ...tasks.batches.map(id => apiClient.feature('pauseDouyuAutomation', { id })),
      ])
      const failed = replies.find(reply => reply.status === 'rejected' || !reply.value.ok)
      if (failed) throw failed.status === 'rejected' ? failed.reason : failed.value
      const remaining = await runningTasks()
      if (remaining.rooms.length + remaining.batches.length > 0) throw new Error('仍有任务未暂停，请重试')
      session.updateSettings({ douyuWrites: false })
      setClosingCount(null)
    } catch (caught) {
      setError(displayError(caught, '关闭未完成，斗鱼写操作仍然开启').message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="desk-pane">
      <Switch label="斗鱼写操作（实验性）" detail="开启弹幕发送、赠礼和账号任务等功能"
        checked={on || asking} disabled={asking || busy || closingCount !== null}
        onChange={(checked) => { if (checked) setAsking(true); else void close(false) }} />
      {asking && (
        <div className="writes-confirm" role="group" aria-label="确认打开斗鱼写操作">
          <p className="note-warn">使用真实斗鱼账号，可能触发风控或账号限制。出现异常请关闭此开关，运行中的任务会暂停。</p>
          <span className="row-end">
            <button type="button" className="btn-quiet small" onClick={() => setAsking(false)}>取消</button>
            <button type="button" className="btn-solid small" onClick={() => { session.updateSettings({ douyuWrites: true }); setAsking(false) }}>确认打开</button>
          </span>
        </div>
      )}
      {closingCount !== null && (
        <div className="writes-confirm" role="group" aria-label="确认关闭斗鱼写操作">
          <p className="note-warn">有 {closingCount} 个任务正在运行或等待执行。关闭会全部暂停，已提交的请求不会撤回。</p>
          <span className="row-end">
            <button type="button" className="btn-quiet small" disabled={busy} onClick={() => { setClosingCount(null); setError('') }}>取消</button>
            <button type="button" className="btn-solid small" disabled={busy} onClick={() => void close(true)}>全部暂停并关闭</button>
          </span>
        </div>
      )}
      {busy && <p className="muted" role="status">{closingCount === null ? '正在核对运行中的任务' : '正在暂停任务'}</p>}
      {error && <ReadError error={error} onRetry={() => void close(closingCount !== null)} />}
    </div>
  )
}
