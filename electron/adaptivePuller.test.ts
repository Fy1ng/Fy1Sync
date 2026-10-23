import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdaptivePullError, pullAdaptive, type AdaptivePullOptions, type AdaptiveSource } from './adaptivePuller'

const source: AdaptiveSource = {
  videoUrl: 'https://r1.example.googlevideo.com/videoplayback?token=PRIVATE_VIDEO',
  audioUrl: 'https://r1.example.googlevideo.com/videoplayback?token=PRIVATE_AUDIO',
  videoContainer: 'webm', height: 1440,
}
const publicDns = vi.fn(async (_hostname: string) => ['142.250.0.1'])
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

function response(text: string, head = '100', status = 200): Response {
  return new Response(text, { status, headers: { 'x-head-seqnum': head } })
}
function sink(chunks: string[] = []): Writable {
  return new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(chunk.toString()); callback() } })
}
function harness(fetcher: typeof fetch, extra: Partial<AdaptivePullOptions> = {}) {
  const controller = new AbortController()
  const video: string[] = [], audio: string[] = []
  const pending = pullAdaptive(source, {
    video: sink(video), audio: sink(audio), signal: controller.signal,
    resolve: publicDns, fetchImpl: fetcher, ...extra,
  }).catch((error: unknown) => error)
  return { controller, video, audio, pending }
}
async function flush() { await vi.advanceTimersByTimeAsync(0) }

describe('adaptive sq acquisition', () => {
  it('discovers the current head when an old broadcast has evicted sq zero', async () => {
    vi.useFakeTimers()
    const calls: number[] = []
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const sq = Number(new URL(String(input)).searchParams.get('sq'))
      calls.push(sq)
      return sq === 0 ? response('evicted old segment', '100', 404) : response(`media-${sq}`, '100')
    }) as typeof fetch
    const h = harness(fetcher)
    await flush()
    expect(calls).toEqual([0, 98, 98])
    expect(h.video).toEqual(['media-98'])
    expect(h.audio).toEqual(['media-98'])
    h.controller.abort()
    await h.pending
  })

  it('does not accept a 404 media segment as successful even when it advertises a head', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const sq = Number(new URL(String(input)).searchParams.get('sq'))
      return response('not media', '100', sq === 0 ? 200 : 404)
    }) as typeof fetch
    const h = harness(fetcher)
    await vi.advanceTimersByTimeAsync(1600)
    expect(await h.pending).toMatchObject({ code: 'adaptive-request-failed', status: 404 })
    expect(h.video).toEqual([])
    expect(h.audio).toEqual([])
  })
  it('starts two behind the probed head and paces both streams using advancing head headers', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const calls: { sq: number; track: string; at: number }[] = []
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      const sq = Number(url.searchParams.get('sq'))
      const track = url.searchParams.get('token') === 'PRIVATE_VIDEO' ? 'v' : 'a'
      calls.push({ sq, track, at: Date.now() - start })
      return response(`${track}${sq}`, String(100 + Math.floor((Date.now() - start) / 5000)))
    }) as typeof fetch
    const h = harness(fetcher)
    await flush()
    expect(calls).toEqual([{ sq: 0, track: 'v', at: 0 }, { sq: 98, track: 'v', at: 0 }, { sq: 98, track: 'a', at: 0 }])
    expect(h.video).toEqual(['v98'])
    expect(h.audio).toEqual(['a98'])
    await vi.advanceTimersByTimeAsync(4999)
    expect(calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.slice(3)).toEqual([{ sq: 99, track: 'v', at: 5000 }, { sq: 99, track: 'a', at: 5000 }])
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.video).toEqual(['v98', 'v99', 'v100'])
    expect(h.audio).toEqual(['a98', 'a99', 'a100'])
    h.controller.abort()
    expect(await h.pending).toMatchObject({ code: 'adaptive-aborted' })
  })

  it('tracks a head jump and catches up without skipping any sq bytes', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input)), sq = Number(url.searchParams.get('sq'))
      return response(String(sq), sq === 0 ? '10' : '12')
    }) as typeof fetch
    const h = harness(fetcher)
    await flush()
    expect(h.video).toEqual(['8', '9', '10'])
    expect(h.audio).toEqual(['8', '9', '10'])
    h.controller.abort()
    await h.pending
  })

  it('never starts with a negative sq when the live head is young', async () => {
    vi.useFakeTimers()
    const calls: number[] = []
    const h = harness(vi.fn(async (input: string | URL | Request) => {
      calls.push(Number(new URL(String(input)).searchParams.get('sq')))
      return response('bytes', '1')
    }) as typeof fetch)
    await flush()
    expect(calls).toEqual([0, 0, 0])
    h.controller.abort()
    await h.pending
  })

  it('retries the same sq at most three times before asking the owner to reconnect', async () => {
    vi.useFakeTimers()
    const calls: number[] = []
    const h = harness(vi.fn(async (input: string | URL | Request) => {
      calls.push(Number(new URL(String(input)).searchParams.get('sq')))
      return response('upstream includes PRIVATE_COOKIE https://secret.invalid/', '100', 503)
    }) as typeof fetch)
    await flush()
    expect(calls).toEqual([0])
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual([0, 0])
    await vi.advanceTimersByTimeAsync(1000)
    const error = await h.pending
    expect(calls).toEqual([0, 0, 0])
    expect(error).toMatchObject({ code: 'adaptive-request-failed', status: 503 })
    expect(String(error)).not.toMatch(/PRIVATE|https:/)
  })

  it.each([403, 410])('immediately hands HTTP %i to the owner for URL/token re-resolution', async (status) => {
    const fetcher = vi.fn(async () => response('PRIVATE_TOKEN', '100', status)) as typeof fetch
    const h = harness(fetcher)
    expect(await h.pending).toMatchObject({ code: 'adaptive-expired', status })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('cancels the other stream when one stream expires mid-run', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const h = harness(vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input)), sq = Number(url.searchParams.get('sq'))
      calls.push(`${url.searchParams.get('token')}:${sq}`)
      return response('bytes', '100', sq === 98 && url.searchParams.get('token') === 'PRIVATE_AUDIO' ? 403 : 200)
    }) as typeof fetch)
    await flush()
    expect(await h.pending).toMatchObject({ code: 'adaptive-expired', status: 403 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toHaveLength(3)
  })

  it('waits for pipe backpressure without allowing same-stream sq reordering', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    let release: (() => void) | undefined
    const video = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback) {
      writes.push(chunk.toString())
      release = callback
    } })
    const calls: string[] = []
    const h = harness(vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input)), sq = Number(url.searchParams.get('sq'))
      const track = url.searchParams.get('token') === 'PRIVATE_VIDEO' ? 'v' : 'a'
      calls.push(`${track}${sq}`)
      return response(`${track}${sq}`, sq === 0 ? '10' : '12')
    }) as typeof fetch, { video })
    await flush()
    expect(writes).toEqual(['v8'])
    expect(calls.filter(call => call.startsWith('v'))).toEqual(['v0', 'v8'])
    expect(h.audio).toEqual(['a8', 'a9', 'a10'])
    release!()
    await flush()
    expect(writes).toEqual(['v8', 'v9'])
    expect(calls.filter(call => call.startsWith('v'))).toEqual(['v0', 'v8', 'v9'])
    h.controller.abort()
    await h.pending
    release!()
  })

  it('reports pipe failures as a fixed code without exposing diagnostics', async () => {
    const video = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('https://signed.invalid/?token=PRIVATE')) } })
    const h = harness(vi.fn(async () => response('bytes')) as typeof fetch, { video })
    const error = await h.pending
    expect(error).toBeInstanceOf(AdaptivePullError)
    expect(error).toMatchObject({ code: 'adaptive-pipe-failed' })
    expect(String(error)).not.toMatch(/PRIVATE|https:/)
  })

  it('times out stalled DNS operations and gives up after three bounded requests', async () => {
    vi.useFakeTimers()
    const resolve = vi.fn(() => new Promise<string[]>(() => {}))
    const fetcher = vi.fn() as typeof fetch
    const h = harness(fetcher, { resolve, requestTimeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(1800)
    expect(await h.pending).toMatchObject({ code: 'adaptive-request-failed' })
    expect(resolve).toHaveBeenCalledTimes(3)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('times out a stalled response body and cancels all three readers', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      headers: { 'x-head-seqnum': '100' },
    })) as typeof fetch
    const h = harness(fetcher, { requestTimeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(1800)
    expect(await h.pending).toMatchObject({ code: 'adaptive-request-failed' })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(cancel).toHaveBeenCalledTimes(3)
  })

  it('bounds streamed body bytes even without Content-Length', async () => {
    const h = harness(vi.fn(async () => response('12345')) as typeof fetch, { maxSegmentBytes: 4 })
    expect(await h.pending).toMatchObject({ code: 'adaptive-segment-too-large' })
    expect(h.video).toEqual([])
    expect(h.audio).toEqual([])
  })

  it.each(['', '-1', 'NaN', '9007199254740992'])('rejects invalid head %j without forwarding upstream body', async head => {
    const fetcher = vi.fn(async () => response('PRIVATE', head)) as typeof fetch
    const h = harness(fetcher)
    expect(await h.pending).toMatchObject({ code: 'adaptive-invalid-head' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(h.video).toEqual([])
  })

  it.each([
    'http://r1.example.googlevideo.com/video',
    'https://googlevideo.com/video',
    'https://r1.example.googlevideo.com.evil.invalid/video',
    'https://user:PRIVATE@r1.example.googlevideo.com/video',
    'https://r1.example.googlevideo.com:8443/video',
  ])('refuses unsafe source %s before DNS or request', async videoUrl => {
    const fetcher = vi.fn() as typeof fetch
    const error = await pullAdaptive({ ...source, videoUrl }, {
      video: sink(), audio: sink(), signal: new AbortController().signal, resolve: publicDns, fetchImpl: fetcher,
    }).catch(error => error)
    expect(error).toMatchObject({ code: 'adaptive-unsafe-url' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(publicDns).not.toHaveBeenCalled()
  })

  it('refuses DNS that resolves an allowlisted CDN to a private address', async () => {
    const fetcher = vi.fn() as typeof fetch
    const h = harness(fetcher, { resolve: async () => ['127.0.0.1'] })
    expect(await h.pending).toMatchObject({ code: 'adaptive-unsafe-url' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['https://example.com/PRIVATE', 'http://r2.example.googlevideo.com/PRIVATE'])('validates redirect %s before sending a second request', async location => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location } })) as typeof fetch
    const h = harness(fetcher)
    expect(await h.pending).toMatchObject({ code: 'adaptive-unsafe-url' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('validates each HTTPS CDN redirect and sends only fixed minimal headers', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://r2.example.googlevideo.com/video' } })) as typeof fetch
    const h = harness(fetcher)
    expect(await h.pending).toMatchObject({ code: 'adaptive-unsafe-url' })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(publicDns).toHaveBeenCalledTimes(4)
    for (const [, init] of vi.mocked(fetcher).mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', headers: { Accept: '*/*' } })
      expect(init?.headers).toEqual({ Accept: '*/*' })
    }
  })

  it('follows a public HTTPS CDN redirect after checking its DNS', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.hostname.startsWith('r1.')) return new Response(null, {
        status: 302, headers: { location: `https://r2.example.googlevideo.com/video?sq=${url.searchParams.get('sq')}` },
      })
      return response('redirected')
    }) as typeof fetch
    const h = harness(fetcher)
    await flush()
    expect(h.video).toEqual(['redirected'])
    expect(h.audio).toEqual(['redirected'])
    expect(publicDns.mock.calls.map(call => call[0])).toEqual([
      'r1.example.googlevideo.com', 'r2.example.googlevideo.com',
      'r1.example.googlevideo.com', 'r1.example.googlevideo.com',
      'r2.example.googlevideo.com', 'r2.example.googlevideo.com',
    ])
    h.controller.abort()
    await h.pending
  })

  it('honours cancellation during the initial probe without retries', async () => {
    const fetcher = vi.fn(async () => new Promise<Response>(() => {})) as typeof fetch
    const h = harness(fetcher)
    h.controller.abort()
    expect(await h.pending).toMatchObject({ code: 'adaptive-aborted' })
    expect(fetcher).toHaveBeenCalledTimes(0)
  })
})
