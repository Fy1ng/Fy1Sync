import { abortable, cancelled, record } from './actionHttp'
import { DOUYU_CHECK_IN_KINDS, readAutomationRequest, type DouyuAutomationDependencies, type DouyuAutomationOutcome,
  type DouyuAutomationProgress, type DouyuAutomationRequest } from './automationTypes'
import { AutomationFault, DouyuActivityCatalog, DouyuAutomationHttp, DOUYU_AUTOMATION_ORIGIN as ORIGIN,
  automationActive, automationArray, automationData, automationEnvelope, automationFailure, automationId,
  automationNumber, automationRecipient, automationTimeout, type AutomationContext, type DouyuArenaActivity } from './activityCatalog'

interface Batch {
  definition: string
  day: string
  uid: string
  fingerprint: string
  targets: string[] | null
  index: number
  skipped: number
  cards: number
  fastSubmitted: boolean
  arena?: DouyuArenaActivity
  evidence: DouyuAutomationProgress['evidence']
}
const YUBA = 'https://yuba.douyu.com'
const MOBILE_YUBA = 'https://mapi-yuba.douyu.com'
const MAX_BATCH = 2_000
const MAX_ATTEMPTS = 16_384
const MAX_BATCHES = 256
const NEXT_STEP_MS = 5_000
const room = (value: unknown): string | null => { const id = automationId(value); return id && id.length <= 12 ? id : null }
const yubaData = (value: unknown) => automationEnvelope(value, true)

/** One bounded item per run. The scheduler retains cancellation and account ownership. */
export class DouyuCheckInActions {
  private readonly http: DouyuAutomationHttp
  private readonly catalog: DouyuActivityCatalog
  private readonly batches = new Map<string, Batch>()
  private readonly attempts = new Map<string, 'submitted' | 'confirmed'>()
  private busy = false

  constructor(private readonly deps: DouyuAutomationDependencies) {
    this.http = new DouyuAutomationHttp(deps)
    this.catalog = new DouyuActivityCatalog(this.http)
  }

  /** Forgetting progress does not remove an uncertain write from the replay ledger. */
  forget(taskId: string): void { this.batches.delete(taskId) }

  async run(raw: DouyuAutomationRequest, signal: AbortSignal): Promise<DouyuAutomationOutcome> {
    automationActive(signal)
    let task: DouyuAutomationRequest
    try { task = readAutomationRequest(raw) } catch { return { status: 'failed', message: '斗鱼签到任务参数无效.' } }
    if (!DOUYU_CHECK_IN_KINDS.includes(task.kind as typeof DOUYU_CHECK_IN_KINDS[number])) return { status: 'failed', message: '此任务不是签到任务.' }
    if (this.busy) return { status: 'waiting-user', message: '上一项签到请求尚未结束, 请稍后恢复.' }
    this.busy = true
    const timeout = automationTimeout(this.deps, signal)
    const context: AutomationContext = { task, signal: timeout.signal, submitted: false }
    let batch: Batch | undefined
    try {
      const auth = await this.http.identity(context)
      const definition = JSON.stringify(task)
      const day = new Date(this.http.now() + 8 * 3_600_000).toISOString().slice(0, 10)
      batch = this.batches.get(task.taskId)
      if (batch && (batch.definition !== definition || batch.uid !== auth.uid || batch.fingerprint !== auth.fingerprint)) throw new AutomationFault('login')
      if (!batch || batch.day !== day) {
        if (!batch && this.batches.size >= MAX_BATCHES) throw new AutomationFault('capacity')
        batch = { definition, day, uid: auth.uid, fingerprint: auth.fingerprint, targets: null, index: 0, skipped: 0, cards: 0, fastSubmitted: false, evidence: 'none' }
        this.batches.set(task.taskId, batch)
      }
      if (!batch.targets) batch.targets = await this.targets(context)
      if (batch.targets.length > (task.options.maxItems ?? MAX_BATCH)) throw new AutomationFault('capacity')
      if (task.kind === 'arena-sign') batch.arena ??= await this.catalog.arena(context, task.options.arena ?? 'actqzs')
      if (batch.index >= batch.targets.length) return this.complete(batch)
      if (task.kind === 'yuba-sign-all' && task.options.yubaMode === 'fast' && !batch.fastSubmitted) {
        await this.fastYuba(context, batch)
        batch.fastSubmitted = true
        return this.next(batch, '极速签到已提交, 正在逐个核对官方鱼吧状态.')
      }
      const target = batch.targets[batch.index]!
      const result = await this.item(context, batch, target)
      if (result === 'skipped') batch.skipped++
      // Supplementation can consume multiple existing cards, always one per step.
      if (result !== 'more') batch.index++
      return batch.index >= batch.targets.length ? this.complete(batch) : this.next(batch, result === 'more' ? '已确认一张补签卡的使用结果, 等待下一步.' : '本项处理完成, 等待下一项签到.')
    } catch (error) {
      if (signal.aborted) throw cancelled()
      if (batch && context.submitted && !context.writeRefused) batch.evidence = 'unconfirmed'
      return { ...automationFailure(error, context.submitted && !context.writeRefused), ...(batch ? { progress: this.progress(batch) } : {}) }
    } finally { timeout.dispose(); this.busy = false }
  }

  private progress(batch: Batch): DouyuAutomationProgress {
    return { completed: batch.index, total: batch.targets?.length ?? null, skipped: batch.skipped,
      current: batch.targets?.[batch.index] ?? null, evidence: batch.evidence }
  }
  private complete(batch: Batch): DouyuAutomationOutcome {
    return { status: 'succeeded', message: batch.evidence === 'receipt-received'
      ? '本批已处理完毕, 已记录官方回执. 实际奖励和签到结果请以官方账户为准.' : '本批签到已完成官方状态核对.', progress: this.progress(batch) }
  }
  private next(batch: Batch, message: string): DouyuAutomationOutcome {
    return { status: 'scheduled', message, nextRunAt: this.http.now() + NEXT_STEP_MS, progress: this.progress(batch) }
  }

  private async targets(context: AutomationContext): Promise<string[]> {
    const { task } = context
    if (task.kind === 'client-sign') return ['account']
    if (task.target.type === 'room') return [task.target.room]
    if (task.target.type === 'group') return [task.target.groupId]
    if (task.target.type !== 'batch') throw new AutomationFault('invalid-response')
    if (task.target.source === 'selected-rooms') return [...task.target.rooms]
    if (task.target.source === 'followed-yuba') return this.followedYuba(context)
    if (!this.deps.readFollowedRooms) throw new AutomationFault('unavailable')
    const list = await abortable(this.deps.readFollowedRooms(task.accountId, context.signal), context.signal)
    await this.http.identity(context)
    if (list.accountId !== task.accountId || list.coverage !== 'all-pages' || !Number.isSafeInteger(list.pageCount) || list.pageCount < 0 || list.pageCount > 100
      || !Number.isSafeInteger(list.checkedAt) || Math.abs(list.checkedAt - this.http.now()) > 60_000
      || !Array.isArray(list.rooms) || list.rooms.length > MAX_BATCH || list.pageCount === 0 && list.rooms.length > 0) throw new AutomationFault('invalid-response')
    const targets = list.rooms.map(entry => room(entry.room))
    if (targets.some(value => value === null) || new Set(targets).size !== targets.length) throw new AutomationFault('invalid-response')
    return targets as string[]
  }

  private async followedYuba(context: AutomationContext): Promise<string[]> {
    const targets: string[] = []
    let pages = 1
    for (let page = 1; page <= pages; page++) {
      const response = yubaData(await this.http.request(context, `${YUBA}/wbapi/web/group/myFollow?page=${page}&limit=30`, { auth: 'dy-token' }))
      const totalPages = automationNumber(response.count_page)
      if (totalPages === null || totalPages > 100 || page > 1 && totalPages !== pages) throw new AutomationFault('invalid-response')
      pages = totalPages
      const rows = automationArray(response.list, 30)
      if (pages === 0 && rows.length || pages > 1 && rows.length === 0) throw new AutomationFault('invalid-response')
      for (const value of rows) {
        const id = automationId(record(value)?.group_id)
        if (!id || targets.includes(id) || targets.length >= MAX_BATCH) throw new AutomationFault('invalid-response')
        targets.push(id)
      }
    }
    return targets
  }

  private key(context: AutomationContext, batch: Batch, target: string): string {
    const activity = batch.arena ? `${batch.arena.kind}:${batch.arena.id}:` : ''
    return `${batch.uid}:${context.task.accountId}:${batch.day}:${context.task.kind}:${activity}${target}`
  }
  private prepare(context: AutomationContext, batch: Batch, target: string): string {
    const key = this.key(context, batch, target)
    if (this.attempts.has(key)) throw new AutomationFault('unknown-result')
    if (this.attempts.size >= MAX_ATTEMPTS) throw new AutomationFault('capacity')
    context.onWrite = () => { this.attempts.set(key, 'submitted') }
    context.onDefiniteRefusal = () => { this.attempts.delete(key) }
    return key
  }
  private confirm(key: string, batch: Batch, evidence: DouyuAutomationProgress['evidence']): void {
    this.attempts.set(key, 'confirmed')
    if (batch.evidence !== 'receipt-received' || evidence === 'receipt-received') batch.evidence = evidence
  }

  private async item(context: AutomationContext, batch: Batch, target: string): Promise<'done' | 'skipped' | 'more'> {
    const { kind } = context.task
    if (kind === 'yuba-sign-all') return this.yuba(context, batch, target)
    const key = this.key(context, batch, target)
    if (this.attempts.get(key) === 'confirmed') return 'skipped'
    this.prepare(context, batch, target)
    if (kind === 'client-sign') {
      const response = await this.http.request(context, 'https://apiv2.douyucdn.cn/h5nc/sign/sendSign', { method: 'POST', auth: 'token-form' })
      const envelope = automationData(response)
      if (automationNumber(envelope.error) !== 0 || ['code', 'result'].some(name => Object.hasOwn(envelope, name) && automationNumber(envelope[name]) !== 0)) throw new AutomationFault('invalid-response')
      if (Array.isArray(envelope.data) && envelope.data.length === 0) {
        this.confirm(key, batch, 'receipt-received'); return 'done'
      }
      const receipt = automationData(envelope.data)
      automationRecipient(context, receipt)
      const awards = automationArray(receipt.sign_pl, 128)
      if (awards.some(value => !record(value) || automationNumber(record(value)!.cnt) === null || typeof record(value)!.name !== 'string')) throw new AutomationFault('invalid-response')
      this.confirm(key, batch, 'receipt-received'); return 'done'
    }
    if (kind === 'followed-room-sign') {
      const response = automationData(await this.http.request(context, 'https://apiv2.douyucdn.cn/japi/roomuserlevel/apinc/checkIn?client_sys=android', {
        method: 'POST', auth: 'token-header', fields: { rid: target },
      }))
      // The pinned request has no success schema. Only an explicit signed state,
      // bound to this room when provided, is accepted; generic error=0 is unknown.
      const data = automationData(response.data)
      automationRecipient(context, data)
      if (automationNumber(response.error) !== 0 || ![data.is_checked, data.is_signed, data.checkInStatus].some(value => value === 1 || value === '1')
        || ['rid', 'room_id', 'roomId'].some(name => Object.hasOwn(data, name) && room(data[name]) !== target)) throw new AutomationFault('unknown-result')
      this.confirm(key, batch, 'official-state'); return 'done'
    }
    let address: string
    let fields: Record<string, string> = { rid: target }
    if (kind === 'arena-sign') {
      if (!batch.arena || batch.arena.endsAt <= this.http.now()) throw new AutomationFault('eligibility')
      address = `${ORIGIN}/japi/revenuenc/web/${batch.arena.kind}/userTask/signIn`
      fields = { rid: target, activity_id: batch.arena.id }
    } else address = `${ORIGIN}/japi/interactnc/web/${kind === 'fans-home-sign' ? 'fanshome/sign' : 'dfansact/userSign'}`
    const response = automationEnvelope(await this.http.request(context, address, { method: 'POST', fields }))
    automationRecipient(context, response)
    if (['rid', 'room_id', 'roomId'].some(name => Object.hasOwn(response, name) && room(response[name]) !== target)) throw new AutomationFault('invalid-response')
    if (kind === 'arena-sign') {
      if (Object.hasOwn(response, 'activity_id') && automationId(response.activity_id) !== batch.arena!.id) throw new AutomationFault('invalid-response')
      for (const raw of automationArray(response.awards, 128)) {
        const award = automationData(raw)
        if (typeof award.name !== 'string' || award.name.length > 128 || automationNumber(award.num) === null) throw new AutomationFault('invalid-response')
      }
    } else if (![response.is_signed, response.isSigned, response.signStatus].some(value => value === 1 || value === '1')) throw new AutomationFault('unknown-result')
    this.confirm(key, batch, 'receipt-received')
    return 'done'
  }

  private async head(context: AutomationContext, id: string): Promise<{ signed: number; exp: number; following: number }> {
    const data = yubaData(await this.http.request(context, `${YUBA}/wbapi/web/group/head?group_id=${id}`, { auth: 'yuba', referer: `${YUBA}/discussion/${id}/posts` }))
    const signed = automationNumber(data.is_signed), exp = automationNumber(data.group_exp), following = automationNumber(data.is_follow)
    if (automationId(data.group_id) !== id || signed === null || signed > 1 || exp === null || following === null || following > 1) throw new AutomationFault('invalid-response')
    return { signed, exp, following }
  }

  private async fastYuba(context: AutomationContext, batch: Batch): Promise<void> {
    const key = this.prepare(context, batch, 'fast')
    const result = automationData(await this.http.request(context, `${MOBILE_YUBA}/wb/v3/fastSign`, { method: 'POST', auth: 'token-header' }))
    if ((automationNumber(result.error) !== 0 && automationNumber(result.status_code) !== 200)
      || ['error', 'code', 'result'].some(name => Object.hasOwn(result, name) && automationNumber(result[name]) !== 0)
      || Object.hasOwn(result, 'status_code') && automationNumber(result.status_code) !== 200
      || automationNumber(result.data) === null) throw new AutomationFault('unknown-result')
    this.confirm(key, batch, 'receipt-received')
  }

  private async yuba(context: AutomationContext, batch: Batch, id: string): Promise<'done' | 'skipped' | 'more'> {
    const mode = context.task.options.yubaMode ?? 'normal'
    if (mode === 'supplement') return this.supplement(context, batch, id)
    const before = await this.head(context, id)
    if (before.signed > 0) { batch.evidence = batch.evidence === 'receipt-received' ? batch.evidence : 'official-state'; return 'skipped' }
    if (before.following !== 1) throw new AutomationFault('eligibility')
    // Fast sign covers only eligible groups. Confirm each group and use the
    // ordinary official sign endpoint for an unsigned followed group.
    const key = this.prepare(context, batch, id)
    const receipt = yubaData(await this.http.request(context, `${YUBA}/ybapi/topic/sign`, { method: 'POST', auth: 'yuba', encoding: 'multipart',
      fields: { group_id: id, cur_exp: String(before.exp) }, referer: `${YUBA}/discussion/${id}/posts` }))
    automationRecipient(context, receipt)
    if (Object.hasOwn(receipt, 'group_id') && automationId(receipt.group_id) !== id) throw new AutomationFault('unknown-result')
    const after = await this.head(context, id)
    if (after.signed <= 0) throw new AutomationFault('unknown-result')
    this.confirm(key, batch, 'official-state')
    return 'done'
  }

  private async supplement(context: AutomationContext, batch: Batch, id: string): Promise<'done' | 'skipped' | 'more'> {
    const prefix = this.key(context, batch, `${id}:card:`)
    if ([...this.attempts].some(([key, status]) => key.startsWith(prefix) && status === 'submitted')) throw new AutomationFault('unknown-result')
    const maximum = context.task.options.maxSupplementCards!
    if (batch.cards >= maximum) return 'skipped'
    const head = await this.head(context, id)
    if (head.following !== 1) throw new AutomationFault('eligibility')
    const read = async () => yubaData(await this.http.request(context, `${YUBA}/wbapi/web/signDetail?group_id=${id}`, { auth: 'dy-token' }))
    const before = await read()
    const cards = automationNumber(before.supplementary_cards)
    if (cards === null) throw new AutomationFault('invalid-response')
    if (cards === 0) return 'skipped'
    const key = this.prepare(context, batch, `${id}:card:${cards}`)
    const receipt = yubaData(await this.http.request(context, `${MOBILE_YUBA}/wb/v3/supplement`, { method: 'POST', auth: 'token-header', fields: { group_id: id } }))
    automationRecipient(context, receipt)
    const after = await read()
    if (automationNumber(after.supplementary_cards) !== cards - 1 || Object.hasOwn(receipt, 'group_id') && automationId(receipt.group_id) !== id) throw new AutomationFault('unknown-result')
    batch.cards++
    this.confirm(key, batch, 'official-state')
    return cards > 1 && batch.cards < maximum ? 'more' : 'done'
  }
}
