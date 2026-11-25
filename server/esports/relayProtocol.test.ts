import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import fixture from './fixtures/liquipedia-matches.json'
import tickerFixture from './fixtures/liquipedia-match-ticker.json'
import { parseSchedule } from './parser'
import { ATTRIBUTION, EsportsService } from './schedule'
import { fromRelaySchedule, parseRelaySchedule, toRelaySchedule, RELAY_MAX_BEST_OF, RELAY_MAX_CHANNEL_LENGTH,
  RELAY_MAX_ENTRY_LENGTH, RELAY_MAX_ID_LENGTH, RELAY_MAX_MATCHES, RELAY_MAX_SCORE, RELAY_MAX_STREAMS,
  RELAY_MAX_TEXT_LENGTH, RELAY_MAX_URL_LENGTH, type RelaySchedule, type RelayStream } from './relayProtocol'
import type { Cs2Schedule } from './types'

const NOW = Date.parse('2026-10-26T20:00:00Z')
const SHA256 = 'abcdef0123456789'.repeat(4)
const KEY = '0123456789abcdef'.repeat(4)
const LOGO = `app://app/team-logo/${KEY}?v=${SHA256}`
const schedule = (): Cs2Schedule => ({ fetchedAt: NOW, source: 'liquipedia', attribution: ATTRIBUTION,
  stale: false, matches: parseSchedule(fixture) })
const wire = (): RelaySchedule => toRelaySchedule(schedule(), NOW + 1_000, null).schedule
type FieldPath = Array<string | number>
function changed(path: FieldPath, value: unknown): unknown {
  const result = wire()
  let parent: Record<string, unknown> = result as unknown as Record<string, unknown>
  for (const part of path.slice(0, -1)) parent = parent[part] as Record<string, unknown>
  parent[path.at(-1)!] = value
  return result
}

describe('relay schedule conversion', () => {
  it.each([fixture, tickerFixture])('roundtrips parsed match fields and streams without carrying client state', payload => {
    const source = { ...schedule(), matches: parseSchedule(payload) }
    const relay = toRelaySchedule(source, NOW, null)
    expect(relay.skipped).toEqual({ matches: 0, streams: 0 })
    const result = fromRelaySchedule(parseRelaySchedule(JSON.parse(JSON.stringify(relay.schedule))))
    expect(result).toEqual(source)
  })

  it.each([
    ['registered video', fixture, 'https://www.youtube.com/PGL/streams'],
    ['legacy channel', { parse: { text: { '*': fixture.parse.text['*'].replaceAll('/youtube/PGL/sx5tneE-ILg', '/youtube/PGL') } } }, 'https://www.youtube.com/PGL/streams'],
    ['handle', { parse: { text: { '*': fixture.parse.text['*'].replaceAll('/youtube/PGL/sx5tneE-ILg', '/youtube/PGL') } } }, 'https://www.youtube.com/@PGL/live'],
    ['escaped handle', { parse: { text: { '*': fixture.parse.text['*'].replaceAll('/youtube/PGL/sx5tneE-ILg', '/youtube/PGL') } } }, 'https://www.youtube.com/@P%47L/live'],
    ['custom channel', { parse: { text: { '*': fixture.parse.text['*'].replaceAll('/youtube/PGL/sx5tneE-ILg', '/youtube/PGL') } } }, 'https://www.youtube.com/c/PGL/live'],
    ['username', { parse: { text: { '*': fixture.parse.text['*'].replaceAll('/youtube/PGL/sx5tneE-ILg', '/youtube/PGL') } } }, 'https://www.youtube.com/user/PGL/live'],
    ['channel id', { parse: { text: { '*': fixture.parse.text['*'].replaceAll('/youtube/PGL/sx5tneE-ILg', '/youtube/PGL') } } }, 'https://www.youtube.com/channel/UCu3pz0wE4Gb5u_7SPyHNTDQ'],
  ])('roundtrips exact streams produced by EsportsService: %s', async (_name, payload, youtubeLink) => {
    const directory = await mkdtemp(join(tmpdir(), 'fy1sync-relay-protocol-'))
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const request = vi.fn<typeof fetch>(async input => {
      const params = new URL(String(input)).searchParams
      if (params.get('action') === 'parse') return Response.json(payload)
      if (params.get('prop') === 'extlinks') return Response.json({ query: { pages: [{ extlinks: [
        'https://www.twitch.tv/PGL', 'https://www.twitch.tv/pgl_cs2', youtubeLink,
      ].map(url => ({ url })) }] } })
      return Response.json({ query: { pages: (params.get('titles') ?? '').split('|').map(title => ({
        title, categories: [{ title: 'Category:Tournaments' }],
      })) } })
    })
    const service = new EsportsService({ userDataDir: directory, version: '0.4.1', request,
      resolve: async () => ['93.184.216.34'], logos: null, log: () => {} })
    try {
      await service.getCs2Schedule()
      service.setScheduleFocus({ eventPath: '/counterstrike/PGL/2026/Masters' })
      await vi.advanceTimersByTimeAsync(6_000)
      const source = await service.getCs2Schedule()
      expect(source.matches.length).toBeGreaterThan(0)
      expect(source.matches[0]!.streams[0]!.url).toBe('https://www.twitch.tv/pgl_cs2')
      expect(source.matches[0]!.streams.find(stream => stream.platform === 'youtube')?.url)
        .toBe(_name === 'registered video' ? 'https://www.youtube.com/watch?v=sx5tneE-ILg'
          : youtubeLink.endsWith('/live') ? youtubeLink : youtubeLink.replace(/\/streams$/, '') + '/live')
      const relay = toRelaySchedule(source, Date.now(), null)
      expect(relay.skipped).toEqual({ matches: 0, streams: 0 })
      const result = fromRelaySchedule(parseRelaySchedule(JSON.parse(JSON.stringify(relay.schedule))))
      expect(result.matches.map(match => match.streams)).toEqual(source.matches.map(match => match.streams))
      expect(result).toEqual(source)
      expect(request).toHaveBeenCalled()
    } finally {
      await service.dispose()
      vi.useRealTimers()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('converts only local versioned logos and lets the caller supply available local URLs', () => {
    const source = schedule()
    source.matches[0]!.teams[0].logo = LOGO
    source.matches[0]!.tournament.logo = LOGO
    const { schedule: relay } = toRelaySchedule(source, NOW + 1, null)
    expect(relay.matches[0]!.teams[0].logo).toEqual({ key: KEY, sha256: SHA256 })
    expect(relay.matches[0]!.tournament.logo).toEqual({ key: KEY, sha256: SHA256 })
    expect(JSON.stringify(relay)).not.toContain('app://')
    expect(fromRelaySchedule(relay).matches[0]!.teams[0].logo).toBeNull()
    expect(fromRelaySchedule(relay).matches[0]!.tournament.logo).toBeNull()
    const logoUrl = vi.fn(logo => `app://app/team-logo/${logo.key}?v=${logo.sha256}`)
    expect(fromRelaySchedule(relay, logoUrl)).toEqual(source)
    expect(logoUrl).toHaveBeenCalledTimes(2)
    expect(fromRelaySchedule(relay, () => null).matches[0]!.teams[0].logo).toBeNull()
  })

  it.each(['https://evil.example/a.png', 'app://app/team-logo/../secret?v=' + SHA256,
    'app://app/team-logo/' + KEY, LOGO + '&url=https://evil.example', LOGO + '#fragment'])('skips a match with a noncanonical local logo: %s', logo => {
    const source = schedule()
    source.matches[0]!.teams[0].logo = logo
    const result = toRelaySchedule(source, NOW, null)
    expect(result.skipped).toEqual({ matches: 1, streams: 0 })
    expect(result.schedule.matches).toEqual(wire().matches.slice(1))
  })

  it('omits local failures, verification state and stream diagnostics from the wire', () => {
    const source: Cs2Schedule = { ...schedule(), stale: true, error: 'local failure', errorDetail: { message: 'private detail' },
      refreshAt: NOW + 5_000, refreshReason: 'retry', verification: { round: 'round', notBefore: NOW, used: false },
      verificationResult: 'failed' }
    source.matches[0]!.streams[0]!.errorDetail = { message: 'private channel failure' }
    const { schedule: result } = toRelaySchedule(source, NOW, NOW + 60_000)
    expect(Object.keys(result)).toEqual(['schema', 'fetchedAt', 'generatedAt', 'source', 'attribution', 'upstream', 'matches'])
    expect(result.upstream).toEqual({ limitedUntil: NOW + 60_000 })
    expect(Object.keys(result.matches[0]!.streams[0]!)).toEqual(['platform', 'entry', 'channel', 'videoId', 'missing'])
    expect(JSON.stringify(result)).not.toContain('private')
    const local = fromRelaySchedule(result)
    expect(local.stale).toBe(false)
    for (const field of ['error', 'errorDetail', 'refreshAt', 'refreshReason', 'verification', 'verificationResult']) {
      expect(local).not.toHaveProperty(field)
    }
  })

  it('copies values instead of retaining input arrays and objects', () => {
    const source = schedule(), { schedule: relay } = toRelaySchedule(source, NOW, null), canonical = parseRelaySchedule(relay)
    const local = fromRelaySchedule(relay)
    canonical.matches[0]!.score![0] = 99
    local.matches[0]!.teams[0].name = 'Changed'
    local.matches[0]!.streams[0]!.entry = 'Changed'
    expect(relay.matches[0]!.score).toEqual([0, 1])
    expect(source.matches[0]!.teams[0].name).toBe('G2 Esports')
    expect(relay.matches[0]!.streams[0]!.entry).toBe('PGL_CS2')
  })

  it('downgrades an invalid YouTube channel while preserving other streams and matches', () => {
    const source = schedule(), canonical = wire()
    const stream = source.matches[0]!.streams[1]!
    stream.channel = 'PGL!invalid'
    stream.videoId = null
    stream.url = 'https://www.youtube.com/PGL!invalid/live'
    const result = toRelaySchedule(source, NOW + 1_000, null)
    expect(result.skipped).toEqual({ matches: 0, streams: 1 })
    canonical.matches[0]!.streams[1] = { platform: 'youtube', entry: stream.entry,
      channel: null, videoId: null, missing: 'unmatched' }
    expect(result.schedule).toEqual(canonical)
    expect(parseRelaySchedule(result.schedule)).toEqual(canonical)
    expect(fromRelaySchedule(result.schedule).matches[0]!.streams[1]).toEqual({ ...canonical.matches[0]!.streams[1], url: null })
  })

  it.each([
    ['invalid video', { videoId: '../evil?a=b' }],
    ['invalid missing reason', { missing: 'rate-limited' }],
    ['invalid URL', { channel: 'PGL', videoId: null, url: 'not a URL' }],
    ['missing channel', { channel: undefined }],
  ])('falls back to an unmatched stream with a valid entry: %s', (_name, changes) => {
    const source = schedule(), stream = source.matches[0]!.streams[1]!
    Object.assign(stream, changes)
    const result = toRelaySchedule(source, NOW, null)
    expect(result.skipped).toEqual({ matches: 0, streams: 1 })
    expect(result.schedule.matches[0]!.streams[1]).toEqual({ platform: 'youtube', entry: stream.entry,
      channel: null, videoId: null, missing: 'unmatched' })
    expect(() => parseRelaySchedule(result.schedule)).not.toThrow()
  })

  it.each(['../secret', '', 'a'.repeat(RELAY_MAX_ENTRY_LENGTH + 1)])('discards a stream with an invalid entry: %s', entry => {
    const source = schedule(), canonical = wire()
    source.matches[0]!.streams[1]!.entry = entry
    const result = toRelaySchedule(source, NOW + 1_000, null)
    expect(result.skipped).toEqual({ matches: 0, streams: 1 })
    canonical.matches[0]!.streams.splice(1, 1)
    expect(result.schedule).toEqual(canonical)
  })

  it('discards a stream whose platform cannot be used for the fallback', () => {
    const source = schedule()
    Object.assign(source.matches[0]!.streams[1]!, { platform: 'kick' })
    const result = toRelaySchedule(source, NOW, null)
    expect(result.skipped).toEqual({ matches: 0, streams: 1 })
    expect(result.schedule.matches[0]!.streams).toEqual(wire().matches[0]!.streams.slice(0, 1))
  })

  it('skips a match with an oversized team name and preserves other matches', () => {
    const source = schedule()
    source.matches[0]!.teams[0].name = 'a'.repeat(RELAY_MAX_TEXT_LENGTH + 1)
    const result = toRelaySchedule(source, NOW, null)
    expect(result.skipped).toEqual({ matches: 1, streams: 0 })
    expect(result.schedule.matches).toEqual(wire().matches.slice(1))
    expect(() => parseRelaySchedule(result.schedule)).not.toThrow()
  })

  it('skips a match with an invalid tournament path', () => {
    const source = schedule()
    source.matches[0]!.tournament.url = 'https://evil.example/counterstrike/PGL'
    const result = toRelaySchedule(source, NOW, null)
    expect(result.skipped).toEqual({ matches: 1, streams: 0 })
    expect(result.schedule.matches).toEqual(wire().matches.slice(1))
  })

  it('counts downgraded and discarded streams only in matches that pass non-stream validation', () => {
    const source = schedule(), match = source.matches[0]!
    match.streams[0]!.channel = 'https://evil.example'
    match.streams[1]!.entry = '../secret'
    const invalidMatch = structuredClone(match)
    invalidMatch.id = 'invalid-match'
    invalidMatch.teams[0].name = 'a'.repeat(RELAY_MAX_TEXT_LENGTH + 1)
    source.matches.unshift(invalidMatch)
    const result = toRelaySchedule(source, NOW, null)
    expect(result.skipped).toEqual({ matches: 1, streams: 2 })
    expect(result.schedule.matches[0]!.streams).toEqual([{ platform: 'twitch', entry: match.streams[0]!.entry,
      channel: null, videoId: null, missing: 'unmatched' }])
    expect(result.schedule.matches.slice(1)).toEqual(wire().matches.slice(1))
  })

  it('can publish an empty schedule when every match is invalid', () => {
    const source = schedule()
    source.matches.forEach(match => { match.teams[0].name = '' })
    const result = toRelaySchedule(source, NOW, null)
    expect(result.skipped).toEqual({ matches: source.matches.length, streams: 0 })
    expect(result.schedule.matches).toEqual([])
    expect(() => parseRelaySchedule(result.schedule)).not.toThrow()
  })

  it('still rejects invalid schedule metadata', () => {
    const source = schedule()
    expect(() => toRelaySchedule({ ...source, fetchedAt: -1 }, NOW, null)).toThrow('Invalid relay schedule')
    expect(() => toRelaySchedule(source, NaN, null)).toThrow('Invalid relay schedule')
    expect(() => toRelaySchedule(source, NOW, -1)).toThrow('Invalid relay schedule')
    expect(() => toRelaySchedule({ ...source, attribution: '' }, NOW, null)).toThrow('Invalid relay schedule')
  })

  it('skips duplicate matches and caps publication without letting an oversized stream list block other matches', () => {
    const source = schedule(), match = source.matches[0]!
    const matches = Array.from({ length: RELAY_MAX_MATCHES + 1 }, (_, index) => ({ ...match, id: String(index),
      streams: index === 0 ? Array(RELAY_MAX_STREAMS + 1).fill(match.streams[0]!) : [] }))
    const result = toRelaySchedule({ ...source, matches: [matches[0]!, ...matches] }, NOW, null)
    expect(result.skipped).toEqual({ matches: 2, streams: 1 })
    expect(result.schedule.matches).toHaveLength(RELAY_MAX_MATCHES)
    expect(result.schedule.matches[0]!.streams).toHaveLength(RELAY_MAX_STREAMS)
    expect(result.schedule.matches[1]!.id).toBe('1')
    expect(parseRelaySchedule(result.schedule)).toEqual(result.schedule)
  })
})

describe('relay schedule validation', () => {
  it.each([null, undefined, [], true, 1, 'schedule'])('rejects a nonobject response: %s', input => {
    expect(() => parseRelaySchedule(input)).toThrow('Invalid relay schedule')
  })

  const malformed: Array<[string, FieldPath, unknown]> = [
    ['schema type', ['schema'], '1'], ['schema version', ['schema'], 2],
    ['source', ['source'], 'pandascore'], ['attribution type', ['attribution'], {}],
    ['attribution empty', ['attribution'], ''], ['attribution too long', ['attribution'], 'a'.repeat(RELAY_MAX_TEXT_LENGTH + 1)],
    ['attribution control', ['attribution'], 'text\ntext'],
    ['fetchedAt type', ['fetchedAt'], String(NOW)], ['fetchedAt negative', ['fetchedAt'], -1],
    ['fetchedAt fraction', ['fetchedAt'], NOW + 0.5], ['fetchedAt unsafe', ['fetchedAt'], Number.MAX_SAFE_INTEGER + 1],
    ['generatedAt infinite', ['generatedAt'], Infinity], ['generatedAt missing', ['generatedAt'], undefined],
    ['generatedAt negative', ['generatedAt'], -1], ['generatedAt unsafe', ['generatedAt'], Number.MAX_SAFE_INTEGER + 1],
    ['upstream type', ['upstream'], []], ['upstream missing', ['upstream'], undefined],
    ['limitedUntil type', ['upstream', 'limitedUntil'], 'tomorrow'], ['limitedUntil negative', ['upstream', 'limitedUntil'], -1],
    ['limitedUntil unsafe', ['upstream', 'limitedUntil'], Number.MAX_SAFE_INTEGER + 1],
    ['limitedUntil fraction', ['upstream', 'limitedUntil'], 0.5], ['limitedUntil missing', ['upstream', 'limitedUntil'], undefined],
    ['matches type', ['matches'], {}], ['match type', ['matches', 0], null],
    ['id type', ['matches', 0, 'id'], 1], ['id empty', ['matches', 0, 'id'], ''],
    ['id too long', ['matches', 0, 'id'], 'a'.repeat(RELAY_MAX_ID_LENGTH + 1)],
    ['startsAt type', ['matches', 0, 'startsAt'], 'soon'], ['startsAt negative', ['matches', 0, 'startsAt'], -1],
    ['startsAt unsafe', ['matches', 0, 'startsAt'], Number.MAX_SAFE_INTEGER + 1],
    ['state', ['matches', 0, 'state'], 'paused'], ['teams type', ['matches', 0, 'teams'], {}],
    ['team type', ['matches', 0, 'teams', 0], null], ['team name type', ['matches', 0, 'teams', 0, 'name'], false],
    ['team name too long', ['matches', 0, 'teams', 0, 'name'], 'a'.repeat(RELAY_MAX_TEXT_LENGTH + 1)],
    ['team short type', ['matches', 0, 'teams', 0, 'short'], 1], ['team short empty', ['matches', 0, 'teams', 0, 'short'], ''],
    ['team short too long', ['matches', 0, 'teams', 0, 'short'], 'a'.repeat(RELAY_MAX_TEXT_LENGTH + 1)],
    ['logo type', ['matches', 0, 'teams', 0, 'logo'], LOGO],
    ['logo missing', ['matches', 0, 'teams', 0, 'logo'], undefined],
    ['logo key traversal', ['matches', 0, 'teams', 0, 'logo'], { key: '../secret', sha256: SHA256 }],
    ['logo key URL', ['matches', 0, 'teams', 0, 'logo'], { key: 'https://evil.example', sha256: SHA256 }],
    ['logo key encoded traversal', ['matches', 0, 'teams', 0, 'logo'], { key: '%2e%2e', sha256: SHA256 }],
    ['logo key length', ['matches', 0, 'teams', 0, 'logo'], { key: 'a'.repeat(65), sha256: SHA256 }],
    ['logo key uppercase', ['matches', 0, 'teams', 0, 'logo'], { key: 'KEY', sha256: SHA256 }],
    ['logo sha256 type', ['matches', 0, 'teams', 0, 'logo'], { key: KEY, sha256: 1 }],
    ['logo sha256 length', ['matches', 0, 'teams', 0, 'logo'], { key: KEY, sha256: SHA256.slice(1) }],
    ['logo sha256 charset', ['matches', 0, 'teams', 0, 'logo'], { key: KEY, sha256: 'z'.repeat(64) }],
    ['score type', ['matches', 0, 'score'], '0:1'], ['score negative', ['matches', 0, 'score'], [-1, 0]],
    ['score too large', ['matches', 0, 'score'], [RELAY_MAX_SCORE + 1, 0]], ['score fraction', ['matches', 0, 'score'], [0.5, 0]],
    ['score wrong length', ['matches', 0, 'score'], [0, 1, 2]], ['score element type', ['matches', 0, 'score'], [0, '1']],
    ['bestOf type', ['matches', 0, 'bestOf'], '3'], ['bestOf zero', ['matches', 0, 'bestOf'], 0],
    ['bestOf too large', ['matches', 0, 'bestOf'], RELAY_MAX_BEST_OF + 1], ['bestOf fraction', ['matches', 0, 'bestOf'], 1.5],
    ['tournament type', ['matches', 0, 'tournament'], null],
    ['tournament name empty', ['matches', 0, 'tournament', 'name'], ''],
    ['tournament name too long', ['matches', 0, 'tournament', 'name'], 'a'.repeat(RELAY_MAX_TEXT_LENGTH + 1)],
    ['stage type', ['matches', 0, 'tournament', 'stage'], []],
    ['stage too long', ['matches', 0, 'tournament', 'stage'], 'a'.repeat(RELAY_MAX_TEXT_LENGTH + 1)],
    ['tier value', ['matches', 0, 'tournament', 'tier'], 5], ['tier type', ['matches', 0, 'tournament', 'tier'], '1'],
    ['tournament URL type', ['matches', 0, 'tournament', 'url'], null],
    ['tournament URL external', ['matches', 0, 'tournament', 'url'], 'https://evil.example/counterstrike/PGL'],
    ['tournament URL traversal', ['matches', 0, 'tournament', 'url'], 'https://liquipedia.net/counterstrike/%2e%2e/secret'],
    ['tournament URL credentials', ['matches', 0, 'tournament', 'url'], 'https://user@liquipedia.net/counterstrike/PGL'],
    ['tournament URL query', ['matches', 0, 'tournament', 'url'], 'https://liquipedia.net/counterstrike/PGL?redirect=evil'],
    ['tournament URL too long', ['matches', 0, 'tournament', 'url'], '/counterstrike/' + 'a'.repeat(RELAY_MAX_URL_LENGTH)],
    ['tournament logo invalid', ['matches', 0, 'tournament', 'logo'], { key: '../secret', sha256: SHA256 }],
    ['streams type', ['matches', 0, 'streams'], null], ['stream type', ['matches', 0, 'streams', 0], null],
    ['platform value', ['matches', 0, 'streams', 0, 'platform'], 'kick'],
    ['entry type', ['matches', 0, 'streams', 0, 'entry'], 1], ['entry empty', ['matches', 0, 'streams', 0, 'entry'], ''],
    ['entry too long', ['matches', 0, 'streams', 0, 'entry'], 'a'.repeat(RELAY_MAX_ENTRY_LENGTH + 1)],
    ['entry path', ['matches', 0, 'streams', 0, 'entry'], '../secret'],
    ['channel type', ['matches', 0, 'streams', 0, 'channel'], {}],
    ['channel missing', ['matches', 0, 'streams', 0, 'channel'], undefined],
    ['channel too long', ['matches', 0, 'streams', 0, 'channel'], 'a'.repeat(RELAY_MAX_CHANNEL_LENGTH + 1)],
    ['channel external URL', ['matches', 0, 'streams', 0, 'channel'], 'https://evil.example'],
    ['channel traversal', ['matches', 0, 'streams', 0, 'channel'], '../private'],
    ['channel query', ['matches', 0, 'streams', 0, 'channel'], 'pgl?url=evil'],
    ['channel short Twitch login', ['matches', 0, 'streams', 0, 'channel'], 'ab'],
    ['channel long Twitch login', ['matches', 0, 'streams', 0, 'channel'], 'a'.repeat(26)],
    ['YouTube channel URL injection', ['matches', 0, 'streams', 1, 'channel'], 'evil.example/@pgl'],
    ['YouTube handle query injection', ['matches', 0, 'streams', 1, 'channel'], '@pgl?url=evil'],
    ['YouTube encoded channel injection', ['matches', 0, 'streams', 1, 'channel'], '@pgl%2f..'],
    ['YouTube channel backslash injection', ['matches', 0, 'streams', 1, 'channel'], '@pgl\\evil'],
    ['YouTube channel whitespace', ['matches', 0, 'streams', 1, 'channel'], '@pgl evil'],
    ['YouTube reserved page', ['matches', 0, 'streams', 1, 'channel'], 'watch'],
    ['videoId type', ['matches', 0, 'streams', 1, 'videoId'], 123],
    ['videoId too short', ['matches', 0, 'streams', 1, 'videoId'], 'abcdefghij'],
    ['videoId too long', ['matches', 0, 'streams', 1, 'videoId'], 'abcdefghijkl'],
    ['videoId address injection', ['matches', 0, 'streams', 1, 'videoId'], '../evil?a=b'],
    ['videoId charset', ['matches', 0, 'streams', 1, 'videoId'], 'abcde/ghijk'],
    ['Twitch videoId', ['matches', 0, 'streams', 0, 'videoId'], 'abcdefghijk'],
    ['missing value', ['matches', 0, 'streams', 0, 'missing'], 'rate-limited'],
    ['missing type', ['matches', 0, 'streams', 0, 'missing'], true],
    ['missing omitted', ['matches', 0, 'streams', 0, 'missing'], undefined],
    ['missing without destination', ['matches', 0, 'streams', 0, 'missing'], null],
    ['missing with destination', ['matches', 0, 'streams', 1, 'missing'], 'finding'],
  ]
  it.each(malformed)('rejects malformed %s', (_name, path, value) => {
    expect(() => parseRelaySchedule(changed(path, value))).toThrow('Invalid relay schedule')
  })

  it('rejects oversized collections, wrong tuple lengths, sparse arrays and duplicate identities', () => {
    const relay = wire(), match = relay.matches[0]!
    expect(() => parseRelaySchedule({ ...relay, matches: Array(RELAY_MAX_MATCHES + 1).fill(match) })).toThrow()
    expect(() => parseRelaySchedule({ ...relay, matches: [match, match] })).toThrow()
    expect(() => parseRelaySchedule({ ...relay, matches: Array(1) })).toThrow()
    expect(() => parseRelaySchedule(changed(['matches', 0, 'streams'], Array(RELAY_MAX_STREAMS + 1).fill(match.streams[0])))).toThrow()
    expect(() => parseRelaySchedule(changed(['matches', 0, 'streams'], Array(1)))).toThrow()
    for (const value of [[], [match.teams[0]], [...match.teams, match.teams[0]], Array(2)]) {
      expect(() => parseRelaySchedule(changed(['matches', 0, 'teams'], value))).toThrow()
    }
    expect(() => parseRelaySchedule(changed(['matches', 0, 'score'], Array(2)))).toThrow()
  })

  it('accepts boundary limits, empty schedules, every tier and every supported state', () => {
    const relay = wire(), match = relay.matches[0]!
    match.id = 'a'.repeat(RELAY_MAX_ID_LENGTH)
    match.teams[0].name = 'a'.repeat(RELAY_MAX_TEXT_LENGTH)
    match.teams[0].short = null
    match.teams[0].logo = { key: 'a'.repeat(64), sha256: SHA256.toUpperCase() }
    match.score = [0, RELAY_MAX_SCORE]
    match.bestOf = RELAY_MAX_BEST_OF
    match.streams = Array.from({ length: RELAY_MAX_STREAMS }, () => ({ platform: 'youtube',
      entry: 'a'.repeat(RELAY_MAX_ENTRY_LENGTH), channel: '@' + 'a'.repeat(100), videoId: null, missing: null }))
    relay.fetchedAt = 0
    relay.generatedAt = 8_640_000_000_000_000
    relay.upstream.limitedUntil = 0
    relay.matches = Array.from({ length: RELAY_MAX_MATCHES }, (_, index) => ({ ...match, id: String(index),
      state: (['live', 'upcoming', 'finished'] as const)[index % 3]!,
      tournament: { ...match.tournament, tier: ([1, 2, 3, 4, -1, null] as const)[index % 6]! } }))
    expect(parseRelaySchedule(relay).matches).toHaveLength(RELAY_MAX_MATCHES)
    expect(parseRelaySchedule(relay).matches[0]!.teams[0].logo?.sha256).toBe(SHA256)
    expect(parseRelaySchedule({ ...relay, matches: [] }).matches).toEqual([])
  })

  it.each(['finding', 'unmatched', 'failed'] as const)('preserves unresolved streams: %s', missing => {
    const relay = wire()
    relay.matches[0]!.streams[0]!.missing = missing
    expect(fromRelaySchedule(relay).matches[0]!.streams[0]).toEqual({
      platform: 'twitch', entry: 'PGL_CS2', channel: null, videoId: null, missing, url: null,
    })
  })

  it.each([
    ['PGL', 'https://www.youtube.com/PGL/live'], ['@PGL', 'https://www.youtube.com/@PGL/live'],
    ['@赛事直播', 'https://www.youtube.com/@%E8%B5%9B%E4%BA%8B%E7%9B%B4%E6%92%AD/live'],
    ['channel/UCu3pz0wE4Gb5u_7SPyHNTDQ', 'https://www.youtube.com/channel/UCu3pz0wE4Gb5u_7SPyHNTDQ/live'],
  ])('rebuilds a YouTube channel address using the existing normalizer: %s', (channel, url) => {
    const relay = wire()
    relay.matches[0]!.streams = [{ platform: 'youtube', entry: 'PGL', channel, videoId: null, missing: null }]
    expect(fromRelaySchedule(relay).matches[0]!.streams[0]!.url).toBe(url)
  })

  it('ignores unknown fields at every level, including injected remote addresses and diagnostics', () => {
    const canonical = wire(), input = structuredClone(canonical)
    const addUnknown = (value: object) => Object.assign(value, { future: 'v1 extension', url: 'https://evil.example',
      errorDetail: { message: 'private' }, verification: { round: 'secret' } })
    addUnknown(input)
    addUnknown(input.upstream)
    addUnknown(input.matches[0]!)
    addUnknown(input.matches[0]!.teams[0])
    Object.assign(input.matches[0]!.tournament, { future: true, errorDetail: 'private' })
    addUnknown(input.matches[0]!.streams[0]!)
    input.matches[0]!.teams[0].logo = { key: KEY, sha256: SHA256 }
    canonical.matches[0]!.teams[0].logo = { key: KEY, sha256: SHA256 }
    addUnknown(input.matches[0]!.teams[0].logo!)
    expect(parseRelaySchedule(input)).toEqual(canonical)
    expect(fromRelaySchedule(input)).toEqual(fromRelaySchedule(canonical))
    expect(JSON.stringify(parseRelaySchedule(input))).not.toContain('evil.example')
  })

  it('always rebuilds URLs from validated identity fields and prioritizes a registered video', () => {
    const relay = wire()
    relay.matches[0]!.streams = [{ platform: 'youtube', entry: 'PGL', channel: '@PGL', videoId: 'sx5tneE-ILg', missing: null },
      { platform: 'twitch', entry: 'PGL', channel: 'pgl_cs2', videoId: null, missing: null }]
    const streams = relay.matches[0]!.streams as Array<RelayStream & { url?: string }>
    streams.forEach(stream => { stream.url = 'https://evil.example' })
    expect(fromRelaySchedule(relay).matches[0]!.streams.map(stream => stream.url)).toEqual([
      'https://www.youtube.com/watch?v=sx5tneE-ILg', 'https://www.twitch.tv/pgl_cs2',
    ])
  })
})
