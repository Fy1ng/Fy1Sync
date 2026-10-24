import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import type { DouyuActionDependencies } from './actions'
import type { DouyuTaskDefinition } from './types'
import { DouyuYubaActions } from './yubaActions'

// Synthetic account data only. These tests never contact or sign into Douyu.
const mainCookie = 'main_private=synthetic-main-secret; acf_uid=42'
const yubaCookie = 'acf_yb_t=synthetic-csrf-secret; yuba_private=synthetic-yuba-secret; acf_uid=42'
const bindUrl = 'https://www.douyu.com/wgapi/yubanc/api/group/getBindGroup?room_id=6979222'
const groupUrl = 'https://yuba.douyu.com/wbapi/web/group/head?group_id=12345'
const signUrl = 'https://yuba.douyu.com/ybapi/topic/sign'
const task: DouyuTaskDefinition = {
  id: 'synthetic-task', accountId: 'account-one', room: '6979222', kind: 'yuba-sign',
  policy: 'foreground', repeatMinutes: null, createdAt: 0,
}
const proxy = resolveConfig({}).proxy
const signal = () => new AbortController().signal
const bind = (data: Record<string, unknown> = {}) => ({ error: 0, data: { group_id: 12345, group_status: 0, ...data } })
const head = (data: Record<string, unknown> = {}) => ({ status_code: 200, data: { group_id: 12345, group_exp: 42, is_signed: 0, is_follow: 1, ...data } })
const receipt = () => ({ status_code: 200, data: { level: 3, levelScore: 44, exp: 20 } })

function scripted(...responses: unknown[]) {
  let index = 0
  return vi.fn<typeof fetch>(async () => {
    if (index >= responses.length) throw new Error('Unexpected synthetic request')
    const next = responses[index++]
    return next instanceof Response ? next : Response.json(next)
  })
}

function setup(overrides: Partial<DouyuActionDependencies> = {}) {
  const cookieHeader = vi.fn(async (_accountId: string, url: string) => new URL(url).hostname === 'www.douyu.com' ? mainCookie : yubaCookie)
  const request = scripted(bind(), head(), receipt(), head({ is_signed: 1 }))
  return {
    actions: new DouyuYubaActions({ cookieHeader, proxy, request, resolve: async () => ['8.8.8.8'], ...overrides }),
    cookieHeader, request,
  }
}

const writeCount = (request: ReturnType<typeof scripted>) => request.mock.calls.filter(([, init]) => init?.method === 'POST').length
const expectPrivate = (outcome: unknown) => expect(JSON.stringify(outcome)).not.toMatch(/synthetic|secret|acf_|main_private|yuba_private|doctype|evil\.test/)

afterEach(() => { vi.useRealTimers() })

describe('Yuba scoped requests and verified outcome', () => {
  it('scopes every credential lookup to its actual endpoint and verifies a single multipart POST', async () => {
    const { actions, request, cookieHeader } = setup()
    const result = await actions.run(task, signal())
    expect(result).toMatchObject({ status: 'succeeded', message: expect.stringContaining('官方状态确认') })
    expect(cookieHeader.mock.calls).toEqual([bindUrl, groupUrl, signUrl, groupUrl].map(url => ['account-one', url]))
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([bindUrl, groupUrl, signUrl, groupUrl])
    expect(writeCount(request)).toBe(1)
    for (const [url, init] of request.mock.calls) {
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('cookie')).toBe(String(url) === bindUrl ? mainCookie : yubaCookie)
      expect(String(url)).not.toMatch(/synthetic|acf_/)
    }
    const [url, init] = request.mock.calls[2]!
    const headers = new Headers(init?.headers)
    expect(headers.get('x-csrf-token')).toBe('synthetic-csrf-secret')
    expect(headers.get('origin')).toBe('https://yuba.douyu.com')
    expect(headers.get('referer')).toBe('https://yuba.douyu.com/discussion/12345/posts')
    expect(headers.has('content-type')).toBe(false)
    expect(init?.body).toBeInstanceOf(FormData)
    const serialized = new Request(String(url), init)
    expect(serialized.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    expect(Object.fromEntries(await serialized.formData())).toEqual({ group_id: '12345', cur_exp: '42' })
    expectPrivate(result)
  })

  it('does not send another check-in when the same group already reports signed', async () => {
    const request = scripted(bind(), head({ is_signed: 7 }))
    const { actions } = setup({ request })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'succeeded', message: expect.stringContaining('今日已签到') })
    expect(request).toHaveBeenCalledTimes(2)
    expect(writeCount(request)).toBe(0)
  })

  it('accepts the documented JSON-string binding and canonical numeric strings', async () => {
    const request = scripted({ error: '0', data: JSON.stringify({ group_status: 0, group_id: '12345' }) }, head({ group_id: '12345', group_exp: '0', is_signed: '0', is_follow: '1' }), receipt(), head({ is_signed: '1' }))
    const { actions } = setup({ request })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'succeeded' })
    expect((request.mock.calls[2]![1]?.body as FormData).get('cur_exp')).toBe('0')
  })

  it('uses fresh Yuba cookies for the POST and confirmation without reusing the main header', async () => {
    let yubaStage = 0
    const cookieHeader = vi.fn(async (_accountId: string, url: string) => url === bindUrl ? mainCookie : `acf_yb_t=synthetic-token-${++yubaStage}; scope=synthetic-yuba-${yubaStage}`)
    const { actions, request } = setup({ cookieHeader })
    expect((await actions.run(task, signal())).status).toBe('succeeded')
    expect(new Headers(request.mock.calls[2]![1]?.headers).get('x-csrf-token')).toBe('synthetic-token-2')
    expect(new Headers(request.mock.calls[3]![1]?.headers).get('cookie')).toContain('synthetic-token-3')
    expect(cookieHeader).toHaveBeenCalledTimes(4)
  })

  it('ignores arbitrary group_url values and constructs only the fixed Yuba host', async () => {
    const request = scripted(bind({ group_url: 'https://evil.test:8443/steal' }), head(), receipt(), head({ is_signed: 1 }))
    const { actions } = setup({ request })
    expect((await actions.run(task, signal())).status).toBe('succeeded')
    expect(request.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['www.douyu.com', 'yuba.douyu.com', 'yuba.douyu.com', 'yuba.douyu.com'])
  })

  it('keeps account, room and kind fixed while asynchronous providers run', async () => {
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    const cookieHeader = vi.fn(async (_accountId: string, url: string) => { await gate; return url === bindUrl ? mainCookie : yubaCookie })
    const { actions, request } = setup({ cookieHeader })
    const mutable = { ...task }
    const running = actions.run(mutable, signal())
    mutable.accountId = 'another-account'
    mutable.room = '1'
    mutable.kind = 'room-sign'
    release()
    expect((await running).status).toBe('succeeded')
    expect(cookieHeader.mock.calls.every(([account]) => account === 'account-one')).toBe(true)
    expect(String(request.mock.calls[0]![0])).toBe(bindUrl)
    expect((request.mock.calls[2]![1]?.body as FormData).get('group_id')).toBe('12345')
  })

  it.each(['', 'acf_uid=42', 'acf_yb_t=', 'acf_yb_t=null', 'acf_yb_t=undefined',
    `${yubaCookie}; acf_yb_t=duplicate`, `${yubaCookie}; acf_yb_t`, 'acf_yb_t=%zz', 'acf_yb_t=bad%0d%0aheader',
    'acf_yb_t=contains space', `${yubaCookie}\r\nInjected: secret`, 'acf_yb_t=非ASCII',
    `acf_yb_t=${'x'.repeat(2049)}`, `${yubaCookie}; oversized=${'x'.repeat(32768)}`,
  ])('rejects missing, duplicate or invalid CSRF cookies before a write %#', async header => {
    const { actions, request } = setup({ cookieHeader: async (_account, url) => url === bindUrl ? mainCookie : header })
    const outcome = await actions.run(task, signal())
    expect(outcome).toEqual({ status: 'waiting-user', message: '请登录鱼吧后再运行签到任务.' })
    expect(request).toHaveBeenCalledOnce()
    expectPrivate(outcome)
  })

  it('decodes the actual safe cookie token instead of synthesizing one', async () => {
    const { actions, request } = setup({ cookieHeader: async (_account, url) => url === bindUrl ? mainCookie : 'acf_yb_t=synthetic%2Dcsrf%2Dsecret' })
    expect((await actions.run(task, signal())).status).toBe('succeeded')
    expect(new Headers(request.mock.calls[2]![1]?.headers).get('x-csrf-token')).toBe('synthetic-csrf-secret')
  })

  it('rechecks CSRF for the POST rather than keeping an earlier token', async () => {
    const { actions, request } = setup({ cookieHeader: async (_account, url) => url === signUrl ? '' : url === bindUrl ? mainCookie : yubaCookie })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('登录鱼吧') })
    expect(request).toHaveBeenCalledTimes(2)
    expect(writeCount(request)).toBe(0)
  })

  it.each([0, 1, 2, 3])('sanitizes credential provider errors at stage %s', async failureStage => {
    let stage = 0
    const { actions, request } = setup({ cookieHeader: async (_account, url) => {
      if (stage++ === failureStage) throw new Error(`synthetic sensitive ${yubaCookie}`)
      return url === bindUrl ? mainCookie : yubaCookie
    } })
    const outcome = await actions.run(task, signal())
    expect(outcome).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('登录鱼吧') })
    expect(request).toHaveBeenCalledTimes(failureStage)
    expect(writeCount(request)).toBe(failureStage === 3 ? 1 : 0)
    expectPrivate(outcome)
  })
})

describe('Yuba group and protocol gates', () => {
  it.each([
    { group_status: 4 }, { group_status: '0' }, { group_status: null }, { group_status: undefined },
    { group_id: 0 }, { group_id: '01' }, { group_id: '1&other=1' }, { group_id: Number.MAX_SAFE_INTEGER + 1 },
  ])('stops when binding is closed, absent or malformed %#', async data => {
    const request = scripted(bind(data))
    const { actions } = setup({ request })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('未发送') })
    expect(request).toHaveBeenCalledOnce()
    expect(writeCount(request)).toBe(0)
  })

  it.each([null, {}, { error: false, data: bind().data }, { error: 0, data: 'invalid JSON synthetic-secret' }])('does not assume an open group from an unknown binding response %#', async binding => {
    const request = scripted(binding)
    const { actions } = setup({ request })
    const outcome = await actions.run(task, signal())
    expect(outcome.status).toBe('waiting-user')
    expect(writeCount(request)).toBe(0)
    expectPrivate(outcome)
  })

  it('does not create a replacement for the observed closed official sample', async () => {
    const request = scripted(bind({ group_id: 5496243, group_status: 4 }))
    const { actions } = setup({ request })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('已关闭') })
    expect(request).toHaveBeenCalledOnce()
  })

  it('refuses a head response for a different group before dispatch', async () => {
    const request = scripted(bind(), head({ group_id: 12346, is_signed: 1 }))
    const { actions } = setup({ request })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('不一致') })
    expect(writeCount(request)).toBe(0)
  })

  it.each([
    { group_exp: -1 }, { group_exp: null }, { group_exp: undefined }, { group_exp: 1.5 },
    { group_exp: '1e3' }, { group_exp: Number.MAX_SAFE_INTEGER + 1 }, { is_signed: true }, { is_signed: -1 },
  ])('requires a reliable experience and signed state %#', async data => {
    const request = scripted(bind(), head(data))
    const { actions } = setup({ request })
    expect((await actions.run(task, signal())).status).toBe('waiting-user')
    expect(request).toHaveBeenCalledTimes(2)
    expect(writeCount(request)).toBe(0)
  })

  it.each([0, 2, null, undefined, false, 'unknown'])('does not implicitly join a group when membership is %s', async following => {
    const request = scripted(bind(), head({ is_follow: following }))
    const { actions } = setup({ request })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('签到可能同时加入') })
    expect(writeCount(request)).toBe(0)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([
    {}, null, [], { error: 0, data: true }, { status_code: '200', data: {} },
    { status_code: 200 }, { status_code: 200, data: [] }, { status_code: 200, data: true },
    { status_code: 200, error: 9, data: {} }, { status_code: 200, data: { group_id: 54321 } },
    { status_code: 200, data: { levelScore: -1 } },
  ])('does not infer success or retry from an unknown or contradictory receipt %#', async value => {
    const request = scripted(bind(), head(), value)
    const { actions } = setup({ request })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('尚无法确认') })
    expect(request).toHaveBeenCalledTimes(3)
    expect(writeCount(request)).toBe(1)
  })

  it('uses readback, not missing level fields, to establish actual success', async () => {
    const request = scripted(bind(), head(), { status_code: 200, data: {} }, head({ is_signed: 1 }))
    const { actions } = setup({ request })
    expect((await actions.run(task, signal())).status).toBe('succeeded')
    expect(request).toHaveBeenCalledTimes(4)
    expect(writeCount(request)).toBe(1)
  })

  it.each([
    head(), head({ group_id: 54321, is_signed: 1 }), head({ is_signed: 1, group_exp: null }),
    { status_code: '200', data: head({ is_signed: 1 }).data },
    { status_code: 3002, message: 'synthetic closed group', data: {} },
  ])('requires an actual valid same-group signed confirmation %#', async confirmation => {
    const request = scripted(bind(), head(), receipt(), confirmation)
    const { actions } = setup({ request })
    const outcome = await actions.run(task, signal())
    expect(outcome).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('尚无法确认') })
    expect(request).toHaveBeenCalledTimes(4)
    expect(writeCount(request)).toBe(1)
    expectPrivate(outcome)
  })

  it.each([
    [{ status_code: 4250 }, '登录鱼吧'], [{ status_code: '4206' }, '登录鱼吧'],
    [{ error: 901 }, '登录鱼吧'], [{ error: '902' }, '登录鱼吧'], [{ error: 1022 }, '登录鱼吧'],
    [{ status_code: 3004 }, '官方验证'], [{ error: '3004' }, '官方验证'],
    [{ error: 9, message: '等级不足 synthetic-secret' }, '资格'],
  ] as const)('classifies official human-action responses before and after dispatch %#', async (value, expected) => {
    for (const beforePost of [true, false]) {
      const request = beforePost ? scripted(bind(), value) : scripted(bind(), head(), value)
      const { actions } = setup({ request })
      const outcome = await actions.run(task, signal())
      expect(outcome).toMatchObject({ status: 'waiting-user', message: expect.stringContaining(expected) })
      expect(writeCount(request)).toBe(beforePost ? 0 : 1)
      expect(request).toHaveBeenCalledTimes(beforePost ? 2 : 3)
      expectPrivate(outcome)
    }
  })

  it('never treats captcha plus a success-shaped payload as signed or submits a challenge', async () => {
    const request = scripted(bind(), head(), { ...receipt(), error: 3004, message: 'captcha synthetic-secret' })
    const { actions } = setup({ request })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('官方验证') })
    expect(request).toHaveBeenCalledTimes(3)
    expect(writeCount(request)).toBe(1)
  })
})

describe('Yuba outbound and body limits', () => {
  it.each(['', '01', '1e3', '1&group_id=1', 'https://evil.test/', '9'.repeat(13)])('requires a canonical room before accessing credentials: %s', async room => {
    const { actions, cookieHeader, request } = setup()
    expect((await actions.run({ ...task, room }, signal())).status).toBe('failed')
    expect(cookieHeader).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses another task kind', async () => {
    const { actions, request } = setup()
    expect((await actions.run({ ...task, kind: 'room-sign' }, signal())).status).toBe('failed')
    expect(request).not.toHaveBeenCalled()
  })

  it.each([{ ...proxy, enabled: false }, { ...proxy, hosts: ['www.douyu.com'] }, { ...proxy, hosts: ['yuba.douyu.com'] }])('honors the outbound allowlist before requesting credentials %#', async policy => {
    const { actions, cookieHeader, request } = setup({ proxy: policy })
    expect((await actions.run(task, signal())).status).toBe('failed')
    expect(cookieHeader).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([0, 1, 2])('rejects private DNS at preflight/request stage %s, even with permissive settings', async privateStage => {
    let stage = 0
    const { actions, request } = setup({
      proxy: { ...proxy, hosts: ['*'], allowNonLoopbackTargets: true, allowNonStandardPorts: true, maxRedirects: 8 },
      resolve: async () => stage++ === privateStage ? ['8.8.8.8', '127.0.0.1'] : ['8.8.8.8'],
    })
    expect(await actions.run(task, signal())).toMatchObject({ status: 'failed', message: expect.stringContaining('未发送') })
    expect(request).toHaveBeenCalledTimes(privateStage)
    expect(writeCount(request)).toBe(0)
  })

  it.each([
    [0, 'https://evil.test/'], [1, 'http://127.0.0.1/'], [2, 'https://evil.test/'],
    [2, 'https://yuba.douyu.com/another'], [2, 'https://yuba.douyu.com:8443/another'], [3, 'https://evil.test/'],
  ] as const)('cleans but never follows a redirect at stage %s to %s', async (stage, location) => {
    const cancel = vi.fn()
    const redirect = new Response(new ReadableStream({ cancel }), { status: 302, headers: { location } })
    const responses: unknown[] = [bind(), head(), receipt(), head({ is_signed: 1 })]
    responses[stage] = redirect
    const request = scripted(...responses)
    const { actions } = setup({ request })
    const outcome = await actions.run(task, signal())
    expect(outcome.status).toBe(stage < 2 ? 'failed' : 'waiting-user')
    expect(request).toHaveBeenCalledTimes(stage + 1)
    expect(writeCount(request)).toBe(stage < 2 ? 0 : 1)
    expect(cancel).toHaveBeenCalledOnce()
    expectPrivate(outcome)
  })

  it.each([401, 429])('cancels HTTP %s bodies without consuming or exposing them', async status => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { status })
    const request = scripted(bind(), head(), response)
    const { actions } = setup({ request })
    const outcome = await actions.run(task, signal())
    expect(outcome).toMatchObject({ status: 'waiting-user', message: expect.stringContaining(status === 401 ? '登录鱼吧' : '频率') })
    expect(cancel).toHaveBeenCalledOnce()
    expect(writeCount(request)).toBe(1)
  })

  it.each([403, 500])('never accepts HTTP %s with a success-shaped body', async status => {
    const request = scripted(bind(), head(), Response.json(receipt(), { status }))
    const { actions } = setup({ request })
    expect((await actions.run(task, signal())).status).toBe('waiting-user')
    expect(request).toHaveBeenCalledTimes(3)
  })

  it.each([0, 1, 2, 3])('bounds and cancels oversized bodies at stage %s with or without length headers', async stage => {
    for (const advertised of [false, true]) {
      const cancel = vi.fn()
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65_537)) }, cancel })
      const response = new Response(stream, { headers: advertised ? { 'content-length': '65537' } : {} })
      const responses: unknown[] = [bind(), head(), receipt(), head({ is_signed: 1 })]
      responses[stage] = response
      const request = scripted(...responses)
      const { actions } = setup({ request })
      expect((await actions.run(task, signal())).status).toBe('waiting-user')
      expect(request).toHaveBeenCalledTimes(stage + 1)
      expect(cancel).toHaveBeenCalledOnce()
      expect(writeCount(request)).toBe(stage < 2 ? 0 : 1)
    }
  })

  it('discards malformed upstream text without exposing it or trying a second write', async () => {
    const request = scripted(bind(), head(), new Response(`<!doctype html>${yubaCookie}`))
    const { actions } = setup({ request })
    const outcome = await actions.run(task, signal())
    expect(outcome.status).toBe('waiting-user')
    expectPrivate(outcome)
    expect(writeCount(request)).toBe(1)
  })
})

describe('Yuba cancellation, total timeout and late responses', () => {
  it('throws AbortError before any provider access when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('synthetic secret'))
    const { actions, cookieHeader, request } = setup()
    await expect(actions.run(task, controller.signal)).rejects.toMatchObject({ name: 'AbortError', message: 'Douyu action cancelled.' })
    expect(cookieHeader).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([0, 2])('bounds stalled credential lookup at stage %s without ever dispatching later', async pendingStage => {
    vi.useFakeTimers()
    let stage = 0
    let release!: (header: string) => void
    const { actions, request } = setup({ proxy: { ...proxy, requestTimeoutMs: 25 }, cookieHeader: async (_account, url) => {
      if (stage++ === pendingStage) return new Promise<string>(done => { release = done })
      return url === bindUrl ? mainCookie : yubaCookie
    } })
    const running = actions.run(task, signal())
    await vi.advanceTimersByTimeAsync(25)
    expect(await running).toMatchObject({ status: 'failed', message: expect.stringContaining('未发送') })
    release(yubaCookie)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(pendingStage)
    expect(writeCount(request)).toBe(0)
  })

  it('does not dispatch a POST after a DNS provider resolves past the total deadline', async () => {
    vi.useFakeTimers()
    let stage = 0
    let release!: (addresses: string[]) => void
    const { actions, request } = setup({ proxy: { ...proxy, requestTimeoutMs: 25 }, resolve: async () => {
      if (stage++ === 2) return new Promise<string[]>(done => { release = done })
      return ['8.8.8.8']
    } })
    const running = actions.run(task, signal())
    await vi.advanceTimersByTimeAsync(25)
    expect(await running).toMatchObject({ status: 'failed', message: expect.stringContaining('未发送') })
    release(['8.8.8.8'])
    await vi.advanceTimersByTimeAsync(1)
    expect(writeCount(request)).toBe(0)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([0, 2, 3])('bounds reads but retains a dispatched write at stage %s until its late transport settles', async pendingStage => {
    vi.useFakeTimers()
    let stage = 0
    let release!: (response: Response) => void
    const responses = [bind(), head(), receipt(), head({ is_signed: 1 })]
    const request = vi.fn<typeof fetch>(async () => {
      const current = stage++
      return current === pendingStage ? new Promise<Response>(done => { release = done }) : Response.json(responses[current])
    })
    const { actions } = setup({ proxy: { ...proxy, requestTimeoutMs: 25 }, request })
    const running = actions.run(task, signal())
    let settled = false
    void running.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(25)
    expect(settled).toBe(pendingStage !== 2)
    expect(request.mock.calls[pendingStage]![1]?.signal?.aborted).toBe(true)
    const cancel = vi.fn()
    release(new Response(new ReadableStream({ cancel })))
    await vi.advanceTimersByTimeAsync(1)
    const outcome = await running
    expect(outcome).toMatchObject({ status: pendingStage === 0 ? 'failed' : 'waiting-user', message: expect.stringContaining(pendingStage === 0 ? '未发送' : '尚无法确认') })
    expect(cancel).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(pendingStage + 1)
    expect(writeCount(request)).toBe(pendingStage === 0 ? 0 : 1)
  })

  it('enforces the 15 second ceiling across a larger configured timeout', async () => {
    vi.useFakeTimers()
    const { actions, request } = setup({ proxy: { ...proxy, requestTimeoutMs: 120_000 }, cookieHeader: () => new Promise(() => {}) })
    const running = actions.run(task, signal())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await running).toMatchObject({ status: 'failed', message: expect.stringContaining('准备超时') })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3])('bounds stalled response bodies at stage %s and cancels them', async pendingStage => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"status_code":200')) }, cancel })
    const responses: unknown[] = [bind(), head(), receipt(), head({ is_signed: 1 })]
    responses[pendingStage] = new Response(body)
    const request = scripted(...responses)
    const { actions } = setup({ proxy: { ...proxy, requestTimeoutMs: 25 }, request })
    const running = actions.run(task, signal())
    await vi.advanceTimersByTimeAsync(25)
    expect(await running).toMatchObject({ status: pendingStage === 1 ? 'failed' : 'waiting-user', message: expect.stringContaining('超时') })
    expect(cancel).toHaveBeenCalledOnce()
    expect(writeCount(request)).toBe(pendingStage === 1 ? 0 : 1)
  })

  it('throws AbortError for an externally cancelled POST and ignores late success', async () => {
    let release!: (response: Response) => void
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST') return new Promise<Response>(done => { release = done })
      return Response.json(String(url) === bindUrl ? bind() : head())
    })
    const { actions } = setup({ request })
    const controller = new AbortController()
    const running = actions.run(task, controller.signal)
    await vi.waitFor(() => expect(writeCount(request)).toBe(1))
    controller.abort(new Error(`synthetic ${yubaCookie}`))
    const assertion = expect(running).rejects.toMatchObject({ name: 'AbortError', message: 'Douyu action cancelled.' })
    const cancel = vi.fn()
    release(new Response(new ReadableStream({ cancel })))
    await assertion
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(request).toHaveBeenCalledTimes(3)
    expect(writeCount(request)).toBe(1)
  })

  it('cancels an in-progress body on external cancellation', async () => {
    const cancel = vi.fn()
    const request = scripted(bind(), head(), new Response(new ReadableStream({ cancel })))
    const { actions } = setup({ request })
    const controller = new AbortController()
    const running = actions.run(task, controller.signal)
    await vi.waitFor(() => expect(writeCount(request)).toBe(1))
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(3)
  })
})
