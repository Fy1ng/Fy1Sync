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
  headersTimeoutMs?: number
  bodyIdleTimeoutMs?: number
  /** Delay before launching a parallel backup connection for a slow live segment (0 disables). */
  hedgeDelayMs?: number
  maxSegmentBytes?: number
  /** Bounded lookahead segment downloads per track when behind the advertised head. */
  prefetch?: number
  /** Optional proactive URL refresh before signed googlevideo URLs expire. */
  refreshSource?: () => Promise<AdaptiveSource | null | undefined>
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
const DEFAULT_HEADERS_TIMEOUT_MS = 5_000
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 6_000
const DEFAULT_HEDGE_DELAY_MS = 3_500
const DEFAULT_PREFETCH_AHEAD = 2
const MAX_PREFETCH_AHEAD = 4
const FIRST_RETRY_BACKOFF_MS = 150
const EXPIRE_REFRESH_LEAD_MS = 10 * 60_000
const EXPIRE_REFRESH_COOLDOWN_MS = 2 * 60_000
const policy: ProxyConfig = {
  enabled: true, hosts: ['*.googlevideo.com'], allowNonStandardPorts: false,
  maxRedirects: 3, requestTimeoutMs: DEFAULT_SEGMENT_TIMEOUT_MS,
}

function parseUrlExpireMs(raw: string): number | undefined {
  let url: URL
  try { url = new URL(raw) } catch { return undefined }
  const param = url.searchParams.get('expire') ?? /\/expire\/(\d{9,12})(?:\/|$)/i.exec(url.pathname)?.[1] ?? null
  if (param === null || !/^\d{9,12}$/.test(param)) return undefined
  const ms = Number(param) * 1000
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined
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
  const headersTimeoutMs = options.headersTimeoutMs
    ?? (timeoutMs > DEFAULT_HEADERS_TIMEOUT_MS ? DEFAULT_HEADERS_TIMEOUT_MS : 0)
  const bodyIdleTimeoutMs = options.bodyIdleTimeoutMs
    ?? (timeoutMs > DEFAULT_BODY_IDLE_TIMEOUT_MS ? DEFAULT_BODY_IDLE_TIMEOUT_MS : 0)
  const hedgeDelayMs = options.hedgeDelayMs
    ?? (timeoutMs >= DEFAULT_BODY_IDLE_TIMEOUT_MS ? DEFAULT_HEDGE_DELAY_MS : 0)
  const prefetchCount = options.prefetch === undefined
    ? DEFAULT_PREFETCH_AHEAD
    : Math.max(0, Math.min(MAX_PREFETCH_AHEAD, Math.floor(options.prefetch)))
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(headersTimeoutMs) || headersTimeoutMs < 0 || headersTimeoutMs > 2_147_483_647
    || !Number.isSafeInteger(bodyIdleTimeoutMs) || bodyIdleTimeoutMs < 0 || bodyIdleTimeoutMs > 2_147_483_647
    || !Number.isSafeInteger(hedgeDelayMs) || hedgeDelayMs < 0 || hedgeDelayMs > 2_147_483_647
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) {
    throw new AdaptivePullError('adaptive-request-failed')
  }
  const dispatcherPool = options.fetchImpl ? undefined : new PinnedDispatcherPool({ connections: 8, allowH2: true })
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

  let activeVideoUrl = source.videoUrl
  let activeAudioUrl = source.audioUrl
  let activeExpireMs = (() => {
    const times = [parseUrlExpireMs(source.videoUrl), parseUrlExpireMs(source.audioUrl)].filter((v): v is number => v !== undefined)
    return times.length ? Math.min(...times) : undefined
  })()
  let refreshInflight: Promise<void> | undefined
  let lastRefreshAttemptAt = 0
  const maybeRefreshSource = (): void => {
    if (!options.refreshSource || activeExpireMs === undefined || refreshInflight || signal.aborted) return
    const current = now()
    if (activeExpireMs - current > EXPIRE_REFRESH_LEAD_MS) return
    if (lastRefreshAttemptAt > 0 && current - lastRefreshAttemptAt < EXPIRE_REFRESH_COOLDOWN_MS) return
    lastRefreshAttemptAt = current
    refreshInflight = Promise.resolve().then(() => options.refreshSource!()).then(refreshed => {
      if (!refreshed || signal.aborted || refreshed.videoContainer !== source.videoContainer) return
      requireMediaUrl(refreshed.videoUrl)
      requireMediaUrl(refreshed.audioUrl)
      activeVideoUrl = refreshed.videoUrl
      activeAudioUrl = refreshed.audioUrl
      const times = [parseUrlExpireMs(refreshed.videoUrl), parseUrlExpireMs(refreshed.audioUrl)].filter((v): v is number => v !== undefined)
      activeExpireMs = times.length ? Math.min(...times) : undefined
    }).catch(() => { /* Keep pulling with the current signed URLs until expiry forces reconnect. */ })
      .finally(() => { refreshInflight = undefined })
  }

  const estimator = createDurationEstimator(parseUrlDurationMs(source.videoUrl) ?? parseUrlDurationMs(source.audioUrl))

  type SegmentResult = { head: number; bytes: Buffer; observedAt: number }
  type AttemptOutcome = { kind: 'ok'; result: SegmentResult } | { kind: 'pending'; delayMs: number }

  const segment = async (getBase: () => string, sq: number, probe = false, allowHedge = false): Promise<SegmentResult> => {
    let attempt = 0
    let pendingStartedAt: number | undefined
    let pendingPolls = 0
    while (attempt < maxAttempts) {
      if (signal.aborted) throw abortError()
      if (!probe) maybeRefreshSource()
      const url = requireMediaUrl(getBase())
      url.searchParams.set('sq', String(sq))
      const request = new AbortController()
      const requestSignal = AbortSignal.any([signal, request.signal])
      const timer = timeoutMs > 0 ? setTimeout(() => { request.abort() }, timeoutMs) : undefined
      let notPublishedDelayMs: number | undefined
      let pendingExhausted = false
      const runSingleAttempt = async (usePool: boolean, attemptSignal: AbortSignal): Promise<AttemptOutcome> => {
        const startedAt = now()
        const headersAbort = new AbortController()
        const fetchSignal = headersTimeoutMs > 0 ? AbortSignal.any([attemptSignal, headersAbort.signal]) : attemptSignal
        const headersTimer = headersTimeoutMs > 0 ? setTimeout(() => { headersAbort.abort() }, headersTimeoutMs) : undefined
        let response: Response
        try {
          const fetched = await safeFetch(url.toString(), policy, {
            fetchImpl: checkedFetch, network: options.network, resolve: options.resolve, signal: fetchSignal,
            headers: { Accept: '*/*' },
            // Share one per-session pool across video/audio tracks on the same googlevideo origin.
            ...(dispatcherPool && usePool ? { dispatcherPool, connectionScope: 'adaptive' } : {}),
          })
          response = fetched.response
        } finally {
          if (headersTimer !== undefined) clearTimeout(headersTimer)
        }
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
          return { kind: 'ok', result: { head, bytes: Buffer.alloc(0), observedAt: startedAt } }
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
            return { kind: 'pending', delayMs: pollMs }
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
        return { kind: 'ok', result: { head, bytes: await readBounded(response, maxBytes, attemptSignal, bodyIdleTimeoutMs), observedAt: startedAt } }
      }
      const isTerminalError = (error: unknown): boolean => {
        if (error instanceof AdaptivePullError) {
          return error.code !== 'adaptive-request-failed' && error.code !== 'adaptive-aborted'
        }
        return Boolean(error && typeof error === 'object' && 'reason' in error)
      }
      const runWithOptionalHedge = (): Promise<AttemptOutcome> => {
        if (probe || !allowHedge || attempt !== 0 || hedgeDelayMs <= 0) {
          return runSingleAttempt(attempt === 0, requestSignal)
        }
        return new Promise<AttemptOutcome>((resolve, reject) => {
          const primaryCtrl = new AbortController()
          const backupCtrl = new AbortController()
          let settled = false
          let primaryDone = false
          let backupStarted = false
          let backupDone = false
          let firstError: unknown
          const finishResolve = (value: AttemptOutcome) => {
            if (settled) return
            settled = true
            clearTimeout(hedgeTimer)
            primaryCtrl.abort()
            backupCtrl.abort()
            resolve(value)
          }
          const finishReject = (error: unknown) => {
            if (settled) return
            settled = true
            clearTimeout(hedgeTimer)
            primaryCtrl.abort()
            backupCtrl.abort()
            reject(error)
          }
          const launchBackup = () => {
            if (settled || backupStarted || requestSignal.aborted) return
            backupStarted = true
            void runSingleAttempt(false, AbortSignal.any([requestSignal, backupCtrl.signal])).then(
              finishResolve,
              error => {
                backupDone = true
                if (settled) return
                if (isTerminalError(error) || primaryDone) finishReject(error)
                else firstError ??= error
              },
            )
          }
          const hedgeTimer = setTimeout(launchBackup, hedgeDelayMs)
          void runSingleAttempt(true, AbortSignal.any([requestSignal, primaryCtrl.signal])).then(
            finishResolve,
            error => {
              primaryDone = true
              if (settled) return
              if (isTerminalError(error)) { finishReject(error); return }
              if (backupStarted) {
                if (backupDone) finishReject(firstError ?? error)
                else firstError ??= error
              } else {
                finishReject(error)
              }
            },
          )
        })
      }
      try {
        const outcome = await abortable(runWithOptionalHedge(), requestSignal)
        if (outcome.kind === 'ok') return outcome.result
        notPublishedDelayMs = outcome.delayMs
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
      const first = await segment(() => activeVideoUrl, 0, true)
      options.progress?.({ track: 'probe', phase: 'received', sq: 0, head: first.head, bytes: first.bytes.length })
      const start = Math.max(0, first.head - behindHeadFor(estimator.durationMs()))
      const pull = async (getBase: () => string, output: Writable, track: 'video' | 'audio'): Promise<void> => {
        let sq = start
        let knownHead = first.head
        let warmed = false
        const inflight = new Map<number, Promise<SegmentResult>>()
        const enqueue = (targetSq: number): Promise<SegmentResult> => {
          let pending = inflight.get(targetSq)
          if (!pending) {
            pending = segment(getBase, targetSq, false, warmed)
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
      const video = pull(() => activeVideoUrl, options.video, 'video')
      const audio = pull(() => activeAudioUrl, options.audio, 'audio')
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
