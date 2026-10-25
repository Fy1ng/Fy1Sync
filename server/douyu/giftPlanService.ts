import { randomUUID } from 'node:crypto'
import { isDouyuAccountId } from '../../electron/douyuAccounts'
import type { DouyuTaskManager } from '../../electron/douyuTasks'
import type { ResolveDouyuRoom } from '../platforms/douyuRoom'
import { validDouyuRoom } from '../platforms/douyuRoom'
import { abortable, cancelled } from './actionHttp'
import type { DouyuBackpackGateway } from './backpackGateway'
import type { DouyuGiftPurchaseGateway } from './giftPurchaseGateway'
import { giftMoney, inventoryArray, inventoryFields, inventoryInteger, multiplyGiftMoney, parseDouyuInventory } from './inventoryService'
import type { DouyuGiftCatalog, DouyuGiftCatalogItem, DouyuGiftMoney, DouyuGiftPlan, DouyuGiftPlanRow, DouyuGiftReceipt, DouyuGiftResult, DouyuGiftResultRow, DouyuInventoryGiftInput, DouyuInventoryItem, DouyuPurchaseGiftInput } from './inventoryTypes'

const PLAN_TTL_MS = 120_000
const MAX_OPERATIONS = 10_000
const MESSAGES = {
  'invalid-arguments': '赠礼参数无效, 请重新选择.',
  'invalid-data': '赠礼数据无法完整核对, 请重新预览.',
  'account-changed': '所选账号或房间已变化, 请重新预览.',
  'stale-plan': '赠礼计划已过期或状态已变化, 请重新预览.',
  'inventory-changed': '可赠库存已变化, 已停止后续赠送.',
  'price-changed': '礼物价格或可赠状态已变化, 已停止后续赠送.',
  'balance-changed': '余额未知, 不足或已变化, 已停止后续赠送.',
  unavailable: '当前没有可确认的赠礼条件.',
  busy: '已有赠礼操作尚未结束.',
  cancelled: '赠礼操作已取消.',
} as const

export class DouyuGiftPlanError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) { super(MESSAGES[code]); this.name = 'DouyuGiftPlanError' }
}

export interface DouyuGiftPlanDependencies {
  gateway: Pick<DouyuBackpackGateway, 'readBackpack' | 'donateInventory'>
  purchase: Pick<DouyuGiftPurchaseGateway, 'readCatalog' | 'readBalance' | 'purchase'>
  tasks: Pick<DouyuTaskManager, 'snapshot' | 'runAccountOperation'>
  accountReady: (id: string) => boolean
  resolveRoom: ResolveDouyuRoom
  now?: () => number
  id?: () => string
}

type StoredPlan = {
  public: DouyuGiftPlan
  uid: string
  originRoom: string
  inventory: Map<string, DouyuInventoryItem>
  gift: DouyuGiftCatalogItem | null
  onceLimit: number | null
}
type Execution = { plan: StoredPlan; controller: AbortController; entered: boolean; settled: boolean; rows: DouyuGiftResultRow[] }
const copy = <T>(value: T): T => structuredClone(value)
const planId = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)
const invalid = (): never => { throw new DouyuGiftPlanError('invalid-arguments') }
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const propId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
const equals = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

function fields(raw: unknown, keys: string[]): Record<string, unknown> {
  try {
    const result = inventoryFields(raw)
    if (Object.keys(result).some(key => !keys.includes(key))) return invalid()
    return result
  } catch { return invalid() }
}

function interval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 60_000) return invalid()
  return value
}

export function readInventoryGiftInput(raw: unknown): DouyuInventoryGiftInput {
  const value = fields(raw, ['room', 'selection', 'intervalMs'])
  if (typeof value.room !== 'string' || !validDouyuRoom(value.room)) return invalid()
  const intervalMs = interval(value.intervalMs ?? 1000)
  if (value.selection === 'all') return { room: value.room, selection: 'all', intervalMs }
  let items: unknown[]
  try { items = inventoryArray(value.selection) } catch { return invalid() }
  if (!items.length) return invalid()
  const seen = new Set<string>()
  const selection = items.map(rawItem => {
    const item = fields(rawItem, ['propId', 'quantity'])
    if (!propId(item.propId) || !positive(item.quantity) || seen.has(item.propId)) return invalid()
    seen.add(item.propId)
    return { propId: item.propId, quantity: item.quantity }
  })
  return { room: value.room, selection, intervalMs }
}

export function readPurchaseGiftInput(raw: unknown): DouyuPurchaseGiftInput {
  const value = fields(raw, ['room', 'giftId', 'quantity', 'repeat', 'intervalMs'])
  if (typeof value.room !== 'string' || !validDouyuRoom(value.room) || !propId(value.giftId) || !positive(value.quantity)
    || !positive(value.repeat) || value.repeat > MAX_OPERATIONS || !Number.isSafeInteger(value.quantity * value.repeat)) return invalid()
  const intervalMs = interval(value.intervalMs)
  if (intervalMs * (value.repeat - 1) > 86_400_000) return invalid()
  return { room: value.room, giftId: value.giftId, quantity: value.quantity, repeat: value.repeat, intervalMs }
}

/** Count-derived fields are checked separately after each operation. */
function inventoryIdentity(item: DouyuInventoryItem): unknown {
  const { quantity: _quantity, totalValue: _totalValue, intimacyTotal: _intimacyTotal, canGift: _canGift, unavailableReason: _reason, ...identity } = item
  return identity
}

function problem(error: unknown): DouyuGiftPlanError {
  return error instanceof DouyuGiftPlanError ? new DouyuGiftPlanError(error.code) : new DouyuGiftPlanError('invalid-data')
}

function safeReceipt(receipt: DouyuGiftReceipt): DouyuGiftReceipt['status'] {
  return receipt?.status === 'receipt-received' || receipt?.status === 'not-submitted' ? receipt.status : 'unknown'
}

/** Immutable preview, explicit execution, one-use ID, shared main-process write lane. */
export class DouyuGiftPlanService {
  private readonly now: () => number
  private readonly id: () => string
  private plan: StoredPlan | null = null
  private reading: { accountId: string; controller: AbortController } | null = null
  private execution: Execution | null = null
  private disposed = false

  constructor(private readonly deps: DouyuGiftPlanDependencies) { this.now = deps.now ?? Date.now; this.id = deps.id ?? randomUUID }

  private scope(accountId: string, room: string): void {
    if (!isDouyuAccountId(accountId) || !validDouyuRoom(room)) return invalid()
    const state = this.deps.tasks.snapshot()
    if (this.disposed || state.activeAccountId !== accountId || state.currentRoom !== room || !this.deps.accountReady(accountId)) throw new DouyuGiftPlanError('account-changed')
  }

  private async read<T>(accountId: string, room: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.execution) throw new DouyuGiftPlanError('busy')
    this.scope(accountId, room)
    this.reading?.controller.abort()
    this.plan = null
    const request = { accountId, controller: new AbortController() }
    this.reading = request
    const timer = setTimeout(() => request.controller.abort(), 45_000)
    try {
      const identity = await abortable(this.deps.resolveRoom(room), request.controller.signal)
      if (!identity.ok || identity.identity.room !== room) throw new DouyuGiftPlanError('invalid-data')
      const result = await abortable(operation(request.controller.signal), request.controller.signal)
      this.scope(accountId, room)
      if (this.reading !== request || request.controller.signal.aborted) throw cancelled()
      return result
    } catch (error) {
      if (request.controller.signal.aborted) throw new DouyuGiftPlanError('cancelled')
      throw problem(error)
    } finally { clearTimeout(timer); if (this.reading === request) this.reading = null }
  }

  async catalog(accountId: string, room: string): Promise<DouyuGiftCatalog> {
    return this.read(accountId, room, async signal => copy(await this.deps.purchase.readCatalog(room, signal)))
  }

  async previewInventory(accountId: string, raw: unknown): Promise<DouyuGiftPlan> {
    const input = readInventoryGiftInput(raw)
    return this.read(accountId, input.room, async signal => {
      const before = await this.deps.gateway.readBackpack(accountId, input.room, signal)
      const items = parseDouyuInventory(before.payload, this.now())
      const byId = new Map(items.map(item => [item.propId, item]))
      const selected = input.selection === 'all' ? items.filter(item => item.canGift).map(item => ({ propId: item.propId, quantity: item.quantity })) : input.selection
      const inventory = new Map<string, DouyuInventoryItem>()
      const rows: DouyuGiftPlanRow[] = selected.map(selection => {
        const item = byId.get(selection.propId)
        if (!item?.canGift || item.quantity < selection.quantity) throw new DouyuGiftPlanError('inventory-changed')
        inventory.set(item.propId, copy(item))
        return { propId: item.propId, giftId: null, name: item.name, quantity: item.batchSupported ? selection.quantity : 1,
          repeat: item.batchSupported ? 1 : selection.quantity, stock: item.quantity, expiresAt: item.expiration.expiresAt,
          unitPrice: item.unitValue, total: item.unitValue ? multiplyGiftMoney(item.unitValue, selection.quantity) : null }
      })
      const totalQuantity = selected.reduce((sum, item) => sum + item.quantity, 0)
      const totalOperations = rows.reduce((sum, row) => sum + row.repeat, 0)
      if (!totalQuantity) throw new DouyuGiftPlanError('unavailable')
      if (!Number.isSafeInteger(totalQuantity) || totalOperations > MAX_OPERATIONS || totalOperations * input.intervalMs! > 86_400_000) return invalid()
      const result = this.create({ accountId, room: input.room, kind: 'inventory', rows, totalQuantity, totalOperations, repeat: 1,
        intervalMs: input.intervalMs!, budget: null, balanceBefore: null,
        excludedItems: items.filter(item => !item.canGift).map(item => ({ propId: item.propId, name: item.name, quantity: item.quantity, reason: item.unavailableReason! })),
        message: '按下列数量赠送已有可赠库存. 非通用物品保留. 不购买, 不领取, 库存不足时停止. 标称价值和亲密度不代表实际到账.' })
      this.scope(accountId, input.room)
      if (signal.aborted) throw cancelled()
      this.plan = { public: copy(result), uid: before.uid, originRoom: input.room, inventory, gift: null, onceLimit: null }
      return copy(result)
    })
  }

  async previewPurchase(accountId: string, raw: unknown): Promise<DouyuGiftPlan> {
    const input = readPurchaseGiftInput(raw)
    return this.read(accountId, input.room, async signal => {
      const catalog = await this.deps.purchase.readCatalog(input.room, signal)
      const gift = catalog.items.find(item => item.giftId === input.giftId)
      if (!gift?.available || !gift.unitPrice || (gift.countLimit !== null && gift.countLimit > 0 && input.quantity > gift.countLimit)) throw new DouyuGiftPlanError('price-changed')
      const budget = multiplyGiftMoney(gift.unitPrice, input.quantity * input.repeat)
      const total = multiplyGiftMoney(gift.unitPrice, input.quantity)
      if (!budget || !total) return invalid()
      const balance = await this.deps.purchase.readBalance(accountId, input.room, signal)
      const available = balance.balances[budget.currency]
      if (available === null || inventoryInteger(available) === null || available < budget.amountMinor) throw new DouyuGiftPlanError('balance-changed')
      const result = this.create({ accountId, room: input.room, kind: 'purchase', intervalMs: input.intervalMs, repeat: input.repeat,
        rows: [{ propId: null, giftId: gift.giftId, name: gift.name, quantity: input.quantity, repeat: input.repeat, stock: null,
          expiresAt: null, unitPrice: gift.unitPrice, total: budget }], totalQuantity: input.quantity * input.repeat, totalOperations: input.repeat,
        budget, balanceBefore: giftMoney(budget.currency, available), excludedItems: [],
        message: '确认后按所示次数, 间隔和总预算购买赠送. 每笔重新核对价格与余额, 变化或结果未知即停. 不充值或追加预算; 榜单与亲密度到账另行核对.' })
      this.scope(accountId, input.room)
      if (signal.aborted) throw cancelled()
      this.plan = { public: copy(result), uid: balance.uid, originRoom: input.room, inventory: new Map(), gift: copy(gift), onceLimit: catalog.onceLimit }
      return copy(result)
    })
  }

  private create(fields: Omit<DouyuGiftPlan, 'id' | 'createdAt' | 'expiresAt'>): DouyuGiftPlan {
    const id = this.id()
    if (!planId(id)) throw new DouyuGiftPlanError('invalid-data')
    const createdAt = this.now()
    return { ...copy(fields), id, createdAt, expiresAt: createdAt + PLAN_TTL_MS }
  }

  cancel(id: string): { cancelled: boolean } {
    if (!planId(id)) return invalid()
    if (this.execution?.plan.public.id === id) { this.execution.controller.abort(); return { cancelled: true } }
    if (this.plan?.public.id === id) { this.plan = null; return { cancelled: true } }
    return { cancelled: false }
  }

  invalidate(accountId: string): void {
    if (this.reading?.accountId === accountId) this.reading.controller.abort()
    if (this.plan?.public.accountId === accountId) this.plan = null
    if (this.execution?.plan.public.accountId === accountId) this.execution.controller.abort()
  }

  dispose(): void { this.disposed = true; this.plan = null; this.reading?.controller.abort(); this.execution?.controller.abort() }

  async execute(id: string): Promise<DouyuGiftResult> {
    if (!planId(id)) return invalid()
    if (this.execution) throw new DouyuGiftPlanError('busy')
    const plan = this.plan
    if (!plan || plan.public.id !== id || plan.public.expiresAt <= this.now()) throw new DouyuGiftPlanError('stale-plan')
    this.scope(plan.public.accountId, plan.originRoom)
    this.plan = null
    const execution: Execution = { plan, controller: new AbortController(), entered: false, settled: false, rows: [] }
    this.execution = execution
    const maximumDuration = Math.min(2_147_483_647, plan.public.totalOperations * (60_000 + plan.public.intervalMs) + 45_000)
    const timer = setTimeout(() => execution.controller.abort(), maximumDuration)
    try {
      const outcome = await this.deps.tasks.runAccountOperation({ accountId: plan.public.accountId, originRoom: plan.originRoom, rooms: [plan.public.room] }, async signal => {
        execution.entered = true
        try { return await this.perform(execution, signal) }
        finally { execution.settled = true; if (this.execution === execution) this.execution = null }
      }, execution.controller.signal)
      if (outcome.status === 'completed') return copy(outcome.value)
      return this.result(execution, outcome.status === 'cancelled' ? 'cancelled' : 'failed', outcome.status === 'cancelled'
        ? '赠礼已停止. 可能已提交的项目需在官方房间核对, 不会自动重送.' : '执行队列未能开始或完成本次操作, 请重新预览.',
      outcome.status === 'cancelled' ? 'cancelled' : outcome.status === 'busy' ? 'queue-busy' : 'unavailable')
    } finally {
      clearTimeout(timer)
      if ((!execution.entered || execution.settled) && this.execution === execution) this.execution = null
    }
  }

  private ensureCurrent(plan: StoredPlan, signal: AbortSignal): void {
    if (signal.aborted) throw cancelled()
    this.scope(plan.public.accountId, plan.originRoom)
  }

  private result(execution: Execution, status: DouyuGiftResult['status'], message: string, reason?: DouyuGiftResult['reason']): DouyuGiftResult {
    return { planId: execution.plan.public.id, status, rows: copy(execution.rows),
      submittedQuantity: execution.rows.filter(row => row.status !== 'not-submitted').reduce((sum, row) => sum + row.quantity, 0),
      confirmedQuantity: execution.rows.filter(row => row.status === 'receipt-received').reduce((sum, row) => sum + row.quantity, 0), message, ...(reason ? { reason } : {}) }
  }

  private async waitInterval(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (!milliseconds) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds) }), signal) }
    finally { clearTimeout(timer) }
  }

  private async perform(execution: Execution, signal: AbortSignal): Promise<DouyuGiftResult> {
    const plan = execution.plan
    const stocks = new Map([...plan.inventory].map(([id, item]) => [id, item.quantity]))
    let balance = plan.public.balanceBefore?.amountMinor ?? null
    let spent = 0
    try {
      this.ensureCurrent(plan, signal)
      if (this.now() >= plan.public.expiresAt) throw new DouyuGiftPlanError('stale-plan')
      for (const row of plan.public.rows) for (let repetition = 1; repetition <= row.repeat; repetition++) {
        if (execution.rows.length) await this.waitInterval(plan.public.intervalMs, signal)
        this.ensureCurrent(plan, signal)
        const identity = await abortable(this.deps.resolveRoom(plan.public.room), signal)
        this.ensureCurrent(plan, signal)
        if (!identity.ok || identity.identity.room !== plan.public.room) throw new DouyuGiftPlanError('stale-plan')
        let quantityBefore: number | null = null
        let inventoryBefore: DouyuInventoryItem | null = null
        let cost: DouyuGiftMoney | null = null
        if (row.propId) {
          const before = await abortable(this.deps.gateway.readBackpack(plan.public.accountId, plan.public.room, signal), signal)
          this.ensureCurrent(plan, signal)
          if (before.uid !== plan.uid) throw new DouyuGiftPlanError('account-changed')
          const item = parseDouyuInventory(before.payload, this.now()).find(item => item.propId === row.propId)
          const approved = plan.inventory.get(row.propId)!
          if (!item?.canGift || item.quantity !== stocks.get(row.propId) || item.quantity < row.quantity
            || !equals(inventoryIdentity(item), inventoryIdentity(approved))) throw new DouyuGiftPlanError('inventory-changed')
          quantityBefore = item.quantity
          inventoryBefore = copy(item)
        } else {
          const catalog = await abortable(this.deps.purchase.readCatalog(plan.public.room, signal), signal)
          this.ensureCurrent(plan, signal)
          const gift = catalog.items.find(item => item.giftId === row.giftId)
          if (!gift?.available || !equals(gift, plan.gift) || catalog.onceLimit !== plan.onceLimit) throw new DouyuGiftPlanError('price-changed')
          const current = await abortable(this.deps.purchase.readBalance(plan.public.accountId, plan.public.room, signal), signal)
          this.ensureCurrent(plan, signal)
          if (current.uid !== plan.uid) throw new DouyuGiftPlanError('account-changed')
          cost = multiplyGiftMoney(row.unitPrice!, row.quantity)
          if (!cost || balance === null || current.balances[cost.currency] !== balance || balance < cost.amountMinor
            || spent + cost.amountMinor > plan.public.budget!.amountMinor) throw new DouyuGiftPlanError('balance-changed')
        }
        this.ensureCurrent(plan, signal)
        const output: DouyuGiftResultRow = { propId: row.propId, giftId: row.giftId, name: row.name, quantity: row.quantity, repetition,
          status: 'unknown', message: '本次请求可能已提交, 尚未完成核对.' }
        execution.rows.push(output)
        // Never race a dispatched write: cancellation retains the shared slot until it settles.
        const receipt = row.propId ? await this.deps.gateway.donateInventory({ accountId: plan.public.accountId, expectedUid: plan.uid,
          room: plan.public.room, propId: row.propId, quantity: row.quantity, expectedInventory: inventoryBefore! }, signal)
          : await this.deps.purchase.purchase({ accountId: plan.public.accountId, expectedUid: plan.uid, room: plan.public.room,
            giftId: row.giftId!, quantity: row.quantity, skinId: plan.gift!.skinId, unitPrice: row.unitPrice!, expectedBalance: balance! }, signal)
        this.ensureCurrent(plan, signal)
        const receiptStatus = safeReceipt(receipt)
        if (receiptStatus !== 'receipt-received') {
          output.status = receiptStatus
          output.message = receiptStatus === 'not-submitted' ? '此笔未提交, 后续操作已停止.' : '此笔结果未知, 后续操作已停止, 不会自动重送.'
          return this.result(execution, receiptStatus === 'unknown' ? 'waiting-user' : 'failed', output.message, receiptStatus === 'unknown' ? 'unconfirmed' : 'unavailable')
        }
        if (row.propId) {
          const after = await abortable(this.deps.gateway.readBackpack(plan.public.accountId, plan.public.room, signal), signal)
          this.ensureCurrent(plan, signal)
          if (after.uid !== plan.uid) throw new DouyuGiftPlanError('account-changed')
          const remaining = parseDouyuInventory(after.payload, this.now()).find(item => item.propId === row.propId)
          const expected = quantityBefore! - row.quantity
          if ((remaining?.quantity ?? 0) !== expected || (remaining && !equals(inventoryIdentity(remaining), inventoryIdentity(plan.inventory.get(row.propId)!)))) throw new DouyuGiftPlanError('inventory-changed')
          stocks.set(row.propId, expected)
        } else {
          const after = await abortable(this.deps.purchase.readBalance(plan.public.accountId, plan.public.room, signal), signal)
          this.ensureCurrent(plan, signal)
          if (after.uid !== plan.uid) throw new DouyuGiftPlanError('account-changed')
          if (after.balances[cost!.currency] !== balance! - cost!.amountMinor) throw new DouyuGiftPlanError('balance-changed')
          balance = balance! - cost!.amountMinor
          spent += cost!.amountMinor
        }
        output.status = 'receipt-received'
        output.message = row.propId ? '已收到赠送回执, 库存变化已核对.' : '已收到赠送回执, 余额扣除已核对.'
      }
      return this.result(execution, 'completed', '计划内赠礼处理完成, 回执和库存或余额已核对. 榜单, 亲密度与续期效果仍需独立核对.')
    } catch (error) {
      const issue = signal.aborted ? new DouyuGiftPlanError('cancelled') : problem(error)
      const submitted = execution.rows.some(row => row.status !== 'not-submitted')
      const reason: DouyuGiftResult['reason'] = issue.code === 'stale-plan' ? 'plan-changed'
        : ['inventory-changed', 'balance-changed', 'price-changed', 'account-changed', 'cancelled'].includes(issue.code) ? issue.code as DouyuGiftResult['reason']
          : submitted ? 'unconfirmed' : 'unavailable'
      return this.result(execution, signal.aborted ? 'cancelled' : submitted ? 'waiting-user' : 'failed', `${issue.message} 已可能提交的项目不会自动重送.`, reason)
    }
  }
}
