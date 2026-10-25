import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { DouyuLevelRewardActions } from './levelRewardActions'
import type { DouyuAutomationDependencies, DouyuAutomationRequest } from './automationTypes'

const NOW = Date.UTC(2026, 9, 25, 4)
const COOKIE = 'acf_uid=42; acf_auth=fixture-auth; acf_biz=1; acf_stk=fixture-stk; acf_ct=1; acf_ltkid=fixture-ltk; acf_ccn=fixture-csrf; cvl_csrf_token=fixture-carnival'
const ok = (data: unknown) => ({ error: 0, data })
const signal = () => new AbortController().signal
const task = (patch: Partial<DouyuAutomationRequest> = {}): DouyuAutomationRequest => ({ taskId: 'level-1', accountId: 'account-1',
  kind: 'level-reward', target: { type: 'room', room: '123' }, options: {}, ...patch })
const status = (prizeStatus = 0, taskStatus = 1, taskId = '9') => ({ taskId, taskStatus, prizeStatus })
const pointsPage = () => new Response('<a href="/topic/20261025POINTS">积分任务</a>')
const pointsConfig = (end = NOW + 3600000) => new Response(`DYConfigCallback(${JSON.stringify({ data: {
  activity_setting: { activity_alias_name: '20261025POINTS', activity_start_time: (NOW - 3600000) / 1000, activity_end_time: end / 1000 },
  sign_setting: { signAlias: '20261025POINTS_sign' },
} })})`)
const watching = (values: number[]) => ok({ startTime: NOW / 1000 - 3600, taskList: Object.fromEntries(values.map((value, i) => [String(i + 1), { status: value }])) })
function setup(responses: unknown[], overrides: Partial<DouyuAutomationDependencies> = {}) {
  const queue = [...responses]
  const request = vi.fn<typeof fetch>(async () => {
    if (!queue.length) throw new Error('Unexpected fixture request')
    const value = queue.shift()
    if (value instanceof Error) throw value
    return value instanceof Response ? value : Response.json(value)
  })
  const cookieHeader = vi.fn(async () => COOKIE)
  return { request, cookieHeader, actions: new DouyuLevelRewardActions({ proxy: resolveConfig({}).proxy, request, cookieHeader,
    resolve: async () => ['8.8.8.8'], now: () => NOW, ...overrides }) }
}
const posts = (request: ReturnType<typeof setup>['request']) => request.mock.calls.filter(([, init]) => init?.method === 'POST')

describe('completed level rewards', () => {
  it('claims one completed unclaimed reward and verifies it by a fresh status read', async () => {
    const { actions, request } = setup([ok({ taskIds: ['9', '10'] }), ok({ list: [status(), status(0, 0, '10')] }),
      ok({ list: [{ name: 'Fixture award', num: 1 }] }), ok({ taskIds: ['9', '10'] }), ok({ list: [status(1), status(0, 0, '10')] })])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + 5000, progress: { completed: 1, current: '9', evidence: 'official-state' } })
    expect(posts(request)).toHaveLength(1)
    expect(new URLSearchParams(posts(request)[0]![1]?.body as string).get('taskIds')).toBe('9')
    expect(request.mock.calls.every(([url]) => !/finishTask|completeTask|heartbeat/.test(String(url)))).toBe(true)
  })

  it.each([[], [status(1)], [status(0, 0)]].map(rows => ({ rows })))('does not write when no officially completed unclaimed task exists %#', async ({ rows }) => {
    const responses = rows.length ? [ok({ taskIds: ['9'] }), ok({ list: rows })] : [ok({ taskIds: [] })]
    const { actions, request } = setup(responses)
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + 60000, progress: { completed: 0 } })
    expect(posts(request)).toHaveLength(0)
  })

  it.each([[status(0, 1, '10')], [status(), status()], [status(3)], []].map(rows => ({ rows })))('refuses mismatched or incomplete task status data %#', async ({ rows }) => {
    const { actions, request } = setup([ok({ taskIds: ['9'] }), ok({ list: rows })])
    expect((await actions.run(task(), signal())).status).not.toBe('succeeded')
    expect(posts(request)).toHaveLength(0)
  })

  it('keeps a lost reward response blocked on manual resume and after forgetting progress', async () => {
    const { actions, request } = setup([ok({ taskIds: ['9'] }), ok({ list: [status()] }), new Error('lost'), ok({ taskIds: ['9'] }), ok({ list: [status()] })])
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user', progress: { evidence: 'unconfirmed' } })
    actions.forget('level-1')
    expect(await actions.run(task(), signal())).toMatchObject({ status: 'waiting-user' })
    expect(posts(request)).toHaveLength(1)
  })
})

describe('official points and explicit social tasks', () => {
  it('claims only a watch task already marked claimable and verifies the claimed state', async () => {
    const { actions, request } = setup([pointsPage(), pointsConfig(), watching([0, 1, 2, 3]), ok({}), watching([0, 1, 3, 3])])
    expect(await actions.run(task({ kind: 'watch-points', target: { type: 'account' } }), signal())).toMatchObject({ status: 'scheduled', progress: { completed: 1, current: '3', evidence: 'official-state' } })
    const claims = posts(request).filter(([url]) => String(url).endsWith('/takeGift'))
    expect(claims).toHaveLength(1)
    expect(new URLSearchParams(claims[0]![1]?.body as string).get('id')).toBe('3')
    expect(request.mock.calls.every(([url]) => !/heartbeat|watchReport|startTask|finishTask/.test(String(url)))).toBe(true)
  })

  it.each([[0], [1], [3], []].map(values => ({ values })))('only polls official state when a viewing task is not claimable %#', async ({ values }) => {
    const { actions, request } = setup([pointsPage(), pointsConfig(), watching(values)])
    expect(await actions.run(task({ kind: 'watch-points', target: { type: 'account' } }), signal())).toMatchObject({ status: 'scheduled', nextRunAt: NOW + 300000 })
    expect(request.mock.calls.some(([url]) => String(url).endsWith('/takeGift'))).toBe(false)
  })

  it('does not replay a watch claim when the official read-back still shows claimable', async () => {
    const { actions, request } = setup([pointsPage(), pointsConfig(), watching([2]), ok({}), watching([2]), pointsPage(), pointsConfig(), watching([2])])
    const input = task({ kind: 'watch-points', target: { type: 'account' } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'waiting-user' })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'waiting-user' })
    expect(posts(request).filter(([url]) => String(url).endsWith('/takeGift'))).toHaveLength(1)
  })

  it.each(['points-sign', 'watch-points'] as const)('does not submit %s to an expired or missing points activity', async kind => {
    const { actions, request } = setup([pointsPage(), pointsConfig(NOW)])
    expect(await actions.run(task({ kind, target: { type: 'account' } }), signal())).toMatchObject({ status: 'failed' })
    expect(posts(request)).toHaveLength(0)
  })

  it('uses the existing official carnival token and never suppresses verification', async () => {
    const { actions, request } = setup([pointsPage(), pointsConfig(), ok({ is_signed: 1 })])
    expect(await actions.run(task({ kind: 'points-sign', target: { type: 'account' } }), signal())).toMatchObject({ status: 'succeeded', progress: { evidence: 'receipt-received' } })
    const body = new URLSearchParams(posts(request)[0]![1]?.body as string)
    expect(body.get('csrfToken')).toBe('fixture-carnival')
    expect(body.get('signAlias')).toBe('20261025POINTS_sign')
    expect(body.has('useJiYan')).toBe(false)
  })

  it('adds only user-selected follows and verifies each change without resetting old follows', async () => {
    const { actions, request } = setup([ok({ '123': 1 }), ok({ '456': 0 }), ok({}), ok({ '456': 1 })])
    const input = task({ kind: 'follow-task', target: { type: 'account' }, options: { followRooms: ['123', '456'] } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'scheduled', progress: { completed: 1, skipped: 1 } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'succeeded', progress: { completed: 2, skipped: 1 } })
    expect(posts(request)).toHaveLength(1)
    expect(new URLSearchParams(posts(request)[0]![1]?.body as string).get('rid')).toBe('456')
    expect(request.mock.calls.every(([url]) => !/cancel|remove|delete/.test(String(url)))).toBe(true)
  })

  it('refuses a star-follow target missing from the current official rank directory', async () => {
    const { actions, request } = setup([ok({ rankItemList: [{ rid: 123 }] })])
    expect(await actions.run(task({ kind: 'anchor-star-follow', options: { followRooms: ['456'] } }), signal())).toMatchObject({ status: 'waiting-user' })
    expect(posts(request)).toHaveLength(0)
  })

  it('signs one official star room per turn and rejects an empty acknowledgement', async () => {
    const { actions, request } = setup([ok({ rankItemList: [{ rid: 123 }, { rid: 456 }] }), ok({ rid: 123, taskStatus: 1 }), ok({})])
    const input = task({ kind: 'anchor-star-sign' })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'scheduled', progress: { completed: 1 } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'waiting-user', progress: { completed: 1, evidence: 'unconfirmed' } })
    expect(posts(request)).toHaveLength(2)
  })

  it('only fetches explicitly requested fish-bar articles without inventing completed reading time', async () => {
    const { actions, request } = setup([ok({ post: { post_id: '999', title: 'Fixture' } })])
    expect(await actions.run(task({ kind: 'yuba-read', target: { type: 'account' }, options: { postIds: ['999'] } }), signal())).toMatchObject({ status: 'succeeded', progress: { completed: 1, evidence: 'none' } })
    expect(posts(request)).toHaveLength(0)
    expect(new URL(String(request.mock.calls[0]![0])).pathname).toBe('/wbapi/web/post/detail/999')
  })

  it('does not accept unrelated fish-bar data as the requested article', async () => {
    const { actions } = setup([ok({ post: { post_id: '1000' } })])
    expect(await actions.run(task({ kind: 'yuba-read', target: { type: 'account' }, options: { postIds: ['999'] } }), signal())).toMatchObject({ status: 'waiting-user', progress: { completed: 0 } })
  })

  it('keeps a resumed follow batch bound to its original account session', async () => {
    let cookie = COOKIE
    const { actions, request } = setup([ok({ '123': 1 })], { cookieHeader: async () => cookie })
    const input = task({ kind: 'follow-task', target: { type: 'account' }, options: { followRooms: ['123', '456'] } })
    expect(await actions.run(input, signal())).toMatchObject({ status: 'scheduled' })
    cookie = COOKIE.replace('acf_uid=42', 'acf_uid=43')
    expect(await actions.run(input, signal())).toMatchObject({ status: 'waiting-user' })
    expect(request).toHaveBeenCalledTimes(1)
  })
})
