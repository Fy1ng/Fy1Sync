/**
 * Room tasks: check-ins, scheduled danmaku and the room activities. A task is created
 * paused and runs only after 启动; quitting the app stops everything, and nothing restarts
 * on its own next time. Tasks are grouped by room because a room is what the viewer thinks
 * in — "the stuff I have running in 9999".
 */

import { useState } from 'react'
import { apiClient } from '../../app/apiClient'
import { colorForIndex } from '../../../server/danmaku/douyuProtocol'
import { readMessageSchedule } from '../../../server/douyu/taskConfig'
import {
  isDouyuActivityKind,
  type DouyuMessageSchedule, type DouyuTaskKind, type DouyuTaskPolicy, type DouyuTaskView,
} from '../../../server/douyu/types'
import { Segmented, Switch } from '../kit'
import { LaneLine } from './DouyuDesk'
import type { DouyuData } from './useDouyu'

const KIND: Record<DouyuTaskKind, string> = {
  'room-sign': '直播间签到', 'yuba-sign': '鱼吧签到', 'message-loop': '定时弹幕',
  'auto-fish': '钓鱼', 'gift-packet': '抢红包', 'treasure-box': '开宝箱',
}
const KIND_NOTE: Partial<Record<DouyuTaskKind, string>> = {
  'yuba-sign': '先在账号里登录鱼吧。只签已经加入的鱼吧。',
  'auto-fish': '只用现有的免费次数，遇到验证会停。',
  'gift-packet': '抢到的红包礼物，会按平台规则到期自动送给这个主播。',
  'treasure-box': '遇到验证会停，到官方房间手动完成后再启动。',
}
const POLICY: Record<DouyuTaskPolicy, string> = {
  foreground: '窗口在前台时', 'background-unlocked': '没锁屏就跑', 'background-locked': '锁屏也跑',
}
const STATUS: Record<DouyuTaskView['status'], string> = {
  paused: '暂停', queued: '排队', running: '进行中', 'waiting-user': '等你处理', succeeded: '完成', failed: '失败', stopped: '已停',
}
const COLORS = ['白', '红', '蓝', '绿', '橙', '紫', '粉']

const scheduled = (task: DouyuTaskView): boolean => task.status === 'queued' || task.status === 'running' || task.nextRunAt !== null
const when = (time: number): string => {
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
}

export function Tasks({ data, defaultRoom }: { data: DouyuData; defaultRoom: string | null }): React.ReactNode {
  const { tasks, all, accounts, taskLane, loading } = data
  const [creating, setCreating] = useState(false)
  const rooms = [...new Set([
    ...(tasks?.currentRoom ? [tasks.currentRoom] : []),
    ...(tasks?.retainedRooms ?? []),
    ...(tasks?.tasks.map((task) => task.room) ?? []),
  ])].filter((room) => tasks?.tasks.some((task) => task.room === room) || tasks?.retainedRooms.includes(room))

  return (
    <div className="desk-pane">
      {creating
        ? <NewTask data={data} defaultRoom={defaultRoom ?? tasks?.currentRoom ?? ''} onDone={() => setCreating(false)} />
        : <button type="button" className="btn-solid new-task" disabled={all.length === 0} onClick={() => setCreating(true)}>新任务</button>}
      {all.length === 0 && !loading && <p className="muted">先去「账号」里添加一个斗鱼账号。</p>}

      {!loading && rooms.length === 0 && !creating && (
        <p className="desk-empty">没有任务。任务新建后先暂停，点启动才会跑；关掉应用就全部停止。</p>
      )}

      {rooms.map((room) => (
        <section key={room} className="room" aria-label={`任务房间 ${room}`}>
          <header className="room-head">
            <h3>房间 {room}</h3>
            {room === tasks?.currentRoom && <span className="tag">正在看</span>}
            <span className="room-keep">
              <Switch label="不看这个房间也继续" checked={tasks?.retainedRooms.includes(room) ?? false}
                disabled={!!taskLane.pending}
                onChange={(retain) => void data.taskAction('正在保存', () => apiClient.retainDouyuTaskRoom(room, retain),
                  retain ? `离开房间 ${room} 后任务继续` : `离开房间 ${room} 后任务停止`)} />
            </span>
          </header>
          <ul className="task-list">
            {tasks?.tasks.filter((task) => task.room === room).map((task) => (
              <TaskRow key={task.id} task={task} data={data} activeId={accounts?.activeAccountId ?? null} />
            ))}
          </ul>
        </section>
      ))}

      {tasks && (
        <p className="muted desk-runtime">
          应用现在{tasks.runtime.suspended ? '休眠中' : tasks.runtime.locked ? '在锁屏' : tasks.runtime.foreground ? '在前台' : '在后台'}，
          「窗口在前台时」的任务只在前台跑。
        </p>
      )}
      <LaneLine lane={taskLane} />
    </div>
  )
}

function TaskRow({ task, data, activeId }: { task: DouyuTaskView; data: DouyuData; activeId: string | null }): React.ReactNode {
  const { all, taskAction, accountAction, accountsBusy, taskLane } = data
  const account = all.find((item) => item.id === task.accountId)
  const blocked = !account ? '账号已不在' : account.id !== activeId ? `先在账号里把 ${account.label} 设为在用`
    : !account.login.loggedIn ? `先登录 ${account.label}` : ''
  const locked = !!taskLane.pending
  const running = scheduled(task)
  const kind = isDouyuActivityKind(task.kind) ? `${KIND[task.kind]}任务` : task.kind === 'message-loop' ? '发送任务'
    : task.kind === 'yuba-sign' ? '鱼吧签到任务' : '签到任务'
  const message = task.message

  return (
    <li className="task" data-status={task.status} role="group" aria-label={`${kind} ${task.room} (${account?.label ?? '账号不可用'})`}>
      <div className="task-main">
        <span className="task-kind">{KIND[task.kind]}</span>
        <span className="task-status" data-status={task.status}>{STATUS[task.status]}</span>
        <span className="muted">
          {account?.label ?? '账号不可用'} · {message
            ? `${message.maxRuns === 1 ? '发 1 次' : `每 ${message.intervalSeconds} 秒，${message.maxRuns === null ? '不限次' : `共 ${message.maxRuns} 次`}`}`
            : isDouyuActivityKind(task.kind) ? '按活动时间' : task.repeatMinutes === 1440 ? '每天' : '一次'}
        </span>
      </div>
      {message && (
        <p className="task-text">
          <span className="swatches" aria-hidden="true">{message.colors.map((color) => <i key={color} style={{ background: colorForIndex(color) }} />)}</span>
          {message.text}
          {task.completedRuns !== undefined && <span className="num muted"> · 已发 {task.completedRuns}</span>}
        </p>
      )}
      {(task.lastResult || task.reason) && <p className="task-result">{task.reason ?? task.lastResult}</p>}
      {(task.lastRunAt !== null || task.nextRunAt !== null) && (
        <p className="muted num">
          {task.lastRunAt !== null && `上次 ${when(task.lastRunAt)}`}
          {task.lastRunAt !== null && task.nextRunAt !== null && '　'}
          {task.nextRunAt !== null && `下次 ${when(task.nextRunAt)}`}
        </p>
      )}
      <div className="task-actions">
        {running || task.status === 'waiting-user'
          ? <button type="button" className="btn-quiet small" disabled={locked}
              onClick={() => void taskAction('正在暂停', () => apiClient.pauseDouyuTask(task.id), '已暂停')}>暂停</button>
          : <button type="button" className="btn-solid small" disabled={locked || accountsBusy || !!blocked} title={blocked || undefined}
              onClick={() => void taskAction('正在启动', () => apiClient.startDouyuTask(task.id), '已启动')}>启动</button>}
        {isDouyuActivityKind(task.kind) && (
          <button type="button" className="btn-quiet small" disabled={locked || accountsBusy || task.accountId !== activeId}
            onClick={() => void accountAction('在打开的 Chrome 窗口里处理，处理完关掉窗口',
              () => apiClient.openDouyuTaskRoom(task.id), '官方页面已关闭，核对后再启动')}>
            {task.kind === 'auto-fish' ? '打开官方钓鱼' : '打开官方房间'}
          </button>
        )}
        <select className="task-policy" value={task.policy} disabled={locked}
          aria-label={`房间 ${task.room} 的 ${account?.label ?? '未知账号'} ${KIND[task.kind]}什么时候跑`}
          onChange={(event) => void taskAction('正在保存', () => apiClient.setDouyuTaskPolicy(task.id, event.target.value as DouyuTaskPolicy), '已保存')}>
          {Object.entries(POLICY).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="button" className="btn-quiet small is-danger" disabled={locked}
          onClick={() => void taskAction('正在删除', () => apiClient.removeDouyuTask(task.id), '已删除')}>删除</button>
      </div>
      {blocked && !running && <p className="muted">{blocked}</p>}
    </li>
  )
}

function NewTask({ data, defaultRoom, onDone }: { data: DouyuData; defaultRoom: string; onDone: () => void }): React.ReactNode {
  const { all, active, taskAction, taskLane } = data
  const [kind, setKind] = useState<DouyuTaskKind>('room-sign')
  const [room, setRoom] = useState(defaultRoom)
  const [accountId, setAccountId] = useState(active?.id ?? all[0]?.id ?? '')
  const [policy, setPolicy] = useState<DouyuTaskPolicy>('foreground')
  const [daily, setDaily] = useState(false)
  const [draft, setDraft] = useState<DouyuMessageSchedule>({ text: '', colors: [0], intervalSeconds: 60, initialDelaySeconds: 0, maxRuns: 10 })
  const [lastRuns, setLastRuns] = useState(10)
  const isMessage = kind === 'message-loop'
  const isActivity = isDouyuActivityKind(kind)
  const schedule = readMessageSchedule(draft)
  const ready = !!accountId && room.trim() !== '' && (!isMessage || !!schedule) && !taskLane.pending
  const num = (value: number): number | '' => Number.isFinite(value) ? value : ''

  return (
    <form className="new-form" onSubmit={(event) => {
      event.preventDefault()
      if (!ready) return
      void taskAction('正在添加', () => apiClient.createDouyuTask({
        accountId, roomInput: room.trim(), kind, policy,
        repeatMinutes: !isMessage && !isActivity && daily ? 1440 : null,
        ...(isMessage && schedule ? { message: schedule } : {}),
      }), '已添加，点启动开始').then((ok) => { if (ok) onDone() })
    }}>
      <div className="field-stack">
        <span className="field-label">做什么</span>
        <Segmented label="任务类型" value={kind} onChange={setKind}
          options={(Object.keys(KIND) as DouyuTaskKind[]).map((value) => ({ value, label: KIND[value] }))} />
        {KIND_NOTE[kind] && <p className="muted">{KIND_NOTE[kind]}</p>}
      </div>

      <div className="new-grid">
        <label className="field-stack">
          <span className="field-label">房间</span>
          <input className="text-input" value={room} placeholder="房间号或链接" aria-label="任务房间号或地址" onChange={(event) => setRoom(event.target.value)} />
        </label>
        <label className="field-stack">
          <span className="field-label">账号</span>
          <select value={accountId} aria-label="任务账号" onChange={(event) => setAccountId(event.target.value)}>
            {all.map((account) => <option key={account.id} value={account.id}>{account.label}{account.id === active?.id ? '（在用）' : ''}</option>)}
          </select>
        </label>
      </div>

      <div className="field-stack">
        <span className="field-label">什么时候跑</span>
        <Segmented label="执行条件" value={policy} onChange={setPolicy}
          options={(Object.keys(POLICY) as DouyuTaskPolicy[]).map((value) => ({ value, label: POLICY[value] }))} />
      </div>

      {!isMessage && !isActivity && (
        <Switch label="每天签一次" checked={daily} onChange={setDaily} />
      )}

      {isMessage && (
        <>
          <label className="field-stack">
            <span className="field-label">发什么</span>
            <textarea className="text-input" rows={2} maxLength={500} value={draft.text} aria-label="发送内容"
              onChange={(event) => { const text = event.target.value; setDraft((value) => ({ ...value, text })) }} />
          </label>
          <div className="new-grid is-three">
            <label className="field-stack">
              <span className="field-label">每隔（秒）</span>
              <input className="text-input num" type="number" min={1} max={86400} value={num(draft.intervalSeconds)} aria-label="发送间隔(秒)"
                onChange={(event) => { const intervalSeconds = event.target.valueAsNumber; setDraft((value) => ({ ...value, intervalSeconds })) }} />
            </label>
            <label className="field-stack">
              <span className="field-label">启动后等（秒）</span>
              <input className="text-input num" type="number" min={0} max={86400} value={num(draft.initialDelaySeconds)} aria-label="启动延迟(秒)"
                onChange={(event) => { const initialDelaySeconds = event.target.valueAsNumber; setDraft((value) => ({ ...value, initialDelaySeconds })) }} />
            </label>
            <label className="field-stack">
              <span className="field-label">发几次</span>
              <input className="text-input num" type="number" min={1} max={1000} disabled={draft.maxRuns === null} aria-label="发送次数"
                value={num(draft.maxRuns ?? lastRuns)}
                onChange={(event) => { const maxRuns = event.target.valueAsNumber; setLastRuns(maxRuns); setDraft((value) => ({ ...value, maxRuns })) }} />
            </label>
          </div>
          <Switch label="一直发，直到暂停" checked={draft.maxRuns === null}
            onChange={(forever) => setDraft((value) => ({ ...value, maxRuns: forever ? null : lastRuns }))} />
          <div className="field-stack">
            <span className="field-label">颜色{draft.colors.length > 1 ? '（按顺序轮换）' : ''}</span>
            <div className="color-picks" role="group" aria-label="发送颜色">
              {COLORS.map((name, color) => {
                const at = draft.colors.indexOf(color)
                return (
                  <label key={color} className={at >= 0 ? 'is-on' : undefined}>
                    <input type="checkbox" checked={at >= 0} aria-label={`发送颜色 ${name}`}
                      onChange={(event) => {
                        const on = event.target.checked
                        setDraft((value) => ({ ...value, colors: on ? [...value.colors, color] : value.colors.filter((item) => item !== color) }))
                      }} />
                    <i style={{ background: colorForIndex(color) }} />
                    {at >= 0 && draft.colors.length > 1 && <b className="num">{at + 1}</b>}
                  </label>
                )
              })}
            </div>
            <p className="muted">彩色需要账号已经解锁对应颜色。</p>
          </div>
          {!schedule && draft.text.length > 0 && <p className="form-error">检查一下内容、时间和次数，至少选一种颜色；内容不能换行。</p>}
        </>
      )}

      <div className="row-end">
        <button type="button" className="btn-quiet" onClick={onDone}>取消</button>
        <button type="submit" className="btn-solid" disabled={!ready}>添加</button>
      </div>
    </form>
  )
}
