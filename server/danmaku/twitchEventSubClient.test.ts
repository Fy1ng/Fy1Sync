import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TwitchEventSubClient, TWITCH_EVENTSUB_URL, type TwitchEventSubStatus } from './twitchEventSubClient'
import {
  twitchFixtureChannel as channel, twitchFixtureOrigin as origin, twitchFixtureViewer as viewer,
  twitchFixtureFrame as frame, twitchFixtureMessage as message, twitchFixtureNotify as notify,
} from './fixtures/twitchEventSub'
import type { TwitchEvent } from '../../src/core/twitchChat'
import type { TwitchChannelTopics } from './twitchEventSubProtocol'

class SocketFixture extends EventTarget {
  close = vi.fn()
  sendFrame(data: string): void { this.dispatchEvent(new MessageEvent('message', { data })) }
  welcome(id = 'session-fixture'): void {
    this.sendFrame(frame('session_welcome', { session: { id, keepalive_timeout_seconds: 10 } }))
  }
}

const oauth = { clientId: 'fixture-client', accessToken: 'fixture-token' }
const CHAT_TYPE = 'channel.chat.message'
const RECONNECT_URL = `${TWITCH_EVENTSUB_URL}?reconnect_token=fixture`
const clients: TwitchEventSubClient[] = []

function setup(options: {
  oauth?: typeof oauth; channelId?: string; userId?: string; scopes?: string[]; topics?: TwitchChannelTopics[];
  rejectedType?: string; validationStatus?: number; expectedUserId?: string
} = {}) {
  const sockets: SocketFixture[] = []
  const openSocket = vi.fn((_url: string) => {
    const socket = new SocketFixture()
    sockets.push(socket)
    return socket
  })
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/validate')) return Response.json({ client_id: oauth.clientId, user_id: options.userId ?? viewer, scopes: options.scopes ?? ['user:read:chat'] },
      { status: options.validationStatus ?? 200 })
    if (options.rejectedType && JSON.parse(String(init.body)).type === options.rejectedType) {
      return Response.json({ message: 'fixture-token' }, { status: 403 })
    }
    return Response.json({ data: [] }, { status: 202 })
  })
  const events: TwitchEvent[] = []
  const states: TwitchEventSubStatus[] = []
  const client = new TwitchEventSubClient({
    channelId: options.channelId ?? channel, oauth: options.oauth, expectedUserId: options.expectedUserId, include: options.topics, fetch, openSocket,
    onEvent: event => events.push(event), onStatus: state => states.push(state), now: () => 1690000000000,
  })
  clients.push(client)
  client.start()
  return { client, fetch, openSocket, sockets, events, states }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  clients.splice(0).forEach(client => client.stop())
  vi.useRealTimers()
})

describe('Twitch EventSub production entry with synthetic transport', () => {
  it('does no chat requests without OAuth, and needs user:read:chat for chat', async () => {
    const anonymous = setup()
    expect(anonymous.states).toEqual([{ state: 'unavailable', reason: 'oauth-required' }])
    expect(anonymous.fetch).not.toHaveBeenCalled()
    expect(anonymous.openSocket).not.toHaveBeenCalled()
    const unauthorized = setup({ oauth, scopes: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(unauthorized.states.at(-1)).toEqual({ state: 'unavailable', reason: 'scope-required' })
    expect(unauthorized.openSocket).not.toHaveBeenCalled()
    const expired = setup({ oauth, validationStatus: 401 })
    await vi.advanceTimersByTimeAsync(0)
    expect(expired.states.at(-1)).toEqual({ state: 'unavailable', reason: 'authorization-failed' })
    expect(expired.openSocket).not.toHaveBeenCalled()
    const wrongAccount = setup({ oauth, expectedUserId: origin })
    await vi.advanceTimersByTimeAsync(0)
    expect(wrongAccount.states.at(-1)).toEqual({ state: 'unavailable', reason: 'authorization-failed' })
    expect(wrongAccount.openSocket).not.toHaveBeenCalled()
  })

  it('subscribes read-only and preserves native parts, distinct delivery/source IDs and local delete mapping', async () => {
    const { fetch, events, states, sockets } = setup({ oauth })
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.welcome()
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toEqual({ state: 'connected' })
    const posts = fetch.mock.calls.slice(1)
    expect(posts).toHaveLength(5)
    expect(posts.every(([url]) => url === 'https://api.twitch.tv/helix/eventsub/subscriptions')).toBe(true)
    expect(JSON.parse(String(posts[0]?.[1].body))).toMatchObject({
      type: CHAT_TYPE, version: '1', condition: { broadcaster_user_id: channel, user_id: viewer },
      transport: { method: 'websocket', session_id: 'session-fixture' },
    })
    const first = notify('event-1', CHAT_TYPE, message)
    sockets[0]!.sendFrame(first)
    sockets[0]!.sendFrame(first)
    sockets[0]!.sendFrame(notify('event-2', CHAT_TYPE, { ...message, message_id: 'delivery-copy' }))
    sockets[0]!.sendFrame(notify('event-wrong', CHAT_TYPE, message, { broadcaster_user_id: origin, user_id: viewer }))
    sockets[0]!.sendFrame(notify('event-3', 'channel.chat.message_delete', { broadcaster_user_id: channel, message_id: 'delivery-copy' }))
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      kind: 'chat', id: `twitch:${origin}:origin-42`, room: `twitch:${channel}`, receivedAt: 1690000000000,
      message: { broadcasterId: channel, messageId: 'delivery-42' },
      source: { broadcasterId: origin, messageId: 'origin-42', login: 'fixture_origin' },
      sourceBadges: [{ setId: 'subscriber', id: '12', info: '18' }],
      reply: { parent: { broadcasterId: channel, messageId: 'parent-1' }, text: 'Hello!' },
      bits: 10, text: 'Hi Kappa Cheer10',
      fragments: [{ type: 'text' }, { type: 'emote', emote: { id: '25' } }, { type: 'text' }, { type: 'cheermote', cheermote: { bits: 10 } }],
    })
    expect(events[1]).toMatchObject({
      kind: 'delete', target: { broadcasterId: channel, messageId: 'delivery-copy' },
      source: { broadcasterId: origin, messageId: 'origin-42' },
    })
  })

  it('reports partial authorization and stops forwarding after revocation', async () => {
    const { events, states, sockets } = setup({ oauth, rejectedType: 'channel.chat.clear' })
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]!
    socket.welcome()
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toContainEqual({ state: 'subscription-failed', type: 'channel.chat.clear', status: 403 })
    expect(states.at(-1)).toEqual({ state: 'connected' })
    socket.sendFrame(notify('clear-1', 'channel.chat.clear', { broadcaster_user_id: channel }))
    socket.sendFrame(frame('revocation', { subscription: {
      type: CHAT_TYPE, version: '1', condition: { broadcaster_user_id: channel, user_id: viewer }, status: 'authorization_revoked',
    } }))
    socket.sendFrame(notify('chat-1', CHAT_TYPE, message))
    expect(states.at(-1)).toEqual({ state: 'unavailable', reason: 'authorization-failed' })
    expect(events).toEqual([])
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('handles shared chat lifecycle, inbound raid and standard versus gifted resub notices with viewer permissions', async () => {
    const { events, fetch, states, sockets } = setup({ oauth, topics: ['shared-chat', 'raid', 'subscriptions', 'redemptions'] })
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]!
    socket.welcome()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch.mock.calls.slice(1)).toHaveLength(9)
    expect(states).toContainEqual({ state: 'topic-unavailable', topic: {
      topic: 'subscriptions', reason: 'broadcaster-required', scope: 'channel:read:subscriptions',
    } })
    const notice = { ...message, system_message: 'Fixture notification' }
    socket.sendFrame(notify('resub', 'channel.chat.notification', { ...notice, source_message_id: 'resub-original',
      notice_type: 'shared_chat_resub', shared_chat_resub: { sub_tier: '1000', cumulative_months: 4, is_gift: true } }))
    socket.sendFrame(notify('gift', 'channel.chat.notification', { ...notice, message_id: 'gift-local', source_message_id: 'gift-original',
      notice_type: 'shared_chat_sub_gift', shared_chat_sub_gift: { sub_tier: '3000', duration_months: 1 } }))
    socket.sendFrame(notify('shared-start', 'channel.shared_chat.begin', {
      broadcaster_user_id: channel, session_id: 'shared-1', host_broadcaster_user_id: origin,
      participants: [{ broadcaster_user_id: channel }, { broadcaster_user_id: origin }],
    }))
    socket.sendFrame(notify('shared-end', 'channel.shared_chat.end', {
      broadcaster_user_id: channel, session_id: 'shared-1', host_broadcaster_user_id: origin,
    }))
    socket.sendFrame(notify('raid', 'channel.raid', { from_broadcaster_user_id: origin, to_broadcaster_user_id: channel, viewers: 88 },
      { to_broadcaster_user_id: channel }))
    expect(events).toMatchObject([
      { kind: 'notice', notice: { type: 'shared_chat_resub', months: 4, giftCount: null, isGift: true } },
      { kind: 'notice', notice: { type: 'shared_chat_sub_gift', months: 1, giftCount: 1 } },
      { kind: 'shared-chat', phase: 'begin', sessionId: 'shared-1', hostId: origin, participantIds: [channel, origin] },
      { kind: 'shared-chat', phase: 'end', sessionId: 'shared-1' },
      { kind: 'channel-event', type: 'raid', fromId: origin, toId: channel, viewers: 88 },
    ])
  })

  it('registers broadcaster events with matching scopes and keeps lifecycle data separately', async () => {
    const { events, fetch, states, sockets } = setup({
      oauth, userId: channel, scopes: ['channel:read:redemptions', 'channel:read:subscriptions', 'bits:read',
        'channel:manage:polls', 'channel:read:predictions'],
      topics: ['redemptions', 'subscriptions', 'cheer', 'polls', 'predictions'],
    })
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]!
    socket.welcome()
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toEqual({ state: 'connected' })
    expect(fetch.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init.body)))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'channel.channel_points_automatic_reward_redemption.add', version: '2' }),
      expect.objectContaining({ type: 'channel.prediction.lock', version: '1' }),
    ]))
    const broadcaster = { broadcaster_user_id: channel }
    socket.sendFrame(notify('cheer', 'channel.cheer', { ...broadcaster, is_anonymous: true, bits: 25 }))
    socket.sendFrame(notify('new-sub', 'channel.subscribe', { ...broadcaster, tier: '1000', user_id: viewer, is_gift: false }))
    socket.sendFrame(notify('resub', 'channel.subscription.message', { ...broadcaster, tier: '1000', user_id: viewer, cumulative_months: 6 }))
    socket.sendFrame(notify('gift', 'channel.subscription.gift', { ...broadcaster, tier: '3000', total: 10, is_anonymous: true }))
    socket.sendFrame(notify('redeem', 'channel.channel_points_custom_reward_redemption.update', {
      ...broadcaster, id: 'redemption-1', status: 'fulfilled', reward: { id: 'reward-1', title: 'Fixture', cost: 75 },
    }))
    socket.sendFrame(notify('poll-end', 'channel.poll.end', {
      ...broadcaster, id: 'poll-1', title: 'Fixture', status: 'completed', ended_at: '2026-11-19T07:00:00Z',
      choices: [{ id: 'option-1', title: 'Option', votes: 0 }],
    }))
    socket.sendFrame(notify('prediction-lock', 'channel.prediction.lock', {
      ...broadcaster, id: 'prediction-1', title: 'Fixture', locked_at: '2026-11-19T07:00:00Z',
      outcomes: [{ id: 'option-2', title: 'Option', users: 2, channel_points: 150 }],
    }))
    expect(events).toMatchObject([
      { kind: 'channel-event', type: 'cheer', bits: 25, userId: null },
      { type: 'sub', tier: '1000', userId: viewer },
      { type: 'resub', months: 6 },
      { type: 'gift-sub', giftCount: 10, userId: null },
      { type: 'redemption', phase: 'update', id: 'redemption-1', rewardId: 'reward-1', cost: 75, status: 'fulfilled' },
      { type: 'poll', phase: 'end', endsAt: Date.parse('2026-11-19T07:00:00Z'), status: 'completed',
        choices: [{ id: 'option-1', votes: 0, points: null }] },
      { type: 'prediction', phase: 'lock', locksAt: Date.parse('2026-11-19T07:00:00Z'), endsAt: null,
        choices: [{ id: 'option-2', users: 2, points: 150, votes: null }] },
    ])
  })

  it('migrates without resubscribing, recovers after disconnect, and never replays the old room after stop', async () => {
    const { client, events, fetch, openSocket, sockets } = setup({ oauth })
    await vi.advanceTimersByTimeAsync(0)
    const first = sockets[0]!
    first.welcome()
    await vi.advanceTimersByTimeAsync(0)
    first.sendFrame(notify('first', CHAT_TYPE, message))
    first.sendFrame(frame('session_reconnect', { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv.example.invalid/ws' } }))
    expect(openSocket).toHaveBeenCalledTimes(1)
    first.sendFrame(frame('session_reconnect', { session: { reconnect_url: RECONNECT_URL } }))
    expect(openSocket).toHaveBeenLastCalledWith(RECONNECT_URL)
    expect(first.close).not.toHaveBeenCalled()
    const second = sockets[1]!
    second.welcome('migrated')
    expect(first.close).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledTimes(6)
    second.sendFrame(notify('first', CHAT_TYPE, message))
    second.dispatchEvent(new Event('close'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(openSocket).toHaveBeenLastCalledWith(TWITCH_EVENTSUB_URL)
    const third = sockets[2]!
    third.welcome('new-session')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(12)
    client.stop()
    third.sendFrame(notify('old-room', CHAT_TYPE, { ...message, source_message_id: 'past-stop' }))
    const switched = setup({ oauth, channelId: origin })
    await vi.advanceTimersByTimeAsync(0)
    expect(switched.sockets).toHaveLength(1)
    switched.sockets[0]!.welcome()
    await vi.advanceTimersByTimeAsync(0)
    switched.sockets[0]!.sendFrame(notify('wrong-room', CHAT_TYPE, message))
    expect(switched.events).toEqual([])
    expect(events).toHaveLength(1)
    expect(third.close).toHaveBeenCalledOnce()
  })

  it('treats silence as a disconnect and aborts pending subscription requests on stop', async () => {
    const { client, fetch, openSocket, sockets } = setup({ oauth })
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.welcome()
    await vi.advanceTimersByTimeAsync(10_000)
    sockets[0]!.sendFrame(frame('session_keepalive', {}))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(openSocket).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(openSocket).toHaveBeenCalledTimes(2)
    sockets[1]!.welcome()
    const currentAttempt = fetch.mock.calls.at(-1)?.[1].signal
    expect(currentAttempt?.aborted).toBe(false)
    client.stop()
    expect(currentAttempt?.aborted).toBe(true)
  })

  it('revalidates a long-running connection and closes it when OAuth expires', async () => {
    const options = { oauth, validationStatus: 200 }
    const { states, sockets, fetch } = setup(options)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]!
    socket.welcome()
    const keepalive = setInterval(() => socket.sendFrame(frame('session_keepalive', {})), 10_000)
    options.validationStatus = 401
    try {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    } finally {
      clearInterval(keepalive)
    }
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/validate'))).toHaveLength(2)
    expect(states.at(-1)).toEqual({ state: 'unavailable', reason: 'authorization-failed' })
    expect(socket.close).toHaveBeenCalledOnce()
  })
})
