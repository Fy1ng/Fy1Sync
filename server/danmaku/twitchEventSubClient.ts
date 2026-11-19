import { twitchMessageKey, type TwitchEvent, type TwitchMessageRef } from '../../src/core/twitchChat'
import {
  TwitchApiError, TwitchHelix, twitchRecord, twitchText, twitchUserId, type TwitchFetch, type TwitchOAuth,
} from '../platforms/twitchHelix'
import { parseTwitchEvent, twitchSubscriptionPlan, type TwitchChannelTopics, type TwitchSubscriptionPlan } from './twitchEventSubProtocol'
import type { WebSocketLike } from './types'

export const TWITCH_EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws'
const VALIDATE_INTERVAL = 60 * 60 * 1000

export type TwitchEventSubStatus =
  | { state: 'connecting' | 'connected' | 'reconnecting' | 'closed' }
  | { state: 'unavailable'; reason: 'oauth-required' | 'scope-required' | 'authorization-failed' | 'invalid-channel' }
  | { state: 'topic-unavailable'; topic: TwitchSubscriptionPlan['unavailable'][number] }
  | { state: 'subscription-failed'; type: string; status: number | null }
  | { state: 'subscription-revoked'; type: string; reason: string }

type Socket = Pick<WebSocketLike, 'close' | 'addEventListener'>

export type TwitchEventSubOptions = {
  channelId: string
  oauth?: TwitchOAuth
  expectedUserId?: string
  include?: readonly TwitchChannelTopics[]
  fetch: TwitchFetch
  openSocket: (url: string) => Socket
  onEvent: (event: TwitchEvent) => void
  onStatus: (status: TwitchEventSubStatus) => void
  now?: () => number
}

type Connection = {
  socket: Socket
  abort: AbortController
  timer?: ReturnType<typeof setTimeout>
  keepalive?: number
}

export class TwitchEventSubClient {
  private readonly lifetime = new AbortController()
  private active?: Connection
  private migration?: Connection
  private retry?: ReturnType<typeof setTimeout>
  private revalidate?: ReturnType<typeof setTimeout>
  private validation?: AbortController
  private retryDelay = 1000
  private started = false
  private connectedTypes = new Set<string>()
  private readonly subscriptions = new Map<string, TwitchSubscriptionPlan['subscriptions'][number]>()
  private readonly notifications = new Map<string, true>()
  private readonly messages = new Map<string, TwitchMessageRef>()
  private readonly origins = new Map<string, true>()
  private readonly deleted = new Map<string, true>()
  private readonly helix?: TwitchHelix

  constructor(private readonly options: TwitchEventSubOptions) {
    if (options.oauth) this.helix = new TwitchHelix(options.fetch, options.oauth)
  }

  start(): void {
    if (this.started || this.lifetime.signal.aborted) return
    this.started = true
    if (!twitchUserId(this.options.channelId)) {
      this.finish({ state: 'unavailable', reason: 'invalid-channel' })
    } else if (!this.helix) {
      this.finish({ state: 'unavailable', reason: 'oauth-required' })
    } else {
      this.options.onStatus({ state: 'connecting' })
      void this.openFreshSession()
    }
  }

  stop(): void {
    this.finish({ state: 'closed' })
  }

  private finish(status: TwitchEventSubStatus): void {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort()
    clearTimeout(this.retry)
    this.cancelRevalidation()
    this.close(this.active)
    this.close(this.migration)
    this.active = this.migration = undefined
    this.options.onStatus(status)
  }

  private async openFreshSession(): Promise<void> {
    if (!this.helix || this.lifetime.signal.aborted) return
    this.cancelRevalidation()
    this.subscriptions.clear()
    this.connectedTypes.clear()
    try {
      const grant = await this.helix.validateUser(this.lifetime.signal)
      this.lifetime.signal.throwIfAborted()
      if (this.options.expectedUserId && grant.userId !== this.options.expectedUserId) {
        this.finish({ state: 'unavailable', reason: 'authorization-failed' })
        return
      }
      const plan = twitchSubscriptionPlan(this.options.channelId, grant, this.options.include)
      plan.subscriptions.forEach(subscription => this.subscriptions.set(subscription.type, subscription))
      plan.unavailable.forEach(topic => this.options.onStatus({ state: 'topic-unavailable', topic }))
      if (!this.subscriptions.size) {
        this.finish({ state: 'unavailable', reason: 'scope-required' })
      } else if (!this.lifetime.signal.aborted) {
        this.active = this.connect(TWITCH_EVENTSUB_URL)
        this.armRevalidation(this.helix, grant.userId)
      }
    } catch (error) {
      if (error instanceof TwitchApiError && (error.status === 401 || error.status === 403)) {
        this.finish({ state: 'unavailable', reason: 'authorization-failed' })
      } else {
        this.scheduleRetry()
      }
    }
  }

  private armRevalidation(helix: TwitchHelix, userId: string): void {
    this.revalidate = setTimeout(async () => {
      const validation = new AbortController()
      this.validation = validation
      try {
        const grant = await helix.validateUser(validation.signal)
        if (validation.signal.aborted) return
        if (grant.userId !== userId) {
          this.finish({ state: 'unavailable', reason: 'authorization-failed' })
        } else {
          this.armRevalidation(helix, userId)
        }
      } catch (error) {
        if (validation.signal.aborted) return
        if (error instanceof TwitchApiError && (error.status === 401 || error.status === 403)) {
          this.finish({ state: 'unavailable', reason: 'authorization-failed' })
        } else {
          this.close(this.active)
          this.close(this.migration)
          this.active = this.migration = undefined
          this.scheduleRetry()
        }
      } finally {
        if (this.validation === validation) this.validation = undefined
      }
    }, VALIDATE_INTERVAL)
  }

  private cancelRevalidation(): void {
    clearTimeout(this.revalidate)
    this.validation?.abort()
    this.validation = undefined
  }

  private connect(url: string): Connection {
    const socket = this.options.openSocket(url)
    const connection: Connection = { socket, abort: new AbortController() }
    this.arm(connection, 10_000)
    socket.addEventListener('message', event => this.accept(connection, event.data))
    socket.addEventListener('error', () => this.disconnected(connection))
    socket.addEventListener('close', () => this.disconnected(connection))
    return connection
  }

  private close(connection?: Connection): void {
    if (!connection || connection.abort.signal.aborted) return
    connection.abort.abort()
    clearTimeout(connection.timer)
    connection.socket.close()
  }

  private arm(connection: Connection, delay: number): void {
    clearTimeout(connection.timer)
    connection.timer = setTimeout(() => this.disconnected(connection), delay)
  }

  private disconnected(connection: Connection): void {
    if (this.lifetime.signal.aborted || connection.abort.signal.aborted) return
    if (connection === this.migration) this.migration = undefined
    if (connection === this.active) this.active = undefined
    this.close(connection)
    if (!this.active && !this.migration) this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.lifetime.signal.aborted || this.retry) return
    this.cancelRevalidation()
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.openFreshSession()
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000)
    this.options.onStatus({ state: 'reconnecting' })
  }

  private accept(connection: Connection, data: unknown): void {
    if (this.lifetime.signal.aborted || connection.abort.signal.aborted || typeof data !== 'string' || data.length > 262_144) return
    let envelope
    try {
      envelope = twitchRecord(JSON.parse(data))
    } catch {
      return
    }
    const metadata = twitchRecord(envelope.metadata)
    const payload = twitchRecord(envelope.payload)
    const kind = metadata.message_type
    if (kind === 'session_welcome') {
      this.welcome(connection, twitchRecord(payload.session))
      return
    }
    if (connection !== this.active || connection.keepalive === undefined) return
    if (kind === 'session_keepalive' || kind === 'notification' || kind === 'session_reconnect' || kind === 'revocation') {
      this.arm(connection, connection.keepalive)
    }
    switch (kind) {
      case 'session_reconnect':
        this.migrate(twitchText(twitchRecord(payload.session).reconnect_url))
        break
      case 'notification':
      case 'revocation':
        this.notification(kind, metadata, payload)
        break
    }
  }

  private welcome(connection: Connection, session: Record<string, unknown>): void {
    if (connection.keepalive !== undefined) return
    const id = twitchText(session.id)
    const seconds = session.keepalive_timeout_seconds
    if (!id || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 600) return
    connection.keepalive = seconds * 1000 + 1000
    this.arm(connection, connection.keepalive)
    if (connection === this.migration) {
      const previous = this.active
      this.active = connection
      this.migration = undefined
      this.close(previous)
      this.options.onStatus({ state: 'connected' })
    } else if (connection === this.active) {
      void this.subscribe(connection, id)
    }
  }

  private migrate(raw: string): void {
    if (this.migration || raw.length > 8192 || /[\x00-\x20\x7f]/.test(raw)) return
    try {
      const url = new URL(raw)
      if (url.origin !== 'wss://eventsub.wss.twitch.tv' || url.username || url.password || url.hash
        || !['/', '/ws'].includes(url.pathname)) return
      this.migration = this.connect(raw)
      this.options.onStatus({ state: 'reconnecting' })
    } catch {}
  }

  private async subscribe(connection: Connection, sessionId: string): Promise<void> {
    const helix = this.helix
    if (!helix) return
    const signal = connection.abort.signal
    const subscriptions = [...this.subscriptions.values()]
    const results = await Promise.all(subscriptions.map(async subscription => {
      try {
        await helix.subscribe(subscription, sessionId, signal)
        if (!signal.aborted && this.subscriptions.has(subscription.type)) this.connectedTypes.add(subscription.type)
        return { ok: true } as const
      } catch (error) {
        const status = error instanceof TwitchApiError ? error.status : null
        if (!signal.aborted) {
          this.subscriptions.delete(subscription.type)
          this.options.onStatus({ state: 'subscription-failed', type: subscription.type, status })
        }
        return { ok: false, status } as const
      }
    }))
    if (signal.aborted) return
    if (results.some(result => !result.ok && result.status === 401)) {
      this.finish({ state: 'unavailable', reason: 'authorization-failed' })
    } else if (this.connectedTypes.size) {
      this.retryDelay = 1000
      this.options.onStatus({ state: 'connected' })
    } else if (results.some(result => !result.ok && (result.status === null || result.status === 429 || result.status >= 500))) {
      this.disconnected(connection)
    } else {
      this.finish({ state: 'unavailable', reason: 'authorization-failed' })
    }
  }

  private notification(kind: 'notification' | 'revocation', metadata: Record<string, unknown>, payload: Record<string, unknown>): void {
    const incoming = twitchRecord(payload.subscription)
    const type = twitchText(incoming.type)
    const subscription = this.subscriptions.get(type)
    const condition = twitchRecord(incoming.condition)
    const notificationId = twitchText(metadata.message_id)
    if (!subscription || incoming.version !== subscription.version || !notificationId
      || !Object.entries(subscription.condition).every(([key, value]) => condition[key] === value)
      || this.notifications.has(notificationId)) return
    remember(this.notifications, notificationId, true)
    if (kind === 'revocation') {
      const reason = twitchText(incoming.status)
      this.subscriptions.delete(type)
      this.connectedTypes.delete(type)
      this.options.onStatus({ state: 'subscription-revoked', type, reason })
      if (reason === 'authorization_revoked' || reason === 'user_removed' || !this.subscriptions.size) {
        this.finish({ state: 'unavailable', reason: 'authorization-failed' })
      }
      return
    }
    const event = parseTwitchEvent(type, payload.event, this.options.channelId, this.options.now?.() ?? Date.now())
    if (!event) return
    if (event.kind === 'chat' || event.kind === 'notice') {
      const key = twitchMessageKey(event.message)
      remember(this.messages, key, event.source)
      if (this.deleted.has(key)) remember(this.deleted, event.id, true)
      if (this.origins.has(event.id) || this.deleted.has(event.id)) return
      remember(this.origins, event.id, true)
    } else if (event.kind === 'delete') {
      const key = twitchMessageKey(event.target)
      event.source = this.messages.get(key) ?? event.target
      remember(this.deleted, key, true)
      remember(this.deleted, twitchMessageKey(event.source), true)
    }
    this.options.onEvent(event)
  }
}

function remember<Value>(entries: Map<string, Value>, id: string, value: Value): void {
  entries.set(id, value)
  if (entries.size <= 4096) return
  const oldest = entries.keys().next().value
  if (oldest !== undefined) entries.delete(oldest)
}
