import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DouyuTaskManager } from '../../electron/douyuTasks'
import { resolveConfig } from '../config'
import { DouyuBackpackGateway } from './backpackGateway'
import { DouyuGiftPurchaseGateway, parseDouyuGiftBalance } from './giftPurchaseGateway'
import { DouyuGiftPlanService, readInventoryGiftInput, readPurchaseGiftInput, type DouyuGiftPlanDependencies } from './giftPlanService'
import type { DouyuGiftCatalogItem, DouyuGiftReceipt } from './inventoryTypes'

const NOW = 1_800_000_000_000
const FOREGROUND = { foreground: true, locked: false, suspended: false }
const receipt: DouyuGiftReceipt = { status: 'receipt-received', message: 'SYNTHETIC_PRIVATE_UPSTREAM_MESSAGE' }
const uuid = (index: number) => `11111111-1111-4111-8111-${index.toString(16).padStart(12, '0')}`
const prop = (id: number, count: number, extra: Record<string, unknown> = {}) => ({ id, count, name: `合成道具 ${id}`, propType: 1,
  isClick: 1, isValuable: 1, met: -1, intimate: 60, price: 600, batchInfo: { '6': { batchNum: 6 } }, ...extra })
const purchaseInput = { room: '100', giftId: '20002', quantity: 2, repeat: 3, intervalMs: 0 }
const instances: Array<{ service: DouyuGiftPlanService; tasks: DouyuTaskManager }> = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function harness(overrides: Partial<DouyuGiftPlanDependencies> = {}) {
  let serial = 0
  const state = { uid: '42', ready: true, YUCHI: 100_000 as number | null, YUWAN: 1_000_000 as number | null,
    onceLimit: 500000, items: new Map<string, Record<string, unknown>>([['268', prop(268, 5)], ['777', prop(777, 2, { batchInfo: {} })], ['800', prop(800, 4, { propType: 7 })]]),
    gift: { giftId: '20002', name: '合成礼物', unitPrice: { currency: 'YUCHI', amountMinor: 600, scale: 100 },
      skinId: 9, countLimit: 0, available: true, unavailableReason: null } as DouyuGiftCatalogItem }
  const tasks = new DouyuTaskManager({ load: () => undefined, save: vi.fn(), run: async () => ({ status: 'succeeded', message: '合成任务完成' }), id: () => uuid(++serial) })
  tasks.setActiveAccount('default')
  tasks.setRoom('100')
  tasks.setRuntime(FOREGROUND)
  const readBackpack = vi.fn<DouyuGiftPlanDependencies['gateway']['readBackpack']>(async () => ({ uid: state.uid,
    payload: { list: structuredClone([...state.items.values()]), ignored: 'SYNTHETIC_PRIVATE' } }))
  const donateInventory = vi.fn<DouyuGiftPlanDependencies['gateway']['donateInventory']>(async input => {
    const item = state.items.get(input.propId)!
    item.count = Number(item.count) - input.quantity
    return { ...receipt }
  })
  const readCatalog = vi.fn<DouyuGiftPlanDependencies['purchase']['readCatalog']>(async room => ({ room, checkedAt: Date.now(), onceLimit: state.onceLimit, items: [structuredClone(state.gift)] }))
  const readBalance = vi.fn<DouyuGiftPlanDependencies['purchase']['readBalance']>(async () => ({ uid: state.uid, checkedAt: Date.now(), balances: { YUCHI: state.YUCHI, YUWAN: state.YUWAN } }))
  const purchase = vi.fn<DouyuGiftPlanDependencies['purchase']['purchase']>(async input => {
    state[input.unitPrice.currency] = state[input.unitPrice.currency]! - input.unitPrice.amountMinor * input.quantity
    return { ...receipt }
  })
  const resolveRoom = vi.fn<DouyuGiftPlanDependencies['resolveRoom']>(async room => ({ ok: true, identity: { room, inputRoom: room } }))
  const service = new DouyuGiftPlanService({ tasks, gateway: { readBackpack, donateInventory }, purchase: { readCatalog, readBalance, purchase },
    resolveRoom, accountReady: () => state.ready, id: () => uuid(++serial), ...overrides })
  instances.push({ service, tasks })
  return { service, state, tasks, readBackpack, donateInventory, readCatalog, readBalance, purchase, resolveRoom }
}

async function flush() { for (let i = 0; i < 128; i++) await Promise.resolve() }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(async () => {
  for (const instance of instances.splice(0)) { instance.service.dispose(); instance.tasks.dispose() }
  await flush()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('inventory plan scope and execution', () => {
  it('clears only transferable existing stock to the current room without any purchase', async () => {
    const h = harness()
    const plan = await h.service.previewInventory('default', { room: '100', selection: 'all', intervalMs: 0 })
    expect(plan).toMatchObject({ accountId: 'default', room: '100', kind: 'inventory', totalQuantity: 7, totalOperations: 3, budget: null })
    expect(plan.rows.map(row => [row.propId, row.quantity, row.repeat])).toEqual([['268', 5, 1], ['777', 1, 2]])
    expect(plan.excludedItems).toMatchObject([{ propId: '800', quantity: 4 }])
    expect(h.donateInventory).not.toHaveBeenCalled()
    expect((await h.service.execute(plan.id))).toMatchObject({ status: 'completed', confirmedQuantity: 7 })
    expect(h.state.items.get('268')?.count).toBe(0)
    expect(h.state.items.get('777')?.count).toBe(0)
    expect(h.state.items.get('800')?.count).toBe(4)
    expect(h.purchase).not.toHaveBeenCalled()
    expect(h.donateInventory.mock.calls.every(([input]) => input.room === '100' && input.accountId === 'default')).toBe(true)
  })

  it('sends an explicit propId and quantity without selecting a similarly named item', async () => {
    const h = harness()
    h.state.items.set('99999', prop(99999, 15, { name: h.state.items.get('268')!.name }))
    const plan = await h.service.previewInventory('default', { room: '100', selection: [{ propId: '99999', quantity: 7 }], intervalMs: 0 })
    expect((await h.service.execute(plan.id)).status).toBe('completed')
    expect(h.donateInventory).toHaveBeenCalledOnce()
    expect(h.donateInventory.mock.calls[0]?.[0]).toMatchObject({ propId: '99999', quantity: 7 })
    expect(h.state.items.get('268')?.count).toBe(5)
  })

  it('does not fall back to purchase when stock is insufficient', async () => {
    const h = harness()
    await expect(h.service.previewInventory('default', { room: '100', selection: [{ propId: '268', quantity: 6 }] })).rejects.toMatchObject({ code: 'inventory-changed' })
    expect(h.purchase).not.toHaveBeenCalled()
    expect(h.donateInventory).not.toHaveBeenCalled()
  })

  it.each([{ count: 4 }, { name: '不同道具' }, { propType: 7 }, { isClick: 0 }, { met: 1 }, { isValuable: 0 }])('stops before submitting if confirmed inventory changes %#', change => {
    const h = harness()
    return h.service.previewInventory('default', { room: '100', selection: [{ propId: '268', quantity: 1 }], intervalMs: 0 }).then(async plan => {
      Object.assign(h.state.items.get('268')!, change)
      expect(await h.service.execute(plan.id)).toMatchObject({ status: 'failed', reason: 'inventory-changed', submittedQuantity: 0 })
      expect(h.donateInventory).not.toHaveBeenCalled()
    })
  })

  it('stops after a receipt when the new inventory does not match the planned deduction', async () => {
    const h = harness()
    h.donateInventory.mockImplementationOnce(async () => ({ ...receipt }))
    const plan = await h.service.previewInventory('default', { room: '100', selection: 'all', intervalMs: 0 })
    expect(await h.service.execute(plan.id)).toMatchObject({ status: 'waiting-user', reason: 'inventory-changed', confirmedQuantity: 0 })
    expect(h.donateInventory).toHaveBeenCalledOnce()
  })
})

describe('exact price, account balance and confirmed budget', () => {
  it('executes the chosen real gift ID and scheduled count using the private preview price', async () => {
    const h = harness()
    h.state.gift.giftId = '20999'
    const plan = await h.service.previewPurchase('default', { ...purchaseInput, giftId: '20999', intervalMs: 2000 })
    const id = plan.id
    expect(plan).toMatchObject({ kind: 'purchase', totalQuantity: 6, totalOperations: 3, intervalMs: 2000,
      budget: { currency: 'YUCHI', amountMinor: 3600, scale: 100 }, balanceBefore: { amountMinor: 100000 } })
    plan.rows[0]!.quantity = 999
    plan.budget!.amountMinor = 1
    plan.room = '200'
    const operation = h.service.execute(id)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await operation).toMatchObject({ status: 'completed', confirmedQuantity: 6 })
    expect(h.purchase.mock.calls.map(([input]) => [input.giftId, input.quantity, input.expectedBalance])).toEqual([
      ['20999', 2, 100000], ['20999', 2, 98800], ['20999', 2, 97600],
    ])
    expect(h.state.YUCHI).toBe(96400)
    expect(h.donateInventory).not.toHaveBeenCalled()
  })

  it('preserves fish-ball accounting rather than dividing it by 100', async () => {
    const h = harness()
    h.state.gift.unitPrice = { currency: 'YUWAN', amountMinor: 100, scale: 1 }
    const plan = await h.service.previewPurchase('default', purchaseInput)
    expect(plan.budget).toEqual({ currency: 'YUWAN', amountMinor: 600, scale: 1 })
    expect((await h.service.execute(plan.id)).status).toBe('completed')
    expect(h.state.YUWAN).toBe(999400)
    expect(h.state.YUCHI).toBe(100000)
  })

  it.each([null, 0, 3599])('refuses unknown or insufficient total budget balance=%s', balance => {
    const h = harness()
    h.state.YUCHI = balance
    return expect(h.service.previewPurchase('default', purchaseInput)).rejects.toMatchObject({ code: 'balance-changed' }).then(() => { expect(h.purchase).not.toHaveBeenCalled() })
  })

  it.each([99000, 101000, null])('stops if wallet state changes after confirmation to %s', balance => {
    const h = harness()
    return h.service.previewPurchase('default', purchaseInput).then(async plan => {
      h.state.YUCHI = balance
      expect(await h.service.execute(plan.id)).toMatchObject({ status: 'failed', reason: 'balance-changed' })
      expect(h.purchase).not.toHaveBeenCalled()
    })
  })

  it('stops on an updated price before the next transaction without expanding budget', async () => {
    const h = harness()
    h.purchase.mockImplementationOnce(async input => {
      h.state.YUCHI! -= input.quantity * input.unitPrice.amountMinor
      h.state.gift.unitPrice!.amountMinor = 700
      return { ...receipt }
    })
    const plan = await h.service.previewPurchase('default', purchaseInput)
    expect(await h.service.execute(plan.id)).toMatchObject({ status: 'waiting-user', reason: 'price-changed', confirmedQuantity: 2 })
    expect(h.purchase).toHaveBeenCalledOnce()
    expect(h.state.YUCHI).toBe(98800)
  })

  it('does not accept an HTTP receipt as proof of the expected wallet deduction', async () => {
    const h = harness()
    h.purchase.mockResolvedValueOnce({ ...receipt })
    const plan = await h.service.previewPurchase('default', purchaseInput)
    expect(await h.service.execute(plan.id)).toMatchObject({ status: 'waiting-user', reason: 'balance-changed', confirmedQuantity: 0,
      rows: [{ status: 'unknown' }] })
    expect(h.purchase).toHaveBeenCalledOnce()
  })

  it.each(['unknown', 'not-submitted'] as const)('never retries or sends the next gift after status=%s', status => {
    const h = harness()
    h.purchase.mockResolvedValueOnce({ status, message: 'SYNTHETIC_PRIVATE_FAILURE' })
    return h.service.previewPurchase('default', purchaseInput).then(async plan => {
      const result = await h.service.execute(plan.id)
      expect(result.status).toBe(status === 'unknown' ? 'waiting-user' : 'failed')
      expect(h.purchase).toHaveBeenCalledOnce()
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE')
      await expect(h.service.execute(plan.id)).rejects.toMatchObject({ code: 'stale-plan' })
    })
  })

  it('keeps account identity private while rejecting a changed UID', async () => {
    const h = harness()
    const plan = await h.service.previewPurchase('default', purchaseInput)
    expect(JSON.stringify(plan)).not.toMatch(/"uid"|SYNTHETIC_PRIVATE/)
    h.state.uid = '99'
    expect(await h.service.execute(plan.id)).toMatchObject({ reason: 'account-changed' })
    expect(h.purchase).not.toHaveBeenCalled()
  })
})

describe('one-use plans, cancellation and the shared write slot', () => {
  it('rejects expired confirmation and changed foreground rooms', async () => {
    const h = harness()
    const expired = await h.service.previewPurchase('default', purchaseInput)
    await vi.advanceTimersByTimeAsync(120001)
    await expect(h.service.execute(expired.id)).rejects.toMatchObject({ code: 'stale-plan' })
    const plan = await h.service.previewPurchase('default', purchaseInput)
    h.tasks.setRoom('200')
    await expect(h.service.execute(plan.id)).rejects.toMatchObject({ code: 'account-changed' })
    expect(h.purchase).not.toHaveBeenCalled()
  })

  it('requires the current room even when another valid room can be resolved', async () => {
    const h = harness()
    await expect(h.service.previewPurchase('default', { ...purchaseInput, room: '200' })).rejects.toMatchObject({ code: 'account-changed' })
    expect(h.readCatalog).not.toHaveBeenCalled()
  })

  it('invalidates an old preview when a fresh one is made or cancelled', async () => {
    const h = harness()
    const first = await h.service.previewPurchase('default', purchaseInput)
    const second = await h.service.previewPurchase('default', { ...purchaseInput, quantity: 1 })
    await expect(h.service.execute(first.id)).rejects.toMatchObject({ code: 'stale-plan' })
    expect(h.service.cancel(second.id)).toEqual({ cancelled: true })
    await expect(h.service.execute(second.id)).rejects.toMatchObject({ code: 'stale-plan' })
    expect(h.purchase).not.toHaveBeenCalled()
  })

  it('claims a plan before awaiting the lane and never replays a completed ID', async () => {
    const h = harness()
    const deferredPurchase = deferred<DouyuGiftReceipt>()
    h.purchase.mockReturnValueOnce(deferredPurchase.promise)
    const plan = await h.service.previewPurchase('default', purchaseInput)
    const executing = h.service.execute(plan.id)
    await flush()
    await expect(h.service.execute(plan.id)).rejects.toMatchObject({ code: 'busy' })
    h.state.YUCHI! -= 1200
    deferredPurchase.resolve({ status: 'unknown', message: 'fixture' })
    expect((await executing).status).toBe('waiting-user')
    await expect(h.service.execute(plan.id)).rejects.toMatchObject({ code: 'stale-plan' })
    expect(h.purchase).toHaveBeenCalledOnce()
  })

  it('keeps a cancelled transport in the serial slot until the network really settles', async () => {
    const h = harness()
    const pending = deferred<DouyuGiftReceipt>()
    h.purchase.mockReturnValueOnce(pending.promise)
    const plan = await h.service.previewPurchase('default', purchaseInput)
    const executing = h.service.execute(plan.id)
    await flush()
    expect(h.purchase).toHaveBeenCalledOnce()
    expect(h.service.cancel(plan.id)).toEqual({ cancelled: true })
    await flush()
    expect((await executing).status).toBe('cancelled')
    await expect(h.service.previewPurchase('default', purchaseInput)).rejects.toMatchObject({ code: 'busy' })
    const other = vi.fn(async () => 'never before settlement')
    expect(await h.tasks.runAccountOperation({ accountId: 'default', originRoom: '100', rooms: ['100'] }, other, new AbortController().signal)).toEqual({ status: 'busy' })
    expect(other).not.toHaveBeenCalled()
    pending.resolve({ status: 'unknown', message: 'fixture' })
    await flush()
    const next = await h.service.previewPurchase('default', { ...purchaseInput, repeat: 1 })
    expect(next.id).not.toBe(plan.id)
    expect(h.purchase).toHaveBeenCalledOnce()
  })

  it('cancels interval waiting without dispatching an extra transaction', async () => {
    const h = harness()
    const plan = await h.service.previewPurchase('default', { ...purchaseInput, intervalMs: 10000 })
    const executing = h.service.execute(plan.id)
    await flush()
    expect(h.purchase).toHaveBeenCalledOnce()
    h.service.cancel(plan.id)
    expect((await executing).status).toBe('cancelled')
    await vi.advanceTimersByTimeAsync(30000)
    expect(h.purchase).toHaveBeenCalledOnce()
  })
})

describe('IPC-sized plan input validation', () => {
  it.each([{ ...purchaseInput, giftId: '0' }, { ...purchaseInput, quantity: -1 }, { ...purchaseInput, repeat: 10001 },
    { ...purchaseInput, intervalMs: -1 }, { ...purchaseInput, unitPrice: 0 }, { ...purchaseInput, budget: 1 },
    { ...purchaseInput, quantity: Number.MAX_SAFE_INTEGER }])('rejects invalid quantities and caller-supplied accounting data %#', value => {
    expect(() => readPurchaseGiftInput(value)).toThrow()
  })

  it.each([{ room: '100', selection: [] }, { room: '100', selection: [{ propId: '777', quantity: 0 }] },
    { room: '100', selection: [{ propId: '777', quantity: 1 }, { propId: '777', quantity: 2 }] },
    { room: '100', selection: 'all', autoBuy: true }])('rejects ambiguous inventory selection %#', value => {
    expect(() => readInventoryGiftInput(value)).toThrow()
  })

  it('does not invoke hostile property getters', () => {
    const getter = vi.fn(() => purchaseInput)
    expect(() => readPurchaseGiftInput(Object.defineProperty({}, 'room', { get: getter }))).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
})

describe('full HTTP fixture flow through the actual gateways and shared task manager', () => {
  const proxy = resolveConfig({}).proxy
  const catalogUrl = 'https://gift.douyucdn.cn/api/gift/v5/web/list?rid=100'
  const purchaseUrl = 'https://www.douyu.com/japi/gift/donate/mainsite/v3'
  const backpackUrl = 'https://www.douyu.com/japi/prop/backpack/web/v5?rid=100'
  const donateUrl = 'https://www.douyu.com/japi/prop/donate/mainsite/v5'
  const deps = { proxy, cookieHeader: async () => 'acf_uid=42; acf_auth=SYNTHETIC_HTTP_FIXTURE', resolve: async () => ['8.8.8.8'] }

  it('completes sequential purchases using real form encoding and independently refreshed balance fixtures', async () => {
    let wallet = 100_000
    const balances = vi.fn(async () => parseDouyuGiftBalance('42', { gold: wallet, silver: 0 }, Date.now()))
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === catalogUrl) return Response.json({ error: 0, data: { onceLimit: 500000, giftList: [{ id: 20002, name: '合成目录礼物',
        basicInfo: { giftType: 0, guardLevel: 0 }, priceInfo: { priceType: 'YUCHI', price: 600 }, donateStatus: 1,
        defaultSkinId: 9, fansLevel: 0, countLimit: 0, isBatchLimited: 0, startTime: 0, endTime: 0 }] } })
      if (String(url) === purchaseUrl && init?.method === 'POST') {
        const form = new URLSearchParams(String(init.body))
        expect(form.get('giftId')).toBe('20002')
        expect(form.get('roomId')).toBe('100')
        const quantity = Number(form.get('giftCount'))
        wallet -= quantity * 600
        return Response.json({ error: 0, data: { gid: 20002, num: quantity, sb: wallet, ry: 0 } })
      }
      throw new Error('No real network or unrelated endpoint allowed')
    })
    const purchaseGateway = new DouyuGiftPurchaseGateway({ ...deps, request }, balances)
    const h = harness({ purchase: purchaseGateway })
    const plan = await h.service.previewPurchase('default', { ...purchaseInput, repeat: 2 })
    expect(h.purchase).not.toHaveBeenCalled()
    expect(await h.service.execute(plan.id)).toMatchObject({ status: 'completed', confirmedQuantity: 4 })
    expect(wallet).toBe(97600)
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
    expect(balances.mock.calls.length).toBeGreaterThanOrEqual(7)
  })

  it('clears a non-batchable ordinary inventory item with real v5 receipts and fresh stock checks', async () => {
    const item = prop(90001, 2, { batchInfo: {} })
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === backpackUrl) return Response.json({ error: 0, data: { list: [{ ...item }] } })
      if (String(url) === donateUrl && init?.method === 'POST') {
        const form = new URLSearchParams(String(init.body))
        expect(form.get('propId')).toBe('90001')
        expect(form.get('propCount')).toBe('1')
        item.count = Number(item.count) - 1
        return Response.json({ error: 0, data: { usedProp: { id: 90001, propType: 1 }, list: [{ ...item }], messages: [] } })
      }
      throw new Error('No real network, purchase or unrelated endpoint allowed')
    })
    const gateway = new DouyuBackpackGateway({ ...deps, request })
    const h = harness({ gateway })
    const plan = await h.service.previewInventory('default', { room: '100', selection: 'all', intervalMs: 0 })
    expect(await h.service.execute(plan.id)).toMatchObject({ status: 'completed', confirmedQuantity: 2 })
    expect(item.count).toBe(0)
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
    expect(h.purchase).not.toHaveBeenCalled()
    expect(h.readBalance).not.toHaveBeenCalled()
  })
})
