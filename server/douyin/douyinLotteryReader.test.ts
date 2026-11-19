import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { DOUYIN_USER_AGENT } from '../platforms/douyinDanmaku'
import { DOUYIN_LOTTERY_MAX_BYTES, douyinLotteryOfficialUrl, parseDouyinLottery, readDouyinLottery } from './douyinLotteryReader'
import { DOUYIN_LOTTERY_FIXTURE_TARGET as target, douyinLotteryFixture } from './fixtures/douyinLotteryFixture'

const now = 1_795_000_000_000
const metadata = { webRoom: '100', roomId: target.roomId, cookie: 'ttwid=synthetic-anonymous', userAgent: DOUYIN_USER_AGENT }
const deps = { proxy: resolveConfig({}, '.runtime-cache').proxy, resolve: async () => ['93.184.216.34'], now: () => now }
const parse = (raw: unknown) => parseDouyinLottery(raw, target, now)

describe('Douyin ordinary lottery', () => {
  it('projects public activity, exact command and seconds from a synthetic response', () => {
    const raw = douyinLotteryFixture(now)
    Object.assign(raw.data.lottery_info, { user_condition: { uid: 'private-account' }, rule_page_scheme: 'file:///private' })
    const request = { ...target, Cookie: 'private-session' }
    const snapshot = parseDouyinLottery(raw, request, now)
    expect(snapshot).toMatchObject({
      ...target, observedAt: now, status: 'active', activity: {
        platformTime: now / 1000, drawTime: now / 1000 + 90, commentCommand: '测试口令',
        prize: { kind: 'virtual-currency', count: 100, winners: 5 },
        webSupport: 'unknown', conditions: [{ type: 3, label: '发送指定评论: 测试口令' }, { type: 6 }],
      },
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/private|file:/)
  })

  it('distinguishes empty, expired, restricted and unknown responses', () => {
    for (const data of [{}, { lottery_info: null }, { lottery_info: {} }]) {
      expect(parse({ status_code: 0, data })).toMatchObject({ ...target, status: 'empty', activity: null })
    }
    expect(parse(douyinLotteryFixture(now, 0)).status).toBe('empty')
    for (const raw of [{ status_code: 403, data: {} }, { status_code: 0, data: null },
      { status_code: 0, data: [] }, { status_code: 0, data: { unknown: true } }]) {
      expect(parse(raw)).toMatchObject({ ...target, status: 'unavailable', activity: null })
    }
  })

  it('rejects an old or conflicting room, precision-lost IDs, and unsupported prize families', () => {
    for (const overrides of [
      { room_id_str: '9000000000000000002' },
      { room_id: 75 },
      { lottery_id_str: undefined, lottery_id: 9000000000000000042 },
      { lottery_id_str: '18446744073709551616' },
      { draw_time: now },
      { prize_info: { type: 4 } },
    ]) {
      const raw = douyinLotteryFixture(now)
      Object.assign(raw.data.lottery_info, overrides)
      expect(parse(raw).status).toBe('unavailable')
    }
  })

  it('keeps App-only conditions tentative and preserves an exact unambiguous command', () => {
    const raw = douyinLotteryFixture(now)
    const info = raw.data.lottery_info
    info.conditions = [{ type: 3, content: ' 测试口令 ' }, { type: 4 }]
    expect(parse(raw).activity).toMatchObject({ commentCommand: ' 测试口令 ', webSupport: 'app-may-be-required' })
    info.conditions.push({ type: 3, content: '另一条口令' })
    expect(parse(raw).activity?.commentCommand).toBeNull()
    info.conditions = [{ type: 3, content: ' ' }]
    expect(parse(raw).activity?.commentCommand).toBeNull()
  })

  it.each(['https://other.test/', 'douyin:0', 'douyin:100?test=1', 'douyin:18446744073709551616', 'huya:100'])(
    'rejects an arbitrary room URL %s',
    room => expect(() => douyinLotteryOfficialUrl(room)).toThrow(),
  )
})

describe('Douyin anonymous lottery transport', () => {
  it('performs one GET with the validated scene and anonymous cookie', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(douyinLotteryFixture(now)))
    const result = await readDouyinLottery(metadata, new AbortController().signal, { ...deps, fetchImpl })
    expect(result).toMatchObject({ ...target, status: 'active' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [input, init] = fetchImpl.mock.calls[0]!
    const url = new URL(String(input))
    expect(url.origin + url.pathname).toBe('https://live.douyin.com/webcast/lottery/melon/lottery_info/')
    expect(url.searchParams.get('room_id')).toBe(target.roomId)
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get('cookie')).toBe(metadata.cookie)
  })

  it('refuses account cookies before dispatch and never follows redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: 'https://other.test/' } }))
    const signal = new AbortController().signal
    expect((await readDouyinLottery({ ...metadata, cookie: 'sessionid=private' }, signal, { ...deps, fetchImpl })).status).toBe('unavailable')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await readDouyinLottery(metadata, signal, { ...deps, fetchImpl })).status).toBe('unavailable')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['HTML challenge', () => new Response('<html>challenge</html>')],
    ['access refusal', () => new Response(null, { status: 403 })],
    ['invalid JSON', () => new Response('invalid JSON', { headers: { 'content-type': 'application/json' } })],
    ['oversized body', () => new Response('x'.repeat(DOUYIN_LOTTERY_MAX_BYTES + 1), { headers: { 'content-type': 'application/json' } })],
  ] as const)('reports %s as unavailable', async (_label, response) => {
    expect((await readDouyinLottery(metadata, new AbortController().signal, { ...deps, fetchImpl: async () => response() })).status)
      .toBe('unavailable')
  })

  it('rejects immediately on caller cancellation and abandons an in-flight read', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const result = readDouyinLottery(metadata, controller.signal, { ...deps, fetchImpl })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await expect(readDouyinLottery(metadata, controller.signal, { ...deps, fetchImpl })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
