import { cancelled, record } from './actionHttp'
import { DOUYU_LEVEL_REWARD_KINDS, readAutomationRequest, type DouyuAutomationDependencies,
  type DouyuAutomationOutcome, type DouyuAutomationProgress, type DouyuAutomationRequest } from './automationTypes'
import { AutomationFault, DouyuActivityCatalog, DouyuAutomationHttp, DOUYU_AUTOMATION_ORIGIN as ORIGIN,
  automationActive, automationArray, automationData, automationEnvelope, automationFailure, automationId,
  automationNumber, automationRecipient, automationTimeout, type AutomationContext, type DouyuPointsActivity } from './activityCatalog'

interface RunState {
  definition: string
  identity: string
  completed: number
  skipped: number
  index: number
  targets: string[] | null
  current: string | null
  points?: DouyuPointsActivity
  evidence: DouyuAutomationProgress['evidence']
}
interface LevelTask { id: string; finished: boolean; claimed: boolean }
interface WatchTask { id: string; status: number; start: string }
const STEP_MS = 5_000
const POLL_MS = 60_000
const MAX_ATTEMPTS = 16_384

/** Claims official completed tasks; it never fabricates watch/read duration or resets follows. */
export class DouyuLevelRewardActions {
  private readonly http: DouyuAutomationHttp
  private readonly catalog: DouyuActivityCatalog
  private readonly runs = new Map<string, RunState>()
  private readonly attempts = new Map<string, 'submitted' | 'confirmed'>()
  private busy = false

  constructor(private readonly deps: DouyuAutomationDependencies) {
    this.http = new DouyuAutomationHttp(deps)
    this.catalog = new DouyuActivityCatalog(this.http)
  }
  forget(taskId: string): void { this.runs.delete(taskId) }

  async run(raw: DouyuAutomationRequest, signal: AbortSignal): Promise<DouyuAutomationOutcome> {
    automationActive(signal)
    let task: DouyuAutomationRequest
    try { task = readAutomationRequest(raw) } catch { return { status: 'failed', message: '斗鱼任务参数无效.' } }
    if (!DOUYU_LEVEL_REWARD_KINDS.includes(task.kind as typeof DOUYU_LEVEL_REWARD_KINDS[number])) return { status: 'failed', message: '此任务不是等级或奖励任务.' }
    if (this.busy) return { status: 'waiting-user', message: '上一项任务请求尚未结束, 请稍后恢复.' }
    this.busy = true
    const timeout = automationTimeout(this.deps, signal)
    const context: AutomationContext = { task, signal: timeout.signal, submitted: false }
    let state: RunState | undefined
    try {
      const identity = await this.http.identity(context)
      const binding = `${identity.uid}:${identity.fingerprint}`
      const definition = JSON.stringify(task)
      state = this.runs.get(task.taskId)
      if (state && (state.definition !== definition || state.identity !== binding)) throw new AutomationFault('login')
      if (!state) {
        if (this.runs.size >= 256) throw new AutomationFault('capacity')
        state = { definition, identity: binding, completed: 0, skipped: 0, index: 0, targets: null, current: null, evidence: 'none' }
        this.runs.set(task.taskId, state)
      }
      if (state.completed >= (task.options.maxItems ?? 2_000)) return this.result(state, 'succeeded', '已达到本次设置的处理数量, 任务结束.')
      if (task.kind === 'level-reward') return await this.level(context, state)
      if (task.kind === 'watch-points') return await this.watch(context, state)
      if (task.kind === 'points-sign') return await this.pointsSign(context, state)
      return await this.sequential(context, state)
    } catch (error) {
      if (signal.aborted) throw cancelled()
      if (state && context.submitted && !context.writeRefused) state.evidence = 'unconfirmed'
      return { ...automationFailure(error, context.submitted && !context.writeRefused), ...(state ? { progress: this.progress(state) } : {}) }
    } finally { timeout.dispose(); this.busy = false }
  }

  private progress(state: RunState): DouyuAutomationProgress {
    return { completed: state.completed, skipped: state.skipped, total: state.targets?.length ?? null, current: state.current, evidence: state.evidence }
  }
  private result(state: RunState, status: 'scheduled' | 'succeeded', message: string, delay = STEP_MS): DouyuAutomationOutcome {
    return status === 'scheduled' ? { status, message, nextRunAt: this.http.now() + delay, progress: this.progress(state) }
      : { status, message, progress: this.progress(state) }
  }
  private key(context: AutomationContext, id: string): string {
    const day = new Date(this.http.now() + 8 * 3_600_000).toISOString().slice(0, 10)
    return `${context.task.accountId}:${context.identity!.uid}:${context.task.kind}:${day}:${id}`
  }
  private guard(context: AutomationContext, id: string): string {
    const key = this.key(context, id)
    if (this.attempts.has(key)) throw new AutomationFault('unknown-result')
    if (this.attempts.size >= MAX_ATTEMPTS) throw new AutomationFault('capacity')
    context.onWrite = () => { this.attempts.set(key, 'submitted') }
    context.onDefiniteRefusal = () => { this.attempts.delete(key) }
    return key
  }
  private confirmed(key: string, state: RunState, evidence: DouyuAutomationProgress['evidence'] = 'official-state'): void {
    this.attempts.set(key, 'confirmed'); state.completed++; state.evidence = evidence
  }
  private targetRoom(context: AutomationContext): string {
    if (context.task.target.type !== 'room') throw new AutomationFault('invalid-response')
    return context.task.target.room
  }

  private async levelTasks(context: AutomationContext, room: string): Promise<LevelTask[]> {
    const detail = automationEnvelope(await this.http.request(context, `${ORIGIN}/japi/interactnc/web/userLevel/userLevelDetail?rid=${room}`))
    if (['rid', 'room_id', 'roomId'].some(name => Object.hasOwn(detail, name) && automationId(detail[name]) !== room)) throw new AutomationFault('invalid-response')
    const ids = automationArray(detail.taskIds, 128).map(value => automationId(value))
    if (ids.some(value => value === null) || new Set(ids).size !== ids.length) throw new AutomationFault('invalid-response')
    if (!ids.length) return []
    const result = automationEnvelope(await this.http.request(context, `${ORIGIN}/japi/tasksys/userLevelTask/getTaskStatus?taskIds=${ids.join(',')}`))
    const found = new Set<string>()
    const tasks = automationArray(result.list, 128).map(value => {
      const data = automationData(value)
      const id = automationId(data.taskId), status = automationNumber(data.taskStatus), prize = automationNumber(data.prizeStatus)
      if (!id || !ids.includes(id) || found.has(id) || status === null || prize === null || status > 1 || prize > 1) throw new AutomationFault('invalid-response')
      found.add(id)
      return { id, finished: status === 1, claimed: prize === 1 }
    })
    if (found.size !== ids.length) throw new AutomationFault('invalid-response')
    return tasks
  }

  private async level(context: AutomationContext, state: RunState): Promise<DouyuAutomationOutcome> {
    const room = this.targetRoom(context)
    const before = await this.levelTasks(context, room)
    const task = before.find(item => item.finished && !item.claimed)
    if (!task) { state.current = null; return this.result(state, 'scheduled', '暂无已完成且未领取的等级任务, 稍后重新检查.', POLL_MS) }
    state.current = task.id
    const key = this.guard(context, `${room}:${task.id}`)
    const result = automationEnvelope(await this.http.request(context, `${ORIGIN}/japi/tasksys/userLevelTask/getPrize`, {
      method: 'POST', fields: { taskIds: task.id, roomId: room },
    }))
    automationRecipient(context, result)
    if (['rid', 'room_id', 'roomId'].some(name => Object.hasOwn(result, name) && automationId(result[name]) !== room)) throw new AutomationFault('invalid-response')
    for (const value of automationArray(result.list, 128)) {
      const award = automationData(value)
      if (typeof award.name !== 'string' || award.name.length > 128 || automationNumber(award.num) === null) throw new AutomationFault('invalid-response')
    }
    const after = await this.levelTasks(context, room)
    if (!after.some(item => item.id === task.id && item.claimed)) throw new AutomationFault('unknown-result')
    this.confirmed(key, state)
    return this.result(state, 'scheduled', '已由官方状态确认领取等级任务奖励, 等待下一项.')
  }

  private async watched(context: AutomationContext, activity: DouyuPointsActivity): Promise<WatchTask[]> {
    if (activity.endsAt <= this.http.now()) throw new AutomationFault('eligibility')
    const data = automationEnvelope(await this.http.request(context, `${ORIGIN}/wgapi/activitync/gametask/viewStatus`, {
      method: 'POST', readOnlyPost: true, fields: { actAlias: activity.alias },
    }))
    if (Object.hasOwn(data, 'actAlias') && data.actAlias !== activity.alias) throw new AutomationFault('invalid-response')
    const start = automationNumber(data.startTime)
    const list = automationData(data.taskList)
    if (start === null || Object.keys(list).length > 128) throw new AutomationFault('invalid-response')
    return Object.entries(list).map(([id, value]) => {
      const status = automationNumber(record(value)?.status)
      if (!automationId(id) || status === null || status > 3) throw new AutomationFault('invalid-response')
      return { id, status, start: String(start) }
    })
  }
  private async watch(context: AutomationContext, state: RunState): Promise<DouyuAutomationOutcome> {
    state.points = await this.catalog.points(context)
    const tasks = await this.watched(context, state.points)
    const item = tasks.find(task => task.status === 2)
    if (!item) { state.current = null; return this.result(state, 'scheduled', '暂无官方确认可领取的观看积分, 稍后检查.', 5 * POLL_MS) }
    state.current = item.id
    const key = this.guard(context, `${state.points.alias}:${item.start}:${item.id}`)
    const receipt = automationEnvelope(await this.http.request(context, `${ORIGIN}/wgapi/activitync/gametask/takeGift`, {
      method: 'POST', fields: { id: item.id, actAlias: state.points.alias, startTime: item.start },
    }))
    automationRecipient(context, receipt)
    const after = await this.watched(context, state.points)
    if (!after.some(task => task.id === item.id && task.start === item.start && task.status === 3)) throw new AutomationFault('unknown-result')
    this.confirmed(key, state)
    return this.result(state, 'scheduled', '已由官方状态确认观看积分领取, 等待下一项.')
  }

  private async pointsSign(context: AutomationContext, state: RunState): Promise<DouyuAutomationOutcome> {
    state.points = await this.catalog.points(context)
    const id = state.points.signAlias
    if (this.attempts.get(this.key(context, id)) === 'confirmed') return this.result(state, 'succeeded', '本轮积分签到已收到官方回执, 不再重复提交.')
    const key = this.guard(context, id)
    // Existing official cvl_csrf_token is required. No fabricated token or
    // useJiYan=false override is supplied to bypass an interactive challenge.
    const response = automationEnvelope(await this.http.request(context, `${ORIGIN}/japi/carnivalApi/sign/doSign`, {
      method: 'POST', carnivalCsrf: true, fields: { signAlias: id },
    }))
    automationRecipient(context, response)
    if (Object.hasOwn(response, 'signAlias') && response.signAlias !== id) throw new AutomationFault('invalid-response')
    if (![response.is_signed, response.isSigned, response.signStatus].some(value => value === 1 || value === '1')) throw new AutomationFault('unknown-result')
    this.confirmed(key, state, 'receipt-received')
    return this.result(state, 'succeeded', '积分签到已收到官方回执, 实际积分请以官方账户为准.')
  }

  private async starRooms(context: AutomationContext): Promise<string[]> {
    const room = this.targetRoom(context)
    const data = automationEnvelope(await this.http.request(context, `${ORIGIN}/japi/livebiznc/web/anchorstardiscover/rank/info?rid=${room}&type=5&track=3`))
    const rooms = automationArray(data.rankItemList, 100).map(value => {
      const id = automationId(record(value)?.rid)
      if (!id || id.length > 12) throw new AutomationFault('invalid-response')
      return id
    })
    if (new Set(rooms).size !== rooms.length) throw new AutomationFault('invalid-response')
    return rooms
  }

  private async sequential(context: AutomationContext, state: RunState): Promise<DouyuAutomationOutcome> {
    const { task } = context
    if (!state.targets) {
      if (task.kind === 'yuba-read') state.targets = [...task.options.postIds!]
      else if (task.kind === 'follow-task') state.targets = [...task.options.followRooms!]
      else {
        const eligible = await this.starRooms(context)
        if (task.kind === 'anchor-star-follow') {
          if (task.options.followRooms!.some(room => !eligible.includes(room))) throw new AutomationFault('eligibility')
          state.targets = [...task.options.followRooms!]
        } else state.targets = eligible.slice(0, Math.min(task.options.maxItems ?? 3, 100))
      }
    }
    if (state.index >= state.targets.length) return this.result(state, 'succeeded', '本批任务已处理完毕, 任务奖励以官方状态为准.')
    const target = state.targets[state.index]!
    state.current = target
    if (task.kind === 'yuba-read') {
      const response = await this.http.request(context, `https://yuba.douyu.com/wbapi/web/post/detail/${target}?cid=&timestamp=${this.http.now()}`, { auth: 'dy-token' })
      const data = automationEnvelope(response, true)
      const post = record(data.post) ?? data
      const reportedId = post.post_id ?? post.id
      if (automationId(reportedId) !== target) throw new AutomationFault('invalid-response')
      state.completed++; state.evidence = 'none'
    } else if (task.kind === 'anchor-star-sign') {
      const key = this.guard(context, target)
      const receipt = automationEnvelope(await this.http.request(context, `${ORIGIN}/japi/livebiznc/web/anchorstardiscover/user/task/report`, {
        method: 'POST', fields: { type: '5', rid: target },
      }))
      automationRecipient(context, receipt)
      if (Object.hasOwn(receipt, 'rid') && automationId(receipt.rid) !== target
        || ![receipt.is_signed, receipt.isSigned, receipt.taskStatus].some(value => value === 1 || value === '1')) throw new AutomationFault('unknown-result')
      this.confirmed(key, state, 'receipt-received')
    } else await this.follow(context, state, target)
    state.index++
    return this.result(state, state.index >= state.targets.length ? 'succeeded' : 'scheduled', task.kind === 'yuba-read'
      ? '已读取指定官方鱼吧文章. 阅读任务奖励是否完成以官方状态为准.' : '本项处理完成, 已保留原有关注关系.')
  }

  private async followState(context: AutomationContext, target: string): Promise<number> {
    const data = automationEnvelope(await this.http.request(context, `${ORIGIN}/wgapi/livenc/liveweb/follow/query?rids=${target}`))
    const keys = Object.keys(data)
    const state = automationNumber(data[target])
    if (keys.length !== 1 || keys[0] !== target || state !== 0 && state !== 1) throw new AutomationFault('invalid-response')
    return state
  }
  private async follow(context: AutomationContext, state: RunState, target: string): Promise<void> {
    if (await this.followState(context, target) === 1) { state.completed++; state.skipped++; state.evidence = 'official-state'; return }
    const key = this.guard(context, target)
    const receipt = automationEnvelope(await this.http.request(context, `${ORIGIN}/wgapi/livenc/liveweb/follow/add`, { method: 'POST', fields: { rid: target } }))
    automationRecipient(context, receipt)
    if (await this.followState(context, target) !== 1) throw new AutomationFault('unknown-result')
    this.confirmed(key, state)
  }
}
