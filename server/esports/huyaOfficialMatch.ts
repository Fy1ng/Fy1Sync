import { metadataUserAgent } from '../appIdentity'
import type { ProxyConfig } from '../config'
import { FeatureApiError } from '../featureApiError'
import { directNetwork } from '../networkPolicy'
import { parseHuyaLiveSummary, type HuyaLiveSummary } from '../platforms/huya'
import { parseTwitchChannel } from '../platforms/twitch'
import { parseYouTubeUrl } from '../platforms/youtube'
import { PinnedDispatcherPool, safeFetch, type Resolver } from '../safeFetch'
import { DispatchTurns, LiquipediaRateLimit } from './liquipediaRateLimit'
import { liquipediaConfig, object, readBody, readJson } from './metadataIo'
import { channelLinksUrl, eventHuyaRooms } from './streamChannels'
import { normalizeTournamentPath } from './tiers'
import type { Cs2Match, Cs2Schedule, Cs2Team, HuyaOfficialLookupInput, HuyaOfficialMatch } from './types'

const LINKS_TTL_MS = 24 * 60 * 60_000
const LINKS_RETRY_MS = 5 * 60_000
const ROOM_TTL_MS = 45_000
const LIVE_LIST_TTL_MS = 60_000
const MAX_HUYA_PAGE_BYTES = 2 * 1_048_576
const MAX_CANDIDATE_ROOMS = 6
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const HUYA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const HUYA_CS2_LIST_URL = 'https://www.huya.com/cache.php?m=LiveList&do=getLiveListByPage&gameId=862&tagAll=0&page=1'
const OFFICIAL_NICK_RE = /完美世界电竞|ESL|BLAST|PGL|IEM|虎牙官方|赛事主舞台|赛事副舞台|官方直播|频道[一二三123]/i
const SECONDARY_MARKER_RE = /(?:[_ -][2b]|stream\s*b|stage\s*b|副舞台|二台|频道二)/i
const PRIMARY_NICK_RE = /(?:频道一|主舞台|1台|一台)/i
const SECONDARY_NICK_RE = /(?:频道二|副舞台|2台|二台)/i

const ENTRY_ALIASES = new Map([
  ['eslcounterstrike', 'eslcs'],
  ['eslcounterstrikeb', 'eslcsb'],
])

const huyaPolicy: ProxyConfig = {
  enabled: true,
  hosts: ['www.huya.com', 'huya.com', 'm.huya.com'],
  allowNonStandardPorts: false,
  maxRedirects: 2,
  requestTimeoutMs: 10_000,
}

const plain = (value: string): string => value.replace(/^@/, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

export function huyaOfficialLookupArguments(raw: unknown): HuyaOfficialLookupInput {
  if (!object(raw)) throw new FeatureApiError('invalid-arguments')
  const keys = Object.keys(raw)
  if (keys.some(key => key !== 'platform' && key !== 'input' && key !== 'channel')) {
    throw new FeatureApiError('invalid-arguments')
  }
  const { platform, input, channel } = raw as Record<string, unknown>
  if ((platform !== 'youtube' && platform !== 'twitch')
    || typeof input !== 'string' || !input.trim() || input.length > 2_048 || /[\x00-\x1f\x7f]/.test(input)
    || (channel !== undefined && (typeof channel !== 'string' || channel.length > 256 || /[\x00-\x1f\x7f]/.test(channel)))) {
    throw new FeatureApiError('invalid-arguments')
  }
  const trimmedChannel = typeof channel === 'string' ? channel.trim() : ''
  return { platform, input: input.trim(), ...(trimmedChannel ? { channel: trimmedChannel } : {}) }
}

function extractStreamQuery(lookup: HuyaOfficialLookupInput): { videoId: string | null; channelKey: string | null } {
  if (lookup.platform === 'twitch') {
    const login = (lookup.channel && parseTwitchChannel(lookup.channel)) ?? parseTwitchChannel(lookup.input)
    return { videoId: null, channelKey: login ? plain(login) : lookup.channel ? plain(lookup.channel) : null }
  }
  let videoId: string | null = lookup.channel && VIDEO_ID.test(lookup.channel) ? lookup.channel : null
  let channelKey: string | null = lookup.channel && !VIDEO_ID.test(lookup.channel) ? plain(lookup.channel) : null
  const normalized = parseYouTubeUrl(lookup.input)
  if (normalized) {
    const parsed = new URL(normalized)
    const v = parsed.searchParams.get('v')
    if (v && VIDEO_ID.test(v)) videoId ??= v
    else if (parsed.pathname.endsWith('/live')) {
      const segment = decodeURIComponent(parsed.pathname.split('/').at(-2) ?? '')
      if (segment) channelKey ??= plain(segment)
    }
  }
  return { videoId, channelKey }
}

function teamTokens(team: Cs2Team): string[] {
  const raw = [team.short, team.name].filter((item): item is string => Boolean(item && item.trim() && item !== 'TBD'))
  const tokens = new Set<string>()
  for (const item of raw) {
    const cleaned = item.trim().toLowerCase()
    const compact = plain(cleaned)
    if (compact.length >= 2) tokens.add(compact)
    const stripped = plain(cleaned.replace(/\b(?:team|esports|gaming|clan|club|cs2|cs)\b/gi, ''))
    if (stripped.length >= 2) tokens.add(stripped)
    // Common broadcast shorthand such as "BC.Game" -> "bc.g" / "bcg".
    const dotPrefix = /^([a-z0-9]{2,6})\.([a-z])/i.exec(cleaned)
    if (dotPrefix) tokens.add(`${dotPrefix[1]!.toLowerCase()}${dotPrefix[2]!.toLowerCase()}`)
  }
  return [...tokens]
}

export function titleMatchesTeam(title: string, team: Cs2Team): boolean {
  const lower = title.toLowerCase()
  const compactTitle = plain(title)
  for (const token of teamTokens(team)) {
    if (token.length <= 3 && /^[a-z0-9]+$/.test(token)) {
      const boundary = new RegExp(`(?:^|[^a-z0-9])${token.split('').join('\\.?')}(?:$|[^a-z0-9])`, 'i')
      if (boundary.test(lower)) return true
    } else if (compactTitle.includes(token)) {
      return true
    }
  }
  return false
}

interface MatchedScheduleEntry {
  match: Cs2Match
  secondary: boolean
  siblings: Cs2Match[]
}

export function findMatchingCs2Match(schedule: Cs2Schedule, lookup: HuyaOfficialLookupInput, now: number): MatchedScheduleEntry | null {
  const { videoId, channelKey } = extractStreamQuery(lookup)
  if (!videoId && !channelKey) return null
  const candidates = schedule.matches.filter(match =>
    match.state === 'live' || (match.state === 'upcoming' && match.startsAt >= now - 90 * 60_000 && match.startsAt <= now + 30 * 60_000))
  for (const match of candidates) {
    for (const stream of match.streams) {
      if (stream.platform !== lookup.platform) continue
      if (videoId && stream.videoId === videoId) {
        return buildMatchedEntry(schedule.matches, match, `${stream.entry} ${stream.channel ?? ''}`)
      }
      if (channelKey) {
        const entryKey = plain(stream.entry)
        const aliasKey = ENTRY_ALIASES.get(entryKey)
        const streamChannelKey = stream.channel ? plain(stream.channel) : null
        if (streamChannelKey === channelKey || entryKey === channelKey || aliasKey === channelKey) {
          return buildMatchedEntry(schedule.matches, match, `${stream.entry} ${stream.channel ?? ''}`)
        }
      }
    }
  }
  if (channelKey && channelKey.length >= 3) {
    for (const match of candidates) {
      for (const stream of match.streams) {
        if (stream.platform !== lookup.platform) continue
        const streamChannelKey = stream.channel ? plain(stream.channel) : null
        if (streamChannelKey && streamChannelKey.includes(channelKey)) {
          return buildMatchedEntry(schedule.matches, match, `${stream.entry} ${stream.channel ?? ''}`)
        }
      }
    }
  }
  return null
}

function buildMatchedEntry(allMatches: Cs2Match[], match: Cs2Match, streamLabel: string): MatchedScheduleEntry {
  const eventBase = match.tournament.url.split('#')[0] || match.tournament.name
  const siblings = allMatches.filter(other => other.state === 'live' && (other.tournament.url.split('#')[0] || other.tournament.name) === eventBase)
  const secondary = SECONDARY_MARKER_RE.test(streamLabel) || (siblings.length > 1 && siblings.findIndex(item => item.id === match.id) === 1)
  return { match, secondary, siblings }
}

export function selectBestHuyaRoom(
  rooms: HuyaLiveSummary[],
  matched: MatchedScheduleEntry | null,
  fromTournamentLinks: boolean,
): HuyaLiveSummary | null {
  if (!rooms.length) return null
  if (matched) {
    const { match, secondary, siblings } = matched
    const bothTeams = rooms.find(room => titleMatchesTeam(room.title, match.teams[0]) && titleMatchesTeam(room.title, match.teams[1]))
    if (bothTeams) return bothTeams
    const otherTeams = siblings.filter(other => other.id !== match.id).flatMap(other => other.teams)
    const singleTeam = rooms.find(room =>
      (titleMatchesTeam(room.title, match.teams[0]) || titleMatchesTeam(room.title, match.teams[1]))
      && !otherTeams.some(other => titleMatchesTeam(room.title, other)))
    if (singleTeam) return singleTeam
    if (fromTournamentLinks) {
      if (secondary) {
        return rooms.find(room => SECONDARY_NICK_RE.test(room.nickname) || SECONDARY_MARKER_RE.test(room.title))
          ?? rooms[1] ?? rooms[0] ?? null
      }
      return rooms.find(room => PRIMARY_NICK_RE.test(room.nickname) && !SECONDARY_NICK_RE.test(room.nickname))
        ?? rooms.find(room => !SECONDARY_NICK_RE.test(room.nickname))
        ?? rooms[0] ?? null
    }
  }
  return null
}

export interface HuyaOfficialMatcherOptions {
  userDataDir: string
  version: string
  getSchedule: () => Promise<Cs2Schedule>
  request?: typeof fetch
  resolve?: Resolver
  now?: () => number
}

export class HuyaOfficialStreamMatcher {
  private readonly now: () => number
  private readonly lifetime = new AbortController()
  private readonly pool = new PinnedDispatcherPool()
  private readonly rateLimit: LiquipediaRateLimit
  private readonly turns: DispatchTurns
  private readonly linksCache = new Map<string, { rooms: string[]; at: number; failed: boolean }>()
  private readonly linksFlights = new Map<string, Promise<string[]>>()
  private readonly roomCache = new Map<string, { summary: HuyaLiveSummary | null; at: number }>()
  private liveListCache: { rooms: string[]; at: number } | null = null

  constructor(private readonly options: HuyaOfficialMatcherOptions) {
    this.now = options.now ?? Date.now
    this.rateLimit = new LiquipediaRateLimit(options.userDataDir, this.now)
    this.turns = new DispatchTurns(this.rateLimit)
  }

  async find(raw: unknown): Promise<HuyaOfficialMatch | null> {
    const lookup = huyaOfficialLookupArguments(raw)
    this.lifetime.signal.throwIfAborted()
    let schedule: Cs2Schedule
    try { schedule = await this.options.getSchedule() } catch { return null }
    const now = this.now()
    const matched = findMatchingCs2Match(schedule, lookup, now)
    if (!matched) return null

    const path = normalizeTournamentPath(matched.match.tournament.url)
    let candidateRooms = path ? await this.tournamentHuyaRooms(path) : []
    const fromTournamentLinks = candidateRooms.length > 0
    if (!candidateRooms.length) {
      candidateRooms = await this.cs2LiveListRooms()
    }
    if (!candidateRooms.length) return null

    const summaries = (await Promise.all(
      candidateRooms.slice(0, MAX_CANDIDATE_ROOMS).map(room => this.inspectHuyaRoom(room)),
    )).filter((item): item is HuyaLiveSummary => item !== null)

    const best = selectBestHuyaRoom(summaries, matched, fromTournamentLinks)
    if (!best) return null
    return {
      room: best.room,
      url: `https://www.huya.com/${best.room}`,
      nickname: best.nickname || `虎牙 ${best.room}`,
      title: best.title,
      tournament: matched.match.tournament.name,
    }
  }

  private async tournamentHuyaRooms(path: string): Promise<string[]> {
    const cached = this.linksCache.get(path), now = this.now()
    if (cached && now >= cached.at && now - cached.at < (cached.failed ? LINKS_RETRY_MS : LINKS_TTL_MS)) {
      return cached.rooms
    }
    const existing = this.linksFlights.get(path)
    if (existing) return existing
    if (this.rateLimit.cooldown()) return cached?.rooms ?? []

    const work = (async () => {
      for (let page = path, depth = 0; ; depth++) {
        const payload = await this.fetchLiquipediaJson(channelLinksUrl(page))
        const rooms = eventHuyaRooms(payload)
        const slash = page.lastIndexOf('/')
        if (rooms.length || depth >= 2 || slash < 0) return rooms
        page = page.slice(0, slash)
      }
    })().then(rooms => {
      this.linksCache.set(path, { rooms, at: this.now(), failed: false })
      return rooms
    }, () => {
      this.linksCache.set(path, { rooms: [], at: this.now(), failed: true })
      return []
    }).finally(() => {
      this.linksFlights.delete(path)
    })
    this.linksFlights.set(path, work)
    return work
  }

  private async fetchLiquipediaJson(url: string): Promise<unknown> {
    this.rateLimit.throwIfCooling()
    const config = liquipediaConfig()
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(config.requestTimeoutMs)])
    let startedAt = this.now()
    const result = await safeFetch(url, config, {
      signal,
      dispatcherPool: this.pool,
      resolve: this.options.resolve,
      headers: {
        'User-Agent': metadataUserAgent(this.options.version),
        'Accept-Encoding': 'gzip',
        Accept: 'application/json',
      },
      fetchImpl: async (input, init) => {
        await this.turns.wait('tier', signal)
        this.rateLimit.throwIfCooling()
        startedAt = this.now()
        const response = await (this.options.request ?? fetch)(input, init)
        if (response.status === 429) {
          await this.rateLimit.rateLimited(response.headers.get('retry-after'), signal, response.headers.get('date'))
        }
        return response
      },
    })
    const payload = await readJson(result.response)
    this.rateLimit.succeeded(startedAt)
    return payload
  }

  private async cs2LiveListRooms(): Promise<string[]> {
    const now = this.now()
    if (this.liveListCache && now - this.liveListCache.at < LIVE_LIST_TTL_MS) return this.liveListCache.rooms
    try {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(8_000)])
      const { response } = await safeFetch(HUYA_CS2_LIST_URL, huyaPolicy, {
        signal, network: directNetwork, dispatcherPool: this.pool, resolve: this.options.resolve,
        fetchImpl: this.options.request,
        headers: { 'User-Agent': HUYA_UA, Referer: 'https://www.huya.com/', Accept: 'application/json' },
      })
      const json = await readJson(response) as { data?: { datas?: Array<Record<string, unknown>> } }
      const datas = Array.isArray(json?.data?.datas) ? json.data.datas : []
      const rooms = datas.slice(0, 60).flatMap(item => {
        const room = typeof item?.profileRoom === 'number' || typeof item?.profileRoom === 'string' ? String(item.profileRoom) : ''
        const nick = typeof item?.nick === 'string' ? item.nick : ''
        const tag = typeof item?.recommendTagName === 'string' ? item.recommendTagName : ''
        if (!/^[1-9]\d{0,15}$/.test(room)) return []
        if (tag === '虎牙官方' || OFFICIAL_NICK_RE.test(nick)) return [room]
        return []
      })
      this.liveListCache = { rooms, at: this.now() }
      return rooms
    } catch {
      return []
    }
  }

  private async inspectHuyaRoom(room: string): Promise<HuyaLiveSummary | null> {
    const now = this.now(), cached = this.roomCache.get(room)
    if (cached && now - cached.at < ROOM_TTL_MS) return cached.summary
    try {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(8_000)])
      const { response } = await safeFetch(`https://www.huya.com/${encodeURIComponent(room)}`, huyaPolicy, {
        signal, network: directNetwork, dispatcherPool: this.pool, resolve: this.options.resolve,
        fetchImpl: this.options.request,
        headers: { 'User-Agent': HUYA_UA, Referer: 'https://www.huya.com/' },
      })
      if (!response.ok) { this.roomCache.set(room, { summary: null, at: this.now() }); return null }
      const html = (await readBody(response, MAX_HUYA_PAGE_BYTES)).toString('utf8')
      const summary = parseHuyaLiveSummary(html, room)
      this.roomCache.set(room, { summary, at: this.now() })
      return summary
    } catch {
      return null
    }
  }

  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled(this.linksFlights.values())
    await this.pool.dispose()
    this.linksCache.clear()
    this.roomCache.clear()
  }
}
