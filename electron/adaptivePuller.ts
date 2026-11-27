import type { NetworkContext } from '../server/networkPolicy'
import { StreamFailureError } from '../server/networkFailure'
import type { Writable } from 'node:stream'
import { PinnedDispatcherPool, safeFetch, type Resolver } from '../server/safeFetch'
import type { ProxyConfig } from '../server/config'

/** Signed source URLs stay in main-process memory and must never enter state or IPC. */
export type AdaptiveSource = {
  videoUrl: string
  audioUrl: string
  videoContainer: 'webm' | 'mp4'
  height: number
}

export type AdaptivePullCode = 'adaptive-expired' | 'adaptive-request-failed' | 'adaptive-invalid-head'
  | 'adaptive-unsafe-url' | 'adaptive-segment-too-large' | 'adaptive-pipe-failed' | 'adaptive-aborted'

/** Only fixed codes and HTTP status leave the acquisition boundary, never upstream errors. */
export class AdaptivePullError extends Error {
  constructor(readonly code: AdaptivePullCode, readonly status?: number) {
    super(code)
    this.name = 'AdaptivePullError'
  }
}

export interface AdaptivePullOptions {
  video: Writable
  audio: Writable
  signal: AbortSignal
  network?: NetworkContext
  fetchImpl?: typeof fetch
  resolve?: Resolver
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  requestTimeoutMs?: number
  bodyIdleTimeoutMs?: number
  maxSegmentBytes?: number
  /** Bounded lookahead segment downloads per track when behind the advertised head. */
  prefetch?: number
  progress?: (event: { track: 'probe' | 'video' | 'audio'; phase: 'received' | 'written'; sq: number; head: number; bytes: number }) => void
}

const DEFAULT_SEGMENT_MS = 5000
const MIN_SEGMENT_MS = 500
const MAX_SEGMENT_MS = 15_000
const MIN_BEHIND_HEAD = 2
const MAX_BEHIND_HEAD = 10
const TARGET_INITIAL_BUFFER_MS = 8_000
const MAX_ATTEMPTS = 3
const MIN_PENDING_POLL_MS = 150
const MAX_PENDING_POLL_MS = 500
const MIN_PENDING_WAIT_MS = 12_000
const MAX_PENDING_POLLS = 60
const DEFAULT_SEGMENT_TIMEOUT_MS = 15_000
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 6_000
const DEFAULT_PREFETCH_AHEAD = 2
const MAX_PREFETCH_AHEAD = 4
const FIRST_RETRY_BACKOFF_MS = 150
const policy: ProxyConfig = {
  enabled: true, hosts: ['*.googlevideo.com'], allowNonStandardPorts: false,
  maxRedirects: 3, requestTimeoutMs: DEFAULT_SEGMENT_TIMEOUT_MS,
}

function parseUrlDurationMs(raw: string): number | undefined {
  let url: URL
  try { url = new URL(raw) } catch { return undefined }
  const param = url.searchParams.get('dur') ?? /\/dur\/(\d+(?:\.\d+)?)(?:\/|$)/i.exec(url.pathname)?.[1] ?? null
  if (param === null || !/^\d+(?:\.\d+)?$/.test(param)) return undefined
  const ms = Math.round(Number(param) * 1000)
  return Number.isFinite(ms) && ms >= MIN_SEGMENT_MS && ms <= MAX_SEGMENT_MS ? ms : undefined
}

function parseHeadTimeMillis(headers: Headers): number | undefined {
  const raw = headers.get('x-head-time-millis')
  if (raw === null || !/^\d+(?:\.\d+)?$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined
}

function behindHeadFor(segmentMs: number): number {
  return Math.min(MAX_BEHIND_HEAD, Math.max(MIN_BEHIND_HEAD, Math.ceil(TARGET_INITIAL_BUFFER_MS / segmentMs)))
}

function createDurationEstimator(initialUrlMs?: number) {
  let currentMs = initialUrlMs ?? DEFAULT_SEGMENT_MS
  let hasHeaderDelta = false
  const hasUrlDuration = initialUrlMs !== undefined
  let lastHeaderSample: { head: number; headTimeMs: number } | undefined
  let initialWallSample: { head: number; at: number } | undefined
  const wallSamples: Array<{ head: number; at: number }> = []

  return {
    observe(head: number, observedAt: number, headTimeMs?: number): void {
      if (headTimeMs !== undefined) {
        if (!lastHeaderSample) {
          lastHeaderSample = { head, headTimeMs }
          if (!hasUrlDuration && !hasHeaderDelta) {
            const ratio = head > 0 ? headTimeMs / head : headTimeMs
            if (ratio >= MIN_SEGMENT_MS && ratio <= MAX_SEGMENT_MS) currentMs = Math.round(ratio)
          }
        } else if (head > lastHeaderSample.head && headTimeMs > lastHeaderSample.headTimeMs) {
          const delta = (headTimeMs - lastHeaderSample.headTimeMs) / (head - lastHeaderSample.head)
          lastHeaderSample = { head, headTimeMs }
          if (delta >= MIN_SEGMENT_MS && delta <= MAX_SEGMENT_MS) {
            currentMs = Math.round(delta)
            hasHeaderDelta = true
          }
        }
      }
      if (hasHeaderDelta || hasUrlDuration) return
      if (!initialWallSample) {
        initialWallSample = { head, at: observedAt }
        return
      }
      const previousHead = wallSamples.length > 0 ? wallSamples.at(-1)!.head : initialWallSample.head
      if (head <= previousHead) return
      if (wallSamples.length === 0) {
        if (head - initialWallSample.head >= 2) {
          const elapsed = observedAt - initialWallSample.at
          if (elapsed >= MIN_SEGMENT_MS) {
            const candidate = elapsed / (head - initialWallSample.head)
            if (candidate >= MIN_SEGMENT_MS && candidate <= MAX_SEGMENT_MS) currentMs = Math.round(candidate)
          }
        }
        wallSamples.push({ head, at: observedAt })
        return
      }
      wallSamples.push({ head, at: observedAt })
      if (wallSamples.length > 6) wallSamples.shift()
      const oldest = wallSamples[0]!
      const elapsed = observedAt - oldest.at
      const advanced = head - oldest.head
      if (advanced > 0 && elapsed >= MIN_SEGMENT_MS) {
        const candidate = elapsed / advanced
        if (candidate >= MIN_SEGMENT_MS && candidate <= MAX_SEGMENT_MS) currentMs = Math.round(candidate)
      }
    },
    durationMs(): number { return currentMs },
  }
}

function requireMediaUrl(raw: string | URL | Request): URL {
  let url: URL
  try { url = new URL(raw instanceof Request ? raw.url : raw) } catch { throw new AdaptivePullError('adaptive-unsafe-url') }
  if (url.protocol !== 'https:' || url.port || url.username || url.password
    || !url.hostname.toLowerCase().endsWith('.googlevideo.com') || /[\r\n\0]/.test(String(raw))) {
    throw new AdaptivePullError('adaptive-unsafe-url')
  }
  return url
}

function abortError(): AdaptivePullError { return new AdaptivePullError('adaptive-aborted') }

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { reject(abortError()) }
    task.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
    if (signal.aborted) { reject(abortError()); return }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return }
    const onAbort = () => { clearTimeout(timer); reject(abortError()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function readBounded(response: Response, limit: number, signal: AbortSignal, idleTimeoutMs = 0): Promise<Buffer> {
  const size = Number(response.headers.get('content-length'))
  if (Number.isFinite(size) && size > limit) {
    void response.body?.cancel().catch(() => {})
    throw new AdaptivePullError('adaptive-segment-too-large')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new AdaptivePullError('adaptive-request-failed')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const readStep = idleTimeoutMs > 0
        ? Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            idleTimer = setTimeout(() => reject(new AdaptivePullError('adaptive-request-failed')), idleTimeoutMs)
          }),
        ])
        : reader.read()
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await abortable(readStep, signal) }
      finally { if (idleTimer !== undefined) clearTimeout(idleTimer) }
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) throw new AdaptivePullError('adaptive-segment-too-large')
      chunks.push(chunk.value)
    }
    if (bytes === 0) throw new AdaptivePullError('adaptive-request-failed')
    return Buffer.concat(chunks, bytes)
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Wait for both the write callback and drain before requesting the next sq. */
function writeBytes(stream: Writable, bytes: Buffer, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let accepted: boolean | undefined
    let drained = false
    let completed = false
    const cleanup = () => {
      stream.removeListener('drain', onDrain)
      stream.removeListener('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (error: AdaptivePullError) => { cleanup(); reject(error) }
    const check = () => { if (completed && (accepted || drained)) { cleanup(); resolve() } }
    const onDrain = () => { drained = true; check() }
    const onClose = () => { fail(new AdaptivePullError('adaptive-pipe-failed')) }
    const onAbort = () => { fail(abortError()) }
    if (signal.aborted) { reject(abortError()); return }
    if (stream.destroyed || stream.writableEnded) { reject(new AdaptivePullError('adaptive-pipe-failed')); return }
    stream.on('drain', onDrain)
    stream.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      accepted = stream.write(bytes, error => {
        if (error) fail(new AdaptivePullError('adaptive-pipe-failed'))
        else { completed = true; check() }
      })
      check()
    } catch { fail(new AdaptivePullError('adaptive-pipe-failed')) }
  })
}

/**
 * Byte-concatenate each elementary stream into its own mux pipe. A failed segment
 * never advances sq: the owner re-resolves both URLs and starts a discontinuity.
 */
export async function pullAdaptive(source: AdaptiveSource, options: AdaptivePullOptions): Promise<void> {
  requireMediaUrl(source.videoUrl)
  requireMediaUrl(source.audioUrl)
  const configuredTimeoutMs = options.network?.media?.requestTimeoutMs
  const timeoutMs = options.requestTimeoutMs ?? (configuredTimeoutMs && configuredTimeoutMs > 0 ? configuredTimeoutMs : policy.requestTimeoutMs)
  const configuredRetries = options.network?.media?.reconnectAttempts
  const maxAttempts = configuredRetries && configuredRetries > 0 ? Math.min(configuredRetries, 6) : MAX_ATTEMPTS
  const maxBytes = options.maxSegmentBytes ?? 32 * 1024 * 1024
  const bodyIdleTimeoutMs = options.bodyIdleTimeoutMs
    ?? (timeoutMs > DEFAULT_BODY_IDLE_TIMEOUT_MS ? DEFAULT_BODY_IDLE_TIMEOUT_MS : 0)
  const prefetchCount = options.prefetch === undefined
    ? DEFAULT_PREFETCH_AHEAD
    : Math.max(0, Math.min(MAX_PREFETCH_AHEAD, Math.floor(options.prefetch)))
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(bodyIdleTimeoutMs) || bodyIdleTimeoutMs < 0 || bodyIdleTimeoutMs > 2_147_483_647
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) {
    throw new AdaptivePullError('adaptive-request-failed')
  }
  const dispatcherPool = options.fetchImpl ? undefined : new PinnedDispatcherPool({ connections: 6, allowH2: true })
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, options.signal, ...(options.network?.signal ? [options.network.signal] : [])])
  const now = options.now ?? Date.now
  const wait = options.sleep ?? sleep
  const doFetch = options.fetchImpl ?? fetch
  // safeFetch rechecks DNS and the allowlist for every redirect; this wrapper also
  // refuses cleartext, credentials and nonstandard ports on every validated hop.
  const checkedFetch: typeof fetch = (input, init) => {
    if (init?.signal?.aborted) return Promise.reject(abortError())
    return doFetch(requireMediaUrl(input), init)
  }

  const estimator = createDurationEstimator(parseUrlDurationMs(source.videoUrl) ?? parseUrlDurationMs(source.audioUrl))

  const segment = async (base: string, sq: number, probe = false): Promise<{ head: number; bytes: Buffer; observedAt: number }> => {
    const url = requireMediaUrl(base)
    url.searchParams.set('sq', String(sq))
    let attempt = 0
    let pendingStartedAt: number | undefined
    let pendingPolls = 0
    while (attempt < maxAttempts) {
      if (signal.aborted) throw abortError()
      const request = new AbortController()
      const requestSignal = AbortSignal.any([signal, request.signal])
      const timer = timeoutMs > 0 ? setTimeout(() => { request.abort() }, timeoutMs) : undefined
      let notPublishedDelayMs: number | undefined
      let pendingExhausted = false
      try {
        const operation = (async () => {
          const startedAt = now()
          const { response } = await safeFetch(url.toString(), policy, {
            fetchImpl: checkedFetch, network: options.network, resolve: options.resolve, signal: requestSignal,
            headers: { Accept: '*/*' },
            // Share one per-session pool across video/audio tracks on the same googlevideo origin.
            ...(dispatcherPool && attempt === 0 ? { dispatcherPool, connectionScope: 'adaptive' } : {}),
          })
          const headersAt = now()
          if (response.status === 403 || response.status === 410) {
            void response.body?.cancel().catch(() => {})
            throw new AdaptivePullError('adaptive-expired', response.status)
          }
          const rawHead = response.headers.get('x-head-seqnum')
          const head = Number(rawHead)
          const validHead = rawHead !== null && /^\d+$/.test(rawHead) && Number.isSafeInteger(head)
          const headTimeMs = parseHeadTimeMillis(response.headers)
          if (validHead) estimator.observe(head, headersAt, headTimeMs)
          // Discovery needs only headers, including when an old sq=0 was evicted.
          // Cancel the unused historical body rather than downloading a full segment.
          if (probe && (response.ok || response.status === 404) && validHead) {
            void response.body?.cancel().catch(() => {})
            return { head, bytes: Buffer.alloc(0), observedAt: startedAt }
          }
          // A 404 with sq > advertised head means the segment is not published yet.
          // Poll briefly with a bounded budget instead of terminating ffmpeg immediately.
          if (response.status === 404 && validHead && sq > head) {
            void response.body?.cancel().catch(() => {})
            pendingStartedAt ??= headersAt
            const segmentMs = estimator.durationMs()
            const maxPendingWaitMs = Math.max(MIN_PENDING_WAIT_MS, segmentMs * 3)
            const pollMs = Math.min(MAX_PENDING_POLL_MS, Math.max(MIN_PENDING_POLL_MS, Math.round(segmentMs / 4)))
            if (pendingPolls < MAX_PENDING_POLLS && headersAt - pendingStartedAt < maxPendingWaitMs) {
              pendingPolls++
              attempt = 0
              notPublishedDelayMs = pollMs
              return undefined
            }
            pendingExhausted = true
            throw new AdaptivePullError('adaptive-request-failed', 404)
          }
          if (!response.ok) {
            void response.body?.cancel().catch(() => {})
            throw new AdaptivePullError('adaptive-request-failed', response.status)
          }
          if (!validHead) {
            void response.body?.cancel().catch(() => {})
            throw new AdaptivePullError('adaptive-invalid-head')
          }
          return { head, bytes: await readBounded(response, maxBytes, requestSignal, bodyIdleTimeoutMs), observedAt: startedAt }
        })()
        const result = await abortable(operation, requestSignal)
        if (result) return result
      } catch (error) {
        if (error instanceof StreamFailureError && attempt === maxAttempts - 1) throw error
        if (signal.aborted) throw abortError()
        const safe = error instanceof AdaptivePullError ? error : new AdaptivePullError(
          error && typeof error === 'object' && 'reason' in error ? 'adaptive-unsafe-url' : 'adaptive-request-failed',
        )
        if (pendingExhausted || (safe.code !== 'adaptive-request-failed' && safe.code !== 'adaptive-aborted')) throw safe
        if (attempt === maxAttempts - 1) throw new AdaptivePullError('adaptive-request-failed', safe.status)
        attempt++
      } finally { clearTimeout(timer) }
      const retryDelayMs = attempt === 1 ? FIRST_RETRY_BACKOFF_MS : Math.min(attempt, 6) * 350
      await wait(notPublishedDelayMs ?? retryDelayMs, signal)
    }
    throw new AdaptivePullError('adaptive-request-failed')
  }

  let rejectPipe: (error: AdaptivePullError) => void = () => {}
  const pipeFailure = new Promise<never>((_resolve, reject) => { rejectPipe = reject })
  const onPipeError = () => { rejectPipe(new AdaptivePullError('adaptive-pipe-failed')) }
  options.video.on('error', onPipeError)
  options.audio.on('error', onPipeError)
  let production: Promise<void> | undefined
  try {
    production = (async () => {
      const first = await segment(source.videoUrl, 0, true)
      options.progress?.({ track: 'probe', phase: 'received', sq: 0, head: first.head, bytes: first.bytes.length })
      const start = Math.max(0, first.head - behindHeadFor(estimator.durationMs()))
      const pull = async (base: string, output: Writable, track: 'video' | 'audio'): Promise<void> => {
        let sq = start
        let knownHead = first.head
        let warmed = false
        const inflight = new Map<number, Promise<{ head: number; bytes: Buffer; observedAt: number }>>()
        const enqueue = (targetSq: number): Promise<{ head: number; bytes: Buffer; observedAt: number }> => {
          let pending = inflight.get(targetSq)
          if (!pending) {
            pending = segment(base, targetSq)
            // Attach a no-op handler so a prefetched failure rejected before its turn
            // does not surface as an unhandled rejection; it still throws when awaited in order.
            void pending.catch(() => {})
            inflight.set(targetSq, pending)
          }
          return pending
        }
        const fillPrefetch = (fromSq: number, maxInflight: number): void => {
          if (!warmed || prefetchCount <= 0 || signal.aborted) return
          const limit = Math.min(knownHead, fromSq + prefetchCount - 1)
          for (let nextSq = fromSq; nextSq <= limit && inflight.size < maxInflight; nextSq++) {
            enqueue(nextSq)
          }
        }
        try {
          while (!signal.aborted) {
            const current = enqueue(sq)
            fillPrefetch(sq + 1, prefetchCount + 1)
            const item = await current
            inflight.delete(sq)
            warmed = true
            if (item.head > knownHead) knownHead = item.head
            options.progress?.({ track, phase: 'received', sq, head: item.head, bytes: item.bytes.length })
            // Keep at most `prefetchCount` already-advertised segments downloading while writing
            // the current segment; pipe backpressure naturally halts further enqueues.
            fillPrefetch(sq + 1, prefetchCount)
            await writeBytes(output, item.bytes, signal)
            options.progress?.({ track, phase: 'written', sq, head: item.head, bytes: item.bytes.length })
            sq++
            // Drain already advertised segments so the muxer can seal its first GOP and
            // playback has a complete segment ahead. Pace only once the advertised head is reached,
            // subtracting request, download and pipe-write elapsed time from the segment cadence.
            const delay = Math.max(0, (sq - item.head) * estimator.durationMs() - (now() - item.observedAt))
            if (delay > 0) await wait(delay, signal)
          }
          throw abortError()
        } finally {
          inflight.clear()
        }
      }
      const video = pull(source.videoUrl, options.video, 'video')
      const audio = pull(source.audioUrl, options.audio, 'audio')
      try { await Promise.all([video, audio]) } finally {
        controller.abort()
        await Promise.allSettled([video, audio])
      }
    })()
    await Promise.race([production, pipeFailure])
  } catch (error) {
    throw error instanceof AdaptivePullError ? error : new AdaptivePullError('adaptive-request-failed')
  } finally {
    controller.abort()
    await production?.catch(() => {})
    await dispatcherPool?.dispose().catch(() => {})
    options.video.removeListener('error', onPipeError)
    options.audio.removeListener('error', onPipeError)
  }
}
