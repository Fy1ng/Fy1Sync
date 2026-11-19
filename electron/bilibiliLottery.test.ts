import { afterEach, describe, expect, it, vi } from 'vitest'
import { BilibiliLotteryService, type BilibiliLotteryDeps } from './bilibiliLottery'
import { parseBilibiliLottery } from '../server/platforms/bilibiliLottery'
import { BILIBILI_LOTTERY_FIXTURE_NOW as NOW, bilibiliLotteryFixture } from '../server/platforms/fixtures/bilibiliLottery'

const services: BilibiliLotteryService[] = []
afterEach(() => { services.splice(0).forEach(service => service.dispose()); vi.useRealTimers(); vi.restoreAllMocks() })
function setup(read = vi.fn<BilibiliLotteryDeps['read']>(async () => parseBilibiliLottery(bilibiliLotteryFixture(), '21452505', NOW))) {
  const clock = { now: NOW }, notify = vi.fn(), openExternal = vi.fn(async () => {})
  const service = new BilibiliLotteryService({ read, notify, openExternal, now: () => clock.now })
  services.push(service)
  const context = { senderId: 1 }, args = { slot: 'commentary' as const, watchId: 'watch-1', input: '6', reminders: false }
  const watch = { slot: args.slot, watchId: args.watchId }
  const open = { ...watch, room: '21452505', activityId: '771' }
  return { service, args, watch, open, context, read, notify, openExternal, clock }
}

describe('Bilibili lottery service lifecycle', () => {
  it('defaults reminders off and deduplicates concurrent reads, two slots and restarts', async () => {
    const s = setup()
    expect((await s.service.read(s.args, s.context)).reminder).toBe(false)
    s.service.setReminders({ ...s.watch, enabled: true }, s.context)
    const notices = await Promise.all([s.service.read(s.args, s.context), s.service.read(s.args, s.context)])
    expect(notices.filter(result => result.reminder)).toHaveLength(1)
    expect(s.read).toHaveBeenCalledTimes(1)
    await s.service.read({ ...s.args, slot: 'official', reminders: true }, s.context)
    s.service.stop(s.watch, s.context)
    await s.service.read({ ...s.args, watchId: 'watch-2', reminders: true }, s.context)
    expect(s.notify).toHaveBeenCalledTimes(1)
    await s.service.open({ ...s.open, watchId: 'watch-2' }, s.context)
    expect(s.openExternal).toHaveBeenCalledExactlyOnceWith('https://live.bilibili.com/21452505')
  })
  it('rejects untrusted context, extra parameters, stale activity and wrong room', async () => {
    const s = setup()
    await expect(s.service.read(s.args, {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(s.service.read({ ...s.args, input: 'https://evil.example/6' }, s.context)).rejects.toThrow()
    await expect(s.service.handlers().readBilibiliLottery({ ...s.args, url: 'evil' } as typeof s.args, s.context)).rejects.toThrow()
    await s.service.read(s.args, s.context)
    await expect(s.service.open({ ...s.open, room: '21452506' }, s.context)).rejects.toMatchObject({ code: 'room-changed' })
    await expect(s.service.open({ ...s.open, activityId: '772' }, s.context)).rejects.toThrow()
    await expect(s.service.open(s.open, { senderId: 2 })).rejects.toThrow()
    expect(s.openExternal).not.toHaveBeenCalled()
  })
  it('cancels ignored-signal requests, refuses reused tokens and suppresses late notices after a room switch', async () => {
    let finish!: (value: ReturnType<typeof parseBilibiliLottery>) => void
    const read = vi.fn<BilibiliLotteryDeps['read']>(async () => new Promise(resolve => { finish = resolve }))
    const s = setup(read)
    const old = s.service.read({ ...s.args, reminders: true }, s.context)
    const rejected = expect(old).rejects.toMatchObject({ code: 'cancelled' })
    await Promise.resolve()
    s.service.stop(s.watch, s.context)
    expect(read.mock.calls[0]?.[1]?.aborted).toBe(true)
    finish(parseBilibiliLottery(bilibiliLotteryFixture(), '21452505', NOW))
    await rejected
    await expect(s.service.read(s.args, s.context)).rejects.toThrow()
    expect(s.notify).not.toHaveBeenCalled()
    read.mockResolvedValue(parseBilibiliLottery(bilibiliLotteryFixture({ room_id: 21452506 }), '21452506', NOW))
    expect((await s.service.read({ ...s.args, input: '7', watchId: 'watch-2' }, s.context)).room).toBe('21452506')
    await expect(s.service.read({ ...s.args, input: '8', watchId: 'watch-2' }, s.context)).rejects.toThrow()
  })
  it('honors a reminder toggle during reads, refuses expired entries and allows a new activity notice', async () => {
    let finish!: (value: ReturnType<typeof parseBilibiliLottery>) => void
    const s = setup(vi.fn<BilibiliLotteryDeps['read']>(async () => new Promise(resolve => { finish = resolve })))
    const pending = s.service.read({ ...s.args, reminders: true }, s.context)
    await Promise.resolve()
    s.service.setReminders({ ...s.watch, enabled: false }, s.context)
    finish(parseBilibiliLottery(bilibiliLotteryFixture(), '21452505', NOW))
    expect((await pending).reminder).toBe(false)
    s.clock.now += 6000
    s.read.mockResolvedValue(parseBilibiliLottery(bilibiliLotteryFixture({ id: 772 }), '21452505', s.clock.now))
    s.service.setReminders({ ...s.watch, enabled: true }, s.context)
    expect((await s.service.read(s.args, s.context)).reminder).toBe(true)
    await expect(s.service.open(s.open, s.context)).rejects.toThrow()
    s.clock.now += 66_000
    await expect(s.service.open({ ...s.open, activityId: '772' }, s.context)).rejects.toThrow()
  })
  it.each([{ lot_status: 2 }, { current_timestamp: undefined }, { time: 0 }])('does not notify ended or unclocked metadata %j', async patch => {
    const s = setup(vi.fn(async () => parseBilibiliLottery(bilibiliLotteryFixture(patch), '21452505', NOW)))
    expect((await s.service.read({ ...s.args, reminders: true }, s.context)).reminder).toBe(false)
    expect(s.notify).not.toHaveBeenCalled()
  })
  it('allows the fixed official fallback for login-required or empty activity, bound to the current null ID', async () => {
    const s = setup(vi.fn(async () => parseBilibiliLottery({ code: -101 }, '21452505', NOW)))
    await s.service.read(s.args, s.context)
    await s.service.open({ ...s.open, activityId: null }, s.context)
    expect(s.openExternal).toHaveBeenCalledExactlyOnceWith('https://live.bilibili.com/21452505')
    await expect(s.service.open(s.open, s.context)).rejects.toThrow()
  })
  it('retires leases on owner release, authentication changes and disposal', async () => {
    const s = setup()
    await s.service.read(s.args, s.context)
    s.service.releaseSender(1)
    await expect(s.service.read(s.args, s.context)).rejects.toThrow()
    await s.service.read({ ...s.args, watchId: 'watch-2' }, s.context)
    s.service.invalidate()
    await expect(s.service.open({ ...s.open, watchId: 'watch-2' }, s.context)).rejects.toThrow()
    s.service.dispose()
    await expect(s.service.read(s.args, s.context)).rejects.toMatchObject({ code: 'service-closed' })
  })
  it('bounds a hung provider and requires a new token after lease expiry', async () => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), milliseconds)
      return controller.signal
    })
    const s = setup(vi.fn<BilibiliLotteryDeps['read']>(async () => new Promise(() => {})))
    const pending = s.service.read(s.args, s.context)
    const cancelled = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(10_001)
    await cancelled
    s.clock.now += 66_000
    await expect(s.service.read(s.args, s.context)).rejects.toThrow()
    s.read.mockResolvedValue(parseBilibiliLottery({ code: 0, data: null }, '21452505', s.clock.now))
    expect((await s.service.read({ ...s.args, watchId: 'resumed' }, s.context)).phase).toBe('empty')
  })
})
