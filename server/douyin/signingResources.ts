/** Anonymous signing resources. No account cookies, ticket, private key or user ID are accepted.
 * SecureSDK snapshot: https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/chunks/2722.06f25cc9.js
 * SHA256: bc8b0308a16f00ccf2a63cd07fd8c573350166186ad7ff75ae1f5de635d75f3d
 * requestServerTimestamp sends an empty POST and reads bd-ticket-guard-ts. The peer is the SDK's pinned public fallback.
 */
import { createHash, X509Certificate } from 'node:crypto'
import type { ProxyConfig } from '../config'
import { safeFetch, type Resolver } from '../safeFetch'
import { networkContext, routeCandidates, type NetworkContext } from '../networkPolicy'
import { abortable, cancelBody } from '../douyu/actionHttp'
import { douyinBrowserUserAgent } from './httpContext'

export const DOUYIN_SIGNING_TIME_URL = 'https://live.douyin.com/passport/user_info/get_sec_ts/?aid=6383&is_from_ttaccountsdk=1'
export const DOUYIN_SIGNING_TIME_TTL_MS = 5 * 60_000
export const DOUYIN_SIGNING_TIME_TIMEOUT_MS = 2_000
export const DOUYIN_SIGNING_PEER_TTL_MS = 24 * 60 * 60_000
export const DOUYIN_SIGNING_PEER_SOURCE = Object.freeze({
  url:'https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/chunks/2722.06f25cc9.js',
  sdkSha256:'bc8b0308a16f00ccf2a63cd07fd8c573350166186ad7ff75ae1f5de635d75f3d',
  certificateDerSha256:'4dbba9381f6a863b7f8372e008d207bd7c28adfc212f9021752d651744eccc6f',
  sn:'533240336124694022040808462028007165443034493949',
})

// Public certificate from SecureSDK's t8 fallback, never an account certificate or a TLS trust override.
const PEER_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIEfTCCBCKgAwIBAgIUXWdS2tzmSoewCWfKFyiWMrJqs/0wCgYIKoZIzj0EAwIw
MTELMAkGA1UEBhMCQ04xIjAgBgNVBAMMGXRpY2tldF9ndWFyZF9jYV9lY2RzYV8y
NTYwIBcNMjIxMTE4MDUyMDA2WhgPMjA2OTEyMzExNjAwMDBaMCQxCzAJBgNVBAYT
AkNOMRUwEwYDVQQDEwxlY2llcy1zZXJ2ZXIwWTATBgcqhkjOPQIBBggqhkjOPQMB
BwNCAASE2llDPlfc8Rq+5J5HXhg4edFjPnCF3Ua7JBoiE/foP9m7L5ELIcvxCgEx
aRCHbQ8kCCK/ArZ4FX/qCobZAkToo4IDITCCAx0wDgYDVR0PAQH/BAQDAgWgMDEG
A1UdJQQqMCgGCCsGAQUFBwMBBggrBgEFBQcDAgYIKwYBBQUHAwMGCCsGAQUFBwME
MCkGA1UdDgQiBCABydxqGrVEHhtkCWTb/vicGpDZPFPDxv82wiuywUlkBDArBgNV
HSMEJDAigCAypWfqjmRIEo3MTk1Ae3MUm0dtU3qk0YDXeZSXeyJHgzCCAZQGCCsG
AQUFBwEBBIIBhjCCAYIwRgYIKwYBBQUHMAGGOmh0dHA6Ly9uZXh1cy1wcm9kdWN0
aW9uLmJ5dGVkYW5jZS5jb20vYXBpL2NlcnRpZmljYXRlL29jc3AwRgYIKwYBBQUH
MAGGOmh0dHA6Ly9uZXh1cy1wcm9kdWN0aW9uLmJ5dGVkYW5jZS5uZXQvYXBpL2Nl
cnRpZmljYXRlL29jc3AwdwYIKwYBBQUHMAKGa2h0dHA6Ly9uZXh1cy1wcm9kdWN0
aW9uLmJ5dGVkYW5jZS5jb20vYXBpL2NlcnRpZmljYXRlL2Rvd25sb2FkLzQ4RjlD
MEU3QjBDNUE3MDVCOTgyQkU1NTE3MDVGNjQ1QzhDODc4QTguY3J0MHcGCCsGAQUF
BzAChmtodHRwOi8vbmV4dXMtcHJvZHVjdGlvbi5ieXRlZGFuY2UubmV0L2FwaS9j
ZXJ0aWZpY2F0ZS9kb3dubG9hZC80OEY5QzBFN0IwQzVBNzA1Qjk4MkJFNTUxNzA1
RjY0NUM4Qzg3OEE4LmNydDCB5wYDVR0fBIHfMIHcMGygaqBohmZodHRwOi8vbmV4
dXMtcHJvZHVjdGlvbi5ieXRlZGFuY2UuY29tL2FwaS9jZXJ0aWZpY2F0ZS9jcmwv
NDhGOUMwRTdCMEM1QTcwNUI5ODJCRTU1MTcwNUY2NDVDOEM4NzhBOC5jcmwwbKBq
oGiGZmh0dHA6Ly9uZXh1cy1wcm9kdWN0aW9uLmJ5dGVkYW5jZS5uZXQvYXBpL2Nl
cnRpZmljYXRlL2NybC80OEY5QzBFN0IwQzVBNzA1Qjk4MkJFNTUxNzA1RjY0NUM4
Qzg3OEE4LmNybDAKBggqhkjOPQQDAgNJADBGAiEAqMjT5ADMdGMeaImoJK4J9jzE
LqZ573rNjsT3k14pK50CIQCLpWHVKWi71qqqrMjiSDvUhpyO1DpTPRHlavPRuaNm
ww==
-----END CERTIFICATE-----`

export interface DouyinSigningResourceDependencies {
  proxy: ProxyConfig
  network?: () => NetworkContext
  fetchImpl?: typeof fetch
  resolve?: Resolver
  now?: () => number
  monotonic?: () => number
  userAgent?: string
}
export type DouyinSigningResourceErrorCode = 'douyin-signing-resource-unavailable' | 'douyin-signing-resource-cancelled' | 'douyin-signing-resource-clock-invalid'
export class DouyinSigningResourceError extends Error {
  constructor(readonly code: DouyinSigningResourceErrorCode = 'douyin-signing-resource-unavailable') {
    super(code)
    if (code === 'douyin-signing-resource-cancelled') this.name = 'AbortError'
  }
}

interface Clock { wall: number; monotonic: number }
interface TimeAnchor extends Clock { serverSeconds: number }
interface TimestampFlight { controller: AbortController; waiters: Set<symbol>; promise: Promise<TimeAnchor> }
const cancelled = () => new DouyinSigningResourceError('douyin-signing-resource-cancelled')

/** One bounded peer cache and one shared timestamp flight, owned by the main-process sender. */
export class DouyinSigningResources {
  private disposed = false
  private anchor: TimeAnchor | undefined
  private peer: { clock: Clock; value: string } | undefined
  private flight: TimestampFlight | undefined
  constructor(private readonly deps: DouyinSigningResourceDependencies) {}

  private check(signal: AbortSignal): void {
    if (signal.aborted || this.disposed) throw cancelled()
  }
  private clock(): Clock {
    try {
      const wall = (this.deps.now ?? Date.now)(), monotonic = (this.deps.monotonic ?? (() => performance.now()))()
      if (!Number.isFinite(wall) || wall < 0 || !Number.isFinite(monotonic) || monotonic < 0) throw new Error()
      return { wall, monotonic }
    } catch { throw new DouyinSigningResourceError('douyin-signing-resource-clock-invalid') }
  }
  private fresh(old: Clock, now: Clock, ttl: number): boolean {
    return now.monotonic >= old.monotonic && Math.max(now.monotonic - old.monotonic, now.wall - old.wall) < ttl
  }

  async peerPublicKey(signal: AbortSignal): Promise<string> {
    this.check(signal)
    const clock = this.clock()
    if (this.peer && this.fresh(this.peer.clock, clock, DOUYIN_SIGNING_PEER_TTL_MS)) return this.peer.value
    try {
      const certificate = new X509Certificate(PEER_CERTIFICATE), key = certificate.publicKey
      if (createHash('sha256').update(certificate.raw).digest('hex') !== DOUYIN_SIGNING_PEER_SOURCE.certificateDerSha256
        || BigInt(`0x${certificate.serialNumber}`).toString() !== DOUYIN_SIGNING_PEER_SOURCE.sn
        || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
        || clock.wall < Date.parse(certificate.validFrom) || clock.wall >= Date.parse(certificate.validTo)) {
        throw new DouyinSigningResourceError()
      }
      this.check(signal)
      const value = key.export({ format:'pem', type:'spki' }).toString()
      this.peer = { clock, value }
      return value
    } catch(error) { throw error instanceof DouyinSigningResourceError ? error : new DouyinSigningResourceError() }
  }

  async timestampSeconds(signal: AbortSignal): Promise<number> {
    this.check(signal)
    const clock = this.clock()
    let anchor = this.anchor
    if (!anchor || !this.fresh(anchor, clock, DOUYIN_SIGNING_TIME_TTL_MS)) {
      this.anchor = undefined
      anchor = await this.join(this.flight ?? this.begin(), signal)
    }
    this.check(signal)
    const current = this.clock()
    if (!this.fresh(anchor, current, DOUYIN_SIGNING_TIME_TTL_MS)) {
      throw new DouyinSigningResourceError('douyin-signing-resource-clock-invalid')
    }
    // Same calibration as SecureSDK: server header at receipt plus monotonic elapsed time, never local epoch time.
    return Math.floor(anchor.serverSeconds + (current.monotonic - anchor.monotonic) / 1000)
  }

  async get(signal: AbortSignal): Promise<{ peerPublicKeyPem: string; timestampSeconds: number }> {
    const peerPublicKeyPem = await this.peerPublicKey(signal), timestampSeconds = await this.timestampSeconds(signal)
    this.check(signal)
    return { peerPublicKeyPem, timestampSeconds }
  }

  private begin(): TimestampFlight {
    const flight: TimestampFlight = { controller:new AbortController(), waiters:new Set(), promise:undefined! }
    this.flight = flight
    flight.promise = this.loadAnchor(flight.controller.signal).then(anchor => {
      if (flight.controller.signal.aborted || this.disposed || this.flight !== flight) throw cancelled()
      this.anchor = anchor
      return anchor
    }).catch(error => {
      throw flight.controller.signal.aborted ? cancelled()
        : error instanceof DouyinSigningResourceError ? error : new DouyinSigningResourceError()
    }).finally(() => { if (this.flight === flight) this.flight = undefined })
    void flight.promise.catch(() => {})
    return flight
  }
  private join(flight: TimestampFlight, signal: AbortSignal): Promise<TimeAnchor> {
    return new Promise((resolve, reject) => {
      const token = Symbol(), finish = () => {
        signal.removeEventListener('abort', abort)
        flight.waiters.delete(token)
        if (flight.waiters.size === 0 && this.flight === flight) {
          this.flight = undefined
          flight.controller.abort()
        }
      }
      let done = false
      const complete = (work: () => void) => { if (!done) { done = true; finish(); work() } }
      const abort = () => complete(() => reject(cancelled()))
      flight.waiters.add(token)
      signal.addEventListener('abort', abort, { once:true })
      if (signal.aborted) abort()
      flight.promise.then(anchor => complete(() => signal.aborted ? reject(cancelled()) : resolve(anchor)),
        error => complete(() => reject(error)))
    })
  }

  private async loadAnchor(owner: AbortSignal): Promise<TimeAnchor> {
    const signal = AbortSignal.any([owner, AbortSignal.timeout(DOUYIN_SIGNING_TIME_TIMEOUT_MS)]), start = this.clock()
    const context = this.deps.network?.() ?? networkContext()
    const network: NetworkContext = { route: async url => routeCandidates(await context.route(url)).find(route => route.kind !== 'unsupported') ?? { kind:'unsupported' } }
    const work = safeFetch(DOUYIN_SIGNING_TIME_URL, { ...this.deps.proxy, maxRedirects:0,
      requestTimeoutMs:Math.min(this.deps.proxy.requestTimeoutMs, DOUYIN_SIGNING_TIME_TIMEOUT_MS) }, {
      method:'POST',signal,network,fetchImpl:this.deps.fetchImpl,resolve:this.deps.resolve,
      headers:{ 'User-Agent':douyinBrowserUserAgent(this.deps.userAgent),Accept:'application/json',
        Origin:'https://live.douyin.com',Referer:'https://live.douyin.com/' },
    })
    void work.then(result => { if (signal.aborted) cancelBody(result.response) }, () => {})
    try {
      const { response, finalUrl } = await abortable(work, signal)
      try {
        signal.throwIfAborted()
        const receipt = this.clock(), raw = response.headers.get('bd-ticket-guard-ts'), age = response.headers.get('age')
        if (!response.ok || finalUrl.href !== DOUYIN_SIGNING_TIME_URL || !raw || !/^[1-9]\d{9}$/.test(raw)
          || Number(raw) < 1_577_836_800 || Number(raw) >= 4_102_444_800
          || age !== null && age !== '0'
          || receipt.monotonic < start.monotonic
          || Math.max(receipt.monotonic-start.monotonic,receipt.wall-start.wall) > DOUYIN_SIGNING_TIME_TIMEOUT_MS) {
          throw new DouyinSigningResourceError()
        }
        return { ...receipt, serverSeconds:Number(raw) }
      } finally { cancelBody(response) }
    } catch(error) {
      if (owner.aborted) throw cancelled()
      throw error instanceof DouyinSigningResourceError ? error : new DouyinSigningResourceError()
    }
  }

  invalidate(): void {
    this.anchor = undefined
    this.peer = undefined
    const old = this.flight
    this.flight = undefined
    old?.controller.abort()
  }
  dispose(): void { this.disposed = true; this.invalidate() }
}
