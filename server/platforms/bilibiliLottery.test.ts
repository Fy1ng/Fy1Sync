import { describe, expect, it, vi } from 'vitest'
import { bilibiliLotteryConditions } from '../../src/core/bilibiliLottery'
import { BilibiliLotteryGateway, bilibiliLotteryOfficialUrl, bilibiliLotteryRoom, parseBilibiliLottery } from './bilibiliLottery'
import type { ProxyConfig } from '../config'
import type { safeFetch } from '../safeFetch'
import { BILIBILI_LOTTERY_FIXTURE_NOW as NOW, bilibiliLotteryFixture } from './fixtures/bilibiliLottery'

const proxy: ProxyConfig = { enabled: true, hosts: ['api.live.bilibili.com'], allowNonStandardPorts: false, maxRedirects: 3, requestTimeoutMs: 15000 }

describe('Bilibili lottery read-only metadata', () => {
  it('anchors to official time under clock skew and omits upstream private fields', () => {
    const result = parseBilibiliLottery(bilibiliLotteryFixture({ award_users: [{ uid: 42, name: 'private' }],
      h5_url: 'https://evil.example/' }), '21452505', NOW - 3600_000, null, 1000)
    expect(result).toMatchObject({ phase: 'ongoing', serverNow: NOW + 500, observedFrom: NOW, endsAt: NOW + 90_000,
      clockSource: 'payload', clockUncertaintyMs: 1500, activity: { id: '771', joined: false } })
    expect(JSON.stringify(result)).not.toMatch(/private|evil|uid|award_users/)
  })
  it('preserves multiple exact candidates without trimming, case folding, truncation or control removal', () => {
    const result = parseBilibiliLottery(bilibiliLotteryFixture({ danmu_new: [{ danmu: '测试口令' },
      { danmu: ' 测试口令 ' }, { danmu: 'ABC' }, { danmu: 'bad\ncommand' }, { danmu: 'x'.repeat(501) }] }), '21452505', NOW)
    expect(result.activity?.messages).toEqual(['测试口令', ' 测试口令 ', 'ABC'])
  })
  it.each([[0, 'ongoing'], [1, 'settling'], [2, 'ended'], [3, 'unverified']])('maps lot_status %i', (status, phase) => {
    expect(parseBilibiliLottery(bilibiliLotteryFixture({ lot_status: status }), '21452505', NOW).phase).toBe(phase)
  })
  it.each([[-101, 'login-required'], [-352, 'restricted'], [-412, 'restricted'], [429, 'restricted'], [19002000, 'unavailable']])('maps refusal %i', (code, phase) => {
    expect(parseBilibiliLottery({ code, data: 'secret' }, '21452505', NOW).phase).toBe(phase)
  })
  it.each([{}, { code: 0 }, { code: 0, data: {} }, bilibiliLotteryFixture({ room_id: 99 }),
    bilibiliLotteryFixture({ id: Number.MAX_SAFE_INTEGER + 1 })])('rejects incomplete or mismatched envelopes', raw => {
    expect(parseBilibiliLottery(raw, '21452505', NOW)).toMatchObject({ phase: 'unverified', activity: null })
  })
  it('keeps missing clocks unknown, accepts official Date and bounds response timing', () => {
    const missing = bilibiliLotteryFixture({ current_timestamp: undefined })
    expect(parseBilibiliLottery(missing, '21452505', NOW)).toMatchObject({ serverNow: null, endsAt: null, clockSource: null })
    expect(parseBilibiliLottery(missing, '21452505', NOW, new Date(NOW).toUTCString())).toMatchObject({ serverNow: NOW, clockSource: 'http-date' })
    expect(parseBilibiliLottery(bilibiliLotteryFixture(), '21452505', NOW, null, NaN).serverNow).toBeNull()
    expect(parseBilibiliLottery(bilibiliLotteryFixture({ time: 0 }), '21452505', NOW).phase).toBe('ended')
    expect(parseBilibiliLottery({ code: 0, data: null }, '21452505', NOW).phase).toBe('empty')
  })
  it('keeps gift conditions, unknown prices and game tasks separate', () => {
    const gift = parseBilibiliLottery(bilibiliLotteryFixture({ join_type: 1, gift_name: '小花花', gift_num: 2, gift_price: 100 }), '21452505', NOW)
    expect(bilibiliLotteryConditions(gift.activity!).join(' ')).toMatch(/小花花 x 2.*100 金瓜子/)
    const unknown = parseBilibiliLottery(bilibiliLotteryFixture({ join_type: 1 }), '21452505', NOW)
    expect(bilibiliLotteryConditions(unknown.activity!).join(' ')).toContain('赠送成本待官方确认')
    const game = parseBilibiliLottery(bilibiliLotteryFixture({ join_type: 2, require_type: 999 }), '21452505', NOW)
    expect(bilibiliLotteryConditions(game.activity!).join(' ')).toMatch(/游戏任务.*待官方确认/)
  })
  it('constructs only fixed official URLs', () => {
    expect(bilibiliLotteryRoom('bilibili:6')).toBe('6')
    expect(bilibiliLotteryRoom('https://live.bilibili.com/6?broadcast_type=0')).toBe('6')
    for (const input of ['0006', 'https://live.bilibili.com.evil/6', 'https://live.bilibili.com:444/6',
      'https://user@live.bilibili.com/6', 'https://live.bilibili.com/6/evil', 'javascript:alert(1)']) {
      expect(bilibiliLotteryRoom(input)).toBeNull()
      expect(() => bilibiliLotteryOfficialUrl(input)).toThrow()
    }
    expect(bilibiliLotteryOfficialUrl('21452505')).toBe('https://live.bilibili.com/21452505')
  })
})

describe('Bilibili lottery gateway', () => {
  it('resolves short IDs, caches identity and uses GET-only cookies scoped to Check', async () => {
    const urls: string[] = []
    const cookieHeader = vi.fn(async () => 'SESSDATA=synthetic')
    const request: typeof safeFetch = async (url, policy, options) => {
      urls.push(url)
      expect(policy.maxRedirects).toBe(0)
      expect(options?.method).toBe('GET')
      expect(options?.headers).toEqual(url.includes('room_init') ? { Referer: 'https://live.bilibili.com/' }
        : { Referer: 'https://live.bilibili.com/', Cookie: 'SESSDATA=synthetic' })
      const body = url.includes('room_init') ? { code: 0, data: { room_id: 21452505 } } : bilibiliLotteryFixture()
      return { finalUrl: new URL(url), response: new Response(JSON.stringify(body)) }
    }
    const gateway = new BilibiliLotteryGateway({ proxy, request, cookieHeader, now: () => NOW })
    const signal = new AbortController().signal
    expect(await gateway.read('6', signal)).toMatchObject({ room: '21452505', phase: 'ongoing' })
    await gateway.read('6', signal)
    expect(urls).toEqual(['https://api.live.bilibili.com/room/v1/Room/room_init?id=6',
      'https://api.live.bilibili.com/xlive/lottery-interface/v1/Anchor/Check?roomid=21452505',
      'https://api.live.bilibili.com/xlive/lottery-interface/v1/Anchor/Check?roomid=21452505'])
    expect(cookieHeader).toHaveBeenCalledTimes(2)
  })
  it('rejects oversized bodies, restrictions and pre-aborted requests', async () => {
    const request = vi.fn<typeof safeFetch>(async url => ({ finalUrl: new URL(url), response: new Response('x'.repeat(128 * 1024 + 1)) }))
    const gateway = new BilibiliLotteryGateway({ proxy, request, cookieHeader: async () => '' })
    expect((await gateway.read('6', new AbortController().signal)).phase).toBe('unavailable')
    request.mockImplementation(async url => ({ finalUrl: new URL(url), response: new Response('', { status: 412 }) }))
    expect((await gateway.read('6', new AbortController().signal)).phase).toBe('restricted')
    const aborted = new AbortController(); aborted.abort()
    await expect(gateway.read('6', aborted.signal)).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(2)
  })
})
