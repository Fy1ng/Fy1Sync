import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATTRIBUTION } from '../server/esports/schedule'
import { parseSchedule } from '../server/esports/parser'
import { toRelaySchedule } from '../server/esports/relayProtocol'
import fixture from '../server/esports/fixtures/liquipedia-matches.json'
import { RelayHttp, RELAY_MAX_HEADER_BYTES, RELAY_MAX_URL_BYTES } from './http'
import { localRequest } from './testHelpers'

const NOW = Date.parse('2026-10-26T20:00:00Z')
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const sha256 = createHash('sha256').update(png).digest('hex')

describe('relay HTTP endpoints', () => {
  let root: string
  let http: RelayHttp
  let port: number
  let now: number
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fy1sync-relay-http-'))
    now = NOW
    http = new RelayHttp(root, () => now)
    port = await http.listen('127.0.0.1', 0)
  })
  afterEach(async () => { await http.close(); await rm(root, { recursive: true, force: true }) })
  const schedule = () => toRelaySchedule({ fetchedAt: NOW, source: 'liquipedia', attribution: ATTRIBUTION,
    stale: false, matches: parseSchedule(fixture) }, NOW, null).schedule

  it('returns not-ready and an unhealthy cold-start snapshot', async () => {
    const response = await localRequest(port, '/v1/cs2/schedule')
    expect(response.status).toBe(503)
    expect(response.headers['retry-after']).toBe('30')
    expect(JSON.parse(response.body.toString())).toEqual({ error: 'not-ready' })
    const head = await localRequest(port, '/v1/cs2/schedule', 'HEAD')
    expect(head.status).toBe(503)
    expect(head.body.length).toBe(0)
    const health = await localRequest(port, '/healthz')
    expect(health.status).toBe(503)
    expect(JSON.parse(health.body.toString())).toEqual({ ok: false, fetchedAt: null, ageSeconds: null, matches: 0, cooldownUntil: null })
  })

  it('serves JSON with a strong ETag, conditional requests and HEAD', async () => {
    const value = schedule()
    http.update(value, null)
    const response = await localRequest(port, '/v1/cs2/schedule')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body.toString())).toEqual(value)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['cache-control']).toBe('public, max-age=15')
    expect(response.headers.etag).toBe('"' + createHash('sha256').update(response.body).digest('hex') + '"')
    const unchanged = await localRequest(port, '/v1/cs2/schedule', 'GET', { 'If-None-Match': response.headers.etag! })
    expect(unchanged.status).toBe(304)
    expect(unchanged.body.length).toBe(0)
    expect(unchanged.headers['content-length']).toBeUndefined()
    expect((await localRequest(port, '/v1/cs2/schedule', 'GET', { 'If-None-Match': 'W/' + response.headers.etag! })).status).toBe(304)
    const head = await localRequest(port, '/v1/cs2/schedule', 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body.length).toBe(0)
    expect(head.headers.etag).toBe(response.headers.etag)
    expect(head.headers['content-length']).toBe(String(response.body.length))
    const withQuery = await localRequest(port, '/v1/cs2/schedule?refresh=true')
    expect(withQuery.body).toEqual(response.body)
  })

  it('supports gzip with representation-specific strong ETags and quality negotiation', async () => {
    http.update(schedule(), null)
    const identity = await localRequest(port, '/v1/cs2/schedule')
    const compressed = await localRequest(port, '/v1/cs2/schedule', 'GET', { 'Accept-Encoding': 'br, gzip' })
    expect(compressed.headers['content-encoding']).toBe('gzip')
    expect(compressed.headers.vary).toBe('Accept-Encoding')
    expect(gunzipSync(compressed.body)).toEqual(identity.body)
    expect(compressed.headers.etag).not.toBe(identity.headers.etag)
    const unchanged = await localRequest(port, '/v1/cs2/schedule', 'HEAD',
      { 'Accept-Encoding': 'gzip', 'If-None-Match': compressed.headers.etag! })
    expect(unchanged.status).toBe(304)
    expect(unchanged.body.length).toBe(0)
    const head = await localRequest(port, '/v1/cs2/schedule', 'HEAD', { 'Accept-Encoding': 'gzip' })
    expect(head.headers['content-length']).toBe(String(compressed.body.length))
    expect(head.body.length).toBe(0)
    const refused = await localRequest(port, '/v1/cs2/schedule', 'GET', { 'Accept-Encoding': 'gzip;q=0, *;q=1' })
    expect(refused.headers['content-encoding']).toBeUndefined()
    expect((await localRequest(port, '/v1/cs2/schedule', 'GET', { 'Accept-Encoding': '*;q=0.5' })).headers['content-encoding']).toBe('gzip')
  })

  it('reads logos with validated keys and immutable versions, including HEAD', async () => {
    await mkdir(join(root, 'events', 'logos'), { recursive: true })
    await writeFile(join(root, 'events', 'logos', 'team1.png'), png)
    const response = await localRequest(port, '/v1/cs2/logos/team1')
    expect(response.status).toBe(200)
    expect(response.body).toEqual(png)
    expect(response.headers['content-type']).toBe('image/png')
    expect(response.headers['cache-control']).toBe('no-cache')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    const immutable = await localRequest(port, `/v1/cs2/logos/team1?v=${sha256}`)
    expect(immutable.headers['cache-control']).toBe('public, max-age=604800, immutable')
    const head = await localRequest(port, `/v1/cs2/logos/team1?v=${sha256}`, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body.length).toBe(0)
    for (const path of ['/v1/cs2/logos/missing', '/v1/cs2/logos/TEAM1', '/v1/cs2/logos/../team1',
      '/v1/cs2/logos/%2E%2E%2Fteam1', '/v1/cs2/logos/' + 'a'.repeat(65), '/v1/cs2/logos/team1?v=bad',
      '/v1/cs2/logos/team1?v=' + '0'.repeat(64), `/v1/cs2/logos/team1?v=${sha256}&v=${sha256}`]) {
      expect((await localRequest(port, path)).status, path).toBe(404)
    }
  })

  it('reports healthy, stale and cooling-down snapshots without expiring cached schedule responses', async () => {
    http.update(schedule(), NOW + 60_000)
    const healthy = await localRequest(port, '/healthz')
    expect(healthy.status).toBe(200)
    expect(healthy.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(healthy.body.toString())).toEqual({ ok: true, fetchedAt: NOW, ageSeconds: 0,
      matches: 9, cooldownUntil: NOW + 60_000 })
    now += 30 * 60_000 + 1
    const stale = await localRequest(port, '/healthz')
    expect(stale.status).toBe(503)
    expect(JSON.parse(stale.body.toString())).toMatchObject({ ok: false, ageSeconds: 1800, cooldownUntil: null })
    expect((await localRequest(port, '/v1/cs2/schedule')).status).toBe(200)
  })

  it('limits URL and header size, methods and paths', async () => {
    expect((await localRequest(port, '/unknown')).status).toBe(404)
    const post = await localRequest(port, '/v1/cs2/schedule', 'POST', { 'Content-Length': '999999' })
    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET, HEAD')
    expect((await localRequest(port, '/' + 'a'.repeat(RELAY_MAX_URL_BYTES))).status).toBe(414)
    expect((await localRequest(port, '/healthz', 'GET', { 'X-Large': 'a'.repeat(RELAY_MAX_HEADER_BYTES) })).status).toBe(431)
    expect(http.server.headersTimeout).toBe(10_000)
    expect(http.server.requestTimeout).toBe(15_000)
    expect(http.server.keepAliveTimeout).toBe(5_000)
    expect(http.server.maxHeadersCount).toBe(64)
  })
})
