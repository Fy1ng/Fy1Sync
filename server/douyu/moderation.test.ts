import { afterEach, describe, expect, it, vi } from 'vitest'
import { DouyuModeration, type DouyuModerationDependencies, type DouyuModerationExecutor } from './moderation'
import { resolveConfig } from '../config'

const input = { accountId: 'a', room: '6979222', username: '昵称&目标=一', minutes: 10 }
const header = 'acf_uid=42; acf_auth_wl=fixture-auth'
const signal = () => new AbortController().signal
const proxy = resolveConfig({}).proxy

function fixture(options: { permission?: unknown; receipt?: unknown; overrides?: Partial<DouyuModerationDependencies> } = {}) {
  const cookieHeader = vi.fn(async () => header)
  const request = vi.fn<typeof fetch>(async url => Response.json(String(url).includes('/roomAdmin/getStatus')
    ? options.permission ?? { error: 0, data: { has: 1 } } : options.receipt ?? { msg: '添加成功', error: 0 }))
  const runExclusive = vi.fn<DouyuModerationExecutor>(async (_context, run, currentSignal) => ({ status: 'completed', value: await run(currentSignal) }))
  const moderation = new DouyuModeration({ proxy, cookieHeader, request, resolve: async () => ['8.8.8.8'], runExclusive, ...options.overrides })
  return { moderation, request, cookieHeader, runExclusive }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('permission-checked serial moderation', () => {
  it('checks the official permission endpoint then submits one bounded encoded form in the account lane', async () => {
    const { moderation, request, cookieHeader, runExclusive } = fixture()
    expect(await moderation.mute(input, signal())).toMatchObject({ status: 'succeeded', code: 'receipt-confirmed', submitted: true })
    expect(runExclusive).toHaveBeenCalledOnce()
    expect(runExclusive.mock.calls[0]![0]).toEqual({ accountId: 'a', originRoom: input.room, rooms: [input.room] })
    expect(String(request.mock.calls[0]![0])).toBe('https://www.douyu.com/japi/firepower/apinc/roomAdmin/getStatus?rid=' + input.room)
    expect(String(request.mock.calls[1]![0])).toBe('https://www.douyu.com/room/roomSetting/addMuteUser')
    expect(new URLSearchParams(String(request.mock.calls[1]![1]?.body))).toEqual(new URLSearchParams({
      ban_nickname: input.username, room_id: input.room, ban_time: '10', reason: '7',
    }))
    for (const [, init] of request.mock.calls) expect(init?.redirect).toBe('manual')
    expect(cookieHeader.mock.calls.map(call => call)).toHaveLength(2)
  })

  it.each([
    [{ error: 0, data: { has: 0 } }, 'permission-required'],
    [{ error: 202, data: null }, 'login-required'],
    [{ error: 0, data: { has: true } }, 'unconfirmed'],
    [{ error: 0, data: {} }, 'unconfirmed'],
  ])('does not send a mute when permission is absent or ambiguous %#', async (permission, code) => {
    const { moderation, request } = fixture({ permission })
    expect(await moderation.mute(input, signal())).toMatchObject({ code, submitted: false })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('exposes permission reads without making an account write', async () => {
    const { moderation, request, runExclusive } = fixture()
    expect(await moderation.preflight({ accountId: 'a', room: input.room }, signal())).toMatchObject({ allowed: true, code: 'allowed' })
    expect(runExclusive).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
  })

  it('refuses stale identity or token changes between permission read and write', async () => {
    let reads = 0
    const { moderation, request } = fixture({ overrides: { cookieHeader: async () => ++reads === 1 ? header : header.replace('fixture-auth', 'changed') } })
    expect(await moderation.mute(input, signal())).toMatchObject({ code: 'login-required', submitted: false })
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([{ error: 0 }, { msg: '添加成功', error: 1 }, { error: 0, msg: 'sensitive-upstream-detail' }])('does not promote a generic or conflicting receipt to success %#', async receipt => {
    const { moderation } = fixture({ receipt })
    const result = await moderation.mute(input, signal())
    expect(result).toMatchObject({ status: 'waiting-user', code: 'unconfirmed', submitted: true })
    expect(JSON.stringify(result)).not.toContain('sensitive-upstream-detail')
  })

  it('returns an official verification requirement without attempting to solve or resend it', async () => {
    const { moderation, request } = fixture({ receipt: { error: 391, msg: '请先完成验证码' } })
    expect(await moderation.mute(input, signal())).toMatchObject({ code: 'verification-required', submitted: true })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([{ minutes: 0 }, { minutes: 2 }, { minutes: 9999999 }, { username: 'line\nline' }, { room: '01' }, { accountId: '' }])('rejects invalid targets before a queue or credential call %#', async change => {
    const { moderation, request, runExclusive, cookieHeader } = fixture()
    expect(await moderation.mute({ ...input, ...change }, signal())).toMatchObject({ code: 'invalid-arguments', submitted: false })
    expect(runExclusive).not.toHaveBeenCalled()
    expect(cookieHeader).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('honors a busy account lane instead of calling endpoints directly', async () => {
    const { moderation, request } = fixture({ overrides: { runExclusive: async () => ({ status: 'busy' }) } })
    expect(await moderation.mute(input, signal())).toMatchObject({ code: 'busy', submitted: false })
    expect(request).not.toHaveBeenCalled()
  })

  it('forbids private DNS addresses even under a permissive caller network policy', async () => {
    const { moderation, request } = fixture({ overrides: { proxy: { ...proxy, hosts: ['*'], allowNonLoopbackTargets: true, allowNonStandardPorts: true }, resolve: async () => ['127.0.0.1'] } })
    expect(await moderation.mute(input, signal())).toMatchObject({ code: 'request-failed', submitted: false })
    expect(request).not.toHaveBeenCalled()
  })

  it('holds a dispatched operation until its transport settles after cancellation', async () => {
    let release!: (response: Response) => void
    let started!: () => void
    const reachedPost = new Promise<void>(resolve => { started = resolve })
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'POST') { started(); return new Promise<Response>(resolve => { release = resolve }) }
      return Response.json({ error: 0, data: { has: 1 } })
    })
    const { moderation } = fixture({ overrides: { request } })
    const controller = new AbortController()
    let settled = false
    const pending = moderation.mute(input, controller.signal).finally(() => { settled = true })
    await reachedPost
    controller.abort()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    release(Response.json({ error: 0, msg: '添加成功' }))
    expect(await pending).toMatchObject({ code: 'cancelled', submitted: true })
    expect(request).toHaveBeenCalledTimes(2)
  })
})
