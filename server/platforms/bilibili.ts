/**
 * Bilibili live room -> HLS playlist, via the public web-room play-info API.
 *
 * This endpoint is the one the web player itself calls and needs no signing for
 * unrestricted rooms, so no obfuscated code has to be executed. Rooms that require
 * login or payment return a structured failure instead of being worked around.
 */

import { failure, MANUAL_URL_HINT, type ResolveResult, type ResolverDeps } from './types'

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

type PlayInfoResponse = {
  code?: number
  message?: string
  data?: {
    room_id?: number
    live_status?: number
    playurl_info?: {
      playurl?: {
        stream?: Array<{
          protocol_name?: string
          format?: Array<{
            format_name?: string
            codec?: Array<{
              base_url?: string
              url_info?: Array<{ host?: string; extra?: string }>
            }>
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
    qn: '10000',
    platform: 'web',
    ptype: '8',
  })

  let payload: PlayInfoResponse
  try {
    payload = (await deps.fetchJson(`${PLAY_INFO_API}?${params.toString()}`)) as PlayInfoResponse
  } catch (error) {
    return failure(
      'upstream-error',
      `请求 B 站直播间信息失败：${error instanceof Error ? error.message : String(error)}`,
      MANUAL_URL_HINT,
    )
  }

  // A response with no `code` at all is not a success: it means we are not talking to
  // the API we think we are, so it takes the same path as an explicit error code.
  const payloadCode = payload.code ?? -1
  if (payloadCode !== 0) {
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

  const url = pickHlsUrl(payload)
  if (!url) {
    return failure(
      'needs-manual-url',
      `直播间 ${room} 未返回可用的 HLS 地址`,
      MANUAL_URL_HINT,
    )
  }

  return {
    ok: true,
    stream: {
      platform: 'bilibili',
      url: deps.proxify(url),
      kind: 'hls',
      label: `B 站直播 · ${room}`,
      channel: room,
      requiresProxy: true,
      notes: ['播放地址带时效签名，长时间后需要重新解析。'],
    },
  }
}

/** Prefer HLS (`http_hls`) over FLV, and fMP4 over TS for seekability. */
function pickHlsUrl(payload: PlayInfoResponse): string | null {
  const streams = payload.data?.playurl_info?.playurl?.stream ?? []
  const hls = streams.find((stream) => stream.protocol_name === 'http_hls') ?? streams[0]
  if (!hls) return null

  const formats = hls.format ?? []
  const preferred =
    formats.find((format) => format.format_name === 'fmp4') ??
    formats.find((format) => format.format_name === 'ts') ??
    formats[0]
  const codec = preferred?.codec?.[0]
  const info = codec?.url_info?.[0]
  if (!codec?.base_url || !info?.host) return null
  return `${info.host}${codec.base_url}${info.extra ?? ''}`
}
