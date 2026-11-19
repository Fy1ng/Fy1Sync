import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { DouyuAccountsSnapshot, DouyuTasksSnapshot } from '../../../server/douyu/types'
import { LaneLine } from './DouyuDesk'
import { useDouyu } from './useDouyu'
import { useGiftPlan } from './giftPlan'
import { GiftPlanView } from './GiftPlanView'
import { displayError } from '../../core/errorDetails'

const accounts: DouyuAccountsSnapshot = { revision: 0, activeAccountId: null, accounts: [] }
const tasks: DouyuTasksSnapshot = {
  activeAccountId: null, currentRoom: null, retainedRooms: [], tasks: [],
  runtime: { foreground: true, locked: false, suspended: false },
}

beforeEach(() => {
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => method === 'listDouyuAccounts'
      ? { ok: true, value: accounts } : method === 'getDouyuTasks'
        ? { ok: true, value: tasks } : { ok: false, code: 'PREVIEW_503', message: '处理失败', detail: { status: 503, traceId: 'gift-preview', token: 'private-session' } }) as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
    subscribeDouyuAccounts: () => () => {},
    subscribeDouyuTasks: () => () => {},
    subscribeFeatures: () => () => {},
  } satisfies StreamSyncerBridge)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness(): React.ReactNode {
  const data = useDouyu()
  return <>
    <button onClick={() => void data.accountAction('读取中', async () => ({ ok: false, code: 'ACCOUNT_401', message: '处理失败', detail: { status: 401, traceId: 'account-read', cookie: 'secret-cookie' } }), '完成')}>账号失败</button>
    <button onClick={() => void data.taskAction('读取中', async () => ({ ok: false, code: 'TASK_502', message: '处理失败', detail: { status: 502, traceId: 'task-read' } }), '完成')}>任务失败</button>
    <button onClick={() => void data.accountAction('读取中', async () => ({ ok: true, value: accounts }), '账号已读取')}>账号成功</button>
    <button onClick={() => void data.accountAction('读取中', async () => { throw Object.assign(new TypeError('local exception'), { code: 'LOCAL_READ' }) }, '完成')}>本地异常</button>
    <section aria-label="账号反馈"><LaneLine lane={data.accountLane} /></section>
    <section aria-label="任务反馈"><LaneLine lane={data.taskLane} /></section>
  </>
}

function fields(region: HTMLElement): Record<string, unknown> {
  return JSON.parse(region.querySelector('code')!.textContent!) as Record<string, unknown>
}

describe('operation-owned error fields', () => {
  it('keeps different failures with the same summary in their own lanes and leaves successes plain', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '账号失败' }))
    fireEvent.click(screen.getByRole('button', { name: '任务失败' }))
    const account = screen.getByRole('region', { name: '账号反馈' })
    const task = screen.getByRole('region', { name: '任务反馈' })
    fireEvent.click(await within(account).findByRole('button', { name: '查看原始错误' }))
    fireEvent.click(await within(task).findByRole('button', { name: '查看原始错误' }))
    expect(fields(within(account).getByRole('region', { name: '原始错误信息' }))).toEqual({
      ok: false, code: 'ACCOUNT_401', message: '处理失败', detail: { status: 401, traceId: 'account-read', cookie: '[redacted]' },
    })
    expect(fields(within(task).getByRole('region', { name: '原始错误信息' }))).toMatchObject({ code: 'TASK_502', detail: { traceId: 'task-read' } })
    fireEvent.click(screen.getByRole('button', { name: '账号成功' }))
    await waitFor(() => expect(account).toHaveTextContent('账号已读取'))
    expect(within(account).queryByRole('button')).toBeNull()
    expect(within(task).getByRole('button', { name: '收起原始错误' })).toBeInTheDocument()
  })

  it('retains the actual caught exception behind the Chinese summary', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '本地异常' }))
    const account = screen.getByRole('region', { name: '账号反馈' })
    fireEvent.click(await within(account).findByRole('button', { name: '查看原始错误' }))
    expect(account).toHaveTextContent('操作未完成，请重试')
    expect(fields(within(account).getByRole('region', { name: '原始错误信息' }))).toMatchObject({ name: 'TypeError', message: 'local exception', code: 'LOCAL_READ' })
  })

  it('applies the returned account snapshot when its domain outcome is incomplete', async () => {
    const { result } = renderHook(() => useDouyu())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const snapshot = { ...accounts, revision: 100 }
    let complete: boolean | undefined
    await act(async () => {
      complete = await result.current.accountAction('读取中', async () => ({ ok: true, value: snapshot }), () => displayError({ code: 'login-incomplete', loggedIn: false }, '登录未完成'))
    })
    expect(complete).toBe(false)
    expect(result.current.accounts).toEqual(snapshot)
    expect(result.current.accountLane.errorDetail).toEqual({ code: 'login-incomplete', loggedIn: false })
  })

  it('retains every failed gift preview field in the shared gift state', async () => {
    const { result } = renderHook(() => useGiftPlan('a1'))
    await act(async () => {
      await result.current.preview(async () => ({ ok: false, code: 'PREVIEW_503', message: '处理失败', detail: { status: 503, traceId: 'gift-preview', token: 'private-session' } }), (_value): _value is never => false)
    })
    expect(result.current.errorDetail).toEqual({ ok: false, code: 'PREVIEW_503', message: '处理失败', detail: { status: 503, traceId: 'gift-preview', token: '[redacted]' } })
    render(<GiftPlanView gift={result.current} accountLabel="主号" currentRoom="100" ready inventory={null} />)
    fireEvent.click(screen.getByRole('button', { name: '查看原始错误' }))
    expect(fields(screen.getByRole('region', { name: '原始错误信息' }))).toMatchObject({ code: 'PREVIEW_503', detail: { traceId: 'gift-preview' } })
  })
})
