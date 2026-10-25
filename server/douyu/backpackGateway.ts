/** Account-scoped, bounded HTTP access. Only the renewal service sees private reads. */
import { isIP } from 'node:net'
import { hostAllowed } from '../config'
import { dnsResolver, isPrivateAddress, safeFetch } from '../safeFetch'
import { validDouyuRoom } from '../platforms/douyuRoom'
import type { DouyuActionDependencies } from './actions'
import { abortable, cancelBody, cancelled, MAX_TIMEOUT_MS, record } from './actionHttp'
import { parseDouyuInventory } from './inventoryService'
import type { DouyuInventoryDonation } from './inventoryTypes'
import type { DouyuBackpackDonation, DouyuBackpackRead, DouyuBackpackReceipt, DouyuBadgePageRead } from './renewalTypes'

const HOST = 'www.douyu.com'
const ORIGIN = `https://${HOST}`
const BADGES_URL = `${ORIGIN}/member/cp/getFansBadgeList`
const DONATE_URL = `${ORIGIN}/japi/prop/donate/mainsite/v5`
const MAX_BODY_BYTES = 512 * 1_024
const MAX_COOKIE_BYTES = 32_768
const PROP_IDS = new Set(['268', '2358'])
const AUTH_FIELDS = ['acf_auth', 'acf_auth_wl', 'acf_dmjwt_token', 'acf_stk', 'acf_ltkid', 'acf_biz'] as const
const CREDENTIAL_FIELDS = new Set<string>(['acf_uid', 'acf_username', 'XSRF-TOKEN', ...AUTH_FIELDS])

type GatewayCode = 'login-required' | 'verification-required' | 'unavailable' | 'invalid-data'
const ERROR_MESSAGES: Record<GatewayCode, string> = {
  'login-required': '斗鱼登录信息缺失或已变化. 请重新登录该账号.',
  'verification-required': '斗鱼要求官方账号验证. 请在官方页面完成验证.',
  unavailable: '暂时无法安全访问斗鱼. 请稍后再试.',
  'invalid-data': '斗鱼返回的数据不完整或无法确认.',
}

export class DouyuRenewalGatewayError extends Error {
  readonly code: GatewayCode
  constructor(code: GatewayCode) {
    const normalized: GatewayCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'unavailable'
    super(ERROR_MESSAGES[normalized])
    this.code = normalized
    this.name = 'DouyuRenewalGatewayError'
  }
}

type Credentials = { uid: string; header: string; xsrf: string | null; fingerprint: string }
type HttpTarget = { accountId: string; url: string; method: 'GET' | 'POST'; room?: string; body?: string; expectedUid?: string }
const invalidData = (): never => { throw new DouyuRenewalGatewayError('invalid-data') }
const assertActive = (signal: AbortSignal): void => { if (signal.aborted) throw cancelled() }
const validAccount = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(value)
const validUid = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
const zero = (value: unknown): boolean => value === 0 || value === '0'

/** Do not interpret a duplicate credential according to arbitrary header order. */
function credentialsFrom(header: unknown): Credentials {
  if (typeof header !== 'string' || !header || header.length > MAX_COOKIE_BYTES || !/^[\x20-\x7e]+$/.test(header)) throw new DouyuRenewalGatewayError('login-required')
  const fields = new Map<string, string>()
  for (const part of header.split(';')) {
    if (!part.trim()) continue
    const separator = part.indexOf('=')
    if (separator < 1) throw new DouyuRenewalGatewayError('login-required')
    const name = part.slice(0, separator).trim()
    const rawValue = part.slice(separator + 1).trim()
    if (!/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(name) || /[\s\x00-\x1f\x7f"\\,;]/.test(rawValue)) throw new DouyuRenewalGatewayError('login-required')
    if (!CREDENTIAL_FIELDS.has(name)) continue
    if (fields.has(name)) throw new DouyuRenewalGatewayError('login-required')
    let value: string
    try { value = decodeURIComponent(rawValue) } catch { throw new DouyuRenewalGatewayError('login-required') }
    if (value.length > 8_192 || /[\x00-\x1f\x7f-\x9f]/.test(value) || /^(null|undefined)$/i.test(value)) throw new DouyuRenewalGatewayError('login-required')
    if ((AUTH_FIELDS as readonly string[]).includes(name) && value && !/^[A-Za-z0-9._~+\/=:-]+$/.test(value)) throw new DouyuRenewalGatewayError('login-required')
    fields.set(name, value)
  }
  const uid = fields.get('acf_uid')
  if (!validUid(uid) || !(fields.get('acf_auth') || fields.get('acf_auth_wl') || fields.get('acf_dmjwt_token') || (fields.get('acf_stk') && fields.get('acf_ltkid') && fields.get('acf_biz')))) throw new DouyuRenewalGatewayError('login-required')
  const xsrf = fields.get('XSRF-TOKEN') ?? null
  if (xsrf !== null && (!/^[A-Za-z0-9._~+\/=:-]{1,2048}$/.test(xsrf))) throw new DouyuRenewalGatewayError('login-required')
  return { uid, header, xsrf, fingerprint: JSON.stringify([uid, ...AUTH_FIELDS.map(field => fields.get(field) ?? '')]) }
}

/** Native JSON.parse accepts duplicate keys. Reject them before trusting status/IDs. */
function parseJson(text: string): unknown {
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { return invalidData() }
  const scopes: Array<Set<string> | null> = []
  for (let index = 0; index < text.length;) {
    const character = text[index]
    if (character === '{' || character === '[') {
      if (scopes.length >= 64) return invalidData()
      scopes.push(character === '{' ? new Set<string>() : null)
      index++
    } else if (character === '}' || character === ']') {
      scopes.pop()
      index++
    } else if (character === '"') {
      const start = index++
      while (index < text.length) {
        if (text[index] === '\\') index += 2
        else if (text[index++] === '"') break
      }
      let next = index
      while (/\s/.test(text[next] ?? '') && next < text.length) next++
      if (text[next] === ':') {
        const keys = scopes[scopes.length - 1]
        const key = JSON.parse(text.slice(start, index)) as string
        if (!keys || keys.has(key) || keys.size >= 4_096) return invalidData()
        keys.add(key)
      }
    } else index++
  }
  return value
}

function dataObject(value: unknown): Record<string, unknown> {
  const data = typeof value === 'string' ? parseJson(value) : value
  return record(data) ?? invalidData()
}

function bindingValue(value: unknown): string | null {
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)) return value
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null
}

/** list is the post-operation inventory, so its remaining counts are not sent quantities. */
function conflicts(value: Record<string, unknown>, expected: DouyuBackpackDonation): boolean {
  const groups: Array<[string[], string]> = [
    [['id', 'propId', 'prop_id', 'pid'], expected.propId],
    [['propCount', 'prop_count', 'quantity', 'num', 'count', 'number'], String(expected.quantity)],
    [['room', 'roomId', 'roomid', 'room_id', 'rid'], expected.room],
    [['uid', 'userId', 'userid', 'user_id', 'sender'], expected.expectedUid],
  ]
  return groups.some(([names, expectedValue]) => names.some(name => Object.hasOwn(value, name) && bindingValue(value[name]) !== expectedValue))
}

const unknownReceipt = (message = '背包赠送结果尚无法确认. 请在官方页面核对, 本次不会自动重试.'): DouyuBackpackReceipt => ({ status: 'unknown', message })
const notSubmitted = (message: string): DouyuBackpackReceipt => ({ status: 'not-submitted', message })

function donationReceipt(payload: unknown, target: DouyuBackpackDonation, expectedPropType?: number): DouyuBackpackReceipt {
  const envelope = record(payload)
  if (envelope?.result === 170001 || envelope?.result === '170001') return unknownReceipt('斗鱼要求官方账号验证. 请在官方页面核对本次赠送, 本次不会自动重试.')
  if (envelope?.error === 16 || envelope?.error === '16') return unknownReceipt('斗鱼要求绑定手机号. 请在官方页面核对本次赠送, 本次不会自动重试.')
  if (envelope?.error === 5821 || envelope?.error === '5821') return unknownReceipt('斗鱼提示账号异常. 请在官方页面核对本次赠送, 本次不会自动重试.')
  if (!envelope || !Object.hasOwn(envelope, 'error') || !zero(envelope.error)) return unknownReceipt()
  if (['result', 'code'].some(name => Object.hasOwn(envelope, name) && !zero(envelope[name]))) return unknownReceipt()
  const data = dataObject(envelope.data)
  const used = record(data.usedProp)
  if (!used || !Array.isArray(data.list)) return unknownReceipt()
  if (expectedPropType !== undefined && Object.hasOwn(used, 'propType') && bindingValue(used.propType) !== String(expectedPropType)) return unknownReceipt()
  if (data.messages !== undefined && (!Array.isArray(data.messages) || data.messages.some(item => typeof item !== 'string'))) return unknownReceipt()
  if ([envelope, data, used].some(value => conflicts(value, target))) return unknownReceipt()
  return { status: 'receipt-received', message: '已收到斗鱼背包赠送回执. 这不代表续牌状态已确认.' }
}

export class DouyuBackpackGateway {
  constructor(protected readonly deps: DouyuActionDependencies) {}

  async readBadges(accountId: string, signal: AbortSignal): Promise<DouyuBadgePageRead> {
    return this.bounded(signal, async active => {
      const target: HttpTarget = { accountId, url: BADGES_URL, method: 'GET' }
      const credentials = await this.credentials(target, active)
      const response = await this.request(target, credentials, active)
      const html = await this.readText(response, active)
      if (!html.trim()) return invalidData()
      await this.confirm(target, credentials, active)
      return { uid: credentials.uid, html }
    })
  }

  async readBackpack(accountId: string, room: string, signal: AbortSignal): Promise<DouyuBackpackRead> {
    return this.bounded(signal, async active => {
      if (typeof room !== 'string' || !validDouyuRoom(room)) return invalidData()
      const target: HttpTarget = { accountId, room, url: `${ORIGIN}/japi/prop/backpack/web/v5?rid=${room}`, method: 'GET' }
      const credentials = await this.credentials(target, active)
      const response = await this.request(target, credentials, active)
      const envelope = record(parseJson(await this.readText(response, active)))
      if (envelope?.result === 170001 || envelope?.result === '170001' || envelope?.error === 16 || envelope?.error === '16') throw new DouyuRenewalGatewayError('verification-required')
      if (!envelope || !Object.hasOwn(envelope, 'error')) return invalidData()
      if (!zero(envelope.error)) throw new DouyuRenewalGatewayError('unavailable')
      if (['result', 'code'].some(name => Object.hasOwn(envelope, name) && !zero(envelope[name]))) throw new DouyuRenewalGatewayError('unavailable')
      const payload = dataObject(envelope.data)
      await this.confirm(target, credentials, active)
      return { uid: credentials.uid, payload }
    })
  }

  async donate(input: DouyuBackpackDonation, signal: AbortSignal): Promise<DouyuBackpackReceipt> {
    return this.donateTarget(input, signal, true)
  }

  /** Separate confirmed inventory path. The renewal allowlist remains unchanged. */
  async donateInventory(input: DouyuInventoryDonation, signal: AbortSignal): Promise<DouyuBackpackReceipt> {
    try {
      const target = { accountId: input.accountId, expectedUid: input.expectedUid, room: input.room, propId: input.propId, quantity: input.quantity }
      const expected = structuredClone(input.expectedInventory)
      if (!validAccount(target.accountId) || !validUid(target.expectedUid) || !validDouyuRoom(target.room)
        || !/^[1-9][0-9]{0,15}$/.test(target.propId) || !Number.isSafeInteger(target.quantity) || target.quantity < 1) return notSubmitted('赠送参数无效. 未提交背包赠送.')
      const before = await this.readBackpack(target.accountId, target.room, signal)
      if (before.uid !== target.expectedUid) return notSubmitted('所选账号已变化. 未提交背包赠送.')
      const item = parseDouyuInventory(before.payload, Date.now()).find(candidate => candidate.propId === target.propId)
      if (!item?.canGift || JSON.stringify(item) !== JSON.stringify(expected) || item.quantity < target.quantity
        || (!item.batchSupported && target.quantity !== 1)) return notSubmitted('可赠库存或数量已变化. 未提交背包赠送.')
      return await this.donateTarget(target, signal, false, item.propType!)
    } catch { return notSubmitted(signal.aborted ? '赠送已取消. 未提交背包赠送.' : '无法确认可赠库存. 未提交背包赠送.') }
  }

  private async donateTarget(input: DouyuBackpackDonation, signal: AbortSignal, renewal: boolean, expectedPropType?: number): Promise<DouyuBackpackReceipt> {
    let target: DouyuBackpackDonation
    try {
      target = { accountId: input.accountId, expectedUid: input.expectedUid, room: input.room, propId: input.propId, quantity: input.quantity }
      if (!validAccount(target.accountId) || !validUid(target.expectedUid) || typeof target.room !== 'string' || !validDouyuRoom(target.room)
        || (renewal ? !PROP_IDS.has(target.propId) : !/^[1-9][0-9]{0,15}$/.test(target.propId))
        || !Number.isSafeInteger(target.quantity) || target.quantity < 1 || (renewal && target.quantity > 1_000)) return notSubmitted('赠送参数无效. 未提交背包赠送.')
    } catch { return notSubmitted('赠送参数无效. 未提交背包赠送.') }
    let dispatched = false
    try {
      return await this.bounded(signal, async active => {
        const httpTarget: HttpTarget = {
          accountId: target.accountId, expectedUid: target.expectedUid, room: target.room,
          method: 'POST', url: DONATE_URL,
          // BackpackEpics.sendProps explicitly sets csrf=false for ordinary
          // mainsite props. The interactive endpoint's ctn is not used here.
          body: new URLSearchParams({ propId: target.propId, propCount: String(target.quantity), roomId: target.room, bizExt: '{"yzxq":{}}' }).toString(),
        }
        const credentials = await this.credentials(httpTarget, active)
        const response = await this.request(httpTarget, credentials, active, () => { dispatched = true })
        const payload = parseJson(await this.readText(response, active))
        await this.confirm(httpTarget, credentials, active)
        return donationReceipt(payload, target, expectedPropType)
      })
    } catch (error) {
      if (dispatched) return unknownReceipt()
      if (signal.aborted) return notSubmitted('赠送已取消. 未提交背包赠送.')
      const code = error instanceof DouyuRenewalGatewayError ? error.code : 'unavailable'
      return notSubmitted(`${ERROR_MESSAGES[code]} 未提交背包赠送.`)
    }
  }

  protected async bounded<T>(signal: AbortSignal, operation: (active: AbortSignal) => Promise<T>): Promise<T> {
    assertActive(signal)
    if (!this.deps.proxy.enabled || !hostAllowed(HOST, this.deps.proxy.hosts)) throw new DouyuRenewalGatewayError('unavailable')
    const timeout = new AbortController()
    const duration = Number.isFinite(this.deps.proxy.requestTimeoutMs) ? Math.max(1, Math.min(this.deps.proxy.requestTimeoutMs, MAX_TIMEOUT_MS)) : MAX_TIMEOUT_MS
    const timer = setTimeout(() => timeout.abort(), duration)
    const active = AbortSignal.any([signal, timeout.signal])
    // Reads and preflight providers are bounded at their await sites. Do not
    // race a dispatched write: its caller owns the shared serial execution lane
    // until the transport really settles, even when it ignores cancellation.
    try { return await operation(active) } catch (error) {
      if (signal.aborted) throw cancelled()
      // Reconstruct even our own error type so no upstream-mutated message escapes.
      throw new DouyuRenewalGatewayError(error instanceof DouyuRenewalGatewayError ? error.code : 'unavailable')
    } finally { clearTimeout(timer) }
  }

  protected async credentials(target: HttpTarget, signal: AbortSignal): Promise<Credentials> {
    assertActive(signal)
    if (!validAccount(target.accountId)) throw new DouyuRenewalGatewayError('login-required')
    let header: string
    try { header = await abortable(this.deps.cookieHeader(target.accountId, target.url), signal) } catch {
      assertActive(signal)
      throw new DouyuRenewalGatewayError('login-required')
    }
    assertActive(signal)
    const credentials = credentialsFrom(header)
    if (target.expectedUid !== undefined && credentials.uid !== target.expectedUid) throw new DouyuRenewalGatewayError('login-required')
    return credentials
  }

  protected async confirm(target: HttpTarget, before: Credentials, signal: AbortSignal): Promise<Credentials> {
    const after = await this.credentials(target, signal)
    if (after.fingerprint !== before.fingerprint) throw new DouyuRenewalGatewayError('login-required')
    return after
  }

  protected async resolve(host: string, signal: AbortSignal): Promise<string[]> {
    assertActive(signal)
    const addresses = await abortable((this.deps.resolve ?? dnsResolver)(host), signal)
    if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 64 || addresses.some(address => typeof address !== 'string' || !isIP(address) || isPrivateAddress(address))) throw new DouyuRenewalGatewayError('unavailable')
    return addresses
  }

  protected async request(target: HttpTarget, credentials: Credentials, signal: AbortSignal, dispatch?: () => void): Promise<Response> {
    const expectedUrl = new URL(target.url)
    if (expectedUrl.origin !== ORIGIN || expectedUrl.protocol !== 'https:' || expectedUrl.username || expectedUrl.password || expectedUrl.port || expectedUrl.hash) throw new DouyuRenewalGatewayError('unavailable')
    assertActive(signal)
    const { response } = await safeFetch(target.url, {
      ...this.deps.proxy, hosts: [HOST], maxRedirects: 0,
      allowNonStandardPorts: false, allowNonLoopbackTargets: false,
    }, {
      method: target.method, body: target.body, signal,
      resolve: host => this.resolve(host, signal),
      fetchImpl: async (url, init) => {
        const latest = await this.confirm(target, credentials, signal)
        assertActive(signal)
        const headers: Record<string, string> = {
          Cookie: latest.header,
          Accept: target.url === BADGES_URL ? 'text/html' : 'application/json, text/plain, */*',
          Referer: target.room ? `${ORIGIN}/${target.room}` : `${ORIGIN}/`,
        }
        if (target.url !== BADGES_URL) headers['X-Requested-With'] = 'XMLHttpRequest'
        if (target.method === 'GET') {
          headers['Cache-Control'] = 'no-cache'
          headers.Pragma = 'no-cache'
        }
        if (latest.xsrf !== null) headers['X-XSRF-TOKEN'] = latest.xsrf
        if (target.method === 'POST') {
          headers['Content-Type'] = 'application/x-www-form-urlencoded'
          headers.Origin = ORIGIN
        }
        dispatch?.()
        const operation = (this.deps.request ?? fetch)(url, { ...init, headers }).then(result => {
          if (signal.aborted) { cancelBody(result); throw cancelled() }
          return result
        })
        const result = target.method === 'POST' ? await operation : await abortable(operation, signal)
        let correctUrl = !result.url
        try { if (result.url) correctUrl = new URL(result.url).href === expectedUrl.href } catch { /* Refuse malformed final URLs. */ }
        if (result.redirected || !correctUrl) { cancelBody(result); throw new DouyuRenewalGatewayError('unavailable') }
        if (result.status === 401 || result.status === 302) { cancelBody(result); throw new DouyuRenewalGatewayError('login-required') }
        if (result.status !== 200) { cancelBody(result); throw new DouyuRenewalGatewayError('unavailable') }
        return result
      },
    })
    if (signal.aborted) { cancelBody(response); throw cancelled() }
    return response
  }

  protected async readText(response: Response, signal: AbortSignal): Promise<string> {
    const advertised = response.headers.get('content-length')
    if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_BODY_BYTES)) { cancelBody(response); return invalidData() }
    if (!response.body) return invalidData()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    let chunksRead = 0
    const abort = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for (;;) {
        assertActive(signal)
        const chunk = await abortable(reader.read(), signal)
        if (chunk.done) break
        if (++chunksRead > 65_536) return invalidData()
        bytes += chunk.value.byteLength
        if (bytes > MAX_BODY_BYTES) return invalidData()
        chunks.push(chunk.value)
      }
      assertActive(signal)
      try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { return invalidData() }
    } finally {
      signal.removeEventListener('abort', abort)
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

export { parseJson as parseDouyuGatewayJson }
