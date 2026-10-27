/** Huya room metadata, anonymous WUP token and local MD5 signing. No remote JS runs.
 * Protocol reference: biliup/biliup (MIT), pinned in fixtures/huya-README.md.
 */
import { createHash, randomBytes } from 'node:crypto'
import { decodeHuyaTokenResponse, encodeHuyaTokenRequest } from './huyaWup'
import { failure, MANUAL_URL_HINT, type QualityOption, type ResolveResult, type ResolverDeps } from './types'

const REFERER = 'https://www.huya.com/'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const HEADERS = { Referer: REFERER, 'User-Agent': USER_AGENT }
const MAX_PAGE = 2 * 1_048_576
const MAX_TOKEN = 16_384
const ROOM = /^[A-Za-z0-9_-]{1,64}$/
const STREAM = /^[A-Za-z0-9_-]{1,256}$/
const md5 = (value: string) => createHash('md5').update(value).digest('hex')
const random = () => randomBytes(4).readUInt32BE() / 0x1_0000_0000
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown, max: number): string => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : ''
const integer = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max

export function parseHuyaRoom(input: string): string | null {
  if (typeof input !== 'string' || input.length > 8192) return null
  const value = input.trim()
  if (/[\x00-\x1f\x7f]/.test(value)) return null
  if (ROOM.test(value)) return value
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password
      || !['huya.com', 'www.huya.com', 'm.huya.com'].includes(url.hostname.toLowerCase())) return null
    const room = url.pathname.replace(/^\//, '').replace(/\/$/, '')
    return ROOM.test(room) ? room : null
  } catch { return null }
}

/** Scan one bounded JSON value, rather than evaluating the surrounding player script. */
function jsonAfter(page: string, marker: RegExp, max: number): unknown {
  const match = marker.exec(page)
  if (!match) return undefined
  const start = match.index + match[0].length
  const stack: string[] = []
  let quoted = false
  let escaped = false
  for (let i = start; i < page.length && i - start <= max; i++) {
    const char = page[i]!
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']')
      if (stack.length > 32) return undefined
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return undefined
      if (stack.length === 0) {
        try { return JSON.parse(page.slice(start, i + 1)) as unknown } catch { return undefined }
      }
    } else if (stack.length === 0 && !/\s/.test(char)) return undefined
  }
  return undefined
}

function roomId(value: unknown): string | null {
  if (integer(value, Number.MAX_SAFE_INTEGER) && value > 0) return String(value)
  return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) ? value : null
}

function uid(value: unknown): bigint | null {
  if (value === undefined) return 0n
  if (integer(value, Number.MAX_SAFE_INTEGER)) return BigInt(value)
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= 0xffff_ffff_ffff_ffffn ? parsed : null
}

function replayTitle(value: unknown): boolean {
  const title = Array.from(text(value, 1024).trim())
  return /回放|重播/.test(title.slice(0, 3).join('')) || /回放|重播/.test(title.slice(-3).join(''))
}

export function parseHuyaQualities(value: unknown): QualityOption[] {
  if (!Array.isArray(value) || value.length > 100) return []
  const seen = new Set<number>()
  return value.flatMap((raw): QualityOption[] => {
    const item = record(raw)
    if (!integer(item.iBitRate, 1_000_000) || seen.has(item.iBitRate)) return []
    if (item.iCodecType !== undefined && item.iCodecType !== 0) return []
    seen.add(item.iBitRate)
    return [{ id: String(item.iBitRate), label: text(item.sDisplayName, 80).trim() || (item.iBitRate === 0 ? '原画' : `画质 ${item.iBitRate}`) }]
  })
}

type Line = { cdn: string; priority: number; name: string; base: string; antiCode: string; presenter: bigint }
type PageResult = { ok: true; room: string; lines: Line[]; qualities: QualityOption[] } | Extract<ResolveResult, { ok: false }>

function mediaUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 32_768 || /[\x00-\x20\x7f]/.test(value)) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password || url.hash
      || !/(^|\.)huya\.com$/i.test(url.hostname)) return null
    url.protocol = 'https:'
    return url
  } catch { return null }
}

/** Page fixtures are reduced and anonymized; raw pages/tokens must never be logged. */
export function parseHuyaPage(rawPage: string, inputRoom: string): PageResult {
  if (typeof rawPage !== 'string' || rawPage.length > MAX_PAGE) return failure('upstream-error', '虎牙房间页面过大或格式无效.', MANUAL_URL_HINT)
  if (rawPage.includes('找不到这个主播')) return failure('room-not-found', '虎牙房间不存在.', '请检查房间号或复制主播的房间链接.')
  if (/正在整改中|房间已被封禁|主播已被封禁/.test(rawPage)) return failure('restricted', '虎牙房间正在整改或受到访问限制.', '请在虎牙官网确认房间状态后重试.')
  const page = rawPage.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  const room = record(jsonAfter(page, /\bTT_ROOM_DATA\s*=\s*/, 65_536))
  if (room.state !== 'ON' && room.state !== 'OFF') return failure('upstream-error', '无法读取虎牙开播状态.', MANUAL_URL_HINT)
  if (room.state === 'OFF' || room.isReplay === true || replayTitle(room.introduction)) return failure('not-live', '虎牙房间未开播或正在播放回放.', '请等待主播开播后重新加载.')
  const canonical = roomId(room.profileRoom) ?? (/^[1-9]\d{0,15}$/.test(inputRoom) ? inputRoom : null)
  if (!canonical) return failure('room-not-found', '无法确认虎牙真实房间号.', '请复制虎牙官网的数字房间链接后重试.')
  const stream = record(jsonAfter(page, /\bstream\s*:\s*/, 1_048_576))
  const data = Array.isArray(stream.data) && stream.data.length <= 100 ? record(stream.data[0]) : {}
  const live = record(data.gameLiveInfo)
  if (replayTitle(live.introduction) || replayTitle(live.roomName)) return failure('not-live', '虎牙房间当前正在播放回放或重播.', '请切换到正在直播的房间.')
  const qualities = parseHuyaQualities(stream.vMultiStreamInfo)
  const lines = Array.isArray(data.gameStreamInfoList) && data.gameStreamInfoList.length <= 100 ? data.gameStreamInfoList.flatMap((raw): Line[] => {
    const line = record(raw)
    const cdn = text(line.sCdnType, 16).toUpperCase()
    const name = text(line.sStreamName, 256)
    const base = mediaUrl(line.sFlvUrl)
    const presenter = uid(line.lPresenterUid)
    if (!/^[A-Z0-9_-]{1,16}$/.test(cdn) || ['HY', 'HUYA', 'HYZJ'].includes(cdn) || !STREAM.test(name)
      || !integer(line.iWebPriorityRate, 1_000_000) || line.sFlvUrlSuffix !== 'flv' || !base || base.search || presenter === null) return []
    return [{ cdn, name, priority: line.iWebPriorityRate, base: base.href.replace(/\/$/, ''), antiCode: text(line.sFlvAntiCode, MAX_TOKEN), presenter }]
  }).sort((a, b) => b.priority - a.priority) : []
  return { ok: true, room: canonical, lines, qualities }
}

/** Rotate only the low 32-bit word left by 8; preserve the upper word exactly. */
export function rotateHuyaUid(value: bigint): bigint {
  const low = value & 0xffff_ffffn
  return (value & 0xffff_ffff_0000_0000n) | (((low << 8n) | (low >> 24n)) & 0xffff_ffffn)
}

/** Fixed clock and RNG are test seams. BigInt avoids losing bits in 64-bit UIDs. */
export function buildHuyaAuth(streamName: string, token: string, presenterUid: bigint,
  options: { now?: () => number; random?: () => number } = {}): string | null {
  if (!STREAM.test(streamName) || !text(token, MAX_TOKEN) || presenterUid < 0n || presenterUid > 0xffff_ffff_ffff_ffffn) return null
  const params = new URLSearchParams(token.replace(/&amp;/g, '&'))
  if (params.size > 64 || new Set(params.keys()).size !== params.size) return null
  const ctype = params.get('ctype') ?? 'huya_live'
  const t = params.get('t') ?? '100'
  const fs = params.get('fs') ?? 'bgct'
  let fm = params.get('fm') ?? ''
  try { fm = decodeURIComponent(fm) } catch { return null }
  if (!/^[A-Za-z0-9+/]{1,4096}={0,2}$/.test(fm) || !/^[A-Za-z0-9_-]{1,80}$/.test(ctype)
    || !/^\d{1,4}$/.test(t) || !/^[A-Za-z0-9_-]{1,80}$/.test(fs)) return null
  let prefix: string
  try { prefix = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(fm, 'base64')).split('_')[0]! } catch { return null }
  if (!/^[A-Za-z0-9-]{1,256}$/.test(prefix)) return null
  const now = (options.now ?? Date.now)()
  if (!integer(now, Number.MAX_SAFE_INTEGER)) return null
  const rng = options.random ?? random
  const sample = () => { const value = rng(); if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Invalid RNG'); return value }
  let user = presenterUid
  if (user === 0n) user = sample() < 0.5 ? 12_340_000n + BigInt(Math.floor(sample() * 10_000)) : 1_400_000_000_000n + BigInt(Math.floor(sample() * 10_000_000))
  const seqid = user + BigInt(now)
  let wsTime = params.get('wsTime') ?? ''
  if (!/^[a-f0-9]{1,12}$/i.test(wsTime)) return null
  if (BigInt(`0x${wsTime}`) < BigInt(Math.floor(now / 1000) + 1200)) wsTime = (Math.floor(now / 1000) + 86400).toString(16)
  const converted = rotateHuyaUid(user)
  const secret = md5(`${prefix}_${t === '103' ? user : converted}_${streamName}_${md5(`${seqid}|${ctype}|${t}`)}_${wsTime}`)
  const result = new URLSearchParams({ wsSecret: secret, wsTime, seqid: String(seqid), ctype, ver: '1', fs, fm, t })
  if (t === '103') {
    const ct = Math.floor((Number.parseInt(wsTime, 16) + sample()) * 1000)
    result.set('uid', String(user))
    result.set('uuid', String(Math.floor(((ct % 10_000_000_000 + sample()) * 1000) % 0xffff_ffff)))
  } else result.set('u', String(converted))
  return result.toString()
}

function resolved(room: string, url: URL, qualities: QualityOption[], quality: string, source: string, cdn: string, deps: ResolverDeps): ResolveResult {
  // Never include raw titles, tokens, headers or extractor output in public metadata.
  return { ok: true, stream: {
    platform: 'huya', url: deps.proxify(url.href), kind: 'progressive', label: `虎牙 ${room}`, channel: room, sourceRoom: room,
    requiresProxy: true, headers: { ...HEADERS }, qualities, quality,
    notes: [`线路: ${cdn}. 令牌来源: ${source}.`, '画质名称和码率由虎牙提供. 断流后重新解析并签名. 虎牙弹幕暂未支持.'],
  } }
}

/** yt-dlp is the last extractor fallback, never a media probe or a login path. */
async function fallback(room: string, qualities: QualityOption[], deps: ResolverDeps, quality: string): Promise<ResolveResult> {
  if (!deps.runYtDlp) return failure('needs-manual-url', '虎牙签名参数不可用, 且未配置备用解析工具.', MANUAL_URL_HINT)
  let data: Record<string, unknown>
  try { data = record(await deps.runYtDlp(`${REFERER}${room}`)) }
  catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/offline|not.live|未开播/i.test(message)) return failure('not-live', '虎牙房间当前未开播.', '请等待主播开播后重新加载.')
    if (/login|sign.in|forbidden|restricted|geo.restrict|登录|封禁|整改/i.test(message)) return failure('restricted', '虎牙限制了该房间或画质的访问.', '请在虎牙官网确认可播放状态. 当前暂不支持虎牙登录.')
    return failure('upstream-error', '虎牙备用解析失败.', MANUAL_URL_HINT)
  }
  // Some Huya extractor versions omit live/codec fields; the page already confirmed ON.
  if (data.is_live === false || (typeof data.live_status === 'string' && data.live_status !== 'is_live') || replayTitle(data.title)) return failure('not-live', '虎牙房间当前不是直播.', MANUAL_URL_HINT)
  const candidates = Array.isArray(data.formats) && data.formats.length <= 1000 ? data.formats : []
  for (const raw of candidates) {
    const item = record(raw)
    const url = mediaUrl(item.url)
    if (!url || !url.pathname.endsWith('.flv') || (item.vcodec != null && !/^(?:avc|h264)/i.test(String(item.vcodec)))) continue
    const rate = url.searchParams.get('ratio') ?? '0'
    if (!/^\d{1,7}$/.test(rate) || Number(rate) > 1_000_000 || rate !== quality) continue
    if (!url.searchParams.get('wsSecret')) continue
    url.searchParams.set('codec', '264')
    // Original quality omits ratio; some CDN lines reject an explicit ratio=0.
    if (rate === '0') url.searchParams.delete('ratio')
    else url.searchParams.set('ratio', rate)
    return resolved(room, url, qualities.length ? qualities : [{ id: rate, label: rate === '0' ? '原画' : `画质 ${rate}` }], rate, 'yt-dlp', '备用线路', deps)
  }
  return failure('needs-manual-url', '虎牙没有返回所选画质的可用 FLV 地址.', '请重新解析并选择可用画质, 或使用直接媒体地址.')
}

export async function resolveHuya(input: string, deps: ResolverDeps): Promise<ResolveResult> {
  const inputRoom = parseHuyaRoom(input)
  if (!inputRoom) return failure('unsupported-url', '无法识别虎牙房间号.', '支持 huya.com/数字或字符串房间号, 也可选择虎牙后输入房间号.')
  if (deps.quality !== undefined && (!/^\d{1,7}$/.test(deps.quality) || Number(deps.quality) > 1_000_000)) return failure('unsupported-url', '虎牙画质编号无效.', '请从画质列表中重新选择.')
  let page: PageResult
  try {
    page = parseHuyaPage(await deps.fetchText(`${REFERER}${inputRoom}`, { headers: HEADERS }), inputRoom)
    if (page.ok && !/^\d+$/.test(inputRoom)) page = parseHuyaPage(await deps.fetchText(`${REFERER}${page.room}`, { headers: HEADERS }), page.room)
  } catch { return failure('upstream-error', '请求虎牙房间页面失败.', MANUAL_URL_HINT) }
  if (!page.ok) return page
  const quality = deps.quality ?? page.qualities[0]?.id ?? '0'
  if (page.qualities.length && !page.qualities.some(option => option.id === quality)) return failure('unsupported-url', '虎牙当前不提供所选画质.', '请重新解析并选择列表中的画质.')
  for (const line of page.lines) {
    let auth: string | null = null
    let source = 'Ex'
    try {
      if (deps.fetchBytes) {
        const token = decodeHuyaTokenResponse(await deps.fetchBytes('https://wup.huya.com', {
          method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/octet-stream' }, body: encodeHuyaTokenRequest(line.name),
        }))
        if (token) auth = buildHuyaAuth(line.name, token, line.presenter, { now: deps.now })
      }
    } catch { /* Invalid/unavailable WUP tokens fall back without exposing upstream details. */ }
    if (!auth) { source = 'AntiCode'; auth = buildHuyaAuth(line.name, line.antiCode, line.presenter, { now: deps.now }) }
    if (!auth) continue
    const url = new URL(`${line.base}/${line.name}.flv?${auth}&codec=264${quality === '0' ? '' : `&ratio=${quality}`}`)
    return resolved(page.room, url, page.qualities, quality, source, line.cdn, deps)
  }
  return fallback(page.room, page.qualities, deps, quality)
}
