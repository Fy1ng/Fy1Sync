/**
 * Twitch channel -> HLS playlist.
 *
 * Twitch's own web player asks its GraphQL endpoint for a signed playback access token
 * and passes the signature to `usher.ttvnw.net`, which returns the multivariant
 * playlist. That is the documented client flow and the public web client ID; nothing
 * here bypasses signing, subscriber gating or geo rules — a stream we are not allowed
 * to see comes back as a structured failure with a manual-URL hint.
 */

import { failure, MANUAL_URL_HINT, type ResolveResult, type ResolverDeps } from './types'

/** Public client id used by Twitch's own web player; required by their GQL gateway. */
const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
const GQL_ENDPOINT = 'https://gql.twitch.tv/gql'
const USHER_BASE = 'https://usher.ttvnw.net/api/channel/hls'

const PLAYBACK_TOKEN_QUERY = `
query PlaybackAccessToken($login: String!, $isLive: Boolean!, $playerType: String!) {
  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
    value
    signature
  }
}`

/** Accepts a bare channel name or any twitch.tv URL that names one. */
export function parseTwitchChannel(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  if (/^[a-zA-Z0-9_]{3,25}$/.test(trimmed)) return trimmed.toLowerCase()

  let url: URL
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (!/(^|\.)twitch\.tv$/i.test(url.hostname)) return null

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length === 0) return null
  // /videos/123 is a VOD, which needs a different token type than we request here.
  if (RESERVED_PATHS.has(segments[0]!.toLowerCase())) return null
  // /<channel>/clip/<slug> names one recorded asset, not the live stream. Resolving it to
  // the channel would quietly play something other than what was pasted, so anything
  // deeper than the channel's own pages is rejected.
  if (segments.length > 1 && !CHANNEL_TABS.has(segments[1]!.toLowerCase())) return null

  const candidate = segments[0]!.toLowerCase()
  return /^[a-zA-Z0-9_]{3,25}$/.test(candidate) ? candidate : null
}

/** First path segments that belong to Twitch itself, so they can never be a channel. */
const RESERVED_PATHS = new Set([
  'videos',
  'directory',
  'settings',
  'downloads',
  'store',
  'subscriptions',
  'popout',
  'moderator',
  'p',
])

/** Second path segments that still address the channel rather than one of its assets. */
const CHANNEL_TABS = new Set(['about', 'schedule', 'videos', 'clips', 'collections', 'home'])

type TokenResponse = {
  data?: {
    streamPlaybackAccessToken?: { value?: string; signature?: string } | null
  }
  errors?: Array<{ message?: string }>
}

export async function resolveTwitch(
  input: string,
  deps: ResolverDeps,
): Promise<ResolveResult> {
  const channel = parseTwitchChannel(input)
  if (!channel) {
    return failure(
      'unsupported-url',
      '无法从输入中识别 Twitch 频道名',
      '支持形如 twitch.tv/频道名 的直播地址或直接输入频道名。点播 VOD 请直接粘贴播放地址。',
    )
  }

  let token: TokenResponse
  try {
    token = (await deps.fetchJson(GQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'client-id': WEB_CLIENT_ID,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operationName: 'PlaybackAccessToken',
        query: PLAYBACK_TOKEN_QUERY,
        variables: { login: channel, isLive: true, playerType: 'site' },
      }),
    })) as TokenResponse
  } catch (error) {
    return failure(
      'upstream-error',
      `请求 Twitch 播放令牌失败：${error instanceof Error ? error.message : String(error)}`,
      MANUAL_URL_HINT,
    )
  }

  const access = token.data?.streamPlaybackAccessToken
  if (!access?.value || !access.signature) {
    const detail = token.errors?.[0]?.message
    return failure(
      'not-live',
      detail ? `Twitch 未返回播放令牌：${detail}` : `频道 ${channel} 当前不在直播，或该频道受限`,
      MANUAL_URL_HINT,
    )
  }

  const params = new URLSearchParams({
    allow_source: 'true',
    allow_audio_only: 'true',
    // Ads and low-latency mode both hurt sync stability; a plain playlist is what we want.
    fast_bread: 'false',
    p: String(Math.floor(Math.random() * 9_999_999)),
    play_session_id: randomHex(32),
    player_backend: 'mediaplayer',
    playlist_include_framerate: 'true',
    reassignments_supported: 'true',
    sig: access.signature,
    token: access.value,
    supported_codecs: 'avc1',
    cdm: 'wv',
    player_version: '1.32.0',
  })
  const playlistUrl = `${USHER_BASE}/${channel}.m3u8?${params.toString()}`

  return {
    ok: true,
    stream: {
      platform: 'twitch',
      url: deps.proxify(playlistUrl),
      kind: 'hls',
      label: `Twitch · ${channel}`,
      channel,
      requiresProxy: true,
      notes: [
        '通过本地代理加载，避免跨域并允许读取画面像素用于倒计时识别。',
        '播放地址带签名且会过期，长时间挂机后如报 403 请重新解析。',
      ],
    },
  }
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2))
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length)
}
