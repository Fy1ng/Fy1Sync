export type YouTubeVideoTarget = Readonly<{ videoId: string; channelId?: string }>
export type YouTubeChatIdentity = Readonly<{ videoId: string; channelId: string; liveChatId: string }>

export function youtubeRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function youtubeOpaqueId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\x21-\x7e]{1,2048}$/.test(value) ? value : undefined
}

export function youtubeChannelId(value: unknown): string | undefined {
  return typeof value === 'string' && /^UC[\w-]{22}$/.test(value) ? value : undefined
}

export function youtubeVideoId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\w-]{11}$/.test(value) ? value : undefined
}

type YouTubeAuthor = {
  channelId?: string
  name?: string
  owner?: boolean
  moderator?: boolean
  member?: boolean
  verified?: boolean
}

type PaidMessage = { amountMicros?: string; currency?: string; amountDisplay?: string; tier?: number }
type PollContent = {
  kind: 'poll'
  status: 'active' | 'closed' | 'unknown'
  question?: string
  options: { text: string; tally?: string }[]
}

export type YouTubeChatContent =
  | { kind: 'text' }
  | (PaidMessage & { kind: 'super-chat' | 'fan-funding'; comment?: string })
  | (PaidMessage & { kind: 'super-sticker'; stickerId?: string; altText?: string; language?: string })
  | { kind: 'membership'; level?: string; upgrade?: boolean }
  | { kind: 'membership-milestone'; level?: string; months?: number; comment?: string }
  | { kind: 'membership-gift'; count?: number; level?: string }
  | { kind: 'membership-received'; level?: string; gifterChannelId?: string; giftMessageId?: string }
  | { kind: 'gift'; name?: string; jewels?: number; comboCount?: number; altText?: string; language?: string }
  | PollContent
  | { kind: 'members-only'; enabled: boolean }
  | { kind: 'user-banned'; channelId?: string; banType?: 'permanent' | 'temporary'; durationSeconds?: string }

export type YouTubeChatMessage = {
  id: string
  publishedAt: number
  receivedAt: number
  author: YouTubeAuthor
  text?: string
  content: YouTubeChatContent
}

type ChatChange =
  | { type: 'upsert'; message: YouTubeChatMessage }
  | { type: 'remove'; id: string; eventId: string; reason: 'deleted' | 'retracted' | 'tombstone'; publishedAt: number; receivedAt: number }
  | { type: 'ended'; eventId?: string; publishedAt: number; receivedAt: number }

export type YouTubeChatEvent = { identity: YouTubeChatIdentity } & ChatChange

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function unsigned(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return value
  return count(value)?.toString()
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function youtubeTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function paid(details: Record<string, unknown>): PaidMessage {
  return {
    amountMicros: unsigned(details.amountMicros), currency: text(details.currency),
    amountDisplay: text(details.amountDisplayString), tier: count(details.tier),
  }
}

function poll(details: Record<string, unknown>): PollContent {
  const metadata = youtubeRecord(details.metadata)
  const options = Array.isArray(metadata.options) ? metadata.options.flatMap(raw => {
    const option = youtubeRecord(raw)
    const label = text(option.optionText)
    return label ? [{ text: label, tally: unsigned(option.tally) }] : []
  }) : []
  return {
    kind: 'poll', status: details.status === 'active' || details.status === 'closed' ? details.status : 'unknown',
    question: text(metadata.questionText), options,
  }
}

function contentFor(snippet: Record<string, unknown>): { content: YouTubeChatContent; fallback?: string } | undefined {
  switch (snippet.type) {
    case 'textMessageEvent':
      return { content: { kind: 'text' }, fallback: text(youtubeRecord(snippet.textMessageDetails).messageText) }
    case 'superChatEvent':
    case 'fanFundingEvent': {
      const superChat = snippet.type === 'superChatEvent'
      const details = youtubeRecord(superChat ? snippet.superChatDetails : snippet.fanFundingEventDetails)
      const comment = text(details.userComment)
      return { content: { kind: superChat ? 'super-chat' : 'fan-funding', ...paid(details), comment }, fallback: comment }
    }
    case 'superStickerEvent': {
      const details = youtubeRecord(snippet.superStickerDetails)
      const meta = youtubeRecord(details.superStickerMetadata)
      const altText = text(meta.altText)
      return {
        content: { kind: 'super-sticker', ...paid(details), stickerId: youtubeOpaqueId(meta.stickerId), altText, language: text(meta.language) },
        fallback: altText,
      }
    }
    case 'newSponsorEvent': {
      const details = youtubeRecord(snippet.newSponsorDetails)
      return { content: { kind: 'membership', level: text(details.memberLevelName), upgrade: flag(details.isUpgrade) } }
    }
    case 'memberMilestoneChatEvent': {
      const details = youtubeRecord(snippet.memberMilestoneChatDetails)
      const comment = text(details.userComment)
      return {
        content: { kind: 'membership-milestone', level: text(details.memberLevelName), months: count(details.memberMonth), comment },
        fallback: comment,
      }
    }
    case 'membershipGiftingEvent': {
      const details = youtubeRecord(snippet.membershipGiftingDetails)
      return { content: { kind: 'membership-gift', count: count(details.giftMembershipsCount), level: text(details.giftMembershipsLevelName) } }
    }
    case 'giftMembershipReceivedEvent': {
      const details = youtubeRecord(snippet.giftMembershipReceivedDetails)
      return { content: {
        kind: 'membership-received', level: text(details.memberLevelName),
        gifterChannelId: youtubeChannelId(details.gifterChannelId),
        giftMessageId: youtubeOpaqueId(details.associatedMembershipGiftingMessageId),
      } }
    }
    case 'giftEvent': {
      const details = youtubeRecord(snippet.giftDetails)
      const name = text(details.giftName), altText = text(details.altText)
      return {
        content: {
          kind: 'gift', name, jewels: count(details.jewelsAmount), comboCount: count(details.comboCount),
          altText, language: text(details.language),
        },
        fallback: altText ?? name,
      }
    }
    case 'pollEvent': {
      const content = poll(youtubeRecord(snippet.pollDetails))
      return { content, fallback: content.question }
    }
    case 'sponsorOnlyModeStartedEvent':
    case 'sponsorOnlyModeEndedEvent':
      return { content: { kind: 'members-only', enabled: snippet.type === 'sponsorOnlyModeStartedEvent' } }
    case 'userBannedEvent': {
      const details = youtubeRecord(snippet.userBannedDetails)
      return { content: {
        kind: 'user-banned', channelId: youtubeChannelId(youtubeRecord(details.bannedUserDetails).channelId),
        banType: details.banType === 'permanent' || details.banType === 'temporary' ? details.banType : undefined,
        durationSeconds: unsigned(details.banDurationSeconds),
      } }
    }
    default:
      return undefined
  }
}

function parseChange(raw: unknown, identity: YouTubeChatIdentity, receivedAt: number): ChatChange | undefined {
  const resource = youtubeRecord(raw)
  const id = youtubeOpaqueId(resource.id)
  const snippet = youtubeRecord(resource.snippet)
  const publishedAt = youtubeTimestamp(snippet.publishedAt)
  if (!id || snippet.liveChatId !== identity.liveChatId || publishedAt === undefined) return undefined
  switch (snippet.type) {
    case 'chatEndedEvent':
      return { type: 'ended', eventId: id, publishedAt, receivedAt }
    case 'tombstone':
      return { type: 'remove', id, eventId: id, reason: 'tombstone', publishedAt, receivedAt }
    case 'messageDeletedEvent':
    case 'messageRetractedEvent': {
      const deleted = snippet.type === 'messageDeletedEvent'
      const target = youtubeOpaqueId(deleted
        ? youtubeRecord(snippet.messageDeletedDetails).deletedMessageId
        : youtubeRecord(snippet.messageRetractedDetails).retractedMessageId)
      return target ? { type: 'remove', id: target, eventId: id, reason: deleted ? 'deleted' : 'retracted', publishedAt, receivedAt } : undefined
    }
  }
  const parsed = contentFor(snippet)
  if (!parsed) return undefined
  const author = youtubeRecord(resource.authorDetails)
  return { type: 'upsert', message: {
    id, publishedAt, receivedAt, content: parsed.content,
    text: parsed.content.kind === 'text'
      ? parsed.fallback ?? text(snippet.displayMessage)
      : text(snippet.displayMessage) ?? parsed.fallback,
    author: {
      channelId: youtubeChannelId(author.channelId) ?? youtubeChannelId(snippet.authorChannelId),
      name: text(author.displayName), owner: flag(author.isChatOwner), moderator: flag(author.isChatModerator),
      member: flag(author.isChatSponsor), verified: flag(author.isVerified),
    },
  } }
}

type SeenMessage = {
  kind: YouTubeChatContent['kind']
  publishedAt: number
  combo?: number
  pollStatus?: PollContent['status']
  pollSnapshots?: Set<string>
}

export class YouTubeChatReplay {
  private readonly seen = new Map<string, SeenMessage | 'removed'>()
  private ended = false

  constructor(private readonly identity: YouTubeChatIdentity, private readonly broadcastStartedAt?: number) {}

  applyPage(payload: unknown, receivedAt: number): YouTubeChatEvent[] {
    if (this.ended) return []
    const page = youtubeRecord(payload)
    const items: unknown[] = Array.isArray(page.items) ? page.items : []
    const changes = items.map(item => parseChange(item, this.identity, receivedAt))
      .filter(change => change !== undefined)
    const activePoll = parseChange(page.activePollItem, this.identity, receivedAt)
    if (activePoll?.type === 'upsert' && activePoll.message.content.kind === 'poll') changes.push(activePoll)

    const events: YouTubeChatEvent[] = []
    let end: Extract<ChatChange, { type: 'ended' }> | undefined
    for (const change of changes) {
      const publishedAt = change.type === 'upsert' ? change.message.publishedAt : change.publishedAt
      if (this.broadcastStartedAt !== undefined && publishedAt < this.broadcastStartedAt) continue
      if (change.type === 'ended') {
        end ??= change
      } else if (change.type === 'remove') {
        if (this.seen.get(change.id) === 'removed') continue
        this.seen.set(change.id, 'removed')
        events.push({ ...change, identity: this.identity })
      } else if (this.accept(change.message)) {
        events.push({ ...change, identity: this.identity })
      }
    }
    const offlineAt = youtubeTimestamp(page.offlineAt)
    if (end) {
      this.ended = true
      events.push({ ...end, identity: this.identity })
    } else if (offlineAt !== undefined && (this.broadcastStartedAt === undefined || offlineAt >= this.broadcastStartedAt)) {
      this.ended = true
      events.push({ type: 'ended', publishedAt: offlineAt, receivedAt, identity: this.identity })
    }
    return events
  }

  private accept(message: YouTubeChatMessage): boolean {
    const previous = this.seen.get(message.id)
    const content = message.content
    const combo = content.kind === 'gift' ? content.comboCount : undefined
    const pollStatus = content.kind === 'poll' ? content.status : undefined
    const pollSnapshot = content.kind === 'poll' ? JSON.stringify(content) : undefined
    if (previous === 'removed') return false
    let pollSnapshots = previous?.pollSnapshots
    if (previous) {
      if (previous.kind !== content.kind || message.publishedAt < previous.publishedAt) return false
      if (content.kind === 'gift') {
        if (combo === undefined || (previous.combo !== undefined && combo <= previous.combo)) return false
      } else if (pollSnapshot !== undefined) {
        if (pollSnapshots?.has(pollSnapshot) || (previous.pollStatus === 'closed' && pollStatus !== 'closed')
          || (previous.pollStatus === 'active' && pollStatus === 'unknown')) return false
      } else {
        return false
      }
    }
    if (pollSnapshot !== undefined) {
      pollSnapshots ??= new Set()
      pollSnapshots.add(pollSnapshot)
    }
    this.seen.set(message.id, { kind: content.kind, publishedAt: message.publishedAt, combo, pollStatus, pollSnapshots })
    return true
  }
}
