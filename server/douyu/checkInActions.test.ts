import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { DouyuCheckInActions } from './checkInActions'
import type { DouyuAutomationDependencies, DouyuAutomationRequest } from './automationTypes'

// All sessions and responses below are local synthetic fixtures.
const NOW = Date.UTC(2026, 9, 25, 4)
const COOKIE = 'acf_uid=42; acf_auth=fixture-auth; acf_biz=1; acf_stk=fixture-stk; acf_ct=1; acf_ltkid=fixture-ltk; acf_ccn=fixture-csrf; acf_yb_t=fixture-yuba'
const signal = () => new AbortController().signal
const ok = (data: unknown) => ({ error: 0, data })
const task = (patch: Partial<DouyuAutomationRequest> = {}): DouyuAutomationRequest => ({ taskId: 'check-1', accountId: 'account-1',
  kind: 'client-sign', target: { type: 'account' }, options: {}, ...patch })
const yuba = (patch: Partial<DouyuAutomationRequest> = {}): DouyuAutomationRequest => task({ kind: 'yuba-sign-all', target: { type: 'group', groupId: '99' }, ...patch })
const head = (id: string, signed = 0) => ok({ group_id: id, is_signed: signed, group_exp: 100, is_follow: 1 })
const directory = (groups: string[], pages = 1) => ok({ count_page: pages, list: groups.map(group_id => ({ group_id })) })
const arenaConfig = (alias = 'actqzs202610', id = '2439') => new Response(`DYConfigCallback(${JSON.stringify({ data: {
  activity_setting: { activity_alias_name: alias, activity_id: id, activity_start_time: NOW / 1000 - 3600, activity_end_time: NOW / 1000 + 3600 },
} })})`)

function setup(responses: unknown[], overrides: Partial<DouyuAutomationDependencies> = {}) {
  const queue = [...responses]
  const request = vi.fn<typeof fetch>(async () => {
    if (!queue.length) throw new Error('Unexpected fixture request')
    const value = queue.shift()
    if (value instanceof Error) throw value
    return value instanceof Response ? value : Response.json(value)
  })
  const cookieHeader = vi.fn(async (_id: string, _url: string) => COOKIE)
  const deps: DouyuAutomationDependencies = { proxy: resolveConfig({}).proxy, cookieHeader, request, resolve: async () => ['8.8.8.8'], now: () => NOW, ...overrides }
  return { actions: new DouyuCheckInActions(deps), request, cookieHeader, queue }
}
const posts = (request: ReturnType<typeof setup>['request']) => request.mock.calls.filter(([, init]) => init?.method === 'POST')
afterEach(() => vi.useRealTimers())

describe('bounded check-in batches', () => {
  it('checks all-page coverage before signing one followed room per turn', async () => {
    const readFollowedRooms = vi.fn(async (accountId: string) => ({ accountId, checkedAt: NOW, coverage: 'all-pages' as const,
      pageCount: 2, reason: null, rooms: ['123', '456'].map(room => ({ room, roomName: '', nickname: '', live: null, replay: null, startedAt: null, popularity: null, url: `https://www.douyu.com/${room}` })) }))
    const { actions, request } = setup([ok({ rid: '123', is_checked: 1 }), ok({ rid: '456', is_checked: 1 })], { readFollowedRooms })
    const input = task({ kind: 'followed-room-sign', target: { type: 'batch', source: 'followed-rooms' } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + 5000, progress: { completed: 1, total: 2 } })
    expect(posts(request)).toHaveLength(1)
    expect(await actions.run(input, signal())).toMatchObject({ status: 'succeeded', progress: { completed: 2, total: 2, evidence: 'official-state' } })
    expect(readFollowedRooms).toHaveBeenCalledTimes(1)
    expect(posts(request).map(([, init]) => new URLSearchParams(init?.body as string).get('rid'))).toEqual(['123', '456'])
    expect(new Headers(posts(request)[0]![1]?.headers).get('token')).toBe('42_1_fixture-stk_1_fixture-ltk')
  })

  it.each([
    { coverage: 'partial' }, { accountId: 'another-account' }, { checkedAt: NOW - 60001 }, { pageCount: 101 },
    { pageCount: 0, rooms: [{ room: '123' }] }, { rooms: [{ room: '123' }, { room: '123' }] },
  ])('refuses incomplete, stale or cross-account batch metadata %#', async patch => {
    const readFollowedRooms = vi.fn(async () => ({ accountId: 'account-1', checkedAt: NOW, coverage: 'all-pages', pageCount: 1, rooms: [], reason: null, ...patch }))
    const { actions, request } = setup([], { readFollowedRooms: readFollowedRooms as DouyuAutomationDependencies['readFollowedRooms'] })
    expect((await actions.run(task({ kind: 'followed-room-sign', target: { type: 'batch', source: 'followed-rooms' } }), signal())).status).not.toBe('succeeded')
    expect(request).not.toHaveBeenCalled()
  })

  it('enumerates every fish-bar page before the first ordinary sign', async () => {
    const { actions, request } = setup([directory(['99'], 2), directory(['100'], 2), head('99'), ok({ group_id: '99' }), head('99', 1), head('100', 1)])
    const input = yuba({ target: { type: 'batch', source: 'followed-yuba' } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'scheduled', progress: { total: 2, completed: 1 } })
    expect(request.mock.calls.slice(0, 2).map(([url]) => new URL(String(url)).searchParams.get('page'))).toEqual(['1', '2'])
    expect(await actions.run(input, signal())).toMatchObject({ status: 'succeeded', progress: { completed: 2, skipped: 1 } })
    expect(posts(request)).toHaveLength(1)
  })

  it.each([
    [directory(['99'], 101)],
    [directory(['99'], 2), directory(['100'], 3)],
    [directory(['99'], 2), directory(['99'], 2)],
    [directory(['99'], 2), directory([], 2)],
    [directory(['99'], 0)],
  ])('does not start an all-fish-bar write with unproven pagination %#', async (...responses) => {
    const { actions, request } = setup(responses)
    expect((await actions.run(yuba({ target: { type: 'batch', source: 'followed-yuba' } }), signal())).status).not.toBe('succeeded')
    expect(posts(request)).toHaveLength(0)
  })

  it('confirms fast sign and normally signs the remaining unsigned followed group', async () => {
    const { actions, request } = setup([directory(['99', '100']), { status_code: 200, data: 20 }, head('99', 1), head('100'), ok({}), head('100', 1)])
    const input = yuba({ target: { type: 'batch', source: 'followed-yuba' }, options: { yubaMode: 'fast' } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'scheduled', progress: { completed: 0 } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'scheduled', progress: { completed: 1, skipped: 1 } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'succeeded', progress: { completed: 2 } })
    expect(posts(request).map(([url]) => new URL(String(url)).pathname)).toEqual(['/wb/v3/fastSign', '/ybapi/topic/sign'])
  })

  it('uses only the explicitly permitted number of already-owned supplement cards', async () => {
    const { actions, request } = setup([head('99'), ok({ supplementary_cards: 3 }), ok({ group_id: '99' }), ok({ supplementary_cards: 2 })])
    const input = yuba({ options: { yubaMode: 'supplement', maxSupplementCards: 1 } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'succeeded', progress: { evidence: 'official-state' } })
    expect(posts(request)).toHaveLength(1)
    expect(request.mock.calls.every(([url]) => !/buy|purchase|gift|exchange/.test(String(url)))).toBe(true)
    expect(await actions.run(input, signal())).toMatchObject({ status: 'succeeded' })
    expect(posts(request)).toHaveLength(1)
  })

  it('does not consume another card after an unknown supplement, even if the count decreased', async () => {
    const { actions, request } = setup([head('99'), ok({ supplementary_cards: 3 }), new Error('lost receipt'), head('99'), ok({ supplementary_cards: 2 })])
    const input = yuba({ options: { yubaMode: 'supplement', maxSupplementCards: 3 } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'waiting-user' })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('不会自动重发') })
    expect(posts(request)).toHaveLength(1)
  })

  it('keeps arena identities separate and uses the current official configuration', async () => {
    const { actions, request } = setup([arenaConfig(), ok({ rid: '123', awards: [{ name: 'Fixture reward', num: 1 }] }),
      arenaConfig('cardArena202610', '2440'), ok({ rid: '123', awards: [] })])
    expect(await actions.run(task({ kind: 'arena-sign', target: { type: 'room', room: '123' }, options: { arena: 'actqzs' } }), signal())).toMatchObject({ status: 'succeeded' })
    expect(await actions.run(task({ taskId: 'check-2', kind: 'arena-sign', target: { type: 'room', room: '123' }, options: { arena: 'cardArena' } }), signal())).toMatchObject({ status: 'succeeded' })
    expect(posts(request).map(([, init]) => new URLSearchParams(init?.body as string).get('activity_id'))).toEqual(['2439', '2440'])
    expect(request.mock.calls.filter(([url]) => String(url).includes('webconf')).every(([, init]) => !new Headers(init?.headers).has('cookie'))).toBe(true)
  })

  it.each(['fans-home-sign', 'diamond-fans-sign'] as const)('does not claim %s success from an empty generic acknowledgement', async kind => {
    const { actions, request } = setup([ok({})])
    const input = task({ kind, target: { type: 'room', room: '123' } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'waiting-user', progress: { evidence: 'unconfirmed' } })
    actions.forget(input.taskId)
    expect(await actions.run(input, signal())).toMatchObject({ status: 'waiting-user' })
    expect(posts(request)).toHaveLength(1)
  })

  it('requires the room sign response to identify an explicit signed state', async () => {
    const { actions, request } = setup([ok({})], { readFollowedRooms: async accountId => ({ accountId, checkedAt: NOW, coverage: 'all-pages', pageCount: 1, reason: null,
      rooms: [{ room: '123', roomName: '', nickname: '', live: null, replay: null, startedAt: null, popularity: null, url: 'https://www.douyu.com/123' }] }) })
    const input = task({ kind: 'followed-room-sign', target: { type: 'batch', source: 'followed-rooms' } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'waiting-user' })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'waiting-user' })
    expect(posts(request)).toHaveLength(1)
  })

  it('allows a fresh explicit resume only after a definite write refusal', async () => {
    const { actions, request } = setup([{ error: 1020440010, data: {} }, ok({ sign_pl: [] })])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user', progress: { evidence: 'none' } })
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'succeeded' })
    expect(posts(request)).toHaveLength(2)
  })

  it('does not erase a submitted sign when only its confirmation read requires verification', async () => {
    const { actions, request } = setup([head('99'), ok({}), { error: 1020440010, data: {} }, head('99')])
    expect(await actions.run(yuba(), signal())).toMatchObject({ status: 'waiting-user', progress: { evidence: 'unconfirmed' } })
    expect(await actions.run(yuba(), signal())).toMatchObject({ status: 'waiting-user' })
    expect(posts(request)).toHaveLength(1)
  })

  it('does not accept a client receipt for another recipient account', async () => {
    const { actions, request } = setup([ok({ uid: '99', sign_pl: [] })])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user', progress: { evidence: 'unconfirmed' } })
    expect(posts(request)).toHaveLength(1)
  })

  it('binds a resumed batch to the same account and token material', async () => {
    let cookie = COOKIE
    const { actions, request } = setup([directory(['99', '100']), head('99', 1)], { cookieHeader: async () => cookie })
    const input = yuba({ target: { type: 'batch', source: 'followed-yuba' } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'scheduled' })
    cookie = COOKIE.replace('acf_ct=1', 'acf_ct=2')
    expect(await actions.run(input, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('登录') })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a successful client sign between different accounts', async () => {
    const { actions, request, cookieHeader } = setup([ok({ sign_pl: [] }), ok({ sign_pl: [] })])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'succeeded' })
    expect(await actions.run(task({ taskId: 'check-2', accountId: 'account-2' }), signal())).toMatchObject({ status: 'succeeded' })
    expect(posts(request)).toHaveLength(2)
    expect(cookieHeader.mock.calls.some(([id]) => id === 'account-2')).toBe(true)
  })

  it('can cancel during pagination without dispatching a late write', async () => {
    const controller = new AbortController()
    let release: (response: Response) => void = () => {}
    const request = vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve }))
    const { actions } = setup([], { request })
    const pending = actions.run(yuba({ target: { type: 'batch', source: 'followed-yuba' } }), controller.signal)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    release(Response.json(directory(['99'])))
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('holds the write slot through cancellation and never replays an unknown client sign', async () => {
    const controller = new AbortController()
    let release: (response: Response) => void = () => {}
    const request = vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve }))
    const { actions } = setup([], { request })
    const pending = actions.run(task(), controller.signal)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    controller.abort()
    expect(await actions.run(task({ taskId: 'check-2' }), signal())).toMatchObject({ status: 'waiting-user' })
    release(Response.json(ok({ sign_pl: [] })))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user' })
    expect(request).toHaveBeenCalledTimes(1)
  })
})
