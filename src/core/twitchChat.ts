export type TwitchChatRoom = `twitch:${string}`

export type TwitchMessageRef = { broadcasterId: string; messageId: string }
export type TwitchChatFragment = {
  type: 'text' | 'emote' | 'cheermote' | 'mention'
  text: string
  emote?: { id: string; setId: string | null; ownerId: string | null; animated: boolean }
  cheermote?: { prefix: string; bits: number; tier: number | null }
  mentionUserId?: string
}
export type TwitchChatBadge = { setId: string; id: string; info: string }
export type TwitchBadgeAsset = { setId: string; id: string; title: string; imageUrl: string }
export type TwitchChatEvent = {
  kind: 'chat' | 'notice'
  id: string
  room: TwitchChatRoom
  receivedAt: number
  message: TwitchMessageRef
  source: TwitchMessageRef & { login: string | null; displayName: string | null }
  sourceOnly: boolean | null
  sender: { id: string | null; login: string | null; displayName: string | null; color: string | null }
  text: string
  fragments: TwitchChatFragment[]
  badges: TwitchChatBadge[]
  sourceBadges: TwitchChatBadge[] | null
  reply: { parent: TwitchMessageRef; thread: TwitchMessageRef | null; text: string } | null
  bits: number | null
  rewardId: string | null
  messageType: string | null
  notice: {
    type: string
    systemText: string
    tier: string | null
    months: number | null
    giftCount: number | null
    isGift: boolean | null
    viewers: number | null
  } | null
}

export type TwitchModerationEvent =
  | { kind: 'delete'; room: TwitchChatRoom; receivedAt: number; target: TwitchMessageRef; source: TwitchMessageRef }
  | { kind: 'clear-user'; room: TwitchChatRoom; receivedAt: number; userId: string }
  | { kind: 'clear'; room: TwitchChatRoom; receivedAt: number }

export type TwitchSharedChatEvent = {
  kind: 'shared-chat'; room: TwitchChatRoom; receivedAt: number; phase: 'begin' | 'update' | 'end'
  sessionId: string; hostId: string; participantIds: string[]
}

export type TwitchChannelEvent = {
  kind: 'channel-event'; room: TwitchChatRoom; receivedAt: number
} & (
  | { type: 'sub' | 'resub' | 'gift-sub'; sourceType: 'channel.subscribe' | 'channel.subscription.message' | 'channel.subscription.gift';
    userId: string | null; tier: string | null; months: number | null; giftCount: number | null }
  | { type: 'cheer'; userId: string | null; bits: number; text: string }
  | { type: 'raid'; fromId: string; toId: string; viewers: number | null }
  | { type: 'redemption'; id: string; userId: string | null; rewardId: string | null; rewardTitle: string | null;
    cost: number | null; status: string | null; text: string; phase: 'add' | 'update' }
  | { type: 'poll' | 'prediction'; id: string; title: string; phase: 'begin' | 'progress' | 'lock' | 'end';
    endsAt: number | null; locksAt: number | null; status: string | null; winningOutcomeId: string | null;
    choices: { id: string; title: string; votes: number | null; users: number | null; points: number | null }[] }
)

export type TwitchEvent = TwitchChatEvent | TwitchModerationEvent | TwitchSharedChatEvent | TwitchChannelEvent

export function twitchMessageKey(ref: TwitchMessageRef): string {
  return `twitch:${ref.broadcasterId}:${ref.messageId}`
}

export function isTwitchChatAssetUrl(url: string): boolean {
  return /^https:\/\/static-cdn\.jtvnw\.net\/(?:badges\/v1\/[\w-]{1,100}\/[123]|emoticons\/v2\/[\w-]{1,100}\/static\/dark\/1\.0)$/.test(url)
}

export function twitchEmoteUrl(fragment: TwitchChatFragment): string | null {
  const id = fragment.emote?.id
  return id && /^[\w-]{1,100}$/.test(id)
    ? `https://static-cdn.jtvnw.net/emoticons/v2/${id}/static/dark/1.0`
    : null
}
