/** Anonymous, read-only OnTV snapshots. No participation or account material. */
import { HuyaTarsReader, HuyaTarsWriter } from './huyaWup'
import type { HuyaDanmakuRoom } from './huyaDanmaku'
import { safeFetch } from '../safeFetch'
import type { NetworkContext } from '../networkPolicy'

export interface HuyaOnTvActivity {
  id: string
  title: string
  prize: string
  mode: number
  conditions: string[]
  cost: string
  qualification: 'unknown'
  endsAt: number
  serverNow: number
}
export interface HuyaOnTvSnapshot {
  room: string
  status: 'loading' | 'none' | 'active' | 'ended' | 'unavailable'
  activity: HuyaOnTvActivity | null
  observedAt: number
}
const MAX_PACKET = 65_536
const MAX_ITEMS = 128
const invalid = () => new Error('虎牙上电视数据暂不可用.')
type Value = bigint | string | Uint8Array | Map<number, Value> | Value[]
type Fields = Map<number, Value>
class OnTvReader extends HuyaTarsReader {
  private budget = 4096
  fields(nested = false, depth = 0): Fields {
    if (depth > 12) throw invalid()
    const out: Fields = new Map()
    while (!this.done) {
      const [tag, type] = this.head()
      if (type === 11) { if (nested) return out; throw invalid() }
      if (out.has(tag)) throw invalid()
      out.set(tag, this.value(type, depth))
    }
    if (nested) throw invalid()
    return out
  }
  private value(type: number, depth: number): Value {
    if (--this.budget < 0 || depth > 12) throw invalid()
    if (type <= 3 || type === 12) return this.int(type)
    if (type === 6 || type === 7) return this.string(type)
    if (type === 13) return this.bytes(type)
    if (type === 10) return this.fields(true, depth + 1)
    if (type === 8 || type === 9) {
      const size = this.size(MAX_ITEMS) * (type === 8 ? 2 : 1)
      return Array.from({ length: size }, () => this.value(this.head()[1], depth + 1))
    }
    throw invalid()
  }
}
const struct = (fields: Fields, tag: number): Fields => {
  const value = fields.get(tag)
  if (!(value instanceof Map)) throw invalid()
  return value
}
const int = (fields: Fields, tag: number, fallback?: bigint): bigint => {
  const value = fields.get(tag) ?? fallback
  if (typeof value !== 'bigint') throw invalid()
  return value
}
const text = (fields: Fields, tag: number): string => {
  const value = fields.get(tag) ?? ''
  if (typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw invalid()
  // Web responses may encode text entities. This never becomes HTML.
  return value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
const list = (fields: Fields, tag: number): Fields[] => {
  const value = fields.get(tag) ?? []
  if (!Array.isArray(value) || value.length > MAX_ITEMS || value.some(item => !(item instanceof Map))) throw invalid()
  return value as Fields[]
}
export function huyaOnTvOfficialUrl(room: string): string {
  if (typeof room !== 'string') throw invalid()
  const id = /^huya:([1-9]\d{0,15})$/.exec(room)?.[1]
  if (!id) throw invalid()
  return `https://www.huya.com/${id}`
}
function identity(room: HuyaDanmakuRoom): void {
  huyaOnTvOfficialUrl(`huya:${room.room}`)
  if (room.presenterUid <= 0n || room.presenterUid > 0x7fff_ffff_ffff_ffffn
    || room.topSid < 0n || room.topSid > 0x7fff_ffff_ffff_ffffn || room.subSid < 0n || room.subSid > 0x7fff_ffff_ffff_ffffn) throw invalid()
}
export function encodeHuyaOnTvRequest(room: HuyaDanmakuRoom): Uint8Array<ArrayBuffer> {
  identity(room)
  const req = new HuyaTarsWriter()
  req.head(0, 10)
  req.head(0, 10)
  req.int(0, 0)
  for (const tag of [1, 2, 3, 4]) req.string(tag, tag === 3 ? 'webh5&1.0.0' : '')
  req.int(5, 0); req.string(6, ''); req.string(7, ''); req.head(0, 11)
  req.int64(1, room.presenterUid); req.int64(2, room.topSid); req.int64(3, room.subSid); req.int(4, 0); req.head(0, 11)
  const payload = new HuyaTarsWriter()
  payload.head(0, 8); payload.int(0, 1); payload.string(0, 'tReq'); payload.bytes(1, req.finish())
  const packet = new HuyaTarsWriter()
  packet.int(1, 3); packet.int(2, 0); packet.int(3, 0); packet.int(4, 1)
  packet.string(5, 'revenueui'); packet.string(6, 'getOnTVPanel'); packet.bytes(7, payload.finish()); packet.int(8, 0)
  for (const tag of [9, 10]) { packet.head(tag, 8); packet.int(0, 0) }
  const body = packet.finish(), length = Buffer.alloc(4)
  length.writeUInt32BE(body.length + 4)
  return new Uint8Array(Buffer.concat([length, body]))
}
function conditions(setting: Fields, mode: number): { conditions: string[]; cost: string } {
  const participation = Number(int(setting, 7, -1n))
  const labels: Record<number, string> = { 0: '活动未设置粉丝身份限制', 1: '需要粉丝身份', 2: '需要关注主播', 3: '需要超粉身份',
    4: '需要超粉 Plus', 5: '需要守护身份', 6: '需要新开通守护', 7: '需要指定粉丝等级' }
  const result = [labels[participation] ?? '参与条件待官网确认', '个人资格和剩余额度未查询']
  const packs = list(setting, 6)
  const counts = packs.map(pack => int(pack, 1, 0n)).filter(n => n > 0n && n <= 1_000_000n)
  const quantity = counts.length ? ` x${[...new Set(counts.map(String))].join(' / x')}` : ''
  if (mode === 2 || mode === 6) return { conditions: result, cost: `需要${mode === 6 ? '虎粮' : '指定礼物'}${quantity}, 费用待官网确认` }
  if (mode === 10) return { conditions: [...result, '仅官方 PC 客户端, 可能需要指定版本'], cost: '官方 PC 限时免费模式, 资格待官网确认' }
  if ([7, 8, 9].includes(mode)) return { conditions: [...result, mode === 8 ? '需要预约游戏, 请查看官方入口' : '可能需要虎牙 App 或游戏账号'], cost: 'App/游戏条件模式, 费用待官网确认' }
  if (![0, 1, 3, 4, 5].includes(mode)) return { conditions: [...result, '未知活动模式, 请查看官网'], cost: '费用未知' }
  const prices = list(setting, 2)
  const zero = prices.some(price => int(price, 1, -1n) === 0n)
  const paid = prices.some(price => int(price, 1, -1n) > 0n)
  return { conditions: result, cost: zero ? `存在无消耗选项${paid ? '和有消耗选项' : ''}, 个人可用额度待官网确认`
    : paid ? '有消耗选项, 金额和单位待官网确认' : '费用未知, 请查看官方条件' }
}
export function decodeHuyaOnTvPanel(bytes: Uint8Array, room: HuyaDanmakuRoom, observedAt: number): HuyaOnTvSnapshot {
  identity(room)
  if (!Number.isSafeInteger(observedAt) || observedAt < 0 || bytes.length < 4 || bytes.length > MAX_PACKET
    || Buffer.from(bytes.subarray(0, 4)).readUInt32BE() !== bytes.length) throw invalid()
  const outer = new OnTvReader(bytes.subarray(4)).fields()
  if (int(outer, 1) !== 3n || int(outer, 4) !== 1n || text(outer, 5) !== 'revenueui' || text(outer, 6) !== 'getOnTVPanel') throw invalid()
  const payload = outer.get(7)
  if (!(payload instanceof Uint8Array)) throw invalid()
  const entries = new OnTvReader(payload).fields().get(0)
  if (!Array.isArray(entries) || entries.length > 16 || entries.length % 2) throw invalid()
  const values = new Map<string, Uint8Array>()
  for (let i = 0; i < entries.length; i += 2) {
    const key = entries[i], value = entries[i + 1]
    if (typeof key !== 'string' || !(value instanceof Uint8Array) || values.has(key)) throw invalid()
    values.set(key, value)
  }
  const code = values.get('')
  if (code && int(new OnTvReader(code).fields(), 0) !== 0n) throw invalid()
  const response = values.get('tRsp')
  if (!response) throw invalid()
  const panel = struct(new OnTvReader(response).fields(), 0)
  const state = Number(int(panel, 0))
  const base: HuyaOnTvSnapshot = { room: `huya:${room.room}`, status: 'none', activity: null, observedAt }
  if (state === 0) return base
  if (![1, 2, 3].includes(state)) throw invalid()
  const info = struct(panel, 2), setting = struct(info, 1), data = struct(info, 2)
  const id = int(info, 0)
  if (id <= 0n || id > 0x7fff_ffff_ffff_ffffn || int(data, 0) !== id || int(setting, 3) !== room.presenterUid) throw invalid()
  const end = int(data, 5), left = int(data, 3)
  if (end < 1_000_000_000n || end > 10_000_000_000n || left < 0n || left > 86400n) throw invalid()
  const mode = Number(int(setting, 5, -1n))
  if (mode < -1 || mode > 2147483647) throw invalid()
  const details = conditions(setting, mode)
  return { ...base, status: state === 1 && left > 0n ? 'active' : 'ended', activity: {
    id: String(id), title: text(setting, 0), prize: text(struct(setting, 1), 0), mode,
    ...details, qualification: 'unknown', endsAt: Number(end) * 1000, serverNow: Number(end - left) * 1000,
  } }
}
export async function readHuyaOnTvPanel(room: HuyaDanmakuRoom, signal: AbortSignal, network?: NetworkContext): Promise<Uint8Array> {
  signal.throwIfAborted()
  const timeout = AbortSignal.timeout(15_000)
  const combined = AbortSignal.any([signal, timeout])
  const { response } = await safeFetch('https://wup.huya.com', { enabled: true, hosts: ['wup.huya.com'],
    allowNonStandardPorts: false, maxRedirects: 0, requestTimeoutMs: 15_000 }, {
    method: 'POST', body: encodeHuyaOnTvRequest(room), signal: combined, network,
    headers: { 'Content-Type': 'application/octet-stream', Referer: 'https://www.huya.com/', 'User-Agent': 'Mozilla/5.0' },
  })
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw invalid() }
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_PACKET)) { void response.body?.cancel().catch(() => {}); throw invalid() }
  if (!response.body) throw invalid()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  combined.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      if (combined.aborted) throw invalid()
      const chunk = await reader.read()
      if (combined.aborted) throw invalid()
      if (chunk.done) break
      size += chunk.value.length
      if (size > MAX_PACKET || chunks.length >= 1024) throw invalid()
      chunks.push(chunk.value)
    }
    return new Uint8Array(Buffer.concat(chunks))
  } finally { combined.removeEventListener('abort', cancel); cancel(); reader.releaseLock() }
}
