import { randomUUID } from 'node:crypto'
import { isDouyuAccountId } from '../../electron/douyuAccounts'
import type { DouyuTaskManager } from '../../electron/douyuTasks'
import type { ResolveDouyuRoom } from '../platforms/douyuRoom'
import { abortable, cancelled } from './actionHttp'
import { DouyuRenewalGatewayError, type DouyuBackpackGateway } from './backpackGateway'
import { parseRenewalInventory, parseRenewalTargets } from './renewalInventory'
import type {
  DouyuBackpackItem, DouyuRenewalPlan, DouyuRenewalPlanRow, DouyuRenewalResult,
  DouyuRenewalResultRow, DouyuRenewalTarget, DouyuRenewalTargetPage,
} from './renewalTypes'

const MESSAGES = {
  'invalid-arguments': '续牌赠送参数无效.',
  'account-changed': '账号状态已变化, 请重新读取目标并生成预览.',
  'login-required': '请先登录当前斗鱼账号.',
  'verification-required': '斗鱼要求官方验证, 请在该账号的官方页面完成后重试读取.',
  unavailable: '无法读取续牌赠送所需的信息, 请到官方页面核对.',
  'invalid-data': '斗鱼返回的信息无法安全确认.',
  'stale-plan': '预览已失效或目标与库存已变化, 请重新生成预览.',
  busy: '上一项操作仍在结束, 请稍后重新生成预览.',
  cancelled: '操作已取消.',
} as const

export class DouyuRenewalError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) { super(MESSAGES[code]); this.name = 'DouyuRenewalError' }
}

export interface DouyuRenewalDependencies {
  gateway: Pick<DouyuBackpackGateway, 'readBadges' | 'readBackpack' | 'donate'>
  tasks: Pick<DouyuTaskManager, 'snapshot' | 'runAccountOperation'>
  accountReady: (id: string) => boolean
  resolveRoom: ResolveDouyuRoom
  now?: () => number
  id?: () => string
}

type StoredPlan = {
  public: DouyuRenewalPlan
  uid: string
  originRoom: string | null
  selected: Map<string, DouyuBackpackItem>
  stocks: Map<string, number>
}
type Execution = { plan: StoredPlan; controller: AbortController; entered: boolean; settled: boolean; rows: DouyuRenewalResultRow[] }
const PREFERRED_PROPS = ['268', '2358']
const PLAN_TTL_MS = 120_000
const READ_TIMEOUT_MS = 45_000
const EXECUTION_TIMEOUT_MS = 90_000
const copy = <T>(value: T): T => structuredClone(value)
const isPlanId = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)

export function readRenewalRooms(raw: unknown): string[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length < 1 || raw.length > 20
    || Reflect.ownKeys(raw).length !== raw.length + 1) throw new DouyuRenewalError('invalid-arguments')
  const rooms: string[] = []
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index))
    const room = descriptor && 'value' in descriptor ? descriptor.value as unknown : null
    if (typeof room !== 'string' || !/^[1-9]\d{0,11}$/.test(room) || rooms.includes(room)) throw new DouyuRenewalError('invalid-arguments')
    rooms.push(room)
  }
  return rooms
}

function translate(error: unknown): DouyuRenewalError {
  if (error instanceof DouyuRenewalError) return error
  if (error instanceof DouyuRenewalGatewayError) return new DouyuRenewalError(error.code)
  if (error instanceof Error && error.name === 'AbortError') return new DouyuRenewalError('cancelled')
  return new DouyuRenewalError('invalid-data')
}

/** One-use, short-lived plans. Only the main process holds identity and inventory proof. */
export class DouyuRenewalService {
  private readonly now: () => number
  private readonly id: () => string
  private plan: StoredPlan | null = null
  private reading: { accountId: string; controller: AbortController } | null = null
  private execution: Execution | null = null
  private disposed = false

  constructor(private readonly deps: DouyuRenewalDependencies) {
    this.now = deps.now ?? Date.now
    this.id = deps.id ?? randomUUID
  }

  private scope(accountId: string, originRoom?: string | null) {
    if (!isDouyuAccountId(accountId)) throw new DouyuRenewalError('invalid-arguments')
    const state = this.deps.tasks.snapshot()
    if (this.disposed || state.activeAccountId !== accountId || !this.deps.accountReady(accountId)) throw new DouyuRenewalError('account-changed')
    if (originRoom !== undefined && state.currentRoom !== originRoom) throw new DouyuRenewalError('stale-plan')
    return state
  }

  private async read<T>(accountId: string, work: (signal: AbortSignal, originRoom: string | null) => Promise<T>): Promise<T> {
    if (this.execution) throw new DouyuRenewalError('busy')
    const { currentRoom } = this.scope(accountId)
    this.reading?.controller.abort()
    this.plan = null
    const request = { accountId, controller: new AbortController() }
    this.reading = request
    const timer = setTimeout(() => request.controller.abort(), READ_TIMEOUT_MS)
    try {
      const result = await abortable(work(request.controller.signal, currentRoom), request.controller.signal)
      if (request.controller.signal.aborted || this.reading !== request) throw cancelled()
      this.scope(accountId, currentRoom)
      return result
    } catch (error) { throw translate(error) }
    finally {
      clearTimeout(timer)
      if (this.reading === request) this.reading = null
    }
  }

  async targets(accountId: string): Promise<DouyuRenewalTargetPage> {
    return this.read(accountId, async signal => {
      const response = await this.deps.gateway.readBadges(accountId, signal)
      return { accountId, checkedAt: this.now(), coverage: 'returned-page', targets: parseRenewalTargets(response.html),
        message: '仅显示本次返回页中可核对的粉丝牌. 不自动判定续期状态, 请手动选择需要处理的房间.' }
    })
  }

  async preview(accountId: string, rawRooms: unknown, quantity: number): Promise<DouyuRenewalPlan> {
    const rooms = readRenewalRooms(rawRooms)
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) throw new DouyuRenewalError('invalid-arguments')
    return this.read(accountId, async (signal, originRoom) => {
      const page = await this.deps.gateway.readBadges(accountId, signal)
      const targets = new Map(parseRenewalTargets(page.html).map(target => [target.room, target]))
      if (rooms.some(room => !targets.has(room))) throw new DouyuRenewalError('stale-plan')
      const choices: Array<{ target: DouyuRenewalTarget; items: DouyuBackpackItem[]; reason: string | null }> = []
      const stocks = new Map<string, number>()
      const inconsistent = new Set<string>()
      for (const room of rooms) {
        if (signal.aborted) throw cancelled()
        this.scope(accountId, originRoom)
        const target = targets.get(room)!
        const resolved = await abortable(this.deps.resolveRoom(room), signal)
        if (!resolved.ok || resolved.identity.room !== room) {
          choices.push({ target, items: [], reason: '房间身份无法一致核对, 本次跳过.' })
          continue
        }
        try {
          const response = await this.deps.gateway.readBackpack(accountId, room, signal)
          if (response.uid !== page.uid) throw new DouyuRenewalError('account-changed')
          const items = parseRenewalInventory(response.payload, this.now())
          for (const item of items.filter(item => item.eligible)) {
            if (stocks.has(item.id) && stocks.get(item.id) !== item.count) inconsistent.add(item.id)
            else stocks.set(item.id, item.count)
          }
          choices.push({ target, items, reason: null })
        } catch (error) {
          if (signal.aborted) throw cancelled()
          const problem = translate(error)
          if (['account-changed', 'login-required', 'verification-required'].includes(problem.code)) throw problem
          choices.push({ target, items: [], reason: '无法安全核对该房间的背包, 本次跳过.' })
        }
      }
      if (signal.aborted) throw cancelled()
      this.scope(accountId, originRoom)
      const remaining = new Map(stocks)
      const selected = new Map<string, DouyuBackpackItem>()
      const rows: DouyuRenewalPlanRow[] = choices.map(({ target, items, reason }) => {
        const eligible = PREFERRED_PROPS.flatMap(id => items.filter(item => item.id === id && item.eligible))
        const item = eligible.find(item => !inconsistent.has(item.id) && (remaining.get(item.id) ?? 0) >= quantity)
        if (!item) return { ...target, status: 'skipped', gift: null, reason: reason
          ?? (eligible.some(item => inconsistent.has(item.id)) ? '跨房间的库存信息不一致, 请重新读取.'
            : eligible.length ? '剩余库存不足以完成指定数量, 本次跳过.'
              : items.find(item => PREFERRED_PROPS.includes(item.id))?.reason ?? '没有可核对的普通背包荧光棒, 本次跳过.') }
        remaining.set(item.id, remaining.get(item.id)! - quantity)
        selected.set(target.room, copy(item))
        return { ...target, status: 'ready', gift: { propId: item.id, name: item.name, quantity, stock: item.count,
          expiresAt: item.met === -1 ? null : item.met! * 1000 }, reason: null }
      })
      const id = this.id()
      if (!isPlanId(id)) throw new DouyuRenewalError('invalid-data')
      const createdAt = this.now()
      const plan: DouyuRenewalPlan = { id, accountId, createdAt, expiresAt: createdAt + PLAN_TTL_MS, rows,
        totalQuantity: rows.reduce((total, row) => total + (row.gift?.quantity ?? 0), 0),
        message: '仅使用下列已有背包库存, 不购买或领取. 数量由你确认, 赠送回执不等于续期效果已验证.' }
      this.plan = { public: copy(plan), uid: page.uid, originRoom, selected, stocks }
      return copy(plan)
    })
  }

  cancel(planId: string): { cancelled: boolean } {
    if (!isPlanId(planId)) throw new DouyuRenewalError('invalid-arguments')
    if (this.execution?.plan.public.id === planId) { this.execution.controller.abort(); return { cancelled: true } }
    if (this.plan?.public.id === planId) { this.plan = null; return { cancelled: true } }
    return { cancelled: false }
  }

  invalidate(accountId: string): void {
    if (this.reading?.accountId === accountId) this.reading.controller.abort()
    if (this.plan?.public.accountId === accountId) this.plan = null
    if (this.execution?.plan.public.accountId === accountId) this.execution.controller.abort()
  }

  dispose(): void {
    this.disposed = true
    this.plan = null
    this.reading?.controller.abort()
    this.execution?.controller.abort()
  }

  async execute(planId: string): Promise<DouyuRenewalResult> {
    if (!isPlanId(planId)) throw new DouyuRenewalError('invalid-arguments')
    if (this.execution) throw new DouyuRenewalError('busy')
    const plan = this.plan
    if (!plan || plan.public.id !== planId || plan.public.expiresAt <= this.now() || plan.public.totalQuantity < 1) throw new DouyuRenewalError('stale-plan')
    this.scope(plan.public.accountId, plan.originRoom)
    // Claim before any await: a plan is never replayed, even after a rejected queue request.
    this.plan = null
    const execution: Execution = { plan, controller: new AbortController(), entered: false, settled: false,
      rows: plan.public.rows.map(row => ({ room: row.room, badgeName: row.badgeName, propName: row.gift?.name ?? null,
        quantity: row.gift?.quantity ?? 0, status: row.status === 'skipped' ? 'skipped' : 'not-submitted', message: row.reason ?? '尚未提交.' })) }
    this.execution = execution
    const timer = setTimeout(() => execution.controller.abort(), EXECUTION_TIMEOUT_MS)
    try {
      const outcome = await this.deps.tasks.runAccountOperation({ accountId: plan.public.accountId, originRoom: plan.originRoom,
        rooms: plan.public.rows.filter(row => row.status === 'ready').map(row => row.room) }, async signal => {
        execution.entered = true
        try { return await this.perform(execution, signal) }
        finally {
          execution.settled = true
          if (this.execution === execution) this.execution = null
        }
      }, execution.controller.signal)
      if (outcome.status === 'completed') return copy(outcome.value)
      return this.result(execution, outcome.status === 'cancelled' ? 'cancelled' : 'failed', outcome.status === 'busy'
        ? '执行队列正忙, 本次未开始赠送, 请稍后重新预览.'
        : outcome.status === 'cancelled' ? outcome.started ? '操作已停止. 已可能提交的项目需要到官方房间核对, 不会自动重送.' : '操作在开始前已取消, 未提交赠送.'
          : '未能安全完成操作. 请核对结果后重新预览, 不会自动重送.',
      outcome.status === 'cancelled' ? 'cancelled' : outcome.status === 'busy' ? 'queue-busy' : 'unavailable')
    } finally {
      clearTimeout(timer)
      if ((!execution.entered || execution.settled) && this.execution === execution) this.execution = null
    }
  }

  private result(execution: Execution, status: DouyuRenewalResult['status'], message: string, reason?: DouyuRenewalResult['reason']): DouyuRenewalResult {
    return { planId: execution.plan.public.id, status, rows: copy(execution.rows), message, ...(reason ? { reason } : {}) }
  }

  private ensureCurrent(plan: StoredPlan, signal: AbortSignal): void {
    if (signal.aborted) throw cancelled()
    this.scope(plan.public.accountId, plan.originRoom)
    if (this.now() >= plan.public.expiresAt) throw new DouyuRenewalError('stale-plan')
  }

  private async perform(execution: Execution, signal: AbortSignal): Promise<DouyuRenewalResult> {
    const plan = execution.plan
    const expectedStocks = new Map(plan.stocks)
    try {
      this.ensureCurrent(plan, signal)
      const page = await this.deps.gateway.readBadges(plan.public.accountId, signal)
      this.ensureCurrent(plan, signal)
      if (page.uid !== plan.uid) throw new DouyuRenewalError('account-changed')
      const targets = new Set(parseRenewalTargets(page.html).map(target => target.room))
      for (let index = 0; index < plan.public.rows.length; index++) {
        const row = plan.public.rows[index]!
        if (!row.gift || row.status !== 'ready') continue
        const output = execution.rows[index]!
        this.ensureCurrent(plan, signal)
        if (!targets.has(row.room)) throw new DouyuRenewalError('stale-plan')
        const identity = await abortable(this.deps.resolveRoom(row.room), signal)
        this.ensureCurrent(plan, signal)
        if (!identity.ok || identity.identity.room !== row.room) throw new DouyuRenewalError('stale-plan')
        const before = await this.deps.gateway.readBackpack(plan.public.accountId, row.room, signal)
        this.ensureCurrent(plan, signal)
        if (before.uid !== plan.uid) throw new DouyuRenewalError('account-changed')
        const item = parseRenewalInventory(before.payload, this.now()).find(item => item.id === row.gift!.propId)
        const approved = plan.selected.get(row.room)!
        if (!item?.eligible || item.count !== expectedStocks.get(item.id) || item.count < row.gift.quantity
          || item.name !== approved.name || item.propType !== approved.propType || item.met !== approved.met
          || item.isClick !== approved.isClick || item.isValuable !== approved.isValuable) throw new DouyuRenewalError('stale-plan')
        // Until the awaited result proves otherwise, interruption cannot prove non-delivery.
        output.status = 'unknown'
        output.message = '本次请求可能已提交, 尚未取得可核对结果.'
        const receipt = await this.deps.gateway.donate({ accountId: plan.public.accountId, expectedUid: plan.uid,
          room: row.room, propId: item.id, quantity: row.gift.quantity }, signal)
        this.ensureCurrent(plan, signal)
        output.status = receipt.status
        output.message = receipt.message
        if (receipt.status !== 'receipt-received') return this.result(execution, 'waiting-user', '赠送结果需要核对, 余下房间已停止. 不会自动重送.',
          receipt.status === 'unknown' ? 'unconfirmed' : 'unavailable')
        const after = await this.deps.gateway.readBackpack(plan.public.accountId, row.room, signal)
        this.ensureCurrent(plan, signal)
        if (after.uid !== plan.uid) throw new DouyuRenewalError('account-changed')
        const afterItem = parseRenewalInventory(after.payload, this.now()).find(candidate => candidate.id === item.id)
        const left = item.count - row.gift.quantity
        if ((afterItem?.count ?? 0) !== left) {
          output.status = 'unknown'
          output.message = '已收到赠送回执, 但库存变化与计划不一致, 请在官方房间核对.'
          return this.result(execution, 'waiting-user', '库存变化未能确认, 余下房间已停止, 不会自动补送.', 'inventory-changed')
        }
        expectedStocks.set(item.id, left)
        output.message = '已收到赠送回执, 库存数量已核对. 续期效果仍需到官方房间确认.'
      }
      return this.result(execution, 'completed', '赠送处理完成. 已收到回执的项目见下表, 粉丝牌续期效果仍需到官方房间核对.')
    } catch (error) {
      const submitted = execution.rows.some(row => row.status === 'unknown' || row.status === 'receipt-received')
      const status = signal.aborted ? 'cancelled' : submitted ? 'waiting-user' : 'failed'
      const problem = translate(error)
      const reason: DouyuRenewalResult['reason'] = signal.aborted ? 'cancelled' : problem.code === 'stale-plan' ? 'plan-changed'
        : problem.code === 'account-changed' || problem.code === 'login-required' ? 'account-changed' : submitted ? 'unconfirmed' : 'unavailable'
      return this.result(execution, status, `${problem.message} 余下操作已停止, 已可能提交的项目不会自动重送.`, reason)
    }
  }
}
