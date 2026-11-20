import { parseTwitchChannel } from './twitch'
import { isTwitchChatAssetUrl, type TwitchBadgeAsset } from '../../src/core/twitchChat'

export type TwitchOAuth = { clientId: string; accessToken: string }
export type TwitchUserGrant = TwitchOAuth & { userId: string; scopes: readonly string[] }
export type TwitchFetch = (url: string, init: RequestInit) => Promise<Response>
export type TwitchRecord = Record<string, unknown>
export type TwitchChannel = { id: string; login: string; displayName: string }
export type TwitchLiveStream = { id: string; startedAt: number }
export type TwitchSharedChatSession = { sessionId: string; hostId: string; participantIds: string[]; createdAt: number | null }

export function twitchRecord(value: unknown): TwitchRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as TwitchRecord : {}
}

export function twitchText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function twitchUserId(value: unknown): string | null {
  return typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : null
}

export class TwitchApiError extends Error {
  constructor(readonly status: number | null) {
    super(status === 401 ? 'Twitch OAuth 授权无效或已过期'
      : status === 403 ? 'Twitch 授权范围或频道权限不足'
      : status === 429 ? 'Twitch API 请求过于频繁'
      : status === null ? '无法读取 Twitch API'
      : `Twitch API 返回异常（${status}）`)
  }
}

export class TwitchHelix {
  constructor(private readonly fetch: TwitchFetch, private readonly oauth: TwitchOAuth) {}

  async validateUser(signal: AbortSignal): Promise<TwitchUserGrant> {
    const result = await request(this.fetch, 'https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${this.oauth.accessToken}` },
    }, signal)
    const userId = twitchUserId(result.user_id)
    if (!userId || result.client_id !== this.oauth.clientId) throw new TwitchApiError(401)
    const scopes = Array.isArray(result.scopes) ? result.scopes.filter((scope): scope is string => typeof scope === 'string') : []
    return { ...this.oauth, userId, scopes }
  }

  async channel(input: string, signal: AbortSignal): Promise<TwitchChannel | null> {
    const login = parseTwitchChannel(input)
    if (!login) return null
    const users = await this.get('/users', { login }, signal)
    if (!users.length) return null
    const user = users.find(row => row.login === login)
    const id = twitchUserId(user?.id)
    if (!id || !user) throw new TwitchApiError(null)
    return { id, login, displayName: twitchText(user.display_name) || login }
  }

  async liveStream(channelId: string, signal: AbortSignal): Promise<TwitchLiveStream | null> {
    if (!twitchUserId(channelId)) return null
    const streams = await this.get('/streams', { user_id: channelId }, signal)
    if (!streams.length) return null
    const stream = streams.find(row => row.user_id === channelId && row.type === 'live')
    if (!stream) throw new TwitchApiError(null)
    const id = twitchUserId(stream.id)
    const startedAt = Date.parse(twitchText(stream.started_at))
    if (!id || !Number.isFinite(startedAt)) throw new TwitchApiError(null)
    return { id, startedAt }
  }

  async badges(channelId: string | null, signal: AbortSignal): Promise<TwitchBadgeAsset[]> {
    if (channelId !== null && !twitchUserId(channelId)) return []
    const sets = channelId
      ? await this.get('/chat/badges', { broadcaster_id: channelId }, signal)
      : await this.get('/chat/badges/global', {}, signal)
    return sets.flatMap(set => {
      const setId = twitchText(set.set_id)
      if (!setId || !Array.isArray(set.versions)) return []
      return set.versions.flatMap(value => {
        const version = twitchRecord(value)
        const id = twitchText(version.id)
        const imageUrl = twitchText(version.image_url_2x)
        const title = twitchText(version.title) || setId
        return id && imageUrl.startsWith('https://static-cdn.jtvnw.net/badges/') && isTwitchChatAssetUrl(imageUrl)
          ? [{ setId, id, title, imageUrl }] : []
      })
    })
  }

  async sharedChat(channelId: string, signal: AbortSignal): Promise<TwitchSharedChatSession | null> {
    if (!twitchUserId(channelId)) return null
    const [row] = await this.get('/shared_chat/session', { broadcaster_id: channelId }, signal)
    if (!row) return null
    const sessionId = twitchText(row.session_id)
    const hostId = twitchUserId(row.host_broadcaster_id)
    const participantIds = Array.isArray(row.participants) ? row.participants.flatMap(value => {
      const id = twitchUserId(twitchRecord(value).broadcaster_id)
      return id ? [id] : []
    }) : []
    if (!sessionId || !hostId || (hostId !== channelId && !participantIds.includes(channelId))) throw new TwitchApiError(null)
    const createdAt = Date.parse(twitchText(row.created_at))
    return { sessionId, hostId, participantIds, createdAt: Number.isFinite(createdAt) ? createdAt : null }
  }

  async subscribe(
    subscription: { type: string; version: string; condition: Record<string, string> },
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.call('/eventsub/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ ...subscription, transport: { method: 'websocket', session_id: sessionId } }),
    }, signal)
  }

  private async get(path: string, params: Record<string, string>, signal: AbortSignal): Promise<TwitchRecord[]> {
    const query = new URLSearchParams(params).toString()
    const response = await this.call(query ? `${path}?${query}` : path, {}, signal)
    if (!Array.isArray(response.data)) throw new TwitchApiError(null)
    return response.data.map(twitchRecord)
  }

  private call(path: string, init: RequestInit, signal: AbortSignal): Promise<TwitchRecord> {
    return request(this.fetch, `https://api.twitch.tv/helix${path}`, {
      ...init,
      headers: {
        'Client-Id': this.oauth.clientId,
        Authorization: `Bearer ${this.oauth.accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, signal)
  }
}

async function request(fetch: TwitchFetch, url: string, init: RequestInit, signal: AbortSignal): Promise<TwitchRecord> {
  signal.throwIfAborted()
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)])
  try {
    const result = await fetch(url, { ...init, signal: requestSignal, redirect: 'error' })
    requestSignal.throwIfAborted()
    if (!result.ok) throw new TwitchApiError(result.status)
    const body = twitchRecord(await result.json())
    requestSignal.throwIfAborted()
    return body
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof TwitchApiError) throw error
    throw new TwitchApiError(null)
  }
}
