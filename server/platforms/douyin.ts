/** Public live acquisition with optional scoped credentials. No page scripts are executed. */
import { parseDouyinInput, type DouyinInput } from '../../src/core/douyinInput'
import { StreamFailureError } from '../networkFailure'
import { asRecord, parseDouyinPage, parseDouyinWebResponse, type DouyinRoomData, type JsonRecord } from './douyinPage'
import { failure, type PlatformPage, type QualityOption, type ResolveResult, type ResolverDeps } from './types'

const REFERER = 'https://live.douyin.com/'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const HEADERS = { Referer: REFERER, 'User-Agent': USER_AGENT }
const ANONYMOUS_SESSION = 'https://ttwid.bytedance.com/ttwid/union/register/'
const WEB_ENTER = 'https://live.douyin.com/webcast/room/web/enter/'
const RETRY_HINT = '请在抖音官网确认房间正在直播且可正常观看, 稍后重新加载.'
const KEY = /^[A-Za-z0-9_-]{1,64}$/
const EXCLUDED = new Set(['ao', 'md', 'tsl'])
const QUALITY_NAMES: Record<string, string> = { origin: '原画', uhd: '蓝光', hd: '超清', sd: '高清', ld: '标清', od: '原画', full_hd1: '原画', hd1: '超清', sd1: '高清', sd2: '标清' }
const QUALITY_RANK: Record<string, number> = { origin: 100, od: 100, uhd: 80, hd: 60, sd: 40, ld: 20, full_hd1: 100, hd1: 60, sd1: 40, sd2: 20 }
const cleanText = (value: unknown, max: number): string => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : ''

function jsonRecord(value: unknown): JsonRecord {
  if (typeof value !== 'string') return asRecord(value)
  if (value.length > 1_048_576) return {}
  try { return asRecord(JSON.parse(value)) } catch { return {} }
}

function mediaUrl(raw: unknown, kind: 'flv' | 'hls'): string | undefined {
  if (typeof raw !== 'string' || raw.length > 32_768 || /[\x00-\x20\x7f]/.test(raw)) return undefined
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
      || !(kind === 'flv' ? /\.flv$/i : /\.m3u8$/i).test(url.pathname)) return undefined
    const codec = url.searchParams.get('codec') ?? ''
    if (/h265|hevc|hvc1|bytevc1/i.test(codec)) return undefined
    return url.href
  } catch { return undefined }
}

type Choice = QualityOption & { rank: number; flv?: string; hls?: string }

function sdkChoices(stream: JsonRecord): Choice[] {
  const pull = asRecord(asRecord(stream.live_core_sdk_data).pull_data)
  const data = asRecord(jsonRecord(pull.stream_data).data)
  const qualities = asRecord(pull.options).qualities
  const descriptions = new Map<string, JsonRecord>()
  if (Array.isArray(qualities) && qualities.length <= 100) {
    for (const value of qualities) {
      const item = asRecord(value)
      if (typeof item.sdk_key === 'string' && KEY.test(item.sdk_key)) descriptions.set(item.sdk_key, item)
    }
  }
  if (Object.keys(data).length > 100) return []
  return Object.entries(data).flatMap(([id, raw]): Choice[] => {
    if (!KEY.test(id) || EXCLUDED.has(id.toLowerCase())) return []
    const main = asRecord(asRecord(raw).main)
    const params = jsonRecord(main.sdk_params)
    const codec = [main.vcodec, params.vcodec, params.VCodec, params.video_codec, params.VideoCodec].find(value => typeof value === 'string')
    if (typeof codec === 'string' && !/^(?:h264|avc|avc1(?:\.[a-f0-9]+)?)$/i.test(codec)) return []
    const flv = mediaUrl(main.flv, 'flv'), hls = mediaUrl(main.hls, 'hls')
    if (!flv && !hls) return []
    const item = descriptions.get(id) ?? {}
    const resolution = typeof item.resolution === 'string' ? /^(\d{2,5})[xX](\d{2,5})$/.exec(item.resolution) : null
    const height = resolution ? Number(resolution[2]) : undefined
    const advertisedFps = item.frame_rate ?? params.fps
    const fps = typeof advertisedFps === 'number' && advertisedFps > 0 && advertisedFps <= 240 ? advertisedFps : undefined
    const rank = typeof item.level === 'number' && Number.isFinite(item.level) ? item.level : QUALITY_RANK[id] ?? 0
    return [{ id, label: cleanText(item.name, 64) || QUALITY_NAMES[id] || id, rank, flv, hls,
      ...(height ? { height } : {}), ...(fps ? { fps } : {}) }]
  })
}

function choicesFor(data: DouyinRoomData): Choice[] {
  const dedicated = sdkChoices(data.h264)
  const sdk = dedicated.length ? dedicated : sdkChoices(data.stream)
  if (sdk.length) return sdk.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
  // Legacy maps must not reintroduce a stream rejected by explicit SDK codec metadata.
  if ([data.h264, data.stream].some(stream => {
    const pull = asRecord(asRecord(stream.live_core_sdk_data).pull_data)
    return Object.keys(asRecord(jsonRecord(pull.stream_data).data)).length > 0
  })) return []
  const flv = asRecord(data.stream.flv_pull_url), hls = asRecord(data.stream.hls_pull_url_map)
  const keys = [...new Set([...Object.keys(flv), ...Object.keys(hls)])]
  if (keys.length > 100) return []
  return keys.flatMap((key): Choice[] => {
    const id = key.toLowerCase()
    if (!KEY.test(id) || EXCLUDED.has(id)) return []
    const flvUrl = mediaUrl(flv[key], 'flv'), hlsUrl = mediaUrl(hls[key], 'hls')
    return flvUrl || hlsUrl ? [{ id, label: QUALITY_NAMES[id] ?? id, rank: QUALITY_RANK[id] ?? 0, flv: flvUrl, hls: hlsUrl }] : []
  }).sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
}

function fromRoom(data: DouyinRoomData, quality?: string): ResolveResult {
  if (data.status === 4 || data.status === '4') return failure('not-live', '抖音直播间当前未开播.', '请等待主播开播后重新加载.')
  if (data.status !== 2 && data.status !== '2') return failure('upstream-error', '无法确认抖音直播间的开播状态.', RETRY_HINT)
  const choices = choicesFor(data)
  if (!choices.length) return failure('needs-manual-url', '抖音直播间未返回可播放的视频流.', '当前仅支持可直接观看的视频直播. 可尝试其他房间或可用的媒体直链.')
  const selected = !quality || quality === 'auto' ? choices[0] : choices.find(item => item.id === quality)
  if (!selected) return failure('unsupported-url', '抖音直播间已不提供所选画质.', '请重新加载房间, 然后从当前可用画质中选择.')
  const channel = data.webRoom ?? data.roomId
  if (!channel) return failure('upstream-error', '无法确认抖音直播间身份.', RETRY_HINT)
  return { ok: true, stream: {
    platform: 'douyin', channel, sourceRoom: data.roomId ?? channel,
    url: selected.flv ?? selected.hls!, kind: selected.flv ? 'progressive' : 'hls',
    requiresProxy: true, headers: { ...HEADERS },
    label: `抖音 / ${cleanText(data.title, 160) || channel}`,
    qualities: choices.map(({ id, label, height, fps }) => ({ id, label, ...(height ? { height } : {}), ...(fps ? { fps } : {}) })),
    ...(data.webRoom ? { danmakuRoom: `douyin:${data.webRoom}` } : {}),
    quality: selected.id,
  } }
}

function anonymousCookie(headers: string[]): string | undefined {
  if (headers.length > 100) return undefined
  for (const header of headers) {
    const match = /^ttwid=([^;\s]{1,4096})(?:;|$)/.exec(header)
    if (match && !/[\x00-\x1f\x7f]/.test(match[1]!)) return `ttwid=${match[1]}`
  }
  return undefined
}

async function pageAt(input: DouyinInput, deps: ResolverDeps): Promise<PlatformPage> {
  const cookie = input.kind === 'room' ? await deps.douyinCookieHeader?.(input.url) : undefined
  const headers = { ...HEADERS, ...(cookie ? { Cookie: cookie } : {}) }
  return deps.fetchPage ? deps.fetchPage(input.url, { headers })
    : { text: await deps.fetchText(input.url, { headers }), finalUrl: input.url, setCookie: [] }
}

/** A fresh anonymous cookie is scoped to this resolution, and only sent to the fixed API. */
async function apiRoom(webRoom: string, page: PlatformPage, deps: ResolverDeps): Promise<DouyinRoomData | null> {
  const signedIn = await deps.douyinCookieHeader?.(WEB_ENTER) ?? ''
  let cookie = signedIn || anonymousCookie(page.setCookie)
  if (!cookie && deps.fetchPage) {
    const session = await deps.fetchPage(ANONYMOUS_SESSION, { method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: 'cn', aid: 6383, needFid: false, service: 'www.douyin.com',
        migrate_info: { ticket: '', source: 'node' }, cbUrlProtocol: 'https', union: true }),
    })
    if (session.finalUrl !== ANONYMOUS_SESSION) return null
    cookie = anonymousCookie(session.setCookie)
  }
  if (!cookie) return null
  const params = new URLSearchParams({ aid: '6383', app_name: 'douyin_web', live_id: '1',
    device_platform: 'web', language: 'zh-CN', browser_language: 'zh-CN', browser_platform: 'Win32',
    browser_name: 'Chrome', browser_version: '131.0.0.0', web_rid: webRoom, is_need_double_stream: 'false', msToken: '' })
  const raw = await deps.fetchJson(`${WEB_ENTER}?${params}`, { headers: { ...HEADERS, Cookie: cookie } })
  return parseDouyinWebResponse(raw, webRoom)
}

export async function resolveDouyin(input: string, deps: ResolverDeps): Promise<ResolveResult> {
  const selected = parseDouyinInput(input)
  if (!selected || (deps.quality !== undefined && !KEY.test(deps.quality))) {
    return failure('unsupported-url', '无法识别抖音直播间或画质.', '请粘贴 live.douyin.com 的直播间地址或抖音直播分享链接.')
  }
  try {
    let request = selected
    let page = await pageAt(request, deps)
    let target = parseDouyinInput(page.finalUrl)
    if (!target || target.kind === 'share') return failure('unsupported-url', '分享链接没有指向可识别的抖音直播间.', '请从抖音直播间重新复制链接.')
    if (selected.kind === 'room' && (target.kind !== 'room' || target.room !== selected.room)) {
      return failure('upstream-error', '抖音返回的房间与输入不一致.', RETRY_HINT)
    }
    let data = parseDouyinPage(page.text, target.kind === 'room' ? target.room : undefined)
    if (target.kind === 'reflow') {
      if (!data || data.roomId !== target.room) return failure('upstream-error', '无法读取抖音直播分享信息.', '请复制该主播的 live.douyin.com 直播间地址后重试.')
      // A share identifies a past session. Follow the confirmed owner to their current room.
      if (data.webRoom) {
        request = { kind: 'room', room: data.webRoom, url: `${REFERER}${data.webRoom}` }
        page = await pageAt(request, deps)
        target = parseDouyinInput(page.finalUrl)
        if (!target || target.kind !== 'room' || target.room !== request.room) return failure('upstream-error', '无法确认分享链接对应的当前直播间.', RETRY_HINT)
        data = parseDouyinPage(page.text, target.room)
      } else return fromRoom(data, deps.quality)
    }
    let pageFailure: Extract<ResolveResult, { ok: false }> | undefined
    if (data) {
      const result = fromRoom(data, deps.quality)
      if (result.ok || result.failure.code !== 'needs-manual-url') return result
      pageFailure = result
    }
    if (target.kind === 'room') {
      const api = await apiRoom(target.room, page, deps)
      if (api) return fromRoom(api, deps.quality)
    }
    return pageFailure ?? failure('restricted', '抖音未返回可用的公开直播信息, 可能需要验证或暂时限制匿名访问.', RETRY_HINT)
  } catch (error) {
    if (error instanceof StreamFailureError) {
      if (error.failure.status === 404) return failure('room-not-found', '抖音直播间不存在或链接已失效.', '请检查房间号或重新复制直播链接.')
      if (error.failure.status === 401 || error.failure.status === 403) return failure('restricted', '抖音暂时不允许访问此直播间.', RETRY_HINT)
      throw error
    }
    return failure('upstream-error', '读取抖音直播信息失败.', RETRY_HINT)
  }
}
