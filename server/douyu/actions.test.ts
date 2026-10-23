import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { DouyuActions, type DouyuActionDependencies } from './actions'
import type { DouyuTaskDefinition } from './types'

// All credentials and responses in this file are synthetic. No live check-in is run.
const cookie = 'acf_uid=42; acf_biz=1; acf_stk=synthetic-session-secret; acf_ct=1800000000; acf_ltkid=7; dy_did=synthetic-device; other=synthetic-private'
const token = '42_1_synthetic-session-secret_1800000000_7'
const endpoint = 'https://apiv2.douyucdn.cn/japi/roomuserlevel/apinc/checkIn?client_sys=android'
const task: DouyuTaskDefinition = {
  id: 'task-one', accountId: 'account-one', room: '6979222', kind: 'room-sign',
  policy: 'foreground', repeatMinutes: null, createdAt: 0,
}
const proxy = resolveConfig({}).proxy
const freshSignal = () => new AbortController().signal

function setup(overrides: Partial<DouyuActionDependencies> = {}) {
  const cookieHeader = vi.fn(async () => cookie)
  const request = vi.fn<typeof fetch>(async () => Response.json({ error: 0, msg: 'success' }))
  const deps = { cookieHeader, proxy, request, resolve: async () => ['8.8.8.8'], ...overrides }
  return { actions: new DouyuActions(deps), cookieHeader, request }
}

afterEach(() => { vi.useRealTimers() })

describe('Douyu room-sign request boundary', () => {
  it('gets only main-site scoped credentials and sends one fixed POST without a Cookie', async () => {
    const { actions, cookieHeader, request } = setup()
    const result = await actions.run(task, freshSignal())
    expect(cookieHeader).toHaveBeenCalledExactlyOnceWith('account-one', 'https://www.douyu.com/')
    expect(request).toHaveBeenCalledOnce()
    const [url, init] = request.mock.calls[0]!
    expect(String(url)).toBe(endpoint)
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('rid=6979222')
    expect(init?.redirect).toBe('manual')
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      accept: 'application/json', aid: 'android1',
      'content-type': 'application/x-www-form-urlencoded', token,
    })
    expect(String(url)).not.toContain(token)
    expect(JSON.stringify(result)).not.toMatch(/synthetic|acf_|1800000000/)
    expect(result).toMatchObject({ status: 'waiting-user' })
  })

  it.each(['acf_uid', 'acf_biz', 'acf_stk', 'acf_ct', 'acf_ltkid'])('requires the actual %s cookie', async name => {
    const incomplete = cookie.split('; ').filter(part => !part.startsWith(`${name}=`)).join('; ')
    const { actions, request } = setup({ cookieHeader: async () => incomplete })
    expect(await actions.run(task, freshSignal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('重新登录') })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    '', `${cookie}; acf_stk=duplicate-secret`, cookie.replace('acf_uid=42', 'acf_uid=0'),
    cookie.replace('synthetic-session-secret', ''), cookie.replace('synthetic-session-secret', 'null'),
    cookie.replace('synthetic-session-secret', 'undefined'), cookie.replace('synthetic-session-secret', '%0d%0aInjected'),
    cookie.replace('synthetic-session-secret', '%zz'), cookie.replace('synthetic-session-secret', 'contains space'),
    `${cookie}\r\nInjected: secret`, `${cookie}; more=${'x'.repeat(32_768)}`,
  ])('rejects missing or ambiguous cookie input %# without dispatching', async value => {
    const { actions, request } = setup({ cookieHeader: async () => value })
    expect(await actions.run(task, freshSignal())).toMatchObject({ status: 'waiting-user' })
    expect(request).not.toHaveBeenCalled()
  })

  it('decodes safe percent-encoded cookie values but never leaks unrelated cookies', async () => {
    const { actions, request } = setup({ cookieHeader: async () => cookie.replace('synthetic-session-secret', 'synthetic%2Dsession%2Dsecret') })
    await actions.run(task, freshSignal())
    const headers = new Headers(request.mock.calls[0]![1]?.headers)
    expect(headers.get('token')).toBe(token)
    expect(headers.has('cookie')).toBe(false)
    expect(headers.has('authorization')).toBe(false)
  })

  it('sanitizes provider errors and asks for login without making a request', async () => {
    const { actions, request } = setup({ cookieHeader: async () => { throw new Error(`sensitive ${cookie}`) } })
    const result = await actions.run(task, freshSignal())
    expect(result.status).toBe('waiting-user')
    expect(JSON.stringify(result)).not.toMatch(/sensitive|synthetic|acf_/)
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps the selected account and room fixed while credentials are being loaded', async () => {
    let release!: (header: string) => void
    const cookieHeader = vi.fn(() => new Promise<string>(done => { release = done }))
    const { actions, request } = setup({ cookieHeader })
    const mutableTask = { ...task }
    const running = actions.run(mutableTask, freshSignal())
    mutableTask.accountId = 'another-account'
    mutableTask.room = '1'
    release(cookie)
    await running
    expect(cookieHeader).toHaveBeenCalledExactlyOnceWith('account-one', 'https://www.douyu.com/')
    expect(request.mock.calls[0]![1]?.body).toBe('rid=6979222')
  })

  it.each(['', '001', '-1', '1e3', '6979222&other=1', 'https://www.douyu.com/6657', '9'.repeat(13)])('requires an already resolved canonical room %s', async room => {
    const { actions, cookieHeader, request } = setup()
    expect(await actions.run({ ...task, room }, freshSignal())).toMatchObject({ status: 'failed' })
    expect(cookieHeader).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses unimplemented task kinds', async () => {
    const { actions, request } = setup()
    expect(await actions.run({ ...task, kind: 'send-message' } as unknown as DouyuTaskDefinition, freshSignal())).toMatchObject({ status: 'failed' })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([{ ...proxy, enabled: false }, { ...proxy, hosts: ['www.douyu.com'] }])('respects an unavailable outbound policy', async policy => {
    const { actions, cookieHeader, request } = setup({ proxy: policy })
    expect(await actions.run(task, freshSignal())).toMatchObject({ status: 'failed' })
    expect(cookieHeader).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps the DNS guard even if a caller provides permissive test proxy settings', async () => {
    const { actions, request } = setup({ proxy: { ...proxy, hosts: ['*'], allowNonLoopbackTargets: true }, resolve: async () => ['127.0.0.1'] })
    expect(await actions.run(task, freshSignal())).toMatchObject({ status: 'failed', message: expect.stringContaining('未发送') })
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['https://www.douyu.com/', 'https://apiv2.douyucdn.cn/another', 'http://127.0.0.1/secret'])('never follows a redirect or forwards the token to %s', async location => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location } }))
    const { actions } = setup({ request })
    expect(await actions.run(task, freshSignal())).toMatchObject({ status: 'waiting-user' })
    expect(request).toHaveBeenCalledOnce()
    expect(String(request.mock.calls[0]![0])).toBe(endpoint)
  })
})

describe('synthetic room-sign response classification', () => {
  // The reference does not inspect its response. These deliberately unverified
  // success-shaped fixtures must NOT become evidence for a production success rule.
  it.each([
    { error: 0, msg: 'success' }, { error: 0, msg: '签到成功' }, { code: 0, data: true },
    { success: true }, { error: 0, data: { is_checkin: 1 } }, {}, null, [],
  ])('does not guess success from an undocumented payload %#', async payload => {
    const request = vi.fn<typeof fetch>(async () => Response.json(payload))
    const { actions } = setup({ request })
    expect(await actions.run(task, freshSignal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('尚无法确认') })
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([
    [{ error: 100, msg: '请先登录 synthetic-secret' }, '重新登录'],
    [{ error: 100, message: 'token expired synthetic-secret' }, '重新登录'],
    [{ error: 100, msg: '请完成安全验证 synthetic-secret' }, '官方验证'],
    [{ error: 100, msg: '粉丝等级不足 synthetic-secret' }, '资格'],
    [{ error: 100, msg: '今日已经签到 synthetic-secret' }, '今日已签到'],
  ])('classifies explicit human-action messages without exposing them %#', async (payload, expected) => {
    const { actions } = setup({ request: async () => Response.json(payload) })
    const result = await actions.run(task, freshSignal())
    expect(result).toMatchObject({ status: 'waiting-user', message: expect.stringContaining(expected) })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })

  it.each([
    [401, 'waiting-user', '重新登录'], [403, 'waiting-user', '验证'],
    [429, 'waiting-user', '频率'], [400, 'failed', '拒绝'], [503, 'waiting-user', '尚无法确认'],
  ] as const)('classifies HTTP %s without exposing the response', async (status, expected, message) => {
    const { actions } = setup({ request: async () => new Response('sensitive upstream body', { status }) })
    const result = await actions.run(task, freshSignal())
    expect(result).toMatchObject({ status: expected, message: expect.stringContaining(message) })
    expect(JSON.stringify(result)).not.toContain('sensitive')
  })

  it('does not surface malformed response bodies or retry an uncertain request', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(`<!doctype html>${cookie}`))
    const { actions } = setup({ request })
    const result = await actions.run(task, freshSignal())
    expect(result.status).toBe('waiting-user')
    expect(JSON.stringify(result)).not.toMatch(/doctype|synthetic|acf_/)
    expect(request).toHaveBeenCalledOnce()
  })

  it('sanitizes request failures and leaves a possibly applied check-in for manual review', async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new Error(`request failed: token=${token}`) })
    const { actions } = setup({ request })
    const result = await actions.run(task, freshSignal())
    expect(result).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('尚无法确认') })
    expect(JSON.stringify(result)).not.toMatch(/synthetic|token=/)
    expect(request).toHaveBeenCalledOnce()
  })
})

describe('bounded response reads and cancellation', () => {
  it.each([false, true])('cancels oversized responses, with content-length = %s', async advertised => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65_537)) }, cancel })
    const { actions } = setup({ request: async () => new Response(stream, { headers: advertised ? { 'content-length': '65537' } : {} }) })
    expect(await actions.run(task, freshSignal())).toMatchObject({ status: 'waiting-user' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects a pre-aborted run without calling the credential provider', async () => {
    const controller = new AbortController()
    controller.abort(new Error(`sensitive ${cookie}`))
    const { actions, cookieHeader, request } = setup()
    await expect(actions.run(task, controller.signal)).rejects.toMatchObject({ name: 'AbortError', message: 'Douyu action cancelled.' })
    expect(cookieHeader).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('does not dispatch when DNS resolves after cancellation', async () => {
    let release!: (addresses: string[]) => void
    const resolve = vi.fn(() => new Promise<string[]>(done => { release = done }))
    const { actions, request } = setup({ resolve })
    const controller = new AbortController()
    const running = actions.run(task, controller.signal)
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
    controller.abort(new Error('sensitive cancellation reason'))
    await expect(running).rejects.toMatchObject({ name: 'AbortError', message: 'Douyu action cancelled.' })
    release(['8.8.8.8'])
    await new Promise<void>(done => setImmediate(done))
    expect(request).not.toHaveBeenCalled()
  })

  it('cancels a pending response body on external abort', async () => {
    const cancel = vi.fn()
    const pulled = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ pull: pulled, cancel })
    const { actions } = setup({ request: async () => new Response(stream) })
    const controller = new AbortController()
    const running = actions.run(task, controller.signal)
    await vi.waitFor(() => expect(pulled).toHaveBeenCalled())
    controller.abort(new Error('sensitive'))
    await expect(running).rejects.toMatchObject({ name: 'AbortError', message: 'Douyu action cancelled.' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('bounds an unresponsive credential provider and never dispatches afterward', async () => {
    vi.useFakeTimers()
    let release!: (header: string) => void
    const { actions, request } = setup({ proxy: { ...proxy, requestTimeoutMs: 25 }, cookieHeader: () => new Promise(done => { release = done }) })
    const running = actions.run(task, freshSignal())
    await vi.advanceTimersByTimeAsync(25)
    expect(await running).toMatchObject({ status: 'failed', message: expect.stringContaining('未发送') })
    release(cookie)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).not.toHaveBeenCalled()
  })

  it('bounds an unresponsive request and discards a late response', async () => {
    vi.useFakeTimers()
    let release!: (response: Response) => void
    const request = vi.fn<typeof fetch>(() => new Promise(done => { release = done }))
    const { actions } = setup({ proxy: { ...proxy, requestTimeoutMs: 25 }, request })
    const running = actions.run(task, freshSignal())
    await vi.advanceTimersByTimeAsync(25)
    expect(await running).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('超时') })
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]![1]?.signal?.aborted).toBe(true)
    const cancel = vi.fn()
    release(new Response(new ReadableStream({ cancel })))
    await vi.advanceTimersByTimeAsync(1)
    expect(cancel).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
  })

  it('bounds a body that never completes and cancels its stream', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"error":0')) }, cancel })
    const { actions } = setup({ proxy: { ...proxy, requestTimeoutMs: 25 }, request: async () => new Response(stream) })
    const running = actions.run(task, freshSignal())
    await vi.advanceTimersByTimeAsync(25)
    expect(await running).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('超时') })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
