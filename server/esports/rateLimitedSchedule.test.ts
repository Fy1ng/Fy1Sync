import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from './fixtures/liquipedia-matches.json'
import { EsportsService, SCHEDULE_TTL_MS } from './schedule'
import { DEFAULT_COOLDOWN_MS, LiquipediaRateLimit, PARSE_INTERVAL_MS, pause } from './liquipediaRateLimit'
import { TeamLogoCache } from './teamLogos'
import { installNetworkPolicy, NetworkPolicy } from '../networkPolicy'

const NOW = Date.parse('2026-10-26T20:00:00Z')
const isParse = (input: unknown) => new URL(String(input)).searchParams.get('action') === 'parse'
const ok = (input: unknown) => Response.json(isParse(input) ? fixture : { query: { pages: [] } })
const limited = (retryAfter?: string) => new Response('<title>Rate Limited - Liquipedia</title>',
  { status: 429, statusText: 'Too Many Requests', headers: { 'content-type': 'text/html', ...(retryAfter ? { 'retry-after': retryAfter } : {}) } })

describe('Liquipedia upstream cooldown', () => {
  let root: string
  const services: EsportsService[] = []
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fy1sync-lp-429-'))
    vi.useFakeTimers(); vi.setSystemTime(NOW)
  })
  afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.dispose()))
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
    installNetworkPolicy(new NetworkPolicy(async () => 'DIRECT', () => 'system'))
  })
  function create(request: typeof fetch, resolve = async () => ['93.184.216.34']) {
    const service = new EsportsService({ userDataDir: root, version: '0.4.1', logos: null, request, resolve, log: () => {} })
    services.push(service)
    return service
  }

  it('does not dispatch for polling, manual refresh or a restarted service during a 429 block', async () => {
    let failing = true
    const request = vi.fn<typeof fetch>(async input => failing ? limited() : ok(input))
    const service = create(request)
    const first = await service.getCs2Schedule()
    expect(first).toMatchObject({ stale: true, matches: [], refreshReason: 'upstream-rate-limit', refreshAt: NOW + DEFAULT_COOLDOWN_MS,
      errorDetail: { status: 429, upstream: { title: 'Rate Limited - Liquipedia' } } })
    for (let minute = 1; minute <= 4; minute++) {
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await service.getCs2Schedule({ refresh: minute % 2 === 0 })
      expect(result.refreshAt).toBe(first.refreshAt)
      expect(result.errorDetail?.status).toBe(429)
    }
    const restarted = create(request)
    expect((await restarted.getCs2Schedule({ refresh: true })).refreshAt).toBe(first.refreshAt)
    expect(request).toHaveBeenCalledTimes(1)
    const budget = JSON.parse(await readFile(join(root, 'events', 'liquipedia-http-attempt.json'), 'utf8'))
    expect(budget.at).toBe(NOW)
    expect(budget.cooldown.count).toBe(1)
    failing = false
    await vi.advanceTimersByTimeAsync(DEFAULT_COOLDOWN_MS - 4 * 60_000)
    const recovered = await service.getCs2Schedule()
    expect(request.mock.calls.filter(([input]) => isParse(input))).toHaveLength(2)
    expect(recovered.matches.length).toBeGreaterThan(0)
    expect(recovered.stale).toBe(false)
    expect(recovered.refreshAt).toBeUndefined()
    expect(recovered.error).toBeUndefined()
  })

  it('keeps good cached matches visible and honors the server retry deadline', async () => {
    let failing = false
    const request = vi.fn<typeof fetch>(async input => isParse(input) && failing ? limited('120') : ok(input))
    const service = create(request)
    const first = await service.getCs2Schedule()
    failing = true
    await vi.advanceTimersByTimeAsync(SCHEDULE_TTL_MS)
    const blocked = await service.getCs2Schedule()
    expect(blocked).toMatchObject({ fetchedAt: first.fetchedAt, stale: true, matches: first.matches,
      refreshAt: NOW + SCHEDULE_TTL_MS + 120_000, refreshReason: 'upstream-rate-limit' })
    const calls = request.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    await service.getCs2Schedule({ refresh: true })
    expect(request).toHaveBeenCalledTimes(calls)
    failing = false
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await service.getCs2Schedule()).error).toBeUndefined()
  })

  it('blocks schedule and image requests when a background category lookup receives 429', async () => {
    const request = vi.fn<typeof fetch>(async input => isParse(input) ? ok(input) : limited())
    const service = create(request)
    await service.getCs2Schedule()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(request).toHaveBeenCalledTimes(2)
    const snapshot = await service.getCs2Schedule()
    expect(snapshot.refreshReason).toBe('upstream-rate-limit')
    expect(snapshot.matches.length).toBeGreaterThan(0)
    const logoRequest = vi.fn<typeof fetch>()
    const logos = new TeamLogoCache({ userDataDir: root, version: '0.4.1', request: logoRequest })
    try {
      await logos.ensure('/commons/images/a/ab/Example.png')
      expect(logoRequest).not.toHaveBeenCalled()
      service.setScheduleFocus({ eventPath: '/counterstrike/PGL/2026/Masters' })
      await vi.advanceTimersByTimeAsync(60_000)
      await service.getCs2Schedule({ refresh: true })
      expect(request).toHaveBeenCalledTimes(2)
      expect(new LiquipediaRateLimit(root).reserve()).toBe(false)
    } finally { await logos.dispose() }
  })

  it('reserves parse quota at actual dispatch after delayed DNS and preserves the 30 second gap', async () => {
    const request = vi.fn<typeof fetch>(async input => ok(input))
    const delayed = create(request, async () => { await pause(5_000, new AbortController().signal); return ['93.184.216.34'] })
    const first = delayed.getCs2Schedule()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await first
    expect(JSON.parse(await readFile(join(root, 'events', 'liquipedia-attempt.json'), 'utf8')).at).toBe(NOW + 5_000)
    await vi.advanceTimersByTimeAsync(PARSE_INTERVAL_MS - 5_000)
    const second = create(request)
    const refused = await second.getCs2Schedule({ refresh: true })
    expect(refused).toMatchObject({ refreshReason: 'parse-quota', refreshAt: NOW + 5_000 + PARSE_INTERVAL_MS })
    expect(request.mock.calls.filter(([input]) => isParse(input))).toHaveLength(1)
  })

  it('does not let minute polling erase or shorten the backoff after a transport failure', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))
    const service = create(request)
    const failed = await service.getCs2Schedule()
    for (let minute = 0; minute < 4; minute++) {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await service.getCs2Schedule()).toMatchObject({ error: failed.error, errorDetail: failed.errorDetail, refreshAt: NOW + SCHEDULE_TTL_MS, refreshReason: 'retry' })
    }
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not misclassify a local quota refusal as a system proxy failure', async () => {
    installNetworkPolicy(new NetworkPolicy(async () => 'PROXY 127.0.0.1:7890', () => 'system'))
    const request = vi.fn<typeof fetch>(async input => ok(input)), service = create(request)
    await service.getCs2Schedule()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await service.getCs2Schedule({ refresh: true })).toMatchObject({ stale: false, refreshReason: 'parse-quota', refreshAt: NOW + PARSE_INTERVAL_MS })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('accepts a newer cache without bypassing an active upstream block, blocked=%s', async blocked => {
    const request = vi.fn<typeof fetch>(async () => { if (blocked) return limited(); throw new Error('offline') })
    const service = create(request)
    await service.getCs2Schedule()
    await vi.advanceTimersByTimeAsync(1)
    await writeFile(join(root, 'events', 'liquipedia.json'), JSON.stringify({ schema: 1, fetchedAt: Date.now(), payload: fixture }))
    const cached = await service.getCs2Schedule()
    expect(cached.matches.length).toBeGreaterThan(0)
    expect(cached.stale).toBe(blocked)
    expect(cached.refreshReason).toBe(blocked ? 'upstream-rate-limit' : undefined)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
