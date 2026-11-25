/**
 * Turning the schedule into what the page lists: events, and within an event the matches
 * on now, next and earlier, each with the streams it can be watched on.
 *
 * Stages. A big event runs two matches at once on two broadcasts; nothing in the schedule
 * says which is the main one, but the stream titles usually do (`[A] …`, `[B] …`). When a
 * title gives none, two live matches of one event are told apart by their channels.
 */

import type { Cs2Match, Cs2Schedule, Cs2Stream, StreamTitle, StreamTitleInput } from '../../../electron/featureContracts'

export interface EventGroup {
  /** The event's own page without the stage anchor, stable across refreshes. */
  key: string
  name: string
  tier: Cs2Match['tournament']['tier']
  /** The event's icon, from the first of its matches that has one. */
  logo: string | null
  live: Cs2Match[]
  upcoming: Cs2Match[]
  finished: Cs2Match[]
}

const eventKey = (match: Cs2Match): string => match.tournament.url.split('#')[0] || match.tournament.name

/**
 * The event's Liquipedia path, for telling main which event is on screen. Only the path goes
 * across, never the address; a key from an event name or another site gives null.
 */
export function eventPath(group: Pick<EventGroup, 'key'> | undefined): string | null {
  if (!group) return null
  try {
    const url = new URL(group.key)
    return url.origin === 'https://liquipedia.net' && url.pathname.startsWith('/counterstrike/') && !url.search
      ? url.pathname : null
  } catch { return null }
}

/** Liquipedia's tiers in order of importance; Misc (-1) after C, unknown last. */
const TIER_RANK: Record<string, number> = { '1': 0, '2': 1, '3': 2, '4': 3, '-1': 4, null: 5 }
export const tierRank = (tier: Cs2Match['tournament']['tier']): number => TIER_RANK[String(tier)] ?? 5

export const TIER_LABEL: Record<string, string> = { '1': 'S', '2': 'A', '3': 'B', '4': 'C', '-1': '其他' }
export const tierLabel = (tier: Cs2Match['tournament']['tier']): string | null => TIER_LABEL[String(tier)] ?? null

/** Live events first (by tier, S first), then non-live events (by tier, S first), then by the earliest thing still to happen. */
export function groupEvents(schedule: Cs2Schedule | null): EventGroup[] {
  const groups = new Map<string, EventGroup>()
  for (const match of schedule?.matches ?? []) {
    const key = eventKey(match)
    let group = groups.get(key)
    if (!group) {
      group = { key, name: match.tournament.name, tier: match.tournament.tier, logo: null, live: [], upcoming: [], finished: [] }
      groups.set(key, group)
    }
    group.tier ??= match.tournament.tier
    group.logo ??= match.tournament.logo
    group[match.state].push(match)
  }
  const soonest = (group: EventGroup): number => (group.live[0] ?? group.upcoming[0] ?? group.finished.at(-1))?.startsAt ?? Infinity
  for (const group of groups.values()) {
    group.live.sort((a, b) => a.startsAt - b.startsAt)
    group.upcoming.sort((a, b) => a.startsAt - b.startsAt)
    group.finished.sort((a, b) => b.startsAt - a.startsAt)
  }
  return [...groups.values()].sort((a, b) =>
    Number(b.live.length > 0) - Number(a.live.length > 0)
    || tierRank(a.tier) - tierRank(b.tier)
    || soonest(a) - soonest(b))
}

/** A stream's identity within a match: its registry entry, which stays put while its channel is looked up. */
export const streamKey = (stream: Pick<Cs2Stream, 'platform' | 'entry' | 'videoId'>): string =>
  JSON.stringify([stream.platform, stream.entry.toLowerCase(), stream.videoId])

/**
 * What a stream's title is read by: the video on YouTube, the matched channel on Twitch. Null
 * while neither is known; a YouTube channel page carries no title worth a request.
 */
export function titleInput(stream: Cs2Stream): StreamTitleInput | null {
  if (stream.platform === 'youtube') return stream.videoId ? { platform: 'youtube', channel: stream.channel ?? stream.entry, videoId: stream.videoId } : null
  return stream.channel ? { platform: 'twitch', channel: stream.channel, videoId: null } : null
}

export const titleKey = (input: StreamTitleInput): string => JSON.stringify([input.platform, input.channel.toLowerCase(), input.videoId])

export function streamTitle(titles: ReadonlyMap<string, StreamTitle>, stream: Cs2Stream): StreamTitle | undefined {
  const input = titleInput(stream)
  return input ? titles.get(titleKey(input)) : undefined
}

/** The streams whose titles are worth reading for this event: on now first, then next. */
export function titleRequests(group: EventGroup | undefined, limit = 12): StreamTitleInput[] {
  if (!group) return []
  const seen = new Map<string, StreamTitleInput>()
  for (const match of [...group.live, ...group.upcoming.slice(0, 4)]) {
    for (const stream of match.streams) {
      const input = titleInput(stream)
      if (input && !seen.has(titleKey(input))) seen.set(titleKey(input), input)
    }
  }
  return [...seen.values()].slice(0, limit)
}

/** A stage label for display: `A` → `A 舞台`; anything longer is the organiser's own words. */
export function stageLabel(stage: string | null | undefined): string | null {
  if (!stage) return null
  return /^[A-Z]$/i.test(stage) ? `${stage.toUpperCase()} 舞台` : stage
}

/**
 * Which stage a match is on: the first title-derived stage among its streams, else, when the
 * event has more than one match on now, the channel that sets it apart.
 */
export function matchStage(match: Cs2Match, titles: ReadonlyMap<string, StreamTitle>, siblingsLive: number): { label: string; from: 'title' | 'channel' } | null {
  for (const stream of match.streams) {
    const label = stageLabel(streamTitle(titles, stream)?.stage)
    if (label) return { label, from: 'title' }
  }
  const first = match.streams[0]
  if (match.state === 'live' && siblingsLive > 1 && first) return { label: `频道 ${first.channel ?? first.entry}`, from: 'channel' }
  return null
}

export const PLATFORM_NAME: Record<Cs2Stream['platform'], string> = { youtube: 'YouTube', twitch: 'Twitch' }

/** Why a stream cannot be played yet, in the sheet's words. */
export const MISSING_TEXT: Record<NonNullable<Cs2Stream['missing']>, string> = {
  finding: '正在查找直播频道',
  unmatched: '未找到直播频道，可在添加直播间中粘贴链接',
  failed: '直播频道读取失败',
}

/** Streams in the order worth offering: YouTube first, since it carries the higher qualities here. */
export function orderedStreams(match: Cs2Match): Cs2Stream[] {
  const rank = { youtube: 0, twitch: 1 } as const
  return [...match.streams].sort((a, b) => rank[a.platform] - rank[b.platform])
}

export const SCHEDULE_STALE_MS = 15 * 60_000
export const SCHEDULE_OVERNIGHT_MS = 60 * 60_000
export const REFRESH_BACKOFF_MS = [500, 1_000, 3_000] as const
export const REFRESH_RESET_MS = 10_000
export const BEIJING_OFFSET_MINUTES = 480

/** Silent manual refresh throttle: 500ms -> 1s -> 3s on consecutive clicks, resetting after 10s idle. */
export function createRefreshThrottle() {
  let step = 0
  let cooldownUntil = -Infinity
  let lastClickAt = -Infinity
  return {
    tryAcquire(now: number): ((completedAt?: number) => void) | null {
      if (now - lastClickAt >= REFRESH_RESET_MS || now < lastClickAt) {
        step = 0
        cooldownUntil = -Infinity
      }
      lastClickAt = now
      if (now < cooldownUntil) return null
      const delay = REFRESH_BACKOFF_MS[Math.min(step, REFRESH_BACKOFF_MS.length - 1)]!
      step = Math.min(step + 1, REFRESH_BACKOFF_MS.length)
      cooldownUntil = now + delay
      return (completedAt = now) => {
        cooldownUntil = Math.max(cooldownUntil, completedAt + delay)
      }
    },
  }
}

export function isScheduleStale(schedule: Cs2Schedule | null, now: number): boolean {
  return !!schedule && (schedule.stale || (schedule.fetchedAt > 0 && (now - schedule.fetchedAt > SCHEDULE_STALE_MS || now < schedule.fetchedAt)))
}

export function isScheduleOvernight(schedule: Cs2Schedule | null, now: number): boolean {
  return !!schedule && schedule.fetchedAt > 0 && (now - schedule.fetchedAt > SCHEDULE_OVERNIGHT_MS || now < schedule.fetchedAt)
}

export function utcOffsetMinutes(at: number): number {
  const offset = -new Date(at).getTimezoneOffset()
  return Object.is(offset, -0) ? 0 : offset
}

export function formatUtcOffset(at: number): string {
  const total = utcOffsetMinutes(at)
  if (total === 0) return 'UTC+0'
  const sign = total > 0 ? '+' : '-'
  const abs = Math.abs(total)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  return minutes === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(minutes).padStart(2, '0')}`
}

export function isBeijingTimeZone(at: number): boolean {
  return utcOffsetMinutes(at) === BEIJING_OFFSET_MINUTES
}

function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatFullStart(at: number): string {
  const date = new Date(at)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${formatClock(date)}（${formatUtcOffset(at)}）`
}

export function formatStart(at: number, now: number): string {
  const date = new Date(at)
  const today = new Date(now)
  const time = formatClock(date)
  const startOfDay = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const startOfToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  const days = Math.round((startOfDay - startOfToday) / 86_400_000)
  if (days === 0) return time
  if (days === 1) return `明天 ${time}`
  if (days === -1) return `昨天 ${time}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}
