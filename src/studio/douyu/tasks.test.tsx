/**
 * Room tasks: the message loop sends several texts with an explicit selection, never an
 * unlimited run by default; activity settings always go out as the whole object; rows show
 * confirmed sends, the deadline and the real official room to handle.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { ApiResult } from '../../app/apiClient'
import { readMessageSchedule } from '../../../server/douyu/taskConfig'
import type { DouyuMessageSchedule, DouyuTasksSnapshot, DouyuTaskView } from '../../../server/douyu/types'
import { Tasks } from './Tasks'
import { useDouyu } from './useDouyu'

type Call = { method: string; args: unknown }
let calls: Call[] = []
let rows: DouyuTaskView[] = []
let removeTask: () => Promise<unknown>
let startTask: (id: string) => Promise<ApiResult<DouyuTasksSnapshot>>
let openTaskRoom: () => Promise<unknown>
let preferences = { version: 1, fishing: { mode: 'all' }, treasure: { crossRoom: false, claimDelayMs: 5000 } }

const accounts = { activeAccountId: 'a1', accounts: [
  { id: 'a1', label: '主号', active: true, busy: false, login: { loggedIn: true } },
  { id: 'a2', label: '小号', active: false, busy: false, login: { loggedIn: true } },
] }
const snapshot = () => ({ activeAccountId: 'a1', currentRoom: '9999', retainedRooms: [], runtime: { foreground: true, locked: false, suspended: false }, tasks: rows })

beforeEach(() => {
  calls = []
  rows = []
  removeTask = async () => { rows = []; return { ok: true, value: snapshot() } }
  startTask = async (id) => {
    rows = rows.map((row) => row.id === id ? { ...row, status: 'queued', reason: null } : row)
    return { ok: true, value: snapshot() }
  }
  openTaskRoom = async () => ({ ok: true, value: accounts })
  preferences = { version: 1, fishing: { mode: 'all' }, treasure: { crossRoom: false, claimDelayMs: 5000 } }
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      if (method === 'listDouyuAccounts') return { ok: true, value: accounts }
      if (method === 'getDouyuTasks') return { ok: true, value: snapshot() }
      if (method === 'createDouyuTask') {
        const input = args as { accountId: string; roomInput: string; kind: DouyuTaskView['kind'] }
        rows = [...rows, task({ id: 'new-task', accountId: input.accountId, room: input.roomInput, kind: input.kind, reason: '尚未启动' })]
        return { ok: true, value: snapshot() }
      }
      if (method === 'startDouyuTask') return startTask((args as { id: string }).id)
      if (method === 'removeDouyuTask') return removeTask()
      if (method === 'getDouyuActivityOptions') return { ok: true, value: preferences }
      if (method === 'setDouyuActivityOptions') { preferences = structuredClone(args) as typeof preferences; return { ok: true, value: preferences } }
      if (method === 'openDouyuTaskRoom') return openTaskRoom()
      return { ok: false, code: 'unexpected', message: 'unexpected' }
    }) as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
    subscribeDouyuTasks: () => () => {},
    subscribeFeatures: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

function Harness({ writesEnabled = () => true }: { writesEnabled?: () => boolean }): React.ReactNode {
  const data = useDouyu(writesEnabled)
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
    fireEvent.change(screen.getByLabelText('发送间隔（秒）'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('启动延迟（秒）'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('发送次数'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('switch', { name: /限制总时长/ }))
    fireEvent.change(screen.getByLabelText('总时长（秒）'), { target: { value: '600' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '发送颜色 红' }))
    fireEvent.click(screen.getByRole('button', { name: '仅添加' }))

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
    fireEvent.click(screen.getByRole('button', { name: '添加并启动' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写发送次数')
    expect(named('createDouyuTask')).toHaveLength(0)

    fireEvent.click(screen.getByRole('switch', { name: '持续发送，直至暂停' }))
    expect(screen.getByLabelText('发送次数')).toBeDisabled()
    expect(screen.getByText('任务将持续发送，请及时暂停')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '仅添加' }))
    await waitFor(() => expect(named('createDouyuTask')).toHaveLength(1))
    const message = (named('createDouyuTask')[0]!.args as { message: DouyuMessageSchedule }).message
    expect(message.maxRuns).toBeNull()
    expect(message).not.toHaveProperty('maxDurationSeconds')
    expect(message.selection).toEqual({ mode: 'sequential', texts: ['提醒'], template: 'cheer' })
  })

  it('uses only the local templates for automatic texts and previews them', async () => {
    render(<Harness />)
    await openForm('定时弹幕')
    fireEvent.click(screen.getByRole('radio', { name: '预设文案' }))
    expect(screen.queryByLabelText('发送内容')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: '感谢' }))
    const preview = within(screen.getByRole('list', { name: '模板预览' }))
    expect(preview.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['感谢主播的精彩直播!', '辛苦了, 主播!'])
    fireEvent.change(screen.getByLabelText('发送次数'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '仅添加' }))
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
    preferences.treasure.claimDelayMs = 500
    render(<Harness />)
    await openForm('开宝箱')
    const delay = await screen.findByLabelText('宝箱领取延迟（秒）')
    expect(delay).toHaveValue('0.5')
    fireEvent.click(await screen.findByRole('switch', { name: /跨房间领取宝箱/ }))
    await waitFor(() => expect(named('setDouyuActivityOptions')).toHaveLength(1))
    expect(named('setDouyuActivityOptions')[0]!.args).toEqual({ version: 1, fishing: { mode: 'all' }, treasure: { crossRoom: true, claimDelayMs: 500 } })

    await waitFor(() => expect(delay).toBeEnabled())
    const save = screen.getByRole('button', { name: '保存延迟' })
    for (const invalid of ['60.001', '0.0001', 'abc']) {
      fireEvent.change(delay, { target: { value: invalid } })
      expect(delay).toBeInvalid()
      expect(screen.getByText('请输入 0 至 60 秒，最多 3 位小数。')).toBeInTheDocument()
      expect(save).toBeDisabled()
      fireEvent.keyDown(delay, { key: 'Enter' })
    }
    expect(named('setDouyuActivityOptions')).toHaveLength(1)
    fireEvent.change(delay, { target: { value: '8.290' } })
    fireEvent.click(save)
    await waitFor(() => expect(named('setDouyuActivityOptions')).toHaveLength(2))
    expect(named('setDouyuActivityOptions')[1]!.args).toEqual({ version: 1, fishing: { mode: 'all' }, treasure: { crossRoom: true, claimDelayMs: 8290 } })
    await waitFor(() => expect(delay).toHaveValue('8.29'))
    expect(named('createDouyuTask')).toHaveLength(0)
  })
})

const task = (patch: Partial<DouyuTaskView>): DouyuTaskView => ({
  id: 't1', accountId: 'a1', room: '9999', kind: 'room-sign', policy: 'foreground', repeatMinutes: null, createdAt: 1,
  status: 'paused', reason: null, lastRunAt: null, nextRunAt: null, lastResult: null, ...patch,
})

describe('adding room tasks', () => {
  it('starts only the newly added task and shows start progress and success inside that row', async () => {
    rows = [task({ room: '8888' })]
    let resolveStart!: (result: ApiResult<DouyuTasksSnapshot>) => void
    const pending = new Promise<ApiResult<DouyuTasksSnapshot>>((resolve) => { resolveStart = resolve })
    const succeed = startTask
    startTask = () => pending
    render(<Harness />)
    const other = within(await screen.findByRole('group', { name: '签到任务 8888 （主号）' }))
    await openForm('直播间签到')
    vi.useFakeTimers()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '添加并启动' })))
    const row = within(screen.getByRole('group', { name: '签到任务 9999 （主号）' }))
    expect(row.getByRole('status')).toHaveTextContent('正在启动')
    expect(screen.getAllByText('正在启动')).toEqual([row.getByRole('status')])
    expect(other.queryByRole('status')).toBeNull()
    expect(other.getByRole('button', { name: '启动' })).toBeDisabled()
    expect(named('startDouyuTask')).toEqual([{ method: 'startDouyuTask', args: { id: 'new-task' } }])
    await act(async () => resolveStart(await succeed('new-task')))
    expect(row.getByRole('button', { name: '暂停' })).toBeEnabled()
    expect(other.getByRole('button', { name: '启动' })).toBeEnabled()
    expect(screen.getAllByText('已启动')).toEqual([row.getByRole('status')])
    act(() => vi.advanceTimersByTime(3000))
    expect(row.queryByRole('status')).toBeNull()
  })

  it('keeps the added task paused and exposes a failed start until it is retried', async () => {
    const succeed = startTask
    startTask = vi.fn(succeed).mockResolvedValueOnce({ ok: false, code: 'login-required', message: '请先登录当前斗鱼账号' })
    render(<Harness />)
    await openForm('直播间签到')
    vi.useFakeTimers()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '添加并启动' })))
    const row = within(screen.getByRole('group', { name: '签到任务 9999 （主号）' }))
    expect(row.getByText('暂停')).toBeInTheDocument()
    expect(screen.getAllByRole('alert')).toEqual([row.getByRole('alert')])
    expect(row.getByRole('alert')).toHaveTextContent('已添加，但未能启动：请先登录当前斗鱼账号')
    act(() => vi.advanceTimersByTime(10_000))
    expect(row.getByRole('alert')).toBeInTheDocument()
    await act(async () => fireEvent.click(row.getByRole('button', { name: '启动' })))
    expect(row.queryByRole('alert')).toBeNull()
    expect(row.getByRole('status')).toHaveTextContent('已启动')
    expect(named('createDouyuTask')).toHaveLength(1)
  })

  it('does not dispatch start when writes become disabled while adding', async () => {
    let enabled = true
    render(<Harness writesEnabled={() => enabled} />)
    await openForm('直播间签到')
    fireEvent.click(screen.getByRole('button', { name: '添加并启动' }))
    enabled = false
    expect(await screen.findByRole('alert')).toHaveTextContent('已添加，但未能启动：请先开启斗鱼写操作')
    expect(named('startDouyuTask')).toHaveLength(0)
  })

  it('adds a task for another account without dispatching start', async () => {
    render(<Harness />)
    await openForm('直播间签到')
    fireEvent.change(screen.getByLabelText('任务账号'), { target: { value: 'a2' } })
    fireEvent.click(screen.getByRole('button', { name: '添加并启动' }))
    const row = within(await screen.findByRole('group', { name: '签到任务 9999 （小号）' }))
    expect(await row.findByRole('alert')).toHaveTextContent('已添加，但未能启动：请先在账号中将 小号 设为当前账号')
    expect(row.getByRole('button', { name: '启动' })).toBeDisabled()
    expect(named('startDouyuTask')).toHaveLength(0)
  })

  it('only adds a paused task and uses the room Yuba name in the form and row', async () => {
    render(<Harness />)
    await openForm('本房间鱼吧签到')
    fireEvent.click(screen.getByRole('button', { name: '仅添加' }))
    const row = within(await screen.findByRole('group', { name: '本房间鱼吧签到任务 9999 （主号）' }))
    expect(row.getByText('本房间鱼吧签到')).toBeInTheDocument()
    expect(row.getByText('暂停')).toBeInTheDocument()
    expect(row.queryByText('尚未启动')).toBeNull()
    expect(row.queryByRole('status')).toBeNull()
    expect(await screen.findByRole('status')).toHaveTextContent('已添加')
    expect(named('startDouyuTask')).toHaveLength(0)
  })
})

describe('task rows', () => {
  it('only removes after confirmation and resets after a failed request', async () => {
    rows = [task({})]
    let fail!: () => void
    const succeed = removeTask
    removeTask = vi.fn(succeed).mockImplementationOnce(() => new Promise(resolve => {
      fail = () => resolve({ ok: false, code: 'remove-failed', message: '任务删除失败' })
    }))
    render(<Harness />)
    const row = within(await screen.findByRole('group', { name: '签到任务 9999 （主号）' }))
    const open = () => fireEvent.click(row.getByRole('button', { name: '删除' }))
    const cancel = () => row.getByRole('button', { name: '取消' })
    const confirm = () => row.getByRole('button', { name: '确认删除' })

    open()
    expect(named('removeDouyuTask')).toHaveLength(0)
    expect(cancel()).toHaveFocus()
    fireEvent.click(cancel())
    expect(row.getByRole('button', { name: '删除' })).toHaveFocus()
    open()
    expect(fireEvent.keyDown(cancel(), { key: 'Escape' })).toBe(false)
    expect(row.queryByRole('button', { name: '确认删除' })).toBeNull()
    expect(named('removeDouyuTask')).toHaveLength(0)

    open()
    fireEvent.click(confirm())
    expect(row.getByRole('status')).toHaveTextContent('正在删除')
    expect(confirm()).toBeDisabled()
    expect(cancel()).toBeDisabled()
    expect(named('removeDouyuTask')).toEqual([{ method: 'removeDouyuTask', args: { id: 't1' } }])
    await act(async () => fail())
    expect(row.getByRole('alert')).toHaveTextContent('任务删除失败')
    expect(row.queryByRole('button', { name: '确认删除' })).toBeNull()

    open()
    expect(named('removeDouyuTask')).toHaveLength(1)
    fireEvent.click(confirm())
    expect(await row.findByText('已删除')).toHaveAttribute('role', 'status')
    expect(row.queryByRole('button')).toBeNull()
    expect(named('removeDouyuTask')).toHaveLength(2)
  })

  it('shows confirmed sends and the deadline of a message loop', async () => {
    const deadline = new Date(2026, 9, 26, 21, 30).getTime()
    rows = [task({ kind: 'message-loop', status: 'running', completedRuns: 2, deadlineAt: deadline,
      message: { text: '甲', colors: [0], intervalSeconds: 60, initialDelaySeconds: 0, maxRuns: 5, maxDurationSeconds: 1800,
        selection: { mode: 'sequential', texts: ['甲', '乙'], template: 'cheer' } } })]
    render(<Harness />)
    const row = within(await screen.findByRole('group', { name: '发送任务 9999 （主号）' }))
    expect(row.getByText(/已发送 2 \/ 5/)).toHaveTextContent('截止 10/26 21:30')
    expect(row.getByText(/限时 30 分钟/)).toBeInTheDocument()
    expect(row.getByText(/等 2 条，顺序/)).toBeInTheDocument()
  })

  it('shows progress, errors and completion of the official window in the waiting task row', async () => {
    rows = [task({ kind: 'treasure-box', status: 'waiting-user', officialRoom: '777', reason: '需要官方验证' }), task({ id: 't2' })]
    let resolveWindow!: (result: unknown) => void
    const pending = new Promise((resolve) => { resolveWindow = resolve })
    openTaskRoom = vi.fn(openTaskRoom).mockReturnValueOnce(pending)
    render(<Harness />)
    const row = within(await screen.findByRole('group', { name: '开宝箱任务 9999 （主号）' }))
    expect(row.getByText('需在官方页面处理：房间 777')).toBeInTheDocument()
    fireEvent.click(row.getByRole('button', { name: '打开官方页面' }))
    const other = within(screen.getByRole('group', { name: '签到任务 9999 （主号）' }))
    expect(other.getByRole('button', { name: '启动' })).toBeDisabled()
    expect(screen.getAllByRole('status')).toEqual([row.getByRole('status')])
    expect(row.getByRole('status')).toHaveTextContent('请在打开的官方窗口中处理')
    expect(named('openDouyuTaskRoom')).toEqual([{ method: 'openDouyuTaskRoom', args: { id: 't1' } }])
    await act(async () => resolveWindow({ ok: false, code: 'window-failed', message: '无法打开官方窗口' }))
    expect(screen.getAllByRole('alert')).toEqual([row.getByRole('alert')])
    expect(row.getByRole('alert')).toHaveTextContent('无法打开官方窗口')
    fireEvent.click(row.getByRole('button', { name: '关闭提示' }))
    expect(row.queryByRole('alert')).toBeNull()
    fireEvent.click(row.getByRole('button', { name: '打开官方页面' }))
    await waitFor(() => expect(row.getByRole('status')).toHaveTextContent('官方窗口已关闭，请核对结果后手动启动'))
    expect(screen.getByRole('region', { name: '活动设置' })).toBeInTheDocument()
  })
})
