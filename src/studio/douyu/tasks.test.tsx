/**
 * Room tasks: the message loop sends several texts with an explicit selection, never an
 * unlimited run by default; activity settings always go out as the whole object; rows show
 * confirmed sends, the deadline and the real official room to handle.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import { readMessageSchedule } from '../../../server/douyu/taskConfig'
import type { DouyuMessageSchedule, DouyuTaskView } from '../../../server/douyu/types'
import { Tasks } from './Tasks'
import { useDouyu } from './useDouyu'

type Call = { method: string; args: unknown }
let calls: Call[] = []
let rows: DouyuTaskView[] = []
let preferences = { version: 1, fishing: { mode: 'all' }, treasure: { crossRoom: false, claimDelayMs: 5000 } }

const accounts = { activeAccountId: 'a1', accounts: [{ id: 'a1', label: '主号', active: true, busy: false, login: { loggedIn: true } }] }
const snapshot = () => ({ activeAccountId: 'a1', currentRoom: '9999', retainedRooms: [], runtime: { foreground: true, locked: false, suspended: false }, tasks: rows })

beforeEach(() => {
  calls = []
  rows = []
  preferences = { version: 1, fishing: { mode: 'all' }, treasure: { crossRoom: false, claimDelayMs: 5000 } }
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      if (method === 'listDouyuAccounts') return { ok: true, value: accounts }
      if (method === 'getDouyuTasks' || method === 'createDouyuTask') return { ok: true, value: snapshot() }
      if (method === 'getDouyuActivityOptions') return { ok: true, value: preferences }
      if (method === 'setDouyuActivityOptions') { preferences = structuredClone(args) as typeof preferences; return { ok: true, value: preferences } }
      if (method === 'openDouyuTaskRoom') return { ok: true, value: accounts }
      return { ok: false, code: 'unexpected', message: 'unexpected' }
    }) as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
    subscribeDouyuTasks: () => () => {},
    subscribeFeatures: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness(): React.ReactNode {
  const data = useDouyu()
  return <Tasks data={data} defaultRoom="9999" />
}

const named = (method: string): Call[] => calls.filter((call) => call.method === method)

async function openForm(kind: string): Promise<void> {
  const button = await screen.findByRole('button', { name: '新任务' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  fireEvent.click(screen.getByRole('radio', { name: kind }))
}

describe('message loop', () => {
  it('sends several texts with the chosen selection, a count and a total duration', async () => {
    render(<Harness />)
    await openForm('定时弹幕')
    fireEvent.change(screen.getByLabelText('发送内容'), { target: { value: '第一条\n\n 第二条 \n第三条' } })
    fireEvent.click(screen.getByRole('radio', { name: '随机' }))
    fireEvent.change(screen.getByLabelText('发送间隔(秒)'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('启动延迟(秒)'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('发送次数'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('switch', { name: /限制总时长/ }))
    fireEvent.change(screen.getByLabelText('总时长(秒)'), { target: { value: '600' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '发送颜色 红' }))
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() => expect(named('createDouyuTask')).toHaveLength(1))
    const args = named('createDouyuTask')[0]!.args as { message: DouyuMessageSchedule }
    expect(args).toEqual({
      accountId: 'a1', roomInput: '9999', kind: 'message-loop', policy: 'foreground', repeatMinutes: null,
      message: {
        text: '第一条', colors: [0, 1], intervalSeconds: 30, initialDelaySeconds: 10, maxRuns: 5, maxDurationSeconds: 600,
        selection: { mode: 'random', texts: ['第一条', '第二条', '第三条'], template: 'cheer' },
      },
    })
    expect(readMessageSchedule(args.message)).toEqual(args.message)
  })

  it('does not default to an unlimited run: the count is required unless continuous sending is chosen', async () => {
    render(<Harness />)
    await openForm('定时弹幕')
    expect(screen.getByLabelText('发送次数')).toHaveValue(null)
    fireEvent.change(screen.getByLabelText('发送内容'), { target: { value: '提醒' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写发送次数')
    expect(named('createDouyuTask')).toHaveLength(0)

    fireEvent.click(screen.getByRole('switch', { name: '持续发送，直至暂停' }))
    expect(screen.getByLabelText('发送次数')).toBeDisabled()
    expect(screen.getByText(/未限制次数与总时长/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(named('createDouyuTask')).toHaveLength(1))
    const message = (named('createDouyuTask')[0]!.args as { message: DouyuMessageSchedule }).message
    expect(message.maxRuns).toBeNull()
    expect(message).not.toHaveProperty('maxDurationSeconds')
    expect(message.selection).toEqual({ mode: 'sequential', texts: ['提醒'], template: 'cheer' })
  })

  it('uses only the local templates for automatic texts and previews them', async () => {
    render(<Harness />)
    await openForm('定时弹幕')
    fireEvent.click(screen.getByRole('radio', { name: '自动文案' }))
    expect(screen.queryByLabelText('发送内容')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: '感谢' }))
    const preview = within(screen.getByRole('list', { name: '模板预览' }))
    expect(preview.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['感谢主播的精彩直播!', '辛苦了, 主播!'])
    fireEvent.change(screen.getByLabelText('发送次数'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(named('createDouyuTask')).toHaveLength(1))
    const message = (named('createDouyuTask')[0]!.args as { message: DouyuMessageSchedule }).message
    expect(message.selection).toEqual({ mode: 'automatic', texts: [], template: 'thanks' })
    expect(readMessageSchedule(message)).not.toBeNull()
  })
})

describe('activity settings', () => {
  it('sends the whole object when the fishing period changes', async () => {
    render(<Harness />)
    await openForm('钓鱼')
    fireEvent.click(await screen.findByRole('radio', { name: '仅大赛时段' }))
    await waitFor(() => expect(named('setDouyuActivityOptions')).toHaveLength(1))
    expect(named('setDouyuActivityOptions')[0]!.args).toEqual({ version: 1, fishing: { mode: 'contest' }, treasure: { crossRoom: false, claimDelayMs: 5000 } })
  })

  it('sends the whole object for the treasure switch and the claim delay', async () => {
    render(<Harness />)
    await openForm('开宝箱')
    fireEvent.click(await screen.findByRole('switch', { name: /跨房间领取宝箱/ }))
    await waitFor(() => expect(named('setDouyuActivityOptions')).toHaveLength(1))
    expect(named('setDouyuActivityOptions')[0]!.args).toEqual({ version: 1, fishing: { mode: 'all' }, treasure: { crossRoom: true, claimDelayMs: 5000 } })

    const delay = screen.getByLabelText('宝箱领取延迟(毫秒)')
    await waitFor(() => expect(delay).toBeEnabled())
    fireEvent.change(delay, { target: { value: '60001' } })
    expect(screen.getByRole('button', { name: '保存延迟' })).toBeDisabled()
    fireEvent.change(delay, { target: { value: '8000' } })
    fireEvent.click(screen.getByRole('button', { name: '保存延迟' }))
    await waitFor(() => expect(named('setDouyuActivityOptions')).toHaveLength(2))
    expect(named('setDouyuActivityOptions')[1]!.args).toEqual({ version: 1, fishing: { mode: 'all' }, treasure: { crossRoom: true, claimDelayMs: 8000 } })
    expect(named('createDouyuTask')).toHaveLength(0)
  })
})

const task = (patch: Partial<DouyuTaskView>): DouyuTaskView => ({
  id: 't1', accountId: 'a1', room: '9999', kind: 'room-sign', policy: 'foreground', repeatMinutes: null, createdAt: 1,
  status: 'paused', reason: null, lastRunAt: null, nextRunAt: null, lastResult: null, ...patch,
})

describe('task rows', () => {
  it('shows confirmed sends and the deadline of a message loop', async () => {
    const deadline = new Date(2026, 9, 26, 21, 30).getTime()
    rows = [task({ kind: 'message-loop', status: 'running', completedRuns: 2, deadlineAt: deadline,
      message: { text: '甲', colors: [0], intervalSeconds: 60, initialDelaySeconds: 0, maxRuns: 5, maxDurationSeconds: 1800,
        selection: { mode: 'sequential', texts: ['甲', '乙'], template: 'cheer' } } })]
    render(<Harness />)
    const row = within(await screen.findByRole('group', { name: '发送任务 9999 (主号)' }))
    expect(row.getByText(/已发送 2 \/ 5/)).toHaveTextContent('截止 10/26 21:30')
    expect(row.getByText(/限时 30 分钟/)).toBeInTheDocument()
    expect(row.getByText(/等 2 条，顺序/)).toBeInTheDocument()
  })

  it('names the real official room of a waiting treasure box and opens it by task id', async () => {
    rows = [task({ kind: 'treasure-box', status: 'waiting-user', officialRoom: '777', reason: '需要官方验证' })]
    render(<Harness />)
    const row = within(await screen.findByRole('group', { name: '开宝箱任务 9999 (主号)' }))
    expect(row.getByText('需在官方页面处理：房间 777')).toBeInTheDocument()
    fireEvent.click(row.getByRole('button', { name: '打开官方页面' }))
    await waitFor(() => expect(named('openDouyuTaskRoom')).toEqual([{ method: 'openDouyuTaskRoom', args: { id: 't1' } }]))
    expect(screen.getByRole('region', { name: '活动设置' })).toBeInTheDocument()
  })
})
