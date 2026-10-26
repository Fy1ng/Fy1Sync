/**
 * Room tasks: check-ins, scheduled danmaku and the room activities. A task is created
 * paused and runs only after 启动; quitting the app stops everything, and nothing restarts
 * on its own next time. Tasks are grouped by room because a room is what the viewer thinks
 * in — "the stuff I have running in 9999".
 */

import { useState } from 'react'
import { apiClient } from '../../app/apiClient'
import { colorForIndex } from '../../../server/danmaku/douyuProtocol'
import {
  isDouyuActivityKind,
  type DouyuMessageSchedule, type DouyuTaskKind, type DouyuTaskPolicy, type DouyuTaskView,
} from '../../../server/douyu/types'
import type { LocalMessageTemplate, MessageSelection } from '../../core/messageComposition'
import { Segmented, Switch } from '../kit'
import { LaneLine } from './DouyuDesk'
import { ActivityOptions } from './taskActivityOptions'
import {
  EMPTY_LOOP, SELECTION_LABEL, TEMPLATE_LABEL, buildMessageSchedule, durationText, messageLines, templateLines, type LoopDraft,
} from './taskMessage'
import type { DouyuData } from './useDouyu'
import './tasks.css'

const KIND: Record<DouyuTaskKind, string> = {
  'room-sign': '直播间签到', 'yuba-sign': '鱼吧签到', 'message-loop': '定时弹幕',
  'auto-fish': '钓鱼', 'gift-packet': '抢红包', 'treasure-box': '开宝箱',
}
const KIND_NOTE: Partial<Record<DouyuTaskKind, string>> = {
  'yuba-sign': '请先在账号中登录鱼吧。仅签到已加入的鱼吧。',
  'auto-fish': '仅使用现有免费鱼饵，不购买鱼饵。遇到验证时停止。',
  'gift-packet': '不会为获取资格自动关注或赠送礼物。参与后以官方最终结果为准；抢到的红包礼物将按平台规则在到期时自动赠送给该主播。',
  'treasure-box': '仅处理普通宝箱。遇到验证时停止，请在官方页面手动完成后重新启动。',
}
const POLICY: Record<DouyuTaskPolicy, string> = {
  foreground: '仅窗口在前台时', 'background-unlocked': '未锁屏时', 'background-locked': '锁屏时也运行',
}
const STATUS: Record<DouyuTaskView['status'], string> = {
  paused: '暂停', queued: '排队', running: '进行中', 'waiting-user': '待处理', succeeded: '完成', failed: '失败', stopped: '已停止',
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
  const hasFishing = !!tasks?.tasks.some((task) => task.kind === 'auto-fish')
  const hasTreasure = !!tasks?.tasks.some((task) => task.kind === 'treasure-box')

  return (
    <div className="desk-pane">
      {creating
        ? <NewTask data={data} defaultRoom={defaultRoom ?? tasks?.currentRoom ?? ''} onDone={() => setCreating(false)} />
        : <button type="button" className="btn-solid new-task" disabled={all.length === 0} onClick={() => setCreating(true)}>新任务</button>}
      {all.length === 0 && !loading && <p className="muted">请先在「账号」中添加斗鱼账号。</p>}

      {!loading && rooms.length === 0 && !creating && (
        <p className="desk-empty">暂无任务。新建的任务默认暂停，点击「启动」后运行；关闭应用后全部停止。</p>
      )}

      {rooms.map((room) => (
        <section key={room} className="room" aria-label={`任务房间 ${room}`}>
          <header className="room-head">
            <h3>房间 {room}</h3>
            {room === tasks?.currentRoom && <span className="tag">正在观看</span>}
            <span className="room-keep">
              <Switch label="离开该房间后继续" checked={tasks?.retainedRooms.includes(room) ?? false}
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

      {!creating && (hasFishing || hasTreasure) && <ActivityOptions fishing={hasFishing} treasure={hasTreasure} />}

      {tasks && (
        <p className="muted desk-runtime">
          应用当前{tasks.runtime.suspended ? '休眠中' : tasks.runtime.locked ? '处于锁屏' : tasks.runtime.foreground ? '在前台运行' : '在后台运行'}，
          「仅窗口在前台时」的任务只在前台运行。
        </p>
      )}
      <LaneLine lane={taskLane} />
    </div>
  )
}

function messageSummary(message: DouyuMessageSchedule): string {
  const parts = [message.maxRuns === 1 ? '发送 1 次' : `每 ${message.intervalSeconds} 秒，${message.maxRuns === null ? '不限次' : `共 ${message.maxRuns} 次`}`]
  if (message.initialDelaySeconds > 0) parts.push(`延迟 ${durationText(message.initialDelaySeconds)}开始`)
  if (message.maxDurationSeconds) parts.push(`限时 ${durationText(message.maxDurationSeconds)}`)
  return parts.join('，')
}

function MessageText({ message }: { message: DouyuMessageSchedule }): React.ReactNode {
  const selection = message.selection
  if (selection?.mode === 'automatic') return <>{`自动文案（${TEMPLATE_LABEL[selection.template]}）`}</>
  if (selection && selection.texts.length > 1) {
    return <>{selection.texts[0]}<span className="muted">{` 等 ${selection.texts.length} 条，${SELECTION_LABEL[selection.mode]}`}</span></>
  }
  return <>{message.text}</>
}

function TaskRow({ task, data, activeId }: { task: DouyuTaskView; data: DouyuData; activeId: string | null }): React.ReactNode {
  const { all, taskAction, accountAction, accountsBusy, taskLane } = data
  const account = all.find((item) => item.id === task.accountId)
  const blocked = !account ? '账号已删除' : account.id !== activeId ? `请先在账号中将 ${account.label} 设为当前账号`
    : !account.login.loggedIn ? `请先登录 ${account.label}` : ''
  const locked = !!taskLane.pending
  const running = scheduled(task)
  const activity = isDouyuActivityKind(task.kind)
  const kind = activity ? `${KIND[task.kind]}任务` : task.kind === 'message-loop' ? '发送任务'
    : task.kind === 'yuba-sign' ? '鱼吧签到任务' : '签到任务'
  const message = task.message
  const waiting = task.status === 'waiting-user'
  const officialRoom = task.officialRoom ?? task.room

  return (
    <li className="task" data-status={task.status} role="group" aria-label={`${kind} ${task.room} (${account?.label ?? '账号不可用'})`}>
      <div className="task-main">
        <span className="task-kind">{KIND[task.kind]}</span>
        <span className="task-status" data-status={task.status}>{STATUS[task.status]}</span>
        <span className="muted">
          {account?.label ?? '账号不可用'} · {message ? messageSummary(message)
            : activity ? '按活动时间' : task.repeatMinutes === 1440 ? '每天' : '一次'}
        </span>
      </div>
      {message && (
        <p className="task-text">
          <span className="swatches" aria-hidden="true">{message.colors.map((color) => <i key={color} style={{ background: colorForIndex(color) }} />)}</span>
          <span className="task-text-body"><MessageText message={message} /></span>
        </p>
      )}
      {message && (task.completedRuns !== undefined || task.deadlineAt !== undefined) && (
        <p className="muted num task-counts">
          {task.completedRuns !== undefined && `已发送 ${task.completedRuns}${message.maxRuns !== null ? ` / ${message.maxRuns}` : ''}`}
          {task.completedRuns !== undefined && task.deadlineAt !== undefined && '　'}
          {task.deadlineAt !== undefined && `截止 ${when(task.deadlineAt)}`}
        </p>
      )}
      {(task.lastResult || task.reason) && <p className="task-result">{task.reason ?? task.lastResult}</p>}
      {activity && (waiting || (task.officialRoom !== undefined && task.officialRoom !== task.room)) && (
        <p className="task-official">
          {waiting ? `需在官方页面处理：房间 ${officialRoom}` : `实际目标房间 ${officialRoom}`}
        </p>
      )}
      {(task.lastRunAt !== null || task.nextRunAt !== null) && (
        <p className="muted num">
          {task.lastRunAt !== null && `上次 ${when(task.lastRunAt)}`}
          {task.lastRunAt !== null && task.nextRunAt !== null && '　'}
          {task.nextRunAt !== null && `下次 ${when(task.nextRunAt)}`}
        </p>
      )}
      <div className="task-actions">
        {running || waiting
          ? <button type="button" className="btn-quiet small" disabled={locked}
              onClick={() => void taskAction('正在暂停', () => apiClient.pauseDouyuTask(task.id), '已暂停')}>暂停</button>
          : <button type="button" className="btn-solid small" disabled={locked || accountsBusy || !!blocked} title={blocked || undefined}
              onClick={() => void taskAction('正在启动', () => apiClient.startDouyuTask(task.id), '已启动')}>启动</button>}
        {activity && (
          <button type="button" className="btn-quiet small" disabled={locked || accountsBusy || task.accountId !== activeId}
            onClick={() => void accountAction('请在打开的官方窗口中处理，完成后关闭该窗口',
              () => apiClient.openDouyuTaskRoom(task.id), '官方窗口已关闭，请核对结果后手动启动')}>
            {waiting ? '打开官方页面' : task.kind === 'auto-fish' ? '打开官方钓鱼' : '打开官方房间'}
          </button>
        )}
        <select className="task-policy" value={task.policy} disabled={locked}
          aria-label={`房间 ${task.room} 的 ${account?.label ?? '未知账号'} ${KIND[task.kind]}运行条件`}
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
  const [loop, setLoop] = useState<LoopDraft>(EMPTY_LOOP)
  const [tried, setTried] = useState(false)
  const isMessage = kind === 'message-loop'
  const isActivity = isDouyuActivityKind(kind)
  const built = isMessage ? buildMessageSchedule(loop) : null
  const messageError = built && 'error' in built ? built.error : null
  const ready = !!accountId && room.trim() !== '' && !taskLane.pending
  const edit = <K extends keyof LoopDraft>(key: K, value: LoopDraft[K]): void => setLoop((current) => ({ ...current, [key]: value }))

  return (
    <form className="new-form" onSubmit={(event) => {
      event.preventDefault()
      setTried(true)
      if (!ready || messageError) return
      const message = built && 'schedule' in built ? built.schedule : undefined
      void taskAction('正在添加', () => apiClient.createDouyuTask({
        accountId, roomInput: room.trim(), kind, policy,
        repeatMinutes: !isMessage && !isActivity && daily ? 1440 : null,
        ...(message ? { message } : {}),
      }), '已添加，点击「启动」开始运行').then((ok) => { if (ok) onDone() })
    }}>
      <div className="field-stack">
        <span className="field-label">任务类型</span>
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
            {all.map((account) => <option key={account.id} value={account.id}>{account.label}{account.id === active?.id ? '（当前）' : ''}</option>)}
          </select>
        </label>
      </div>

      <div className="field-stack">
        <span className="field-label">运行条件</span>
        <Segmented label="执行条件" value={policy} onChange={setPolicy}
          options={(Object.keys(POLICY) as DouyuTaskPolicy[]).map((value) => ({ value, label: POLICY[value] }))} />
      </div>

      {!isMessage && !isActivity && (
        <Switch label="每天签到一次" checked={daily} onChange={setDaily} />
      )}

      {(kind === 'auto-fish' || kind === 'treasure-box') && (
        <ActivityOptions fishing={kind === 'auto-fish'} treasure={kind === 'treasure-box'} />
      )}

      {isMessage && <LoopEditor loop={loop} edit={edit} />}
      {isMessage && tried && messageError && <p className="form-error" role="alert">{messageError}</p>}

      <div className="row-end">
        <button type="button" className="btn-quiet" onClick={onDone}>取消</button>
        <button type="submit" className="btn-solid" disabled={!ready}>添加</button>
      </div>
    </form>
  )
}

function LoopEditor({ loop, edit }: { loop: LoopDraft; edit: <K extends keyof LoopDraft>(key: K, value: LoopDraft[K]) => void }): React.ReactNode {
  const automatic = loop.mode === 'automatic'
  const count = messageLines(loop.lines).length

  return (
    <>
      <div className="field-stack">
        <span className="field-label">文案</span>
        <Segmented label="文案选择" value={loop.mode} onChange={(mode: MessageSelection['mode']) => edit('mode', mode)}
          options={(['sequential', 'random', 'automatic'] as const).map((value) => ({ value, label: SELECTION_LABEL[value] }))} />
      </div>

      {automatic
        ? (
          <div className="field-stack">
            <span className="field-label">本地模板</span>
            <Segmented label="自动文案模板" value={loop.template} onChange={(template: LocalMessageTemplate) => edit('template', template)}
              options={(Object.keys(TEMPLATE_LABEL) as LocalMessageTemplate[]).map((value) => ({ value, label: TEMPLATE_LABEL[value] }))} />
            <ol className="task-template-preview" aria-label="模板预览">
              {templateLines(loop.template).map((line) => <li key={line}>{line}</li>)}
            </ol>
            <p className="muted">按顺序轮换以上本地模板，不调用外部文本服务。</p>
          </div>
        )
        : (
          <label className="field-stack">
            <span className="field-label">发送内容（每行一条，最多 100 条）{count > 0 ? `　已填 ${count} 条` : ''}</span>
            <textarea className="text-input" rows={4} value={loop.lines} aria-label="发送内容"
              onChange={(event) => edit('lines', event.target.value)} />
            {count > 1 && <span className="muted">{loop.mode === 'random' ? '每次随机选取一条。' : '按行顺序轮换，确认发送成功后才切换到下一条。'}</span>}
          </label>
        )}

      <div className="new-grid is-three">
        <label className="field-stack">
          <span className="field-label">发送间隔（秒）</span>
          <input className="text-input num" type="number" min={1} max={86400} value={loop.interval} aria-label="发送间隔(秒)"
            onChange={(event) => edit('interval', event.target.value)} />
        </label>
        <label className="field-stack">
          <span className="field-label">启动延迟（秒）</span>
          <input className="text-input num" type="number" min={0} max={86400} value={loop.delay} aria-label="启动延迟(秒)"
            onChange={(event) => edit('delay', event.target.value)} />
        </label>
        <label className="field-stack">
          <span className="field-label">发送次数（1 至 1000）</span>
          <input className="text-input num" type="number" min={1} max={1000} disabled={loop.unlimited} aria-label="发送次数"
            value={loop.runs} placeholder="必填" onChange={(event) => edit('runs', event.target.value)} />
        </label>
      </div>
      <Switch label="持续发送，直至暂停" checked={loop.unlimited} onChange={(unlimited) => edit('unlimited', unlimited)} />

      <div className="task-duration">
        <Switch label="限制总时长" detail="从启动时开始计时，包含启动延迟" checked={loop.limitDuration}
          onChange={(limitDuration) => edit('limitDuration', limitDuration)} />
        {loop.limitDuration && (
          <label className="field-stack">
            <span className="field-label">总时长（秒，1 至 86400）</span>
            <input className="text-input num" type="number" min={1} max={86400} value={loop.duration} aria-label="总时长(秒)"
              onChange={(event) => edit('duration', event.target.value)} />
          </label>
        )}
      </div>
      {loop.unlimited && !loop.limitDuration && (
        <p className="note-warn">未限制次数与总时长，任务将持续发送，直至手动暂停或出现未确认的结果。</p>
      )}

      <div className="field-stack">
        <span className="field-label">颜色{loop.colors.length > 1 ? '（按顺序轮换）' : ''}</span>
        <div className="color-picks" role="group" aria-label="发送颜色">
          {COLORS.map((name, color) => {
            const at = loop.colors.indexOf(color)
            return (
              <label key={color} className={at >= 0 ? 'is-on' : undefined}>
                <input type="checkbox" checked={at >= 0} aria-label={`发送颜色 ${name}`}
                  onChange={(event) => edit('colors', event.target.checked ? [...loop.colors, color] : loop.colors.filter((item) => item !== color))} />
                <i style={{ background: colorForIndex(color) }} />
                {at >= 0 && loop.colors.length > 1 && <b className="num">{at + 1}</b>}
              </label>
            )
          })}
        </div>
        <p className="muted">彩色弹幕需要账号已解锁对应颜色。仅在确认发送成功后计入次数，未确认的发送不会自动重试。</p>
      </div>
    </>
  )
}
