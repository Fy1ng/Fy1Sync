import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { getDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from '../server/esports/fixtures/liquipedia-matches.json'
import { EsportsService, SCHEDULE_TTL_MS } from '../server/esports/schedule'
import { currentMatches, parseSchedule } from '../server/esports/parser'
import type { Cs2Schedule } from '../server/esports/types'
import { LIQUIPEDIA_INTERVAL_MS } from '../server/esports/liquipediaRateLimit'
import { ScheduleRelay, RELAY_POLL_MS } from './service'
import { localRequest } from './testHelpers'

const NOW = Date.parse('2026-10-26T20:00:00Z')
const isParse = (input: unknown) => new URL(String(input)).searchParams.get('action') === 'parse'

describe('relay upstream lifecycle', () => {
  let root: string
  const relays: ScheduleRelay[] = []
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fy1sync-relay-service-'))
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(async () => {
    await Promise.all(relays.splice(0).map(relay => relay.dispose()))
    vi.restoreAllMocks()
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  })

  function create(request: typeof fetch, offline = false, log: (message: string) => void = () => {}, resolve = async () => ['93.184.216.34']) {
    const relay = new ScheduleRelay({ dataDir: root, version: '0.4.1', request, resolve,
      logos: null, offline, log })
    relays.push(relay)
    return relay
  }

  it('starts cold without blocking HTTP and publishes each successful upstream result once', async () => {
    let release!: (value: Response) => void
    const request = vi.fn<typeof fetch>(async input => isParse(input)
      ? await new Promise<Response>(resolve => { release = resolve }) : Response.json({ query: { pages: [] } }))
    const log = vi.fn<(message: string) => void>()
    const relay = create(request, false, log)
    const port = await relay.start('127.0.0.1', 0)
    const pending = relay.poll()
    expect((await localRequest(port, '/v1/cs2/schedule')).status).toBe(503)
    expect(release).toBeTypeOf('function')
    release(Response.json(fixture))
    await pending
    const result = await localRequest(port, '/v1/cs2/schedule')
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body.toString())).toMatchObject({ schema: 1, fetchedAt: NOW, source: 'liquipedia', upstream: { limitedUntil: null } })
    const agent = new Headers(request.mock.calls[0]![1]?.headers).get('user-agent')
    expect(agent).toBe('Fy1Sync-schedule-relay/0.4.1 (https://github.com/Fy1ng/Fy1Sync; sync@fy1ng.cn)')
    await relay.poll()
    const entries = log.mock.calls.map(([value]) => JSON.parse(value))
    expect(entries[0]).toEqual({ type: 'started', host: '127.0.0.1', port, offline: false,
      autoSelectFamilyAttemptTimeoutMs: getDefaultAutoSelectFamilyAttemptTimeout() })
    expect(entries.filter(value => value.type === 'upstream-result')).toEqual([
      { type: 'upstream-result', ok: true, fetchedAt: NOW, matches: currentMatches(parseSchedule(fixture), NOW).length, cooldownUntil: null },
    ])
    expect(entries.every(value => !Object.hasOwn(value, 'ip') && !Object.hasOwn(value, 'body'))).toBe(true)
    await relay.dispose()
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ type: 'stopped' })
  })

  it('keeps the representation and ETag when a quiet poll supplies no new data', async () => {
    const relay = create(vi.fn<typeof fetch>(), true)
    await mkdir(join(root, 'events'), { recursive: true })
    await writeFile(join(root, 'events', 'liquipedia.json'), JSON.stringify({ schema: 1, fetchedAt: NOW, payload: fixture }))
    const port = await relay.start('127.0.0.1', 0)
    await relay.poll()
    const initial = await localRequest(port, '/v1/cs2/schedule')
    await vi.advanceTimersByTimeAsync(RELAY_POLL_MS)
    await relay.poll()
    expect((await localRequest(port, '/v1/cs2/schedule')).body).toEqual(initial.body)
    expect((await localRequest(port, '/v1/cs2/schedule', 'GET', { 'If-None-Match': initial.headers.etag! })).status).toBe(304)
  })

  it.each(['active', 'idle'] as const)('uses the background schedule cadence in %s mode', async mode => {
    const original = fixture.parse.text['*']
    const payload = mode === 'active' ? fixture : { parse: { text: {
      '*': original.replace(/class="timer-object[^"]*"/g, '$& data-finished="finished"'),
    } } }
    const parses: number[] = []
    const request = vi.fn<typeof fetch>(async input => {
      if (isParse(input)) { parses.push(Date.now()); return Response.json(payload) }
      return Response.json({ query: { pages: [] } })
    })
    const relay = create(request)
    await relay.start('127.0.0.1', 0)
    await relay.poll()
    await vi.advanceTimersByTimeAsync(SCHEDULE_TTL_MS - 1)
    expect(parses).toEqual([NOW])
    await vi.advanceTimersByTimeAsync(1)
    await relay.poll()
    expect(parses).toEqual([NOW, NOW + SCHEDULE_TTL_MS])
  })

  it('queues all waiting channel lookups in one poll and spaces their actual requests', async () => {
    const focuses = vi.spyOn(EsportsService.prototype, 'setScheduleFocus')
    const original = fixture.parse.text['*']
    const card = original.slice(0, original.indexOf('<div class="match-info">', 1))
    const longPath = `Extra/${'Long:'.repeat(150)}2026`
    const paths = [longPath, ...Array.from({ length: 9 }, (_, index) => `Extra${index}/2026`)]
    const extraEvents = paths.map(path => card.replaceAll('/counterstrike/PGL/2026/Masters#', `/counterstrike/${path}#`))
    const html = original + extraEvents.join('')
    const payload = { parse: { text: { '*': html } } }
    const requests: Array<{ title: string; at: number }> = []
    const request = vi.fn<typeof fetch>(async input => {
      if (isParse(input)) return Response.json(payload)
      const params = new URL(String(input)).searchParams
      if (params.get('prop') === 'extlinks') {
        requests.push({ title: params.get('titles')!, at: Date.now() })
        return Response.json({ query: { pages: [{ extlinks: [{ url: 'https://www.twitch.tv/pgl_cs2' }] }] } })
      }
      return Response.json({ query: { pages: [] } })
    })
    const relay = create(request)
    await relay.start('127.0.0.1', 0)
    await relay.poll()
    const calls = focuses.mock.calls.map(([args]) => args.eventPath)
    const waiting = calls.slice(0, -1)
    expect(waiting).toHaveLength(11)
    expect(waiting).toContain(`/counterstrike/${longPath}`)
    expect(waiting).toEqual([...new Set(waiting)])
    expect(waiting).toContain(calls.at(-1))
    await vi.advanceTimersByTimeAsync(LIQUIPEDIA_INTERVAL_MS * (waiting.length + 2))
    expect(requests.map(item => item.title).sort()).toEqual(waiting.map(path => decodeURIComponent(path!.slice('/counterstrike/'.length))).sort())
    expect(requests.slice(1).every((item, index) => item.at - requests[index]!.at >= LIQUIPEDIA_INTERVAL_MS)).toBe(true)
  })

  it('publishes the remaining data and logs skipped counts only when they change', async () => {
    const clean: Cs2Schedule = { fetchedAt: NOW, source: 'liquipedia', attribution: 'Liquipedia', stale: false, matches: parseSchedule(fixture) }
    const bad = structuredClone(clean)
    bad.matches[0]!.teams[0].name = 'a'.repeat(501)
    const log = vi.fn<(message: string) => void>()
    const snapshots = vi.spyOn(EsportsService.prototype, 'getCs2Schedule').mockResolvedValue(bad)
    const relay = create(vi.fn<typeof fetch>(), true, log)
    const port = await relay.start('127.0.0.1', 0)
    await relay.poll()
    const published = await localRequest(port, '/v1/cs2/schedule')
    expect(published.status).toBe(200)
    expect(JSON.parse(published.body.toString()).matches).toHaveLength(clean.matches.length - 1)
    await vi.advanceTimersByTimeAsync(RELAY_POLL_MS * 2)
    const loggedCounts = () => log.mock.calls.map(([value]) => JSON.parse(value)).filter(value => value.type === 'wire-skipped')
    expect(loggedCounts()).toEqual([{ type: 'wire-skipped', matches: 1, streams: 0 }])
    snapshots.mockResolvedValue(clean)
    await vi.advanceTimersByTimeAsync(RELAY_POLL_MS * 2)
    expect(loggedCounts()).toEqual([{ type: 'wire-skipped', matches: 1, streams: 0 }, { type: 'wire-skipped', matches: 0, streams: 0 }])
  })

  const bodyMarker = 'DO_NOT_LOG_UPSTREAM_BODY'
  const queryMarker = 'DO_NOT_LOG_QUERY_VALUE'
  const headerMarker = 'DO_NOT_LOG_UPSTREAM_HEADER'
  const contaminatedId = `Ab\r\n\t\x1b\u2028\u4e2d${'c'.repeat(130)}`
  const validId = `Ab${'c'.repeat(118)}`

  it.each([
    { scenario: 'HTTP error', response: () => Response.json({ error: { code: bodyMarker, info: bodyMarker } },
      { status: 503, statusText: headerMarker, headers: { 'Retry-After': headerMarker } }), expected: { errorKind: 'http', status: 503 } },
    { scenario: 'API error', response: () => Response.json({ error: { code: 'badvalue', info: bodyMarker } }),
      expected: { errorKind: 'api', code: 'badvalue' } },
    { scenario: 'API rate limit', response: () => Response.json({ error: { code: 'ratelimited', info: bodyMarker } }),
      expected: { errorKind: 'api', code: 'ratelimited', reason: 'upstream-rate-limit' } },
    { scenario: 'long API code', response: () => Response.json({ error: { code: contaminatedId } }),
      expected: { errorKind: 'api', code: validId } },
    { scenario: 'URL in API code', response: () => Response.json({ error: { code: `/path?value=${queryMarker}` } }),
      expected: { errorKind: 'api' }, absent: 'code' },
    { scenario: 'unexpected JSON shape', response: () => Response.json({ text: bodyMarker }),
      expected: { errorKind: 'format', selector: 'parse.text.*' } },
    { scenario: 'changed HTML layout', response: () => Response.json({ parse: { text: { '*': `<div>${bodyMarker}</div>` } } }),
      expected: { errorKind: 'format', selector: '.match-ticker-card or .match-info' } },
    { scenario: 'invalid JSON', response: () => new Response(`<html>${bodyMarker}</html>`),
      expected: { errorKind: 'other', name: 'SyntaxError' } },
    { scenario: 'fetch failure without a code', response: () => { throw new TypeError(bodyMarker) },
      expected: { errorKind: 'other', name: 'TypeError' }, absent: 'detail' },
    { scenario: 'safeFetch refusal', response: () => { throw Object.assign(new Error(bodyMarker), { name: 'ProxyError', reason: 'upstream-failed' }) },
      expected: { errorKind: 'other', name: 'ProxyError', detail: 'upstream-failed' } },
    { scenario: 'long error name', response: () => { throw Object.assign(new Error(bodyMarker), { name: contaminatedId }) },
      expected: { errorKind: 'other', name: validId } },
  ])('logs a bounded summary for $scenario', async ({ response, expected, absent }) => {
    const request = vi.fn<typeof fetch>(async () => response())
    const log = vi.fn<(message: string) => void>()
    await create(request, false, log).poll()
    expect(request).toHaveBeenCalledTimes(1)
    const lines = log.mock.calls.map(([line]) => line)
    const results = lines.map(line => JSON.parse(line)).filter(entry => entry.type === 'upstream-result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: false, fetchedAt: 0, matches: 0, ...expected })
    if (absent) expect(results[0]).not.toHaveProperty(absent)
    for (const line of lines) {
      expect(line).toMatch(/^[\x20-\x7e]+$/)
      expect(line).not.toContain(bodyMarker)
      expect(line).not.toContain(queryMarker)
      expect(line).not.toContain(headerMarker)
    }
  })

  it.each(['headers', 'body'])('logs the actual schedule timeout while waiting for %s', async phase => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init!.signal!
      if (phase === 'headers') return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true })
      } }))
    })
    const log = vi.fn<(message: string) => void>()
    const pending = create(request, false, log).poll()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(request).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual({ type: 'upstream-result', ok: false,
      fetchedAt: 0, matches: 0, reason: 'schedule-unavailable', errorKind: 'timeout', name: 'TimeoutError', cooldownUntil: null })
  })

  it.each(['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET'])('logs the underlying %s network code', async code => {
    const underlying = Object.assign(new Error(bodyMarker), { code })
    const cause = code === 'ETIMEDOUT' ? new AggregateError([underlying]) : underlying
    const request = vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed', { cause }) })
    const log = vi.fn<(message: string) => void>()
    await create(request, false, log).poll()
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual({ type: 'upstream-result', ok: false,
      fetchedAt: 0, matches: 0, reason: 'schedule-unavailable', errorKind: 'network', code, cooldownUntil: null })
    expect(log.mock.calls.flat().join('')).not.toContain(bodyMarker)
  })

  it('keeps the DNS code when URL validation fails before dispatch', async () => {
    const request = vi.fn<typeof fetch>()
    const log = vi.fn<(message: string) => void>()
    await create(request, false, log, async () => { throw Object.assign(new Error(bodyMarker), { code: 'ENOTFOUND' }) }).poll()
    expect(request).not.toHaveBeenCalled()
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual({ type: 'upstream-result', ok: false,
      fetchedAt: 0, matches: 0, reason: 'schedule-unavailable', errorKind: 'network', code: 'ENOTFOUND', cooldownUntil: null })
    expect(log.mock.calls.flat().join('')).not.toContain(bodyMarker)
  })

  it('logs one sorted set of parse skips only when it changes across parsed schedules', async () => {
    const cards = fixture.parse.text['*'].split(/(?=<div class="match-info">)/)
    const opponent = 'match-info-header-opponent'
    const score = 'match-info-header-scoreholder-upper'
    const brokenCard = (index: number, selector: string) => cards[index]!.replaceAll(`class="${selector}"`, 'class="wrong"')
    const withSkips = (first = opponent, second = score) => [brokenCard(0, first), brokenCard(1, second), ...cards.slice(2)]
    let html: string | null = withSkips().join('')
    const request = vi.fn<typeof fetch>(async input => {
      if (!isParse(input)) return Response.json({ query: { pages: [] } })
      return html === null ? new Response(bodyMarker, { status: 503 }) : Response.json({ parse: { text: { '*': html } } })
    })
    const log = vi.fn<(message: string) => void>()
    const relay = create(request, false, log)
    const updates = () => log.mock.calls.map(([line]) => JSON.parse(line)).filter(entry => entry.type === 'parse-skipped')
    await relay.poll()
    const first = { type: 'parse-skipped', selectors: [`.${opponent}`, `.${score}`] }
    expect(updates()).toEqual([first])
    for (const next of [[...withSkips(score, opponent), brokenCard(2, opponent)].join(''), null, withSkips().join('')]) {
      html = next
      await vi.advanceTimersByTimeAsync(SCHEDULE_TTL_MS)
      await relay.poll()
      expect(updates()).toEqual([first])
    }
    html = [brokenCard(0, opponent), ...cards.slice(1)].join('')
    await vi.advanceTimersByTimeAsync(SCHEDULE_TTL_MS)
    await relay.poll()
    html = cards.join('')
    await vi.advanceTimersByTimeAsync(SCHEDULE_TTL_MS)
    await relay.poll()
    expect(updates()).toEqual([first, { type: 'parse-skipped', selectors: [`.${opponent}`] }, { type: 'parse-skipped', selectors: [] }])
    expect(log.mock.calls.flat().join('')).not.toContain(bodyMarker)
  })

  it('retains previously fetched schedule data and publishes an upstream cooldown after a 429', async () => {
    let limited = false
    const request = vi.fn<typeof fetch>(async input => isParse(input)
      ? limited ? new Response('DO NOT LOG UPSTREAM BODY', { status: 429, headers: { 'Retry-After': '900' } }) : Response.json(fixture)
      : Response.json({ query: { pages: [] } }))
    const log = vi.fn<(message: string) => void>()
    const relay = create(request, false, log)
    const port = await relay.start('127.0.0.1', 0)
    await relay.poll()
    const initial = JSON.parse((await localRequest(port, '/v1/cs2/schedule')).body.toString())
    limited = true
    await vi.advanceTimersByTimeAsync(SCHEDULE_TTL_MS)
    await relay.poll()
    const staleResponse = await localRequest(port, '/v1/cs2/schedule')
    const stale = JSON.parse(staleResponse.body.toString())
    expect(staleResponse.status).toBe(200)
    expect(stale.fetchedAt).toBe(initial.fetchedAt)
    expect(stale.matches.map((match: { id: string }) => match.id)).toEqual(initial.matches.map((match: { id: string }) => match.id))
    expect(stale.upstream.limitedUntil).toBeGreaterThan(Date.now())
    expect(stale.verification).toBeUndefined()
    const count = request.mock.calls.length
    await vi.advanceTimersByTimeAsync(3 * RELAY_POLL_MS)
    expect(request.mock.calls.length).toBe(count)
    const entries = log.mock.calls.map(([value]) => JSON.parse(value))
    expect(entries.some(value => value.type === 'upstream-result' && !value.ok && value.status === 429 && value.cooldownUntil > Date.now())).toBe(true)
    expect(log.mock.calls.flat().join('')).not.toContain('DO NOT LOG UPSTREAM BODY')
  })

  it('restores schedule data and logos from disk without any offline requests or cache writes', async () => {
    await mkdir(join(root, 'events', 'logos'), { recursive: true })
    const cache = JSON.stringify({ schema: 1, fetchedAt: NOW, payload: fixture })
    await writeFile(join(root, 'events', 'liquipedia.json'), cache)
    const paths = new Map<string, string>()
    const parsed = parseSchedule(fixture, paths)
    const logoPath = paths.get(`${parsed[0]!.id}:0`)!
    const logoKey = createHash('sha256').update(logoPath).digest('hex')
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    await writeFile(join(root, 'events', 'logos', `${logoKey}.png`), bytes)
    const request = vi.fn<typeof fetch>(async () => { throw new Error('Offline mode attempted a request') })
    const relay = new ScheduleRelay({ dataDir: root, version: '0.4.1', offline: true, request, log: () => {} })
    relays.push(relay)
    const port = await relay.start('127.0.0.1', 0)
    await relay.poll()
    const restored = JSON.parse((await localRequest(port, '/v1/cs2/schedule')).body.toString())
    expect(restored.fetchedAt).toBe(NOW)
    expect(restored.matches).toHaveLength(currentMatches(parsed, NOW).length)
    expect(restored.matches.find((match: { id: string }) => match.id === parsed[0]!.id).teams[0].logo).toEqual({
      key: logoKey, sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    expect((await localRequest(port, `/v1/cs2/logos/${logoKey}`)).body).toEqual(bytes)
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    await relay.poll()
    expect(request).not.toHaveBeenCalled()
    expect((await localRequest(port, '/healthz')).status).toBe(503)
    expect(await readFile(join(root, 'events', 'liquipedia.json'), 'utf8')).toBe(cache)
    await relay.dispose()
    const restarted = create(request, true)
    const nextPort = await restarted.start('127.0.0.1', 0)
    await restarted.poll()
    expect(JSON.parse((await localRequest(nextPort, '/v1/cs2/schedule')).body.toString()).fetchedAt).toBe(NOW)
    expect(request).not.toHaveBeenCalled()
  })

  it('continues polling after a thrown refresh and clears all owned timers on dispose', async () => {
    const request = vi.fn<typeof fetch>(async input => Response.json(isParse(input) ? fixture : { query: { pages: [] } }))
    const log = vi.fn<(message: string) => void>()
    const upstream = vi.spyOn(EsportsService.prototype, 'getCs2Schedule').mockRejectedValueOnce(new Error('Transient failure'))
    const relay = create(request, false, log)
    await relay.start('127.0.0.1', 0)
    await relay.poll()
    expect(log.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual({ type: 'upstream-result', ok: false,
      reason: 'refresh-loop-failed', errorKind: 'other', name: 'Error' })
    const poll = vi.spyOn(relay, 'poll')
    await vi.advanceTimersByTimeAsync(RELAY_POLL_MS)
    await relay.poll()
    expect(poll).toHaveBeenCalled()
    expect(upstream.mock.calls.length).toBeGreaterThan(1)
    expect(request).toHaveBeenCalled()
    await relay.dispose()
    expect(vi.getTimerCount()).toBe(0)
    const calls = request.mock.calls.length
    await vi.advanceTimersByTimeAsync(SCHEDULE_TTL_MS)
    expect(request.mock.calls.length).toBe(calls)
    await relay.dispose()
  })
})
