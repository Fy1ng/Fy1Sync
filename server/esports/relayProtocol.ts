import { validEntry, validTwitchLogin } from './parser'
import { channelFromLink } from './streamChannels'
import { LOGO_KEY } from './teamLogos'
import { normalizeTournamentPath } from './tiers'
import type { Cs2Match, Cs2Schedule, Cs2Stream, Cs2Team } from './types'

export const RELAY_MAX_MATCHES = 500
export const RELAY_MAX_STREAMS = 32
export const RELAY_MAX_TEXT_LENGTH = 500
export const RELAY_MAX_ID_LENGTH = 100
export const RELAY_MAX_ENTRY_LENGTH = 100
export const RELAY_MAX_CHANNEL_LENGTH = 108
export const RELAY_MAX_URL_LENGTH = 2_000
export const RELAY_MAX_SCORE = 99
export const RELAY_MAX_BEST_OF = 99
export const RELAY_SHA256 = /^[a-fA-F0-9]{64}$/
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_HANDLE = /^@[\p{L}\p{N}\p{M}_.\-\u00b7]{1,100}$/u
const YOUTUBE_NAME = /^[A-Za-z0-9_-]{3,100}$/
const YOUTUBE_PATH = /^(?:channel|c|user)\/[A-Za-z0-9_-]{1,100}$/
const ENCODED_HANDLE = /^@(?:[A-Za-z0-9_.-]|%[a-fA-F0-9]{2}){1,100}$/
const MAX_DATE = 8_640_000_000_000_000

export interface RelayLogo { key: string; sha256: string }
export interface RelayTeam extends Omit<Cs2Team, 'logo'> { logo: RelayLogo | null }
export type RelayStream = Pick<Cs2Stream, 'platform' | 'entry' | 'channel' | 'videoId' | 'missing'>
export interface RelayMatch extends Omit<Cs2Match, 'teams' | 'tournament' | 'streams'> {
  teams: [RelayTeam, RelayTeam]
  tournament: Omit<Cs2Match['tournament'], 'logo'> & { logo: RelayLogo | null }
  streams: RelayStream[]
}
export interface RelaySchedule {
  schema: 1
  fetchedAt: number
  generatedAt: number
  source: 'liquipedia'
  attribution: string
  upstream: { limitedUntil: number | null }
  matches: RelayMatch[]
}

const invalid = (): never => { throw new Error('Invalid relay schedule') }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
}
function text(value: unknown, limit = RELAY_MAX_TEXT_LENGTH): string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value) ? value : invalid()
}
function nullableText(value: unknown, limit = RELAY_MAX_TEXT_LENGTH): string | null {
  return value === null ? null : text(value, limit)
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER, minimum = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : invalid()
}
function enumeration<Value extends string | number | null>(value: unknown, allowed: readonly Value[]): Value {
  return allowed.includes(value as Value) ? value as Value : invalid()
}
function list(value: unknown, maximum: number, length?: number): unknown[] {
  return Array.isArray(value) && value.length <= maximum && (length === undefined || value.length === length)
    && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean) ? value : invalid()
}
function parseLogo(value: unknown): RelayLogo | null {
  if (value === null) return null
  const logo = record(value), key = text(logo.key, 64), sha256 = text(logo.sha256, 64)
  if (!LOGO_KEY.test(key) || !RELAY_SHA256.test(sha256)) return invalid()
  return { key, sha256: sha256.toLowerCase() }
}
function localLogo(value: string | null): RelayLogo | null {
  if (value === null) return null
  const match = /^app:\/\/app\/team-logo\/([a-z0-9]{1,64})\?v=([a-fA-F0-9]{64})$/.exec(value)
  return match ? parseLogo({ key: match[1], sha256: match[2] }) : invalid()
}
function youtubeChannel(channel: string): ReturnType<typeof channelFromLink> {
  let path = channel
  if (YOUTUBE_HANDLE.test(channel)) path = `@${encodeURIComponent(channel.slice(1))}`
  else if (ENCODED_HANDLE.test(channel)) {
    try { if (!YOUTUBE_HANDLE.test(decodeURIComponent(channel))) return null } catch { return null }
  } else if (!YOUTUBE_PATH.test(channel) && !YOUTUBE_NAME.test(channel)) return null
  return channelFromLink(`https://www.youtube.com/${path}`)
}
function wireChannel(stream: Cs2Stream): string | null {
  if (stream.platform !== 'youtube' || stream.channel === null || stream.videoId !== null || stream.url === null) return stream.channel
  const path = new URL(stream.url).pathname.slice(1, -'/live'.length)
  if (YOUTUBE_PATH.test(path) || youtubeChannel(stream.channel)?.url !== stream.url && ENCODED_HANDLE.test(path)) return path
  return stream.channel
}
function streamUrl(stream: RelayStream): string | null {
  if (stream.platform === 'youtube' && stream.videoId !== null) return `https://www.youtube.com/watch?v=${stream.videoId}`
  if (stream.channel === null) return null
  return stream.platform === 'twitch' ? `https://www.twitch.tv/${stream.channel}` : youtubeChannel(stream.channel)?.url ?? null
}
function parseStream(value: unknown): RelayStream {
  const stream = record(value)
  const platform = enumeration(stream.platform, ['youtube', 'twitch'] as const)
  const entry = text(stream.entry, RELAY_MAX_ENTRY_LENGTH)
  if (!validEntry(entry)) return invalid()
  const channel = nullableText(stream.channel, RELAY_MAX_CHANNEL_LENGTH)
  if (channel !== null && !(platform === 'twitch' ? validTwitchLogin(channel) : youtubeChannel(channel))) return invalid()
  const videoId = nullableText(stream.videoId, 11)
  if (videoId !== null && (platform !== 'youtube' || !VIDEO_ID.test(videoId))) return invalid()
  const missing = enumeration(stream.missing, ['finding', 'unmatched', 'failed', null] as const)
  const result = { platform, entry, channel, videoId, missing }
  if ((streamUrl(result) === null) !== (missing !== null)) return invalid()
  return result
}
function parseTeam(value: unknown): RelayTeam {
  const team = record(value)
  return { name: text(team.name), short: nullableText(team.short), logo: parseLogo(team.logo) }
}
function parseMatch(value: unknown): RelayMatch {
  const match = record(value), tournament = record(match.tournament)
  const teams = list(match.teams, 2, 2)
  const score = match.score === null ? null : list(match.score, 2, 2)
  const url = text(tournament.url, RELAY_MAX_URL_LENGTH)
  if (normalizeTournamentPath(url) === null) return invalid()
  return {
    id: text(match.id, RELAY_MAX_ID_LENGTH), startsAt: integer(match.startsAt, MAX_DATE),
    state: enumeration(match.state, ['live', 'upcoming', 'finished'] as const),
    teams: [parseTeam(teams[0]), parseTeam(teams[1])],
    score: score === null ? null : [integer(score[0], RELAY_MAX_SCORE), integer(score[1], RELAY_MAX_SCORE)],
    bestOf: match.bestOf === null ? null : integer(match.bestOf, RELAY_MAX_BEST_OF, 1),
    tournament: { name: text(tournament.name), stage: nullableText(tournament.stage),
      tier: enumeration(tournament.tier, [1, 2, 3, 4, -1, null] as const), url, logo: parseLogo(tournament.logo) },
    streams: list(match.streams, RELAY_MAX_STREAMS).map(parseStream),
  }
}

export function toRelaySchedule(schedule: Cs2Schedule, generatedAt: number, limitedUntil: number | null): {
  schedule: RelaySchedule; skipped: { matches: number; streams: number }
} {
  const relay = parseRelaySchedule({
    schema: 1, fetchedAt: schedule.fetchedAt, generatedAt, source: schedule.source, attribution: schedule.attribution,
    upstream: { limitedUntil }, matches: [],
  })
  const skipped = { matches: 0, streams: 0 }
  const ids = new Set<string>()
  for (const match of schedule.matches) {
    if (relay.matches.length >= RELAY_MAX_MATCHES) { skipped.matches++; continue }
    let result: RelayMatch
    try {
      result = parseMatch({
        id: match.id, startsAt: match.startsAt, state: match.state, score: match.score, bestOf: match.bestOf,
        teams: match.teams.map(team => ({ name: team.name, short: team.short, logo: localLogo(team.logo) })),
        tournament: { name: match.tournament.name, stage: match.tournament.stage, tier: match.tournament.tier,
          url: match.tournament.url, logo: localLogo(match.tournament.logo) }, streams: [],
      })
    } catch {
      skipped.matches++
      continue
    }
    if (ids.has(result.id)) { skipped.matches++; continue }
    ids.add(result.id)
    for (const stream of match.streams) {
      if (result.streams.length >= RELAY_MAX_STREAMS) { skipped.streams++; continue }
      try {
        result.streams.push(parseStream({ platform: stream.platform, entry: stream.entry, channel: wireChannel(stream),
          videoId: stream.videoId, missing: stream.missing }))
      } catch {
        skipped.streams++
        try {
          result.streams.push(parseStream({ platform: stream.platform, entry: stream.entry,
            channel: null, videoId: null, missing: 'unmatched' }))
        } catch {}
      }
    }
    relay.matches.push(result)
  }
  return { schedule: relay, skipped }
}

export function parseRelaySchedule(input: unknown): RelaySchedule {
  const schedule = record(input), upstream = record(schedule.upstream)
  if (schedule.schema !== 1 || schedule.source !== 'liquipedia') return invalid()
  const matches = list(schedule.matches, RELAY_MAX_MATCHES).map(parseMatch)
  if (new Set(matches.map(match => match.id)).size !== matches.length) return invalid()
  return {
    schema: 1, fetchedAt: integer(schedule.fetchedAt, MAX_DATE), generatedAt: integer(schedule.generatedAt, MAX_DATE), source: 'liquipedia',
    attribution: text(schedule.attribution),
    upstream: { limitedUntil: upstream.limitedUntil === null ? null : integer(upstream.limitedUntil, MAX_DATE) }, matches,
  }
}

export function fromRelaySchedule(wire: RelaySchedule, logoUrl: (logo: RelayLogo) => string | null = () => null): Cs2Schedule {
  const schedule = parseRelaySchedule(wire)
  const localUrl = (logo: RelayLogo | null) => logo === null ? null : logoUrl(logo)
  return {
    fetchedAt: schedule.fetchedAt, source: schedule.source, attribution: schedule.attribution, stale: false,
    matches: schedule.matches.map(match => ({
      id: match.id, startsAt: match.startsAt, state: match.state, score: match.score, bestOf: match.bestOf,
      teams: match.teams.map(team => ({ name: team.name, short: team.short, logo: localUrl(team.logo) })) as [Cs2Team, Cs2Team],
      tournament: { ...match.tournament, logo: localUrl(match.tournament.logo) },
      streams: match.streams.map(stream => ({ ...stream, url: streamUrl(stream),
        channel: stream.platform === 'youtube' && stream.channel ? youtubeChannel(stream.channel)?.name ?? null : stream.channel })),
    })),
  }
}
