import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from './fixtures/liquipedia-matches.json'
import { currentMatches, parseSchedule, ScheduleFormatError } from './parser'
import { EsportsService, PARSE_INTERVAL_MS, SCHEDULE_TTL_MS, TITLE_TTL_MS, scheduleArguments, streamTitleArguments, titleStage } from './schedule'
import { DEFAULT_PROXY_HOSTS, hostAllowed, metadataConfig } from '../config'
import type { StreamTitleInput } from './types'

const NOW = Date.parse('2026-10-26T20:00:00Z')
const youtube: StreamTitleInput = { platform: 'youtube', channel: 'PGL', videoId: 'sx5tneE-ILg' }
const twitch: StreamTitleInput = { platform: 'twitch', channel: 'PGL_CS2', videoId: null }
const response = (value: unknown = fixture) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
const change = (from: string, to: string) => ({ parse: { text: { '*': fixture.parse.text['*'].replace(from, to) } } })

describe('Liquipedia fixture parsing', () => {
  it('reads real live, upcoming, TBD and finished matches, with stable identities and resolvable streams', () => {
    const matches = parseSchedule(fixture)
    expect(matches).toHaveLength(9)
    expect(matches[0]).toMatchObject({ startsAt: 1793032200000, state: 'live', teams: [{ name: 'G2 Esports', short: 'G2' }, { name: 'DENDELE CS', short: 'DENDELE' }],
      score: [0, 1], bestOf: 3, tournament: { name: 'PGL Masters Bucharest 2026', stage: 'Round 3', tier: null, url: 'https://liquipedia.net/counterstrike/PGL/2026/Masters#Round_3' } })
    expect(matches[0]!.streams).toEqual([
      { platform: 'twitch', channel: 'PGL_CS2', videoId: null, url: 'https://www.twitch.tv/PGL_CS2' },
      { platform: 'youtube', channel: 'PGL', videoId: 'sx5tneE-ILg', url: 'https://www.youtube.com/watch?v=sx5tneE-ILg' },
    ])
    expect(matches[1]!.streams[0]!.channel).toBe('PGL')
    expect(matches[2]).toMatchObject({ state: 'upcoming', score: null, teams: [{ name: 'FlyQuest' }, { name: 'StaQued', short: null }] })
    expect(matches[4]).toMatchObject({ teams: [{ name: 'TBD', short: null }, { name: 'TBD', short: null }] })
    expect(matches[6]).toMatchObject({ state: 'finished', score: [0, 2] })
    expect(matches[7]!.teams[0]).toEqual({ name: 'Group B 2nd Place', short: null })
    expect(matches[8]!.teams[1]).toEqual({ name: 'TBD', short: null })
    expect(parseSchedule(fixture).map(m => m.id)).toEqual(matches.map(m => m.id))
  })
  it('does not invent tiers from page-wide filter buttons, but reads per-match attributes', () => {
    const actual = parseSchedule(fixture)
    expect(actual.every(match => match.tournament.tier === null)).toBe(true)
    const enriched = change('class="match-info"', 'class="match-info" data-filter-group="filterbuttons-liquipediatier" data-filter-category="1"')
    expect(parseSchedule(enriched)[0]!.tournament.tier).toBe(1)
  })
  it('uses a channel live URL when a YouTube video id is absent and drops Kick', () => {
    const result = parseSchedule(change('/youtube/PGL/sx5tneE-ILg', '/youtube/PGL'))[0]!
    expect(result.streams[1]).toMatchObject({ videoId: null, url: 'https://www.youtube.com/@PGL/live' })
    expect(result.streams).toHaveLength(2)
  })
  it.each([
    ['match-info-header-opponent', 'removed-opponent'], ['match-info-header-scoreholder-upper', 'removed-score'],
    ['data-timestamp="1793032200"', 'data-timestamp="wrong"'], ['PGL/sx5tneE-ILg', 'PGL/bad'],
  ])('rejects the whole response when a required selector or value changes: %s', (from, to) => {
    expect(() => parseSchedule(change(from, to))).toThrow(ScheduleFormatError)
  })
  it('rejects non-API data and an empty unknown layout', () => {
    expect(() => parseSchedule('<html>error</html>')).toThrow('赛程格式已变化, 暂时无法读取')
    expect(() => parseSchedule({ parse: { text: { '*': '<p>Changed markup</p>' } } })).toThrow(ScheduleFormatError)
  })
  it('filters inclusive -12h/+48h and sorts live first, then by start time', () => {
    const base = parseSchedule(fixture)[0]!
    const matches = [
      { ...base, id: 'old', startsAt: NOW - 12 * 3600_000 - 1 },
      { ...base, id: 'early', state: 'finished' as const, startsAt: NOW - 12 * 3600_000 },
      { ...base, id: 'live', startsAt: NOW },
      { ...base, id: 'last', state: 'upcoming' as const, startsAt: NOW + 48 * 3600_000 },
      { ...base, id: 'future', startsAt: NOW + 48 * 3600_000 + 1 },
    ]
    expect(currentMatches(matches, NOW).map(m => m.id)).toEqual(['live', 'early', 'last'])
  })
})

describe('shared schedule service', () => {
  let directory: string, now: number
  const services: EsportsService[] = []
  function create(request = vi.fn<typeof fetch>().mockImplementation(async () => response())) {
    const service = new EsportsService({ userDataDir: directory, version: '0.1.3', request, now: () => now, resolve: async () => ['93.184.216.34'], log: () => {} })
    services.push(service); return { service, request }
  }
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'fy1sync-esports-')); now = NOW })
  afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())); await rm(directory, { recursive: true, force: true }) })

  it('coalesces windows, persists successful data and honors five-minute caching', async () => {
    const { service, request } = create()
    const replies = await Promise.all(Array.from({ length: 8 }, () => service.getCs2Schedule()))
    expect(request).toHaveBeenCalledTimes(1)
    expect(replies.every(reply => reply.stale === false && reply.matches.length > 0)).toBe(true)
    replies[0]!.matches.length = 0
    expect(replies[1]!.matches.length).toBeGreaterThan(0)
    const stored = JSON.parse(await readFile(join(directory, 'events', 'liquipedia.json'), 'utf8'))
    expect(stored.fetchedAt).toBe(NOW)
    now += SCHEDULE_TTL_MS - 1
    await service.getCs2Schedule()
    expect(request).toHaveBeenCalledTimes(1)
    now++
    await service.getCs2Schedule()
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('honors 30 seconds for forced refresh and a separate service after restart', async () => {
    const { service, request } = create()
    await service.getCs2Schedule({ refresh: true })
    const second = create()
    now += PARSE_INTERVAL_MS - 1
    await Promise.all([service.getCs2Schedule({ refresh: true }), second.service.getCs2Schedule({ refresh: true })])
    expect(request).toHaveBeenCalledTimes(1)
    expect(second.request).not.toHaveBeenCalled()
    now++
    await second.service.getCs2Schedule({ refresh: true })
    expect(second.request).toHaveBeenCalledTimes(1)
  })
  it('only dispatches once when two services race on the same empty directory', async () => {
    const first = create(), second = create()
    await Promise.all([first.service.getCs2Schedule({ refresh: true }), second.service.getCs2Schedule({ refresh: true })])
    expect(first.request.mock.calls.length + second.request.mock.calls.length).toBe(1)
  })
  it('refuses a redirect response without sending a second Liquipedia parse request', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 302, headers: { location: 'https://liquipedia.net/counterstrike/api.php?action=parse' } }))
    const { service } = create(request)
    expect(await service.getCs2Schedule()).toMatchObject({ stale: true, matches: [], error: expect.any(String) })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('keeps failures in the request budget and returns the last cache as stale', async () => {
    const { service, request } = create()
    await service.getCs2Schedule()
    now += SCHEDULE_TTL_MS
    request.mockRejectedValueOnce(new Error('offline'))
    const failed = await service.getCs2Schedule({ refresh: true })
    expect(failed).toMatchObject({ fetchedAt: NOW, stale: true, error: expect.any(String) })
    expect(failed.matches.length).toBeGreaterThan(0)
    await service.getCs2Schedule({ refresh: true })
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('returns an old disk cache immediately on cold start while one background refresh runs', async () => {
    await create().service.getCs2Schedule()
    now += SCHEDULE_TTL_MS
    let release!: (value: Response) => void
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { release = resolve }))
    const second = create(request)
    const old = await second.service.getCs2Schedule()
    expect(old).toMatchObject({ fetchedAt: NOW, stale: true })
    for (let i = 0; i < 10 && !release; i++) await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    release(response())
    expect((await second.service.getCs2Schedule()).fetchedAt).toBe(now)
  })
  it('does not defeat the limit when the system clock moves backwards', async () => {
    const { service, request } = create()
    await service.getCs2Schedule()
    now -= 60_000
    await service.getCs2Schedule({ refresh: true })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('returns the required format error and never publishes partial matches', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response(change('match-info-header-opponent', 'wrong')))
    const { service } = create(request)
    const result = await service.getCs2Schedule()
    expect(result).toMatchObject({ stale: true, error: '赛程格式已变化, 暂时无法读取', matches: [] })
  })
  it('uses the identified User-Agent, gzip and metadata-only allowlist', async () => {
    const { service, request } = create()
    await service.getCs2Schedule()
    expect(request.mock.calls[0]![1]?.headers).toMatchObject({ 'User-Agent': 'Fy1Sync/0.1.3 (local desktop app; sync@fy1ng.cn)', 'Accept-Encoding': 'gzip' })
    expect(hostAllowed('liquipedia.net', metadataConfig().hosts)).toBe(true)
    expect(hostAllowed('liquipedia.net', DEFAULT_PROXY_HOSTS)).toBe(false)
    expect(request.mock.calls[0]![1]?.redirect).toBe('manual')
  })
  it('fails closed on a corrupt persisted reservation', async () => {
    const { service, request } = create()
    await service.getCs2Schedule()
    await writeFile(join(directory, 'events', 'liquipedia-attempt.json'), '{broken')
    now += SCHEDULE_TTL_MS
    await service.getCs2Schedule({ refresh: true })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('deduplicates titles, reads oEmbed/GQL independently and caches each for two minutes', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async input => String(input).includes('oembed')
      ? response({ title: '[B] G2 vs DENDELE - Round 3' }) : response({ data: { user: { stream: { title: 'Main Stage: final', type: 'live' } } } }))
    const { service } = create(request)
    const results = await service.getStreamTitles({ streams: [youtube, twitch, youtube] })
    expect(results).toEqual([{ ...youtube, title: '[B] G2 vs DENDELE - Round 3', stage: 'B', live: null },
      { ...twitch, title: 'Main Stage: final', stage: '主舞台', live: true }])
    now += TITLE_TTL_MS - 1
    await service.getStreamTitles({ streams: [youtube, twitch] })
    expect(request).toHaveBeenCalledTimes(2)
    now++
    await service.getStreamTitles({ streams: [youtube] })
    expect(request).toHaveBeenCalledTimes(3)
  })
  it('isolates a title failure and reports Twitch offline without claiming YouTube is live', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async input => {
      if (String(input).includes('oembed')) throw new Error('offline')
      return response({ data: { user: { stream: null } } })
    })
    const { service } = create(request)
    const results = await service.getStreamTitles({ streams: [youtube, twitch, { ...youtube, videoId: null }] })
    expect(results.map(r => [r.title, r.live])).toEqual([[null, null], [null, false], [null, null]])
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('limits concurrent title requests across calls to four', async () => {
    let active = 0, peak = 0
    const pending: Array<() => void> = []
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      active++; peak = Math.max(peak, active)
      await new Promise<void>(resolve => pending.push(resolve))
      active--; return response({ title: 'Stream A - final' })
    })
    const { service } = create(request)
    const inputs = Array.from({ length: 12 }, (_, i) => ({ ...youtube, videoId: `abcdefghij${i.toString(16)}` }))
    const result = service.getStreamTitles({ streams: inputs })
    for (let group = 0; group < 3; group++) {
      for (let tick = 0; tick < 30 && pending.length < 4; tick++) await new Promise(resolve => setImmediate(resolve))
      expect(pending).toHaveLength(4)
      pending.splice(0).forEach(release => release())
    }
    expect(await result).toHaveLength(12)
    expect(peak).toBe(4)
  })
})

describe('title markers and IPC arguments', () => {
  it.each([['[A] final', 'A'], ['B Stream: semifinal', 'B'], ['Stream A - final', 'A'], ['Main Stage', '主舞台'],
    ['Team A vs Team B', null], ['[A] Stream B', null], ['ordinary title', null]])('parses only unambiguous markers: %s', (title, stage) => {
    expect(titleStage(title)).toBe(stage)
  })
  it('accepts the documented optional refresh and at most twelve titles', () => {
    expect(scheduleArguments(undefined)).toBeUndefined()
    expect(scheduleArguments({ refresh: true })).toEqual({ refresh: true })
    expect(streamTitleArguments({ streams: [] })).toEqual({ streams: [] })
    expect(() => streamTitleArguments({ streams: Array(13).fill(youtube) })).toThrow()
    expect(() => scheduleArguments({ refresh: 'yes' })).toThrow()
    expect(() => scheduleArguments({ url: 'http://localhost' })).toThrow()
  })
  it.each([
    { ...youtube, channel: '../private' }, { ...youtube, videoId: '../../' }, { ...twitch, videoId: 'abcdefghijk' },
    { ...youtube, platform: 'kick' }, { ...youtube, url: 'http://localhost' }, { platform: 'youtube', channel: 'PGL' },
  ])('rejects untrusted stream addresses and malformed input %#', value => {
    expect(() => streamTitleArguments({ streams: [value] })).toThrow()
  })
})
