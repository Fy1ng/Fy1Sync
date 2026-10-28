import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { DouyuInsightsGateway } from './insightsGateway'
import { parseRenewalTargets } from './renewalInventory'

const NOW = Date.UTC(2026, 9, 25, 12)
const COOKIE = 'acf_uid=42; acf_auth=synthetic-account-secret'
const envelope = (data: unknown) => ({ error: 0, data })
const followed = (room: string) => ({ room_id: room, room_name: `room ${room}`, nickname: '主播', show_status: '1', videoLoop: '0', show_time: String(NOW / 1000 - 60), online: 123 })
const idle = () => new AbortController().signal
function setup(responses: Array<unknown | Error>, options: { now?: number; privateDns?: boolean } = {}) {
  let index = 0, cookie = COOKIE
  const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const response = responses[index++]
    if (response instanceof Error) throw response
    if (response === undefined) throw new Error('unexpected request')
    return response instanceof Response ? response : Response.json(response)
  })
  const cookieHeader = vi.fn(async () => cookie)
  const gateway = new DouyuInsightsGateway({ proxy: resolveConfig({}).proxy, request, cookieHeader,
    resolve: async () => [options.privateDns ? '127.0.0.1' : '8.8.8.8'], now: () => options.now ?? NOW })
  return { gateway, request, cookieHeader, setCookie: (value: string) => { cookie = value } }
}
afterEach(() => { vi.useRealTimers() })

describe('read-only followed room gateway', () => {
  it('walks all explicit pages and emits only whitelisted metadata', async () => {
    const f = setup([envelope({ pageCount: 2, total: 3, list: [followed('100'), followed('200')] }), envelope({ pageCount: 2, total: 3, list: [{ ...followed('300'), secret: 'never-return' }] })])
    const result = await f.gateway.readFollowedRooms('account-one', idle())
    expect(result.coverage).toBe('all-pages')
    expect(result.rooms.map(room => room.room)).toEqual(['100', '200', '300'])
    expect(result.rooms[0]).toMatchObject({ live: true, replay: false, startedAt: NOW - 60_000, popularity: 123, url: 'https://www.douyu.com/100' })
    expect(f.request.mock.calls.map(([url]) => String(url))).toEqual([
      'https://www.douyu.com/wgapi/livenc/liveweb/follow/list?page=1', 'https://www.douyu.com/wgapi/livenc/liveweb/follow/list?page=2',
    ])
    expect(JSON.stringify(result)).not.toMatch(/never-return|synthetic-account-secret/)
    expect(f.cookieHeader.mock.calls).toHaveLength(2)
  })
  it('requires explicit empty completeness, not just an empty list', async () => {
    expect((await setup([envelope({ pageCount: 0, total: 0, list: [] })]).gateway.readFollowedRooms('a', idle())).coverage).toBe('all-pages')
    expect((await setup([envelope({ list: [] })]).gateway.readFollowedRooms('a', idle())).coverage).toBe('partial')
  })
  it('normalizes safe numeric room IDs without hiding numeric/string duplicates', async () => {
    const f = setup([envelope({ pageCount: 1, total: 1, list: [{ ...followed('100'), room_id: 100 }] })])
    expect((await f.gateway.readFollowedRooms('a', idle())).rooms[0]?.room).toBe('100')
    const duplicate = setup([envelope({ pageCount: 1, total: 2, list: [followed('100'), { ...followed('100'), room_id: 100 }] })])
    expect(await duplicate.gateway.readFollowedRooms('a', idle())).toMatchObject({ coverage: 'partial', rooms: [] })
  })
  it.each([
    envelope({ pageCount: 2, total: 2, list: [followed('100')] }),
    envelope({ pageCount: 3, total: 3, list: [followed('200')] }),
    new Error('upstream-token-must-stay-private'),
  ])('does not call a repeated, changed or failed page complete', async second => {
    const f = setup([envelope({ pageCount: 2, total: 2, list: [followed('100')] }), second])
    const result = await f.gateway.readFollowedRooms('a', idle())
    expect(result.coverage).toBe('partial')
    expect(result.rooms).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('upstream-token')
  })
  it('refuses a login mismatch and never exposes a partial account snapshot after invalidation', async () => {
    const f = setup([envelope({ pageCount: 1, total: 1, list: [followed('100')] })])
    const controller = new AbortController()
    f.request.mockImplementationOnce(async () => { controller.abort(); return Response.json(envelope({ pageCount: 1, total: 1, list: [followed('100')] })) })
    await expect(f.gateway.readFollowedRooms('a', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(setup([envelope({ uid: '43', pageCount: 0, total: 0, list: [] })]).gateway.readFollowedRooms('a', idle())).rejects.toMatchObject({ code: 'login-required' })
  })
  it('accepts equal host and domain device cookies for read-only account queries', async () => {
    const f = setup([envelope({ pageCount: 0, total: 0, list: [] }), envelope({ todayWatch: '123', rid: '100' })])
    f.setCookie(`${COOKIE}; dy_did=synthetic-device-123; dy_did=synthetic-device-123`)
    expect(await f.gateway.readFollowedRooms('a', idle())).toMatchObject({ coverage: 'all-pages', rooms: [] })
    expect(await f.gateway.readWatchTime('a', '100', idle())).toMatchObject({ seconds: 123 })
    expect(f.request).toHaveBeenCalledTimes(2)
  })
  it('still checks credential continuity between distinct pagination requests', async () => {
    const f = setup([envelope({ pageCount: 2, total: 2, list: [followed('100')] })])
    f.request.mockImplementationOnce(async () => {
      f.setCookie('acf_uid=43; acf_auth=other')
      return Response.json(envelope({ pageCount: 2, total: 2, list: [followed('100')] }))
    })
    await expect(f.gateway.readFollowedRooms('a', idle())).rejects.toMatchObject({ code: 'login-required' })
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.cookieHeader).toHaveBeenCalledTimes(2)
  })
  it.each([
    `${COOKIE}; dy_did=synthetic-device-123; dy_did=other-device-456`,
    `${COOKIE}; acf_auth=synthetic-account-secret`,
    `${COOKIE}; acf_uid=42`,
  ])('still rejects ambiguous devices or repeated authentication cookies before network access', async cookie => {
    const f = setup([])
    f.setCookie(cookie)
    await expect(f.gateway.readFollowedRooms('a', idle())).rejects.toMatchObject({ code: 'login-required' })
    expect(f.request).not.toHaveBeenCalled()
  })
  it.each([301, 302, 401, 403, 429, 500])('rejects HTTP %s and follows no redirect', async status => {
    const f = setup([new Response('sensitive', { status, headers: { location: 'https://evil.example/' } })])
    await expect(f.gateway.readFollowedRooms('a', idle())).rejects.toThrow()
    expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('rejects duplicate JSON keys, private DNS and missing credentials', async () => {
    await expect(setup([new Response('{"error":-1,"error":0,"data":{}}')]).gateway.readFollowedRooms('a', idle())).rejects.toThrow()
    const privateRequest = setup([], { privateDns: true })
    await expect(privateRequest.gateway.readFollowedRooms('a', idle())).rejects.toThrow()
    expect(privateRequest.request).not.toHaveBeenCalled()
    const f = setup([]); f.setCookie('')
    await expect(f.gateway.readFollowedRooms('a', idle())).rejects.toMatchObject({ code: 'login-required' })
    expect(f.request).not.toHaveBeenCalled()
  })
  it('cancels a stuck credential provider within the request deadline', async () => {
    vi.useFakeTimers()
    const f = setup([])
    f.cookieHeader.mockImplementation(() => new Promise<string>(() => {}))
    const result = f.gateway.readFollowedRooms('a', idle())
    const assertion = expect(result).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(15_001)
    await assertion
    expect(f.request).not.toHaveBeenCalled()
  })
})

describe('room metadata, badge age and platform watch time', () => {
  it('fetches room metadata anonymously and preserves unknown real viewers', async () => {
    const f = setup([envelope({ room_id: '100', show_status: '1', show_time: NOW / 1000 - 40, owner_uid: '42', online: 0 })])
    expect(await f.gateway.readRoom('100', idle())).toMatchObject({ live: true, startedAt: NOW - 40_000, viewers: null, popularity: 0, ownerUid: '42' })
    expect(f.cookieHeader).not.toHaveBeenCalled()
    expect(f.request.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Cookie')
  })
  it('uses the last start time only when offline and rejects an alias mismatch', async () => {
    const f = setup([envelope({ room_id: '100', show_status: '2', show_time: NOW / 1000 - 40 })])
    expect(await f.gateway.readRoom('100', idle())).toMatchObject({ live: false, startedAt: null, lastStartedAt: NOW - 40_000 })
    await expect(setup([envelope({ room_id: '200' })]).gateway.readRoom('100', idle())).rejects.toThrow()
  })
  it('retains only explicitly requested badge acquisition metadata', () => {
    const html = (value: string) => `<table class="fans-badge-list"><tr data-fans-room="100" data-fans-gbdgts="${value}"><td>badge</td></tr></table>`
    const acquiredAt = NOW - 3 * 86_400_000 - 99
    expect(parseRenewalTargets(html(String(Math.floor(acquiredAt / 1000))), { now: NOW })[0]).toMatchObject({ acquiredAt: Math.floor(acquiredAt / 1000) * 1000, heldDays: 3 })
    expect(parseRenewalTargets(html('1700000000'))[0]).not.toHaveProperty('acquiredAt')
    for (const value of ['0', 'NaN', '-1', String(NOW / 1000 + 1)]) expect(parseRenewalTargets(html(value), { now: NOW })[0]).toMatchObject({ acquiredAt: null, heldDays: null })
  })
  it('checks the official per-account watch value and never replaces missing data with zero', async () => {
    expect(await setup([envelope({ todayWatch: '123', rid: '100' })]).gateway.readWatchTime('a', '100', idle())).toMatchObject({ seconds: 123 })
    expect(await setup([envelope({})]).gateway.readWatchTime('a', '100', idle())).toMatchObject({ seconds: null })
    expect(await setup([envelope({ todayWatch: 0, rid: 0 })]).gateway.readWatchTime('a', '100', idle())).toMatchObject({ seconds: null })
    expect(await setup([envelope({ todayWatch: 123, rid: '0' })]).gateway.readWatchTime('a', '100', idle())).toMatchObject({ seconds: null })
  })
  it('accepts the official numeric room binding while rejecting mismatches and invalid IDs', async () => {
    expect(await setup([envelope({ todayWatch: 123, rid: 100 })]).gateway.readWatchTime('a', '100', idle())).toMatchObject({ seconds: 123 })
    expect(await setup([envelope({ room_id: 100, show_status: '1' })]).gateway.readRoom('100', idle())).toMatchObject({ room: '100' })
    for (const rid of [200, 100.5, -100, Number.MAX_SAFE_INTEGER + 1, '0100']) {
      await expect(setup([envelope({ todayWatch: 123, rid })]).gateway.readWatchTime('a', '100', idle())).rejects.toMatchObject({ code: 'invalid-data' })
    }
  })
})

describe('monthly consumption sources', () => {
  it('aggregates signed debits and refunds with source categories', async () => {
    const f = setup([envelope([{ id: 1, amount: -300, consumeTypeDesc: '礼物' }, { id: 2, amount: 100, consumeTypeDesc: '退款' }]), envelope({ list: [] })])
    const value = await f.gateway.readMonthlySpending('a', idle())
    expect(value).toMatchObject({ month: '2026-10', currency: 'CNY', unit: 'fen', totalMinor: 200, aggregation: 'complete' })
    expect(value.sources[0]?.categories).toEqual([{ category: '礼物', amountMinor: 300, entries: 1 }, { category: '退款', amountMinor: -100, entries: 1 }])
  })
  it('does not blindly add potentially overlapping diamond and gift ledgers', async () => {
    const f = setup([envelope([{ id: 1, amount: -600 }]), envelope({ list: [{ id: 2, consumeTime: NOW / 1000 - 1, consumeMoney: 600 }] })])
    const value = await f.gateway.readMonthlySpending('a', idle())
    expect(value.totalMinor).toBeNull()
    expect(value.aggregation).toBe('unreconciled')
    expect(value.sources.map(source => source.amountMinor)).toEqual([600, 600])
  })
  it('deduplicates a common order and rejects conflicting order amounts', async () => {
    const ledgers = (amount: number) => [envelope([{ id: 1, amount: -600, orderId: 'ORDER-42' }]), envelope({ list: [{ id: 2, consumeTime: NOW / 1000 - 1, consumeMoney: amount, orderId: 'ORDER-42' }] })]
    expect((await setup(ledgers(600)).gateway.readMonthlySpending('a', idle())).totalMinor).toBe(600)
    expect((await setup(ledgers(700)).gateway.readMonthlySpending('a', idle())).aggregation).toBe('unreconciled')
  })
  it('uses a bounded cursor and marks repeated pages partial', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, amount: -100 }))
    const f = setup([envelope(rows), envelope(rows), envelope({ list: [] })])
    const value = await f.gateway.readMonthlySpending('a', idle())
    expect(String(f.request.mock.calls[1]?.[0])).toContain('&id=20')
    expect(value.sources[0]).toMatchObject({ coverage: 'partial', amountMinor: 2000, entries: 20 })
    expect(value.totalMinor).toBeNull()
  })
  it('keeps a failed source partial and does not claim a complete zero', async () => {
    const value = await setup([new Error('secret'), envelope({ list: [] })]).gateway.readMonthlySpending('a', idle())
    expect(value.aggregation).toBe('partial')
    expect(value.totalMinor).toBeNull()
  })
  it('computes month boundaries in the platform timezone, including UTC year rollover', async () => {
    const f = setup([envelope([]), envelope({ list: [] })], { now: Date.UTC(2026, 11, 31, 17) })
    expect((await f.gateway.readMonthlySpending('a', idle())).month).toBe('2027-01')
    expect(String(f.request.mock.calls[0]?.[0])).toContain('tradeStartDate=2027-01-01')
  })
})
