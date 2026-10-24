import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DouyuTaskManager } from '../../electron/douyuTasks'
import type { DouyuTaskDefinition, DouyuTaskOutcome } from './types'
import type { ResolveDouyuRoom } from '../platforms/douyuRoom'
import { DouyuRenewalGatewayError } from './backpackGateway'
import { DouyuRenewalService, type DouyuRenewalDependencies } from './renewalService'
import type { DouyuBackpackRead, DouyuBackpackReceipt, DouyuBadgePageRead } from './renewalTypes'

const ACCOUNT_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UID = '9876543210987654321'
const OTHER_UID = '9876543210987654322'
const PRIVATE = 'SYNTHETIC_PRIVATE_HC_AND_PAYLOAD'
const FOREGROUND = { foreground: true, locked: false, suspended: false }
const RECEIPT: DouyuBackpackReceipt = { status: 'receipt-received', message: '已收到赠送回执.' }
const SIGN_SUCCESS: DouyuTaskOutcome = { status: 'succeeded', message: '签到完成' }
const fixtures: Array<{ service: DouyuRenewalService; tasks: DouyuTaskManager }> = []
const copy = <T>(value: T): T => structuredClone(value)
const uuid = (index: number) => `11111111-1111-4111-8111-${index.toString(16).padStart(12, '0')}`
const badgeHtml = (rooms: string[]) => `<table class="fans-badge-list"><thead><tr><th>粉丝牌</th><th>主播</th></tr></thead><tbody>${rooms.length
  ? rooms.map(room => `<tr data-fans-room="${room}" data-hc="${PRIVATE}" data-fans-gbdgts="1700000000"><td>合成牌</td><td>合成主播</td></tr>`).join('')
  : '<tr><td colspan="2">暂无粉丝牌</td></tr>'}</tbody></table>`
const prop = (count: number, overrides: Record<string, unknown> = {}) => ({
  id: 268, name: '荧光棒', count, met: -1, propType: 1, isClick: 1, isValuable: 0, description: PRIVATE, ...overrides,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function observe<T>(promise: Promise<T>) {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; value?: T; error?: unknown } = { status: 'pending' }
  void promise.then(value => { state.status = 'fulfilled'; state.value = value }, error => { state.status = 'rejected'; state.error = error })
  return state
}

function harness(count = 12) {
  const state = { uid: UID, ready: true, rooms: ['200', '300'], items: new Map<string, Record<string, unknown>>([['268', prop(count)]]) }
  const trace: string[] = []
  let serial = 0
  const signs: Array<ReturnType<typeof deferred<DouyuTaskOutcome>> & { signal: AbortSignal }> = []
  const run = vi.fn((task: DouyuTaskDefinition, signal: AbortSignal) => {
    trace.push(`sign:${task.kind}`)
    const attempt = { ...deferred<DouyuTaskOutcome>(), signal }
    signs.push(attempt)
    return attempt.promise
  })
  const save = vi.fn()
  const tasks = new DouyuTaskManager({ load: () => undefined, save, run, id: () => uuid(++serial) })
  tasks.setActiveAccount('default')
  tasks.setRoom('100')
  tasks.setRuntime(FOREGROUND)
  const readBadges = vi.fn<DouyuRenewalDependencies['gateway']['readBadges']>(async () => {
    trace.push('badges')
    return { uid: state.uid, html: badgeHtml(state.rooms) }
  })
  const readBackpack = vi.fn<DouyuRenewalDependencies['gateway']['readBackpack']>(async (_accountId, room) => {
    trace.push(`stock:${room}:${state.items.get('268')?.count}`)
    // The selected prop deliberately follows an unrelated row, including every post-read.
    return { uid: state.uid, payload: { list: [prop(99, { id: 999, name: '其他道具' }), ...copy([...state.items.values()])] } }
  })
  const donate = vi.fn<DouyuRenewalDependencies['gateway']['donate']>(async input => {
    trace.push(`donate:${input.room}:${input.quantity}`)
    const item = state.items.get(input.propId)!
    item.count = Number(item.count) - input.quantity
    return { ...RECEIPT }
  })
  const resolveRoom = vi.fn<ResolveDouyuRoom>(async room => ({ ok: true, identity: { room, inputRoom: room } }))
  const accountReady = vi.fn((id: string) => id === 'default' && state.ready)
  const service = new DouyuRenewalService({ gateway: { readBadges, readBackpack, donate }, tasks, resolveRoom, accountReady, id: () => uuid(++serial) })
  fixtures.push({ service, tasks })
  return { state, trace, tasks, service, run, signs, save, readBadges, readBackpack, donate, resolveRoom, accountReady }
}

function addSign(h: ReturnType<typeof harness>): string {
  return h.tasks.create({ accountId: 'default', room: '100', kind: 'room-sign', policy: 'foreground', repeatMinutes: null }).tasks[0]!.id
}

async function flush() { for (let index = 0; index < 32; index++) await Promise.resolve() }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
afterEach(async () => {
  for (const { service, tasks } of fixtures.splice(0)) { service.dispose(); tasks.dispose() }
  await flush()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('renewal target and preview orchestration', () => {
  it('binds per-room quantities to the reviewed plan and reconciles their shared inventory', async () => {
    const h = harness(5)
    const quantities = [{ room: '200', quantity: 3 }]
    const plan = await h.service.preview('default', ['200', '300'], 2, quantities)
    expect(plan.rows.map(row => row.gift?.quantity)).toEqual([3, 2])
    expect(plan.totalQuantity).toBe(5)
    expect(h.donate).not.toHaveBeenCalled()
    quantities[0]!.quantity = 1000
    const result = await h.service.execute(plan.id)
    expect(result.status).toBe('completed')
    expect(h.donate.mock.calls.map(([input]) => [input.room, input.quantity])).toEqual([['200', 3], ['300', 2]])
    expect(h.state.items.get('268')?.count).toBe(0)
    await expect(h.service.execute(plan.id)).rejects.toMatchObject({ code: 'stale-plan' })
  })

  it('skips an unaffordable room override without spending inventory allocated to later rooms', async () => {
    const h = harness(2)
    const plan = await h.service.preview('default', ['200', '300'], 1, [{ room: '200', quantity: 3 }])
    expect(plan.rows.map(row => row.status)).toEqual(['skipped', 'ready'])
    expect(plan.totalQuantity).toBe(1)
    const result = await h.service.execute(plan.id)
    expect(result.status).toBe('completed')
    expect(h.donate.mock.calls.map(([input]) => [input.room, input.quantity])).toEqual([['300', 1]])
  })

  it.each([
    [{ room: '999', quantity: 1 }], [{ room: '200', quantity: 0 }], [{ room: '200', quantity: 1001 }],
    [{ room: '200', quantity: 1.5 }], [{ room: '200', quantity: '1' }],
    [{ room: '200', quantity: 1 }, { room: '200', quantity: 2 }],
    [{ room: '200', quantity: 1, propId: '2358' }], null, {}, new Array(1),
  ])('rejects invalid per-room quantities before reading credentials or inventory %#', async quantities => {
    const h = harness()
    await expect(h.service.preview('default', ['200', '300'], 1, quantities)).rejects.toMatchObject({ code: 'invalid-arguments' })
    expect(h.readBadges).not.toHaveBeenCalled()
    expect(h.donate).not.toHaveBeenCalled()
  })

  it('reads and previews without donating or exposing private identity and response fields', async () => {
    const h = harness()
    const page = await h.service.targets('default')
    expect(page).toMatchObject({ accountId: 'default', coverage: 'returned-page', targets: [
      { room: '200', badgeName: '房间 200' }, { room: '300', badgeName: '房间 300' },
    ] })
    const plan = await h.service.preview('default', ['200', '300'], 2)
    expect(plan).toMatchObject({ accountId: 'default', totalQuantity: 4, rows: [
      { room: '200', status: 'ready', gift: { propId: '268', quantity: 2, stock: 12 } },
      { room: '300', status: 'ready', gift: { propId: '268', quantity: 2, stock: 12 } },
    ] })
    expect(h.donate).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
    expect(h.tasks.snapshot().tasks).toEqual([])
    expect(JSON.stringify([page, plan])).not.toContain(UID)
    expect(JSON.stringify([page, plan])).not.toContain(PRIVATE)
    expect(JSON.stringify([page, plan])).not.toMatch(/"uid"|data-hc|description|payload/)
  })

  it('only admits rooms on this returned page and requires canonical identity to remain the same', async () => {
    const h = harness()
    await expect(h.service.preview('default', ['999'], 1)).rejects.toMatchObject({ code: 'stale-plan' })
    expect(h.readBackpack).not.toHaveBeenCalled()
    h.resolveRoom.mockImplementationOnce(async room => ({ ok: true, identity: { room: '999', inputRoom: room } }))
    const plan = await h.service.preview('default', ['200'], 1)
    expect(plan.rows[0]).toMatchObject({ status: 'skipped', gift: null, reason: expect.stringContaining('房间身份') })
    expect(h.readBackpack).not.toHaveBeenCalled()
    await expect(h.service.execute(plan.id)).rejects.toMatchObject({ code: 'stale-plan' })
    expect(h.donate).not.toHaveBeenCalled()
  })

  it('caps selection at 20 targets and rejects a duplicate selection before further reads', async () => {
    const h = harness(30)
    h.state.rooms = Array.from({ length: 21 }, (_, index) => String(index + 1))
    expect((await h.service.preview('default', h.state.rooms.slice(0, 20), 1)).rows).toHaveLength(20)
    h.readBadges.mockClear()
    await expect(h.service.preview('default', h.state.rooms, 1)).rejects.toMatchObject({ code: 'invalid-arguments' })
    await expect(h.service.preview('default', ['1', '1'], 1)).rejects.toMatchObject({ code: 'invalid-arguments' })
    expect(h.readBadges).not.toHaveBeenCalled()
    expect(h.donate).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, 1001, NaN])('requires an explicit bounded integer quantity: %#', async quantity => {
    const h = harness()
    await expect(h.service.preview('default', ['200'], quantity)).rejects.toMatchObject({ code: 'invalid-arguments' })
    expect(h.readBadges).not.toHaveBeenCalled()
    expect(h.donate).not.toHaveBeenCalled()
  })

  it.each([1, 1000])('accepts quantity endpoint %s without implicit rescaling', async quantity => {
    const h = harness(1000)
    const plan = await h.service.preview('default', ['200'], quantity)
    expect(plan.rows[0]!.gift?.quantity).toBe(quantity)
    expect(plan.totalQuantity).toBe(quantity)
    expect(h.donate).not.toHaveBeenCalled()
  })

  it('allocates each global prop stock once across rooms and skips targets after both stocks are exhausted', async () => {
    const h = harness(5)
    h.state.items.set('2358', prop(4, { id: 2358, name: '超级荧光棒' }))
    h.state.rooms = ['200', '300', '400']
    const plan = await h.service.preview('default', h.state.rooms, 3)
    expect(plan.rows.map(row => ({ status: row.status, id: row.gift?.propId, quantity: row.gift?.quantity }))).toEqual([
      { status: 'ready', id: '268', quantity: 3 }, { status: 'ready', id: '2358', quantity: 3 },
      { status: 'skipped', id: undefined, quantity: undefined },
    ])
    expect(plan.totalQuantity).toBe(6)
    expect(h.donate).not.toHaveBeenCalled()
  })

  it('skips inconsistent shared inventory and unsupported items without falling back to a purchase', async () => {
    const h = harness()
    h.readBackpack.mockResolvedValueOnce({ uid: UID, payload: { list: [prop(12)] } })
    h.readBackpack.mockResolvedValueOnce({ uid: UID, payload: { list: [prop(11)] } })
    const inconsistent = await h.service.preview('default', ['200', '300'], 1)
    expect(inconsistent.rows.every(row => row.status === 'skipped' && row.reason?.includes('库存信息不一致'))).toBe(true)
    h.state.items.set('268', prop(12, { propType: 5 }))
    const unsupported = await h.service.preview('default', ['200'], 1)
    expect(unsupported.rows[0]).toMatchObject({ status: 'skipped', gift: null, reason: expect.stringContaining('领取') })
    expect(h.donate).not.toHaveBeenCalled()
  })

  it('rejects credentials changing between badge and backpack reads without retaining an executable plan', async () => {
    const h = harness()
    h.readBackpack.mockResolvedValueOnce({ uid: OTHER_UID, payload: { list: [prop(12)] } })
    await expect(h.service.preview('default', ['200'], 1)).rejects.toMatchObject({ code: 'account-changed' })
    await expect(h.service.execute(uuid(1))).rejects.toMatchObject({ code: 'stale-plan' })
    expect(h.donate).not.toHaveBeenCalled()
  })
})

describe('one-use plan execution and reconciliation', () => {
  it('executes an isolated stored plan once and reconciles each target by ID as global stock falls', async () => {
    const h = harness(7)
    const plan = await h.service.preview('default', ['200', '300'], 2)
    const id = plan.id
    plan.rows[0]!.room = '999'
    plan.rows[0]!.badgeName = PRIVATE
    plan.rows[0]!.gift!.propId = '2358'
    plan.rows[0]!.gift!.quantity = 1000
    plan.rows[1]!.gift!.stock = 9999
    plan.totalQuantity = 1000
    h.trace.length = 0
    const result = await h.service.execute(id)
    expect(h.donate.mock.calls.map(([input]) => input)).toEqual([
      { accountId: 'default', expectedUid: UID, room: '200', propId: '268', quantity: 2 },
      { accountId: 'default', expectedUid: UID, room: '300', propId: '268', quantity: 2 },
    ])
    expect(h.trace).toEqual(['badges', 'stock:200:7', 'donate:200:2', 'stock:200:5', 'stock:300:5', 'donate:300:2', 'stock:300:3'])
    expect(result).toMatchObject({ status: 'completed', rows: [{ room: '200', quantity: 2, status: 'receipt-received' },
      { room: '300', quantity: 2, status: 'receipt-received' }] })
    expect(result.message).toContain('续期效果仍需')
    expect(JSON.stringify(result)).not.toContain(UID)
    expect(JSON.stringify(result)).not.toContain(PRIVATE)
    await expect(h.service.execute(id)).rejects.toMatchObject({ code: 'stale-plan' })
    expect(h.donate).toHaveBeenCalledTimes(2)
    expect(h.tasks.snapshot()).toMatchObject({ tasks: [], retainedRooms: [] })
  })

  it.each(['uid', 'account', 'origin-room', 'ready', 'expiry', 'invalidate', 'cancel'] as const)
  ('blocks an approved plan after %s changes', async change => {
    const h = harness()
    const plan = await h.service.preview('default', ['200'], 1)
    if (change === 'uid') h.state.uid = OTHER_UID
    if (change === 'account') h.tasks.setActiveAccount(ACCOUNT_B)
    if (change === 'origin-room') h.tasks.setRoom('400')
    if (change === 'ready') h.state.ready = false
    if (change === 'expiry') await vi.advanceTimersByTimeAsync(120_000)
    if (change === 'invalidate') h.service.invalidate('default')
    if (change === 'cancel') expect(h.service.cancel(plan.id)).toEqual({ cancelled: true })
    if (change === 'uid') expect(await h.service.execute(plan.id)).toMatchObject({ status: 'failed', rows: [{ status: 'not-submitted' }] })
    else await expect(h.service.execute(plan.id)).rejects.toMatchObject({ code: expect.stringMatching(/account-changed|stale-plan/) })
    expect(h.donate).not.toHaveBeenCalled()
  })

  it.each([
    { count: 11 }, { met: 1_800_000_300 }, { propType: 2 }, { name: '改名荧光棒' }, { isClick: 2 }, { isValuable: 1 },
  ])('does not replace the approved item or adjust its amount after confirmation metadata changes: %#', async changed => {
    const h = harness()
    h.state.items.set('2358', prop(99, { id: 2358, name: '超级荧光棒' }))
    const plan = await h.service.preview('default', ['200'], 2)
    h.state.items.set('268', prop(12, changed))
    const result = await h.service.execute(plan.id)
    expect(result).toMatchObject({ status: 'failed', rows: [{ status: 'not-submitted', propName: '荧光棒', quantity: 2 }] })
    expect(h.donate).not.toHaveBeenCalled()
  })

  it('checks that selected badges and canonical identities still exist at confirmation', async () => {
    const h = harness()
    const removed = await h.service.preview('default', ['200'], 1)
    h.state.rooms = ['300']
    expect(await h.service.execute(removed.id)).toMatchObject({ status: 'failed', rows: [{ status: 'not-submitted' }] })
    h.state.rooms = ['200']
    const aliased = await h.service.preview('default', ['200'], 1)
    h.resolveRoom.mockImplementationOnce(async inputRoom => ({ ok: true, identity: { room: '999', inputRoom } }))
    expect(await h.service.execute(aliased.id)).toMatchObject({ status: 'failed', rows: [{ status: 'not-submitted' }] })
    expect(h.donate).not.toHaveBeenCalled()
  })

  it('stops the remaining rooms on a post-stock mismatch without automatically compensating', async () => {
    const h = harness()
    const plan = await h.service.preview('default', ['200', '300'], 2)
    h.readBackpack.mockResolvedValueOnce({ uid: UID, payload: { list: [prop(12)] } })
    h.readBackpack.mockResolvedValueOnce({ uid: UID, payload: { list: [prop(99, { id: 999, name: '其他道具' }), prop(12)] } })
    const result = await h.service.execute(plan.id)
    expect(result).toMatchObject({ status: 'waiting-user', rows: [{ room: '200', status: 'unknown' }, { room: '300', status: 'not-submitted' }] })
    expect(result.rows[0]!.message).toContain('库存变化与计划不一致')
    expect(h.donate).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(h.donate).toHaveBeenCalledOnce()
  })

  it.each(['unknown', 'not-submitted', 'permission'] as const)('stops after the first %s donation result', async kind => {
    const h = harness()
    const plan = await h.service.preview('default', ['200', '300'], 1)
    if (kind === 'permission') h.donate.mockRejectedValueOnce(new DouyuRenewalGatewayError('verification-required'))
    else h.donate.mockResolvedValueOnce({ status: kind, message: '合成固定结果, 请核对.' })
    const result = await h.service.execute(plan.id)
    expect(result.status).toBe('waiting-user')
    expect(result.rows[1]).toMatchObject({ status: 'not-submitted' })
    expect(h.donate).toHaveBeenCalledOnce()
    await expect(h.service.execute(plan.id)).rejects.toMatchObject({ code: 'stale-plan' })
  })

  it('does not describe a received receipt as fully unsubmitted if its post-read fails', async () => {
    const h = harness()
    const plan = await h.service.preview('default', ['200', '300'], 1)
    h.readBackpack.mockResolvedValueOnce({ uid: UID, payload: { list: [prop(12)] } })
    h.readBackpack.mockRejectedValueOnce(new DouyuRenewalGatewayError('unavailable'))
    const result = await h.service.execute(plan.id)
    expect(result.status).toBe('waiting-user')
    expect(result.rows[0]).toMatchObject({ status: 'receipt-received', message: RECEIPT.message })
    expect(result.rows[0]!.message).not.toMatch(/未提交|未赠送|未发送/)
    expect(result.rows[1]).toMatchObject({ status: 'not-submitted' })
    expect(h.donate).toHaveBeenCalledOnce()
  })
})

describe('renewal execution ownership and cancellation', () => {
  it('holds one real queue slot around the entire multi-target producer', async () => {
    const h = harness()
    const plan = await h.service.preview('default', ['200', '300'], 2)
    const first = addSign(h)
    const second = h.tasks.create({ accountId: 'default', room: '100', kind: 'yuba-sign', policy: 'foreground', repeatMinutes: null }).tasks.at(-1)!.id
    h.tasks.start(first)
    h.tasks.start(second)
    await flush()
    const transport = deferred<DouyuBackpackReceipt>()
    h.donate.mockImplementationOnce(async input => { h.trace.push(`donate:${input.room}:${input.quantity}`); return transport.promise })
    const pending = h.service.execute(plan.id)
    await flush()
    expect(h.donate).not.toHaveBeenCalled()
    await expect(h.service.execute(plan.id)).rejects.toMatchObject({ code: 'busy' })
    h.signs[0]!.resolve(SIGN_SUCCESS)
    await flush()
    expect(h.donate).toHaveBeenCalledOnce()
    expect(h.run).toHaveBeenCalledOnce()
    h.state.items.get('268')!.count = 10
    transport.resolve(RECEIPT)
    expect(await pending).toMatchObject({ status: 'completed' })
    await flush()
    expect(h.donate).toHaveBeenCalledTimes(2)
    expect(h.run).toHaveBeenCalledTimes(2)
    expect(h.trace.indexOf('donate:300:2')).toBeLessThan(h.trace.indexOf('sign:yuba-sign'))
    expect(h.state.items.get('268')!.count).toBe(8)
  })

  it('cancels a queued plan without entering its producer or cancelling the current sign', async () => {
    const h = harness()
    const plan = await h.service.preview('default', ['200', '300'], 1)
    h.tasks.start(addSign(h))
    await flush()
    h.readBadges.mockClear()
    const pending = h.service.execute(plan.id)
    await flush()
    expect(h.service.cancel(plan.id)).toEqual({ cancelled: true })
    const result = await pending
    expect(result).toMatchObject({ status: 'cancelled', rows: [{ status: 'not-submitted' }, { status: 'not-submitted' }] })
    expect(h.readBadges).not.toHaveBeenCalled()
    expect(h.donate).not.toHaveBeenCalled()
    expect(h.signs[0]!.signal.aborted).toBe(false)
    await expect(h.service.execute(plan.id)).rejects.toMatchObject({ code: 'stale-plan' })
    expect((await h.service.targets('default')).targets).toHaveLength(2)
    h.signs[0]!.resolve(SIGN_SUCCESS)
    await flush()
    expect(h.donate).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'invalidate', 'dispose'] as const)
  ('returns promptly on %s but stays busy until an abort-ignoring donation settles', async action => {
    const h = harness()
    const plan = await h.service.preview('default', ['200', '300'], 1)
    const transport = deferred<DouyuBackpackReceipt>()
    let transportSignal!: AbortSignal
    h.donate.mockImplementationOnce((_input, signal) => { transportSignal = signal; return transport.promise })
    const pending = h.service.execute(plan.id)
    const observed = observe(pending)
    await flush()
    expect(h.donate).toHaveBeenCalledOnce()
    if (action === 'cancel') h.service.cancel(plan.id)
    if (action === 'invalidate') h.service.invalidate('default')
    if (action === 'dispose') h.service.dispose()
    await flush()
    expect(observed.status).toBe('fulfilled')
    const early = observed.value!
    expect(early).toMatchObject({ status: 'cancelled', rows: [{ status: 'unknown' }, { status: 'not-submitted' }] })
    expect(transportSignal.aborted).toBe(true)
    await expect(h.service.targets('default')).rejects.toMatchObject({ code: 'busy' })
    await expect(h.service.preview('default', ['200'], 1)).rejects.toMatchObject({ code: 'busy' })
    await expect(h.service.execute(plan.id)).rejects.toMatchObject({ code: 'busy' })
    h.tasks.start(addSign(h))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.run).not.toHaveBeenCalled()
    expect(h.donate).toHaveBeenCalledOnce()
    transport.resolve(RECEIPT)
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
    expect(h.donate).toHaveBeenCalledOnce()
    expect(await pending).toEqual(early)
    if (action === 'dispose') await expect(h.service.targets('default')).rejects.toMatchObject({ code: 'account-changed' })
    else expect((await h.service.targets('default')).targets).toHaveLength(2)
  })

  it('bounds a stalled execution without freeing a live donation or continuing to the next room', async () => {
    const h = harness()
    const plan = await h.service.preview('default', ['200', '300'], 1)
    const transport = deferred<DouyuBackpackReceipt>()
    h.donate.mockImplementationOnce(() => transport.promise)
    const observed = observe(h.service.execute(plan.id))
    await flush()
    await vi.advanceTimersByTimeAsync(89_999)
    expect(observed.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(observed.status).toBe('fulfilled')
    expect(observed.value).toMatchObject({ status: 'cancelled' })
    await expect(h.service.targets('default')).rejects.toMatchObject({ code: 'busy' })
    transport.resolve(RECEIPT)
    await flush()
    expect(h.donate).toHaveBeenCalledOnce()
    expect((await h.service.targets('default')).targets).toHaveLength(2)
  })

  it('does not hang confirmation on a resolver that ignores abort, and never donates after its late reply', async () => {
    const h = harness()
    const plan = await h.service.preview('default', ['200'], 1)
    const resolution = deferred<Awaited<ReturnType<ResolveDouyuRoom>>>()
    h.resolveRoom.mockImplementationOnce(() => resolution.promise)
    const pending = h.service.execute(plan.id)
    const observed = observe(pending)
    await flush()
    h.service.cancel(plan.id)
    await flush()
    expect(observed.status).toBe('fulfilled')
    expect(observed.value).toMatchObject({ status: 'cancelled', rows: [{ status: 'not-submitted' }] })
    expect(h.donate).not.toHaveBeenCalled()
    expect((await h.service.targets('default')).targets).toHaveLength(2)
    resolution.resolve({ ok: true, identity: { room: '200', inputRoom: '200' } })
    await flush()
    expect(h.donate).not.toHaveBeenCalled()
  })

  it.each(['queue-busy', 'background'] as const)('fails safely if the real execution lane is %s and consumes the claimed plan', async cause => {
    const h = harness()
    const plan = await h.service.preview('default', ['200'], 1)
    const producer = deferred<void>()
    let other: Promise<unknown> | undefined
    if (cause === 'queue-busy') {
      other = h.tasks.runAccountOperation({ accountId: 'default', originRoom: '100', rooms: ['900'] }, () => producer.promise, new AbortController().signal)
      await flush()
    } else h.tasks.setRuntime({ ...FOREGROUND, foreground: false })
    const result = await h.service.execute(plan.id)
    expect(result).toMatchObject({ status: 'failed', rows: [{ status: 'not-submitted' }] })
    expect(h.donate).not.toHaveBeenCalled()
    h.tasks.setRuntime(FOREGROUND)
    producer.resolve()
    await other
    await expect(h.service.execute(plan.id)).rejects.toMatchObject({ code: 'stale-plan' })
  })

  it('accepts only the opaque plan ID at confirmation', async () => {
    const h = harness()
    const plan = await h.service.preview('default', ['200'], 1)
    await expect(h.service.execute(plan as never)).rejects.toMatchObject({ code: 'invalid-arguments' })
    expect(h.donate).not.toHaveBeenCalled()
    expect(await h.service.execute(plan.id)).toMatchObject({ status: 'completed' })
    expect(h.donate).toHaveBeenCalledOnce()
  })
})

describe('renewal asynchronous read lifetime', () => {
  it('supersedes a target read and ignores the old uncooperative gateway response', async () => {
    const h = harness()
    const first = deferred<DouyuBadgePageRead>()
    let signal!: AbortSignal
    h.readBadges.mockImplementationOnce((_account, abort) => { signal = abort; return first.promise })
    const old = observe(h.service.targets('default'))
    await flush()
    const current = await h.service.targets('default')
    expect(signal.aborted).toBe(true)
    expect(old.status).toBe('rejected')
    expect(old.error).toMatchObject({ code: 'cancelled' })
    first.resolve({ uid: OTHER_UID, html: badgeHtml(['999']) })
    await flush()
    expect(current.targets.map(target => target.room)).toEqual(['200', '300'])
    expect(h.donate).not.toHaveBeenCalled()
  })

  it('prevents a superseded preview from overwriting the current plan after a late stock read', async () => {
    const h = harness()
    const first = deferred<DouyuBackpackRead>()
    h.readBackpack.mockImplementationOnce(() => first.promise)
    const old = observe(h.service.preview('default', ['200'], 1))
    await flush()
    const current = await h.service.preview('default', ['300'], 2)
    expect(old.status).toBe('rejected')
    expect(old.error).toMatchObject({ code: 'cancelled' })
    first.resolve({ uid: UID, payload: { list: [prop(999)] } })
    await flush()
    expect(await h.service.execute(current.id)).toMatchObject({ status: 'completed', rows: [{ room: '300', quantity: 2 }] })
    expect(h.donate).toHaveBeenCalledExactlyOnceWith({ accountId: 'default', expectedUid: UID, room: '300', propId: '268', quantity: 2 }, expect.any(AbortSignal))
  })

  it.each(['targets', 'preview'] as const)('invalidates an unfinished %s read without waiting for the gateway', async kind => {
    const h = harness()
    const pending = deferred<DouyuBadgePageRead>()
    h.readBadges.mockImplementationOnce(() => pending.promise)
    const observed = observe<unknown>(kind === 'targets' ? h.service.targets('default') : h.service.preview('default', ['200'], 1))
    await flush()
    h.service.invalidate('default')
    await flush()
    expect(observed.status).toBe('rejected')
    expect(observed.error).toMatchObject({ code: 'cancelled' })
    pending.resolve({ uid: UID, html: badgeHtml(['200']) })
    await flush()
    expect(h.donate).not.toHaveBeenCalled()
    await expect(h.service.execute(uuid(1))).rejects.toMatchObject({ code: 'stale-plan' })
  })

  it('disposes an unfinished preview and never stores a late result as a usable plan', async () => {
    const h = harness()
    const stock = deferred<DouyuBackpackRead>()
    h.readBackpack.mockImplementationOnce(() => stock.promise)
    const observed = observe(h.service.preview('default', ['200'], 1))
    await flush()
    h.service.dispose()
    await flush()
    expect(observed.status).toBe('rejected')
    expect(observed.error).toMatchObject({ code: 'cancelled' })
    stock.resolve({ uid: UID, payload: { list: [prop(12)] } })
    await flush()
    await expect(h.service.targets('default')).rejects.toMatchObject({ code: 'account-changed' })
    await expect(h.service.execute(uuid(1))).rejects.toMatchObject({ code: 'stale-plan' })
    expect(h.donate).not.toHaveBeenCalled()
  })

  it.each(['targets', 'preview-stock', 'preview-resolver'] as const)('applies the overall 45-second read deadline to %s', async kind => {
    const h = harness()
    const badge = deferred<DouyuBadgePageRead>()
    const stock = deferred<DouyuBackpackRead>()
    const resolution = deferred<Awaited<ReturnType<ResolveDouyuRoom>>>()
    if (kind === 'targets') h.readBadges.mockImplementationOnce(() => badge.promise)
    if (kind === 'preview-stock') h.readBackpack.mockImplementationOnce(() => stock.promise)
    if (kind === 'preview-resolver') h.resolveRoom.mockImplementationOnce(() => resolution.promise)
    const observed = observe<unknown>(kind === 'targets' ? h.service.targets('default') : h.service.preview('default', ['200'], 1))
    await flush()
    await vi.advanceTimersByTimeAsync(44_999)
    expect(observed.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(observed.status).toBe('rejected')
    expect(observed.error).toMatchObject({ code: 'cancelled' })
    badge.resolve({ uid: UID, html: badgeHtml(['200']) })
    stock.resolve({ uid: UID, payload: { list: [prop(12)] } })
    resolution.resolve({ ok: true, identity: { room: '200', inputRoom: '200' } })
    await flush()
    expect(h.donate).not.toHaveBeenCalled()
    await expect(h.service.execute(uuid(1))).rejects.toMatchObject({ code: 'stale-plan' })
    expect((await h.service.targets('default')).targets).toHaveLength(2)
  })

  it.each(['account', 'room'] as const)('rechecks %s scope before exposing an asynchronous target read', async change => {
    const h = harness()
    const response = deferred<DouyuBadgePageRead>()
    h.readBadges.mockImplementationOnce(() => response.promise)
    const observed = observe(h.service.targets('default'))
    await flush()
    if (change === 'account') h.tasks.setActiveAccount(ACCOUNT_B)
    else h.tasks.setRoom('400')
    response.resolve({ uid: UID, html: badgeHtml(['200']) })
    await flush()
    expect(observed.status).toBe('rejected')
    expect(observed.error).toMatchObject({ code: change === 'account' ? 'account-changed' : 'stale-plan' })
    expect(h.donate).not.toHaveBeenCalled()
  })
})
