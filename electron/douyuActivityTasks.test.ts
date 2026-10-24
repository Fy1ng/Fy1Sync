import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DouyuTaskManager } from './douyuTasks'
import { DOUYU_ACTIVITY_KINDS } from '../server/douyu/types'
import type { CreateDouyuTask, DouyuTaskDefinition, DouyuTaskOutcome, DouyuTaskStorage } from '../server/douyu/types'

const input: CreateDouyuTask = { accountId: 'default', room: '9999', kind: 'auto-fish', policy: 'foreground', repeatMinutes: null }
const managers: DouyuTaskManager[] = []
const clock = 1_800_000_000_000
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function fixture(initial?: DouyuTaskStorage) {
  let saved: DouyuTaskStorage | undefined = initial
  let index = 0
  const attempts: Array<{ task: DouyuTaskDefinition; signal: AbortSignal; resolve: (result: DouyuTaskOutcome) => void }> = []
  const run = vi.fn((task: DouyuTaskDefinition, signal: AbortSignal) => new Promise<DouyuTaskOutcome>(resolve => {
    attempts.push({ task, signal, resolve })
  }))
  const manager = new DouyuTaskManager({ load: () => saved, save: data => { saved = structuredClone(data) }, run,
    id: () => `00000000-0000-4000-8000-${String(++index).padStart(12, '0')}` })
  managers.push(manager)
  manager.setActiveAccount('default')
  manager.setRoom('9999')
  manager.setRuntime({ foreground: true, locked: false, suspended: false })
  return { manager, attempts, run, saved: () => saved! }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(clock) })
afterEach(() => { managers.splice(0).forEach(manager => manager.dispose()); vi.useRealTimers() })

it.each(DOUYU_ACTIVITY_KINDS)('persists %s paused and refuses generic recurring or message fields', async kind => {
  const f = fixture()
  const view = f.manager.create({ ...input, kind }).tasks[0]!
  expect(view).toMatchObject({ kind, status: 'paused', nextRunAt: null })
  expect(() => f.manager.create({ ...input, room: '100', kind, repeatMinutes: 1440 })).toThrow()
  expect(() => f.manager.create({ ...input, room: '100', kind, message: { text: 'x', colors: [0], intervalSeconds: 1, initialDelaySeconds: 0, maxRuns: 1 } })).toThrow()
  f.manager.start(view.id)
  await flush()
  f.attempts[0]!.resolve({ status: 'scheduled', message: '等待官方活动时间', nextRunAt: Date.now() + 60_000 })
  await flush()
  expect(f.manager.snapshot().tasks[0]).toMatchObject({ status: 'queued', nextRunAt: clock + 60_000 })
  const restored = fixture(f.saved())
  expect(restored.manager.snapshot().tasks[0]).toMatchObject({ kind, status: 'paused', nextRunAt: null, lastRunAt: null })
  expect(restored.run).not.toHaveBeenCalled()
})

it('releases the write lane while waiting and does not let repeated starts bypass the deadline', async () => {
  const f = fixture()
  const fish = f.manager.create(input).tasks[0]!.id
  const chest = f.manager.create({ ...input, kind: 'treasure-box' }).tasks[1]!.id
  f.manager.start(fish)
  f.manager.start(chest)
  await flush()
  expect(f.run).toHaveBeenCalledTimes(1)
  f.attempts[0]!.resolve({ status: 'scheduled', message: '钓鱼等待中', nextRunAt: clock + 60_000 })
  await flush()
  expect(f.attempts[1]!.task.id).toBe(chest)
  f.attempts[1]!.resolve({ status: 'waiting-user', message: '请手动完成官方验证' })
  await flush()
  f.manager.start(fish)
  await vi.advanceTimersByTimeAsync(59_999)
  expect(f.run).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.attempts[2]!.task.id).toBe(fish)
  expect(f.manager.snapshot().tasks[1]!.status).toBe('waiting-user')
})

it('enforces a minimum delay and waits for foreground without losing the official deadline', async () => {
  const f = fixture()
  const id = f.manager.create(input).tasks[0]!.id
  f.manager.start(id)
  await flush()
  f.attempts[0]!.resolve({ status: 'scheduled', message: '等待', nextRunAt: clock + 1 })
  await flush()
  expect(f.manager.snapshot().tasks[0]!.nextRunAt).toBe(clock + 5_000)
  f.manager.setRuntime({ foreground: false, locked: false, suspended: false })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.run).toHaveBeenCalledTimes(1)
  f.manager.setRuntime({ foreground: true, locked: false, suspended: false })
  await flush()
  expect(f.run).toHaveBeenCalledTimes(2)
})

it.each([
  { status: 'scheduled', message: 'invalid', nextRunAt: clock },
  { status: 'scheduled', message: 'invalid', nextRunAt: clock + 86_400_001 },
  { status: 'scheduled', message: 'invalid', nextRunAt: NaN },
  { status: 'scheduled', message: 'invalid', nextRunAt: '1800000005000' },
  { status: 'scheduled', message: 'invalid', nextRunAt: clock + 5000, extra: true },
  { status: 'scheduled', message: 'bad\nmessage', nextRunAt: clock + 5000 },
])('stops invalid scheduler outcomes without scheduling a retry (%j)', async result => {
  const f = fixture()
  f.manager.start(f.manager.create(input).tasks[0]!.id)
  await flush()
  f.attempts[0]!.resolve(result as DouyuTaskOutcome)
  await flush()
  expect(f.manager.snapshot().tasks[0]).toMatchObject({ status: 'failed', nextRunAt: null })
  await vi.advanceTimersByTimeAsync(90_000)
  expect(f.run).toHaveBeenCalledTimes(1)
})

it('does not allow a sign-in adapter to arm activity polling', async () => {
  const f = fixture()
  f.manager.start(f.manager.create({ ...input, kind: 'room-sign' }).tasks[0]!.id)
  await flush()
  f.attempts[0]!.resolve({ status: 'scheduled', message: 'unexpected', nextRunAt: clock + 5000 })
  await flush()
  expect(f.manager.snapshot().tasks[0]).toMatchObject({ status: 'failed', nextRunAt: null })
})

it.each(['pause', 'switch-account', 'close-room', 'lock', 'dispose'] as const)('cancels an activity and ignores late scheduling after %s', async change => {
  const f = fixture()
  const id = f.manager.create(input).tasks[0]!.id
  f.manager.start(id)
  await flush()
  if (change === 'pause') f.manager.pause(id)
  else if (change === 'switch-account') f.manager.setActiveAccount('11111111-1111-4111-8111-111111111111')
  else if (change === 'close-room') f.manager.setRoom('100')
  else if (change === 'lock') f.manager.setRuntime({ foreground: false, locked: true, suspended: false })
  else f.manager.dispose()
  expect(f.attempts[0]!.signal.aborted).toBe(true)
  f.attempts[0]!.resolve({ status: 'scheduled', message: 'late', nextRunAt: clock + 5000 })
  await vi.advanceTimersByTimeAsync(90_000)
  expect(f.run).toHaveBeenCalledTimes(1)
  expect(f.manager.snapshot().tasks[0]?.nextRunAt).not.toBe(clock + 5000)
})

it('holds the write lane until an aborted activity settles', async () => {
  const f = fixture()
  const id = f.manager.create(input).tasks[0]!.id
  f.manager.start(id)
  await flush()
  f.manager.pause(id)
  f.manager.start(id)
  await flush()
  expect(f.run).toHaveBeenCalledTimes(1)
  f.attempts[0]!.resolve({ status: 'waiting-user', message: '请求结果未知' })
  await flush()
  expect(f.run).toHaveBeenCalledTimes(2)
})
