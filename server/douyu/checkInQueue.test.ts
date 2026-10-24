import { afterEach, describe, expect, it, vi } from 'vitest'
import { DouyuTaskManager } from '../../electron/douyuTasks'
import { resolveConfig } from '../config'
import { DouyuActions } from './actions'

// These producers exercise the real adapters and scheduler with synthetic data only.
const cookie = 'acf_uid=42; acf_biz=1; acf_stk=synthetic-session; acf_ct=1800000000; acf_ltkid=7; acf_yb_t=synthetic-yuba'
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }
const managers: DouyuTaskManager[] = []
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); vi.useRealTimers() })

describe.each(['room-sign', 'yuba-sign'] as const)('%s serial write ownership', kind => {
  it.each(['pause', 'timeout'] as const)('does not start another write after %s until the first transport settles', async cancellation => {
    vi.useFakeTimers()
    const pending: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = []
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST') return new Promise<Response>(resolve => {
        pending.push({ signal: init.signal!, resolve })
      })
      return Response.json(new URL(String(url)).pathname.includes('getBindGroup')
        ? { error: 0, data: { group_id: 99, group_status: 0 } }
        : { status_code: 200, data: { group_id: 99, is_signed: 0, group_exp: 1, is_follow: 1 } })
    })
    const actions = new DouyuActions({ proxy: { ...resolveConfig({}).proxy, requestTimeoutMs: 1_000 },
      cookieHeader: async () => cookie, resolve: async () => ['8.8.8.8'], request })
    let sequence = 0
    const manager = new DouyuTaskManager({ load: () => undefined, save: () => {},
      run: (task, signal) => actions.run(task, signal),
      id: () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}` })
    managers.push(manager)
    manager.setActiveAccount('default')
    manager.setRoom('100')
    manager.retainRoom('200', true)
    manager.setRuntime({ foreground: true, locked: false, suspended: false })
    for (const room of ['100', '200']) manager.create({ accountId: 'default', room, kind, policy: 'foreground', repeatMinutes: null })
    const [first, second] = manager.snapshot().tasks
    manager.start(first!.id)
    manager.start(second!.id)
    await vi.advanceTimersByTimeAsync(1)
    expect(pending).toHaveLength(1)
    if (cancellation === 'pause') manager.pause(first!.id)
    else await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(pending[0]!.signal.aborted).toBe(true)
    expect(pending).toHaveLength(1)
    expect(manager.snapshot().tasks[1]!.status).toBe('queued')

    pending[0]!.resolve(Response.json({ error: 0 }))
    await vi.advanceTimersByTimeAsync(1)
    expect(pending).toHaveLength(2)
    expect(manager.snapshot().tasks[1]!.status).toBe('running')
    expect(manager.snapshot().tasks[0]!.status).toBe(cancellation === 'pause' ? 'paused' : 'waiting-user')
    manager.dispose()
    pending[1]!.resolve(Response.json({ error: 0 }))
    await vi.advanceTimersByTimeAsync(1)
  })
})
