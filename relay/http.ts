import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'
import { LOGO_KEY, readTeamLogo } from '../server/esports/teamLogos'
import type { RelaySchedule } from '../server/esports/relayProtocol'

export const RELAY_MAX_URL_BYTES = 2_048
export const RELAY_MAX_HEADER_BYTES = 8_192
export const RELAY_HEALTH_MAX_AGE_MS = 30 * 60_000

interface Representation { body: Buffer; etag: string }
const represent = (body: Buffer): Representation => ({ body, etag: '"' + createHash('sha256').update(body).digest('hex') + '"' })

function acceptsGzip(value: string | undefined): boolean {
  const entries = (value ?? '').toLowerCase().split(',').map(entry => {
    const [encoding, ...parameters] = entry.trim().split(';')
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='))?.trim().slice(2)
    const weight = quality === undefined ? 1 : Number(quality)
    return { encoding, weight: Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0 }
  })
  return ((entries.find(entry => entry.encoding === 'gzip') ?? entries.find(entry => entry.encoding === '*'))?.weight ?? 0) > 0
}

function json(response: ServerResponse, status: number, value: unknown, head = false): void {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length })
  response.end(head ? undefined : body)
}

export class RelayHttp {
  private schedule: RelaySchedule | null = null
  private identity: Representation | null = null
  private compressed: Representation | null = null
  private cooldownUntil: number | null = null
  readonly server = createServer({ maxHeaderSize: RELAY_MAX_HEADER_BYTES, headersTimeout: 10_000,
    requestTimeout: 15_000, keepAliveTimeout: 5_000, connectionsCheckingInterval: 1_000 }, (request, response) => this.handle(request, response))

  constructor(private readonly dataDir: string, private readonly now: () => number = Date.now) {
    this.server.maxHeadersCount = 64
    this.server.setTimeout(15_000, socket => socket.destroy())
  }

  update(schedule: RelaySchedule | null, cooldownUntil: number | null): void {
    this.cooldownUntil = cooldownUntil
    if (!schedule) return
    if (this.schedule && this.identity?.body.equals(Buffer.from(JSON.stringify({ ...schedule, generatedAt: this.schedule.generatedAt })))) return
    const body = Buffer.from(JSON.stringify(schedule))
    const identity = represent(body), compressed = represent(gzipSync(body))
    this.schedule = schedule
    this.identity = identity
    this.compressed = compressed
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const head = request.method === 'HEAD'
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0')) {
      response.setHeader('Connection', 'close')
    }
    if (request.method !== 'GET' && !head) {
      response.setHeader('Allow', 'GET, HEAD')
      response.setHeader('Connection', 'close')
      json(response, 405, { error: 'method-not-allowed' })
      return
    }
    if (!request.url || Buffer.byteLength(request.url) > RELAY_MAX_URL_BYTES) {
      json(response, 414, { error: 'uri-too-long' }, head)
      return
    }
    let url: URL
    try {
      if (!request.url.startsWith('/') || request.url.startsWith('//')) throw new Error('Invalid URL')
      url = new URL(request.url, 'http://localhost')
      if (url.pathname !== request.url.split('?')[0]) throw new Error('Invalid path')
    } catch { json(response, 404, { error: 'not-found' }, head); return }
    if (url.pathname === '/v1/cs2/schedule') {
      response.setHeader('Cache-Control', 'public, max-age=15')
      response.setHeader('Vary', 'Accept-Encoding')
      if (!this.identity || !this.compressed) {
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Retry-After', '30')
        json(response, 503, { error: 'not-ready' }, head)
        return
      }
      const gzip = acceptsGzip(request.headers['accept-encoding'])
      const representation = gzip ? this.compressed : this.identity
      response.setHeader('ETag', representation.etag)
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (gzip) response.setHeader('Content-Encoding', 'gzip')
      const matches = request.headers['if-none-match']?.split(',').some(value =>
        value.trim() === '*' || value.trim().replace(/^W\//, '') === representation.etag)
      if (matches) { response.writeHead(304); response.end(); return }
      response.setHeader('Content-Length', representation.body.length)
      response.writeHead(200)
      response.end(head ? undefined : representation.body)
      return
    }
    if (url.pathname.startsWith('/v1/cs2/logos/')) {
      const key = url.pathname.slice('/v1/cs2/logos/'.length)
      const logo = LOGO_KEY.test(key) ? readTeamLogo(this.dataDir, key) : null
      const versions = url.searchParams.getAll('v')
      if (!logo || versions.length > 1 || (versions.length === 1 &&
        (!/^[a-f\d]{64}$/i.test(versions[0]!) || versions[0]!.toLowerCase() !== logo.sha256))) {
        json(response, 404, { error: 'not-found' }, head)
        return
      }
      response.writeHead(200, { 'Content-Type': logo.type, 'Content-Length': logo.bytes.length,
        'Cache-Control': versions.length ? 'public, max-age=604800, immutable' : 'no-cache' })
      response.end(head ? undefined : logo.bytes)
      return
    }
    if (url.pathname === '/healthz') {
      const ageSeconds = this.schedule ? Math.max(0, Math.floor((this.now() - this.schedule.fetchedAt) / 1_000)) : null
      const ok = this.schedule !== null && this.now() - this.schedule.fetchedAt <= RELAY_HEALTH_MAX_AGE_MS
      response.setHeader('Cache-Control', 'no-store')
      json(response, ok ? 200 : 503, { ok, fetchedAt: this.schedule?.fetchedAt ?? null, ageSeconds,
        matches: this.schedule?.matches.length ?? 0,
        cooldownUntil: this.cooldownUntil !== null && this.cooldownUntil > this.now() ? this.cooldownUntil : null }, head)
      return
    }
    json(response, 404, { error: 'not-found' }, head)
  }

  async listen(host: string, port: number): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { this.server.off('listening', ready); reject(error) }
      const ready = () => { this.server.off('error', failed); resolve() }
      this.server.once('error', failed)
      this.server.once('listening', ready)
      this.server.listen(port, host)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Missing listening port')
    return address.port
  }

  async close(): Promise<void> {
    if (!this.server.listening) return
    const closed = new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
    this.server.closeIdleConnections()
    await closed
  }
}
