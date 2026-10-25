/** Fixed official purchase route. No recharge, retries, fallback purchases or arbitrary URLs. */
import { hostAllowed } from '../config'
import { safeFetch } from '../safeFetch'
import { validDouyuRoom } from '../platforms/douyuRoom'
import type { DouyuActionDependencies } from './actions'
import { abortable, cancelBody } from './actionHttp'
import { DouyuBackpackGateway, DouyuRenewalGatewayError, parseDouyuGatewayJson } from './backpackGateway'
import { giftMoney, inventoryArray, inventoryFields, inventoryInteger, inventoryName, multiplyGiftMoney } from './inventoryService'
import type { DouyuGiftBalanceProvider, DouyuGiftBalanceRead, DouyuGiftCatalog, DouyuGiftCatalogItem, DouyuGiftPurchase, DouyuGiftReceipt } from './inventoryTypes'

const PURCHASE_URL = 'https://www.douyu.com/japi/gift/donate/mainsite/v3'
const CATALOG_HOST = 'gift.douyucdn.cn'
const CATALOG_URL = `https://${CATALOG_HOST}/api/gift/v5/web/list`
const validUid = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
const zero = (value: unknown) => value === 0 || value === '0'
const invalid = (): never => { throw new DouyuRenewalGatewayError('invalid-data') }
const notSubmitted = (message: string): DouyuGiftReceipt => ({ status: 'not-submitted', message })
const unknownReceipt = (): DouyuGiftReceipt => ({ status: 'unknown', message: '本次礼物可能已提交, 结果尚未确认. 请在官方房间核对, 不会自动重送.' })

/** Gold is hundredths of a fish fin; silver is an integer fish-ball balance. */
export function parseDouyuGiftBalance(uid: string, payload: unknown, checkedAt: number): DouyuGiftBalanceRead {
  if (!validUid(uid) || inventoryInteger(checkedAt) === null) return invalid()
  const fields = inventoryFields(payload)
  return { uid, checkedAt, balances: { YUCHI: inventoryInteger(fields.gold), YUWAN: inventoryInteger(fields.silver) } }
}

export function parseDouyuGiftCatalog(payload: unknown, room: string, checkedAt: number): DouyuGiftCatalog {
  if (!validDouyuRoom(room) || inventoryInteger(checkedAt) === null) return invalid()
  const envelope = inventoryFields(payload)
  if (!zero(envelope.error) || ['code', 'result'].some(key => Object.hasOwn(envelope, key) && !zero(envelope[key]))) return invalid()
  const data = inventoryFields(typeof envelope.data === 'string' ? parseDouyuGatewayJson(envelope.data) : envelope.data)
  const seen = new Set<string>()
  const items: DouyuGiftCatalogItem[] = inventoryArray(data.giftList, 2048).map(raw => {
    const gift = inventoryFields(raw)
    const id = inventoryInteger(gift.id)
    if (!id || seen.has(String(id))) return invalid()
    seen.add(String(id))
    const basic = inventoryFields(gift.basicInfo)
    const price = inventoryFields(gift.priceInfo)
    const amount = inventoryInteger(price.price)
    const currency = price.priceType === 'YUCHI' || price.priceType === 'YUWAN' ? price.priceType : null
    const unitPrice = amount !== null && amount > 0 && currency ? giftMoney(currency, amount) : null
    const skinId = inventoryInteger(gift.defaultSkinId)
    const countLimit = inventoryInteger(gift.countLimit)
    const start = inventoryInteger(gift.startTime)
    const end = inventoryInteger(gift.endTime)
    const reason = inventoryInteger(gift.donateStatus) !== 1 ? '当前不可赠送.'
      : inventoryInteger(basic.giftType) !== 0 ? '特殊礼物用途或资格未核验.'
        : inventoryInteger(basic.guardLevel) !== 0 || inventoryInteger(gift.fansLevel) !== 0 ? '礼物要求额外账号资格.'
          : !unitPrice ? '币种或价格未知, 不允许购买.'
            : skinId === null ? '礼物皮肤标识未知.'
              : countLimit === null || inventoryInteger(gift.isBatchLimited) !== 0 ? '礼物数量限制尚未核验.'
                : start === null || end === null || (start > 0 && start * 1000 > checkedAt) || (end > 0 && end * 1000 <= checkedAt) ? '礼物有效时段尚未满足.' : null
    return { giftId: String(id), name: inventoryName(gift.name), unitPrice, skinId: skinId ?? 0,
      countLimit, available: reason === null, unavailableReason: reason }
  })
  return { room, checkedAt, onceLimit: inventoryInteger(data.onceLimit), items }
}

function samePrice(left: DouyuGiftPurchase['unitPrice'], right: DouyuGiftPurchase['unitPrice'] | null): boolean {
  return !!right && left.currency === right.currency && left.amountMinor === right.amountMinor && left.scale === right.scale
}

function purchaseReceipt(payload: unknown, target: DouyuGiftPurchase): DouyuGiftReceipt {
  const envelope = inventoryFields(payload)
  if (!zero(envelope.error) || ['code', 'result'].some(key => Object.hasOwn(envelope, key) && !zero(envelope[key]))) return unknownReceipt()
  const data = inventoryFields(typeof envelope.data === 'string' ? parseDouyuGatewayJson(envelope.data) : envelope.data)
  if (!Object.keys(data).length) return unknownReceipt()
  const bindings: Array<[string[], string]> = [
    [['giftId', 'gift_id', 'gfid', 'gid'], target.giftId], [['giftCount', 'gift_count', 'quantity', 'num'], String(target.quantity)],
    [['roomId', 'room_id', 'rid'], target.room], [['uid', 'userId', 'user_id'], target.expectedUid],
  ]
  for (const source of [envelope, data]) for (const [keys, expected] of bindings) for (const key of keys) {
    if (Object.hasOwn(source, key) && String(source[key]) !== expected) return unknownReceipt()
  }
  // The official client only guarantees error=0 and a data object. Independent
  // balance reads in the plan service verify the expected accounting change.
  return { status: 'receipt-received', message: '已收到斗鱼礼物回执, 正在核对余额. 榜单和亲密度到账仍需独立核对.' }
}

export class DouyuGiftPurchaseGateway extends DouyuBackpackGateway {
  constructor(deps: DouyuActionDependencies, private readonly balances: DouyuGiftBalanceProvider, private readonly now: () => number = Date.now) { super(deps) }

  async readCatalog(room: string, signal: AbortSignal): Promise<DouyuGiftCatalog> {
    if (!validDouyuRoom(room) || !hostAllowed(CATALOG_HOST, this.deps.proxy.hosts)) return invalid()
    return this.bounded(signal, async active => {
      const target = `${CATALOG_URL}?rid=${room}`
      const { response } = await safeFetch(target, { ...this.deps.proxy, hosts: [CATALOG_HOST], maxRedirects: 0,
        allowNonStandardPorts: false, allowNonLoopbackTargets: false }, {
        method: 'GET', signal: active,
        resolve: host => this.resolve(host, active),
        fetchImpl: async (url, init) => {
          const result = await abortable((this.deps.request ?? fetch)(url, { ...init, headers: {
            Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache',
          } }), active)
          if (result.status !== 200 || result.redirected || (result.url && result.url !== target)) { cancelBody(result); return invalid() }
          return result
        },
      })
      return parseDouyuGiftCatalog(parseDouyuGatewayJson(await this.readText(response, active)), room, this.now())
    })
  }

  async readBalance(accountId: string, room: string, signal: AbortSignal): Promise<DouyuGiftBalanceRead> {
    if (!validDouyuRoom(room)) return invalid()
    return this.bounded(signal, async active => {
      const target = { accountId, room, method: 'POST' as const, url: PURCHASE_URL }
      const credentials = await this.credentials(target, active)
      const requestedAt = this.now()
      const result = inventoryFields(await abortable(this.balances(accountId, room, active), active))
      const values = inventoryFields(result.balances)
      const checkedAt = inventoryInteger(result.checkedAt)
      if (result.uid !== credentials.uid || checkedAt === null || checkedAt < requestedAt || checkedAt > this.now() + 1000) return invalid()
      if (Object.keys(values).some(key => key !== 'YUCHI' && key !== 'YUWAN')
        || [values.YUCHI, values.YUWAN].some(value => value !== null && inventoryInteger(value) === null)) return invalid()
      await this.confirm(target, credentials, active)
      return { uid: credentials.uid, checkedAt, balances: { YUCHI: inventoryInteger(values.YUCHI), YUWAN: inventoryInteger(values.YUWAN) } }
    })
  }

  async purchase(input: DouyuGiftPurchase, signal: AbortSignal): Promise<DouyuGiftReceipt> {
    let dispatched = false
    try {
      const fields = inventoryFields(input)
      const price = inventoryFields(fields.unitPrice)
      if (typeof fields.accountId !== 'string' || !validUid(fields.expectedUid) || !validDouyuRoom(fields.room)
        || typeof fields.giftId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(fields.giftId)
        || inventoryInteger(fields.quantity) === null || Number(fields.quantity) < 1
        || inventoryInteger(fields.skinId) === null || inventoryInteger(fields.expectedBalance) === null
        || !['YUCHI', 'YUWAN'].includes(String(price.currency)) || inventoryInteger(price.amountMinor) === null || Number(price.amountMinor) < 1
        || price.scale !== (price.currency === 'YUCHI' ? 100 : 1)) return notSubmitted('赠礼参数无效. 未提交购买.')
      const target: DouyuGiftPurchase = { accountId: fields.accountId, expectedUid: fields.expectedUid, room: String(fields.room), giftId: fields.giftId,
        quantity: Number(fields.quantity), skinId: Number(fields.skinId), expectedBalance: Number(fields.expectedBalance),
        unitPrice: giftMoney(price.currency as 'YUCHI' | 'YUWAN', Number(price.amountMinor)) }
      const cost = multiplyGiftMoney(target.unitPrice, target.quantity)
      if (!cost || cost.amountMinor > target.expectedBalance) return notSubmitted('确认预算或余额不足. 未提交购买.')
      return await this.bounded(signal, async active => {
        const catalog = await this.readCatalog(target.room, active)
        const gift = catalog.items.find(item => item.giftId === target.giftId)
        if (!gift?.available || !samePrice(target.unitPrice, gift.unitPrice) || gift.skinId !== target.skinId
          || (gift.countLimit !== null && gift.countLimit > 0 && target.quantity > gift.countLimit)) return notSubmitted('礼物价格或可赠状态已变化. 未提交购买.')
        const balance = await this.readBalance(target.accountId, target.room, active)
        if (balance.uid !== target.expectedUid || balance.balances[cost.currency] !== target.expectedBalance) return notSubmitted('账号或余额已变化. 未提交购买.')
        const httpTarget = { accountId: target.accountId, expectedUid: target.expectedUid, room: target.room, method: 'POST' as const, url: PURCHASE_URL,
          body: new URLSearchParams({ giftId: target.giftId, giftCount: String(target.quantity), roomId: target.room, bizExt: '{"yzxq":{}}', skinId: String(target.skinId) }).toString() }
        const credentials = await this.credentials(httpTarget, active)
        // This awaited POST owns the shared serial lane until the transport settles.
        const response = await this.request(httpTarget, credentials, active, () => { dispatched = true })
        const payload = parseDouyuGatewayJson(await this.readText(response, active))
        await this.confirm(httpTarget, credentials, active)
        return purchaseReceipt(payload, target)
      })
    } catch {
      if (dispatched) return unknownReceipt()
      if (signal.aborted) return notSubmitted('操作已取消. 未提交购买.')
      return notSubmitted('价格, 余额或账号无法核对. 未提交购买.')
    }
  }

}
