import type { Writable } from 'node:stream'
import { safeFetch, type Resolver } from '../server/safeFetch'
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
  fetchImpl?: typeof fetch
  resolve?: Resolver
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  requestTimeoutMs?: number
  maxSegmentBytes?: number
  progress?: (event: { track: 'probe' | 'video' | 'audio'; phase: 'received' | 'written'; sq: number; head: number; bytes: number }) => void
}

const SEGMENT_MS = 5000
const BEHIND_HEAD = 2
const MAX_ATTEMPTS = 3
const policy: ProxyConfig = {
  enabled: true, hosts: ['*.googlevideo.com'], allowNonStandardPorts: false,
  allowNonLoopbackTargets: false, maxRedirects: 3, requestTimeoutMs: 20_000,
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

async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
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
      const chunk = await abortable(reader.read(), signal)
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
  const timeoutMs = options.requestTimeoutMs ?? policy.requestTimeoutMs
  const maxBytes = options.maxSegmentBytes ?? 32 * 1024 * 1024
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) {
    throw new AdaptivePullError('adaptive-request-failed')
  }
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, options.signal])
  const now = options.now ?? Date.now
  const wait = options.sleep ?? sleep
  const doFetch = options.fetchImpl ?? fetch
  // safeFetch rechecks DNS and the allowlist for every redirect; this wrapper also
  // refuses cleartext, credentials and nonstandard ports on every validated hop.
  const checkedFetch: typeof fetch = (input, init) => {
    if (init?.signal?.aborted) return Promise.reject(abortError())
    return doFetch(requireMediaUrl(input), init)
  }

  const segment = async (base: string, sq: number, probe = false): Promise<{ head: number; bytes: Buffer }> => {
    const url = requireMediaUrl(base)
    url.searchParams.set('sq', String(sq))
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal.aborted) throw abortError()
      const request = new AbortController()
      const requestSignal = AbortSignal.any([signal, request.signal])
      const timer = setTimeout(() => { request.abort() }, timeoutMs)
      try {
        const operation = (async () => {
          const { response } = await safeFetch(url.toString(), policy, {
            fetchImpl: checkedFetch, resolve: options.resolve, signal: requestSignal,
            headers: { Accept: '*/*' },
          })
          if (response.status === 403 || response.status === 410) {
            void response.body?.cancel().catch(() => {})
            throw new AdaptivePullError('adaptive-expired', response.status)
          }
          const rawHead = response.headers.get('x-head-seqnum')
          const head = Number(rawHead)
          const validHead = rawHead !== null && /^\d+$/.test(rawHead) && Number.isSafeInteger(head)
          // Long-running broadcasts can evict sq=0 while still advertising their
          // current head on its 404 response. This is discovery, never a media gap.
          if (probe && response.status === 404 && validHead) {
            void response.body?.cancel().catch(() => {})
            return { head, bytes: Buffer.alloc(0) }
          }
          if (!response.ok) {
            void response.body?.cancel().catch(() => {})
            throw new AdaptivePullError('adaptive-request-failed', response.status)
          }
          if (!validHead) {
            void response.body?.cancel().catch(() => {})
            throw new AdaptivePullError('adaptive-invalid-head')
          }
          return { head, bytes: await readBounded(response, maxBytes, requestSignal) }
        })()
        return await abortable(operation, requestSignal)
      } catch (error) {
        if (signal.aborted) throw abortError()
        const safe = error instanceof AdaptivePullError ? error : new AdaptivePullError(
          error && typeof error === 'object' && 'reason' in error ? 'adaptive-unsafe-url' : 'adaptive-request-failed',
        )
        if (safe.code !== 'adaptive-request-failed' && safe.code !== 'adaptive-aborted') throw safe
        if (attempt === MAX_ATTEMPTS - 1) throw new AdaptivePullError('adaptive-request-failed', safe.status)
      } finally { clearTimeout(timer) }
      await wait((attempt + 1) * 500, signal)
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
      const start = Math.max(0, first.head - BEHIND_HEAD)
      const pull = async (base: string, output: Writable, track: 'video' | 'audio'): Promise<void> => {
        let sq = start
        while (!signal.aborted) {
          const item = await segment(base, sq)
          options.progress?.({ track, phase: 'received', sq, head: item.head, bytes: item.bytes.length })
          const observedAt = now()
          await writeBytes(output, item.bytes, signal)
          options.progress?.({ track, phase: 'written', sq, head: item.head, bytes: item.bytes.length })
          sq++
          // A newer head permits catch-up; otherwise hold approximately two 5 s
          // segments behind it instead of busy-polling an unfinished live sq.
          const delay = Math.max(0, (sq - Math.max(0, item.head - BEHIND_HEAD)) * SEGMENT_MS - (now() - observedAt))
          if (delay > 0) await wait(delay, signal)
        }
        throw abortError()
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
    options.video.removeListener('error', onPipeError)
    options.audio.removeListener('error', onPipeError)
  }
}
