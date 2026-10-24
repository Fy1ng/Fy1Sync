import { useEffect, useRef, useState } from 'react'
import { apiClient, type ApiResult } from '../app/apiClient'
import type {
  DouyuAccountsSnapshot, DouyuAccountSummary, DouyuMessageSchedule, DouyuTaskKind, DouyuTaskPolicy, DouyuTasksSnapshot, DouyuTaskView,
} from '../../server/douyu/types'
import { readMessageSchedule } from '../../server/douyu/taskConfig'
import { colorForIndex } from '../../server/danmaku/douyuProtocol'
import { DouyuRenewalPanel } from './DouyuRenewalPanel'
import './DouyuTools.css'

const POLICY_LABELS: Record<DouyuTaskPolicy, string> = {
  foreground: '仅前台',
  'background-unlocked': '后台未锁屏',
  'background-locked': '后台含锁屏',
}
const STATUS_LABELS: Record<DouyuTaskView['status'], string> = {
  paused: '已暂停', queued: '等待执行', running: '执行中', 'waiting-user': '等待手动处理',
  succeeded: '已完成', failed: '失败', stopped: '已停止',
}
const TASK_LABELS: Record<DouyuTaskKind, string> = { 'room-sign': '直播间签到', 'yuba-sign': '鱼吧签到', 'message-loop': '弹幕发送' }
const COLOR_LABELS = ['普通', '红色', '蓝色', '绿色', '橙色', '紫色', '粉色']
const numericValue = (value: number): number | '' => Number.isFinite(value) ? value : ''

function taskScheduleLabel(task: DouyuTaskView): string {
  if (task.kind === 'message-loop' && task.message) {
    return task.message.maxRuns === 1 ? '发送 1 次' : `每 ${task.message.intervalSeconds} 秒 / ${task.message.maxRuns === null ? '持续发送' : `共 ${task.message.maxRuns} 次`}`
  }
  return task.repeatMinutes === null ? '单次' : task.repeatMinutes === 1440 ? '每天' : `每 ${task.repeatMinutes} 分钟`
}

function PolicyOptions(): React.ReactNode {
  return Object.entries(POLICY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)
}

function accountStatus(account: DouyuAccountSummary): string {
  if (account.busy) return '操作中...'
  if (!account.login.loggedIn) return '未登录'
  const expiresAt = account.login.expiresAt
  const expiry = expiresAt ? new Date(expiresAt * 1000) : null
  return `已登录${expiry && Number.isFinite(expiry.getTime()) ? `, 到期 ${expiry.toISOString().slice(0, 10)}` : ''}`
}

function scheduled(task: DouyuTaskView): boolean {
  return task.status === 'queued' || task.status === 'running' || task.nextRunAt !== null
}

function timeLabel(time: number): string {
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '未知'
}

export interface DouyuToolsProps {
  defaultRoom?: string | null
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
}

/** Account mutations and task control remain separate so a pending login cannot prevent pausing work. */
export function DouyuTools({ defaultRoom = null, disabled = false, onBusyChange }: DouyuToolsProps): React.ReactNode {
  const [accounts, setAccounts] = useState<DouyuAccountsSnapshot | null>(null)
  const [tasks, setTasks] = useState<DouyuTasksSnapshot | null>(null)
  const [accountsLoading, setAccountsLoading] = useState(true)
  const [tasksLoading, setTasksLoading] = useState(true)
  const [accountPending, setAccountPending] = useState('')
  const [taskPending, setTaskPending] = useState('')
  const [accountNotice, setAccountNotice] = useState('')
  const [taskNotice, setTaskNotice] = useState('')
  const [accountError, setAccountError] = useState('')
  const [taskError, setTaskError] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const [chosenAccountId, setChosenAccountId] = useState('')
  const [roomInput, setRoomInput] = useState<string | null>(null)
  const [kind, setKind] = useState<DouyuTaskKind>('room-sign')
  const [policy, setPolicy] = useState<DouyuTaskPolicy>('foreground')
  const [repeat, setRepeat] = useState('once')
  const [messageDraft, setMessageDraft] = useState<DouyuMessageSchedule>({
    text: '', colors: [0], intervalSeconds: 60, initialDelaySeconds: 0, maxRuns: 10,
  })
  const [finiteRuns, setFiniteRuns] = useState(10)
  const mounted = useRef(false)
  const accountInFlight = useRef(false)
  const taskInFlight = useRef(false)
  const accountRevision = useRef(0)
  const taskRevision = useRef(0)

  useEffect(() => {
    mounted.current = true
    let current = true
    const accountVersion = ++accountRevision.current
    const taskVersion = taskRevision.current
    const unsubscribe = apiClient.subscribeDouyuTasks(snapshot => {
      if (!current || !Array.isArray(snapshot?.tasks) || !Array.isArray(snapshot?.retainedRooms)) return
      taskRevision.current++
      setTasks(snapshot)
      setTasksLoading(false)
    })
    void apiClient.listDouyuAccounts().then(result => {
      if (!current || accountVersion !== accountRevision.current) return
      if (result.ok && Array.isArray(result.value?.accounts)) setAccounts(result.value)
      else setAccountError(result.ok ? '无法读取斗鱼账号, 请刷新状态.' : result.message)
    }).catch(() => { if (current) setAccountError('无法读取斗鱼账号, 请刷新状态.') })
      .finally(() => { if (current) setAccountsLoading(false) })
    void apiClient.getDouyuTasks().then(result => {
      // A subscription may deliver a newer state while the initial read is in flight.
      if (!current || taskVersion !== taskRevision.current) return
      if (result.ok && Array.isArray(result.value?.tasks) && Array.isArray(result.value?.retainedRooms)) setTasks(result.value)
      else setTaskError(result.ok ? '无法读取斗鱼任务, 请刷新任务.' : result.message)
    }).catch(() => {
      if (current && taskVersion === taskRevision.current) setTaskError('无法读取斗鱼任务, 请刷新任务.')
    }).finally(() => { if (current) setTasksLoading(false) })
    return () => { current = false; mounted.current = false; unsubscribe() }
  }, [])

  const allAccounts = accounts?.accounts ?? []
  const activeAccount = allAccounts.find(account => account.id === accounts?.activeAccountId)
  const accountBusy = !!accountPending || allAccounts.some(account => account.busy)
  const accountLocked = disabled || accountsLoading || accountBusy
  const taskLocked = tasksLoading || !!taskPending
  const selectedAccountId = allAccounts.some(account => account.id === chosenAccountId)
    ? chosenAccountId : activeAccount?.id ?? allAccounts[0]?.id ?? ''
  const taskRoom = roomInput ?? defaultRoom ?? tasks?.currentRoom ?? ''
  const messageTask = kind === 'message-loop'
  const messageSchedule = readMessageSchedule(messageDraft)
  const rooms = [...new Set([
    ...(tasks?.currentRoom ? [tasks.currentRoom] : []),
    ...(tasks?.retainedRooms ?? []),
    ...(tasks?.tasks.map(task => task.room) ?? []),
  ])]

  useEffect(() => {
    onBusyChange?.(accountBusy)
    return () => { onBusyChange?.(false) }
  }, [accountBusy, onBusyChange])

  const accountAction = async (
    pending: string,
    work: () => Promise<ApiResult<DouyuAccountsSnapshot>>,
    success: string | ((snapshot: DouyuAccountsSnapshot) => string),
    refresh = false,
  ): Promise<boolean> => {
    if (accountInFlight.current || disabled || (!refresh && accountLocked)) return false
    accountInFlight.current = true
    accountRevision.current++
    setAccountPending(pending)
    setAccountError('')
    setAccountNotice('')
    try {
      const result = await work()
      if (!mounted.current) return false
      if (!result.ok) { setAccountError(result.message); return false }
      if (!Array.isArray(result.value?.accounts)) { setAccountError('无法读取斗鱼账号, 请刷新状态.'); return false }
      setAccounts(result.value)
      setAccountNotice(typeof success === 'function' ? success(result.value) : success)
      return true
    } catch {
      if (mounted.current) setAccountError('斗鱼账号操作失败, 请重试.')
      return false
    } finally {
      accountInFlight.current = false
      if (mounted.current) setAccountPending('')
    }
  }

  const taskAction = async (
    pending: string,
    work: () => Promise<ApiResult<DouyuTasksSnapshot>>,
    success: string,
  ): Promise<void> => {
    if (taskInFlight.current || tasksLoading) return
    taskInFlight.current = true
    const version = taskRevision.current
    setTaskPending(pending)
    setTaskNotice('')
    setTaskError('')
    try {
      const result = await work()
      if (!mounted.current) return
      if (!result.ok) { setTaskError(result.message); return }
      if (!Array.isArray(result.value?.tasks) || !Array.isArray(result.value?.retainedRooms)) {
        setTaskError('无法读取斗鱼任务, 请刷新任务.')
        return
      }
      // Keep newer executor events instead of replacing them with an older action response.
      if (version === taskRevision.current) setTasks(result.value)
      setTaskNotice(success)
    } catch {
      if (mounted.current) setTaskError('斗鱼任务操作失败, 请重试.')
    } finally {
      taskInFlight.current = false
      if (mounted.current) setTaskPending('')
    }
  }

  const login = (account: DouyuAccountSummary) => accountAction(
    `正在登录 ${account.label}. 请在打开的 Chrome 窗口中登录, 完成后关闭该窗口.`,
    () => apiClient.loginDouyuAccount(account.id),
    snapshot => snapshot.accounts.find(item => item.id === account.id)?.login.loggedIn
      ? `${account.label} 已登录. 登录完成后请重新加载片源.`
      : `${account.label} 尚未登录. 请重新登录并完成 Chrome 中的验证.`,
  )
  const loginYuba = (account: DouyuAccountSummary) => accountAction(
    `正在登录 ${account.label} 的鱼吧. 请在打开的 Chrome 窗口中完成登录, 然后关闭窗口.`,
    () => apiClient.loginDouyuYubaAccount(account.id),
    `${account.label} 的鱼吧登录窗口已关闭. 启动签到任务时会检查登录状态.`,
  )

  return <section className="douyu-tools" aria-label="斗鱼账号和任务">
    <div className="douyu-tools-summary">
      <h3>斗鱼</h3>
      <span className="hint">{accountsLoading ? '正在读取账号...' : activeAccount
        ? `活动账号: ${activeAccount.label}, ${accountStatus(activeAccount)}` : '当前没有活动账号'}</span>
      <button type="button" disabled={accountLocked || !activeAccount} onClick={() => { if (activeAccount) void login(activeAccount) }}>
        登录斗鱼
      </button>
    </div>
    <p className="hint">每个账号独立保存登录资料. 登录时请在 Chrome 中手动完成, 然后关闭窗口.</p>
    <details className="douyu-tools-details">
      <summary>管理斗鱼账号 ({allAccounts.length})</summary>
      <div className="douyu-tools-body">
        {!accountsLoading && allAccounts.length === 0 && <p className="hint">先新增账号, 再登录并激活.</p>}
        <ul className="douyu-account-list" aria-label="斗鱼账号列表">
          {allAccounts.map(account => <li className="douyu-account" key={account.id} role="group" aria-label={`斗鱼账号 ${account.label}`}>
            <div className="douyu-account-heading">
              <strong>{account.label}</strong>
              {account.id === accounts?.activeAccountId && <span className="badge douyu-active">当前活动</span>}
              <span className="hint">{accountStatus(account)}</span>
            </div>
            {editingId === account.id ? <form className="douyu-account-edit" onSubmit={event => {
              event.preventDefault()
              const label = editingLabel.trim()
              if (!label) return
              void accountAction('正在保存账号标签...', () => apiClient.renameDouyuAccount(account.id, label), '账号标签已保存.')
                .then(saved => { if (saved && mounted.current) setEditingId(null) })
            }}>
              <label className="field"><span>新账号标签</span>
                <input value={editingLabel} onChange={event => setEditingLabel(event.target.value)} maxLength={40} disabled={accountLocked} autoFocus />
              </label>
              <div className="source-actions">
                <button type="submit" className="small" disabled={accountLocked || !editingLabel.trim()}>保存标签</button>
                <button type="button" className="ghost small" disabled={!!accountPending} onClick={() => setEditingId(null)}>取消</button>
              </div>
            </form> : <div className="source-actions">
              <button type="button" className="small" disabled={accountLocked} onClick={() => void login(account)}>登录</button>
              <button type="button" className="small" disabled={accountLocked} onClick={() => void loginYuba(account)}>登录鱼吧</button>
              {account.id !== accounts?.activeAccountId && <button type="button" className="small" disabled={accountLocked}
                onClick={() => void accountAction('正在切换活动账号...', () => apiClient.activateDouyuAccount(account.id), `${account.label} 已设为活动账号.`)}>激活</button>}
              <button type="button" className="ghost small" disabled={accountLocked} onClick={() => { setEditingId(account.id); setEditingLabel(account.label) }}>改名</button>
              <button type="button" className="ghost small" disabled={accountLocked || (!account.login.loggedIn && account.login.cookieCount === 0)}
                onClick={() => void accountAction('正在退出账号...', () => apiClient.logoutDouyuAccount(account.id), `${account.label} 已退出, 登录资料已清除.`)}>退出</button>
              <button type="button" className="ghost small danger" disabled={accountLocked}
                onClick={() => void accountAction('正在删除账号...', () => apiClient.removeDouyuAccount(account.id), `${account.label} 已删除.`)}>删除</button>
            </div>}
          </li>)}
        </ul>
        <form className="douyu-account-add" onSubmit={event => {
          event.preventDefault()
          const label = newLabel.trim()
          if (!label) return
          void accountAction('正在新增账号...', () => apiClient.addDouyuAccount(label), `${label} 已新增.`)
            .then(saved => { if (saved && mounted.current) setNewLabel('') })
        }}>
          <label className="field"><span>斗鱼账号标签</span>
            <input placeholder="例如 日常账号" value={newLabel} onChange={event => setNewLabel(event.target.value)} disabled={accountLocked} maxLength={40} />
          </label>
          <button type="submit" disabled={accountLocked || !newLabel.trim()}>新增账号</button>
        </form>
        <div className="source-actions"><button type="button" className="ghost small" disabled={disabled || accountsLoading || !!accountPending}
          onClick={() => void accountAction('正在刷新账号...', () => apiClient.listDouyuAccounts(), '账号状态已刷新.', true)}>刷新状态</button></div>
        <p className="hint">同一时间仅激活一个账号. 退出会清除所选账号的登录资料, 删除会移除该账号及其任务.</p>
      </div>
    </details>
    {(accountPending || accountNotice) && <p role="status" className="hint">{accountPending || accountNotice}</p>}
    {accountError && <p role="alert" className="dialog-error">{accountError}</p>}

    <DouyuRenewalPanel accountId={activeAccount?.id ?? null} accountLabel={activeAccount?.label ?? '未选择账号'}
      disabled={accountLocked || !activeAccount?.login.loggedIn} />

    <details className="douyu-tools-details">
      <summary>房间任务 ({tasks?.tasks.length ?? 0})</summary>
      <div className="douyu-tools-body">
        <p className="hint">新建任务默认为暂停, 点击启动后才会执行. 应用退出后任务停止, 重新打开应用后需手动启动.</p>
        {messageTask
          ? <p className="hint">发送内容随任务配置保存在本机. 每次启动从第 1 次重新计数, 仅在确认成功后继续. 需要验证或结果未知时停止, 不自动重发.</p>
          : kind === 'room-sign'
          ? <p className="hint">直播间签到仍需到官方房间核对结果, 暂不会自动重复提交. 每日设置仅保存计划.</p>
          : <p className="hint">先在账号管理中登录鱼吧. 仅对已加入的鱼吧签到, 已签到时跳过. 确认完成后才安排下一次, 遇到验证或未知结果会停止并提示.</p>}
        <form className="douyu-task-create" onSubmit={event => {
          event.preventDefault()
          if (!selectedAccountId || !taskRoom.trim() || accountLocked || (messageTask && !messageSchedule)) return
          void taskAction(messageTask ? '正在创建发送任务...' : '正在创建签到任务...', () => apiClient.createDouyuTask({
            accountId: selectedAccountId, roomInput: taskRoom.trim(), kind, policy,
            repeatMinutes: !messageTask && repeat === 'daily' ? 1440 : null,
            ...(messageTask && messageSchedule ? { message: messageSchedule } : {}),
          }), messageTask ? '发送任务已创建, 当前为暂停.' : '签到任务已创建, 当前为暂停.')
        }}>
          <label className="field"><span>任务账号</span>
            <select value={selectedAccountId} disabled={accountLocked || taskLocked || !allAccounts.length} onChange={event => setChosenAccountId(event.target.value)}>
              {!allAccounts.length && <option value="">请先新增账号</option>}
              {allAccounts.map(account => <option key={account.id} value={account.id}>{account.label}{account.id === accounts?.activeAccountId ? ' (活动)' : ''}</option>)}
            </select>
          </label>
          <label className="field"><span>任务房间号或地址</span>
            <input value={taskRoom} placeholder="例如 9999 或 douyu.com/9999" disabled={taskLocked} onChange={event => setRoomInput(event.target.value)} />
          </label>
          <label className="field"><span>任务类型</span>
            <select aria-label="任务类型" value={kind} disabled={taskLocked} onChange={event => setKind(event.target.value as DouyuTaskKind)}>
              <option value="room-sign">直播间签到</option><option value="yuba-sign">鱼吧签到</option><option value="message-loop">延迟/循环发送弹幕</option>
            </select>
          </label>
          <label className="field"><span>执行条件</span>
            <select aria-label="执行条件" value={policy} disabled={taskLocked} onChange={event => setPolicy(event.target.value as DouyuTaskPolicy)}><PolicyOptions /></select>
          </label>
          {!messageTask && <label className="field"><span>执行周期</span>
            <select aria-label="执行周期" value={repeat} disabled={taskLocked} onChange={event => setRepeat(event.target.value)}>
              <option value="once">单次</option><option value="daily">每天</option>
            </select>
          </label>}
          {messageTask && <>
            <label className="field douyu-message-wide"><span>发送内容</span>
              <textarea rows={3} value={messageDraft.text} disabled={taskLocked}
                onChange={event => { const text = event.target.value; setMessageDraft(value => ({ ...value, text })) }} />
            </label>
            <label className="field"><span>发送间隔(秒)</span>
              <input type="number" min={1} max={86400} step={1} required value={numericValue(messageDraft.intervalSeconds)} disabled={taskLocked}
                onChange={event => { const intervalSeconds = event.target.valueAsNumber; setMessageDraft(value => ({ ...value, intervalSeconds })) }} />
            </label>
            <label className="field"><span>启动延迟(秒)</span>
              <input type="number" min={0} max={86400} step={1} required value={numericValue(messageDraft.initialDelaySeconds)} disabled={taskLocked}
                onChange={event => { const initialDelaySeconds = event.target.valueAsNumber; setMessageDraft(value => ({ ...value, initialDelaySeconds })) }} />
            </label>
            <label className="field"><span>发送次数</span>
              <input type="number" min={1} max={1000} step={1} required value={numericValue(messageDraft.maxRuns ?? finiteRuns)} disabled={taskLocked || messageDraft.maxRuns === null}
                onChange={event => { const maxRuns = event.target.valueAsNumber; setFiniteRuns(maxRuns); setMessageDraft(value => ({ ...value, maxRuns })) }} />
            </label>
            <label className="douyu-message-unlimited"><input type="checkbox" checked={messageDraft.maxRuns === null} disabled={taskLocked}
              onChange={event => { const unlimited = event.target.checked; setMessageDraft(value => ({ ...value, maxRuns: unlimited ? null : finiteRuns })) }} />持续发送直到暂停</label>
            <fieldset className="douyu-message-wide douyu-message-colors" disabled={taskLocked}>
              <legend>发送颜色(多选自动变色)</legend>
              <div>{COLOR_LABELS.map((label, color) => <label key={color}>
                <input type="checkbox" aria-label={`发送颜色 ${label}`} checked={messageDraft.colors.includes(color)}
                  onChange={event => { const checked = event.target.checked; setMessageDraft(value => ({ ...value,
                    colors: checked ? [...value.colors, color] : value.colors.filter(item => item !== color),
                  })) }} />
                <span className="douyu-color-swatch" style={{ backgroundColor: colorForIndex(color) }} />{label}
              </label>)}</div>
              <p className="hint">{messageDraft.colors.length > 1 ? '轮换顺序' : '固定颜色'}: {messageDraft.colors.map(color => COLOR_LABELS[color]).join(' > ') || '请选择颜色'}.</p>
            </fieldset>
            <p className="hint douyu-message-wide">间隔会同时遵守服务器冷却. 彩色弹幕需要斗鱼已解锁对应颜色, 不可用时会停止并提示.</p>
            {!messageSchedule && messageDraft.text.length > 0 && <p className="dialog-error douyu-message-wide" role="alert">请检查内容, 时间和次数, 并至少选择一种颜色. 内容最多 500 个字符, 不支持换行.</p>}
          </>}
          <button type="submit" disabled={accountLocked || taskLocked || !selectedAccountId || !taskRoom.trim() || (messageTask && !messageSchedule)}>{messageTask ? '创建发送任务' : '创建签到任务'}</button>
        </form>
        {!activeAccount?.login.loggedIn && <p className="hint">可以先创建暂停任务. 启动前请登录并激活任务所用的账号.</p>}
        {tasks && <p className="hint">当前房间: {tasks.currentRoom ?? '未连接'}. 应用状态: {tasks.runtime.suspended ? '已休眠'
          : tasks.runtime.locked ? '已锁屏' : tasks.runtime.foreground ? '前台' : '后台未锁屏'}.</p>}
        {tasksLoading && <p className="hint" role="status">正在读取斗鱼任务...</p>}
        {tasks?.tasks.length === 0 && <p className="hint">暂无房间任务.</p>}
        <div className="douyu-room-list">
          {rooms.map(room => <section key={room} className="douyu-room" aria-label={`任务房间 ${room}`}>
            <div className="douyu-room-heading">
              <strong>房间 {room}</strong>
              {room === tasks?.currentRoom && <span className="badge">当前房间</span>}
              <label className="douyu-retain-room">
                <input type="checkbox" checked={tasks?.retainedRooms.includes(room) ?? false} disabled={taskLocked}
                  aria-label={`保留房间 ${room} 的任务`} onChange={event => {
                    const retain = event.target.checked
                    void taskAction('正在更新保留房间...', () => apiClient.retainDouyuTaskRoom(room, retain), retain ? `已保留房间 ${room} 的任务.` : `已取消保留房间 ${room}.`)
                  }} />保留房间任务
              </label>
              {tasks?.retainedRooms.includes(room) && <button type="button" className="ghost small" disabled={taskLocked}
                onClick={() => void taskAction('正在关闭保留房间...', () => apiClient.closeDouyuTaskRoom(room), `已关闭房间 ${room} 的保留任务.`)}>关闭保留房间</button>}
            </div>
            <ul className="douyu-task-list">
              {tasks?.tasks.filter(task => task.room === room).map(task => {
                const account = allAccounts.find(item => item.id === task.accountId)
                const startProblem = !account ? '账号不可用' : account.id !== accounts?.activeAccountId ? '激活该账号后可启动'
                  : !account.login.loggedIn ? '登录该账号后可启动' : ''
                return <li className="douyu-task" key={task.id} role="group" aria-label={`${task.kind === 'message-loop' ? '发送任务' : task.kind === 'yuba-sign' ? '鱼吧签到任务' : '签到任务'} ${room} (${account?.label ?? '账号不可用'})`}>
                  <div className="douyu-task-heading"><strong>{TASK_LABELS[task.kind]}</strong>
                    <span className="hint">{account?.label ?? '账号不可用'} / {taskScheduleLabel(task)}</span>
                    <span className="douyu-task-status" data-state={task.status}>{STATUS_LABELS[task.status]}</span>
                  </div>
                  {task.kind === 'message-loop' && task.message && <>
                    <p className="douyu-message-template">{task.message.text}</p>
                    <p className="hint">本轮已确认 {task.completedRuns ?? 0} 次{task.message.maxRuns !== null ? ` / 共 ${task.message.maxRuns} 次` : ', 持续发送'}.
                      {' '}启动延迟 {task.message.initialDelaySeconds} 秒. 颜色: {task.message.colors.map(color => COLOR_LABELS[color]).join(' > ')}.</p>
                  </>}
                  {task.lastResult && <p className="douyu-task-result">结果: {task.lastResult}</p>}
                  {task.reason && <p className="hint">{task.reason}</p>}
                  {(task.lastRunAt !== null || task.nextRunAt !== null) && <p className="hint">
                    {task.lastRunAt !== null ? `上次执行: ${timeLabel(task.lastRunAt)}.` : ''}
                    {task.nextRunAt !== null ? ` 下次执行: ${timeLabel(task.nextRunAt)}.` : ''}
                  </p>}
                  <div className="douyu-task-actions">
                    <label className="douyu-task-policy"><span>执行条件</span>
                      <select aria-label={`房间 ${room} 的 ${account?.label ?? '未知账号'} ${TASK_LABELS[task.kind]}执行条件`} value={task.policy} disabled={taskLocked}
                        onChange={event => { const nextPolicy = event.target.value as DouyuTaskPolicy; void taskAction('正在保存执行条件...', () => apiClient.setDouyuTaskPolicy(task.id, nextPolicy), '执行条件已更新.') }}><PolicyOptions /></select>
                    </label>
                    <button type="button" className="small" disabled={taskLocked || accountLocked || !!startProblem || scheduled(task)} title={startProblem || undefined}
                      onClick={() => void taskAction('正在启动任务...', () => apiClient.startDouyuTask(task.id), '已提交启动, 执行结果请查看任务状态.')}>启动</button>
                    <button type="button" className="ghost small" disabled={taskLocked || (!scheduled(task) && task.status !== 'waiting-user')}
                      onClick={() => void taskAction('正在暂停任务...', () => apiClient.pauseDouyuTask(task.id), '任务已暂停.')}>暂停</button>
                    <button type="button" className="ghost small" disabled={taskLocked}
                      onClick={() => void taskAction('正在移除任务...', () => apiClient.removeDouyuTask(task.id), '任务已移除.')}>移除</button>
                  </div>
                  {startProblem && <p className="hint">{startProblem}.</p>}
                </li>
              })}
            </ul>
          </section>)}
        </div>
        <p className="hint">保留房间后可继续执行该房间的任务. 关闭保留房间只停止该房间的任务.</p>
        <div className="source-actions"><button type="button" className="ghost small" disabled={taskLocked}
          onClick={() => void taskAction('正在刷新任务...', () => apiClient.getDouyuTasks(), '任务状态已刷新.')}>刷新任务</button></div>
      </div>
    </details>
    {(taskPending || taskNotice) && <p role="status" className="hint">{taskPending || taskNotice}</p>}
    {taskError && <p role="alert" className="dialog-error">{taskError}</p>}
  </section>
}
