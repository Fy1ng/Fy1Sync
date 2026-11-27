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
    expect(calls[0]).toBe(0)
    expect([...calls.slice(1)].sort((a, b) => a - b)).toEqual([98, 98, 99, 99, 100, 100])
    expect(h.video).toEqual(['media-98', 'media-99', 'media-100'])
    expect(h.audio).toEqual(['media-98', 'media-99', 'media-100'])
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
    expect(calls).toHaveLength(7)
    expect(calls.filter(call => call.track === 'v')).toEqual([
      { sq: 0, track: 'v', at: 0 }, { sq: 98, track: 'v', at: 0 },
      { sq: 99, track: 'v', at: 0 }, { sq: 100, track: 'v', at: 0 },
    ])
    expect(calls.filter(call => call.track === 'a')).toEqual([
      { sq: 98, track: 'a', at: 0 }, { sq: 99, track: 'a', at: 0 }, { sq: 100, track: 'a', at: 0 },
    ])
    expect(h.video).toEqual(['v98', 'v99', 'v100'])
    expect(h.audio).toEqual(['a98', 'a99', 'a100'])
    await vi.advanceTimersByTimeAsync(4999)
    expect(calls).toHaveLength(7)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.slice(7)).toEqual([{ sq: 101, track: 'v', at: 5000 }, { sq: 101, track: 'a', at: 5000 }])
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.video).toEqual(['v98', 'v99', 'v100', 'v101', 'v102'])
    expect(h.audio).toEqual(['a98', 'a99', 'a100', 'a101', 'a102'])
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
    expect(h.video).toEqual(['8', '9', '10', '11', '12'])
    expect(h.audio).toEqual(['8', '9', '10', '11', '12'])
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
    expect(calls[0]).toBe(0)
    expect([...calls.slice(1)].sort((a, b) => a - b)).toEqual([0, 0, 1, 1])
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

  it('waits for pipe backpressure with bounded prefetch and without same-stream sq reordering', async () => {
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
    // Bounded prefetch starts at most two advertised segments ahead while write is blocked.
    expect(calls.filter(call => call.startsWith('v'))).toEqual(['v0', 'v8', 'v9', 'v10'])
    expect(h.audio).toEqual(['a8', 'a9', 'a10', 'a11', 'a12'])
    release!()
    await flush()
    expect(writes).toEqual(['v8', 'v9'])
    expect(calls.filter(call => call.startsWith('v'))).toEqual(['v0', 'v8', 'v9', 'v10', 'v11'])
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

  it('cancels discovery and bounds each stalled media track to three body reads', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      headers: { 'x-head-seqnum': '100' },
    })) as typeof fetch
    const h = harness(fetcher, { requestTimeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(1800)
    expect(await h.pending).toMatchObject({ code: 'adaptive-request-failed' })
    expect(fetcher).toHaveBeenCalledTimes(7)
    expect(cancel).toHaveBeenCalledTimes(7)
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

  it('refuses DNS that resolves an allowlisted CDN to an invalid address', async () => {
    const fetcher = vi.fn() as typeof fetch
    const h = harness(fetcher, { resolve: async () => ['invalid-address'] })
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
    expect(h.video).toEqual(['redirected', 'redirected', 'redirected'])
    expect(h.audio).toEqual(['redirected', 'redirected', 'redirected'])
    const dnsHosts = publicDns.mock.calls.map(call => call[0])
    expect(dnsHosts).toHaveLength(14)
    expect(dnsHosts.filter(host => host === 'r1.example.googlevideo.com')).toHaveLength(7)
    expect(dnsHosts.filter(host => host === 'r2.example.googlevideo.com')).toHaveLength(7)
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

  it('discovers the live head from headers without reading an unused media body', async () => {
    vi.useFakeTimers()
    const probe = response('unused historical segment')
    const read = vi.spyOn(probe.body!, 'getReader')
    const cancel = vi.spyOn(probe.body!, 'cancel')
    const h = harness(vi.fn(async (input: string | URL | Request) => {
      const sq = Number(new URL(String(input)).searchParams.get('sq'))
      return sq === 0 ? probe : response(`segment-${sq}`)
    }) as typeof fetch)
    await flush()
    expect(read).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
    expect(h.video).toEqual(['segment-98', 'segment-99', 'segment-100'])
    h.controller.abort()
    await h.pending
  })

  it('subtracts request and download latency from pacing so cadence does not drift slower than realtime', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const startedAt: { sq: number; track: string; at: number }[] = []
    const timedSource: AdaptiveSource = {
      videoUrl: 'https://r1.example.googlevideo.com/videoplayback?token=PRIVATE_VIDEO&dur=2.000',
      audioUrl: 'https://r1.example.googlevideo.com/videoplayback?token=PRIVATE_AUDIO&dur=2.000',
      videoContainer: 'webm', height: 1440,
    }
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      const sq = Number(url.searchParams.get('sq'))
      const track = url.searchParams.get('token') === 'PRIVATE_VIDEO' ? 'v' : 'a'
      startedAt.push({ sq, track, at: Date.now() - start })
      // Simulate 1200ms download latency on sq=100 (head=100) so only 800ms should remain before sq=101.
      if (sq === 100) await new Promise(resolve => setTimeout(resolve, 1200))
      const head = 100 + Math.floor((Date.now() - start) / 2000)
      return response(`${track}${sq}`, String(head))
    }) as typeof fetch
    const controller = new AbortController()
    const video: string[] = [], audio: string[] = []
    const pending = pullAdaptive(timedSource, {
      video: sink(video), audio: sink(audio), signal: controller.signal,
      resolve: publicDns, fetchImpl: fetcher,
    }).catch((error: unknown) => error)
    await flush()
    // dur=2.000 starts 4 behind head (96..100 = 5 segments = 10s initial cushion).
    expect(startedAt.filter(call => call.track === 'v').map(call => call.sq)).toEqual([0, 96, 97, 98, 99, 100])
    await vi.advanceTimersByTimeAsync(1200)
    expect(video).toEqual(['v96', 'v97', 'v98', 'v99', 'v100'])
    await vi.advanceTimersByTimeAsync(799)
    expect(startedAt.some(call => call.sq === 101)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(startedAt.filter(call => call.sq === 101)).toEqual([
      { sq: 101, track: 'v', at: 2000 },
      { sq: 101, track: 'a', at: 2000 },
    ])
    controller.abort()
    await pending
  })

  it('adapts initial behind-head cushion and cadence for 1s segments via URL dur', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const calls: { sq: number; track: string; at: number }[] = []
    const lowLatencySource: AdaptiveSource = {
      videoUrl: 'https://r1.example.googlevideo.com/videoplayback?token=PRIVATE_VIDEO&dur=1.000',
      audioUrl: 'https://r1.example.googlevideo.com/videoplayback?token=PRIVATE_AUDIO&dur=1.000',
      videoContainer: 'webm', height: 1440,
    }
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      const sq = Number(url.searchParams.get('sq'))
      const track = url.searchParams.get('token') === 'PRIVATE_VIDEO' ? 'v' : 'a'
      calls.push({ sq, track, at: Date.now() - start })
      return response(`${track}${sq}`, String(100 + Math.floor((Date.now() - start) / 1000)))
    }) as typeof fetch
    const controller = new AbortController()
    const video: string[] = [], audio: string[] = []
    const pending = pullAdaptive(lowLatencySource, {
      video: sink(video), audio: sink(audio), signal: controller.signal,
      resolve: publicDns, fetchImpl: fetcher,
    }).catch((error: unknown) => error)
    await flush()
    expect(video).toEqual(['v92', 'v93', 'v94', 'v95', 'v96', 'v97', 'v98', 'v99', 'v100'])
    await vi.advanceTimersByTimeAsync(999)
    expect(calls.some(call => call.sq === 101)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.filter(call => call.sq === 101)).toEqual([
      { sq: 101, track: 'v', at: 1000 },
      { sq: 101, track: 'a', at: 1000 },
    ])
    controller.abort()
    await pending
  })

  it('estimates segment duration from x-head-time-millis headers (both initial ratio and advancing deltas)', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const calls: { sq: number; at: number }[] = []
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const sq = Number(new URL(String(input)).searchParams.get('sq'))
      const elapsed = Date.now() - start
      calls.push({ sq, at: elapsed })
      const head = 100 + Math.floor(elapsed / 2000)
      return new Response(`seg-${sq}`, {
        status: 200,
        headers: { 'x-head-seqnum': String(head), 'x-head-time-millis': String(head * 2000) },
      })
    }) as typeof fetch
    const h = harness(fetcher)
    await flush()
    // 200000 / 100 = 2000ms -> 4 segments behind head (96..100).
    expect(h.video).toEqual(['seg-96', 'seg-97', 'seg-98', 'seg-99', 'seg-100'])
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls.some(call => call.sq === 101)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.video).toEqual(['seg-96', 'seg-97', 'seg-98', 'seg-99', 'seg-100', 'seg-101'])
    h.controller.abort()
    await h.pending
  })

  it('adapts segment duration from epoch-scale x-head-time-millis deltas when dur is absent', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const epochBase = 1_700_000_000_000
    const calls: { sq: number; at: number }[] = []
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const sq = Number(new URL(String(input)).searchParams.get('sq'))
      const elapsed = Date.now() - start
      calls.push({ sq, at: elapsed })
      const head = 100 + Math.floor(elapsed / 2000)
      return new Response(`seg-${sq}`, {
        status: 200,
        headers: { 'x-head-seqnum': String(head), 'x-head-time-millis': String(epochBase + head * 2000) },
      })
    }) as typeof fetch
    const h = harness(fetcher)
    await flush()
    // Epoch ratio is out of bounds so initial cadence starts at 5000ms (98..100).
    expect(h.video).toEqual(['seg-98', 'seg-99', 'seg-100'])
    // After 5000ms, head has advanced to 102 with delta 4000ms / 2 = 2000ms.
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.video).toEqual(['seg-98', 'seg-99', 'seg-100', 'seg-101', 'seg-102'])
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls.some(call => call.sq === 103)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.video).toContain('seg-103')
    h.controller.abort()
    await h.pending
  })

  it('adapts segment duration from wall-clock x-head-seqnum increments when neither dur nor x-head-time-millis is present', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const sq = Number(new URL(String(input)).searchParams.get('sq'))
      const elapsed = Date.now() - start
      const head = 100 + Math.floor(elapsed / 2000)
      return response(`seg-${sq}`, String(head))
    }) as typeof fetch
    const h = harness(fetcher)
    await flush()
    expect(h.video).toEqual(['seg-98', 'seg-99', 'seg-100'])
    // After the initial 5000ms fallback wait, head jumped by 2 (100 -> 102) so estimate shrinks to 2500ms.
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.video).toEqual(['seg-98', 'seg-99', 'seg-100', 'seg-101', 'seg-102'])
    // Next fetch happens at +2500ms (t=7500ms) instead of waiting another full 5000ms.
    await vi.advanceTimersByTimeAsync(2500)
    expect(h.video).toContain('seg-103')
    h.controller.abort()
    await h.pending
  })

  it('short-polls a not-yet-published 404 (sq > head) until available without terminating ffmpeg', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    let earlyHits = 0
    const timedSource: AdaptiveSource = {
      videoUrl: 'https://r1.example.googlevideo.com/videoplayback?token=PRIVATE_VIDEO&dur=2.000',
      audioUrl: 'https://r1.example.googlevideo.com/videoplayback?token=PRIVATE_AUDIO&dur=2.000',
      videoContainer: 'webm', height: 1440,
    }
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const sq = Number(new URL(String(input)).searchParams.get('sq'))
      const elapsed = Date.now() - start
      // Delay sq=101 publication by 1500ms after the 2000ms mark (published at t=3500ms).
      const head = elapsed < 3500 ? 100 : 101
      if (sq > head) {
        earlyHits++
        return response('not published yet', String(head), 404)
      }
      return response(`seg-${sq}`, String(head), 200)
    }) as typeof fetch
    const controller = new AbortController()
    const video: string[] = [], audio: string[] = []
    const pending = pullAdaptive(timedSource, {
      video: sink(video), audio: sink(audio), signal: controller.signal,
      resolve: publicDns, fetchImpl: fetcher,
    }).catch((error: unknown) => error)
    await flush()
    expect(video).toEqual(['seg-96', 'seg-97', 'seg-98', 'seg-99', 'seg-100'])
    await vi.advanceTimersByTimeAsync(3600)
    expect(earlyHits).toBeGreaterThanOrEqual(4)
    expect(video).toEqual(['seg-96', 'seg-97', 'seg-98', 'seg-99', 'seg-100', 'seg-101'])
    expect(audio).toEqual(['seg-96', 'seg-97', 'seg-98', 'seg-99', 'seg-100', 'seg-101'])
    controller.abort()
    expect(await pending).toMatchObject({ code: 'adaptive-aborted' })
  })

  it('bounds short-polling for a permanently stuck future segment (404 with sq > head)', async () => {
    vi.useFakeTimers()
    const timedSource: AdaptiveSource = {
      videoUrl: 'https://r1.example.googlevideo.com/videoplayback?token=PRIVATE_VIDEO&dur=2.000',
      audioUrl: 'https://r1.example.googlevideo.com/videoplayback?token=PRIVATE_AUDIO&dur=2.000',
      videoContainer: 'webm', height: 1440,
    }
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const sq = Number(new URL(String(input)).searchParams.get('sq'))
      return sq > 100 ? response('still unavailable', '100', 404) : response(`seg-${sq}`, '100', 200)
    }) as typeof fetch
    const controller = new AbortController()
    const video: string[] = [], audio: string[] = []
    const pending = pullAdaptive(timedSource, {
      video: sink(video), audio: sink(audio), signal: controller.signal,
      resolve: publicDns, fetchImpl: fetcher,
    }).catch((error: unknown) => error)
    await flush()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toMatchObject({ code: 'adaptive-request-failed', status: 404 })
  })

  it('prefetches advertised segments in parallel after warm-up and aborts stalled body reads via idle timeout', async () => {
    vi.useFakeTimers()
    let inflightVideo = 0
    let maxInflightVideo = 0
    let stalledOnce = false
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      const sq = Number(url.searchParams.get('sq'))
      const isVideo = url.searchParams.get('token') === 'PRIVATE_VIDEO'
      if (sq === 0) return response('probe', '100')
      if (isVideo && sq >= 99) {
        inflightVideo++
        maxInflightVideo = Math.max(maxInflightVideo, inflightVideo)
        try {
          if (sq === 100 && !stalledOnce) {
            stalledOnce = true
            await new Promise(resolve => setTimeout(resolve, 40))
            return new Response(new ReadableStream({
              start(controller) { controller.enqueue(new TextEncoder().encode('partial')) },
            }), { status: 200, headers: { 'x-head-seqnum': '100' } })
          }
          await new Promise(resolve => setTimeout(resolve, 40))
        } finally {
          inflightVideo--
        }
      }
      return response(`${isVideo ? 'v' : 'a'}${sq}`, '100')
    }) as typeof fetch
    const h = harness(fetcher, { requestTimeoutMs: 5000, bodyIdleTimeoutMs: 200 })
    await flush()
    await vi.advanceTimersByTimeAsync(600)
    expect(maxInflightVideo).toBeGreaterThanOrEqual(2)
    expect(h.video).toEqual(['v98', 'v99', 'v100'])
    expect(h.audio).toEqual(['a98', 'a99', 'a100'])
    h.controller.abort()
    await h.pending
  })

  it('hedges a slow live segment with a parallel backup request and cancels the slow one', async () => {
    vi.useFakeTimers()
    let slowAborted = false
    let video99Calls = 0
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const sq = Number(url.searchParams.get('sq'))
      const isVideo = url.searchParams.get('token') === 'PRIVATE_VIDEO'
      if (sq === 0) return response('probe', '100')
      if (isVideo && sq === 99) {
        video99Calls++
        if (video99Calls === 1) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              slowAborted = true
              reject(new DOMException('aborted', 'AbortError'))
            }, { once: true })
          })
        }
        return response('v99-hedged', '100')
      }
      return response(`${isVideo ? 'v' : 'a'}${sq}`, '100')
    }) as typeof fetch
    const h = harness(fetcher, { requestTimeoutMs: 5000, headersTimeoutMs: 4000, hedgeDelayMs: 200 })
    await flush()
    await vi.advanceTimersByTimeAsync(250)
    expect(video99Calls).toBe(2)
    expect(slowAborted).toBe(true)
    expect(h.video).toEqual(['v98', 'v99-hedged', 'v100'])
    h.controller.abort()
    await h.pending
  })

  it('proactively refreshes signed URLs before expire without interrupting the stream', async () => {
    vi.useFakeTimers()
    const baseNow = 1_700_000_000_000
    vi.setSystemTime(baseNow)
    const expiringSoon = Math.floor((baseNow + 5 * 60_000) / 1000)
    const freshExpire = Math.floor((baseNow + 6 * 3600_000) / 1000)
    const expiringSource: AdaptiveSource = {
      videoUrl: `https://r1.example.googlevideo.com/videoplayback?token=OLD_VIDEO&expire=${expiringSoon}&dur=2.000`,
      audioUrl: `https://r1.example.googlevideo.com/videoplayback?token=OLD_AUDIO&expire=${expiringSoon}&dur=2.000`,
      videoContainer: 'webm', height: 1440,
    }
    const refreshSource = vi.fn(async (): Promise<AdaptiveSource> => ({
      videoUrl: `https://r2.example.googlevideo.com/videoplayback?token=NEW_VIDEO&expire=${freshExpire}&dur=2.000`,
      audioUrl: `https://r2.example.googlevideo.com/videoplayback?token=NEW_AUDIO&expire=${freshExpire}&dur=2.000`,
      videoContainer: 'webm', height: 1440,
    }))
    const seenTokens: string[] = []
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      const sq = Number(url.searchParams.get('sq'))
      const token = url.searchParams.get('token') ?? ''
      seenTokens.push(`${token}:${sq}`)
      const elapsed = Date.now() - baseNow
      const head = 100 + Math.floor(elapsed / 2000)
      return response(`${token}:${sq}`, String(head))
    }) as typeof fetch
    const controller = new AbortController()
    const video: string[] = [], audio: string[] = []
    const pending = pullAdaptive(expiringSource, {
      video: sink(video), audio: sink(audio), signal: controller.signal,
      resolve: publicDns, fetchImpl: fetcher, refreshSource,
    }).catch((error: unknown) => error)
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    expect(refreshSource).toHaveBeenCalledOnce()
    expect(seenTokens.some(entry => entry.startsWith('NEW_VIDEO:'))).toBe(true)
    expect(seenTokens.some(entry => entry.startsWith('NEW_AUDIO:'))).toBe(true)
    controller.abort()
    await pending
  })
})
