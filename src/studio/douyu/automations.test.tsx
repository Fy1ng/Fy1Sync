/**
 * Batch automations: the form must send exactly what `readAutomationRequest` accepts, and
 * nothing more; supplement sign-in never runs without an explicit card limit; the list
 * follows pushed snapshots and only removes after a confirmation.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { FeatureEvent } from '../../../electron/featureContracts'
import type { AutomationView } from '../../../electron/automationManager'
import { readAutomationRequest } from '../../../server/douyu/automationTypes'
import { Automations } from './Automations'
import { useDouyu } from './useDouyu'

type Call = { method: string; args: unknown }
let calls: Call[] = []
let pushFeature: (event: FeatureEvent) => void = () => {}
let automations: AutomationView[] = []

const accounts = {
  activeAccountId: 'a1',
  accounts: [{ id: 'a1', label: '主号', active: true, busy: false, login: { loggedIn: true } },
    { id: 'a2', label: '小号', active: false, busy: false, login: { loggedIn: true } }],
}
const tasks = { activeAccountId: 'a1', currentRoom: '6979222', retainedRooms: [], runtime: { foreground: true, locked: false, suspended: false }, tasks: [] }

beforeEach(() => {
  calls = []
  automations = []
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      if (method === 'listDouyuAccounts') return { ok: true, value: accounts }
      if (method === 'getDouyuTasks') return { ok: true, value: tasks }
      if (method === 'getDouyuAutomations') return { ok: true, value: { tasks: automations } }
      if (method === 'createDouyuAutomation') return { ok: true, value: { tasks: automations } }
      if (method === 'removeDouyuAutomation') return { ok: true, value: { tasks: [] } }
      if (method === 'startDouyuAutomation') return { ok: true, value: { tasks: automations } }
      if (method === 'resolveDouyuRoom') {
        const input = (args as { input: string }).input
        return { ok: true, value: { ok: true, identity: { room: input === '9999' ? '6979222' : input, inputRoom: input } } }
      }
      return { ok: false, code: 'unexpected', message: 'unexpected' }
    }) as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
    subscribeDouyuTasks: () => () => {},
    subscribeFeatures: (listener: (event: FeatureEvent) => void) => { pushFeature = listener; return () => { pushFeature = () => {} } },
  } satisfies StreamSyncerBridge)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness(): React.ReactNode {
  const data = useDouyu()
  return <Automations data={data} />
}

const created = (): Call[] => calls.filter((call) => call.method === 'createDouyuAutomation')

/** The create args are `CreateAutomation`; the inner request must pass the backend reader as is. */
function expectAccepted(args: unknown): void {
  const value = args as Record<string, unknown>
  expect(Object.keys(value).sort()).toEqual(['accountId', 'kind', 'options', 'policy', 'repeatMinutes', 'target'])
  expect(() => readAutomationRequest({ taskId: 't1', accountId: value.accountId, target: value.target, kind: value.kind, options: value.options })).not.toThrow()
}

async function openForm(): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name: '新建批量任务' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  return screen.getByRole('form', { name: '新建批量任务' })
}

const chooseKind = (kind: string): void => { fireEvent.change(screen.getByLabelText('批量任务类型'), { target: { value: kind } }) }

describe('creating an automation', () => {
  it('sends a followed-room check-in as a paused single run for the current account', async () => {
    render(<Harness />)
    const form = await openForm()
    expect(within(form).getByLabelText('批量任务账号')).toHaveValue('a1')
    fireEvent.click(within(form).getByRole('button', { name: '创建' }))
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]!.args).toEqual({
      accountId: 'a1', kind: 'followed-room-sign', target: { type: 'batch', source: 'followed-rooms' },
      options: {}, policy: 'foreground', repeatMinutes: null,
    })
    expectAccepted(created()[0]!.args)
    expect(await screen.findByText('已创建，当前为暂停，点击「启动」后运行')).toBeInTheDocument()
  })

  it('requires an explicit card limit for supplement sign-in', async () => {
    render(<Harness />)
    await openForm()
    chooseKind('yuba-sign-all')
    fireEvent.click(screen.getByRole('radio', { name: '补签' }))
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('补签卡最多使用数量')
    expect(created()).toHaveLength(0)

    fireEvent.change(screen.getByLabelText('补签卡最多使用数量'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('radio', { name: '重复' }))
    fireEvent.change(screen.getByLabelText('重复间隔(分钟)'), { target: { value: '720' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]!.args).toEqual({
      accountId: 'a1', kind: 'yuba-sign-all', target: { type: 'batch', source: 'followed-yuba' },
      options: { yubaMode: 'supplement', maxSupplementCards: 5 }, policy: 'foreground', repeatMinutes: 720,
    })
    expectAccepted(created()[0]!.args)
  })

  it('offers fast sign-in only for all followed Yuba groups', async () => {
    render(<Harness />)
    await openForm()
    chooseKind('yuba-sign-all')
    fireEvent.click(screen.getByRole('radio', { name: '极速' }))
    fireEvent.click(screen.getByRole('radio', { name: '指定鱼吧' }))
    expect(screen.queryByRole('radio', { name: '极速' })).toBeNull()
    expect(screen.getByRole('radio', { name: '普通' })).toBeChecked()
    fireEvent.change(screen.getByLabelText('鱼吧 ID'), { target: { value: '12345' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]!.args).toMatchObject({ target: { type: 'group', groupId: '12345' }, options: { yubaMode: 'normal' } })
    expectAccepted(created()[0]!.args)
  })

  it('sends selected rooms, the arena choice and an item limit for an arena check-in', async () => {
    render(<Harness />)
    await openForm()
    chooseKind('arena-sign')
    fireEvent.click(screen.getByRole('radio', { name: '所选房间' }))
    fireEvent.change(screen.getByLabelText('房间号列表'), { target: { value: '100, 200\n300' } })
    fireEvent.click(screen.getByRole('radio', { name: 'cardArena' }))
    fireEvent.change(screen.getByLabelText('最多处理数量'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('radio', { name: '锁屏时也运行' }))
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]!.args).toEqual({
      accountId: 'a1', kind: 'arena-sign', target: { type: 'batch', source: 'selected-rooms', rooms: ['100', '200', '300'] },
      options: { arena: 'cardArena', maxItems: 3 }, policy: 'background-locked', repeatMinutes: null,
    })
    expectAccepted(created()[0]!.args)
  })

  it('rejects duplicate rooms before sending', async () => {
    render(<Harness />)
    await openForm()
    chooseKind('follow-task')
    fireEvent.change(screen.getByLabelText('关注房间号列表'), { target: { value: '100 100' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('编号存在重复')
    expect(created()).toHaveLength(0)
  })

  it('resolves a room target to its real room before creating', async () => {
    render(<Harness />)
    await openForm()
    chooseKind('anchor-star-follow')
    fireEvent.change(screen.getByLabelText('目标房间号'), { target: { value: '9999' } })
    fireEvent.change(screen.getByLabelText('关注房间号列表'), { target: { value: '300' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]!.args).toEqual({
      accountId: 'a1', kind: 'anchor-star-follow', target: { type: 'room', room: '6979222' },
      options: { followRooms: ['300'] }, policy: 'foreground', repeatMinutes: null,
    })
    expectAccepted(created()[0]!.args)
  })

  it('sends no options for account-level points and client check-ins', async () => {
    render(<Harness />)
    await openForm()
    chooseKind('points-sign')
    expect(screen.queryByLabelText('最多处理数量')).toBeNull()
    fireEvent.change(screen.getByLabelText('批量任务账号'), { target: { value: 'a2' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]!.args).toEqual({ accountId: 'a2', kind: 'points-sign', target: { type: 'account' }, options: {}, policy: 'foreground', repeatMinutes: null })
    expectAccepted(created()[0]!.args)
  })
})

const view = (patch: Partial<AutomationView>): AutomationView => ({
  id: '00000000-0000-4000-8000-000000000001', createdAt: 1, accountId: 'a1', kind: 'followed-room-sign',
  target: { type: 'batch', source: 'followed-rooms' }, options: {}, policy: 'foreground', repeatMinutes: 1440,
  status: 'paused', reason: null, nextRunAt: null, lastRunAt: null, progress: null, ...patch,
})

describe('the automation list', () => {
  it('follows pushed snapshots and never invents a percentage for an unknown total', async () => {
    render(<Harness />)
    await screen.findByText('暂无批量任务。新建的任务默认暂停，点击「启动」后运行。')
    act(() => pushFeature({ topic: 'automations', data: { tasks: [
      view({ status: 'running', progress: { completed: 2, total: 5, skipped: 1, current: '房间 100', evidence: 'official-state' } }),
      view({ id: '00000000-0000-4000-8000-000000000002', kind: 'watch-points', target: { type: 'account' }, repeatMinutes: null,
        status: 'waiting-user', reason: '操作未确认完成, 请核对结果后手动恢复',
        progress: { completed: 1, total: null, skipped: 0, current: null, evidence: 'receipt-received' } }),
    ] } }))
    const first = within(screen.getByRole('group', { name: '关注房间签到 (主号)' }))
    expect(first.getByText('已完成 2 / 5 · 跳过 1 · 当前 房间 100 · 官方状态已确认')).toBeInTheDocument()
    expect(first.getByRole('progressbar', { name: '完成进度' })).toHaveAttribute('max', '5')
    expect(first.getByText(/每 24 小时/)).toBeInTheDocument()
    expect(first.getByRole('button', { name: '暂停' })).toBeInTheDocument()

    const second = within(screen.getByRole('group', { name: '观看积分 (主号)' }))
    expect(second.getByText(/已完成 1，总数未知/)).toBeInTheDocument()
    expect(second.queryByRole('progressbar')).toBeNull()
    expect(second.getByText('操作未确认完成, 请核对结果后手动恢复')).toBeInTheDocument()
    expect(second.getByText('结果需在官方页面人工核对，核对后再手动启动。')).toBeInTheDocument()
  })

  it('removes only after a confirmation', async () => {
    automations = [view({})]
    render(<Harness />)
    const row = within(await screen.findByRole('group', { name: '关注房间签到 (主号)' }))
    fireEvent.click(row.getByRole('button', { name: '删除' }))
    expect(calls.some((call) => call.method === 'removeDouyuAutomation')).toBe(false)
    fireEvent.click(row.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(calls.filter((call) => call.method === 'removeDouyuAutomation'))
      .toEqual([{ method: 'removeDouyuAutomation', args: { id: '00000000-0000-4000-8000-000000000001' } }]))
    await waitFor(() => expect(screen.queryByRole('group', { name: '关注房间签到 (主号)' })).toBeNull())
  })
})
