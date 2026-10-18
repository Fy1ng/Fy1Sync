/**
 * Douyu room -> playable URL, via Douyu's documented open room API.
 *
 * Douyu's web player builds its stream URL by downloading an obfuscated JS function
 * from the room page and executing it to sign the request. This implementation does not
 * do that: running remote, deliberately-obfuscated code inside our server process is an
 * arbitrary-code-execution channel controlled by a third party, and it changes without
 * notice. Instead we query the public `open.douyucdn.cn` room API. When that endpoint
 * does not include a playable URL, the user is told to paste the m3u8 directly rather
 * than having the restriction worked around silently.
 *
 * The room id is still resolved here because the danmaku relay needs it, so commentary
 * danmaku works even when the video URL has to be supplied manually.
 */

import { failure, MANUAL_URL_HINT, type ResolveResult, type ResolverDeps } from './types'

const OPEN_ROOM_API = 'https://open.douyucdn.cn/api/RoomApi/room'

export function parseDouyuRoom(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  if (/^\d{1,12}$/.test(trimmed)) return trimmed

  let url: URL
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (!/(^|\.)douyu\.com$/i.test(url.hostname)) return null

  // Short rooms live at /123456; topic pages at /topic/xxx?rid=123456.
  const rid = url.searchParams.get('rid')
  if (rid && /^\d{1,12}$/.test(rid)) return rid

  const segments = url.pathname.split('/').filter(Boolean)
  for (const segment of segments.reverse()) {
    if (/^\d{1,12}$/.test(segment)) return segment
  }
  // Vanity room paths (/tv/name) cannot be turned into a numeric id without the page.
  return null
}

type OpenRoomResponse = {
  error?: number
  data?: {
    room_id?: number | string
    room_name?: string
    owner_name?: string
    room_status?: string
    hls_url?: string
    rtmp_url?: string
    rtmp_live?: string
  }
}

export async function resolveDouyu(input: string, deps: ResolverDeps): Promise<ResolveResult> {
  const room = parseDouyuRoom(input)
  if (!room) {
    return failure(
      'unsupported-url',
      '无法从输入中识别斗鱼房间号',
      '支持形如 douyu.com/房间号 的地址或直接输入房间号。个性域名房间请先在浏览器中打开，复制地址栏里的数字房间号。',
    )
  }

  let payload: OpenRoomResponse
  try {
    payload = (await deps.fetchJson(`${OPEN_ROOM_API}/${room}`)) as OpenRoomResponse
  } catch (error) {
    return failure(
      'upstream-error',
      `请求斗鱼房间信息失败：${error instanceof Error ? error.message : String(error)}`,
      MANUAL_URL_HINT,
    )
  }

  const data = payload.data
  if (payload.error !== 0 || !data) {
    return failure('room-not-found', `斗鱼未返回房间 ${room} 的信息`, MANUAL_URL_HINT)
  }

  const label = data.room_name?.trim() || data.owner_name?.trim() || `斗鱼 ${room}`
  const hls = pickHlsUrl(data)

  // The room id is the useful half of a failed resolve: danmaku needs only the number,
  // so every failure below keeps it in the hint.
  const roomHint = `${MANUAL_URL_HINT}弹幕仍可使用房间号 ${room} 单独连接。`

  // A closed room's cached hls_url usually 404s or serves a stale segment list. Saying so
  // is more useful than handing the player a URL that will fail on its own a second later.
  if (data.room_status !== '1') {
    return { ok: false, failure: { code: 'not-live', message: `房间「${label}」当前未开播`, hint: roomHint } }
  }

  if (!hls) {
    return {
      ok: false,
      failure: {
        code: 'needs-manual-url',
        message: `已找到房间「${label}」，但斗鱼公开接口未返回可直接播放的地址`,
        hint: roomHint,
      },
    }
  }

  return {
    ok: true,
    stream: {
      platform: 'douyu',
      url: deps.proxify(hls),
      kind: hls.includes('.m3u8') ? 'hls' : 'progressive',
      label: `斗鱼 · ${label}`,
      channel: room,
      requiresProxy: true,
      danmakuRoom: room,
      notes: ['播放地址带时效签名，长时间后需要重新解析。'],
    },
  }
}

function pickHlsUrl(data: NonNullable<OpenRoomResponse['data']>): string | null {
  const candidate = data.hls_url?.trim()
  if (candidate && /^https?:\/\//.test(candidate)) return candidate
  // Some responses split the RTMP url; only an HTTP(S) one is usable in a browser.
  const rtmp = `${data.rtmp_url?.trim() ?? ''}/${data.rtmp_live?.trim() ?? ''}`
  if (/^https?:\/\//.test(rtmp) && rtmp.includes('.m3u8')) return rtmp
  return null
}

/** Room id for the danmaku relay, extracted without requiring a playable stream. */
export function douyuRoomFor(input: string): string | null {
  return parseDouyuRoom(input)
}
