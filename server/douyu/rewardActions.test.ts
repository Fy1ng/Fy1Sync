import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import type { DouyuActionDependencies } from './actions'
import type { DouyuTaskDefinition } from './types'
import { DouyuRewardActions } from './rewardActions'

// Synthetic account data only. No test fetches a real room or claims a real reward.
const NOW = Date.parse('2026-10-24T01:00:00Z')
const cookie = 'acf_uid=42; acf_auth=synthetic-private-auth; acf_ccn=synthetic-private-csrf; dy_did=synthetic-device-123'
const packetList = 'https://www.douyu.com/japi/interactnc/web/propredpacket/getPrpList?type_id=1&room_id=6979222'
const packetGrab = 'https://www.douyu.com/japi/interactnc/web/propredpacket/grab_prp'
const packetResult = 'https://www.douyu.com/japi/interactnc/web/propredpacket/get_prp_result?activityid=12345'
const followQuery = 'https://www.douyu.com/wgapi/livenc/liveweb/follow/query?rids=6979222'
const boxPanel = 'https://www.douyu.com/mgapi/activitync/box/panel?rid=6979222'
const boxGrab = 'https://www.douyu.com/wgapi/activitync/barrageBox/grab'
const roomUrl = 'https://www.douyu.com/betard/6979222'
const signal = () => new AbortController().signal
const task = (kind: 'gift-packet' | 'treasure-box' = 'gift-packet'): DouyuTaskDefinition => ({ id: 'synthetic-task', accountId: 'account-one', room: '6979222', kind, policy: 'foreground', repeatMinutes: null, createdAt: 0 })
const packet = (overrides: Record<string, unknown> = {}) => ({ activityid: '12345', joinc: 0, startTime: NOW / 1_000 - 10, cdtime: 0, ...overrides })
const box = (overrides: Record<string, unknown> = {}) => ({ type: 2, BarrageBox: { treasureId: 98765, treasureType: 1, openTime: NOW / 1_000 - 10, destroyTime: NOW / 1_000 + 300, ...overrides } })
const envelope = (data: unknown) => ({ error: 0, data })
const packets = (...list: unknown[]) => envelope({ list })
const boxes = (...list: unknown[]) => envelope({ list })
const owner = (uid: unknown = 123) => ({ room: { room_id: 6979222, owner_uid: uid } })
const packetReceipt = (isSuc = 1, overrides: Record<string, unknown> = {}) => envelope({ activityid: 12345, isSuc, ...overrides })
const boxReceipt = (overrides: Record<string, unknown> = {}) => envelope({ prizeType: 1, silverCount: 10, silverBalance: 100, ...overrides })

function scripted(...responses: unknown[]) {
  let index = 0
  return vi.fn<typeof fetch>(async () => {
    if (index >= responses.length) throw new Error('Unexpected synthetic request')
    const next = responses[index++]
    if (next instanceof Error) throw next
    return next instanceof Response ? next : Response.json(next)
  })
}

function setup(responses: unknown[] = [], overrides: Partial<DouyuActionDependencies & { now: () => number }> = {}) {
  const request = scripted(...responses)
  const cookieHeader = vi.fn(async (_accountId: string, _url: string) => cookie)
  const resolve = vi.fn(async () => ['8.8.8.8'])
  const clock = { now: NOW }
  const deps = { request, cookieHeader, resolve, proxy: resolveConfig({}).proxy, now: () => clock.now, ...overrides }
  return { actions: new DouyuRewardActions(deps), request, cookieHeader, resolve, clock }
}
const writeCount = (request: ReturnType<typeof scripted>) => request.mock.calls.filter(([, init]) => init?.method === 'POST').length
const expectPrivate = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/synthetic|private|acf_|dy_did|doctype|evil\.test/)

afterEach(() => vi.useRealTimers())

describe('gift packet official protocol', () => {
  it('submits once with the exact scoped CSRF and confirms the later official result by GET', async () => {
    const { actions, request, cookieHeader, clock } = setup([packets(packet()), owner(), packetReceipt(), packets(packet()), packetReceipt()])
    expect(await actions.run(task(), signal())).toEqual({ status: 'scheduled', message: '礼物红包参与已提交, 等待官方结果.', nextRunAt: NOW + 5_000 })
    clock.now += 5_000
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled', message: expect.stringContaining('官方已确认') })
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([packetList, roomUrl, packetGrab, packetList, packetResult])
    expect(writeCount(request)).toBe(1)
    const [, post] = request.mock.calls[2]!
    expect(Object.fromEntries(new URLSearchParams(post?.body as string))).toEqual({ activityid: '12345', ctn: 'synthetic-private-csrf' })
    expect(new Headers(post?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    for (const [url, init] of request.mock.calls) {
      expect(init?.redirect).toBe('manual')
      const headers = new Headers(init?.headers)
      expect(headers.get('cookie')).toBe(cookie)
      expect(headers.get('referer')).toBe('https://www.douyu.com/6979222')
      expect(String(url)).not.toMatch(/synthetic|acf_|token=/)
      expect(cookieHeader.mock.calls.filter(([, scope]) => scope === String(url)).length).toBeGreaterThanOrEqual(3)
    }
    expect(cookieHeader.mock.calls.every(([account]) => account === 'account-one')).toBe(true)
  })

  it('never treats a successful grab acknowledgement alone as an awarded prize', async () => {
    const { actions, request, clock } = setup([packets(packet()), owner(), packetReceipt(), packets(), packetReceipt(0)])
    const first = await actions.run(task(), signal())
    expect(first.message).toContain('等待官方结果')
    clock.now += 5_000
    const result = await actions.run(task(), signal())
    expect(result).toMatchObject({ status: 'scheduled', message: expect.stringContaining('未获得奖励') })
    expect(writeCount(request)).toBe(1)
  })

  it('handles an explicit no-award receipt without retrying the same event', async () => {
    const { actions, request } = setup([packets(packet()), owner(), packetReceipt(0), packets(packet())])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled', message: expect.stringContaining('未抢到') })
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled', message: expect.stringContaining('已处理') })
    expect(writeCount(request)).toBe(1)
  })

  it('waits until the later official countdown/start time instead of firing early', async () => {
    const { actions, request } = setup([packets(packet({ cdtime: '60', startTime: NOW / 1_000 + 90 }))])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + 90_000 })
    expect(request).toHaveBeenCalledTimes(1)
    expect(writeCount(request)).toBe(0)
  })

  it('clamps a short wait to five seconds and an ordinary empty poll to sixty seconds', async () => {
    const { actions } = setup([packets(packet({ cdtime: 1 })), packets()])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + 5_000 })
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + 60_000 })
  })

  it('skips an explicitly expired packet', async () => {
    const { actions, request } = setup([packets(packet({ endTime: NOW / 1_000 - 1 }))])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled' })
    expect(writeCount(request)).toBe(0)
  })

  it.each([2, 3])('does not infer fan eligibility from historic or unbound state for condition %s', async joinc => {
    const { actions, request } = setup([packets(packet({ joinc }))])
    const outcome = await actions.run(task(), signal())
    expect(outcome).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('无法通过已核验的只读接口确认') })
    expect(request).toHaveBeenCalledTimes(1)
    expect(writeCount(request)).toBe(0)
  })

  it.each(['payAmount', 'needGift', 'needBarrage', 'watchRequired', 'conditions'])('stops an event advertising an unsupported %s requirement', async field => {
    const { actions, request } = setup([packets(packet({ [field]: 1 }))])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user' })
    expect(writeCount(request)).toBe(0)
  })

  it('selects at most one eligible event and does not inherit the reference author fan-club gate', async () => {
    const { actions, request } = setup([packets(packet({ joinc: 3, activityid: 54321 }), packet()), owner(), packetReceipt(0)])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled' })
    expect(writeCount(request)).toBe(1)
    expect(request.mock.calls.map(([url]) => String(url)).join(' ')).not.toContain('5189167')
  })

  it('excludes the room anchor from a no-condition packet', async () => {
    const { actions, request } = setup([packets(packet()), owner('42')])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('主播不能') })
    expect(writeCount(request)).toBe(0)
  })

  it.each([owner(0), owner(null), { room: { room_id: 123, owner_uid: 123 } }])('rejects an unconfirmed room-owner preflight', async response => {
    const { actions, request } = setup([packets(packet()), response])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user' })
    expect(writeCount(request)).toBe(0)
  })

  it('does not resubmit after an early or unrecognizable write result', async () => {
    const { actions, request } = setup([packets(packet()), owner(), packetReceipt(2), packets(packet())])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user' })
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('结果不明') })
    expect(writeCount(request)).toBe(1)
  })

  it('accepts official object and JSON-string data without treating arbitrary upstream text as output', async () => {
    const { actions, request } = setup([envelope(JSON.stringify({ list: [packet()] })), owner(), envelope(JSON.stringify({ activityid: 12345, isSuc: 0 }))])
    const result = await actions.run(task(), signal())
    expect(result).toMatchObject({ status: 'scheduled' })
    expectPrivate(result)
    expect(writeCount(request)).toBe(1)
  })
})

describe('official follow eligibility for conditional packets', () => {
  it.each([envelope({ '6979222': 1 }), envelope('{"6979222":"1"}')])('participates when the exact room is explicitly followed by the bound account', async follow => {
    const { actions, request, cookieHeader } = setup([packets(packet({ joinc: 1 })), follow, owner(), packetReceipt(0)])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled', message: expect.stringContaining('未抢到') })
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([packetList, followQuery, roomUrl, packetGrab])
    const [, read] = request.mock.calls[1]!
    expect(read?.method).toBe('GET')
    expect(read?.body).toBeUndefined()
    expect(new Headers(read?.headers).get('cookie')).toBe(cookie)
    expect(cookieHeader.mock.calls.filter(([, url]) => url === followQuery)).toEqual(Array(3).fill(['account-one', followQuery]))
    expect(writeCount(request)).toBe(1)
    expect(request.mock.calls.map(([url]) => String(url)).join(' ')).not.toMatch(/follow\/add|follow\/batchAdd|donate|member\/|message/)
  })

  it('pauses on an explicit not-followed result and can recheck after a deliberate resume', async () => {
    const { actions, request } = setup([packets(packet({ joinc: 1 })), envelope({ '6979222': 0 }), packets(packet({ joinc: 1 })), envelope({ '6979222': 1 }), owner(), packetReceipt(0)])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('尚未关注') })
    expect(writeCount(request)).toBe(0)
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled' })
    expect(writeCount(request)).toBe(1)
  })

  it('prefers an open no-condition packet without making an unnecessary qualification query', async () => {
    const { actions, request } = setup([packets(packet({ joinc: 1, activityid: 555 }), packet()), owner(), packetReceipt(0)])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled' })
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([packetList, roomUrl, packetGrab])
  })

  it('continues waiting for a future no-condition packet when the open followed-only packet is ineligible', async () => {
    const { actions, request } = setup([packets(packet({ joinc: 1, activityid: 555 }), packet({ cdtime: 30 })), envelope({ '6979222': 0 })])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + 30_000 })
    expect(writeCount(request)).toBe(0)
  })

  it('defers qualification reads until the official packet window opens', async () => {
    const { actions, request } = setup([packets(packet({ joinc: 1, cdtime: 30 }))])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + 30_000 })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    {}, { '42': 1 }, { '6979222': 2 }, { '6979222': true }, { '6979222': null },
    { follow: 1 }, { '6979222': { follow: 1 } }, { '6979222': 1, uid: 99 },
  ])('does not guess eligibility from a missing, wrapped or ambiguous room status', async data => {
    const { actions, request } = setup([packets(packet({ joinc: 1 })), envelope(data)])
    const result = await actions.run(task(), signal())
    expect(result).toMatchObject({ status: 'waiting-user' })
    expect(writeCount(request)).toBe(0)
    expect(request).toHaveBeenCalledTimes(2)
    expectPrivate(result)
  })

  it('recognizes the currently observed anonymous login-expired response without leaking its text', async () => {
    const { actions, request } = setup([packets(packet({ joinc: 1 })), { code: -1, error: -1, msg: '用户未登陆或token已过期' }])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('登录信息') })
    expect(writeCount(request)).toBe(0)
  })

  it('rejects a credential switch while reading the account-scoped qualification', async () => {
    let currentCookie = cookie
    const request = vi.fn<typeof fetch>(async url => {
      if (String(url) === packetList) return Response.json(packets(packet({ joinc: 1 })))
      currentCookie = cookie.replace('acf_uid=42', 'acf_uid=43')
      return Response.json(envelope({ '6979222': 1 }))
    })
    const { actions } = setup([], { request, cookieHeader: async () => currentCookie })
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('登录信息') })
    expect(writeCount(request)).toBe(0)
  })

  it('still excludes the room anchor after a positive follow check', async () => {
    const { actions, request } = setup([packets(packet({ joinc: 1 })), envelope({ '6979222': 1 }), owner(42)])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('主播不能') })
    expect(writeCount(request)).toBe(0)
  })

  it('does not submit after the packet expires during the qualification read', async () => {
    let time = NOW
    const request = vi.fn<typeof fetch>(async url => {
      if (String(url) === packetList) return Response.json(packets(packet({ joinc: 1, endTime: NOW / 1_000 + 1 })))
      if (String(url) === followQuery) { time = NOW + 2_000; return Response.json(envelope({ '6979222': 1 })) }
      return Response.json(owner())
    })
    const { actions } = setup([], { request, now: () => time })
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user' })
    expect(writeCount(request)).toBe(0)
  })

  it('observes cancellation during a follow query without dispatching any later request', async () => {
    let finish!: (response: Response) => void
    const request = vi.fn<typeof fetch>(async url => String(url) === packetList ? Response.json(packets(packet({ joinc: 1 }))) : new Promise<Response>(resolve => { finish = resolve }))
    const { actions } = setup([], { request })
    const controller = new AbortController()
    const result = actions.run(task(), controller.signal)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    controller.abort()
    await rejected
    finish(Response.json(envelope({ '6979222': 1 })))
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(2)
    expect(writeCount(request)).toBe(0)
  })
})

describe('ordinary barrage-box protocol', () => {
  it('uses the current JSON endpoint with a real session device and exact CSRF, and checks the prize', async () => {
    const { actions, request } = setup([boxes(box()), boxReceipt()])
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'scheduled', message: expect.stringContaining('奖励回执') })
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([boxPanel, boxGrab])
    const [, post] = request.mock.calls[1]!
    expect(new Headers(post?.headers).get('content-type')).toBe('application/json;charset=utf-8')
    expect(JSON.parse(post?.body as string)).toEqual({ room_id: 6979222, device_id: 'synthetic-device-123', version: 1, gt_version: 'v3', ct_version: '1', packettype: 1, packerid: 98765, ctn: 'synthetic-private-csrf' })
    expect(String(post?.body)).not.toMatch(/token|challenge|geetest_validate|watch|heartbeat|pay|gift/)
  })

  it.each([boxReceipt({ prizeType: 2, propId: 268, propCount: 1 }), boxReceipt({ prizeType: '0' })])('handles a verified prop or no-prize result', async receipt => {
    const { actions, request } = setup([boxes(box()), receipt, boxes(box())])
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'scheduled' })
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'scheduled', message: expect.stringContaining('已处理') })
    expect(writeCount(request)).toBe(1)
  })

  it('waits until five seconds after the authoritative opening time', async () => {
    const { actions, request } = setup([boxes(box({ openTime: NOW / 1_000 + 50 }))])
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + 55_000 })
    expect(writeCount(request)).toBe(0)
  })

  it('does not chase other rooms, carnival activity boxes, or expired ordinary boxes', async () => {
    const { actions, request } = setup([
      envelope({ list: [], otherList: [box()] }),
      boxes({ type: 1, ActivityBox: { roundId: 77, hitRate: 0.1 } }),
      boxes(box({ destroyTime: NOW / 1_000 - 1 })),
    ])
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'scheduled' })
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'waiting-user' })
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'scheduled' })
    expect(writeCount(request)).toBe(0)
  })

  it.each([1020440010, 1020440030])('requires a human for official error %s without a second submit or challenge handling', async error => {
    const { actions, request } = setup([boxes(box()), { error, msg: 'synthetic-private-message', data: { geeData: { challenge: 'synthetic-private-challenge' } } }])
    const result = await actions.run(task('treasure-box'), signal())
    expect(result).toMatchObject({ status: 'waiting-user', message: expect.stringContaining(error === 1020440010 ? '手动完成验证' : '绑定手机号') })
    expect(writeCount(request)).toBe(1)
    expect(request).toHaveBeenCalledTimes(2)
    expectPrivate(result)
  })

  it('allows a deliberate new run after a definite verification refusal, but carries no challenge fields', async () => {
    const { actions, request } = setup([boxes(box()), { error: 1020440010, data: { geeData: { challenge: 'synthetic-challenge' } } }, boxes(box()), boxReceipt()])
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'waiting-user' })
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'scheduled' })
    expect(writeCount(request)).toBe(2)
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => init?.body)).toEqual([request.mock.calls[1]![1]?.body, request.mock.calls[1]![1]?.body])
  })

  it('does not clear an uncertain attempt merely because arbitrary server text mentions validation', async () => {
    const { actions, request } = setup([boxes(box()), { error: 999, msg: 'captcha synthetic-private-message', data: {} }, boxes(box())])
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'waiting-user' })
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('结果不明') })
    expect(writeCount(request)).toBe(1)
  })

  it.each([
    { prizeType: 1 }, { prizeType: 1, silverCount: 0 }, { prizeType: 1, silverCount: -1 },
    { prizeType: 2, propId: 268 }, { prizeType: 2, propId: 268, propCount: 0 },
    { prizeType: 99, silverCount: 10 }, { prizeType: 1, silverCount: 10, packerid: 7 },
    { prizeType: 1, silverCount: 10, room_id: 7 }, { prizeType: 1, silverCount: 10, receiverUid: 7 },
    { prizeType: 1, silverCount: 10, code: -1 }, { prizeType: 1, silverCount: 10, result: 7 },
  ])('does not report success for an incomplete or conflicting prize receipt', async data => {
    const { actions, request } = setup([boxes(box()), envelope(data), boxes(box())])
    const result = await actions.run(task('treasure-box'), signal())
    expect(result).toMatchObject({ status: 'waiting-user' })
    expectPrivate(result)
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'waiting-user' })
    expect(writeCount(request)).toBe(1)
  })
})

describe('bounded parsing, credential scope and uncertain dispatches', () => {
  it.each([
    '', 'acf_uid=42', 'acf_uid=42; acf_auth=abc; acf_uid=43',
    `${cookie}; acf_ccn=second`, `${cookie}; dy_did=second-device`, `${cookie}; bad=cr\r\nlf`,
    cookie.replace('synthetic-private-csrf', '%0a'), cookie.replace('42', '042'),
  ])('refuses ambiguous or invalid credentials before any network activity', async header => {
    const { actions, request } = setup([], { cookieHeader: async () => header })
    const result = await actions.run(task(), signal())
    expect(result).toMatchObject({ status: 'waiting-user' })
    expect(request).not.toHaveBeenCalled()
    expectPrivate(result)
  })

  it.each(['acf_ccn', 'dy_did'])('does not invent a missing %s for a ready box', async field => {
    const header = cookie.split('; ').filter(value => !value.startsWith(`${field}=`)).join('; ')
    const { actions, request } = setup([boxes(box())], { cookieHeader: async () => header })
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'waiting-user' })
    expect(writeCount(request)).toBe(0)
  })

  it.each([2, 3, 4, 5])('detects identity or credential changes at lookup %s before a write', async changeAt => {
    let calls = 0
    const { actions, request } = setup([boxes(box())], { cookieHeader: async () => ++calls >= changeAt ? cookie.replace('acf_uid=42', 'acf_uid=43') : cookie })
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'waiting-user' })
    expect(writeCount(request)).toBe(0)
  })

  it('does not mix the second account into a pending packet result', async () => {
    let current = cookie
    const { actions, request } = setup([packets(packet()), owner(), packetReceipt(), packets(packet())], { cookieHeader: async () => current })
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled' })
    current = cookie.replace('acf_uid=42', 'acf_uid=43')
    const result = await actions.run(task(), signal())
    expect(result).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('登录信息') })
    expect(request.mock.calls.some(([url]) => String(url) === packetResult)).toBe(false)
    expect(writeCount(request)).toBe(1)
  })

  it.each([
    packets(packet({ activityid: '1e3' })), packets(packet({ cdtime: -1 })), packets(packet({ cdtime: 86_401 })),
    packets(packet({ joinc: 8 })), packets(packet({ room_id: '7' })), packets(packet(), packet()),
    { error: 0, data: { list: Array(65).fill(packet()) } }, { error: 0, data: { list: null } },
    { data: { list: [] } }, { error: 0, code: 9, data: { list: [] } },
    new Response('{"error":0,"error":1,"data":{"list":[]}}'),
    envelope('{"list":[],"list":[{}]}'),
    new Response('<!doctype html>synthetic-private-secret'),
  ])('stops malformed preflight responses without an official write', async response => {
    const { actions, request } = setup([response])
    const result = await actions.run(task(), signal())
    expect(result).toMatchObject({ status: 'waiting-user' })
    expect(writeCount(request)).toBe(0)
    expectPrivate(result)
  })

  it('does not follow redirects or expose their URLs and text', async () => {
    const { actions, request } = setup([new Response('synthetic-private-secret', { status: 302, headers: { location: 'https://evil.test/private' } })])
    const result = await actions.run(task(), signal())
    expect(result).toMatchObject({ status: 'waiting-user' })
    expect(request).toHaveBeenCalledTimes(1)
    expectPrivate(result)
  })

  it.each([{ addresses: ['127.0.0.1'] }, { addresses: ['8.8.8.8', '10.0.0.1'] }, { addresses: ['not-an-ip'] }, { addresses: [] }])('refuses unsafe DNS answers before any HTTP request', async ({ addresses }) => {
    const { actions, request } = setup([], { resolve: async () => addresses })
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user' })
    expect(request).not.toHaveBeenCalled()
  })

  it('bounds advertised and streamed bodies and rejects malformed UTF-8', async () => {
    const oversized = new Response('tiny', { headers: { 'content-length': '65537' } })
    const large = new Response(' '.repeat(65_537))
    const utf8 = new Response(new Uint8Array([0xc3, 0x28]))
    const { actions, request } = setup([oversized, large, utf8])
    for (let index = 0; index < 3; index++) expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user' })
    expect(writeCount(request)).toBe(0)
  })

  it('bounds a credential provider which does not observe cancellation', async () => {
    vi.useFakeTimers()
    const { actions, request } = setup([], { cookieHeader: async () => new Promise<string>(() => {}), proxy: { ...resolveConfig({}).proxy, requestTimeoutMs: 40 } })
    const result = actions.run(task(), signal())
    await vi.advanceTimersByTimeAsync(45)
    expect(await result).toMatchObject({ status: 'waiting-user' })
    expect(request).not.toHaveBeenCalled()
  })

  it('stops after a write network failure and never automatically repeats the event', async () => {
    const { actions, request } = setup([boxes(box()), new Error(cookie), boxes(box())])
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'waiting-user' })
    const result = await actions.run(task('treasure-box'), signal())
    expect(result).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('结果不明') })
    expect(writeCount(request)).toBe(1)
    expectPrivate(result)
  })

  it('retains the serial slot until an uncooperative dispatched write actually settles', async () => {
    let finish!: (response: Response) => void
    let dispatched!: () => void
    const ready = new Promise<void>(resolve => { dispatched = resolve })
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method !== 'POST') return Response.json(boxes(box()))
      dispatched()
      return new Promise<Response>(resolve => { finish = resolve })
    })
    const { actions } = setup([], { request })
    const controller = new AbortController()
    let finished = false
    const running = actions.run(task('treasure-box'), controller.signal).finally(() => { finished = true })
    const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' })
    await ready
    controller.abort()
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('尚未结束') })
    expect(writeCount(request)).toBe(1)
    finish(Response.json(boxReceipt()))
    await rejected
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('结果不明') })
    expect(writeCount(request)).toBe(1)
  })

  it('does not write if the user cancels while a preflight is pending', async () => {
    let finish!: (response: Response) => void
    const request = vi.fn<typeof fetch>(async () => new Promise<Response>(resolve => { finish = resolve }))
    const { actions } = setup([], { request })
    const controller = new AbortController()
    const result = actions.run(task(), controller.signal)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    controller.abort()
    await rejected
    finish(Response.json(packets(packet())))
    await Promise.resolve()
    expect(writeCount(request)).toBe(0)
  })

  it('refuses a stale official clock instead of submitting outside the correct event window', async () => {
    const { actions, request } = setup([Response.json(boxes(box()), { headers: { date: new Date(NOW - 600_000).toUTCString() } })])
    expect(await actions.run(task('treasure-box'), signal())).toMatchObject({ status: 'waiting-user' })
    expect(writeCount(request)).toBe(0)
  })
})
