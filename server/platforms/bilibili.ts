/**
 * Bilibili live room -> HLS playlist, via the public web-room play-info API.
 *
 * This endpoint is the one the web player itself calls and needs no signing for
 * unrestricted rooms, so no obfuscated code has to be executed. Rooms that require
 * login or payment return a structured failure instead of being worked around.
 */

import { failure, MANUAL_URL_HINT, type ResolveResult, type ResolverDeps } from './types'
import { StreamFailureError } from '../networkFailure'

const PLAY_INFO_API =
  'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo'

export function parseBilibiliRoom(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  if (/^\d{1,12}$/.test(trimmed)) return trimmed

  let url: URL
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (!/(^|\.)bilibili\.com$/i.test(url.hostname)) return null
  if (!url.hostname.toLowerCase().startsWith('live.')) return null

  const segments = url.pathname.split('/').filter(Boolean)
  for (const segment of segments.reverse()) {
    if (/^\d{1,12}$/.test(segment)) return segment
  }
  return null
}

type PlayCodec = {
  codec_name?: string
  current_qn?: number
  accept_qn?: number[]
  base_url?: string
  url_info?: Array<{ host?: string; extra?: string }>
}

type PlayInfoResponse = {
  code?: number
  message?: string
  data?: {
    room_id?: number
    live_status?: number
    playurl_info?: {
      playurl?: {
        g_qn_desc?: Array<{ qn?: number; desc?: string }>
        stream?: Array<{
          protocol_name?: string
          format?: Array<{
            format_name?: string
            codec?: PlayCodec[]
          }>
        }>
      }
    }
  }
}

/** `1` is the legacy "room does not exist"; `19002000` is the room-service equivalent. */
const ROOM_NOT_FOUND_CODES = new Set([1, 60004, 19002000])

export async function resolveBilibili(
  input: string,
  deps: ResolverDeps,
): Promise<ResolveResult> {
  const room = parseBilibiliRoom(input)
  if (!room) {
    return failure(
      'unsupported-url',
      '无法从输入中识别 B 站直播间号',
      '支持形如 live.bilibili.com/房间号 的地址或直接输入房间号。',
    )
  }

  const params = new URLSearchParams({
    room_id: room,
    protocol: '0,1',
    format: '0,1,2',
    codec: '0,1',
    qn: deps.quality && /^[1-9]\d{0,5}$/.test(deps.quality) ? deps.quality : '10000',
    platform: 'web',
    ptype: '8',
  })

  let payload: PlayInfoResponse
  try {
    const requestUrl = `${PLAY_INFO_API}?${params.toString()}`
    const cookie = await deps.cookieHeader?.('bilibili', requestUrl)
    payload = (await deps.fetchJson(requestUrl, cookie ? { headers: { Cookie: cookie } } : undefined)) as PlayInfoResponse
  } catch (error) {
    if (error instanceof StreamFailureError) throw error
    return failure(
      'upstream-error',
      '请求 B 站直播间信息失败',
      MANUAL_URL_HINT,
    )
  }

  // A response with no `code` at all is not a success: it means we are not talking to
  // the API we think we are, so it takes the same path as an explicit error code.
  const payloadCode = payload.code ?? -1
  if (payloadCode !== 0) {
    // -101 is the explicit account-not-logged-in code; rendition caps are not identity errors.
    if (payloadCode === -101) return failure('login-required', 'B站登录信息已失效或该直播间需要登录.', '请登录B站后重新加载片源.')
    // Only the codes that really mean "no such room" are reported as such; everything else
    // (-400 bad request, -352 risk control, 网关 5xx mapped to a code) is our problem or
    // theirs, and telling the user the room does not exist would send them chasing nothing.
    const code = ROOM_NOT_FOUND_CODES.has(payloadCode) ? 'room-not-found' : 'upstream-error'
    return failure(
      code,
      payload.message?.trim() || `B 站未返回直播间 ${room} 的播放信息`,
      MANUAL_URL_HINT,
    )
  }
  if (payload.data?.live_status !== 1) {
    return failure('not-live', `直播间 ${room} 当前未开播`, MANUAL_URL_HINT)
  }

  const requested = Number(params.get('qn'))
  const renditions = hlsRenditions(payload, requested)
  const selected = renditions[0]
  if (!selected) {
    return failure(
      'needs-manual-url',
      `直播间 ${room} 未返回可用的 HLS 地址`,
      MANUAL_URL_HINT,
    )
  }

  const descriptions = new Map((payload.data?.playurl_info?.playurl?.g_qn_desc ?? [])
    .filter(item => validQn(item.qn) && typeof item.desc === 'string' && item.desc.trim())
    .map(item => [item.qn!, item.desc!.trim().slice(0, 64)]))
  const label = (qn: number) => descriptions.get(qn) ?? QUALITY_LABELS[qn] ?? `档位 ${qn}`
  const current = validQn(selected.codec.current_qn) ? selected.codec.current_qn : undefined
  const available = [...new Set(renditions.flatMap(({ codec }) => [
    ...(codec.accept_qn?.filter(validQn) ?? []), ...(validQn(codec.current_qn) ? [codec.current_qn] : []),
  ]))].sort((a, b) => b - a)
  const notes = ['播放地址带时效签名, 长时间后需要重新解析.']
  if (current !== undefined && current !== requested) {
    notes.push(`请求${label(requested)}, 实际为${label(current)}. 可用画质由直播间返回, 不能据此判断登录状态.`)
  }

  return {
    ok: true,
    stream: {
      platform: 'bilibili',
      url: deps.proxify(selected.url),
      kind: 'hls',
      label: `B 站直播 · ${room}`,
      channel: room,
      requiresProxy: true,
      qualities: available.length ? available.map(qn => ({ id: String(qn), label: label(qn) })) : undefined,
      quality: current === undefined ? undefined : String(current),
      notes,
    },
  }
}

/** Match the actual quality across HLS formats before preferring fMP4 for seekability. */
function hlsRenditions(payload: PlayInfoResponse, requested: number) {
  const streams = payload.data?.playurl_info?.playurl?.stream ?? []
  const candidates = streams.filter(stream => stream.protocol_name === 'http_hls').flatMap(stream =>
    (stream.format ?? []).filter(format => format.format_name === 'fmp4' || format.format_name === 'ts').flatMap(format =>
      (format.codec ?? []).flatMap(codec => {
        const info = codec.url_info?.find(item => item.host)
        if (!codec.base_url || !info?.host) return []
        return [{ url: `${info.host}${codec.base_url}${info.extra ?? ''}`, codec, format: format.format_name }]
      }),
    ),
  )
  // Keep AVC compatibility across formats; HEVC remains a fallback when no AVC is available.
  const codecName = candidates.some(item => item.codec.codec_name === 'avc') ? 'avc' : 'hevc'
  return candidates.filter(item => item.codec.codec_name === codecName).sort((a, b) =>
    Number(b.codec.current_qn === requested) - Number(a.codec.current_qn === requested)
    || (validQn(b.codec.current_qn) ? b.codec.current_qn : 0) - (validQn(a.codec.current_qn) ? a.codec.current_qn : 0)
    || Number(b.format === 'fmp4') - Number(a.format === 'fmp4'),
  )
}

function validQn(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 999_999
}

const QUALITY_LABELS: Record<number, string> = {
  80: '流畅', 150: '高清', 250: '超清', 400: '蓝光', 10000: '原画', 20000: '4K', 30000: '杜比',
}
