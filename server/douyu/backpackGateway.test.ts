import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import type { DouyuActionDependencies } from './actions'
import { DouyuBackpackGateway, DouyuRenewalGatewayError } from './backpackGateway'
import type { DouyuBackpackDonation } from './renewalTypes'

// Synthetic credentials, stock and responses only. No real request is permitted.
const cookie = 'acf_uid=42; acf_auth=fixture-private-auth; acf_username=fixture-user; other=fixture-scoped-cookie'
const badgesUrl = 'https://www.douyu.com/member/cp/getFansBadgeList'
const backpackUrl = 'https://www.douyu.com/japi/prop/backpack/web/v5?rid=6979222'
const donateUrl = 'https://www.douyu.com/japi/prop/donate/mainsite/v5'
const html = '<html><body><div>fixture-private-badge-page</div></body></html>'
const backpack = { list: [{ id: '268', count: 10, name: 'fixture-prop' }] }
const receipt = { error: 0, data: { usedProp: { propType: 1 }, list: [{ id: '268', count: 9 }, { id: '2358', count: 20 }], messages: ['type@=dgb/'] } }
const donation: DouyuBackpackDonation = { accountId: 'account-one', expectedUid: '42', room: '6979222', propId: '268', quantity: 1 }
const proxy = resolveConfig({}).proxy
const signal = () => new AbortController().signal

function setup(overrides: Partial<DouyuActionDependencies> = {}) {
  const cookieHeader = vi.fn(async () => cookie)
  const request = vi.fn<typeof fetch>(async url => {
    if (String(url) === badgesUrl) return new Response(html)
    if (String(url) === backpackUrl) return Response.json({ error: 0, data: backpack })
    if (String(url) === donateUrl) return Response.json(receipt)
    throw new Error('Fixture refuses any other URL')
  })
  const resolve = vi.fn(async () => ['8.8.8.8'])
  return { gateway: new DouyuBackpackGateway({ proxy, cookieHeader, request, resolve, ...overrides }), cookieHeader, request, resolve }
}
async function flush(): Promise<void> { for (let count = 0; count < 100; count++) await Promise.resolve() }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('fixed read endpoints and private return contracts', () => {
  it('reads only the returned badge page with exact URL-scoped account credentials', async () => {
    const { gateway, request, cookieHeader } = setup()
    expect(await gateway.readBadges('account-one', signal())).toEqual({ uid: '42', html })
    expect(request).toHaveBeenCalledOnce()
    expect(String(request.mock.calls[0]![0])).toBe(badgesUrl)
    expect(request.mock.calls[0]![1]?.method).toBe('GET')
    expect(cookieHeader).toHaveBeenCalledTimes(3)
    for (const call of cookieHeader.mock.calls) expect(call).toEqual(['account-one', badgesUrl])
    expect(request.mock.calls[0]![1]?.redirect).toBe('manual')
    expect(new Headers(request.mock.calls[0]![1]?.headers).get('cookie')).toBe(cookie)
    expect(new Headers(request.mock.calls[0]![1]?.headers).get('cache-control')).toBe('no-cache')
    expect(request.mock.calls[0]![1]?.body).toBeUndefined()
  })
  it.each([false, true])('unwraps an explicit backpack success without inventing inventory, string=%s', async stringify => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ error: '0', data: stringify ? JSON.stringify(backpack) : backpack }))
    const { gateway, cookieHeader } = setup({ request })
    expect(await gateway.readBackpack('account-one', '6979222', signal())).toEqual({ uid: '42', payload: backpack })
    expect(request).toHaveBeenCalledOnce()
    expect(String(request.mock.calls[0]![0])).toBe(backpackUrl)
    expect(new Headers(request.mock.calls[0]![1]?.headers).get('cache-control')).toBe('no-cache')
    expect(new Headers(request.mock.calls[0]![1]?.headers).get('pragma')).toBe('no-cache')
    for (const call of cookieHeader.mock.calls) expect(call).toEqual(['account-one', backpackUrl])
  })
  it('passes an unknown inner object to the strict reader unchanged', async () => {
    const { gateway } = setup({ request: async () => Response.json({ error: 0, data: { unusual: true } }) })
    expect(await gateway.readBackpack('account-one', '6979222', signal())).toEqual({ uid: '42', payload: { unusual: true } })
  })
  it.each([
    [{ error: 16 }, 'verification-required'], [{ error: 1, result: 170001 }, 'verification-required'],
    [{ error: 5821 }, 'unavailable'], [{ error: 0, result: 999, data: backpack }, 'unavailable'],
    [{ error: 0, code: 9, data: backpack }, 'unavailable'],
  ] as const)('does not pass rejected or contradictory read results to inventory parsing %#', async (payload, code) => {
    const { gateway } = setup({ request: async () => Response.json(payload) })
    await expect(gateway.readBackpack('account-one', '6979222', signal())).rejects.toMatchObject({ code })
  })
  it.each([
    {}, { msg: 'success', data: [] }, { error: 0 }, { error: 0, data: null },
    { error: 0, data: [] }, { error: 0, data: 'broken-json' }, { error: 0, data: '[]' },
  ])('never turns malformed backpack data into an empty inventory %#', async payload => {
    const { gateway } = setup({ request: async () => Response.json(payload) })
    await expect(gateway.readBackpack('account-one', '6979222', signal())).rejects.toMatchObject({ name: 'DouyuRenewalGatewayError', code: 'invalid-data' })
  })
  it.each([undefined, '', '001', '0', '6979222&other=1', 'https://www.douyu.com/1'])('rejects a noncanonical room %# before reading credentials', async room => {
    const { gateway, request, cookieHeader } = setup()
    await expect(gateway.readBackpack('account-one', room as string, signal())).rejects.toMatchObject({ code: 'invalid-data' })
    expect(request).not.toHaveBeenCalled()
    expect(cookieHeader).not.toHaveBeenCalled()
  })
})

describe('strict credentials and account continuity', () => {
  it.each([
    '', 'acf_auth=fixture-private-auth', 'acf_uid=42', `${cookie}; acf_uid=42`,
    `${cookie}; acf_auth=another`, cookie.replace('acf_uid=42', 'acf_uid=0'), cookie.replace('acf_uid=42', 'acf_uid=042'),
    cookie.replace('fixture-private-auth', 'null'), cookie.replace('fixture-private-auth', 'undefined'),
    cookie.replace('fixture-private-auth', '%0d%0aInjected'), cookie.replace('fixture-private-auth', '%zz'),
    `${cookie}\r\nInjected`, `${cookie}; extra=${'x'.repeat(32_768)}`, `${cookie}; XSRF-TOKEN=`,
    `${cookie}; XSRF-TOKEN=%0a`, `${cookie}; XSRF-TOKEN=a; XSRF-TOKEN=b`,
  ])('rejects malformed or ambiguous credentials %#', async header => {
    const { gateway, request } = setup({ cookieHeader: async () => header })
    await expect(gateway.readBadges('account-one', signal())).rejects.toMatchObject({ code: 'login-required' })
    expect(request).not.toHaveBeenCalled()
  })
  it.each([
    'acf_uid=42; acf_auth_wl=fixture-auth', 'acf_uid=42; acf_dmjwt_token=fixture.jwt.token',
    'acf_uid=42; acf_stk=fixture-stk; acf_ltkid=9; acf_biz=1',
  ])('accepts recognized existing authentication material without inventing more %#', async header => {
    const { gateway } = setup({ cookieHeader: async () => header })
    expect(await gateway.readBadges('account-one', signal())).toEqual({ uid: '42', html })
  })
  it.each([2, 3])('discards a read if account credentials change at check %s', async changeAt => {
    let calls = 0
    const { gateway, request } = setup({ cookieHeader: async () => ++calls >= changeAt ? cookie.replace('fixture-private-auth', 'changed-auth') : cookie })
    await expect(gateway.readBackpack('account-one', '6979222', signal())).rejects.toMatchObject({ code: 'login-required' })
    expect(request).toHaveBeenCalledTimes(changeAt === 2 ? 0 : 1)
  })
  it.each([1, 2, 3])('does not confirm a donation across an expected UID change at check %s', async changeAt => {
    let calls = 0
    const { gateway, request } = setup({ cookieHeader: async () => ++calls >= changeAt ? cookie.replace('acf_uid=42', 'acf_uid=99') : cookie })
    expect(await gateway.donate(donation, signal())).toMatchObject({ status: changeAt === 3 ? 'unknown' : 'not-submitted' })
    expect(request).toHaveBeenCalledTimes(changeAt === 3 ? 1 : 0)
  })
  it('copies an actual valid XSRF cookie, but puts no username or CSRF field into the form', async () => {
    const { gateway, request } = setup({ cookieHeader: async () => `${cookie}; XSRF-TOKEN=fixture%2Ftoken%3D` })
    expect(await gateway.donate(donation, signal())).toHaveProperty("status", 'receipt-received')
    const [url, init] = request.mock.calls[0]!
    expect(new Headers(init?.headers).get('X-XSRF-TOKEN')).toBe('fixture/token=')
    expect(String(url) + String(init?.body)).not.toMatch(/fixture-user|username|csrf|ctn|sign/)
  })
  it('sanitizes provider exceptions and mutated upstream error objects', async () => {
    const { gateway } = setup({ cookieHeader: async () => { throw new Error(cookie) } })
    const error = await gateway.readBadges('account-one', signal()).catch(error => error as Error)
    expect(error).toBeInstanceOf(DouyuRenewalGatewayError)
    expect((error as Error).message).not.toMatch(/fixture|acf_/)
    const upstream = new DouyuRenewalGatewayError('unavailable')
    upstream.message = cookie
    const second = setup({ request: async () => { throw upstream } })
    const sanitized = await second.gateway.readBadges('account-one', signal()).catch(error => error as Error)
    expect((sanitized as Error).message).toBe('暂时无法安全访问斗鱼. 请稍后再试.')
  })
})

describe('one fixed backpack donation and receipt-only success', () => {
  it.each(['268', '2358'])('uses the allowed prop %s, never a purchase endpoint', async propId => {
    const { gateway, request, cookieHeader } = setup()
    const result = await gateway.donate({ ...donation, propId, quantity: 3 }, signal())
    expect(result.status).toBe('receipt-received')
    expect(result.message).toContain('不代表续牌状态已确认')
    expect(request).toHaveBeenCalledOnce()
    const [url, init] = request.mock.calls[0]!
    expect(String(url)).toBe(donateUrl)
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('manual')
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ propId, propCount: '3', roomId: '6979222', bizExt: '{"yzxq":{}}' })
    const headers = new Headers(init?.headers)
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
    expect(headers.get('X-Requested-With')).toBe('XMLHttpRequest')
    expect(headers.get('Origin')).toBe('https://www.douyu.com')
    expect(headers.get('Referer')).toBe('https://www.douyu.com/6979222')
    expect(headers.get('Cookie')).toBe(cookie)
    expect(headers.has('X-XSRF-TOKEN')).toBe(false)
    for (const call of cookieHeader.mock.calls) expect(call).toEqual(['account-one', donateUrl])
    expect(JSON.stringify(result)).not.toMatch(/fixture|acf_|messages|usedProp/)
  })
  it.each([
    { propId: '1' }, { propId: '0268' }, { propId: '../gift' }, { expectedUid: '0' },
    { quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: 1_001 }, { quantity: Infinity },
    { room: '001' }, { room: '6979222?buy=1' }, { accountId: 'account one' },
  ])('rejects invalid donation scope before network access %#', async change => {
    const { gateway, request, cookieHeader } = setup()
    expect(await gateway.donate({ ...donation, ...change }, signal())).toHaveProperty("status", 'not-submitted')
    expect(request).not.toHaveBeenCalled()
    expect(cookieHeader).not.toHaveBeenCalled()
  })
  it('binds mutable input fields before awaiting credentials', async () => {
    let release!: (value: string) => void
    let calls = 0
    const { gateway, request } = setup({ cookieHeader: () => ++calls === 1 ? new Promise<string>(done => { release = done }) : Promise.resolve(cookie) })
    const mutable = { ...donation }
    const pending = gateway.donate(mutable, signal())
    mutable.room = '1'
    mutable.accountId = 'another-account'
    mutable.quantity = 1000
    release(cookie)
    expect(await pending).toHaveProperty("status", 'receipt-received')
    expect(new URLSearchParams(String(request.mock.calls[0]![1]?.body)).get('roomId')).toBe('6979222')
    expect(new URLSearchParams(String(request.mock.calls[0]![1]?.body)).get('propCount')).toBe('1')
  })
  it.each([false, true])('accepts confirmed structure without inventing required identifier fields, string=%s', async encoded => {
    const data = { usedProp: {}, list: [], messages: ['https://evil.example/do-not-fetch-or-execute'] }
    const request = vi.fn<typeof fetch>(async () => Response.json({ error: 0, data: encoded ? JSON.stringify(data) : data }))
    const { gateway } = setup({ request })
    expect(await gateway.donate(donation, signal())).toHaveProperty("status", 'receipt-received')
    // The one response URL is never followed, interpreted as code or retransmitted.
    expect(request).toHaveBeenCalledOnce()
    expect(String(request.mock.calls[0]![0])).toBe(donateUrl)
  })
  it.each([
    {}, { msg: 'success' }, { success: true, data: receipt.data }, { error: 0 },
    { error: 0, data: {} }, { error: 0, data: [] }, { error: 0, data: null },
    { error: 0, data: { usedProp: [], list: [] } }, { error: 0, data: { usedProp: {} } },
    { error: 0, data: { usedProp: {}, list: {}, messages: [] } },
    { error: 0, data: { usedProp: {}, list: [], messages: 'not-a-message-array' } },
    { error: 0, result: 999, data: receipt.data }, { error: 0, code: 9, data: receipt.data },
  ])('does not invent a receipt from unconfirmed success-shaped data %#', async payload => {
    const request = vi.fn<typeof fetch>(async () => Response.json(payload))
    const { gateway } = setup({ request })
    expect(await gateway.donate(donation, signal())).toHaveProperty("status", 'unknown')
    expect(request).toHaveBeenCalledOnce()
  })
  it.each([
    [{ error: 16, msg: cookie }, '绑定手机号'], [{ error: 5821, msg: cookie }, '账号异常'],
    [{ error: 1, result: 170001, msg: cookie }, '官方账号验证'],
    [{ error: 0, result: 170001, data: receipt.data }, '官方账号验证'],
    [{ error: 9, msg: cookie }, '尚无法确认'],
  ] as const)('stops on prop-specific errors without copying upstream text %#', async (payload, expected) => {
    const request = vi.fn<typeof fetch>(async () => Response.json(payload))
    const { gateway } = setup({ request })
    const result = await gateway.donate(donation, signal())
    expect(result.status).toBe('unknown')
    expect(result.message).toContain(expected)
    expect(result.message).not.toMatch(/fixture|acf_/)
    expect(request).toHaveBeenCalledOnce()
  })
  it.each<Record<string, unknown>>([
    { id: '2358' }, { propId: '2358' }, { pid: '2358' }, { propCount: 2 }, { quantity: 2 },
    { count: 2 }, { num: 2 }, { roomId: '1' }, { rid: '1' }, { uid: '99' }, { userId: 99 },
  ])('rejects conflicting optional receipt bindings %#', async conflict => {
    for (const where of ['outer', 'data', 'usedProp']) {
      const data = { ...receipt.data, ...(where === 'data' ? conflict : {}), usedProp: { propType: 1, ...(where === 'usedProp' ? conflict : {}) } }
      const payload = { error: 0, ...(where === 'outer' ? conflict : {}), data }
      const { gateway } = setup({ request: async () => Response.json(payload) })
      expect(await gateway.donate(donation, signal())).toHaveProperty("status", 'unknown')
    }
  })
  it('matches present bindings while leaving unrelated inventory IDs and remaining counts alone', async () => {
    const data = { ...receipt.data, uid: 42, roomId: '6979222', usedProp: { id: 268, quantity: 1 } }
    const { gateway } = setup({ request: async () => Response.json({ error: 0, data }) })
    expect(await gateway.donate(donation, signal())).toHaveProperty("status", 'receipt-received')
  })
  it.each([
    '{"error":16,"error":0,"data":{"usedProp":{},"list":[]}}',
    '{"error":0,"data":{"usedProp":{"id":"2358","id":"268"},"list":[]}}',
    '{"error":0,"data":{"usedProp":{"uid":"99","\\u0075id":"42"},"list":[]}}',
    JSON.stringify({ error: 0, data: '{"usedProp":{"id":"2358","id":"268"},"list":[]}' }),
  ])('refuses duplicate status or binding fields rather than taking the last value %#', async body => {
    const { gateway } = setup({ request: async () => new Response(body) })
    expect(await gateway.donate(donation, signal())).toHaveProperty("status", 'unknown')
  })
})

describe('network isolation, bounded bodies and cancellation', () => {
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:7f00:1', 'not-an-ip'])('keeps DNS/IP guards with permissive caller settings: %s', async address => {
    const { gateway, request } = setup({ proxy: { ...proxy, hosts: ['*'], allowNonStandardPorts: true, allowNonLoopbackTargets: true, maxRedirects: 9 }, resolve: async () => [address] })
    await expect(gateway.readBadges('account-one', signal())).rejects.toMatchObject({ code: 'unavailable' })
    expect(await gateway.donate(donation, signal())).toHaveProperty("status", 'not-submitted')
    expect(request).not.toHaveBeenCalled()
  })
  it.each([401, 302])('reports login for badge HTTP %s and follows no other page', async status => {
    const request = vi.fn<typeof fetch>(async () => new Response('private-response', { status, headers: { location: 'https://passport.douyu.com/login' } }))
    const { gateway } = setup({ request })
    await expect(gateway.readBadges('account-one', signal())).rejects.toMatchObject({ code: 'login-required' })
    expect(request).toHaveBeenCalledOnce()
  })
  it.each(['https://www.douyu.com/another', 'https://evil.example/', 'http://127.0.0.1/private'])('does not follow a donation redirect or forward credentials to %s', async location => {
    const cancel = vi.fn()
    const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), { status: 302, headers: { location } }))
    const { gateway } = setup({ request })
    expect(await gateway.donate(donation, signal())).toHaveProperty("status", 'unknown')
    expect(request).toHaveBeenCalledOnce()
    expect(String(request.mock.calls[0]![0])).toBe(donateUrl)
    expect(cancel).toHaveBeenCalledOnce()
  })
  it.each(['url', 'redirected'])('rejects an unexpected response %s', async field => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }))
    Object.defineProperty(response, field, { value: field === 'url' ? 'https://evil.example/private' : true })
    const { gateway } = setup({ request: async () => response })
    await expect(gateway.readBadges('account-one', signal())).rejects.toMatchObject({ code: 'unavailable' })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('accepts exactly 512KiB of badge HTML and does not fetch extra pages', async () => {
    const full = 'x'.repeat(512 * 1_024)
    const request = vi.fn<typeof fetch>(async () => new Response(full))
    const { gateway } = setup({ request })
    expect((await gateway.readBadges('account-one', signal())).html.length).toBe(full.length)
    expect(request).toHaveBeenCalledOnce()
  })
  it.each([false, true])('cancels a response beyond the actual/advertised body bound: %s', async advertised => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(512 * 1_024 + 1)) }, cancel })
    const { gateway } = setup({ request: async () => new Response(stream, { headers: advertised ? { 'content-length': String(512 * 1_024 + 1) } : {} }) })
    await expect(gateway.readBackpack('account-one', '6979222', signal())).rejects.toMatchObject({ code: 'invalid-data' })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('does not parse malformed UTF-8 as partial private data', async () => {
    const { gateway } = setup({ request: async () => new Response(new Uint8Array([0xff])) })
    await expect(gateway.readBadges('account-one', signal())).rejects.toMatchObject({ code: 'invalid-data' })
  })
  it('keeps reads abortable while a pre-aborted donation is explicitly not submitted', async () => {
    const controller = new AbortController()
    controller.abort(new Error(cookie))
    const { gateway, cookieHeader, request } = setup()
    await expect(gateway.readBadges('account-one', controller.signal)).rejects.toMatchObject({ name: 'AbortError', message: 'Douyu action cancelled.' })
    expect(await gateway.donate(donation, controller.signal)).toHaveProperty("status", 'not-submitted')
    expect(cookieHeader).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  it('bounds a stuck credential provider at 15s even if configuration asks for more', async () => {
    vi.useFakeTimers()
    let release!: (value: string) => void
    const { gateway, request } = setup({ proxy: { ...proxy, requestTimeoutMs: 999_999 }, cookieHeader: () => new Promise<string>(done => { release = done }) })
    const pending = gateway.readBadges('account-one', signal()).catch(error => error as Error)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toMatchObject({ code: 'unavailable' })
    release(cookie)
    await flush()
    expect(request).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not submit after DNS completes following cancellation', async () => {
    let release!: (value: string[]) => void
    const { gateway, request } = setup({ resolve: () => new Promise<string[]>(done => { release = done }) })
    const controller = new AbortController()
    const pending = gateway.donate(donation, controller.signal)
    await flush()
    controller.abort()
    expect(await pending).toHaveProperty("status", 'not-submitted')
    release(['8.8.8.8'])
    await flush()
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['timeout', 'cancel'])('never accepts a late donation response after %s', async mode => {
    vi.useFakeTimers()
    let release!: (value: Response) => void
    const request = vi.fn<typeof fetch>(() => new Promise<Response>(done => { release = done }))
    const { gateway } = setup({ request, proxy: { ...proxy, requestTimeoutMs: 25 } })
    const controller = new AbortController()
    const pending = gateway.donate(donation, controller.signal)
    await flush()
    expect(request).toHaveBeenCalledOnce()
    if (mode === 'cancel') controller.abort(new Error(cookie))
    else await vi.advanceTimersByTimeAsync(25)
    const result = await pending
    expect(result.status).toBe('unknown')
    expect(result.message).not.toMatch(/fixture|acf_/)
    const cancel = vi.fn()
    release(new Response(new ReadableStream({ cancel })))
    await flush()
    expect(cancel).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['read', 'donate'])('cancels a hanging response body for %s', async method => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"error":0')) }, cancel })
    const { gateway } = setup({ request: async () => new Response(stream), proxy: { ...proxy, requestTimeoutMs: 25 } })
    const pending = method === 'read'
      ? gateway.readBackpack('account-one', '6979222', signal()).catch(error => error as Error)
      : gateway.donate(donation, signal())
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toMatchObject(method === 'read' ? { code: 'unavailable' } : { status: 'unknown' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
