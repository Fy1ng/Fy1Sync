/**
 * The backpack spends real items and currency. These tests pin the rules that keep it
 * honest: only a previewed plan is executed, by its id, once; any edit retires the plan;
 * unknown values are never rendered as 0 or 永久; the purchase confirmation shows every
 * number the viewer is about to spend.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { DouyuGiftPlan, DouyuInventorySnapshot } from '../../../server/douyu/inventoryTypes'
import { Backpack } from './Backpack'
import type { DouyuData } from './useDouyu'

type Call = { method: string; args: unknown }
let calls: Call[] = []
let executeReply: () => Promise<unknown>

const inventory: DouyuInventorySnapshot = {
  accountId: 'a1', room: '100', checkedAt: 1_700_000_000_000, message: '',
  items: [
    { propId: '268', name: '荧光棒', quantity: 5, propType: 1, isValuable: false,
      expiration: { kind: 'timestamp', expiresAt: 1_800_000_000_000, dayBucket: null }, rawPrice: 10,
      unitValue: { currency: 'YUWAN', amountMinor: 100, scale: 1 }, totalValue: { currency: 'YUWAN', amountMinor: 500, scale: 1 },
      intimacyPerUnit: 1, intimacyTotal: 5, canGift: true, unavailableReason: null, batchSupported: true },
    { propId: '777', name: '神秘道具', quantity: 2, propType: null, isValuable: null,
      expiration: { kind: 'unknown', expiresAt: null, dayBucket: null }, rawPrice: null,
      unitValue: null, totalValue: null, intimacyPerUnit: null, intimacyTotal: null,
      canGift: false, unavailableReason: '类型不受支持', batchSupported: false },
  ],
  totals: { quantity: 7, knownValue: [{ currency: 'YUWAN', amountMinor: 500, scale: 1 }], unvaluedItems: 1, knownIntimacy: 5, unknownIntimacyItems: 1 },
}

const inventoryPlan = (id: string, quantity: number): DouyuGiftPlan => ({
  id, accountId: 'a1', room: '100', kind: 'inventory', createdAt: Date.now(), expiresAt: Date.now() + 120_000,
  intervalMs: 1000, totalQuantity: quantity, totalOperations: 1, repeat: 1, budget: null, balanceBefore: null,
  rows: [{ propId: '268', giftId: null, name: '荧光棒', quantity, repeat: 1, stock: 5, expiresAt: 1_800_000_000_000,
    unitPrice: { currency: 'YUWAN', amountMinor: 100, scale: 1 }, total: { currency: 'YUWAN', amountMinor: 100 * quantity, scale: 1 } }],
  excludedItems: [{ propId: '777', name: '神秘道具', quantity: 2, reason: '类型不受支持' }], message: '',
})

const purchasePlan = (id: string, input: { giftId: string; quantity: number; repeat: number; intervalMs: number }): DouyuGiftPlan => ({
  id, accountId: 'a1', room: '100', kind: 'purchase', createdAt: Date.now(), expiresAt: Date.now() + 120_000,
  intervalMs: input.intervalMs, totalQuantity: input.quantity * input.repeat, totalOperations: input.repeat, repeat: input.repeat,
  budget: { currency: 'YUCHI', amountMinor: 1000 * input.quantity * input.repeat, scale: 100 },
  balanceBefore: { currency: 'YUCHI', amountMinor: 123_400, scale: 100 },
  rows: [{ propId: null, giftId: input.giftId, name: '飞机', quantity: input.quantity, repeat: input.repeat, stock: null, expiresAt: null,
    unitPrice: { currency: 'YUCHI', amountMinor: 1000, scale: 100 }, total: { currency: 'YUCHI', amountMinor: 1000 * input.quantity * input.repeat, scale: 100 } }],
  excludedItems: [], message: '',
})

beforeEach(() => {
  calls = []
  let plans = 0
  executeReply = async () => ({ status: 'completed', rows: [], submittedQuantity: 1, confirmedQuantity: 1, message: '' })
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      if (method === 'getDouyuInventory') return { ok: true, value: inventory }
      if (method === 'previewDouyuInventoryGift') {
        const { input } = args as { input: { selection: 'all' | { quantity: number }[] } }
        return { ok: true, value: inventoryPlan(`g${++plans}`, input.selection === 'all' ? 5 : input.selection[0]!.quantity) }
      }
      if (method === 'getDouyuGiftCatalog') {
        return { ok: true, value: { room: '100', checkedAt: 1, onceLimit: null, items: [
          { giftId: '195', name: '飞机', unitPrice: { currency: 'YUCHI', amountMinor: 1000, scale: 100 }, skinId: 0, available: true, unavailableReason: null, countLimit: 0 },
          { giftId: '196', name: '火箭', unitPrice: { currency: 'YUCHI', amountMinor: 50000, scale: 100 }, skinId: 0, available: false, unavailableReason: '本房间不可赠', countLimit: null },
        ] } }
      }
      if (method === 'previewDouyuPurchaseGift') return { ok: true, value: purchasePlan(`g${++plans}`, (args as { input: never }).input) }
      if (method === 'executeDouyuGiftPlan') {
        const reply = await executeReply() as object
        return { ok: true, value: { planId: (args as { planId: string }).planId, ...reply } }
      }
      if (method === 'cancelDouyuGiftPlan') return { ok: true, value: { cancelled: true } }
      return { ok: false, code: 'x', message: 'unexpected' }
    }) as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const named = (method: string): Call[] => calls.filter((call) => call.method === method)

const dataFor = (loggedIn = true): DouyuData => ({
  active: { id: 'a1', label: '主号', active: true, busy: false, login: { loggedIn } },
  accountsBusy: false,
  tasks: { activeAccountId: 'a1', currentRoom: '100', retainedRooms: [], tasks: [] },
} as unknown as DouyuData)

async function openPack(): Promise<void> {
  render(<Backpack data={dataFor()} room="100" />)
  await screen.findByRole('region', { name: '背包库存' })
  await screen.findByText('神秘道具')
}

async function toInventoryPlan(quantity = '2'): Promise<void> {
  await openPack()
  fireEvent.change(screen.getByRole('textbox', { name: '荧光棒 赠送数量' }), { target: { value: quantity } })
  fireEvent.click(screen.getByRole('button', { name: '生成预览' }))
  await screen.findByRole('region', { name: '赠送确认单' })
}

describe('backpack inventory', () => {
  it('keeps unknown values unknown and never shows them as 0 or permanent', async () => {
    await openPack()
    const row = screen.getByText('神秘道具').closest('tr')!
    const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent)
    expect(cells.slice(2, 6)).toEqual(['未知', '未知', '未知', '未知'])
    expect(within(row).queryByText('永久')).toBeNull()
    expect(within(row).queryByText(/^0/)).toBeNull()
    const totals = screen.getByLabelText('背包汇总')
    expect(within(totals).getByText('500 鱼丸')).toBeInTheDocument()
    expect(within(totals).getAllByText('1 项')).toHaveLength(2)
    expect(named('getDouyuInventory')[0]!.args).toEqual({ accountId: 'a1', room: '100' })
  })

  it('asks for a sign-in and reads nothing when the account is signed out', () => {
    render(<Backpack data={dataFor(false)} room="100" />)
    expect(screen.getByText('当前账号未登录。请在「账号」中登录后使用背包。')).toBeInTheDocument()
    expect(calls).toEqual([])
  })
})

describe('gifting from the backpack', () => {
  it('executes only the previewed plan, by id, once, even on a double click', async () => {
    let release!: (value: unknown) => void
    executeReply = () => new Promise((resolve) => { release = resolve })
    await toInventoryPlan()
    expect(named('executeDouyuGiftPlan')).toEqual([])
    expect(named('previewDouyuInventoryGift')[0]!.args).toEqual({
      accountId: 'a1', input: { room: '100', selection: [{ propId: '268', quantity: 2 }], intervalMs: 1000 },
    })
    const confirm = screen.getByRole('button', { name: '确认赠送' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    // The second click must neither execute again nor hit the stop button.
    expect(confirm).toBeDisabled()
    expect(screen.getByRole('button', { name: '停止剩余' })).toBeEnabled()
    expect(named('cancelDouyuGiftPlan')).toEqual([])
    await act(async () => { release({ status: 'completed', rows: [], submittedQuantity: 2, confirmedQuantity: 2, message: '' }) })
    await screen.findByRole('region', { name: '赠送结果' })
    expect(named('executeDouyuGiftPlan')).toEqual([{ method: 'executeDouyuGiftPlan', args: { planId: 'g1' } }])
    expect(screen.getByRole('button', { name: '确认赠送' })).toBeDisabled()
  })

  it('retires the plan when a quantity changes, and the stale plan cannot be confirmed', async () => {
    await toInventoryPlan()
    fireEvent.change(screen.getByRole('textbox', { name: '荧光棒 赠送数量' }), { target: { value: '3' } })
    await waitFor(() => expect(named('cancelDouyuGiftPlan')).toEqual([{ method: 'cancelDouyuGiftPlan', args: { planId: 'g1' } }]))
    expect(screen.queryByRole('region', { name: '赠送确认单' })).toBeNull()
    expect(screen.queryByRole('button', { name: '确认赠送' })).toBeNull()
    expect(named('executeDouyuGiftPlan')).toEqual([])
  })

  it('retires the plan when the room or interval changes', async () => {
    await toInventoryPlan()
    fireEvent.change(screen.getByRole('textbox', { name: '目标房间号' }), { target: { value: '200' } })
    await waitFor(() => expect(named('cancelDouyuGiftPlan')).toHaveLength(1))
    expect(screen.queryByRole('region', { name: '赠送确认单' })).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: '目标房间号' }), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: '生成预览' }))
    await screen.findByRole('region', { name: '赠送确认单' })
    fireEvent.change(screen.getByRole('textbox', { name: '赠送间隔（毫秒）' }), { target: { value: '2000' } })
    await waitFor(() => expect(named('cancelDouyuGiftPlan').map((call) => call.args)).toEqual([{ planId: 'g1' }, { planId: 'g2' }]))
    expect(screen.queryByRole('button', { name: '确认赠送' })).toBeNull()
  })

  it('retires an unexecuted plan when the page closes', async () => {
    await toInventoryPlan()
    cleanup()
    expect(named('cancelDouyuGiftPlan')).toEqual([{ method: 'cancelDouyuGiftPlan', args: { planId: 'g1' } }])
    expect(named('executeDouyuGiftPlan')).toEqual([])
  })

  it('rejects a quantity above the stock just read', async () => {
    await openPack()
    fireEvent.change(screen.getByRole('textbox', { name: '荧光棒 赠送数量' }), { target: { value: '6' } })
    expect(screen.getByText('数量须为 1 到当前库存之间的整数')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成预览' })).toBeDisabled()
  })

  it('sends selection all, lists exclusions, and shows unknown outcomes without retrying', async () => {
    executeReply = async () => ({ status: 'waiting-user', reason: 'unconfirmed', submittedQuantity: 5, confirmedQuantity: 0, message: '',
      rows: [{ propId: '268', giftId: null, name: '荧光棒', quantity: 5, repetition: 1, status: 'unknown', message: '' }] })
    await openPack()
    fireEvent.click(screen.getByRole('radio', { name: '全部可赠道具' }))
    fireEvent.click(screen.getByRole('button', { name: '生成预览' }))
    const plan = await screen.findByRole('region', { name: '赠送确认单' })
    expect((named('previewDouyuInventoryGift')[0]!.args as { input: { selection: unknown } }).input.selection).toBe('all')
    expect(within(plan).getByText(/类型不受支持/)).toBeInTheDocument()
    fireEvent.click(within(plan).getByRole('button', { name: '确认赠送' }))
    const result = await screen.findByRole('region', { name: '赠送结果' })
    expect(within(result).getByText('结果未知')).toBeInTheDocument()
    expect(within(result).getByText('已提交 5 · 已收到回执 0')).toBeInTheDocument()
    expect(named('executeDouyuGiftPlan')).toHaveLength(1)
    expect(named('previewDouyuInventoryGift')).toHaveLength(1)
  })
})

describe('buying and sending gifts', () => {
  async function toPurchasePlan(): Promise<HTMLElement> {
    await openPack()
    fireEvent.click(screen.getByRole('radio', { name: '购买礼物' }))
    fireEvent.click(screen.getByRole('button', { name: '读取礼物目录' }))
    await screen.findByRole('radio', { name: '飞机（ID 195）' })
    expect(screen.getByRole('radio', { name: '火箭（ID 196）' })).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: '飞机（ID 195）' }))
    expect(screen.getByRole('button', { name: '生成确认单' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: '每次数量' }), { target: { value: '2' } })
    fireEvent.change(screen.getByRole('textbox', { name: '赠送次数' }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('textbox', { name: '购买赠送间隔（毫秒）' }), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: '生成确认单' }))
    return screen.findByRole('region', { name: '赠送确认单' })
  }

  it('shows every field the viewer is about to spend on before confirming', async () => {
    const plan = await toPurchasePlan()
    expect(named('previewDouyuPurchaseGift')[0]!.args).toEqual({
      accountId: 'a1', input: { room: '100', giftId: '195', quantity: 2, repeat: 3, intervalMs: 500 },
    })
    const facts = Object.fromEntries([...plan.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent ?? '']))
    expect(facts['账号']).toBe('主号')
    expect(facts['目标']).toContain('房间 100')
    expect(facts['礼物']).toContain('飞机')
    expect(facts['礼物']).toContain('ID 195')
    expect(facts['每次数量']).toBe('2')
    expect(facts['次数']).toBe('3')
    expect(facts['总量']).toBe('6')
    expect(facts['间隔']).toBe('500 毫秒')
    expect(facts['单价']).toContain('10 鱼翅')
    expect(facts['单价']).toContain('YUCHI，scale 100')
    expect(facts['预算']).toContain('60 鱼翅')
    expect(facts['赠送前余额']).toContain('1,234 鱼翅')
    expect(facts['确认单有效期']).toMatch(/剩余 \d+ 秒/)
    expect(within(plan).getByText('排除项')).toBeInTheDocument()
    expect(plan.textContent).not.toMatch(/人民币|元/)
    expect(named('executeDouyuGiftPlan')).toEqual([])

    fireEvent.click(within(plan).getByRole('button', { name: '确认赠送' }))
    await screen.findByRole('region', { name: '赠送结果' })
    expect(named('executeDouyuGiftPlan')).toEqual([{ method: 'executeDouyuGiftPlan', args: { planId: 'g1' } }])
  })

  it('retires the purchase plan when the repeat count changes', async () => {
    await toPurchasePlan()
    fireEvent.change(screen.getByRole('textbox', { name: '赠送次数' }), { target: { value: '4' } })
    await waitFor(() => expect(named('cancelDouyuGiftPlan')).toEqual([{ method: 'cancelDouyuGiftPlan', args: { planId: 'g1' } }]))
    expect(screen.queryByRole('button', { name: '确认赠送' })).toBeNull()
  })

  it('rejects a repeat count above 10000', async () => {
    await openPack()
    fireEvent.click(screen.getByRole('radio', { name: '购买礼物' }))
    fireEvent.click(screen.getByRole('button', { name: '读取礼物目录' }))
    fireEvent.click(await screen.findByRole('radio', { name: '飞机（ID 195）' }))
    fireEvent.change(screen.getByRole('textbox', { name: '每次数量' }), { target: { value: '1' } })
    fireEvent.change(screen.getByRole('textbox', { name: '赠送次数' }), { target: { value: '10001' } })
    expect(screen.getByText('次数须为 1 到 10000 的整数')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成确认单' })).toBeDisabled()
  })
})
