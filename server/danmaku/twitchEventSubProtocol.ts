import {
  twitchMessageKey, type TwitchChatBadge, type TwitchChatEvent, type TwitchChatFragment, type TwitchChatRoom,
  type TwitchEvent, type TwitchMessageRef,
} from '../../src/core/twitchChat'
import { twitchRecord, twitchText, twitchUserId, type TwitchRecord, type TwitchUserGrant } from '../platforms/twitchHelix'

const CHAT_SUBSCRIPTIONS = [
  'channel.chat.message', 'channel.chat.notification', 'channel.chat.message_delete',
  'channel.chat.clear', 'channel.chat.clear_user_messages',
]
const SHARED_SUBSCRIPTIONS = ['channel.shared_chat.begin', 'channel.shared_chat.update', 'channel.shared_chat.end']
const REDEMPTION_PREFIX = 'channel.channel_points_custom_reward_redemption.'
const AUTOMATIC_REDEMPTION = 'channel.channel_points_automatic_reward_redemption.add'

export type TwitchSubscription = { type: string; version: string; condition: Record<string, string> }
export type TwitchChannelTopics = 'shared-chat' | 'raid' | 'subscriptions' | 'cheer' | 'redemptions' | 'polls' | 'predictions'
export type TwitchSubscriptionPlan = {
  subscriptions: TwitchSubscription[]
  unavailable: { topic: 'chat' | TwitchChannelTopics; reason: 'scope-required' | 'broadcaster-required'; scope: string }[]
}

export function twitchSubscriptionPlan(
  channelId: string, grant: TwitchUserGrant, include: readonly TwitchChannelTopics[] = [],
): TwitchSubscriptionPlan {
  const subscriptions: TwitchSubscription[] = []
  const unavailable: TwitchSubscriptionPlan['unavailable'] = []
  if (!twitchUserId(channelId) || !twitchUserId(grant.userId)) return { subscriptions, unavailable }
  const broadcaster = { broadcaster_user_id: channelId }
  const add = (type: string, condition: Record<string, string> = broadcaster, version = '1') => {
    subscriptions.push({ type, version, condition })
  }
  const chatCondition = { ...broadcaster, user_id: grant.userId }
  if (grant.scopes.includes('user:read:chat')) {
    CHAT_SUBSCRIPTIONS.forEach(type => add(type, chatCondition))
  } else {
    unavailable.push({ topic: 'chat', reason: 'scope-required', scope: 'user:read:chat' })
  }
  const broadcasterTopics = [
    { topic: 'subscriptions', scope: 'channel:read:subscriptions', types: ['channel.subscribe', 'channel.subscription.message', 'channel.subscription.gift'] },
    { topic: 'cheer', scope: 'bits:read', types: ['channel.cheer'] },
    { topic: 'redemptions', scope: 'channel:read:redemptions', manage: 'channel:manage:redemptions',
      types: ['add', 'update'].map(phase => `${REDEMPTION_PREFIX}${phase}`) },
    { topic: 'polls', scope: 'channel:read:polls', manage: 'channel:manage:polls',
      types: ['begin', 'progress', 'end'].map(phase => `channel.poll.${phase}`) },
    { topic: 'predictions', scope: 'channel:read:predictions', manage: 'channel:manage:predictions',
      types: ['begin', 'progress', 'lock', 'end'].map(phase => `channel.prediction.${phase}`) },
  ] as const
  if (include.includes('shared-chat')) SHARED_SUBSCRIPTIONS.forEach(type => add(type))
  if (include.includes('raid')) add('channel.raid', { to_broadcaster_user_id: channelId })
  for (const { topic, scope, types, ...options } of broadcasterTopics) {
    if (!include.includes(topic)) continue
    if (grant.userId !== channelId) {
      unavailable.push({ topic, scope, reason: 'broadcaster-required' })
    } else if (!grant.scopes.includes(scope) && !('manage' in options && grant.scopes.includes(options.manage))) {
      unavailable.push({ topic, scope, reason: 'scope-required' })
    } else {
      types.forEach(type => add(type))
      if (topic === 'redemptions') add(AUTOMATIC_REDEMPTION, broadcaster, '2')
    }
  }
  return { subscriptions, unavailable }
}

function nullableText(value: unknown): string | null {
  return twitchText(value) || null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function timestamp(value: unknown): number | null {
  const ms = Date.parse(twitchText(value))
  return Number.isFinite(ms) ? ms : null
}

function ref(broadcasterId: string, value: unknown): TwitchMessageRef | null {
  const messageId = twitchText(value)
  return messageId && /^[\w-]{1,128}$/.test(messageId) ? { broadcasterId, messageId } : null
}

function badges(value: unknown): TwitchChatBadge[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => {
    const badge = twitchRecord(entry)
    const setId = twitchText(badge.set_id)
    const id = twitchText(badge.id)
    return setId && id ? [{ setId, id, info: twitchText(badge.info) }] : []
  })
}

function fragment(value: unknown): TwitchChatFragment {
  const part = twitchRecord(value)
  const text = twitchText(part.text)
  const emote = twitchRecord(part.emote)
  const cheer = twitchRecord(part.cheermote)
  const mentionUserId = twitchUserId(twitchRecord(part.mention).user_id)
  const id = twitchText(emote.id)
  if (part.type === 'emote' && id) {
    return { type: 'emote', text, emote: { id, setId: nullableText(emote.emote_set_id), ownerId: twitchUserId(emote.owner_id),
      animated: Array.isArray(emote.format) && emote.format.includes('animated') } }
  }
  const bits = count(cheer.bits)
  if (part.type === 'cheermote' && bits !== null) {
    return { type: 'cheermote', text, cheermote: { prefix: twitchText(cheer.prefix), bits, tier: count(cheer.tier) } }
  }
  return part.type === 'mention' && mentionUserId ? { type: 'mention', text, mentionUserId } : { type: 'text', text }
}

function parseChat(type: string, event: TwitchRecord, channelId: string, receivedAt: number): TwitchChatEvent | null {
  const message = ref(channelId, event.message_id)
  if (!message) return null
  const sharedId = twitchUserId(event.source_broadcaster_user_id)
  const source = sharedId ? ref(sharedId, event.source_message_id) : message
  if (!source) return null
  const body = twitchRecord(event.message)
  const text = twitchText(body.text)
  const parts = Array.isArray(body.fragments) ? body.fragments.map(fragment) : []
  const reply = twitchRecord(event.reply)
  const parent = ref(channelId, reply.parent_message_id)
  const noticeType = twitchText(event.notice_type)
  const noticeDetails = twitchRecord(Object.hasOwn(event, noticeType) ? event[noticeType] : undefined)
  const color = twitchText(event.color)
  return {
    kind: type === 'channel.chat.message' ? 'chat' : 'notice',
    id: twitchMessageKey(source), room: `twitch:${channelId}`, receivedAt, message,
    source: { ...source, login: nullableText(sharedId ? event.source_broadcaster_user_login : event.broadcaster_user_login),
      displayName: nullableText(sharedId ? event.source_broadcaster_user_name : event.broadcaster_user_name) },
    sourceOnly: typeof event.is_source_only === 'boolean' ? event.is_source_only : null,
    sender: { id: event.chatter_is_anonymous === true ? null : twitchUserId(event.chatter_user_id),
      login: event.chatter_is_anonymous === true ? null : nullableText(event.chatter_user_login),
      displayName: event.chatter_is_anonymous === true ? null : nullableText(event.chatter_user_name),
      color: /^#[A-Fa-f0-9]{6}$/.test(color) ? color : null },
    text, fragments: parts.map(part => part.text).join('') === text && parts.length > 0 ? parts : [{ type: 'text', text }],
    badges: badges(event.badges), sourceBadges: Array.isArray(event.source_badges) ? badges(event.source_badges) : null,
    reply: parent ? { parent, thread: ref(channelId, reply.thread_message_id), text: twitchText(reply.parent_message_body) } : null,
    bits: count(twitchRecord(event.cheer).bits),
    rewardId: nullableText(event.channel_points_custom_reward_id),
    messageType: nullableText(event.message_type),
    notice: noticeType ? {
      type: noticeType, systemText: twitchText(event.system_message), tier: nullableText(noticeDetails.sub_tier),
      months: count(noticeDetails.cumulative_months ?? noticeDetails.duration_months),
      giftCount: count(noticeDetails.total) ?? (noticeType.endsWith('sub_gift') && !noticeType.endsWith('community_sub_gift') ? 1 : null),
      isGift: typeof noticeDetails.is_gift === 'boolean' ? noticeDetails.is_gift : null,
      viewers: count(noticeDetails.viewer_count),
    } : null,
  }
}

function parseActivity(type: string, event: TwitchRecord, room: TwitchChatRoom, receivedAt: number): TwitchEvent | null {
  const id = twitchText(event.id)
  const base = { kind: 'channel-event' as const, room, receivedAt }
  const topic = type.startsWith('channel.poll.') ? 'poll' : type.startsWith('channel.prediction.') ? 'prediction' : null
  const phase = type.split('.').at(-1)
  if (topic && id && (phase === 'begin' || phase === 'progress' || phase === 'lock' || phase === 'end')) {
    const options = topic === 'poll' ? event.choices : event.outcomes
    return { ...base, type: topic, id, phase, title: twitchText(event.title), status: nullableText(event.status),
      endsAt: timestamp(event.ended_at ?? event.ends_at), locksAt: timestamp(event.locked_at ?? event.locks_at),
      winningOutcomeId: nullableText(event.winning_outcome_id),
      choices: Array.isArray(options) ? options.flatMap(option => {
        const choice = twitchRecord(option)
        const id = twitchText(choice.id)
        return id ? [{ id, title: twitchText(choice.title), votes: count(choice.votes),
          users: count(choice.users), points: count(choice.channel_points) }] : []
      }) : [] }
  }
  if (id && (type === AUTOMATIC_REDEMPTION || type.startsWith(REDEMPTION_PREFIX)) && (phase === 'add' || phase === 'update')) {
    const reward = twitchRecord(event.reward)
    return { ...base, type: 'redemption', id, phase, userId: twitchUserId(event.user_id), rewardId: nullableText(reward.id),
      rewardTitle: nullableText(reward.title) ?? nullableText(reward.type), cost: count(reward.cost ?? reward.channel_points),
      status: nullableText(event.status), text: twitchText(event.user_input ?? twitchRecord(event.message).text) }
  }
  return null
}

export function parseTwitchEvent(
  type: string, value: unknown, channelId: string, receivedAt: number,
): TwitchEvent | null {
  const event = twitchRecord(value)
  const room = `twitch:${channelId}` as const
  if (type === 'channel.raid') {
    const fromId = twitchUserId(event.from_broadcaster_user_id)
    const toId = twitchUserId(event.to_broadcaster_user_id)
    return fromId && toId === channelId
      ? { kind: 'channel-event', type: 'raid', room, receivedAt, fromId, toId, viewers: count(event.viewers) } : null
  }
  if (event.broadcaster_user_id !== channelId) return null
  const base = { room, receivedAt }
  switch (type) {
    case 'channel.chat.message':
    case 'channel.chat.notification':
      return parseChat(type, event, channelId, receivedAt)
    case 'channel.chat.message_delete': {
      const target = ref(channelId, event.message_id)
      return target ? { ...base, kind: 'delete', target, source: target } : null
    }
    case 'channel.chat.clear_user_messages': {
      const userId = twitchUserId(event.target_user_id)
      return userId ? { ...base, kind: 'clear-user', userId } : null
    }
    case 'channel.chat.clear':
      return { ...base, kind: 'clear' }
    case 'channel.shared_chat.begin':
    case 'channel.shared_chat.update':
    case 'channel.shared_chat.end': {
      const phase = type === 'channel.shared_chat.begin' ? 'begin' : type === 'channel.shared_chat.update' ? 'update' : 'end'
      const sessionId = twitchText(event.session_id)
      const hostId = twitchUserId(event.host_broadcaster_user_id)
      const participants: unknown[] = Array.isArray(event.participants) ? event.participants : []
      const participantIds = participants.flatMap(value => {
        const id = twitchUserId(twitchRecord(value).broadcaster_user_id)
        return id ? [id] : []
      })
      return sessionId && hostId ? { ...base, kind: 'shared-chat', phase, sessionId, hostId, participantIds } : null
    }
    case 'channel.cheer': {
      const bits = count(event.bits)
      return bits !== null ? { ...base, kind: 'channel-event', type: 'cheer', bits,
        userId: event.is_anonymous === true ? null : twitchUserId(event.user_id), text: twitchText(event.message) } : null
    }
    case 'channel.subscribe':
    case 'channel.subscription.message':
    case 'channel.subscription.gift':
      return { ...base, kind: 'channel-event', type: type === 'channel.subscription.message' ? 'resub'
        : type === 'channel.subscription.gift' || event.is_gift === true ? 'gift-sub' : 'sub', sourceType: type,
      userId: event.is_anonymous === true ? null : twitchUserId(event.user_id), tier: nullableText(event.tier),
      months: count(event.cumulative_months), giftCount: count(event.total) ?? (event.is_gift === true ? 1 : null) }
    default:
      return parseActivity(type, event, room, receivedAt)
  }
}
