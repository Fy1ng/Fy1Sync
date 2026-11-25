import { isIP } from 'node:net'
import { httpErrorDetails } from '../server/httpError'
import { dnsResolver, safeFetch, type Resolver } from '../server/safeFetch'
import { networkContext } from '../server/networkPolicy'
import { secureUpdateUrl } from './onlineUpdateManifest'

const invalidRequest = () => new Error('在线更新请求参数无效')
const invalidDns = () => new Error('在线更新域名解析结果无效')
const untrustedTarget = () => new Error('在线更新来源或重定向目标不受信任')
const invalidResponse = () => new Error('在线更新响应内容或长度校验失败')

/** Bound injected transports, DNS and stream reads that do not observe AbortSignal. */
export function updateBounded<T>(operation: Promise<T>, signal: AbortSignal, abortedError: () => Error = () => new Error('在线更新请求超时')): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortedError()) }
    if (signal.aborted) { void operation.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(value => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) abort(); else resolve(value)
    }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

function ipv6Words(address: string): number[] | undefined {
  let value = address.toLowerCase()
  if (value.includes('.')) {
    const colon = value.lastIndexOf(':')
    const bytes = value.slice(colon + 1).split('.').map(Number)
    if (bytes.length !== 4 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return undefined
    value = value.slice(0, colon + 1) + ((bytes[0]! << 8) | bytes[1]!).toString(16) + ':' + ((bytes[2]! << 8) | bytes[3]!).toString(16)
  }
  const halves = value.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  if (parts.length !== 8) return undefined
  const words = parts.map(part => /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN)
  return words.some(Number.isNaN) ? undefined : words
}

/**
 * Update URLs are strictly allowlisted HTTPS origins verified by TLS + Ed25519 + SHA-256,
 * while TUN/Fake-IP/NAT64/SNI-proxy tools may use any unicast IPv4 or IPv6 range.
 * Only reject unspecified (0.0.0.0/8, ::) and multicast/broadcast addresses.
 */
export function isUsableUpdateAddress(address: string): boolean {
  if (typeof address !== 'string' || address.includes('%')) return false
  const family = isIP(address)
  if (family === 4) {
    const first = Number(address.split('.')[0])
    return first > 0 && first < 224
  }
  if (family !== 6) return false
  const words = ipv6Words(address)
  if (!words || words.every(word => word === 0) || (words[0]! & 0xff00) === 0xff00) return false
  if (words.slice(0, 5).every(word => word === 0) && (words[5] === 0xffff || words[5] === 0 && !(words[6] === 0 && words[7] === 1))) {
    const first = words[6]! >>> 8
    return first > 0 && first < 224
  }
  return true
}

export interface UpdateDownloadOptions {
  signal: AbortSignal
  limit: number
  expectedBytes?: number
  /** Empty for catalogs and frontend containers. These never redirect. */
  redirectOrigins?: readonly string[]
  timeoutMs?: number
  request?: typeof fetch
  resolve?: Resolver
  onProgress?: (bytes: number) => void
}

export async function streamUpdateDownload(url: string, options: UpdateDownloadOptions, consume: (bytes: Uint8Array) => Promise<void>): Promise<number> {
  const initial = secureUpdateUrl(url, true)
  const allowed = new Set([initial.origin, ...options.redirectOrigins ?? []])
  for (const origin of allowed) {
    const parsed = secureUpdateUrl(origin)
    if (parsed.origin !== origin) throw untrustedTarget()
  }
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0 || options.expectedBytes !== undefined
    && (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes <= 0 || options.expectedBytes > options.limit)) throw invalidRequest()
  const deadline = new AbortController(), timeoutMs = options.timeoutMs ?? 20_000
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  const signal = AbortSignal.any([options.signal, deadline.signal])
  const abortedError = () => new Error(options.signal.aborted ? '在线更新下载已取消' : '在线更新请求超时')
  const answers = new Map<string, string[]>()
  const unicastResolve: Resolver = async host => {
    const existing = answers.get(host)
    if (existing) return [...existing]
    const values = await updateBounded((options.resolve ?? dnsResolver)(host), signal, abortedError)
    if (!Array.isArray(values) || !values.length || values.length > 64 || values.some(value => typeof value !== 'string' || !isUsableUpdateAddress(value))) throw invalidDns()
    const addresses = [...new Set(values)]
    answers.set(host, addresses)
    return [...addresses]
  }
  const configuredNetwork = networkContext()
  try {
    const fetched = await updateBounded(safeFetch(initial.href, {
      enabled: true, hosts: [...allowed].map(origin => new URL(origin).hostname), allowNonStandardPorts: false,
      maxRedirects: options.redirectOrigins === undefined ? 0 : 4, requestTimeoutMs: timeoutMs,
    }, {
      signal, resolve: unicastResolve,
      // DIRECT routes pin resolved unicast answers (including any user Fake-IP CIDR);
      // HTTP/SOCKS5 proxies resolve DNS remotely in safeFetch while preserving end-to-end TLS.
      network: { route: async target => {
        const parsed = secureUpdateUrl(target, true)
        if (!allowed.has(parsed.origin)) throw untrustedTarget()
        return updateBounded(configuredNetwork.route(parsed.href), signal, abortedError)
      } },
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Fy1Sync-Signed-Updater', 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
      fetchImpl: async (input, init) => {
        signal.throwIfAborted()
        const target = secureUpdateUrl(input instanceof Request ? input.url : String(input), true)
        if (!allowed.has(target.origin)) throw untrustedTarget()
        const response = await updateBounded((options.request ?? fetch)(input, { ...init, credentials: 'omit', cache: 'no-store' }).then(value => {
          if (signal.aborted) { void value.body?.cancel().catch(() => {}); throw abortedError() }
          return value
        }), signal, abortedError)
        if (response.redirected || response.url && response.url !== target.href) {
          void response.body?.cancel().catch(() => {})
          throw untrustedTarget()
        }
        return response
      },
    }), signal, abortedError)
    const response = fetched.response
    const length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding')
    if (response.status !== 200) {
      const message = response.status === 404 ? '所选更新源尚未发布更新清单或文件不存在（HTTP 404）' : `在线更新请求失败（HTTP ${response.status}）`
      throw Object.assign(new Error(message), await httpErrorDetails(response))
    }
    if (!response.body || encoding !== null && encoding.toLowerCase() !== 'identity'
      || length !== null && (!/^\d+$/.test(length) || Number(length) > options.limit || options.expectedBytes !== undefined && Number(length) !== options.expectedBytes)) {
      void response.body?.cancel().catch(() => {})
      throw invalidResponse()
    }
    const reader = response.body.getReader()
    let count = 0, reads = 0
    try {
      for (;;) {
        const next = await updateBounded(reader.read(), signal, abortedError)
        if (next.done) break
        count += next.value.byteLength
        if (count > options.limit || options.expectedBytes !== undefined && count > options.expectedBytes || ++reads > 1_048_576) throw invalidResponse()
        await updateBounded(consume(next.value), signal, abortedError)
        options.onProgress?.(count)
      }
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    if (!count || length !== null && count !== Number(length) || options.expectedBytes !== undefined && count !== options.expectedBytes) throw invalidResponse()
    signal.throwIfAborted()
    return count
  } finally { clearTimeout(timer) }
}

export async function readUpdateDownload(url: string, options: UpdateDownloadOptions): Promise<Buffer> {
  const chunks: Buffer[] = []
  const size = await streamUpdateDownload(url, options, async chunk => { chunks.push(Buffer.from(chunk)) })
  return Buffer.concat(chunks, size)
}
