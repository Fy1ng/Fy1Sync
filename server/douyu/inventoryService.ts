import { types as utilTypes } from 'node:util'
import { isDouyuAccountId } from '../../electron/douyuAccounts'
import type { DouyuTaskManager } from '../../electron/douyuTasks'
import type { ResolveDouyuRoom } from '../platforms/douyuRoom'
import { validDouyuRoom } from '../platforms/douyuRoom'
import { abortable, cancelled } from './actionHttp'
import type { DouyuBackpackGateway } from './backpackGateway'
import type { DouyuGiftCurrency, DouyuGiftMoney, DouyuInventoryItem, DouyuInventorySnapshot } from './inventoryTypes'

const MAX_SECONDS = 253_402_300_799
const MESSAGES = {
  'invalid-arguments': '背包查询参数无效.',
  'invalid-data': '斗鱼背包数据无法完整核对, 请重新读取.',
  'account-changed': '所选账号或房间已变化, 请重新读取.',
  cancelled: '背包查询已取消.',
} as const

export class DouyuInventoryError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) { super(MESSAGES[code]); this.name = 'DouyuInventoryError' }
}

const fail = (): never => { throw new DouyuInventoryError('invalid-data') }

/** No getters, proxies, inherited data or ambiguous numeric coercions. */
export function inventoryFields(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || utilTypes.isProxy(raw) || Array.isArray(raw)) return fail()
  if (![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return fail()
  const keys = Reflect.ownKeys(raw)
  if (keys.length > 512) return fail()
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) return fail()
    result[key] = descriptor.value
  }
  return result
}

export function inventoryArray(raw: unknown, maximum = 512): unknown[] {
  if (!raw || typeof raw !== 'object' || utilTypes.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return fail()
  const length: unknown = Object.getOwnPropertyDescriptor(raw, 'length')?.value
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum || Reflect.ownKeys(raw).length !== length + 1) return fail()
  const result: unknown[] = []
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index))
    if (!descriptor || !('value' in descriptor)) return fail()
    result.push(descriptor.value)
  }
  return result
}

export function inventoryInteger(raw: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(raw) ? Number(raw) : NaN
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : null
}

export function inventoryName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 256) return fail()
  const value = raw.replace(/[\x00-\x1f\x7f-\x9f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu, '').replace(/\s+/gu, ' ').trim()
  if (!value || value.length > 128) return fail()
  return value
}

export function giftMoney(currency: DouyuGiftCurrency, amountMinor: number): DouyuGiftMoney {
  if (!['YUCHI', 'YUWAN'].includes(currency) || inventoryInteger(amountMinor) === null) return fail()
  return { currency, amountMinor, scale: currency === 'YUCHI' ? 100 : 1 }
}

export function multiplyGiftMoney(value: DouyuGiftMoney, quantity: number): DouyuGiftMoney | null {
  const amount = value.amountMinor * quantity
  return Number.isSafeInteger(amount) && amount >= 0 ? giftMoney(value.currency, amount) : null
}

function truth(raw: unknown): boolean | null {
  return raw === 0 || raw === '0' || raw === false ? false : raw === 1 || raw === '1' || raw === true ? true : null
}

/** expiry is an official display day bucket. Only met supplies execution timestamps. */
export function parseDouyuInventory(payload: unknown, now: number): DouyuInventoryItem[] {
  if (inventoryInteger(now, MAX_SECONDS * 1000) === null) return fail()
  const fields = inventoryFields(payload)
  if (Object.hasOwn(fields, 'error') && inventoryInteger(fields.error) !== 0) return fail()
  if (Object.hasOwn(fields, 'success') && truth(fields.success) !== true) return fail()
  const seen = new Set<string>()
  return inventoryArray(fields.list).map(raw => {
    const item = inventoryFields(raw)
    const id = inventoryInteger(item.id)
    const quantity = inventoryInteger(item.count)
    if (!id || quantity === null || seen.has(String(id))) return fail()
    seen.add(String(id))
    const propType = inventoryInteger(item.propType, 255)
    const isClick = inventoryInteger(item.isClick, 255)
    const isValuable = truth(item.isValuable)
    const permanent = item.met === -1 || item.met === '-1'
    const seconds = permanent ? null : inventoryInteger(item.met, MAX_SECONDS)
    const bucket = inventoryInteger(item.expiry, 7)
    const expiration: DouyuInventoryItem['expiration'] = {
      kind: permanent ? 'permanent' : seconds === null ? 'unknown' : 'timestamp',
      expiresAt: seconds === null ? null : seconds * 1000,
      dayBucket: bucket !== null && bucket >= 1 ? bucket : null,
    }
    const rawPrice = inventoryInteger(item.price)
    const currency = item.priceType === 'YUCHI' || item.priceType === 'YUWAN' ? item.priceType : null
    // A bare backpack price can be an intimacy/display value. Do not label it as money.
    const unitValue = currency && rawPrice !== null ? giftMoney(currency, rawPrice) : null
    const intimacyPerUnit = inventoryInteger(item.intimate)
    const intimacyTotal = intimacyPerUnit === null || !Number.isSafeInteger(intimacyPerUnit * quantity) ? null : intimacyPerUnit * quantity
    let batchSupported = false
    if (item.batchInfo !== undefined) {
      const batches = inventoryFields(item.batchInfo)
      batchSupported = Object.keys(batches).length > 0 && Object.values(batches).every(value => {
        const entry = inventoryFields(value)
        const count = inventoryInteger(entry.batchNum)
        return count !== null && count > 0
      })
    }
    const reason = propType === null ? '道具用途未知, 不可自动赠送.'
      : propType === 5 ? '这是领取入口, 不是可赠库存.'
        : propType >= 7 && propType <= 10 ? '这是兑换道具, 不执行兑换.'
          : ![0, 1, 2].includes(propType) ? '此道具的通用赠送或财务语义尚未核验.'
            : item.extPropType !== undefined && item.extPropType !== '' ? '这是特殊权益道具, 不可通用赠送.'
              : isClick !== 1 ? '当前可用状态未确认, 不可赠送.'
                : isValuable === null ? '价值属性未知, 不可赠送.'
                  : quantity < 1 ? '没有可用库存.'
                    : expiration.kind === 'unknown' ? '无法确认准确到期时间, 暂不可赠送.'
                      : expiration.expiresAt !== null && expiration.expiresAt <= now + 5000 ? '已过期或即将过期, 不可赠送.' : null
    return {
      propId: String(id), name: inventoryName(item.name), quantity, propType, isValuable, expiration,
      rawPrice, unitValue, totalValue: unitValue ? multiplyGiftMoney(unitValue, quantity) : null,
      intimacyPerUnit, intimacyTotal, canGift: reason === null, unavailableReason: reason, batchSupported,
    }
  })
}

export function inventorySnapshot(accountId: string, room: string, checkedAt: number, items: DouyuInventoryItem[]): DouyuInventorySnapshot {
  let quantity = 0
  let knownIntimacy = 0
  const values = new Map<DouyuGiftCurrency, number>()
  for (const item of items) {
    quantity += item.quantity
    if (item.intimacyTotal !== null) knownIntimacy += item.intimacyTotal
    if (item.totalValue) values.set(item.totalValue.currency, (values.get(item.totalValue.currency) ?? 0) + item.totalValue.amountMinor)
  }
  if (![quantity, knownIntimacy, ...values.values()].every(Number.isSafeInteger)) return fail()
  return { accountId, room, checkedAt, items: structuredClone(items), totals: {
    quantity, knownValue: [...values].map(([currency, amount]) => giftMoney(currency, amount)),
    unvaluedItems: items.filter(item => item.totalValue === null && item.quantity > 0).length,
    knownIntimacy, unknownIntimacyItems: items.filter(item => item.intimacyTotal === null && item.quantity > 0).length,
  }, message: '未提供的价值和亲密度显示为未知. 剩余天数仅供参考, 具体到期时间以斗鱼显示为准. 亲密度按道具标注显示, 实际到账以斗鱼为准; 金额未折算成人民币.' }
}

export interface DouyuInventoryDependencies {
  gateway: Pick<DouyuBackpackGateway, 'readBackpack'>
  tasks: Pick<DouyuTaskManager, 'snapshot'>
  accountReady: (id: string) => boolean
  resolveRoom: ResolveDouyuRoom
  now?: () => number
}

export class DouyuInventoryService {
  private reading: { accountId: string; controller: AbortController } | null = null
  private disposed = false
  constructor(private readonly deps: DouyuInventoryDependencies) {}

  async read(accountId: string, room?: string): Promise<DouyuInventorySnapshot> {
    if (!isDouyuAccountId(accountId)) throw new DouyuInventoryError('invalid-arguments')
    const scope = this.deps.tasks.snapshot()
    const target = room ?? scope.currentRoom
    if (!target || !validDouyuRoom(target)) throw new DouyuInventoryError('invalid-arguments')
    const ensureCurrent = () => {
      const current = this.deps.tasks.snapshot()
      if (this.disposed || current.activeAccountId !== accountId || !this.deps.accountReady(accountId) || current.currentRoom !== scope.currentRoom) throw new DouyuInventoryError('account-changed')
    }
    ensureCurrent()
    this.reading?.controller.abort()
    const reading = { accountId, controller: new AbortController() }
    this.reading = reading
    const timer = setTimeout(() => reading.controller.abort(), 45_000)
    try {
      const signal = reading.controller.signal
      const identity = await abortable(this.deps.resolveRoom(target), signal)
      ensureCurrent()
      if (!identity.ok || identity.identity.room !== target) throw new DouyuInventoryError('invalid-data')
      const response = await abortable(this.deps.gateway.readBackpack(accountId, target, signal), signal)
      ensureCurrent()
      if (this.reading !== reading || signal.aborted) throw cancelled()
      const now = (this.deps.now ?? Date.now)()
      return inventorySnapshot(accountId, target, now, parseDouyuInventory(response.payload, now))
    } catch (error) {
      if (reading.controller.signal.aborted) throw new DouyuInventoryError('cancelled')
      throw error instanceof DouyuInventoryError ? new DouyuInventoryError(error.code) : new DouyuInventoryError('invalid-data')
    } finally {
      clearTimeout(timer)
      if (this.reading === reading) this.reading = null
    }
  }

  invalidate(accountId: string): void { if (this.reading?.accountId === accountId) this.reading.controller.abort() }
  dispose(): void { this.disposed = true; this.reading?.controller.abort() }
}
