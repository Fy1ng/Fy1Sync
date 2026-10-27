/** Anonymous, receive-only HTTP chat signing. This is independent of H1 tokens. */
import type { ProxyConfig } from '../config'
import { readPlatformBytes } from '../platformResponse'
import { safeFetch } from '../safeFetch'
import { HuyaTarsReader as Reader, HuyaTarsWriter as Writer } from './huyaWup'

const MAX_PACKET = 65_536
const MAX_UID = 0x7fff_ffff_ffff_ffffn
const SDK = 'hysdk-webh5&2610221812'
const invalid = () => new Error('无法读取虎牙聊天流签名.')
const cancelled = () => new DOMException('虎牙聊天流签名请求已中止.', 'AbortError')

/** Internal only: the signed URL and wsTime must never cross IPC or enter logs. */
export type HuyaChatSignal = {
  url: string
  host: string
  ttlSeconds: number
  issuedAt: number
  expiresAt: number
  wsTime: string
}

function validUid(uid: bigint): boolean { return typeof uid === 'bigint' && uid > 0n && uid <= MAX_UID }

/** HUYA.GetP2PStreamInfoReq contains no UserId, Cookie, guid or login token. */
export function encodeHuyaChatSignalRequest(presenterUid: bigint): Uint8Array<ArrayBuffer> {
  if (!validUid(presenterUid)) throw invalid()
  const request = new Writer()
  request.head(0, 10)
  request.int64(0, presenterUid)
  request.string(1, `chat-${presenterUid}`)
  request.int(2, 2)
  request.string(3, SDK)
  request.head(0, 11)
  const payload = new Writer()
  payload.head(0, 8)
  payload.int(0, 1)
  payload.string(0, 'tReq')
  payload.bytes(1, request.finish())
  const packet = new Writer()
  packet.int(1, 3)
  packet.int(2, 0)
  packet.int(3, 0)
  packet.int(4, 1)
  packet.string(5, 'mediaui')
  packet.string(6, 'getP2PStreamInfo')
  packet.bytes(7, payload.finish())
  packet.int(8, 0)
  for (const tag of [9, 10]) { packet.head(tag, 8); packet.int(0, 0) }
  const body = packet.finish()
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length + 4)
  return new Uint8Array(Buffer.concat([length, body]))
}

function integer(reader: Reader, type: number, min: bigint, max: bigint): bigint {
  const result = reader.int(type)
  if (result < min || result > max) throw invalid()
  return result
}

function shortString(reader: Reader, type: number, max: number): string {
  const result = reader.string(type)
  if (result.length > max || /[\x00-\x20\x7f]/.test(result)) throw invalid()
  return result
}

function responsePayload(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes.length > MAX_PACKET || Buffer.from(bytes.subarray(0, 4)).readUInt32BE() !== bytes.length) throw invalid()
  const packet = new Reader(bytes.subarray(4))
  const seen = new Set<number>()
  let version: bigint | undefined
  let servant: string | undefined
  let method: string | undefined
  let payload: Uint8Array | undefined
  while (!packet.done) {
    const [tag, type] = packet.head()
    if (seen.has(tag)) throw invalid()
    seen.add(tag)
    if (tag === 1) version = integer(packet, type, 3n, 3n)
    else if (tag === 2 || tag === 3 || tag === 8) integer(packet, type, 0n, 0n)
    else if (tag === 4) integer(packet, type, 1n, 2147483647n)
    else if (tag === 5) servant = shortString(packet, type, 32)
    else if (tag === 6) method = shortString(packet, type, 64)
    else if (tag === 7) payload = packet.bytes(type)
    else packet.skip(type)
  }
  if (version !== 3n || servant !== 'mediaui' || method !== 'getP2PStreamInfo' || !payload) throw invalid()
  const map = new Reader(payload)
  const [tag, type] = map.head()
  if (tag !== 0 || type !== 8) throw invalid()
  const count = map.size(16)
  let result: Uint8Array | undefined
  const keys = new Set<string>()
  for (let i = 0; i < count; i++) {
    const [keyTag, keyType] = map.head()
    if (keyTag !== 0) throw invalid()
    const key = shortString(map, keyType, 64)
    if (keys.has(key)) throw invalid()
    keys.add(key)
    const [valueTag, valueType] = map.head()
    if (valueTag !== 1) throw invalid()
    const value = map.bytes(valueType)
    if (key === 'tRsp') result = value
    else if (key === '') {
      const status = new Reader(value)
      const [statusTag, statusType] = status.head()
      if (statusTag !== 0 || integer(status, statusType, 0n, 0n) !== 0n || !status.done) throw invalid()
    }
  }
  if (!map.done || !result) throw invalid()
  return result
}

/** wsTime is the issue time in Unix seconds (hex), not the expiry timestamp. */
export function decodeHuyaChatSignalResponse(bytes: Uint8Array, presenterUid: bigint, now = Date.now()): HuyaChatSignal | null {
  try {
    if (!validUid(presenterUid) || !Number.isSafeInteger(now) || now < 0) return null
    const response = new Reader(responsePayload(bytes))
    const [structTag, structType] = response.head()
    if (structTag !== 0 || structType !== 10) return null
    const fields = new Map<number, bigint | string>()
    const seen = new Set<number>()
    let ended = false
    while (!response.done) {
      const [tag, type] = response.head()
      if (type === 11) { if (tag !== 0) return null; ended = true; break }
      if (seen.has(tag)) return null
      seen.add(tag)
      if (tag === 0) fields.set(tag, integer(response, type, 1n, MAX_UID))
      else if (tag === 2) fields.set(tag, integer(response, type, 2n, 2n))
      else if (tag === 4) fields.set(tag, integer(response, type, 1n, 3600n))
      else if (tag === 1 || tag === 3 || tag === 5 || tag === 6 || tag === 7) fields.set(tag, shortString(response, type, tag === 5 ? 320 : 128))
      else if (tag === 8) {
        // The web schema is map<int,int>, never a vector. Values are bounded hints.
        if (type !== 8) return null
        const count = response.size(16)
        const keys = new Set<bigint>()
        for (let i = 0; i < count; i++) {
          const [keyTag, keyType] = response.head()
          if (keyTag !== 0) return null
          const key = integer(response, keyType, 0n, 65535n)
          if (keys.has(key)) return null
          keys.add(key)
          const [valueTag, valueType] = response.head()
          if (valueTag !== 1) return null
          integer(response, valueType, 0n, 65535n)
        }
      } else if (tag === 9) integer(response, type, 0n, 65535n)
      else response.skip(type)
    }
    if (!ended || !response.done || fields.get(0) !== presenterUid || fields.get(1) !== `chat-${presenterUid}` || fields.get(2) !== 2n) return null
    const auth = fields.get(3)
    const ttl = fields.get(4)
    const hostPath = fields.get(5)
    const channel = fields.get(6)
    const subChannel = fields.get(7)
    if (typeof auth !== 'string' || typeof ttl !== 'bigint' || typeof hostPath !== 'string' || typeof channel !== 'string' || typeof subChannel !== 'string') return null
    const token = /^wsSecret=([a-f0-9]{32})&wsTime=([a-f0-9]{1,12})$/i.exec(auth)
    if (!token || !/^(0|[1-9]\d{0,9})$/.test(channel) || !/^(0|[1-9]\d{0,9})$/.test(subChannel)
      || BigInt(channel) > 2147483647n || BigInt(subChannel) > 2147483647n) return null
    const slash = hostPath.indexOf('/')
    const host = hostPath.slice(0, slash)
    // Match the observed web endpoint exactly; no arbitrary path, port or URL input.
    if (slash < 1 || hostPath.slice(slash) !== '/huyalive' || host.length > 253
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+huya\.com$/i.test(host)) return null
    const wsTime = token[2]!
    const issuedAt = Number.parseInt(wsTime, 16) * 1000
    const ttlSeconds = Number(ttl)
    const expiresAt = issuedAt + ttlSeconds * 1000
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || issuedAt <= 0 || issuedAt > now + 60_000 || expiresAt <= now) return null
    const url = `https://${hostPath}/chat-${presenterUid}_${channel}_${subChannel}_66.slice?${auth}&baseIndex=0&quickTime=2000`
    return { url, host: host.toLowerCase(), ttlSeconds, issuedAt, expiresAt, wsTime }
  } catch { return null }
}

export type HuyaChatSignalDeps = {
  /** Trusted host-side test seam; production always uses safeFetch. */
  safeFetchImpl?: typeof safeFetch
  now?: () => number
  timeoutMs?: number
}

async function limitedBytes(response: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const advertised = response.headers.get('content-length')
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_PACKET)) {
    void response.body?.cancel().catch(() => {})
    throw invalid()
  }
  if (!response.body) return new Uint8Array()
  let size = 0
  let chunks = 0
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    size += chunk.byteLength
    if (size > MAX_PACKET || ++chunks > 1024) throw invalid()
    controller.enqueue(chunk)
  } }))
  return readPlatformBytes(new Response(body, { headers: response.headers }), signal)
}

/** Every reconnect obtains a fresh anonymous signal; the caller never reuses URLs. */
export async function requestHuyaChatSignal(presenterUid: bigint, signal: AbortSignal, deps: HuyaChatSignalDeps = {}): Promise<HuyaChatSignal> {
  const timeoutMs = deps.timeoutMs ?? 15_000
  if (!validUid(presenterUid) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw invalid()
  if (signal.aborted) throw cancelled()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const combined = AbortSignal.any([signal, controller.signal])
  const config: ProxyConfig = { enabled: true, hosts: ['wup.huya.com'], allowNonStandardPorts: false,
    allowNonLoopbackTargets: false, maxRedirects: 0, requestTimeoutMs: timeoutMs }
  let abort = () => {}
  let response: Response | undefined
  try {
    const operation = async () => {
      const result = await (deps.safeFetchImpl ?? safeFetch)('https://wup.huya.com', config, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: encodeHuyaChatSignalRequest(presenterUid), signal: combined,
      })
      response = result.response
      if (combined.aborted) { void response.body?.cancel().catch(() => {}); throw cancelled() }
      if (!response.ok || result.finalUrl.href !== 'https://wup.huya.com/') throw invalid()
      const bytes = await limitedBytes(response, combined)
      const decoded = decodeHuyaChatSignalResponse(bytes, presenterUid, (deps.now ?? Date.now)())
      if (!decoded) throw invalid()
      return decoded
    }
    return await Promise.race([operation(), new Promise<never>((_yes, no) => {
      abort = () => no(cancelled())
      combined.addEventListener('abort', abort, { once: true })
      if (combined.aborted) abort()
    })])
  } catch {
    if (combined.aborted) throw cancelled()
    throw invalid()
  } finally {
    clearTimeout(timeout)
    combined.removeEventListener('abort', abort)
    // readPlatformBytes already cancels its reader; this also covers HTTP failures.
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
  }
}
