/**
 * Account, Yuba and batch automations (handoff items 43-51): check-ins, reward claims and
 * explicit follow/read tasks. Every automation is created paused and runs only after 启动;
 * the main process owns the schedule and the single account-write lane, so nothing here
 * keeps its own timer or posts to the platform. A receipt is not shown as a confirmed
 * result, and an unknown total never becomes a percentage.
 */

import { useState } from 'react'
import { apiClient, type ApiResult } from '../../app/apiClient'
import type { AutomationSnapshot, AutomationView } from '../../../electron/automationManager'
import type { DouyuAutomationKind, DouyuAutomationProgress, DouyuAutomationTarget } from '../../../server/douyu/automationTypes'
import type { DouyuTaskPolicy } from '../../../server/douyu/types'
import { Segmented } from '../kit'
import {
  ARENA_LABEL, GROUP_LABEL, KIND_ORDER, KIND_SPEC, TARGET_LABEL, YUBA_MODE_LABEL,
  buildAutomationRequest, yubaModeAllowed, type AutomationDraft, type KindGroup, type TargetChoice,
} from './automationKinds'
import { useAutomations } from './automationState'
import { LaneLine } from './DouyuDesk'
import type { DouyuData } from './useDouyu'
import './automations.css'

const POLICY: Record<DouyuTaskPolicy, string> = {
  foreground: '仅窗口在前台时', 'background-unlocked': '未锁屏时', 'background-locked': '锁屏时也运行',
}
const STATUS: Record<AutomationView['status'], string> = {
  paused: '暂停', queued: '等待', running: '进行中', succeeded: '完成', 'waiting-user': '待核对', failed: '失败',
}
const EVIDENCE: Record<DouyuAutomationProgress['evidence'], string> = {
  none: '暂无结果', 'official-state': '官方状态已确认', 'receipt-received': '已收到回执，尚未读回确认', unconfirmed: '结果未确认',
}

const when = (time: number): string => {
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
}
const repeatText = (minutes: number | null): string => minutes === null ? '单次'
  : minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`

function targetText(target: DouyuAutomationTarget): string {
  switch (target.type) {
    case 'account': return '账号'
    case 'room': return `房间 ${target.room}`
    case 'group': return `鱼吧 ${target.groupId}`
    case 'batch': return target.source === 'selected-rooms' ? `所选 ${target.rooms.length} 个房间` : TARGET_LABEL[target.source]
  }
}

function optionText(task: AutomationView): string[] {
  const { options } = task
  const parts: string[] = []
  if (options.yubaMode) parts.push(`${YUBA_MODE_LABEL[options.yubaMode]}模式`)
  if (options.maxSupplementCards !== undefined) parts.push(`补签卡最多 ${options.maxSupplementCards} 张`)
  if (options.arena) parts.push(ARENA_LABEL[options.arena])
  if (options.postIds) parts.push(`${options.postIds.length} 篇帖子`)
  if (options.followRooms) parts.push(`关注 ${options.followRooms.length} 个房间`)
  if (options.maxItems !== undefined) parts.push(`最多 ${options.maxItems} 项`)
  return parts
}

export function Automations({ data }: { data: DouyuData }): React.ReactNode {
  const { snapshot, lane, loading, act } = useAutomations()
  const [creating, setCreating] = useState(false)
  const tasks = snapshot?.tasks ?? []

  return (
    <div className="desk-pane automations">
      {creating
        ? <NewAutomation data={data} act={act} locked={!!lane.pending} onDone={() => setCreating(false)} />
        : <button type="button" className="btn-solid new-task" disabled={data.all.length === 0} onClick={() => setCreating(true)}>新建批量任务</button>}
      {data.all.length === 0 && !data.loading && <p className="muted">请先在「账号」中添加斗鱼账号。</p>}

      {!loading && tasks.length === 0 && !creating && (
        <p className="desk-empty">暂无批量任务。新建的任务默认暂停，点击「启动」后运行。</p>
      )}

      {tasks.length > 0 && (
        <ul className="task-list" aria-label="批量任务">
          {tasks.map((task) => <AutomationRow key={task.id} task={task} data={data} act={act} locked={!!lane.pending} />)}
        </ul>
      )}

      {tasks.length > 0 && (
        <p className="muted automation-foot">暂停或删除不会撤回已提交的请求。应用重启后全部批量任务处于暂停状态。</p>
      )}
      <LaneLine lane={lane} />
    </div>
  )
}

type Act = ReturnType<typeof useAutomations>['act']

function AutomationRow({ task, data, act, locked }: { task: AutomationView; data: DouyuData; act: Act; locked: boolean }): React.ReactNode {
  const spec = KIND_SPEC[task.kind]
  const account = data.all.find((item) => item.id === task.accountId)
  const [confirming, setConfirming] = useState(false)
  const scheduled = task.status === 'queued' || task.status === 'running'
  const progress = task.progress
  const review = task.status === 'waiting-user' || progress?.evidence === 'receipt-received' || progress?.evidence === 'unconfirmed'
  const details = [targetText(task.target), ...optionText(task), repeatText(task.repeatMinutes), POLICY[task.policy]]

  return (
    <li className="task automation" data-status={task.status} role="group" aria-label={`${spec.label} (${account?.label ?? '账号不可用'})`}>
      <div className="task-main">
        <span className="task-kind">{spec.label}</span>
        <span className="task-status" data-status={task.status}>{STATUS[task.status]}</span>
        <span className="muted">{account?.label ?? '账号不可用'} · {details.join(' · ')}</span>
      </div>

      {progress && <Progress progress={progress} />}

      {task.reason && <p className="task-result" data-status={task.status}>{task.reason}</p>}
      {review && <p className="automation-review">结果需在官方页面人工核对，核对后再手动启动。</p>}

      {(task.lastRunAt !== null || task.nextRunAt !== null) && (
        <p className="muted num">
          {task.lastRunAt !== null && `上次 ${when(task.lastRunAt)}`}
          {task.lastRunAt !== null && task.nextRunAt !== null && '　'}
          {task.nextRunAt !== null && `下次 ${when(task.nextRunAt)}`}
        </p>
      )}

      <div className="task-actions">
        {scheduled
          ? <button type="button" className="btn-quiet small" disabled={locked}
              onClick={() => void act('正在暂停', () => apiClient.feature('pauseDouyuAutomation', { id: task.id }), '已暂停')}>暂停</button>
          : <button type="button" className="btn-solid small" disabled={locked || !account} title={account ? undefined : '账号已删除'}
              onClick={() => void act('正在启动', () => apiClient.feature('startDouyuAutomation', { id: task.id }), '已启动')}>启动</button>}
        {confirming
          ? <span className="automation-confirm" role="group" aria-label="确认删除">
              <span className="muted">删除后不可恢复，已提交的请求不会撤回。</span>
              <button type="button" className="btn-quiet small is-danger" disabled={locked}
                onClick={() => void act('正在删除', () => apiClient.feature('removeDouyuAutomation', { id: task.id }), '已删除')
                  .then((ok) => { if (!ok) setConfirming(false) })}>确认删除</button>
              <button type="button" className="btn-quiet small" onClick={() => setConfirming(false)}>取消</button>
            </span>
          : <button type="button" className="btn-quiet small is-danger" disabled={locked} onClick={() => setConfirming(true)}>删除</button>}
      </div>
      {account && account.id !== data.accounts?.activeAccountId && !scheduled && (
        <p className="muted">仅在 {account.label} 为当前账号时运行。</p>
      )}
    </li>
  )
}

function Progress({ progress }: { progress: DouyuAutomationProgress }): React.ReactNode {
  const { completed, total, skipped, current, evidence } = progress
  const parts = [total === null ? `已完成 ${completed}，总数未知` : `已完成 ${completed} / ${total}`]
  if (skipped > 0) parts.push(`跳过 ${skipped}`)
  if (current) parts.push(`当前 ${current}`)
  parts.push(EVIDENCE[evidence])
  return (
    <div className="automation-progress">
      {total !== null && total > 0 && (
        <progress value={Math.min(completed + skipped, total)} max={total} aria-label="完成进度" />
      )}
      <p className="muted num">{parts.join(' · ')}</p>
    </div>
  )
}

const GROUPS: KindGroup[] = ['sign', 'claim', 'task']

function NewAutomation({ data, act, locked, onDone }: { data: DouyuData; act: Act; locked: boolean; onDone: () => void }): React.ReactNode {
  const { all, active, tasks } = data
  const [draft, setDraft] = useState<AutomationDraft>({
    accountId: active?.id ?? all[0]?.id ?? '', kind: 'followed-room-sign', target: 'followed-rooms',
    room: tasks?.currentRoom ?? '', groupId: '', rooms: '', yubaMode: 'normal', maxSupplementCards: '',
    arena: 'actqzs', postIds: '', followRooms: '', maxItems: '', policy: 'foreground', repeat: false, repeatMinutes: '1440',
  })
  const [tried, setTried] = useState(false)
  const spec = KIND_SPEC[draft.kind]
  const set = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]): void => setDraft((current) => ({ ...current, [key]: value }))

  const chooseKind = (kind: DouyuAutomationKind): void => setDraft((current) => {
    const targets = KIND_SPEC[kind].targets
    const target = targets.includes(current.target) ? current.target : targets[0]!
    return { ...current, kind, target, yubaMode: yubaModeAllowed(target, current.yubaMode) ? current.yubaMode : 'normal' }
  })
  const chooseTarget = (target: TargetChoice): void => setDraft((current) => ({
    ...current, target, yubaMode: yubaModeAllowed(target, current.yubaMode) ? current.yubaMode : 'normal',
  }))

  // The room is resolved to its real ID on submit, so validate everything else with a stand-in.
  const check = buildAutomationRequest(draft.target === 'room' ? { ...draft, room: draft.room.trim() ? '1' : '' } : draft)
  const error = 'error' in check ? check.error : null

  const submit = (): void => {
    setTried(true)
    if (error || locked) return
    const work = async (): Promise<ApiResult<AutomationSnapshot>> => {
      let room = draft.room
      if (draft.target === 'room') {
        const resolved = await apiClient.resolveDouyuRoom(draft.room.trim())
        if (!resolved.ok) return resolved
        if (!resolved.value.ok) return { ok: false, code: resolved.value.failure.code, message: resolved.value.failure.message }
        room = resolved.value.identity.room
      }
      const built = buildAutomationRequest({ ...draft, room })
      if ('error' in built) return { ok: false, code: 'invalid-arguments', message: built.error }
      return apiClient.feature('createDouyuAutomation', built.request)
    }
    void act('正在创建', work, '已创建，当前为暂停，点击「启动」后运行').then((ok) => { if (ok) onDone() })
  }

  return (
    <form className="new-form automation-form" aria-label="新建批量任务" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <div className="new-grid">
        <label className="field-stack">
          <span className="field-label">任务类型</span>
          <select value={draft.kind} aria-label="批量任务类型" onChange={(event) => chooseKind(event.target.value as DouyuAutomationKind)}>
            {GROUPS.map((group) => (
              <optgroup key={group} label={GROUP_LABEL[group]}>
                {KIND_ORDER.filter((kind) => KIND_SPEC[kind].group === group)
                  .map((kind) => <option key={kind} value={kind}>{KIND_SPEC[kind].label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="field-stack">
          <span className="field-label">账号</span>
          <select value={draft.accountId} aria-label="批量任务账号" onChange={(event) => set('accountId', event.target.value)}>
            {all.map((account) => <option key={account.id} value={account.id}>{account.label}{account.id === active?.id ? '（当前）' : ''}</option>)}
          </select>
        </label>
      </div>
      <p className="muted automation-note">{spec.note}</p>

      <div className="field-stack">
        <span className="field-label">目标范围</span>
        {spec.targets.length > 1
          ? <Segmented label="目标范围" value={draft.target} onChange={chooseTarget}
              options={spec.targets.map((value) => ({ value, label: TARGET_LABEL[value] }))} />
          : <span className="automation-fixed">{TARGET_LABEL[draft.target]}</span>}
      </div>

      {draft.target === 'room' && (
        <label className="field-stack">
          <span className="field-label">目标房间</span>
          <input className="text-input" value={draft.room} placeholder="房间号或链接" aria-label="目标房间号"
            onChange={(event) => set('room', event.target.value)} />
        </label>
      )}
      {draft.target === 'group' && (
        <label className="field-stack">
          <span className="field-label">鱼吧 ID</span>
          <input className="text-input num" value={draft.groupId} inputMode="numeric" aria-label="鱼吧 ID"
            onChange={(event) => set('groupId', event.target.value)} />
        </label>
      )}
      {draft.target === 'selected-rooms' && (
        <IdList label="房间号列表" hint="填写数字房间号，以空格、逗号或换行分隔，最多 100 个。" value={draft.rooms} onChange={(value) => set('rooms', value)} />
      )}

      {spec.fields.includes('yuba') && (
        <div className="field-stack">
          <span className="field-label">签到模式</span>
          <Segmented label="鱼吧签到模式" value={draft.yubaMode} onChange={(value) => set('yubaMode', value)}
            options={(['normal', 'fast', 'supplement'] as const).filter((mode) => yubaModeAllowed(draft.target, mode))
              .map((value) => ({ value, label: YUBA_MODE_LABEL[value] }))} />
          {draft.yubaMode === 'supplement' && (
            <label className="field-stack">
              <span className="field-label">补签卡最多使用数量</span>
              <input className="text-input num automation-short" type="number" min={1} max={100} value={draft.maxSupplementCards}
                aria-label="补签卡最多使用数量" onChange={(event) => set('maxSupplementCards', event.target.value)} />
              <span className="muted">仅消耗已有补签卡，不购买。</span>
            </label>
          )}
        </div>
      )}
      {spec.fields.includes('arena') && (
        <div className="field-stack">
          <span className="field-label">活动</span>
          <Segmented label="活动类型" value={draft.arena} onChange={(value) => set('arena', value)}
            options={(['actqzs', 'cardArena'] as const).map((value) => ({ value, label: ARENA_LABEL[value] }))} />
        </div>
      )}
      {spec.fields.includes('postIds') && (
        <IdList label="帖子 ID 列表" hint="填写官方鱼吧帖子的数字 ID，最多 100 个。" value={draft.postIds} onChange={(value) => set('postIds', value)} />
      )}
      {spec.fields.includes('followRooms') && (
        <IdList label="关注房间号列表" hint="填写需要关注的数字房间号，最多 100 个。" value={draft.followRooms} onChange={(value) => set('followRooms', value)} />
      )}
      {spec.fields.includes('maxItems') && (
        <label className="field-stack">
          <span className="field-label">最多处理数量（可留空）</span>
          <input className="text-input num automation-short" type="number" min={1} max={2000} value={draft.maxItems} placeholder="默认"
            aria-label="最多处理数量" onChange={(event) => set('maxItems', event.target.value)} />
        </label>
      )}

      <div className="field-stack">
        <span className="field-label">运行条件</span>
        <Segmented label="执行条件" value={draft.policy} onChange={(value) => set('policy', value)}
          options={(Object.keys(POLICY) as DouyuTaskPolicy[]).map((value) => ({ value, label: POLICY[value] }))} />
      </div>

      <div className="field-stack">
        <span className="field-label">执行方式</span>
        <Segmented label="执行方式" value={draft.repeat ? 'repeat' : 'once'} onChange={(value) => set('repeat', value === 'repeat')}
          options={[{ value: 'once', label: '单次' }, { value: 'repeat', label: '重复' }]} />
        {draft.repeat && (
          <label className="field-stack">
            <span className="field-label">重复间隔（分钟，60 至 43200）</span>
            <input className="text-input num automation-short" type="number" min={60} max={43200} value={draft.repeatMinutes}
              aria-label="重复间隔(分钟)" onChange={(event) => set('repeatMinutes', event.target.value)} />
          </label>
        )}
      </div>

      {tried && error && <p className="form-error" role="alert">{error}</p>}

      <div className="row-end">
        <button type="button" className="btn-quiet" onClick={onDone}>取消</button>
        <button type="submit" className="btn-solid" disabled={locked}>创建</button>
      </div>
    </form>
  )
}

function IdList({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (value: string) => void }): React.ReactNode {
  return (
    <label className="field-stack">
      <span className="field-label">{label}</span>
      <textarea className="text-input num" rows={2} value={value} aria-label={label} onChange={(event) => onChange(event.target.value)} />
      <span className="muted">{hint}</span>
    </label>
  )
}
