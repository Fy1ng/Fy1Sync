import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { FeatureEvent } from '../../../electron/featureContracts'
import { Accounts } from './Accounts'
import { Automations } from './Automations'
import { Tasks } from './Tasks'
import { useDouyu } from './useDouyu'

const accounts = { revision: 1, activeAccountId: null, accounts: [] }
const tasks = { activeAccountId: null, currentRoom: null, retainedRooms: [], tasks: [], runtime: { foreground: true, locked: false, suspended: false } }
const snapshots: Record<string, unknown> = { listDouyuAccounts: accounts, getDouyuTasks: tasks, getDouyuAutomations: { tasks: [] } }
const cases = [
  { view: 'accounts', method: 'listDouyuAccounts', loading: '正在读取账号', empty: /暂无账号/ },
  { view: 'tasks', method: 'getDouyuTasks', loading: '正在读取房间任务', empty: /暂无任务/ },
  { view: 'automations', method: 'getDouyuAutomations', loading: '正在读取批量任务', empty: /暂无批量任务/ },
] as const

let pendingMethod = ''
let finish: ((value: unknown) => void) | undefined
let reject: ((error: unknown) => void) | undefined
let reads = 0
let pushAccounts: (value: unknown) => void = () => {}
let pushTasks: (value: unknown) => void = () => {}
let pushFeature: (event: FeatureEvent) => void = () => {}

beforeEach(() => {
  reads = 0; finish = undefined; reject = undefined
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn((method: string) => {
      if (method === pendingMethod && reads++ === 0) return new Promise((resolve, fail) => { finish = resolve; reject = fail })
      return Promise.resolve({ ok: true, value: snapshots[method] })
    }) as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
    subscribeDouyuAccounts: listener => { pushAccounts = listener as (value: unknown) => void; return () => {} },
    subscribeDouyuTasks: listener => { pushTasks = listener as (value: unknown) => void; return () => {} },
    subscribeFeatures: listener => { pushFeature = listener; return () => {} },
  } satisfies StreamSyncerBridge)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness({ view }: { view: typeof cases[number]['view'] }): React.ReactNode {
  const data = useDouyu()
  if (view === 'accounts') return <Accounts data={data} />
  if (view === 'tasks') return <Tasks data={data} defaultRoom={null} />
  return <Automations data={data} />
}

describe.each(cases)('$view read state', ({ view, method, loading, empty }) => {
  it.each(['refusal', 'exception', 'invalid'])('separates loading, %s failure and empty results and retries in place', async failure => {
    pendingMethod = method
    render(<Harness view={view} />)
    expect(screen.getByText(loading)).toBeInTheDocument()
    expect(screen.queryByText(empty)).toBeNull()
    await act(async () => {
      if (failure === 'exception') reject!(new Error('synthetic read failure'))
      else finish!(failure === 'invalid' ? { ok: true, value: {} } : { ok: false, code: 'read-failed', message: '读取失败' })
    })
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(loading)).toBeNull()
    expect(screen.queryByText(empty)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看原始错误' }))
    expect(screen.getByRole('region', { name: '原始错误信息' })).toHaveTextContent(failure === 'refusal' ? 'read-failed' : failure === 'invalid' ? '"ok": true' : 'synthetic read failure')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText(empty)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(reads).toBe(2)
  })

  it('keeps a newer pushed snapshot when the pending read fails', async () => {
    pendingMethod = method
    render(<Harness view={view} />)
    await waitFor(() => expect(finish).toBeDefined())
    await act(async () => {
      if (view === 'accounts') pushAccounts(accounts)
      if (view === 'tasks') pushTasks(tasks)
      if (view === 'automations') pushFeature({ topic: 'automations', data: { tasks: [] } })
      finish!({ ok: false, code: 'old-read-failed', message: '旧读取失败' })
    })
    expect(screen.getByText(empty)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

it.each(['tasks', 'automations'] as const)('does not suggest adding an account after the account read fails on %s', async view => {
  pendingMethod = 'listDouyuAccounts'
  render(<Harness view={view} />)
  await act(async () => { finish!({ ok: false, code: 'account-read-failed', message: '无法读取账号' }) })
  expect(await screen.findByRole('alert')).toHaveTextContent('无法读取账号')
  expect(screen.queryByText('请先在「账号」中添加斗鱼账号。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('请先在「账号」中添加斗鱼账号。')).toBeInTheDocument()
})

it('accepts an account read whose main-process revision is newer than the intervening push', async () => {
  pendingMethod = 'listDouyuAccounts'
  const { result } = renderHook(() => useDouyu())
  await act(async () => {
    pushAccounts(accounts)
    finish!({ ok: true, value: { ...accounts, revision: 2 } })
  })
  expect(result.current.accounts?.revision).toBe(2)
  expect(result.current.accountsReadError).toBe('')
})
