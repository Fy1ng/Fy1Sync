import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import type { DouyuActionDependencies } from './actions'
import { DouyuFishingActions } from './fishingActions'
import type { DouyuTaskDefinition } from './types'

// Synthetic protocol fixtures only. No account data or live activity requests.
const NOW = Date.UTC(2026, 9, 24)
const MAX_WAIT = 24 * 60 * 60 * 1_000
const CONFIG_URL = 'https://webconf.douyucdn.cn/resource/common/activity/actfans_w.json'
const HOME_URL = 'https://www.douyu.com/japi/revenuenc/web/actfans/fishing/homePage?rid=6979222&opt=1'
const CONFIRM_URL = HOME_URL.replace('opt=1', 'opt=0')
const START_URL = 'https://www.douyu.com/japi/revenuenc/web/actfans/fishing/fishing'
const REEL_URL = 'https://www.douyu.com/japi/revenuenc/web/actfans/fishing/reelIn'
const COOKIE = 'acf_uid=42; acf_auth=synthetic-auth; acf_ccn=synthetic%2Fcsrf%2Btoken; XSRF-TOKEN=synthetic-xsrf'
const proxy = resolveConfig({}).proxy
const task: DouyuTaskDefinition = {
  id: 'synthetic-fishing', accountId: 'account-one', room: '6979222', kind: 'auto-fish',
  policy: 'foreground', repeatMinutes: null, createdAt: 0,
}
const signal = () => new AbortController().signal
const home = (state = 0, data: Record<string, unknown> = {}, fishing: Record<string, unknown> = {}) => ({
  error: 0,
  data: {
    timeMs: NOW, myCh: { ctype: 1 }, baits: [{ id: 1, cnt: 100, inUse: 1 }],
    fishing: { stat: state, fishStMs: NOW - 1_000, fishEtMs: state === 2 ? NOW - 1 : NOW + 60_000, ...fishing },
    ...data,
  },
})
const started = (state = 1) => home(state, { timeMs: NOW + 500, baits: [{ id: 1, cnt: 80, inUse: 1 }] }, { fishStMs: NOW, fishEtMs: NOW + 60_000 })
const configData = (bait: Record<string, unknown> = {}, dispatch: Record<string, unknown> = {}) => ({
  callback: 'actfans',
  data: {
    activity_setting: { system_switch: 1 },
    diapatch_setting: { blacklist: [], cate2_blacklist: [], ...dispatch },
    fishingConfig: { baitConfig: { baitList: [{ baitLv: 1, costNum: 20, giftId: 0, giftNum: 0, giftPrice: 0, singleGiftNum: 0, ...bait }] } },
  },
})
const jsonp = (data = configData()) => new Response(`DYConfigCallback(${JSON.stringify(data)})`, { headers: { 'Content-Type': 'application/javascript' } })
const receipt = () => ({ error: 0, data: { fish: { id: 4, wei: 2.5 }, awards: [] } })

function scripted(...responses: unknown[]) {
  let index = 0
  return vi.fn<typeof fetch>(async () => {
    if (index >= responses.length) throw new Error('Unexpected synthetic request with synthetic-secret')
    const response = responses[index++]
    return response instanceof Response ? response : Response.json(response)
  })
}

function setup(overrides: Partial<DouyuActionDependencies & { now: () => number }> = {}) {
  const cookieHeader = vi.fn(async (_accountId: string, _url: string) => COOKIE)
  const request = scripted(home(), jsonp(), { error: 0, data: {} }, started())
  return {
    actions: new DouyuFishingActions({ cookieHeader, proxy, request, resolve: async () => ['8.8.8.8'], now: () => NOW, ...overrides }),
    cookieHeader, request,
  }
}

const writes = (request: ReturnType<typeof scripted>) => request.mock.calls.filter(([, init]) => init?.method === 'POST')
const expectPrivate = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/synthetic|secret|acf_|csrf|evil\.test|doctype/i)
const flush = async () => { for (let count = 0; count < 30; count++) await Promise.resolve() }

afterEach(() => { vi.useRealTimers() })

describe('official free fishing flow', () => {
  it('scopes credentials per endpoint, starts once and confirms the inventory and active state', async () => {
    const { actions, request, cookieHeader } = setup()
    const result = await actions.run(task, signal())
    expect(result).toEqual({ status: 'scheduled', message: '已由官方状态确认开始钓鱼, 等待本轮结束.', nextRunAt: NOW + 61_500 })
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([HOME_URL, CONFIG_URL, START_URL, CONFIRM_URL])
    expect(writes(request)).toHaveLength(1)
    for (const [url, init] of request.mock.calls) {
      expect(init?.redirect).toBe('manual')
      const headers = new Headers(init?.headers)
      expect(headers.get('cookie')).toBe(String(url) === CONFIG_URL ? null : COOKIE)
      expect(String(url)).not.toMatch(/synthetic|acf_/)
    }
    expect(cookieHeader.mock.calls.every(([account, url]) => account === 'account-one' && [HOME_URL, START_URL, CONFIRM_URL].includes(url))).toBe(true)
    const [, init] = writes(request)[0]!
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ ctn: 'synthetic/csrf+token', rid: '6979222', baitId: '1', ver: '1.1' })
    const headers = new Headers(init?.headers)
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(headers.get('origin')).toBe('https://www.douyu.com')
    expect(headers.get('referer')).toBe('https://www.douyu.com/pages/fish-act?rid=6979222')
    expect(headers.get('x-xsrf-token')).toBe('synthetic-xsrf')
    expectPrivate(result)
  })

  it('allows the same official start endpoint to activate an existing free automatic entitlement', async () => {
    const request = scripted(home(), jsonp(), { error: 0, data: {} }, started(20))
    const { actions } = setup({ request })
    expect((await actions.run(task, signal())).status).toBe('scheduled')
    expect(String(writes(request)[0]![0])).toBe(START_URL)
    expect(request.mock.calls.some(([url]) => /autoFishing|giftReelIn|exchange|selectBait|gift/i.test(String(url)))).toBe(false)
  })

  it('reels only an explicitly completed cast and confirms idle before scheduling another turn', async () => {
    const request = scripted(home(2), jsonp(), receipt(), home(0, { timeMs: NOW + 300 }))
    const { actions } = setup({ request })
    expect(await actions.run(task, signal())).toEqual({ status: 'scheduled', message: '已由官方状态确认收杆, 等待下一轮免费钓鱼.', nextRunAt: NOW + 5_000 })
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([HOME_URL, CONFIG_URL, REEL_URL, CONFIRM_URL])
    expect(writes(request)).toHaveLength(1)
    expect(Object.fromEntries(new URLSearchParams(String(writes(request)[0]![1]?.body)))).toEqual({ ctn: 'synthetic/csrf+token', rid: '6979222' })
  })

  it.each([1, 20])('releases the turn for state %s and adjusts waiting with the server clock', async state => {
    const request = scripted(home(state))
    const { actions } = setup({ request, now: () => NOW + MAX_WAIT })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + MAX_WAIT + 62_000 })
    expect(request).toHaveBeenCalledOnce()
    expect(writes(request)).toHaveLength(0)
  })

  it('does not force a reel when the server still says fishing after the deadline', async () => {
    const request = scripted(home(1, {}, { fishEtMs: NOW - 1 }))
    const { actions } = setup({ request })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + 5_000 })
    expect(writes(request)).toHaveLength(0)
  })

  it('clamps long waits to 24 hours and refuses clock overflow', async () => {
    const { actions } = setup({ request: scripted(home(1, {}, { fishEtMs: NOW + MAX_WAIT * 3 })) })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + MAX_WAIT })
    const overflow = setup({ request: scripted(home(1)), now: () => Number.MAX_SAFE_INTEGER }).actions
    expect((await overflow.run(task, signal())).status).toBe('waiting-user')
  })

  it('leaves existing official paid automation alone and stops when its results need attention', async () => {
    const ongoing = setup({ request: scripted(home(10, {}, { autoInfo: { etMs: NOW + 30_000 } })) })
    expect(await ongoing.actions.run(task, signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + 32_000 })
    const completed = setup({ request: scripted(home(10, {}, { autoInfo: { etMs: NOW - 1 } })) })
    expect(await completed.actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('查看结果') })
  })

  it.each([11, 21])('stops when official automatic fishing state %s is waiting for bait', async state => {
    const request = scripted(home(state))
    const { actions } = setup({ request })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('等待鱼饵') })
    expect(writes(request)).toHaveLength(0)
  })

  it('uses a freshly scoped CSRF cookie for the POST without persisting it in the task', async () => {
    const cookieHeader = vi.fn(async (_account: string, url: string) => url === START_URL ? COOKIE.replace('synthetic%2Fcsrf%2Btoken', 'synthetic-post-token') : COOKIE)
    const { actions, request } = setup({ cookieHeader })
    expect((await actions.run(task, signal())).status).toBe('scheduled')
    expect(new URLSearchParams(String(writes(request)[0]![1]?.body)).get('ctn')).toBe('synthetic-post-token')
    expect(Object.keys(task)).not.toContain('ccn')
  })

  it('supports canonical numeric strings from the official numeric conversion path', async () => {
    const first = home(0, { timeMs: String(NOW), myCh: { ctype: '1' }, baits: [{ id: '1', cnt: '100', inUse: '1' }] }, { stat: '0' })
    const request = scripted({ ...first, error: '0' }, jsonp(configData({ baitLv: '1', costNum: '20', giftPrice: '0' })), { error: '0' }, started())
    expect((await setup({ request }).actions.run(task, signal())).status).toBe('scheduled')
  })
})

describe('fishing qualification and free inventory gates', () => {
  it.each([
    [], [{ id: 1, cnt: 19, inUse: 1 }], [{ id: 2, cnt: 100, inUse: 1 }],
    [{ id: 1, cnt: 100, inUse: 0 }], [{ id: 1, cnt: 0, inUse: 1 }],
  ].map(baits => ({ baits })))('does not switch bait, buy or start when selected free inventory is unavailable %#', async ({ baits }) => {
    const request = scripted(home(0, { baits }), jsonp())
    const result = await setup({ request }).actions.run(task, signal())
    expect(result.status).toBe('waiting-user')
    expect(writes(request)).toHaveLength(0)
    expectPrivate(result)
  })

  it.each([null, { ctype: 0 }])('does not create a fishing character for the user %#', async myCh => {
    const request = scripted(home(0, { myCh }))
    expect(await setup({ request }).actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('设置鱼娘形象') })
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([
    { giftId: 42 }, { giftPrice: 0.1 }, { giftNum: 1 }, { singleGiftNum: 1 },
    { costNum: 0 }, { costNum: -1 }, { costNum: 100_001 }, { costNum: '20.0' },
    { giftPrice: undefined }, { baitLv: 2 },
  ])('requires current explicit free configuration before any write %#', async bait => {
    const request = scripted(home(), jsonp(configData(bait)))
    expect((await setup({ request }).actions.run(task, signal())).status).toBe('waiting-user')
    expect(writes(request)).toHaveLength(0)
  })

  it.each([
    { blacklist: [6979222] }, { blacklist: ['6979222'] }, { blacklist: ['invalid'] },
    { cate2_blacklist: [1] }, { cate2_blacklist: null },
  ])('honors current official room restrictions and stops on unverifiable categories %#', async dispatch => {
    const request = scripted(home(), jsonp(configData({}, dispatch)))
    expect(await setup({ request }).actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('资格') })
    expect(writes(request)).toHaveLength(0)
  })

  it('rejects a closed activity, duplicate bait rule and executable JSONP suffix', async () => {
    const closed = configData()
    closed.data.activity_setting.system_switch = 0
    const duplicate = configData()
    duplicate.data.fishingConfig.baitConfig.baitList.push({ ...duplicate.data.fishingConfig.baitConfig.baitList[0]! })
    for (const response of [jsonp(closed), jsonp(duplicate), new Response(`DYConfigCallback(${JSON.stringify(configData())});syntheticSecret()`)] ) {
      const request = scripted(home(), response)
      expect((await setup({ request }).actions.run(task, signal())).status).toBe('waiting-user')
      expect(writes(request)).toHaveLength(0)
    }
  })

  it('uses the current official cost instead of a hard-coded number', async () => {
    const request = scripted(home(), jsonp(configData({ costNum: 30 })), { error: 0 }, home(1, { timeMs: NOW + 500, baits: [{ id: 1, cnt: 70, inUse: 1 }] }, { fishStMs: NOW }))
    expect((await setup({ request }).actions.run(task, signal())).status).toBe('scheduled')
    expect(writes(request)).toHaveLength(1)
  })
})

describe('strict fishing status and receipt verification', () => {
  it.each([
    home(9), home(2, {}, { fishEtMs: NOW + 1 }), home(1, {}, { fishStMs: NOW + 1 }),
    home(1, {}, { fishEtMs: undefined }), home(10, {}, { autoInfo: {} }),
    home(0, { timeMs: undefined }), home(0, { timeMs: false }),
    home(0, { baits: [{ id: 1, cnt: 20, inUse: 1 }, { id: 1, cnt: 20, inUse: 0 }] }),
    home(0, { baits: [{ id: 1, cnt: 20, inUse: 1 }, { id: 2, cnt: 20, inUse: 1 }] }),
    home(0, { baits: [{ id: 1, cnt: -1, inUse: 1 }] }),
    home(0, { baits: [{ id: 1, cnt: 20.1, inUse: 1 }] }),
    home(0, { uid: 43 }), home(0, { roomId: '1' }),
    { ...home(), error: false }, { ...home(), result: 1 },
  ])('stops on malformed or conflicting official state without a write %#', async value => {
    const request = scripted(value)
    const result = await setup({ request }).actions.run(task, signal())
    expect(result.status).toBe('waiting-user')
    expect(writes(request)).toHaveLength(0)
    expectPrivate(result)
  })

  it.each([
    { error: 1002, msg: '用户未登录 synthetic-secret' },
    { error: 1, msg: '需要验证码 synthetic-secret' },
    { error: 1, msg: '等级不足 synthetic-secret' },
  ])('sanitizes official login and eligibility responses %#', async value => {
    const request = scripted(value)
    const result = await setup({ request }).actions.run(task, signal())
    expect(result.status).toBe('waiting-user')
    expectPrivate(result)
    expect(writes(request)).toHaveLength(0)
  })

  it.each([
    null, true, { error: 1, msg: 'synthetic-secret' }, { error: 0, code: 1 },
    { error: 0, data: { uid: 99 } }, { error: 0, data: { rid: '1' } },
  ])('never retries an uncertain start response %#', async value => {
    const request = scripted(home(), jsonp(), value)
    const result = await setup({ request }).actions.run(task, signal())
    expect(result).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('不会自动重试') })
    expect(writes(request)).toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(3)
    expectPrivate(result)
  })

  it.each([
    home(), home(1), home(1, { baits: [{ id: 1, cnt: 100, inUse: 1 }] }, { fishStMs: NOW }),
    home(1, { baits: [{ id: 1, cnt: 79, inUse: 1 }] }, { fishStMs: NOW }),
    home(1, { baits: [{ id: 1, cnt: 80, inUse: 0 }, { id: 2, cnt: 20, inUse: 1 }] }, { fishStMs: NOW }),
    home(1, { uid: 43 }), home(1, { timeMs: NOW - 1 }),
  ])('does not resume after a success-shaped start without matching read-back %#', async after => {
    const request = scripted(home(), jsonp(), { error: 0 }, after)
    expect(await setup({ request }).actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('不会自动重试') })
    expect(writes(request)).toHaveLength(1)
  })

  it.each([
    { error: 0, data: {} }, { error: 0, data: { fish: { id: 0, wei: 1 } } },
    { error: 0, data: { fish: { id: 1, wei: -1 } } },
    { error: 0, data: { fish: { id: 1, wei: 1 }, awards: {} } },
    { error: 0, data: { fish: { id: 1, wei: 1, userId: 99 } } },
  ])('requires a valid reel receipt and never repeats a reel %#', async value => {
    const request = scripted(home(2), jsonp(), value)
    expect((await setup({ request }).actions.run(task, signal())).status).toBe('waiting-user')
    expect(writes(request)).toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('stops if the completed cast is still present after a valid reel receipt', async () => {
    const request = scripted(home(2), jsonp(), receipt(), home(2))
    expect((await setup({ request }).actions.run(task, signal())).status).toBe('waiting-user')
    expect(writes(request)).toHaveLength(1)
  })
})

describe('fishing credentials and bounded transport', () => {
  it.each([
    '', 'acf_uid=42', 'acf_auth=synthetic-auth', `${COOKIE}; acf_uid=43`, `${COOKIE}; acf_auth=other`,
    `${COOKIE}; acf_ccn=other`, `${COOKIE}; acf_uid`, COOKIE.replace('42', '0'),
    COOKIE.replace('synthetic-auth', 'null'), COOKIE.replace('synthetic-auth', '%0A'),
    `${COOKIE}\r\nInjected: synthetic-secret`, `${COOKIE}; bad=non ASCII 值`, `${COOKIE}; pad=${'x'.repeat(32768)}`,
  ])('rejects missing, ambiguous or malformed credentials %#', async header => {
    const { actions, request } = setup({ cookieHeader: async () => header })
    const result = await actions.run(task, signal())
    expect(result.status).toBe('waiting-user')
    expect(request).not.toHaveBeenCalled()
    expectPrivate(result)
  })

  it.each([
    COOKIE.replace('acf_uid=42', 'acf_uid=43'), COOKIE.replace('synthetic-auth', 'synthetic-other-auth'),
    COOKIE.replace('acf_ccn=synthetic%2Fcsrf%2Btoken; ', ''),
  ])('rechecks identity, auth and CSRF immediately before dispatch %#', async postCookie => {
    const { actions, request } = setup({ cookieHeader: async (_account, url) => url === START_URL ? postCookie : COOKIE })
    expect((await actions.run(task, signal())).status).toBe('waiting-user')
    expect(writes(request)).toHaveLength(0)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('stops instead of confirming a write with another account', async () => {
    const { actions, request } = setup({ cookieHeader: async (_account, url) => url === CONFIRM_URL ? COOKIE.replace('42', '43') : COOKIE })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('不会自动重试') })
    expect(writes(request)).toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('captures task identity before asynchronous credential lookup', async () => {
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    const cookieHeader = vi.fn(async (_account: string, _url: string) => { await gate; return COOKIE })
    const { actions, request } = setup({ cookieHeader })
    const mutable = { ...task }
    const pending = actions.run(mutable, signal())
    mutable.accountId = 'other-account'
    mutable.room = '1'
    mutable.kind = 'room-sign'
    release()
    expect((await pending).status).toBe('scheduled')
    expect(cookieHeader.mock.calls.every(([account]) => account === 'account-one')).toBe(true)
    expect(new URLSearchParams(String(writes(request)[0]![1]?.body)).get('rid')).toBe('6979222')
  })

  it.each([['127.0.0.1'], ['10.0.0.1'], ['::1'], ['not-an-ip'], [], ['8.8.8.8', '192.168.1.1']].map(addresses => ({ addresses })))('rejects unsafe DNS answers %#', async ({ addresses }) => {
    const { actions, request } = setup({ resolve: async () => addresses })
    expect((await actions.run(task, signal())).status).toBe('waiting-user')
    expect(request).not.toHaveBeenCalled()
  })

  it.each([301, 302, 307, 401, 403, 429, 500])('never follows redirects or treats HTTP %s as success', async status => {
    const request = scripted(new Response('synthetic-secret', { status, headers: { location: 'https://evil.test/steal' } }))
    const result = await setup({ request }).actions.run(task, signal())
    expect(result.status).toBe('waiting-user')
    expect(request).toHaveBeenCalledOnce()
    expectPrivate(result)
  })

  it('rejects transports that already followed a redirect', async () => {
    const response = Response.json(home())
    Object.defineProperties(response, { redirected: { value: true }, url: { value: 'https://evil.test/secret' } })
    const request = scripted(response)
    expect((await setup({ request }).actions.run(task, signal())).status).toBe('waiting-user')
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([
    () => new Response('{"error":1,"error":0,"data":{}}'),
    () => new Response('{"error":0,"data":{"fish":1,"fish":2}}'),
    () => new Response('<!doctype html>synthetic-secret'),
    () => new Response(new Uint8Array([0xff, 0xfe])),
    () => new Response('x'.repeat(65_537)),
    () => new Response('{}', { headers: { 'content-length': '65537' } }),
    () => new Response('{}', { headers: { 'content-length': 'invalid' } }),
    () => new Response('['.repeat(65) + '0' + ']'.repeat(65)),
  ])('bounds and strictly decodes untrusted response bodies %#', async response => {
    const request = scripted(response())
    const result = await setup({ request }).actions.run(task, signal())
    expect(result.status).toBe('waiting-user')
    expect(request).toHaveBeenCalledOnce()
    expectPrivate(result)
  })

  it('bounds the public configuration separately and never forwards cookies to it', async () => {
    const request = scripted(home(), new Response('x'.repeat(512 * 1_024 + 1)))
    expect((await setup({ request }).actions.run(task, signal())).status).toBe('waiting-user')
    expect(writes(request)).toHaveLength(0)
    expect(new Headers(request.mock.calls[1]![1]?.headers).has('cookie')).toBe(false)
  })

  it('does not dispatch with invalid input or a disabled proxy', async () => {
    const { actions, request } = setup()
    for (const invalid of [{ ...task, room: '1&uid=42' }, { ...task, kind: 'room-sign' as const }, { ...task, accountId: '' }]) {
      expect((await actions.run(invalid, signal())).status).not.toBe('scheduled')
    }
    expect(request).not.toHaveBeenCalled()
    const disabled = setup({ proxy: { ...proxy, enabled: false } })
    expect((await disabled.actions.run(task, signal())).status).toBe('failed')
    expect(disabled.request).not.toHaveBeenCalled()
  })
})

describe('fishing cancellation keeps the serial slot until transport settlement', () => {
  it('honors cancellation before any work', async () => {
    const controller = new AbortController()
    controller.abort()
    const { actions, request, cookieHeader } = setup()
    await expect(actions.run(task, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(request).not.toHaveBeenCalled()
    expect(cookieHeader).not.toHaveBeenCalled()
  })

  it('can cancel an unresolved credential provider without a late dispatch', async () => {
    let release!: (value: string) => void
    const cookieHeader = vi.fn(() => new Promise<string>(done => { release = done }))
    const { actions, request } = setup({ cookieHeader })
    const controller = new AbortController()
    const pending = actions.run(task, controller.signal)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    release(COOKIE)
    await flush()
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'timeout'])('retains the slot while a POST ignores %s, then stops without confirmation or retry', async reason => {
    vi.useFakeTimers()
    let release!: (response: Response) => void
    let startedPost!: () => void
    const posted = new Promise<Response>(done => { release = done })
    const postStarted = new Promise<void>(done => { startedPost = done })
    let calls = 0
    const request = vi.fn<typeof fetch>(async () => {
      calls++
      if (calls === 1) return Response.json(home())
      if (calls === 2) return jsonp()
      if (calls === 3) { startedPost(); return posted }
      throw new Error('Unexpected synthetic request')
    })
    const { actions } = setup({ request, proxy: { ...proxy, requestTimeoutMs: 100 } })
    const controller = new AbortController()
    let settled = false
    const pending = actions.run(task, controller.signal)
    void pending.then(() => { settled = true }, () => { settled = true })
    await postStarted
    expect(calls).toBe(3)
    if (reason === 'cancel') controller.abort()
    else await vi.advanceTimersByTimeAsync(101)
    await flush()
    expect(settled).toBe(false)
    const result = reason === 'cancel' ? expect(pending).rejects.toMatchObject({ name: 'AbortError' }) : expect(pending).resolves.toMatchObject({ status: 'waiting-user', message: expect.stringContaining('不会自动重试') })
    release(Response.json({ error: 0, data: {} }))
    await result
    expect(calls).toBe(3)
    expect(writes(request)).toHaveLength(1)
  })

  it('waits for body cancellation to finish before releasing the turn', async () => {
    let release!: () => void
    let cancelling = false
    const cancellation = new Promise<void>(done => { release = done })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65_537)) },
      cancel() { cancelling = true; return cancellation },
    })
    const request = scripted(new Response(stream))
    const { actions } = setup({ request })
    let settled = false
    const pending = actions.run(task, signal())
    void pending.then(() => { settled = true })
    await flush()
    expect(cancelling).toBe(true)
    expect(settled).toBe(false)
    release()
    expect((await pending).status).toBe('waiting-user')
    expect(request).toHaveBeenCalledOnce()
  })
})
