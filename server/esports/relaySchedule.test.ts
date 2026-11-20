import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { teamLogoResponse } from '../../electron/teamLogoRoute'
import { metadataConfig } from '../config'
import { NetworkPolicy } from '../networkPolicy'
import { RelayScheduleService, scheduleRelayOrigin } from './relaySchedule'
import { LOGO_MAX_BYTES, readTeamLogo } from './teamLogos'
import type { RelayLogo, RelayMatch, RelaySchedule } from './relayProtocol'

const NOW = Date.parse('2026-10-26T20:00:00Z')
const ORIGIN = 'https://schedule.fy1ng.cn'
const ETAG = '"first"'
const PNG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1)
const NEXT_PNG = Uint8Array.of(...PNG, 2)
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const logo = (key: string, sha256 = sha(PNG)): RelayLogo => ({ key, sha256 })
const match = (id: string, over: Partial<RelayMatch> = {}): RelayMatch => ({ id, startsAt: NOW, state: 'upcoming', bestOf: 3, score: null,
  teams: [{ name: 'Alpha', short: null, logo: null }, { name: 'Beta', short: null, logo: null }],
  tournament: { name: 'PGL', stage: null, tier: null, url: 'https://liquipedia.net/counterstrike/PGL/2026/Masters', logo: null },
  streams: [{ platform: 'youtube', entry: 'PGL', channel: null, missing: null, videoId: 'sx5tneE-ILg' }], ...over })
const wire = (over: Partial<RelaySchedule> = {}): RelaySchedule => ({ schema: 1, fetchedAt: NOW, generatedAt: NOW,
  source: 'liquipedia', attribution: 'Liquipedia (CC-BY-SA 3.0)', upstream: { limitedUntil: null }, matches: [match('first')], ...over })
const response = (value = wire()) => Response.json(value, { headers: { ETag: ETAG } })
const options = { resolve: async () => ['93.184.216.34'], version: '0.4.1' }
let root: string
const services: RelayScheduleService[] = []

function setup(request: typeof fetch, bundledLogoDir?: string, origin = ORIGIN) {
  const onEvent = vi.fn()
  const service = new RelayScheduleService({ ...options, userDataDir: root, bundledLogoDir, request, onEvent }, origin)
  services.push(service)
  return { service, onEvent }
}

function disk() { return JSON.parse(readFileSync(join(root, 'events', 'relay-schedule.json'), 'utf8')) }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fy1sync-relay-client-'))
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(async () => {
  try { await Promise.all(services.splice(0).map(service => service.dispose())) }
  finally { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) }
})

describe('relay client', () => {
  it('persists canonical data from a 200 and conditionally reads at 60 seconds without writing on a 304', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...wire(), error: 'future field', debug: 1 }, { headers: { ETag: ETAG } }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { ETag: ETAG } }))
    const { service, onEvent } = setup(request)
    const first = await service.getCs2Schedule()
    expect(first).toMatchObject({ stale: false, fetchedAt: NOW, matches: [{ streams: [{ url: 'https://www.youtube.com/watch?v=sx5tneE-ILg' }] }] })
    expect(first).not.toHaveProperty('verification')
    expect(String(request.mock.calls[0]![0])).toBe(`${ORIGIN}/v1/cs2/schedule`)
    expect(request.mock.calls[0]![1]?.headers).toMatchObject({ 'User-Agent': 'Fy1Sync/0.4.1 (local desktop app; sync@fy1ng.cn)' })
    expect(disk()).toEqual({ origin: ORIGIN, etag: ETAG, schedule: wire(), receivedAt: NOW })
    const cacheFile = join(root, 'events', 'relay-schedule.json')
    utimesSync(cacheFile, new Date(NOW), new Date(NOW))
    const mtime = statSync(cacheFile).mtimeMs
    await vi.advanceTimersByTimeAsync(59_999)
    expect(await service.getCs2Schedule()).toEqual(first)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(1)
    expect(await service.getCs2Schedule()).toEqual(first)
    await vi.advanceTimersByTimeAsync(0)
    expect(request.mock.calls[1]![1]?.headers).toMatchObject({ 'If-None-Match': ETAG })
    expect(disk().receivedAt).toBe(NOW)
    expect(statSync(cacheFile).mtimeMs).toBe(mtime)
    expect(await service.getCs2Schedule()).toEqual(first)
    expect(onEvent.mock.calls).toEqual([[{ topic: 'cs2-schedule', data: { type: 'schedule-updated' } }]])
  })

  it('waits until five minutes for an unattended background read', async () => {
    const request = vi.fn<typeof fetch>(async () => response())
    const { service } = setup(request)
    await service.getCs2Schedule()
    await vi.advanceTimersByTimeAsync(299_999)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('returns the disk snapshot while a background request is pending and makes an explicit refresh join it', async () => {
    const first = setup(async () => response()).service
    await first.getCs2Schedule()
    await first.dispose()
    let release!: (value: Response) => void
    const request = vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve }))
    const { service, onEvent } = setup(request)
    const ready = vi.fn(), refreshed = vi.fn()
    const plain = service.getCs2Schedule().then(ready)
    const manual = service.getCs2Schedule({ refresh: true }).then(refreshed)
    await vi.advanceTimersByTimeAsync(0)
    try {
      expect(request).toHaveBeenCalledTimes(1)
      expect(ready).toHaveBeenCalledWith(expect.objectContaining({ matches: [expect.objectContaining({ id: 'first' })] }))
      expect(refreshed).not.toHaveBeenCalled()
      expect(onEvent).not.toHaveBeenCalled()
    } finally { release(response(wire({ matches: [match('updated')] }))) }
    await Promise.all([plain, manual])
    expect(refreshed).toHaveBeenCalledWith(expect.objectContaining({ matches: [expect.objectContaining({ id: 'updated' })] }))
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ topic: 'cs2-schedule', data: { type: 'schedule-updated' } })
    expect((await service.getCs2Schedule()).matches[0]?.id).toBe('updated')
  })

  it('filters and sorts cached matches using the same time window on every read', async () => {
    const hours = 60 * 60_000
    const matches = [match('future', { startsAt: NOW + 48 * hours }), match('too-far', { startsAt: NOW + 48 * hours + 2 }),
      match('past', { startsAt: NOW - 12 * hours }), match('expired', { startsAt: NOW - 12 * hours - 1 }),
      match('live', { state: 'live' })]
    const { service } = setup(async () => response(wire({ matches })))
    const ids = async () => (await service.getCs2Schedule()).matches.map(match => match.id)
    expect(await ids()).toEqual(['live', 'past', 'future'])
    await vi.advanceTimersByTimeAsync(1)
    expect(await ids()).toEqual(['live', 'future'])
    await vi.advanceTimersByTimeAsync(1)
    expect(await ids()).toEqual(['live', 'future', 'too-far'])
  })

  it('reopens the disk snapshot offline and rejects invalid data without replacing it', async () => {
    const first = setup(async () => response()).service
    await first.getCs2Schedule()
    await first.dispose()
    const invalid = wire({ matches: [match('rejected')] })
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(Response.json({ ...invalid, schema: 2 }, { headers: { ETag: '"bad"' } }))
    const { service } = setup(request)
    expect(await service.getCs2Schedule()).toMatchObject({ fetchedAt: NOW, matches: [{ id: 'first' }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(await service.getCs2Schedule()).toMatchObject({ fetchedAt: NOW, stale: true, error: '赛程暂时无法读取，请稍后重试',
      errorDetail: { message: 'offline' }, refreshAt: NOW + 30_000, refreshReason: 'retry', matches: [{ id: 'first' }] })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await service.getCs2Schedule()).toMatchObject({ stale: true, matches: [{ id: 'first' }], errorDetail: { message: 'Invalid relay schedule' } })
    expect(disk()).toEqual({ origin: ORIGIN, receivedAt: NOW, etag: ETAG, schedule: wire() })
  })

  it('enforces the ten-second manual floor and coalesces concurrent reads', async () => {
    let release!: (result: Response) => void
    const request = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockResolvedValueOnce(response(wire({ matches: [match('next')] })))
    const { service, onEvent } = setup(request)
    const settled = vi.fn()
    const replies = [service.getCs2Schedule(), service.getCs2Schedule({ refresh: true }), service.getCs2Schedule()]
    void replies[0]!.then(settled)
    await vi.advanceTimersByTimeAsync(0)
    try {
      expect(request).toHaveBeenCalledTimes(1)
      expect(settled).not.toHaveBeenCalled()
    } finally { release(response()) }
    expect(await Promise.all(replies)).toEqual(Array(3).fill(await replies[0]))
    await vi.advanceTimersByTimeAsync(9_999)
    await service.getCs2Schedule({ refresh: true })
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await service.getCs2Schedule({ refresh: true })).toMatchObject({ matches: [{ id: 'next' }] })
    expect(request).toHaveBeenCalledTimes(2)
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it('retries failed polls with capped backoff, resets on success and clears timers on dispose', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: 'not-ready' }, { status: 503, headers: { 'Retry-After': '30' } }))
    const { service } = setup(request)
    let current = NOW
    for (const [index, delay] of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000].entries()) {
      expect(await service.getCs2Schedule()).toMatchObject({ stale: true, refreshAt: current + delay, refreshReason: 'retry',
        errorDetail: { status: 503, retryAfter: '30' } })
      await vi.advanceTimersByTimeAsync(delay - 1)
      await service.getCs2Schedule({ refresh: true })
      expect(request).toHaveBeenCalledTimes(index + 1)
      if (index === 5) request.mockResolvedValueOnce(response())
      await vi.advanceTimersByTimeAsync(1)
      current += delay
    }
    expect(await service.getCs2Schedule()).toMatchObject({ stale: true, matches: [{ id: 'first' }] })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(await service.getCs2Schedule()).toMatchObject({ refreshAt: current + 330_000 })
    await service.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(request).toHaveBeenCalledTimes(8)
  })

  it('marks old and cooling schedules stale, never offering verification or forcing network via compatibility methods', async () => {
    const until = NOW + 500_000
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(wire({ upstream: { limitedUntil: until } })))
      .mockResolvedValueOnce(response(wire({ fetchedAt: NOW - 900_001 })))
    const { service } = setup(request)
    expect(service.setScheduleFocus({ eventPath: '/counterstrike/PGL' })).toEqual({ updated: true })
    expect(() => service.setScheduleFocus({ eventPath: 'https://example.invalid' })).toThrow()
    const open = vi.fn(async () => {})
    await expect(service.openLiquipediaVerification(open)).resolves.toEqual({ opened: true })
    expect(open).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
    const cooling = await service.getCs2Schedule()
    expect(cooling).toMatchObject({ stale: true, error: '赛程更新受限，暂时显示上次结果', refreshAt: until, refreshReason: 'upstream-rate-limit' })
    expect(cooling).not.toHaveProperty('verification')
    await expect(service.refreshCs2ScheduleAfterVerification({ round: 'dead:beef' })).resolves.toEqual({ ...cooling, verificationResult: 'not-attempted' })
    await expect(service.refreshCs2ScheduleAfterVerification({ round: 'invalid/path' })).rejects.toThrow()
    expect(request).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10_000)
    const old = await service.getCs2Schedule({ refresh: true })
    expect(old).toMatchObject({ stale: true, fetchedAt: NOW - 900_001 })
    expect(old).not.toHaveProperty('error')
    expect(old).not.toHaveProperty('verification')
  })

  it('keeps the original oEmbed and Twitch GQL API and cache behavior', async () => {
    const request = vi.fn<typeof fetch>(async input => new URL(String(input)).hostname === 'www.youtube.com'
      ? Response.json({ title: '[A] Event' }) : Response.json({ data: { user: { stream: { title: 'B Stream', type: 'live' } } } }))
    const { service } = setup(request)
    const youtube = { platform: 'youtube', channel: 'PGL', videoId: 'sx5tneE-ILg' } as const
    const twitch = { platform: 'twitch', channel: 'pgl_cs2', videoId: null } as const
    const handle = { ...youtube, videoId: null }
    const args = { streams: [youtube, twitch, youtube, handle] }
    const titles = await service.getStreamTitles(args)
    expect(titles).toEqual([{ ...youtube, title: '[A] Event', stage: 'A', live: null },
      { ...twitch, title: 'B Stream', stage: 'B', live: true }, { ...handle, title: null, stage: null, live: null }])
    expect(await service.getStreamTitles(args)).toEqual(titles)
    expect(request).toHaveBeenCalledTimes(2)
    const urls = request.mock.calls.map(([url, init]) => [String(url), init?.method])
    expect(urls).toContainEqual(['https://gql.twitch.tv/gql', 'POST'])
    expect(urls).toContainEqual(['https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dsx5tneE-ILg&format=json', 'GET'])
  })
})

describe('relay client logos', () => {
  const crest = (id: string, first: RelayLogo, second: RelayLogo | null = null, state: RelayMatch['state'] = 'upcoming') => match(id,
    { state, teams: [{ name: 'Alpha', short: null, logo: first }, { name: 'Beta', short: null, logo: second }] })

  it('uses installed and bundled logos, downloads a changed crest, and preserves original files', async () => {
    const bundled = join(root, 'bundle'), legacy = join(root, 'events', 'logos')
    mkdirSync(join(bundled, 'events', 'logos'), { recursive: true })
    mkdirSync(legacy, { recursive: true })
    for (const key of ['installed', 'changed']) writeFileSync(join(legacy, `${key}.png`), PNG)
    writeFileSync(join(bundled, 'events', 'logos', 'bundle.png'), PNG)
    const tournament = { ...match('live').tournament, logo: logo('bundle') }
    const matches = [crest('live', logo('installed'), logo('changed', sha(NEXT_PNG)), 'live')]
    matches[0]!.tournament = tournament
    let complete!: (value: Response) => void
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(wire({ matches })))
      .mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const { service, onEvent } = setup(request, bundled)
    const first = (await service.getCs2Schedule()).matches[0]!
    expect(first.teams.map(team => team.logo)).toEqual([`app://app/team-logo/installed?v=${sha(PNG)}`, null])
    expect(first.tournament.logo).toBe(`app://app/team-logo/bundle?v=${sha(PNG)}`)
    await vi.advanceTimersByTimeAsync(0)
    expect(String(request.mock.calls[1]![0])).toBe(`${ORIGIN}/v1/cs2/logos/changed?v=${sha(NEXT_PNG)}`)
    complete(new Response(NEXT_PNG))
    await vi.advanceTimersByTimeAsync(100)
    const local = (await service.getCs2Schedule()).matches[0]!.teams[1].logo
    expect(local).toBe(`app://app/team-logo/changed?v=${sha(NEXT_PNG)}`)
    expect(teamLogoResponse(new Request(local!), root, bundled).status).toBe(200)
    expect(readFileSync(join(legacy, 'changed.png'))).toEqual(Buffer.from(PNG))
    expect(onEvent).toHaveBeenCalledWith({ topic: 'cs2-schedule', data: { type: 'logos-updated' } })
  })

  it('limits parallel downloads to four and prioritizes live matches', async () => {
    const matches = [crest('upcoming', logo('future')), ...Array.from({ length: 4 }, (_, index) => crest(`live${index}`, logo(`live${index}`), null, 'live'))]
    const pending: Array<(value: Response) => void> = []
    const request = vi.fn<typeof fetch>((input, init) => String(input).endsWith('/schedule') ? Promise.resolve(response(wire({ matches })))
      : new Promise((resolve, reject) => { pending.push(resolve); init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }) }))
    const { service } = setup(request)
    await service.getCs2Schedule()
    await vi.advanceTimersByTimeAsync(0)
    expect(pending).toHaveLength(4)
    expect(request.mock.calls.slice(1).map(([url]) => new URL(String(url)).pathname)).toEqual([0, 1, 2, 3].map(index => `/v1/cs2/logos/live${index}`))
    pending[0]!(new Response(PNG))
    await vi.advanceTimersByTimeAsync(0)
    expect(pending).toHaveLength(5)
    expect(String(request.mock.calls[5]![0])).toContain('/logos/future?')
  })

  it('rejects an invalid hash, an invalid format and oversized streamed bytes, delaying retries ten minutes', async () => {
    const huge = new Uint8Array(LOGO_MAX_BYTES + 1), invalid = Uint8Array.of(1, 2, 3)
    const matches = [crest('bad', logo('bad'), logo('huge', sha(huge))), crest('format', logo('format', sha(invalid)))]
    const request = vi.fn<typeof fetch>(async input => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/schedule')) return response(wire({ matches }))
      return new Response(path.endsWith('/huge') ? huge : path.endsWith('/format') ? invalid : NEXT_PNG)
    })
    const { service } = setup(request)
    await service.getCs2Schedule()
    await vi.advanceTimersByTimeAsync(0)
    for (const key of ['bad', 'huge', 'format']) expect(readTeamLogo(root, key)).toBeNull()
    const countDownloads = () => request.mock.calls.filter(([url]) => String(url).includes('/logos/')).length
    expect(countDownloads()).toBe(3)
    await vi.advanceTimersByTimeAsync(599_999)
    expect(countDownloads()).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(countDownloads()).toBe(6)
  })
})

describe('relay network policy', () => {
  it('allows only validated startup origins and leaves the desktop Liquipedia host out', () => {
    for (const raw of ['http://example.invalid:4040', 'http://localhost', 'http://127.1:5081', 'http://localhost:0', 'http://localhost:65536',
      'https://x.invalid/path', 'https://name:secret@x.invalid', 'https://x.invalid/?a=1', 'https://liquipedia.net', 'file:///tmp']) {
      expect(scheduleRelayOrigin(raw)).toBe(ORIGIN)
    }
    expect(scheduleRelayOrigin('https://example.invalid:8443/')).toBe('https://example.invalid:8443')
    expect(scheduleRelayOrigin('http://127.0.0.1:5032')).toBe('http://127.0.0.1:5032')
    expect(metadataConfig().hosts).toEqual(['schedule.fy1ng.cn', 'www.youtube.com', 'gql.twitch.tv'])
  })

  it('accepts only the chosen local or HTTPS override through safeFetch', async () => {
    for (const origin of ['http://localhost:80', 'http://localhost:5081', 'http://127.0.0.1:5081', 'https://example.invalid:8443']) {
      const request = vi.fn<typeof fetch>(async () => response())
      expect(await setup(request, undefined, origin).service.getCs2Schedule()).toMatchObject({ stale: false })
      expect(String(request.mock.calls[0]![0])).toBe(`${new URL(origin).origin}/v1/cs2/schedule`)
    }
  })

  it('defaults the production relay to direct without changing system mode or foreign hosts', async () => {
    const proxy = vi.fn(async () => 'PROXY proxy.invalid:8080')
    let mode: 'direct' | 'system' = 'direct'
    const policy = new NetworkPolicy(proxy, () => mode)
    expect(await policy.context().route(ORIGIN)).toEqual({ kind: 'direct' })
    expect(proxy).not.toHaveBeenCalled()
    expect(await policy.context().route('https://www.youtube.com')).toMatchObject({ kind: 'http' })
    expect(await policy.context().route('https://another.fy1ng.cn')).toMatchObject({ kind: 'http' })
    mode = 'system'
    expect(await policy.context().route(ORIGIN)).toMatchObject({ kind: 'http' })
  })
})
