import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationManager, type CreateAutomation } from './automationManager'
import { DouyuTaskManager } from './douyuTasks'
import type { DouyuAutomationOutcome } from '../server/douyu/automationTypes'

const INPUT: CreateAutomation = { accountId: 'default', kind: 'followed-room-sign', target: { type: 'batch', source: 'followed-rooms' }, options: {}, policy: 'foreground', repeatMinutes: null }
const cleanup: (() => void)[] = []
function fixture() {
  let storage: unknown
  const queue = new DouyuTaskManager({ load: () => undefined, save() {}, run: async () => ({ status: 'succeeded', message: 'fixture' }) })
  queue.setActiveAccount('default'); queue.setRuntime({ foreground: true, locked: false, suspended: false })
  const run = vi.fn(async (_request: unknown, _signal: AbortSignal): Promise<DouyuAutomationOutcome> => ({ status: 'succeeded', message: 'fixture' }))
  const manager = new AutomationManager({ queue, load: () => storage, save: data => { storage = structuredClone(data) }, run })
  cleanup.push(() => { manager.dispose(); queue.dispose() })
  return { queue, manager, run, storage: () => storage }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.useRealTimers() })
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve() }
describe('account and batch task lifecycle', () => {
  it('runs account-wide batches with no fake room and keeps persisted definitions paused', async () => {
    const f = fixture()
    const id = f.manager.create(INPUT).tasks[0]!.id
    f.manager.start(id); await flush()
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(f.run.mock.calls[0]![0]).toMatchObject({ target: { type: 'batch', source: 'followed-rooms' } })
    expect(f.manager.snapshot().tasks[0]!.status).toBe('succeeded')
    const restored = new AutomationManager({ queue: f.queue, load: f.storage, save() {}, run: f.run })
    expect(restored.snapshot().tasks[0]!.status).toBe('paused')
    restored.dispose()
  })
  it('shares the original write lane and keeps it occupied when cancellation races an issued request', async () => {
    const f = fixture()
    let settle!: (value: DouyuAutomationOutcome) => void
    f.run.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    const id = f.manager.create(INPUT).tasks[0]!.id
    f.manager.start(id); await flush()
    f.manager.pause(id)
    const second = f.manager.create({ ...INPUT, kind: 'client-sign', target: { type: 'account' } }).tasks[1]!.id
    f.manager.start(second); await flush()
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(f.run.mock.calls[0]![1].aborted).toBe(true)
    settle({ status: 'succeeded', message: 'late' }); await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.run).toHaveBeenCalledTimes(2)
    expect(f.manager.snapshot().tasks[0]!.status).toBe('paused')
  })
  it('respects lock policy and drops late work after account switch', async () => {
    const f = fixture()
    f.queue.setRuntime({ foreground: false, locked: true, suspended: false })
    const first = f.manager.create(INPUT).tasks[0]!.id
    f.manager.start(first); await flush()
    expect(f.run).not.toHaveBeenCalled()
    const second = f.manager.create({ ...INPUT, policy: 'background-locked' }).tasks[1]!.id
    f.manager.start(second); await flush()
    expect(f.run).toHaveBeenCalledTimes(1)
    f.queue.setActiveAccount(null)
    expect(f.manager.snapshot().tasks[0]!.status).toBe('paused')
  })
})
