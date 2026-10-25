import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../danmaku/douyuProtocol'
import { DouyuInsightsService } from './insightsService'
import type { DouyuFollowedRooms, DouyuRoomInfo } from './insightsTypes'

const NOW = 1_793_000_000_000
const services: DouyuInsightsService[] = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { services.splice(0).forEach(service => service.dispose()); vi.useRealTimers() })
function setup() {
  let now = NOW
  const info: DouyuRoomInfo = { room: '100', checkedAt: now, roomName: 'room', nickname: '主播', ownerUid: '9',
    live: false, replay: false, startedAt: null, lastStartedAt: now - 100_000, popularity: 0, viewers: null, source: 'douyu-h5room' }
  const follows = (live: boolean): DouyuFollowedRooms => ({ accountId: 'a', checkedAt: now, coverage: 'all-pages', pageCount: 1, reason: null,
    rooms: [{ room: '100', live, replay: false, roomName: 'room', nickname: '主播', startedAt: null, popularity: null, url: 'https://www.douyu.com/100' }] })
  const gateway = { readRoom: vi.fn(async () => ({ ...info })), readFollowedRooms: vi.fn(async () => follows(false)) }
  const notification = vi.fn()
  const service = new DouyuInsightsService({ gateway, now: () => now, onNotification: notification })
  services.push(service)
  return { service, gateway, notification, follows, info, advance: (ms: number) => { now += ms }, now: () => now }
}
function chat(id: string, uid = '42', extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, room: '100', text: 'test', username: 'viewer', color: 0, level: 1, receivedAt: NOW, system: false, sender: { uid }, ...extra }
}

describe('bounded room observations', () => {
  it('values room catalogs independently using fish-fin units instead of assumed cash', () => {
    const f = setup()
    f.service.setRoomGiftPrices('100', [{ kind: 'gift', id: '1', amountMinor: 150, currency: 'YUCHI', source: 'official-catalog', checkedAt: NOW }])
    f.service.setRoomGiftPrices('101', [{ kind: 'gift', id: '1', amountMinor: 200, currency: 'YUCHI', source: 'official-catalog', checkedAt: NOW }])
    f.service.observe(chat('gift-100', '42', { gift: { kind: 'gift', id: '1', count: 2 } }))
    f.service.observe(chat('gift-101', '42', { room: '101', gift: { kind: 'gift', id: '1', count: 2 } }))
    expect(f.service.snapshot('100').gifts).toMatchObject({ totalValueMinor: 300, currency: 'YUCHI', scale: 100 })
    expect(f.service.snapshot('101').gifts).toMatchObject({ totalValueMinor: 400, currency: 'YUCHI', scale: 100 })
  })
  it('counts unique sender IDs without treating repeated text as a duplicate message', () => {
    const f = setup()
    f.service.observe(chat('one'))
    f.service.observe(chat('two', '43'))
    f.service.observe(chat('one', '44'))
    f.service.observe(chat('three', ''))
    expect(f.service.snapshot('100')).toMatchObject({ uniqueChatters: 2, viewers: null,
      coverage: { completeRoomHistory: false, source: 'received-events', unknownSenderEvents: 1 } })
  })
  it('keeps unknown prices and gift namespaces separate and does not revalue historical unknowns', () => {
    const f = setup()
    f.service.setGiftPrices([{ kind: 'gift', id: '1', amountMinor: 150, currency: 'YUCHI', source: 'official-catalog', checkedAt: NOW }])
    f.service.observe(chat('gift-1', '42', { system: true, gift: { kind: 'gift', id: '1', count: 2 } }))
    f.service.observe(chat('gift-2', '43', { system: true, gift: { kind: 'prop', id: '1', count: 3 } }))
    expect(f.service.snapshot('100')).toMatchObject({ uniqueGiftSenders: 2, gifts: { count: 5, knownValueMinor: 300, unknownValueCount: 3, totalValueMinor: null } })
    f.service.setGiftPrices([{ kind: 'prop', id: '1', amountMinor: 1, currency: 'YUCHI', source: 'official-catalog', checkedAt: NOW }])
    expect(f.service.snapshot('100').gifts.totalValueMinor).toBeNull()
  })
  it('never applies a new catalog retrospectively to old replay messages', () => {
    const f = setup()
    f.service.setGiftPrices([{ kind: 'gift', id: '1', amountMinor: 150, currency: 'YUCHI', source: 'official-catalog', checkedAt: NOW }])
    f.service.observe(chat('old', '42', { receivedAt: NOW - 1, gift: { kind: 'gift', id: '1', count: 1 } }))
    expect(f.service.snapshot('100').gifts).toMatchObject({ knownValueMinor: 0, unknownValueCount: 1 })
  })
  it('preserves disconnection and ingress-loss evidence', () => {
    const f = setup()
    f.service.connection('100', 'connected')
    f.service.connection('100', 'reconnecting')
    f.service.connection('100', 'connected')
    f.service.dropped('100', 5)
    expect(f.service.snapshot('100')).toMatchObject({ connected: true, coverage: { disconnected: true, droppedEvents: 5 } })
  })
  it('does not emit unbounded UI changes per chat packet', async () => {
    const f = setup(), listener = vi.fn()
    f.service.subscribe(listener)
    for (let index = 0; index < 300; index++) f.service.observe(chat(String(index)))
    expect(listener).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('live notifications and read races', () => {
  it('only notifies a known transition into a non-replay live stream', () => {
    const f = setup()
    f.service.setNotifications(true)
    f.service.signal({ kind: 'live', room: '100', receivedAt: NOW, live: true, replay: false })
    expect(f.notification).not.toHaveBeenCalled()
    f.service.signal({ kind: 'live', room: '100', receivedAt: NOW, live: false, replay: false })
    f.service.signal({ kind: 'live', room: '100', receivedAt: NOW, live: true, replay: true })
    expect(f.notification).not.toHaveBeenCalled()
    f.service.signal({ kind: 'live', room: '100', receivedAt: NOW, live: true, replay: false })
    expect(f.notification).toHaveBeenCalledTimes(1)
    f.service.signal({ kind: 'live', room: '100', receivedAt: NOW, live: false, replay: false })
    f.service.signal({ kind: 'live', room: '100', receivedAt: NOW, live: true, replay: false })
    expect(f.notification).toHaveBeenCalledTimes(1)
  })
  it('respects the notification toggle and explicit room selection', () => {
    const f = setup()
    f.service.setNotifications(true, ['200'])
    f.service.signal({ kind: 'live', room: '100', receivedAt: NOW, live: false, replay: false })
    f.service.signal({ kind: 'live', room: '100', receivedAt: NOW, live: true, replay: false })
    expect(f.notification).not.toHaveBeenCalled()
  })
  it('does not overwrite newer socket state with an old room query', async () => {
    const f = setup()
    let resolve!: (value: DouyuRoomInfo) => void
    f.gateway.readRoom.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const result = f.service.refreshRoom('100', new AbortController().signal)
    f.service.signal({ kind: 'live', room: '100', receivedAt: NOW, live: true, replay: false })
    resolve(f.info)
    expect((await result).live).toBe(true)
  })
  it('does not recreate a forgotten room from a late query', async () => {
    const f = setup()
    let resolve!: (value: DouyuRoomInfo) => void
    f.gateway.readRoom.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const result = f.service.refreshRoom('100', new AbortController().signal)
    f.service.forgetRoom('100'); resolve(f.info)
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('monitors complete follow snapshots and stops after account invalidation', async () => {
    const f = setup()
    f.gateway.readFollowedRooms.mockResolvedValueOnce(f.follows(false)).mockResolvedValueOnce(f.follows(true))
    f.service.setNotifications(true); f.service.startFollowMonitor('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.notification).not.toHaveBeenCalled()
    f.advance(60_000); await vi.advanceTimersByTimeAsync(60_000)
    expect(f.notification).toHaveBeenCalledTimes(1)
    f.service.invalidateAccount('a')
    await vi.advanceTimersByTimeAsync(180_000)
    expect(f.gateway.readFollowedRooms).toHaveBeenCalledTimes(2)
  })
  it('does not notify from incomplete follow pages', async () => {
    const f = setup()
    f.gateway.readFollowedRooms.mockResolvedValueOnce(f.follows(false)).mockResolvedValueOnce({ ...f.follows(true), coverage: 'partial' })
    f.service.setNotifications(true); f.service.startFollowMonitor('a')
    await vi.advanceTimersByTimeAsync(0)
    f.advance(60_000); await vi.advanceTimersByTimeAsync(60_000)
    expect(f.notification).not.toHaveBeenCalled()
  })
})

describe('actual playback heartbeat accounting', () => {
  it('counts overlapping windows once and excludes stale, paused and suspended intervals', () => {
    const f = setup()
    f.service.reportPlayback('100', true, 'main')
    f.advance(5000); f.service.reportPlayback('100', true, 'main')
    f.service.reportPlayback('100', true, 'pip')
    f.advance(5000); f.service.reportPlayback('100', true, 'pip')
    expect(f.service.reportPlayback('100', false, 'main').localWatchSeconds).toBe(10)
    f.advance(16_000); expect(f.service.reportPlayback('100', true, 'pip').localWatchSeconds).toBe(10)
    f.advance(4000); expect(f.service.reportPlayback('100', false, 'pip').localWatchSeconds).toBe(14)
    f.advance(4000); expect(f.service.reportPlayback('100', false, 'pip').localWatchSeconds).toBe(14)
  })
  it('keeps official broadcast duration distinct from local watched time', async () => {
    const f = setup()
    f.gateway.readRoom.mockResolvedValue({ ...f.info, live: true, startedAt: NOW - 120_000, lastStartedAt: null })
    const result = await f.service.refreshRoom('100', new AbortController().signal)
    expect(result).toMatchObject({ broadcastSeconds: 120, localWatchSeconds: 0 })
  })
})
