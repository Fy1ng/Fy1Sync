import { isIP } from 'node:net'
import { hostAllowed } from '../config'
import { dnsResolver, isPrivateAddress, safeFetch } from '../safeFetch'
import { validDouyuRoom } from '../platforms/douyuRoom'
import type { DouyuActionDependencies } from './actions'
import { abortable, cancelBody, cancelled, record } from './actionHttp'
import { parseRewardJson, readRewardJson, rewardCredentials, RewardProblem, type RewardCredentials } from './rewardProtocol'
import { DouyuBackpackGateway } from './backpackGateway'
import { parseRenewalTargets } from './renewalInventory'
import type {
  DouyuBadgeAges, DouyuFollowedRoom, DouyuFollowedRooms, DouyuMonthlySpending,
  DouyuRoomInfo, DouyuSpendSource, DouyuWatchTime,
} from './insightsTypes'

const HOST = 'www.douyu.com'
const ORIGIN = `https://${HOST}`
const MAX_PAGES = 100
const MAX_ROOMS = 5_000
const MAX_LEDGER_ROWS = 10_000
const MAX_BODY = 1024 * 1024
const OFFSET = 8 * 60 * 60 * 1000
const safeAccount = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(id)
const integer = (value: unknown): number | null => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value))) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}
const identity = (value: unknown): string | null => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null
const text = (value: unknown, fallback = ''): string => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, 160) : fallback
const binary = (value: unknown): boolean | null => value === 1 || value === '1' ? true : value === 0 || value === '0' ? false : null
const liveState = (value: unknown): boolean | null => value === 1 || value === '1' ? true : [0, 2, '0', '2'].includes(value as number | string) ? false : null
const active = (signal: AbortSignal) => { if (signal.aborted) throw cancelled() }
const epoch = (value: unknown, now: number): number | null => {
  const n = integer(value)
  return n !== null && n > 0 && n * 1000 <= now ? n * 1000 : null
}

export type DouyuInsightsErrorCode = 'invalid-arguments' | 'login-required' | 'verification-required' | 'unavailable' | 'invalid-data' | 'busy'
export class DouyuInsightsError extends Error {
  constructor(readonly code: DouyuInsightsErrorCode) {
    super({
      'invalid-arguments': '查询参数无效.', 'login-required': '当前斗鱼账号未登录或登录信息已变化.',
      'verification-required': '斗鱼要求在官方页面完成账号验证.', unavailable: '暂时无法安全读取斗鱼数据.',
      'invalid-data': '斗鱼返回的数据不完整或无法确认.', busy: '数据查询较多, 请稍后重试.',
    }[code])
    this.name = 'DouyuInsightsError'
  }
}

function envelope(raw: unknown): unknown {
  const value = record(raw)
  if (!value) throw new DouyuInsightsError('invalid-data')
  const statuses = ['error', 'code', 'result'].filter(key => Object.hasOwn(value, key)).map(key => value[key])
  if (statuses.some(code => [-1, '-1', 401, '401', 101, '101'].includes(code as string | number))) throw new DouyuInsightsError('login-required')
  if (statuses.some(code => [16, '16', 170001, '170001'].includes(code as string | number))) throw new DouyuInsightsError('verification-required')
  if (!statuses.length || statuses.some(code => code !== 0 && code !== '0') || !Object.hasOwn(value, 'data')) throw new DouyuInsightsError('invalid-data')
  return typeof value.data === 'string' ? parseRewardJson(value.data) : value.data
}

type Session = { accountId?: string; credentials?: RewardCredentials; signal: AbortSignal }
type LedgerEntry = { id: string; globalId: string | null; amount: number; category: string }
type Ledger = { summary: DouyuSpendSource; entries: LedgerEntry[] }

/** Read-only access to fixed official endpoints. Credentials never become public DTO fields. */
export class DouyuInsightsGateway {
  private inFlight = 0
  constructor(private readonly deps: DouyuActionDependencies & { now?: () => number }) {}
  private now(): number {
    const now = (this.deps.now ?? Date.now)()
    if (!Number.isSafeInteger(now) || now < 0) throw new DouyuInsightsError('invalid-arguments')
    return now
  }

  private async scope<T>(accountId: string | undefined, signal: AbortSignal, run: (context: Session) => Promise<T>): Promise<T> {
    active(signal)
    if (accountId !== undefined && !safeAccount(accountId)) throw new DouyuInsightsError('invalid-arguments')
    if (!this.deps.proxy.enabled || !hostAllowed(HOST, this.deps.proxy.hosts)) throw new DouyuInsightsError('unavailable')
    if (this.inFlight >= 4) throw new DouyuInsightsError('busy')
    this.inFlight++
    // Covers the whole operation, including pagination and an unresponsive injected provider.
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 120_000)
    const context: Session = { accountId, signal: AbortSignal.any([signal, timeout.signal]) }
    try { return await run(context) }
    catch (error) {
      if (signal.aborted) throw cancelled()
      if (error instanceof DouyuInsightsError) throw error
      if (error instanceof RewardProblem) throw new DouyuInsightsError(error.code === 'login' ? 'login-required' : error.code === 'verification' ? 'verification-required' : 'invalid-data')
      throw new DouyuInsightsError('unavailable')
    } finally { clearTimeout(timer); this.inFlight-- }
  }

  private async credentials(context: Session, url: string): Promise<RewardCredentials | undefined> {
    active(context.signal)
    if (context.accountId === undefined) return undefined
    let value: RewardCredentials
    try { value = rewardCredentials(await abortable(this.deps.cookieHeader(context.accountId, url), context.signal)) }
    catch { active(context.signal); throw new DouyuInsightsError('login-required') }
    if (context.credentials && context.credentials.fingerprint !== value.fingerprint) throw new DouyuInsightsError('login-required')
    context.credentials = value
    return value
  }

  private async json(url: string, parent: Session): Promise<unknown> {
    const target = new URL(url)
    if (target.origin !== ORIGIN || target.username || target.password || target.hash || target.port) throw new DouyuInsightsError('invalid-arguments')
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), Math.max(1, Math.min(this.deps.proxy.requestTimeoutMs || 15_000, 15_000)))
    const context: Session = { ...parent, signal: AbortSignal.any([parent.signal, timeout.signal]) }
    try {
      await this.credentials(context, url)
      const { response } = await safeFetch(url, {
        ...this.deps.proxy, hosts: [HOST], maxRedirects: 0, allowNonLoopbackTargets: false, allowNonStandardPorts: false,
      }, {
        method: 'GET', signal: context.signal,
        resolve: async host => {
          const addresses = await abortable((this.deps.resolve ?? dnsResolver)(host), context.signal)
          if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some(address => !isIP(address) || isPrivateAddress(address))) throw new DouyuInsightsError('unavailable')
          return addresses
        },
        fetchImpl: async (input, init) => {
          const credentials = await this.credentials(context, url)
          active(context.signal)
          const headers: Record<string, string> = { Accept: 'application/json', Referer: `${ORIGIN}/`, 'Cache-Control': 'no-cache' }
          if (credentials) { headers.Cookie = credentials.header; if (credentials.xsrf) headers['X-XSRF-TOKEN'] = credentials.xsrf }
          const operation = (this.deps.request ?? fetch)(input, { ...init, headers }).then(value => {
            if (context.signal.aborted) { cancelBody(value); throw cancelled() }
            return value
          })
          const result = await abortable(operation, context.signal)
          if (result.redirected || (result.url && result.url !== target.href) || result.status !== 200) {
            cancelBody(result)
            throw new DouyuInsightsError([401, 302].includes(result.status) ? 'login-required' : 'unavailable')
          }
          return result
        },
      })
      const value = await readRewardJson(response, context.signal, MAX_BODY)
      await this.credentials(context, url)
      parent.credentials = context.credentials
      const payload = envelope(value)
      const owner = record(payload)?.uid
      if (context.credentials && owner !== undefined && identity(owner) !== context.credentials.uid) throw new DouyuInsightsError('login-required')
      return payload
    } finally { clearTimeout(timer) }
  }

  async readFollowedRooms(accountId: string, signal: AbortSignal): Promise<DouyuFollowedRooms> {
    return this.scope(accountId, signal, async context => {
      const rooms = new Map<string, DouyuFollowedRoom>()
      let expectedPages: number | null = null, expectedTotal: number | null = null, pageCount = 0
      let reason: string | null = null
      for (let page = 1; page <= MAX_PAGES; page++) {
        let data: Record<string, unknown> | null
        try { data = record(await this.json(`${ORIGIN}/wgapi/livenc/liveweb/follow/list?page=${page}`, context)) }
        catch (error) {
          if (!pageCount || (error instanceof DouyuInsightsError && ['login-required', 'verification-required'].includes(error.code)) || context.signal.aborted) throw error
          reason = '后续关注页读取失败, 已返回已核对部分.'; break
        }
        if (!data || !Array.isArray(data.list) || data.list.length > 200) throw new DouyuInsightsError('invalid-data')
        pageCount++
        const pages = integer(data.pageCount), total = integer(data.total)
        if (page === 1) { expectedPages = pages; expectedTotal = total }
        else if (pages !== expectedPages || total !== expectedTotal) { reason = '关注列表在分页期间变化, 请刷新后重试.'; break }
        let invalid = false
        const next: DouyuFollowedRoom[] = []
        for (const raw of data.list) {
          const item = record(raw), room = validDouyuRoom(item?.room_id)
          if (!item || !room || rooms.has(room) || next.some(value => value.room === room)) { invalid = true; break }
          next.push({ room, roomName: text(item.room_name, `房间 ${room}`), nickname: text(item.nickname),
            live: liveState(item.show_status), replay: binary(item.videoLoop), startedAt: epoch(item.show_time, this.now()),
            popularity: integer(item.online), url: `${ORIGIN}/${room}` })
        }
        if (invalid) { reason = '关注页包含重复或无效房间, 完整性无法确认.'; break }
        if (rooms.size + next.length > MAX_ROOMS) { reason = '关注数量超过本次读取上限.'; break }
        next.forEach(room => rooms.set(room.room, room))
        if (expectedPages === null || expectedTotal === null) { reason = '官方响应未提供可核对的分页总数.'; break }
        if (expectedPages === 0 && (expectedTotal !== 0 || rooms.size !== 0)) { reason = '关注分页总数与实际内容不一致.'; break }
        if (page >= expectedPages) {
          if (rooms.size !== expectedTotal) reason = '关注总数与已取得的房间数不一致.'
          break
        }
        if (!next.length || page === MAX_PAGES) { reason = '关注列表未能在读取上限内完整返回.'; break }
      }
      return { accountId, checkedAt: this.now(), coverage: reason === null ? 'all-pages' : 'partial', pageCount, rooms: [...rooms.values()], reason }
    })
  }

  async readRoom(room: string, signal: AbortSignal): Promise<DouyuRoomInfo> {
    if (!validDouyuRoom(room)) throw new DouyuInsightsError('invalid-arguments')
    return this.scope(undefined, signal, async context => {
      const data = record(await this.json(`${ORIGIN}/swf_api/h5room/${room}`, context))
      if (!data || validDouyuRoom(data.room_id) !== room) throw new DouyuInsightsError('invalid-data')
      const now = this.now(), live = liveState(data.show_status), started = epoch(data.show_time, now)
      return { room, checkedAt: now, roomName: text(data.room_name, `房间 ${room}`), nickname: text(data.nickname),
        ownerUid: identity(data.owner_uid), live, replay: binary(data.videoLoop ?? data.is_loop),
        startedAt: live === true ? started : null, lastStartedAt: live === false ? started : null,
        popularity: integer(data.online), viewers: null, source: 'douyu-h5room' }
    })
  }

  async readBadgeAges(accountId: string, signal: AbortSignal): Promise<DouyuBadgeAges> {
    return this.scope(accountId, signal, async context => {
      const value = await new DouyuBackpackGateway(this.deps).readBadges(accountId, context.signal)
      const checkedAt = this.now()
      const badges = parseRenewalTargets(value.html, { now: checkedAt }).map(target => ({
        room: target.room, badgeName: target.badgeName, acquiredAt: target.acquiredAt ?? null, heldDays: target.heldDays ?? null,
      }))
      return { accountId, checkedAt, coverage: 'returned-page', badges }
    })
  }

  async readWatchTime(accountId: string, room: string, signal: AbortSignal): Promise<DouyuWatchTime> {
    if (!validDouyuRoom(room)) throw new DouyuInsightsError('invalid-arguments')
    return this.scope(accountId, signal, async context => {
      const data = record(await this.json(`${ORIGIN}/japi/interactnc/web/fsjk/getCardTaskInfo?rid=${room}`, context))
      if (!data || (data.rid !== undefined && validDouyuRoom(data.rid) !== room)) throw new DouyuInsightsError('invalid-data')
      const seconds = integer(data.todayWatch)
      return { accountId, room, checkedAt: this.now(), seconds: seconds !== null && seconds <= 86_400 ? seconds : null, source: 'douyu-today-watch' }
    })
  }

  async readMonthlySpending(accountId: string, signal: AbortSignal): Promise<DouyuMonthlySpending> {
    return this.scope(accountId, signal, async context => {
      const checkedAt = this.now(), date = new Date(checkedAt + OFFSET)
      const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
      const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) - OFFSET
      const endDay = `${month}-${String(date.getUTCDate()).padStart(2, '0')}`
      const gift = await this.ledger(context, 'gift-consumption', start, checkedAt, `${month}-01`, endDay)
      const diamond = await this.ledger(context, 'diamond-fans', start, checkedAt, `${month}-01`, endDay)
      const complete = [gift, diamond].every(source => source.summary.coverage === 'all-pages')
      let totalMinor: number | null = null
      let aggregation: DouyuMonthlySpending['aggregation'] = complete ? 'unreconciled' : 'partial'
      if (complete) {
        if (!gift.entries.length || !diamond.entries.length) totalMinor = gift.summary.amountMinor + diamond.summary.amountMinor
        else if ([...gift.entries, ...diamond.entries].every(item => item.globalId !== null)) {
          const unique = new Map<string, number>()
          let conflict = false
          for (const item of [...gift.entries, ...diamond.entries]) {
            const prior = unique.get(item.globalId!)
            if (prior !== undefined && prior !== item.amount) { conflict = true; break }
            unique.set(item.globalId!, item.amount)
          }
          if (!conflict) totalMinor = [...unique.values()].reduce((sum, amount) => sum + amount, 0)
        }
        if (totalMinor !== null && Number.isSafeInteger(totalMinor)) aggregation = 'complete'
        else totalMinor = null
      }
      return { accountId, checkedAt, month, timeZone: 'Asia/Shanghai', currency: 'CNY', unit: 'fen',
        sources: [gift.summary, diamond.summary], totalMinor, aggregation,
        message: aggregation === 'complete' ? '本月消费已按已核对账单汇总.' : aggregation === 'partial'
          ? '账单未完整返回, 各来源仅显示已取得的金额.' : '两个账单来源缺少共同订单标识, 无法排除重叠, 已分别显示金额.' }
    })
  }

  private async ledger(context: Session, source: DouyuSpendSource['source'], start: number, end: number, startDay: string, endDay: string): Promise<Ledger> {
    const entries: LedgerEntry[] = [], seen = new Set<string>()
    let cursor: string | null = null, pageCount = 0, reason: string | null = null, finished = false
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = source === 'gift-consumption' ? new URL(`${ORIGIN}/wjapi/nc/exchange/consume/giftList`)
        : new URL(`${ORIGIN}/japi/interactnc/web/dFansbadge/myLogs`)
      if (source === 'gift-consumption') {
        for (const [key, value] of Object.entries({ queryType: '0', consumeType: '0', startDate: String(Math.floor(start / 1000)), endDate: String(Math.floor(end / 1000)), tradeStartDate: startDay, tradeEndDate: endDay, direction: '1' })) url.searchParams.set(key, value)
        if (cursor) url.searchParams.set('id', cursor)
      } else { url.searchParams.set('type', '0'); url.searchParams.set('page', String(page)) }
      let payload: unknown
      try { payload = await this.json(url.href, context) }
      catch (error) {
        if ((error instanceof DouyuInsightsError && ['login-required', 'verification-required'].includes(error.code)) || context.signal.aborted) throw error
        reason = '该消费来源读取失败或被限流.'; break
      }
      const list = source === 'gift-consumption' ? payload : record(payload)?.list
      if (!Array.isArray(list) || list.length > 200) { reason = '消费列表形状无法确认.'; break }
      pageCount++
      let reachedEarlierMonth = false, invalid = false
      const parsed: LedgerEntry[] = []
      for (const raw of list) {
        const item = record(raw)
        if (!item) { invalid = true; break }
        const id = identity(item.id)
        const rawAmount = source === 'gift-consumption' ? item.amount : item.consumeMoney
        const amount = typeof rawAmount === 'number' ? rawAmount : typeof rawAmount === 'string' && /^-?(0|[1-9][0-9]{0,14})$/.test(rawAmount) ? Number(rawAmount) : NaN
        if (!Number.isSafeInteger(amount) || Math.abs(amount) > 1_000_000_000_000) { invalid = true; break }
        // The consumption endpoint is an outgoing ledger. A negative amount is a debit,
        // while the diamond ledger reports the positive paid amount. Refunds remain signed.
        const paid = source === 'gift-consumption' ? -amount : amount
        if (source === 'diamond-fans') {
          const time = integer(item.consumeTime)
          if (time === null || time <= 0 || time * 1000 > end) { invalid = true; break }
          if (time * 1000 < start) { reachedEarlierMonth = true; continue }
        }
        const key = id ?? (source === 'diamond-fans' ? `${String(item.consumeTime)}:${text(item.room_id)}:${amount}:${text(item.type)}` : null)
        if (!key || seen.has(key) || parsed.some(entry => entry.id === key)) { invalid = true; break }
        const order = item.orderId ?? item.order_id ?? item.tradeNo ?? item.trade_no
        const globalId = typeof order === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(order) ? order : null
        parsed.push({ id: key, globalId, amount: paid, category: source === 'gift-consumption' ? text(item.consumeTypeDesc, '其他') : '钻粉充值/续费' })
      }
      if (invalid) { reason = '消费页包含重复记录或无法确认的金额.'; break }
      if (entries.length + parsed.length > MAX_LEDGER_ROWS) { reason = '消费记录超过本次读取上限.'; break }
      for (const item of parsed) { seen.add(item.id); entries.push(item) }
      if (list.length < 20 || reachedEarlierMonth) { finished = true; break }
      if (source === 'gift-consumption') {
        const next = identity(record(list[list.length - 1])?.id)
        if (!next || next === cursor) { reason = '消费分页游标未前进.'; break }
        cursor = next
      }
      if (page === MAX_PAGES) reason = '消费列表未能在读取上限内完整返回.'
    }
    const categories = new Map<string, { category: string; amountMinor: number; entries: number }>()
    let amountMinor = 0
    for (const item of entries) {
      amountMinor += item.amount
      const category = categories.get(item.category) ?? { category: item.category, amountMinor: 0, entries: 0 }
      category.amountMinor += item.amount; category.entries++
      categories.set(item.category, category)
    }
    if (!Number.isSafeInteger(amountMinor)) throw new DouyuInsightsError('invalid-data')
    return { entries, summary: { source, coverage: finished && reason === null ? 'all-pages' : 'partial', pageCount,
      entries: entries.length, amountMinor, categories: [...categories.values()], reason } }
  }
}
