/** Current official gift packets and ordinary barrage boxes, main process only. */
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { hostAllowed } from '../config'
import { validDouyuRoom } from '../platforms/douyuRoom'
import { dnsResolver, isPrivateAddress, safeFetch } from '../safeFetch'
import type { DouyuActionDependencies } from './actions'
import { abortable, cancelBody, cancelled, MAX_TIMEOUT_MS, record } from './actionHttp'
import {
  assertRewardActive, readRewardJson, rewardAttention, rewardCredentials, rewardEnvelope,
  rewardHasRequirement, rewardId, rewardInteger, RewardProblem, rewardRoomMatches,
  type RewardCredentials, type RewardProblemCode,
} from './rewardProtocol'
import type { DouyuTaskDefinition, DouyuTaskOutcome } from './types'

const HOST = 'www.douyu.com'
const ORIGIN = `https://${HOST}`
const PACKET_LIST = `${ORIGIN}/japi/interactnc/web/propredpacket/getPrpList`
const PACKET_GRAB = `${ORIGIN}/japi/interactnc/web/propredpacket/grab_prp`
const PACKET_RESULT = `${ORIGIN}/japi/interactnc/web/propredpacket/get_prp_result`
const FOLLOW_QUERY = `${ORIGIN}/wgapi/livenc/liveweb/follow/query`
const BOX_PANEL = `${ORIGIN}/mgapi/activitync/box/panel`
const BOX_GRAB = `${ORIGIN}/wgapi/activitync/barrageBox/grab`
const MIN_DELAY = 5_000
const POLL_DELAY = 60_000
const MAX_DELAY = 24 * 60 * 60 * 1_000
const MAX_EVENTS = 64
const MAX_ATTEMPTS = 2_048
const waiting = (message: string): DouyuTaskOutcome => ({ status: 'waiting-user', message })
const failed = (message: string): DouyuTaskOutcome => ({ status: 'failed', message })

type Kind = 'gift-packet' | 'treasure-box'
type Attempt = {
  key: string; scope: string; id: string; uid: string; fingerprint: string
  state: 'submitted' | 'pending-result' | 'confirmed' | 'unknown'
}
type Context = {
  accountId: string; room: string; kind: Kind; signal: AbortSignal
  credentials?: RewardCredentials; dispatched: boolean; attempt?: Attempt
}
type Candidate = { id: string; readyAt: number; expiresAt: number | null; type?: number; followRequired?: boolean }
type JsonResponse = { payload: unknown; serverNow: number }
type Write = { event: Candidate; encoding: 'form' | 'json'; fields: (credentials: RewardCredentials) => Record<string, string | number> }

const messages: Record<RewardProblemCode, string> = {
  login: '斗鱼登录信息缺失或已变化. 请在该账号的官方房间重新确认登录.',
  verification: '斗鱼要求官方验证. 请在该账号的官方房间手动完成验证和核对结果, 再手动恢复任务.',
  phone: '斗鱼要求绑定手机号. 请在该账号的官方房间自行处理, 再手动恢复任务.',
  eligibility: '官方参与条件尚未满足或无法确认. 请在官方房间查看要求, 任务已暂停.',
  invalid: '官方活动状态或回执无法确认. 请在官方房间核对, 本次不会自动重试领取.',
  unavailable: '无法安全读取斗鱼活动状态. 请在官方房间核对后再恢复任务.',
  capacity: '本次会话的活动防重复记录已达上限. 任务已暂停, 请在官方房间核对.',
}

/** One long-lived instance retains uncertain attempts; restarting the app never arms tasks. */
export class DouyuRewardActions {
  private readonly attempts = new Map<string, Attempt>()
  private running = false
  constructor(private readonly deps: DouyuActionDependencies & { now?: () => number }) {}

  private now(): number { return (this.deps.now ?? Date.now)() }
  private scheduled(message: string, next = this.now() + POLL_DELAY): DouyuTaskOutcome {
    const now = this.now()
    return { status: 'scheduled', message, nextRunAt: Math.max(now + MIN_DELAY, Math.min(now + MAX_DELAY, next)) }
  }

  async run(task: DouyuTaskDefinition, signal: AbortSignal): Promise<DouyuTaskOutcome> {
    assertRewardActive(signal)
    const { accountId, room, kind } = task
    if (kind !== 'gift-packet' && kind !== 'treasure-box') return failed('该奖励任务类型尚未接入.')
    if (!validDouyuRoom(room)) return failed('斗鱼真实房间号无效, 请重新确认房间.')
    if (typeof accountId !== 'string' || !accountId || accountId.length > 128 || /[\s\x00-\x1f\x7f]/.test(accountId)) return waiting(messages.login)
    if (!this.deps.proxy.enabled || !hostAllowed(HOST, this.deps.proxy.hosts)) return failed('斗鱼活动请求未启用或目标域名未获允许.')
    if (!Number.isSafeInteger(this.now()) || this.now() < 0) return failed('本地时间无效, 活动任务已暂停.')
    if (this.running) return waiting('上一轮活动请求尚未结束, 请稍后再恢复任务.')
    this.running = true
    const timeout = new AbortController()
    const milliseconds = this.deps.proxy.requestTimeoutMs
    const timer = setTimeout(() => timeout.abort(), Number.isFinite(milliseconds) ? Math.max(1, Math.min(milliseconds, MAX_TIMEOUT_MS)) : MAX_TIMEOUT_MS)
    const context: Context = { accountId, room, kind, signal: AbortSignal.any([signal, timeout.signal]), dispatched: false }
    try {
      return kind === 'gift-packet' ? await this.packets(context) : await this.boxes(context)
    } catch (error) {
      if (context.attempt?.state === 'submitted') context.attempt.state = 'unknown'
      if (signal.aborted) throw cancelled()
      const code = error instanceof RewardProblem && Object.hasOwn(messages, error.code) ? error.code : 'unavailable'
      // A definite verification/phone rejection did not award anything. Only an
      // explicit user resume can re-enter this attempt; no challenge is retained.
      if (context.kind === 'treasure-box' && context.attempt && error instanceof RewardProblem && error.definiteRefusal) this.attempts.delete(context.attempt.key)
      if (context.dispatched && !['verification', 'phone', 'eligibility', 'login'].includes(code)) return waiting(timeout.signal.aborted
        ? '领取请求已提交但超时, 结果无法确认. 请在官方房间核对, 不会自动重试同一活动.'
        : '领取请求的结果无法确认. 请在官方房间核对, 不会自动重试同一活动.')
      return waiting(messages[code])
    } finally { clearTimeout(timer); this.running = false }
  }

  private scope(context: Context): string {
    return createHash('sha256').update(JSON.stringify([context.accountId, context.room, context.kind])).digest('hex')
  }
  private key(context: Context, id: string): string { return `${this.scope(context)}:${context.credentials!.uid}:${id}` }
  private markSubmitted(context: Context, event: Candidate, credentials: RewardCredentials): void {
    const key = this.key(context, event.id)
    if (this.attempts.has(key)) throw new RewardProblem('invalid')
    if (this.attempts.size >= MAX_ATTEMPTS) throw new RewardProblem('capacity')
    // Do not evict successful or uncertain IDs just to make room: the list need
    // not expose an expiry for packets, so eviction could permit a stale replay.
    const attempt: Attempt = { key, scope: this.scope(context), id: event.id, uid: credentials.uid, fingerprint: credentials.fingerprint, state: 'submitted' }
    this.attempts.set(key, attempt)
    context.attempt = attempt
    context.dispatched = true
  }

  private async packets(context: Context): Promise<DouyuTaskOutcome> {
    // This fresh list also establishes the current account's credential binding.
    const list = await this.request(context, `${PACKET_LIST}?type_id=1&room_id=${context.room}`)
    const data = rewardEnvelope(list.payload)
    if (!rewardRoomMatches(data, context.room) || !Array.isArray(data.list) || data.list.length > MAX_EVENTS) throw new RewardProblem('invalid')
    const scope = this.scope(context)
    const pending = [...this.attempts.values()].find(attempt => attempt.scope === scope && attempt.state === 'pending-result')
    if (pending) return this.packetResult(context, pending)
    if (data.list.length === 0) return this.scheduled('当前房间没有礼物红包, 稍后继续检查.')
    const candidates: Candidate[] = []
    const ids = new Set<string>()
    let restricted = false
    let unconfirmedFans = false
    for (const value of data.list) {
      const item = record(value)
      const id = rewardId(item?.activityid)
      if (!item || !id || ids.has(id) || !rewardRoomMatches(item, context.room)) throw new RewardProblem('invalid')
      ids.add(id)
      const join = rewardInteger(item.joinc)
      if (join === null || join > 3) throw new RewardProblem('invalid')
      if (rewardHasRequirement(item)) { restricted = true; continue }
      // Current official fc3e2 derives fans membership from authenticated
      // blst/gbi messages. A historic badge HTML row is not an equivalent proof.
      if (join >= 2) { unconfirmedFans = true; continue }
      const candidate = this.packetWindow(item, id, list.serverNow)
      candidate.followRequired = join === 1
      if (candidate.expiresAt !== null && candidate.expiresAt <= this.now()) continue
      const previous = this.attempts.get(this.key(context, id))
      if (previous?.state === 'unknown' || previous?.state === 'submitted') return waiting('此礼物红包已有一次结果不明的参与请求. 请在官方房间核对, 不会自动重复提交.')
      if (!previous) candidates.push(candidate)
    }
    candidates.sort((left, right) => left.readyAt - right.readyAt)
    // Prefer an already-open unrestricted packet, so it does not depend on an
    // unrelated follow query. At most one room-specific query is needed otherwise.
    let event = candidates.find(candidate => !candidate.followRequired && candidate.readyAt <= this.now()) ?? candidates[0]
    if (!event) return unconfirmedFans
      ? waiting('此红包要求粉丝资格, 当前无法通过已核验的只读接口确认. 请在官方房间确认并自行参与.')
      : restricted ? waiting('房间红包有额外参与条件. 请在官方房间确认并自行参与, 本次未执行附加操作.') : this.scheduled('本轮礼物红包已处理, 稍后继续检查新活动.')
    if (event.readyAt > this.now()) return this.scheduled('礼物红包尚未开启, 等待官方开启时间.', event.readyAt)
    if (event.followRequired && !await this.followed(context)) {
      event = candidates.find(candidate => !candidate.followRequired)
      if (!event) return waiting('官方确认该账号尚未关注此房间, 未参与要求关注的红包. 请在官方房间自行处理后再恢复任务.')
      if (event.readyAt > this.now()) return this.scheduled('等待无需关注条件的礼物红包开启.', event.readyAt)
    }

    // The official UI excludes the room's anchor even for joinc=0.
    const roomResult = await this.request(context, `${ORIGIN}/betard/${context.room}`, undefined, 262_144)
    const room = record(record(roomResult.payload)?.room)
    if (!room || rewardId(room.room_id) !== context.room || !rewardId(room.owner_uid)) throw new RewardProblem('invalid')
    if (rewardId(room.owner_uid) === context.credentials!.uid) return waiting('主播不能参与自己房间的礼物红包, 本次未发送领取请求.')
    this.assertWindow(event)
    const result = await this.request(context, PACKET_GRAB, {
      event, encoding: 'form', fields: credentials => ({ activityid: event.id, ctn: this.csrf(credentials) }),
    })
    const receipt = rewardEnvelope(result.payload)
    this.assertReceipt(receipt, context, event, ['activityid'])
    const success = rewardInteger(receipt.isSuc)
    if (success === 0) {
      context.attempt!.state = 'confirmed'
      return this.scheduled('官方确认本次礼物红包未抢到, 稍后继续检查新活动.')
    }
    if (success !== 1) throw new RewardProblem('invalid')
    // Official checkGetRed waits for prpresult; get_prp_result is the read-only
    // counterpart. A grab acknowledgement alone is not a reward confirmation.
    context.attempt!.state = 'pending-result'
    return this.scheduled('礼物红包参与已提交, 等待官方结果.', this.now() + MIN_DELAY)
  }

  private async followed(context: Context): Promise<boolean> {
    // Official common_17eee4a module 9fee9: followServices.checkFollow passes
    // rids and reads data[room]. Its data.follow field is a LOCAL wrapper only.
    const result = await this.request(context, `${FOLLOW_QUERY}?rids=${context.room}`)
    const statuses = rewardEnvelope(result.payload)
    const keys = Object.keys(statuses)
    if (keys.length !== 1 || keys[0] !== context.room) throw new RewardProblem('invalid')
    const state = rewardInteger(statuses[context.room])
    if (state !== 0 && state !== 1) throw new RewardProblem('invalid')
    return state === 1
  }

  private packetWindow(item: Record<string, unknown>, id: string, serverNow: number): Candidate {
    const localNow = this.now()
    let readyAt: number | null = null
    if (Object.hasOwn(item, 'cdtime')) {
      const countdown = rewardInteger(item.cdtime)
      if (countdown === null || countdown * 1_000 > MAX_DELAY) throw new RewardProblem('invalid')
      readyAt = localNow + countdown * 1_000
    }
    if (Object.hasOwn(item, 'startTime')) {
      const start = this.timestamp(item.startTime)
      if (start < serverNow - MAX_DELAY) throw new RewardProblem('invalid')
      readyAt = Math.max(readyAt ?? 0, localNow + start - serverNow)
    }
    if (readyAt === null || readyAt > localNow + MAX_DELAY) throw new RewardProblem('invalid')
    let expiresAt: number | null = null
    if (Object.hasOwn(item, 'endTime')) {
      expiresAt = localNow + this.timestamp(item.endTime) - serverNow
      if ((expiresAt > localNow && expiresAt <= readyAt) || expiresAt > localNow + MAX_DELAY) throw new RewardProblem('invalid')
    }
    return { id, readyAt, expiresAt }
  }

  private async packetResult(context: Context, attempt: Attempt): Promise<DouyuTaskOutcome> {
    if (context.credentials!.uid !== attempt.uid || context.credentials!.fingerprint !== attempt.fingerprint) throw new RewardProblem('login')
    const result = await this.request(context, `${PACKET_RESULT}?activityid=${attempt.id}`)
    const receipt = rewardEnvelope(result.payload)
    this.assertReceipt(receipt, context, { id: attempt.id, readyAt: 0, expiresAt: null }, ['activityid'])
    const status = rewardInteger(receipt.isSuc)
    if (status !== 0 && status !== 1) throw new RewardProblem('invalid')
    attempt.state = 'confirmed'
    return this.scheduled(status === 1 ? '官方已确认礼物红包结果, 奖励请在官方背包查看.' : '官方确认本次礼物红包未获得奖励, 稍后继续检查新活动.')
  }

  private async boxes(context: Context): Promise<DouyuTaskOutcome> {
    const response = await this.request(context, `${BOX_PANEL}?rid=${context.room}`)
    const data = rewardEnvelope(response.payload)
    if (!rewardRoomMatches(data, context.room) || !Array.isArray(data.list) || data.list.length > MAX_EVENTS) throw new RewardProblem('invalid')
    if (data.list.length === 0) return this.scheduled('当前房间没有普通弹幕宝箱, 稍后继续检查.')
    const candidates: Candidate[] = []
    const ids = new Set<string>()
    let restricted = false
    for (const value of data.list) {
      const item = record(value)
      const type = rewardInteger(item?.type)
      // type=1 is a separate carnival lucky-box flow, including its own hit rate.
      // otherList is the cross-room radar and is never traversed by this task.
      if (type === 1) { restricted = true; continue }
      if (!item || type !== 2 || !rewardRoomMatches(item, context.room)) throw new RewardProblem('invalid')
      const box = record(item.BarrageBox)
      const id = rewardId(box?.treasureId)
      const packetType = rewardInteger(box?.treasureType)
      if (!box || !id || ids.has(id) || packetType === null || packetType > 255 || !rewardRoomMatches(box, context.room)) throw new RewardProblem('invalid')
      ids.add(id)
      if (rewardHasRequirement(item) || rewardHasRequirement(box)) { restricted = true; continue }
      const open = this.timestamp(box.openTime)
      const destroy = this.timestamp(box.destroyTime)
      if (destroy <= open || open < response.serverNow - MAX_DELAY || destroy > response.serverNow + MAX_DELAY) throw new RewardProblem('invalid')
      const now = this.now()
      const event: Candidate = { id, type: packetType, readyAt: now + open - response.serverNow + MIN_DELAY, expiresAt: now + destroy - response.serverNow }
      if (event.expiresAt! <= now || event.readyAt >= event.expiresAt!) continue
      const previous = this.attempts.get(this.key(context, id))
      if (previous?.state === 'unknown' || previous?.state === 'submitted') return waiting('此宝箱已有一次结果不明的领取请求. 请在官方房间核对, 不会自动重复提交.')
      if (!previous) candidates.push(event)
    }
    candidates.sort((left, right) => left.readyAt - right.readyAt)
    const event = candidates[0]
    if (!event) return restricted ? waiting('当前宝箱有独立活动规则或参与要求. 请在官方房间查看并自行处理.') : this.scheduled('本轮普通弹幕宝箱已处理或已过期, 稍后继续检查.')
    if (event.readyAt > this.now()) return this.scheduled('宝箱尚未到可领取时间, 等待官方开启时间.', event.readyAt)
    this.assertWindow(event)
    const result = await this.request(context, BOX_GRAB, {
      event, encoding: 'json', fields: credentials => {
        if (!credentials.device) throw new RewardProblem('login')
        return { room_id: Number(context.room), device_id: credentials.device, version: 1, gt_version: 'v3', ct_version: '1', packettype: event.type!, packerid: Number(event.id), ctn: this.csrf(credentials) }
      },
    })
    const receipt = rewardEnvelope(result.payload)
    this.assertReceipt(receipt, context, event, ['packerid', 'treasureId'], false)
    const prize = rewardInteger(receipt.prizeType)
    if (prize === 0) {
      context.attempt!.state = 'confirmed'
      return this.scheduled('官方确认本次宝箱未获得奖励, 稍后继续检查新活动.')
    }
    if (prize === 1) {
      if (!(rewardInteger(receipt.silverCount)! > 0) || (Object.hasOwn(receipt, 'silverBalance') && rewardInteger(receipt.silverBalance) === null)) throw new RewardProblem('invalid')
    } else if (prize === 2) {
      if (!rewardId(receipt.propId) || !(rewardInteger(receipt.propCount)! > 0)) throw new RewardProblem('invalid')
    } else throw new RewardProblem('invalid')
    context.attempt!.state = 'confirmed'
    return this.scheduled('官方已返回宝箱奖励回执, 奖励请在官方账户查看.')
  }

  private timestamp(value: unknown): number {
    const seconds = rewardInteger(value)
    if (seconds === null || seconds < 1_577_836_800 || seconds > 4_102_444_800) throw new RewardProblem('invalid')
    return seconds * 1_000
  }
  private assertWindow(event: Candidate): void {
    if (event.readyAt > this.now() || (event.expiresAt !== null && event.expiresAt <= this.now())) throw new RewardProblem('invalid')
  }
  private csrf(credentials: RewardCredentials): string {
    if (!credentials.csrf) throw new RewardProblem('login')
    return credentials.csrf
  }
  private assertReceipt(receipt: Record<string, unknown>, context: Context, event: Candidate, ids: string[], required = true): void {
    if (rewardHasRequirement(receipt) || !rewardRoomMatches(receipt, context.room)) throw new RewardProblem('invalid')
    if (['error', 'code', 'result'].some(key => Object.hasOwn(receipt, key) && rewardInteger(receipt[key]) !== 0)) throw new RewardProblem('invalid')
    if (required && !ids.some(key => Object.hasOwn(receipt, key))) throw new RewardProblem('invalid')
    if (ids.some(key => Object.hasOwn(receipt, key) && rewardId(receipt[key]) !== event.id)) throw new RewardProblem('invalid')
    // Packet lists contain the sender's uid. Only explicitly recipient-named
    // receipt fields can be checked against the authenticated claimant.
    if (['receiverUid', 'receiver_uid', 'claimUid', 'claim_uid'].some(key => Object.hasOwn(receipt, key) && String(receipt[key]) !== context.credentials!.uid)) throw new RewardProblem('invalid')
  }

  private async credentials(context: Context, url: string): Promise<RewardCredentials> {
    assertRewardActive(context.signal)
    let header: string
    try { header = await abortable(this.deps.cookieHeader(context.accountId, url), context.signal) } catch {
      assertRewardActive(context.signal)
      throw new RewardProblem('login')
    }
    assertRewardActive(context.signal)
    const credentials = rewardCredentials(header)
    if (context.credentials && context.credentials.fingerprint !== credentials.fingerprint) throw new RewardProblem('login')
    context.credentials ??= credentials
    return credentials
  }

  private async request(context: Context, url: string, write?: Write, limit?: number): Promise<JsonResponse> {
    assertRewardActive(context.signal)
    const expected = new URL(url)
    if (expected.origin !== ORIGIN || expected.username || expected.password || expected.hash || expected.port) throw new RewardProblem('unavailable')
    await this.credentials(context, url)
    const { response } = await safeFetch(url, {
      ...this.deps.proxy, hosts: [HOST], maxRedirects: 0, allowNonLoopbackTargets: false, allowNonStandardPorts: false,
    }, {
      method: write ? 'POST' : 'GET', signal: context.signal,
      resolve: async host => {
        const addresses = await abortable((this.deps.resolve ?? dnsResolver)(host), context.signal)
        if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 64 || addresses.some(value => typeof value !== 'string' || !isIP(value) || isPrivateAddress(value))) throw new RewardProblem('unavailable')
        return addresses
      },
      fetchImpl: async (checkedUrl, init) => {
        const credentials = await this.credentials(context, url)
        assertRewardActive(context.signal)
        const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*', Cookie: credentials.header, Referer: `${ORIGIN}/${context.room}`, 'X-Requested-With': 'XMLHttpRequest', 'Cache-Control': 'no-cache' }
        if (credentials.xsrf) headers['X-XSRF-TOKEN'] = credentials.xsrf
        let body: string | undefined
        if (write) {
          this.assertWindow(write.event)
          const fields = write.fields(credentials)
          body = write.encoding === 'form' ? new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, String(value)])).toString() : JSON.stringify(fields)
          headers['Content-Type'] = write.encoding === 'form' ? 'application/x-www-form-urlencoded' : 'application/json;charset=utf-8'
          headers.Origin = ORIGIN
          this.markSubmitted(context, write.event, credentials)
        }
        const operation = (this.deps.request ?? fetch)(checkedUrl, { ...init, headers, body }).then(response => {
          if (context.signal.aborted) { cancelBody(response); throw cancelled() }
          return response
        })
        // A dispatched write retains the task manager's serial slot until the
        // transport settles, even if an injected transport ignores cancellation.
        const response = write ? await operation : await abortable(operation, context.signal)
        if (response.redirected || (response.url && response.url !== expected.href)) { cancelBody(response); throw new RewardProblem('unavailable') }
        return response
      },
    })
    assertRewardActive(context.signal)
    if (response.status !== 200) { cancelBody(response); rewardAttention(response.status, null) }
    const payload = await readRewardJson(response, context.signal, limit)
    await this.credentials(context, url)
    rewardAttention(response.status, payload)
    // HTTP Date can be cached and is not an authentication signal. Reject major
    // clock disagreements and use it only to translate official event seconds.
    const date = response.headers.get('date')
    const serverNow = date === null ? this.now() : Date.parse(date)
    if (!Number.isFinite(serverNow) || Math.abs(serverNow - this.now()) > 5 * 60_000) throw new RewardProblem('invalid')
    return { payload, serverNow }
  }
}
