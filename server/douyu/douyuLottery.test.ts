import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { DouyuLotteryReader, DouyuLotteryService } from './douyuLottery'
import { addDouyuLotteryCost, parseDouyuLottery } from './douyuLotteryProtocol'
import { parseDouyuGiftCatalog } from './giftPurchaseGateway'

const NOW = Date.parse('2026-11-17T00:00:00Z')
const payload = (patch: Record<string, unknown> = {}) => ({ error: 0, data: {
  room_id: '100', activity_id: '456', activity_status: '4', prize_name: '奖品 <img>', prize_num: '2',
  start_at: NOW / 1000 - 60, stop_at: NOW / 1000 + 120, join_type: '1',
  join_condition: { lottery_range: 3, command_content: ' 口令 <img>  ' }, ...patch,
} })
const snapshot = (room = '100') => ({ room, serverNow: NOW, status: 'active' as const, activity: parseDouyuLottery(payload({ room_id: room }), room, NOW) })
const proxy = resolveConfig({}).proxy
const date = new Date(NOW).toUTCString()
const signal = () => new AbortController().signal

describe('Douyu lottery protocol', () => {
  it('binds the formal room, preserves exact text and parses official timed expiry', () => {
    const fixture = payload({ stop_at: 0, join_condition: { expire_time: 180, lottery_range: 3, command_content: ' 口令 <img>  ' } })
    expect(parseDouyuLottery(fixture, '100', NOW)).toMatchObject({ id: '456', room: '100', prize: '奖品 <img>', prizeCount: 2,
      startsAt: NOW - 60_000, endsAt: NOW + 120_000, command: ' 口令 <img>  ', eligibility: 'unknown',
      conditions: expect.arrayContaining(['需要关注和粉丝团身份']) })
    expect(() => parseDouyuLottery(fixture, '200', NOW)).toThrow('Lottery room mismatch')
    expect(parseDouyuLottery(fixture, '100', NOW + 120_000)).toBeNull()
    expect(parseDouyuLottery(fixture, '100', NOW - 60_001)).toBeNull()
  })

  it.each([0, 1, 2, 3, 5, 6, 7])('keeps non-active status %s out of the card', status => {
    expect(parseDouyuLottery(payload({ activity_status: status }), '100', NOW)).toBeNull()
  })

  it.each([['YUCHI', 100], ['YUWAN', 1]] as const)('calculates catalog cost in %s and removes a stale text command', (currency, scale) => {
    const activity = parseDouyuLottery(payload({ join_type: 2, join_condition: {
      gift_id: 22, gift_num: 3, gift_name: '礼物原文', gift_price: '1.5', command_content: '上一轮口令',
    } }), '100', NOW)!
    expect(activity).toMatchObject({ command: null, cost: null, gift: { count: 3, priceOriginal: '1.5' } })
    const item = { id: 22, name: '礼物原文', basicInfo: {}, priceInfo: { price: 150, priceType: currency } }
    const catalog = (room: string) => parseDouyuGiftCatalog({ error: 0, data: { giftList: [item] } }, room, NOW)
    expect(addDouyuLotteryCost(activity, catalog('100')).cost)
      .toEqual({ currency, totalMinor: 450, scale })
    expect(addDouyuLotteryCost(activity, catalog('200')).cost).toBeNull()
  })

  it('does not infer the count or currency for an incomplete gift requirement', () => {
    const activity = parseDouyuLottery(payload({ join_type: 3, join_condition: { gift_id: 22, gift_price: '1.5' } }), '100', NOW)
    expect(activity).toMatchObject({ gift: { id: '22', count: null, priceOriginal: '1.5' }, cost: null })
  })
})

describe('read-only lottery transport', () => {
  it('uses only an anonymous GET with platform time and accounts for HTTP Age', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(payload(), { headers: { Date: date, Age: '2' } }))
    const reader = new DouyuLotteryReader({ proxy, fetchImpl: request, resolve: async () => ['8.8.8.8'] })
    const result = await reader.read('100', signal())
    expect(result).toMatchObject({ status: 'active', activity: { id: '456' } })
    expect(result.serverNow).toBeGreaterThanOrEqual(NOW + 2_000)
    expect(result.serverNow).toBeLessThan(NOW + 5_000)
    expect(request).toHaveBeenCalledOnce()
    const [url, options] = request.mock.calls[0]!
    expect(String(url)).toBe('https://www.douyu.com/member/lottery/activity_info?room_id=100')
    expect(options!.method).toBe('GET')
    expect(JSON.stringify(options!.headers)).not.toMatch(/cookie|authorization|csrf/i)
    expect(options!.body).toBeUndefined()
  })

  it('keeps the gift activity when its separate catalog response is unavailable', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(payload({ join_type: 2, join_condition: { gift_id: 22, gift_num: 3 } }), { headers: { Date: date } }))
    const readCatalog = vi.fn().mockRejectedValue(new Error('catalog unavailable'))
    const reader = new DouyuLotteryReader({ proxy, fetchImpl: request, readCatalog, resolve: async () => ['8.8.8.8'] })
    expect(await reader.read('100', signal())).toMatchObject({ status: 'active', activity: { cost: null, gift: { id: '22', count: 3 } } })
    expect(request).toHaveBeenCalledOnce()
    expect(readCatalog).toHaveBeenCalledWith('100', expect.any(AbortSignal))
  })

  it('rejects missing official time, redirects, stale records and ambiguous data', async () => {
    for (const response of [Response.json(payload()), Response.json(payload(), { headers: { Date: date, Age: '30' } }),
      new Response('{"error":0,"error":0,"data":{}}', { headers: { Date: date } }),
      new Response('x'.repeat(70_000), { headers: { Date: date } }), new Response('', { status: 302 })]) {
      const reader = new DouyuLotteryReader({ proxy, fetchImpl: async () => response, resolve: async () => ['8.8.8.8'] })
      await expect(reader.read('100', signal())).rejects.toThrow()
    }
  })
})

describe('lottery lifecycle', () => {
  it('requires a connected room, coalesces reads and rejects expired or stale official links', async () => {
    let time = 0
    const read = vi.fn(async () => snapshot())
    const service = new DouyuLotteryService({ read }, () => time)
    service.setRoom('100')
    await expect(service.read('100')).rejects.toMatchObject({ code: 'cancelled' })
    service.connection('100', true)
    const [first, second] = await Promise.all([service.read('100'), service.read('100')])
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(read).toHaveBeenCalledOnce()
    time = 14_000
    expect((await service.read('100')).serverNow).toBe(NOW + time)
    expect(service.officialUrl('100', '456')).toBe('https://www.douyu.com/100')
    expect(() => service.officialUrl('100', '457')).toThrow()
    time = 15_000
    expect(() => service.officialUrl('100', '456')).toThrow()
    service.dispose()
    await expect(service.read('100')).rejects.toMatchObject({ code: 'cancelled' })
  })

  it.each(['room', 'disconnect', 'dispose'])('cancels late reads on %s', async event => {
    let active!: AbortSignal
    const read = vi.fn((_room: string, value: AbortSignal) => {
      active = value
      return new Promise<ReturnType<typeof snapshot>>(() => {})
    })
    const service = new DouyuLotteryService({ read })
    service.setRoom('100')
    service.connection('100', true)
    const old = service.read('100')
    await Promise.resolve()
    if (event === 'room') service.setRoom('200')
    else if (event === 'disconnect') service.connection('100', false)
    else service.dispose()
    expect(active.aborted).toBe(true)
    await expect(old).rejects.toMatchObject({ code: 'cancelled' })
    if (event === 'dispose') return
    const room = event === 'room' ? '200' : '100'
    service.connection(room, true)
    read.mockResolvedValue(snapshot(room))
    expect((await service.read(room)).activity?.room).toBe(room)
  })
})
