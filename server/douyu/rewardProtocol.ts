/** Strict local parsing for the current official reward APIs. No account data leaves here. */
import { createHash } from 'node:crypto'
import { abortable, cancelBody, cancelled, record } from './actionHttp'

const AUTH_FIELDS = ['acf_auth', 'acf_auth_wl', 'acf_dmjwt_token', 'acf_stk', 'acf_ltkid', 'acf_biz'] as const
const CREDENTIAL_FIELDS = new Set(['acf_uid', 'acf_username', 'acf_ccn', 'dy_did', 'XSRF-TOKEN', ...AUTH_FIELDS])

export type RewardProblemCode = 'login' | 'verification' | 'phone' | 'eligibility' | 'invalid' | 'unavailable' | 'capacity'
export class RewardProblem extends Error {
  constructor(readonly code: RewardProblemCode, readonly definiteRefusal = false) { super('Reward request could not be confirmed.'); this.name = 'RewardProblem' }
}

export const assertRewardActive = (signal: AbortSignal): void => { if (signal.aborted) throw cancelled() }
export const rewardInteger = (value: unknown): number | null => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value))) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}
export const rewardId = (value: unknown): string | null => {
  const number = rewardInteger(value)
  return number !== null && number > 0 ? String(number) : null
}

export type RewardCredentials = { uid: string; header: string; csrf: string | null; device: string | null; xsrf: string | null; fingerprint: string }

export function rewardCredentials(header: unknown): RewardCredentials {
  const invalid = (): never => { throw new RewardProblem('login') }
  if (typeof header !== 'string' || !header || header.length > 32_768 || !/^[\x20-\x7e]+$/.test(header)) return invalid()
  const fields = new Map<string, string>()
  for (const part of header.split(';')) {
    if (!part.trim()) continue
    const separator = part.indexOf('=')
    if (separator < 1) return invalid()
    const name = part.slice(0, separator).trim()
    const raw = part.slice(separator + 1).trim()
    if (!/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(name) || /[\s\x00-\x1f\x7f"\\,;]/.test(raw)) return invalid()
    if (!CREDENTIAL_FIELDS.has(name)) continue
    if (fields.has(name)) return invalid()
    let value: string
    try { value = decodeURIComponent(raw) } catch { return invalid() }
    if (value.length > 8_192 || /[\x00-\x1f\x7f-\x9f]/.test(value) || /^(null|undefined)$/i.test(value)) return invalid()
    if (name !== 'acf_username' && value && !/^[A-Za-z0-9._~+\/=:-]+$/.test(value)) return invalid()
    fields.set(name, value)
  }
  const uid = fields.get('acf_uid')
  if (!uid || !/^[1-9][0-9]{0,19}$/.test(uid) || !(fields.get('acf_auth') || fields.get('acf_auth_wl') || fields.get('acf_dmjwt_token') || (fields.get('acf_stk') && fields.get('acf_ltkid') && fields.get('acf_biz')))) return invalid()
  const csrf = fields.get('acf_ccn') || null
  const device = fields.get('dy_did') || null
  const xsrf = fields.get('XSRF-TOKEN') || null
  if ([csrf, xsrf].some(value => value !== null && !/^[A-Za-z0-9._~+\/=:-]{1,2048}$/.test(value))) return invalid()
  if (device !== null && !/^[A-Za-z0-9_-]{8,128}$/.test(device)) return invalid()
  // Store only a digest when a result needs a subsequent scheduled read.
  const fingerprint = createHash('sha256').update(JSON.stringify([uid, ...AUTH_FIELDS.map(name => fields.get(name) ?? ''), csrf, device, xsrf])).digest('hex')
  return { uid, header, csrf, device, xsrf, fingerprint }
}

/** Reject duplicate JSON keys before interpreting an error, identity or qualifier. */
export function parseRewardJson(text: string): unknown {
  const invalid = (): never => { throw new RewardProblem('invalid') }
  let result: unknown
  try { result = JSON.parse(text) as unknown } catch { return invalid() }
  const scopes: Array<Set<string> | null> = []
  for (let index = 0; index < text.length;) {
    const character = text[index]
    if (character === '{' || character === '[') {
      if (scopes.length >= 48) return invalid()
      scopes.push(character === '{' ? new Set() : null)
      index++
    } else if (character === '}' || character === ']') {
      scopes.pop(); index++
    } else if (character === '"') {
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
  return result
}

export function rewardData(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 65_536) throw new RewardProblem('invalid')
    value = parseRewardJson(value)
  }
  const data = record(value)
  if (!data) throw new RewardProblem('invalid')
  return data
}

export async function readRewardJson(response: Response, signal: AbortSignal, limit = 65_536): Promise<unknown> {
  const advertised = response.headers.get('content-length')
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > limit)) { cancelBody(response); throw new RewardProblem('invalid') }
  if (!response.body) throw new RewardProblem('invalid')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let count = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      assertRewardActive(signal)
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (++count > 4_096 || bytes > limit) throw new RewardProblem('invalid')
      chunks.push(chunk.value)
    }
    assertRewardActive(signal)
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { throw new RewardProblem('invalid') }
    return parseRewardJson(text)
  } finally {
    signal.removeEventListener('abort', abort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Only the fixed reason category is returned, never any server-supplied message. */
export function rewardAttention(status: number, value: unknown): void {
  if (status === 401) throw new RewardProblem('login')
  if (status !== 200) throw new RewardProblem('unavailable')
  const envelope = record(value)
  if (!envelope) throw new RewardProblem('invalid')
  const error = rewardInteger(envelope.error)
  if ([901, 902, 1022].includes(error ?? -1)) throw new RewardProblem('login')
  if (error === 1020440010) throw new RewardProblem('verification', true)
  if (error === 1020440030) throw new RewardProblem('phone', true)
  if (error === 3004 || envelope.result === 170001) throw new RewardProblem('verification')
  const message = [envelope.msg, envelope.message].filter((value): value is string => typeof value === 'string' && value.length < 512).join(' ')
  if (/验证码|人机验证|安全验证|滑块|captcha|geetest/i.test(message)) throw new RewardProblem('verification')
  if (/未登[录陆]|请.{0,8}登[录陆]|登[录陆].{0,8}(过期|失效)|token.{0,12}(过期|失效|expired|invalid)|login\s*required/i.test(message)) throw new RewardProblem('login')
  if (/不满足|未满足|无资格|没有资格|权限不足|观看.{0,8}(不足|未满)|not\s*eligible/i.test(message)) throw new RewardProblem('eligibility')
}

export function rewardEnvelope(value: unknown): Record<string, unknown> {
  const envelope = record(value)
  if (!envelope || rewardInteger(envelope.error) !== 0 || ['code', 'result'].some(key => Object.hasOwn(envelope, key) && rewardInteger(envelope[key]) !== 0)) throw new RewardProblem('invalid')
  return rewardData(envelope.data)
}

export function rewardRoomMatches(value: Record<string, unknown>, room: string): boolean {
  return ['room_id', 'roomId', 'roomid', 'rid', 'package_room_id', 'srcRoomId'].every(key => !Object.hasOwn(value, key) || rewardId(value[key]) === room)
}

/** New explicit restrictions need human handling until their official flow is supported. */
export function rewardHasRequirement(value: Record<string, unknown>): boolean {
  const inactive = (value: unknown) => value === 0 || value === '0' || value === false || value === null || value === ''
  return ['cost', 'price', 'payAmount', 'pay_amount', 'needPay', 'need_pay', 'needGift', 'need_gift', 'needBarrage', 'need_barrage', 'needWatch', 'need_watch', 'watchRequired', 'watch_required', 'needFollow', 'need_follow', 'needVerify', 'need_verify', 'verifyRequired', 'verify_required']
    .some(key => Object.hasOwn(value, key) && !inactive(value[key]))
    || ['geeData', 'geetest', 'captcha', 'verifyCert', 'challenge', 'conditions', 'requirements'].some(key => Object.hasOwn(value, key) && value[key] !== null)
}
