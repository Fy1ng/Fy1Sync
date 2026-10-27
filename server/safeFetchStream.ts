/** Long-lived, backpressured reads using the same per-hop SSRF policy as safeFetch. */
import type { ProxyConfig } from './config'
import { ProxyError, safeFetch, type Resolver, type UrlRejection } from './safeFetch'

export type SafeFetchStreamErrorCode =
  | 'invalid-options'
  | 'connect-timeout'
  | 'read-timeout'
  | 'idle-timeout'
  | 'buffer-limit'
  | 'aborted'
  | 'connect-failed'
  | 'read-failed'
  | 'policy-rejected'
  | 'http-status'
  | 'empty-body'
  | 'consumer-failed'

/** Never retains an upstream error, signed URL, headers or response bytes. */
export class SafeFetchStreamError extends Error {
  constructor(
    readonly code: SafeFetchStreamErrorCode,
    readonly status?: number,
    readonly policyReason?: UrlRejection,
  ) {
    super(`Safe stream failed: ${code}.`)
    this.name = 'SafeFetchStreamError'
  }
}

export type SafeFetchStreamOptions = {
  signal?: AbortSignal
  /** Called after a successful HTTP response with a readable body. */
  onOpen?: () => void
  /** Awaited before the next read; consumers must also bound their own parser state. */
  onChunk: (chunk: Uint8Array) => void | Promise<void>
  connectTimeoutMs?: number
  readTimeoutMs?: number
  /** Measured from the last nonempty chunk, including time spent in onChunk. */
  idleTimeoutMs?: number
  /** Maximum application-owned chunk/backing buffer; no chunks are accumulated. */
  maxBufferedBytes?: number
  resolve?: Resolver
  fetchImpl?: typeof fetch
}

export type SafeFetchStreamResult = { bytesRead: number; chunksRead: number }

const MAX_TIMER_MS = 2_147_483_647
function boundedInteger(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new SafeFetchStreamError('invalid-options')
  return value
}

/** Races pending I/O and consumer callbacks even when a test transport ignores abort. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort = () => {}
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }),
    ])
  } finally { signal.removeEventListener('abort', abort) }
}

/**
 * The connection timer ends at response headers. A healthy body may run indefinitely;
 * every read, nonempty-data idle interval and owned buffer remains bounded. This uses
 * safeFetch directly, retaining hostname allow-list, DNS validation, pinned dispatcher
 * and manual redirect checks without granting access to any additional host or port.
 */
export async function safeFetchStream(
  raw: string,
  config: ProxyConfig,
  options: SafeFetchStreamOptions,
): Promise<SafeFetchStreamResult> {
  const connectTimeoutMs = boundedInteger(options.connectTimeoutMs ?? config.requestTimeoutMs, MAX_TIMER_MS)
  const readTimeoutMs = boundedInteger(options.readTimeoutMs ?? 15_000, MAX_TIMER_MS)
  const idleTimeoutMs = boundedInteger(options.idleTimeoutMs ?? 45_000, MAX_TIMER_MS)
  const maxBufferedBytes = boundedInteger(options.maxBufferedBytes ?? 256 * 1_024, Number.MAX_SAFE_INTEGER)
  const controller = new AbortController()
  const fail = (code: SafeFetchStreamErrorCode) => {
    if (!controller.signal.aborted) controller.abort(new SafeFetchStreamError(code))
  }
  const abort = () => fail('aborted')
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  let connectTimer: ReturnType<typeof setTimeout> | undefined
  let readTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let response: Response | undefined
  let phase: 'connect' | 'read' | 'consumer' = 'connect'
  let bytesRead = 0
  let chunksRead = 0
  let lastDataAt = performance.now()
  const cancelRead = () => { void reader?.cancel().catch(() => {}) }
  const resetIdle = () => {
    clearTimeout(idleTimer)
    lastDataAt = performance.now()
    idleTimer = setTimeout(() => fail('idle-timeout'), idleTimeoutMs)
  }

  try {
    controller.signal.throwIfAborted()
    connectTimer = setTimeout(() => fail('connect-timeout'), connectTimeoutMs)
    ;({ response } = await untilAborted(safeFetch(raw, config, {
      signal: controller.signal, resolve: options.resolve, fetchImpl: options.fetchImpl,
    }), controller.signal))
    clearTimeout(connectTimer)
    connectTimer = undefined
    controller.signal.throwIfAborted()
    if (!response.ok) throw new SafeFetchStreamError('http-status', response.status)
    if (!response.body) throw new SafeFetchStreamError('empty-body')
    reader = response.body.getReader()
    controller.signal.addEventListener('abort', cancelRead, { once: true })
    resetIdle()
    phase = 'consumer'
    options.onOpen?.()
    for (;;) {
      controller.signal.throwIfAborted()
      // This check also prevents an endless microtask chain of empty chunks from
      // starving the timer while keeping a stream with no real data alive.
      if (performance.now() - lastDataAt >= idleTimeoutMs) throw new SafeFetchStreamError('idle-timeout')
      phase = 'read'
      readTimer = setTimeout(() => fail('read-timeout'), readTimeoutMs)
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await untilAborted(reader.read(), controller.signal) }
      finally { clearTimeout(readTimer); readTimer = undefined }
      controller.signal.throwIfAborted()
      if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array)
        || chunk.value.byteLength > maxBufferedBytes || chunk.value.buffer.byteLength > maxBufferedBytes) {
        throw new SafeFetchStreamError('buffer-limit')
      }
      if (chunk.value.byteLength === 0) continue
      resetIdle()
      bytesRead += chunk.value.byteLength
      chunksRead += 1
      phase = 'consumer'
      await untilAborted(Promise.resolve(options.onChunk(chunk.value)), controller.signal)
    }
    return { bytesRead, chunksRead }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof SafeFetchStreamError) throw error
    if (error instanceof ProxyError && error.reason !== 'upstream-failed') {
      throw new SafeFetchStreamError('policy-rejected', undefined, error.reason)
    }
    throw new SafeFetchStreamError(phase === 'consumer' ? 'consumer-failed' : phase === 'read' ? 'read-failed' : 'connect-failed')
  } finally {
    clearTimeout(connectTimer)
    clearTimeout(readTimer)
    clearTimeout(idleTimer)
    options.signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', cancelRead)
    // Do not await cancellation: an uncooperative source must not hold teardown
    // open. Abort tears down safeFetch's pinned dispatcher and the pending read.
    cancelRead()
    if (!reader) void response?.body?.cancel().catch(() => {})
    if (!controller.signal.aborted) controller.abort(new SafeFetchStreamError('aborted'))
    reader?.releaseLock()
  }
}
