/** Official fish-act protocol. Each scheduler turn performs at most one write. */
import { isIP } from 'node:net'
import { hostAllowed } from '../config'
import { validDouyuRoom } from '../platforms/douyuRoom'
import { dnsResolver, isPrivateAddress, safeFetch } from '../safeFetch'
import type { DouyuActionDependencies } from './actions'
import { abortable, cancelled, MAX_RESPONSE_BYTES, MAX_TIMEOUT_MS, record } from './actionHttp'
import type { DouyuTaskDefinition, DouyuTaskOutcome } from './types'

const ORIGIN = 'https://www.douyu.com'
const CONFIG_URL = 'https://webconf.douyucdn.cn/resource/common/activity/actfans_w.json'
const API = `${ORIGIN}/japi/revenuenc/web/actfans/fishing`
const START_URL = `${API}/fishing`
const REEL_URL = `${API}/reelIn`
const CONFIG_LIMIT = 512 * 1_024
const MIN_WAIT = 5_000
const MAX_WAIT = 24 * 60 * 60 * 1_000
const EMPTY_WAIT = 60_000
const AUTH_FIELDS = ['acf_auth', 'acf_auth_wl', 'acf_dmjwt_token', 'acf_stk', 'acf_ltkid', 'acf_biz', 'acf_ct'] as const
const CREDENTIAL_FIELDS = new Set<string>(['acf_uid', 'acf_ccn', 'XSRF-TOKEN', ...AUTH_FIELDS])
const homeUrl = (room: string, initial = true) => `${API}/homePage?rid=${room}&opt=${initial ? 1 : 0}`
const active = (signal: AbortSignal): void => { if (signal.aborted) throw cancelled() }
const waiting = (message: string): DouyuTaskOutcome => ({ status: 'waiting-user', message })
const failed = (message: string): DouyuTaskOutcome => ({ status: 'failed', message })
const unconfirmed = () => waiting('本次钓鱼操作结果尚无法确认. 请在官方钓鱼页面核对, 任务已暂停且不会自动重试.')

type FaultCode = 'login' | 'verification' | 'rate' | 'eligibility' | 'data'
class FishingFault extends Error {
  constructor(readonly code: FaultCode = 'data') { super('Douyu fishing unavailable.') }
}
const invalid = (): never => { throw new FishingFault() }
const FAULT_MESSAGES: Record<FaultCode, string> = {
  login: '斗鱼登录信息缺失, 失效或已变化. 请重新登录该账号.',
  verification: '斗鱼要求官方验证. 请在官方页面完成验证后再启动钓鱼.',
  rate: '斗鱼限制了请求频率. 钓鱼任务已暂停, 请稍后核对官方状态.',
  eligibility: '该房间或账号的钓鱼资格尚未确认. 请在官方钓鱼页面查看要求.',
  data: '无法确认当前钓鱼状态或免费鱼饵规则, 未发送操作请求. 请在官方钓鱼页面核对.',
}
type Credentials = { uid: string; header: string; ccn: string | null; xsrf: string | null; fingerprint: string }
type Target = Pick<DouyuTaskDefinition, 'accountId' | 'room'>
type Context = Target & { credentials?: Credentials }
type Bait = { id: number; count: number; inUse: number }
type Home = { state: number; serverNow: number; start: number | null; end: number | null; autoEnd: number | null; role: number; baits: Bait[] }

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9]\d{0,15})$/.test(value))) return null
  const result = Number(value)
  return Number.isSafeInteger(result) && result >= 0 && result <= maximum ? result : null
}

function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  const result = integer(value, maximum)
  return result !== null && result > 0 ? result : null
}

/** Bind identity and auth material, while allowing an endpoint's own CSRF cookie. */
function credentialsFrom(header: unknown): Credentials {
  if (typeof header !== 'string' || !header || header.length > 32_768 || !/^[\x20-\x7e]+$/.test(header)) throw new FishingFault('login')
  const fields = new Map<string, string>()
  for (const part of header.split(';')) {
    if (!part.trim()) continue
    const separator = part.indexOf('=')
    if (separator < 1) throw new FishingFault('login')
    const name = part.slice(0, separator).trim()
    const raw = part.slice(separator + 1).trim()
    if (!/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(name) || /[\s\x00-\x1f\x7f"\\,;]/.test(raw)) throw new FishingFault('login')
    if (!CREDENTIAL_FIELDS.has(name)) continue
    if (fields.has(name)) throw new FishingFault('login')
    let value: string
    try { value = decodeURIComponent(raw) } catch { throw new FishingFault('login') }
    if (value.length > 8_192 || !/^[A-Za-z0-9._~+\/=:-]*$/.test(value) || /^(null|undefined)$/i.test(value)) throw new FishingFault('login')
    fields.set(name, value)
  }
  const uid = fields.get('acf_uid')
  if (!uid || !/^[1-9][0-9]{0,19}$/.test(uid) || !(fields.get('acf_auth') || fields.get('acf_auth_wl') || fields.get('acf_dmjwt_token') || (fields.get('acf_stk') && fields.get('acf_ltkid') && fields.get('acf_biz')))) throw new FishingFault('login')
  const ccn = fields.get('acf_ccn') ?? null
  const xsrf = fields.get('XSRF-TOKEN') ?? null
  if ([ccn, xsrf].some(value => value !== null && (!value || value.length > 2_048))) throw new FishingFault('login')
  return { uid, header, ccn, xsrf, fingerprint: JSON.stringify([uid, ...AUTH_FIELDS.map(name => fields.get(name) ?? '')]) }
}

/** Refuse duplicate JSON keys and pathological depth before trusting status/IDs. */
function parseJson(text: string): unknown {
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { return invalid() }
  const scopes: Array<Set<string> | null> = []
  for (let index = 0; index < text.length;) {
    const character = text[index]
    if (character === '{' || character === '[') {
      if (scopes.length >= 64) return invalid()
      scopes.push(character === '{' ? new Set<string>() : null)
      index++
    } else if (character === '}' || character === ']') { scopes.pop(); index++ }
    else if (character === '"') {
      const start = index++
      while (index < text.length) {
        if (text[index] === '\\') index += 2
        else if (text[index++] === '"') break
      }
      let next = index
      while (next < text.length && /\s/.test(text[next]!)) next++
      if (text[next] === ':') {
        const keys = scopes[scopes.length - 1]
        const key = JSON.parse(text.slice(start, index)) as string
        if (!keys || keys.has(key) || keys.size >= 4_096) return invalid()
        keys.add(key)
      }
    } else index++
  }
  return value
}

function boundData(value: unknown, context: Context): Record<string, unknown> {
  const data = record(typeof value === 'string' ? parseJson(value) : value) ?? invalid()
  for (const [names, expected] of [[['uid', 'userId', 'user_id'], context.credentials?.uid], [['rid', 'roomId', 'room_id'], context.room]] as const) {
    for (const name of names) {
      if (Object.hasOwn(data, name) && String(data[name]) !== expected) return invalid()
    }
  }
  return data
}

function envelope(value: unknown, context: Context): Record<string, unknown> {
  const result = boundData(value, context)
  const message = [result.msg, result.message].filter((item): item is string => typeof item === 'string' && item.length <= 512).join(' ')
  if (integer(result.error) === 1002 || /未登录|请.{0,8}登录|登录.{0,8}(失效|过期)|invalid.{0,3}token|login.required/i.test(message)) throw new FishingFault('login')
  if (/验证码|人机验证|安全验证|滑块|captcha|geetest/i.test(message)) throw new FishingFault('verification')
  if (/无资格|没有资格|不满足|未满足|权限不足|等级不足|未开放|已关闭/i.test(message)) throw new FishingFault('eligibility')
  if (integer(result.error) !== 0 || ['code', 'result'].some(name => Object.hasOwn(result, name) && integer(result[name]) !== 0)) return invalid()
  return result
}

function homeFrom(value: unknown, context: Context): Home {
  const data = boundData(envelope(value, context).data, context)
  const fishing = boundData(data.fishing, context)
  const state = integer(fishing.stat)
  const serverNow = positive(data.timeMs)
  const role = data.myCh === null ? 0 : integer(record(data.myCh)?.ctype, 1_000_000)
  if (state === null || ![0, 1, 2, 10, 11, 20, 21].includes(state) || serverNow === null || role === null || !Array.isArray(data.baits) || data.baits.length > 32) return invalid()
  const ids = new Set<number>()
  const baits = data.baits.map(value => {
    const bait = record(value)
    const id = positive(bait?.id, 1_000_000)
    const count = integer(bait?.cnt, 1_000_000_000)
    const inUse = integer(bait?.inUse, 1)
    if (id === null || count === null || inUse === null || ids.has(id)) return invalid()
    ids.add(id)
    return { id, count, inUse }
  })
  if (baits.filter(bait => bait.inUse === 1).length > 1) return invalid()
  const start = positive(fishing.fishStMs)
  const end = positive(fishing.fishEtMs)
  const autoEnd = positive(record(fishing.autoInfo)?.etMs)
  if ([1, 2, 20].includes(state) && (start === null || end === null || start > serverNow || end <= start)) return invalid()
  if (state === 2 && end! > serverNow) return invalid()
  if (state === 10 && autoEnd === null) return invalid()
  return { state, serverNow, start, end, autoEnd, role, baits }
}

/** Current official baitLv=1 has no gift charge; all price fields stay explicit. */
function freeBaitCost(text: string, room: string): number {
  const match = /^\s*DYConfigCallback\((\{[\s\S]*\})\);?\s*$/.exec(text)
  if (!match) return invalid()
  const config = record(parseJson(match[1]!))
  const data = record(config?.data)
  const settings = record(data?.activity_setting)
  const dispatch = record(data?.diapatch_setting)
  if (config?.callback !== 'actfans' || integer(settings?.system_switch) !== 1 || !Array.isArray(dispatch?.blacklist) || !Array.isArray(dispatch.cate2_blacklist)) throw new FishingFault('eligibility')
  if (dispatch.blacklist.length > 10_000 || dispatch.blacklist.some(value => positive(value) === null) || dispatch.blacklist.some(value => String(value) === room)) throw new FishingFault('eligibility')
  // No category is supplied by this task or verified by homePage. Refuse a new
  // category restriction rather than silently bypassing the official gate.
  if (dispatch.cate2_blacklist.length !== 0) throw new FishingFault('eligibility')
  const baitList = record(record(data?.fishingConfig)?.baitConfig)?.baitList
  if (!Array.isArray(baitList) || baitList.length > 16) return invalid()
  const candidates = baitList.filter(item => integer(record(item)?.baitLv) === 1)
  if (candidates.length !== 1) return invalid()
  const bait = record(candidates[0])!
  const cost = positive(bait.costNum, 100_000)
  if (cost === null || ['giftId', 'giftNum', 'giftPrice', 'singleGiftNum'].some(name => integer(bait[name]) !== 0)) return invalid()
  return cost
}

export class DouyuFishingActions {
  constructor(private readonly deps: DouyuActionDependencies & { now?: () => number }) {}

  async run(task: DouyuTaskDefinition, signal: AbortSignal): Promise<DouyuTaskOutcome> {
    active(signal)
    const { accountId, room, kind } = task
    if (kind !== 'auto-fish') return failed('该钓鱼任务类型尚未接入.')
    if (typeof room !== 'string' || !validDouyuRoom(room)) return failed('斗鱼真实房间号无效, 请重新确认房间.')
    if (typeof accountId !== 'string' || !accountId || accountId.length > 128 || /[\s\x00-\x1f\x7f]/.test(accountId)) return waiting(FAULT_MESSAGES.login)
    if (!this.deps.proxy.enabled || !['www.douyu.com', 'webconf.douyucdn.cn'].every(host => hostAllowed(host, this.deps.proxy.hosts))) return failed('钓鱼请求未启用或目标域名未获允许.')
    const timeout = new AbortController()
    const duration = Number.isFinite(this.deps.proxy.requestTimeoutMs) ? Math.max(1, Math.min(this.deps.proxy.requestTimeoutMs, MAX_TIMEOUT_MS)) : MAX_TIMEOUT_MS
    const timer = setTimeout(() => timeout.abort(), duration)
    const combined = AbortSignal.any([signal, timeout.signal])
    let dispatched = false
    try {
      // Await the actual transport/reader. Racing it against abort would release
      // the account's serial slot while an uncooperative request still runs.
      return await this.perform({ accountId, room }, combined, () => { dispatched = true })
    } catch (error) {
      if (signal.aborted) throw cancelled()
      if (dispatched) return unconfirmed()
      return waiting(FAULT_MESSAGES[error instanceof FishingFault ? error.code : 'data'])
    } finally { clearTimeout(timer) }
  }

  private schedule(message: string, delay = EMPTY_WAIT): DouyuTaskOutcome {
    const now = (this.deps.now ?? Date.now)()
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - MAX_WAIT || !Number.isFinite(delay)) return invalid()
    return { status: 'scheduled', message, nextRunAt: now + Math.max(MIN_WAIT, Math.min(MAX_WAIT, Math.ceil(delay))) }
  }

  private async perform(context: Context, signal: AbortSignal, dispatch: () => void): Promise<DouyuTaskOutcome> {
    const before = await this.readHome(context, signal)
    if (!before.role) return waiting('请先在官方钓鱼页面设置鱼娘形象, 本次未发送操作请求.')
    if (before.state === 11 || before.state === 21) return waiting('官方自动钓鱼正在等待鱼饵. 请在官方页面处理后再启动任务.')
    if (before.state === 10) {
      if (before.autoEnd! <= before.serverNow) return waiting('官方自动钓鱼已结束. 请在官方钓鱼页面查看结果后再启动任务.')
      return this.schedule('官方自动钓鱼进行中, 等待其结束.', before.autoEnd! - before.serverNow + 2_000)
    }
    if (before.state === 1 || before.state === 20) return this.schedule('钓鱼进行中, 等待官方状态更新.', before.end! - before.serverNow + 2_000)

    const cost = freeBaitCost(await this.request(context, CONFIG_URL, signal), context.room)
    let selected: Bait | undefined
    if (before.state === 0) {
      selected = before.baits.find(bait => bait.inUse === 1)
      if (!selected || selected.id !== 1) return waiting('请先在官方钓鱼页面选用入门鱼饵. 本任务只使用已持有的免费入门鱼饵.')
      if (selected.count < cost) return waiting('可用入门鱼饵不足, 钓鱼任务已暂停. 请在官方页面核对免费获取条件.')
    }
    const isStart = before.state === 0
    const result = envelope(parseJson(await this.request(context, isStart ? START_URL : REEL_URL, signal, { dispatch, ...(isStart ? { baitId: '1', ver: '1.1' } : {}) })), context)
    // The official start callback refreshes homePage and does not rely on a
    // particular POST data shape. Never accept its error=0 as the final proof.
    if (result.data !== undefined && result.data !== null && result.data !== '') {
      const data = boundData(result.data, context)
      if (data.fishing !== undefined) boundData(data.fishing, context)
    }
    if (!isStart) {
      const data = boundData(result.data, context)
      const fish = boundData(data.fish, context)
      const weight = typeof fish.wei === 'number' ? fish.wei : typeof fish.wei === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(fish.wei) ? Number(fish.wei) : NaN
      if (positive(fish.id, 1_000_000) === null || !Number.isFinite(weight) || weight < 0 || weight > 1_000_000 || (data.awards !== undefined && (!Array.isArray(data.awards) || data.awards.length > 256))) return unconfirmed()
    }
    const after = await this.readHome(context, signal, false)
    if (after.serverNow < before.serverNow) return unconfirmed()
    if (isStart) {
      const bait = after.baits.find(item => item.id === 1 && item.inUse === 1)
      if (![1, 20].includes(after.state) || !after.role || after.start! < before.serverNow || after.end! <= after.serverNow || !bait || bait.count !== selected!.count - cost) return unconfirmed()
      return this.schedule('已由官方状态确认开始钓鱼, 等待本轮结束.', after.end! - after.serverNow + 2_000)
    }
    return after.state === 0 ? this.schedule('已由官方状态确认收杆, 等待下一轮免费钓鱼.', MIN_WAIT) : unconfirmed()
  }

  private async credentials(context: Context, url: string, signal: AbortSignal): Promise<Credentials> {
    active(signal)
    let header: string
    try { header = await abortable(this.deps.cookieHeader(context.accountId, url), signal) } catch {
      active(signal)
      throw new FishingFault('login')
    }
    active(signal)
    const credentials = credentialsFrom(header)
    if (context.credentials && context.credentials.fingerprint !== credentials.fingerprint) throw new FishingFault('login')
    context.credentials ??= credentials
    return credentials
  }

  private async readHome(context: Context, signal: AbortSignal, initial = true): Promise<Home> {
    return homeFrom(parseJson(await this.request(context, homeUrl(context.room, initial), signal)), context)
  }

  private async request(context: Context, url: string, signal: AbortSignal, write?: { dispatch: () => void; baitId?: string; ver?: string }): Promise<string> {
    active(signal)
    const publicRequest = url === CONFIG_URL
    const expected = new URL(url)
    if ((!publicRequest && expected.origin !== ORIGIN) || (write && url !== START_URL && url !== REEL_URL)) return invalid()
    const original = publicRequest ? null : await this.credentials(context, url, signal)
    const { response } = await safeFetch(url, {
      ...this.deps.proxy, hosts: [expected.hostname], maxRedirects: 0,
      allowNonStandardPorts: false, allowNonLoopbackTargets: false,
    }, {
      signal, method: write ? 'POST' : 'GET',
      resolve: async host => {
        const addresses = await abortable((this.deps.resolve ?? dnsResolver)(host), signal)
        if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some(address => typeof address !== 'string' || !isIP(address) || isPrivateAddress(address))) return invalid()
        return addresses
      },
      fetchImpl: async (checkedUrl, init) => {
        const latest = publicRequest ? null : await this.credentials(context, url, signal)
        if (original && latest?.fingerprint !== original.fingerprint) throw new FishingFault('login')
        active(signal)
        const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*', Referer: `${ORIGIN}/pages/fish-act?rid=${context.room}` }
        if (latest) {
          headers.Cookie = latest.header
          headers['X-Requested-With'] = 'XMLHttpRequest'
          if (latest.xsrf) headers['X-XSRF-TOKEN'] = latest.xsrf
        }
        let body: string | undefined
        if (write) {
          if (!latest?.ccn) throw new FishingFault('login')
          headers['Content-Type'] = 'application/x-www-form-urlencoded'
          headers.Origin = ORIGIN
          body = new URLSearchParams({ ctn: latest.ccn, rid: context.room, ...(write.baitId ? { baitId: write.baitId, ver: write.ver! } : {}) }).toString()
        } else { headers['Cache-Control'] = 'no-cache'; headers.Pragma = 'no-cache' }
        write?.dispatch()
        const result = await (this.deps.request ?? fetch)(checkedUrl, { ...init, headers, body })
        if (signal.aborted || result.redirected || (result.url && result.url !== expected.href) || result.status !== 200) {
          await result.body?.cancel().catch(() => {})
          active(signal)
          if (result.status === 401) throw new FishingFault('login')
          if (result.status === 429) throw new FishingFault('rate')
          return invalid()
        }
        return result
      },
    })
    const text = await this.readText(response, signal, publicRequest ? CONFIG_LIMIT : MAX_RESPONSE_BYTES)
    if (!publicRequest) await this.credentials(context, url, signal)
    return text
  }

  private async readText(response: Response, signal: AbortSignal, limit: number): Promise<string> {
    const advertised = response.headers.get('content-length')
    if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > limit)) {
      await response.body?.cancel().catch(() => {})
      return invalid()
    }
    if (!response.body) return invalid()
    const reader = response.body.getReader()
    let cancelling: Promise<unknown> | undefined
    const cancel = () => { cancelling ??= reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    const chunks: Uint8Array[] = []
    let bytes = 0
    let count = 0
    try {
      for (;;) {
        active(signal)
        const chunk = await reader.read()
        active(signal)
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > limit || ++count > 65_536) return invalid()
        chunks.push(chunk.value)
      }
      try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { return invalid() }
    } finally {
      signal.removeEventListener('abort', cancel)
      cancel()
      await cancelling
      reader.releaseLock()
    }
  }
}
