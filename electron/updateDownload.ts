import { isIP } from 'node:net'
import { dnsResolver, safeFetch, type Resolver } from '../server/safeFetch'
import { networkContext } from '../server/networkPolicy'
import { secureUpdateUrl } from './onlineUpdateManifest'

const failure = () => new Error('在线更新下载失败或来源不安全.')

/** Bound injected transports, DNS and stream reads that do not observe AbortSignal. */
export function updateBounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(failure()) }
    if (signal.aborted) { void operation.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(value => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) abort(); else resolve(value)
    }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

export function isPublicUpdateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number, number]
    return a !== 0 && a !== 10 && a !== 127 && a < 224
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0 || b === 88 && c === 99))
      && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) && !(a === 203 && b === 0 && c === 113)
  }
  if (family !== 6) return false
  // Only current global-unicast space, excluding special-purpose and transition ranges.
  const words = address.toLowerCase().split(':')
  const first = parseInt(words[0] || '0', 16), second = parseInt(words[1] || '0', 16)
  return (first & 0xe000) === 0x2000 && first !== 0x2002 && first !== 0x3ffe
    && !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    && !(first === 0x3fff && second < 0x1000)
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
    if (parsed.origin !== origin) throw failure()
  }
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0 || options.expectedBytes !== undefined
    && (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes <= 0 || options.expectedBytes > options.limit)) throw failure()
  const deadline = new AbortController(), timeoutMs = options.timeoutMs ?? 20_000
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  const signal = AbortSignal.any([options.signal, deadline.signal])
  const answers = new Map<string, string[]>()
  const publicResolve: Resolver = async host => {
    const existing = answers.get(host)
    if (existing) return [...existing]
    const values = await updateBounded((options.resolve ?? dnsResolver)(host), signal)
    if (!Array.isArray(values) || !values.length || values.length > 64 || values.some(value => typeof value !== 'string' || !isPublicUpdateAddress(value))) throw failure()
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
      signal, resolve: publicResolve,
      // Preserve the user's proxy choice. DIRECT pins these public answers; a configured
      // HTTP proxy remains responsible for its own DNS, as in the existing network policy.
      network: { route: async target => {
        const parsed = secureUpdateUrl(target, true)
        if (!allowed.has(parsed.origin)) throw failure()
        await publicResolve(parsed.hostname)
        return updateBounded(configuredNetwork.route(parsed.href), signal)
      } },
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Fy1Sync-Signed-Updater', 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
      fetchImpl: async (input, init) => {
        signal.throwIfAborted()
        const target = secureUpdateUrl(input instanceof Request ? input.url : String(input), true)
        if (!allowed.has(target.origin)) throw failure()
        const response = await updateBounded((options.request ?? fetch)(input, { ...init, credentials: 'omit', cache: 'no-store' }).then(value => {
          if (signal.aborted) { void value.body?.cancel().catch(() => {}); throw failure() }
          return value
        }), signal)
        if (response.redirected || response.url && response.url !== target.href) {
          void response.body?.cancel().catch(() => {})
          throw failure()
        }
        return response
      },
    }), signal)
    const response = fetched.response
    const length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding')
    if (response.status !== 200 || !response.body || encoding !== null && encoding.toLowerCase() !== 'identity'
      || length !== null && (!/^\d+$/.test(length) || Number(length) > options.limit || options.expectedBytes !== undefined && Number(length) !== options.expectedBytes)) {
      void response.body?.cancel().catch(() => {})
      throw failure()
    }
    const reader = response.body.getReader()
    let count = 0, reads = 0
    try {
      for (;;) {
        const next = await updateBounded(reader.read(), signal)
        if (next.done) break
        count += next.value.byteLength
        if (count > options.limit || options.expectedBytes !== undefined && count > options.expectedBytes || ++reads > 1_048_576) throw failure()
        await updateBounded(consume(next.value), signal)
        options.onProgress?.(count)
      }
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    if (!count || length !== null && count !== Number(length) || options.expectedBytes !== undefined && count !== options.expectedBytes) throw failure()
    signal.throwIfAborted()
    return count
  } finally { clearTimeout(timer) }
}

export async function readUpdateDownload(url: string, options: UpdateDownloadOptions): Promise<Buffer> {
  const chunks: Buffer[] = []
  const size = await streamUpdateDownload(url, options, async chunk => { chunks.push(Buffer.from(chunk)) })
  return Buffer.concat(chunks, size)
}
