import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from './config'
import { SafeFetchStreamError, safeFetchStream, type SafeFetchStreamOptions } from './safeFetchStream'

const policy = resolveConfig({}).proxy
const target = 'https://chat.huya.com/chat?wsSecret=synthetic-sensitive'
const publicResolver = async () => ['93.184.216.34']
const defaults = { resolve: publicResolver, onChunk: () => {} }
const makeFetch = (response: Response): typeof fetch => vi.fn(async () => response)
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const capture = <T>(promise: Promise<T>) => promise.catch((error: unknown) => error)

afterEach(() => { vi.useRealTimers() })

describe('safeFetchStream', () => {
  it('consumes chunks with backpressure, counts only nonempty data, and cleans up on completion', async () => {
    const controller = new AbortController()
    let capturedSignal: AbortSignal | undefined
    let consumed = 0
    let pending = 0
    let maxPending = 0
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array([1, 2]))
        stream.enqueue(new Uint8Array())
        stream.enqueue(new Uint8Array([3]))
        stream.close()
      },
    }))
    const onOpen = vi.fn()
    const result = await safeFetchStream(target, policy, {
      ...defaults, signal: controller.signal, onOpen,
      fetchImpl: async (_input, init) => {
        capturedSignal = init!.signal!
        expect(init!.redirect).toBe('manual')
        expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeDefined()
        return response
      },
      onChunk: async chunk => {
        pending++
        maxPending = Math.max(maxPending, pending)
        await Promise.resolve()
        consumed += chunk.byteLength
        pending--
      },
    })
    expect(result).toEqual({ bytesRead: 3, chunksRead: 2 })
    expect(consumed).toBe(3)
    expect(maxPending).toBe(1)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(response.body!.locked).toBe(false)
    expect(capturedSignal!.aborted).toBe(true)
    expect(controller.signal.aborted).toBe(false)
  })

  it('does not apply the connection timeout to a healthy long-lived response', async () => {
    vi.useFakeTimers()
    let next = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await delay(3)
        if (++next <= 6) controller.enqueue(new Uint8Array([next]))
        else controller.close()
      },
    })
    const result = capture(safeFetchStream(target, { ...policy, requestTimeoutMs: 5 }, {
      ...defaults, fetchImpl: makeFetch(new Response(stream)), readTimeoutMs: 20, idleTimeoutMs: 20,
    }))
    await vi.advanceTimersByTimeAsync(25)
    expect(await result).toEqual({ bytesRead: 6, chunksRead: 6 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a connection that never returns headers and aborts its transport', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const result = capture(safeFetchStream(target, policy, {
      ...defaults, connectTimeoutMs: 10,
      fetchImpl: async (_url, init) => { signal = init!.signal!; return new Promise(() => {}) },
    }))
    await vi.advanceTimersByTimeAsync(11)
    expect(await result).toMatchObject({ code: 'connect-timeout' })
    expect(signal!.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('includes DNS validation in the connection deadline', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>()
    const result = capture(safeFetchStream(target, policy, {
      ...defaults, resolve: () => new Promise(() => {}), connectTimeoutMs: 10, fetchImpl,
    }))
    await vi.advanceTimersByTimeAsync(11)
    expect(await result).toMatchObject({ code: 'connect-timeout' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('cancels and releases a hung read at its deadline', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }))
    const result = capture(safeFetchStream(target, policy, {
      ...defaults, fetchImpl: makeFetch(response), readTimeoutMs: 10, idleTimeoutMs: 50,
    }))
    await vi.advanceTimersByTimeAsync(11)
    expect(await result).toMatchObject({ code: 'read-timeout' })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body!.locked).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out idle data even when empty chunks keep reads completing', async () => {
    vi.useFakeTimers()
    let timer: ReturnType<typeof setInterval>
    const cancel = vi.fn(() => clearInterval(timer))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { timer = setInterval(() => controller.enqueue(new Uint8Array()), 3) },
      cancel,
    })
    const onChunk = vi.fn()
    const result = capture(safeFetchStream(target, policy, {
      ...defaults, onChunk, fetchImpl: makeFetch(new Response(stream)), readTimeoutMs: 20, idleTimeoutMs: 10,
    }))
    await vi.advanceTimersByTimeAsync(12)
    expect(await result).toMatchObject({ code: 'idle-timeout' })
    expect(onChunk).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resets idle only when nonempty data arrives', async () => {
    vi.useFakeTimers()
    let streamController: ReadableStreamDefaultController<Uint8Array>
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) { streamController = c } }))
    const onChunk = vi.fn()
    const result = capture(safeFetchStream(target, policy, {
      ...defaults, onChunk, fetchImpl: makeFetch(response), readTimeoutMs: 100, idleTimeoutMs: 10,
    }))
    await vi.advanceTimersByTimeAsync(7)
    streamController!.enqueue(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(7)
    expect(onChunk).toHaveBeenCalledTimes(1)
    expect(response.body!.locked).toBe(true)
    await vi.advanceTimersByTimeAsync(4)
    expect(await result).toMatchObject({ code: 'idle-timeout' })
  })

  it.each([
    new Uint8Array(5),
    new Uint8Array(new ArrayBuffer(5), 0, 1),
  ])('rejects an oversized chunk or backing buffer before delivering bytes %#', async chunk => {
    const cancel = vi.fn()
    const onChunk = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(chunk) }, cancel,
    }))
    await expect(safeFetchStream(target, policy, {
      ...defaults, onChunk, fetchImpl: makeFetch(response), maxBufferedBytes: 4,
    })).rejects.toMatchObject({ code: 'buffer-limit' })
    expect(onChunk).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body!.locked).toBe(false)
  })

  it('accepts the exact buffer limit and never accumulates the total response', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < 100; i++) c.enqueue(new Uint8Array(4)); c.close() },
    })
    expect(await safeFetchStream(target, policy, {
      ...defaults, fetchImpl: makeFetch(new Response(stream)), maxBufferedBytes: 4,
    })).toEqual({ bytesRead: 400, chunksRead: 100 })
  })

  it('handles a pre-aborted caller signal without connecting or exposing its reason', async () => {
    const controller = new AbortController()
    controller.abort(new Error(target))
    const fetchImpl = vi.fn<typeof fetch>()
    const result = await capture(safeFetchStream(target, policy, { ...defaults, signal: controller.signal, fetchImpl }))
    expect(result).toMatchObject({ code: 'aborted' })
    expect(String(result)).not.toContain('synthetic-sensitive')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('aborts a live response, cancels its body and releases its lock', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }))
    let signal: AbortSignal | undefined
    let didOpen!: () => void
    const opened = new Promise<void>(resolve => { didOpen = resolve })
    const result = capture(safeFetchStream(target, policy, {
      ...defaults, signal: controller.signal, onOpen: didOpen,
      fetchImpl: async (_url, init) => { signal = init!.signal!; return response },
    }))
    await opened
    controller.abort(new Error(target))
    expect(await result).toMatchObject({ code: 'aborted' })
    expect(signal!.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body!.locked).toBe(false)
  })

  it('finishes teardown even if source cancellation never resolves', async () => {
    vi.useFakeTimers()
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => {}) }))
    const result = capture(safeFetchStream(target, policy, {
      ...defaults, fetchImpl: makeFetch(response), readTimeoutMs: 10,
    }))
    await vi.advanceTimersByTimeAsync(11)
    expect(await result).toMatchObject({ code: 'read-timeout' })
    expect(response.body!.locked).toBe(false)
  })

  it('cancels HTTP errors without delivering their bodies or upstream text', async () => {
    const cancel = vi.fn()
    const onOpen = vi.fn()
    const onChunk = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503, statusText: 'synthetic-sensitive' })
    const error = await capture(safeFetchStream(target, policy, { ...defaults, onOpen, onChunk, fetchImpl: makeFetch(response) }))
    expect(error).toMatchObject({ code: 'http-status', status: 503 })
    expect(String(error)).not.toContain('synthetic-sensitive')
    expect(onOpen).not.toHaveBeenCalled()
    expect(onChunk).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects a successful response without a body', async () => {
    await expect(safeFetchStream(target, policy, {
      ...defaults, fetchImpl: makeFetch(new Response(null, { status: 204 })),
    })).rejects.toMatchObject({ code: 'empty-body' })
  })

  it.each(['connect', 'read', 'consumer'] as const)('sanitizes %s failures without retaining a cause', async phase => {
    const secretError = new Error(target)
    const error = await capture(safeFetchStream(target, policy, {
      ...defaults,
      fetchImpl: async () => {
        if (phase === 'connect') throw secretError
        return new Response(new ReadableStream<Uint8Array>({
          start(c) { if (phase === 'read') c.error(secretError); else c.enqueue(new Uint8Array([1])) },
        }))
      },
      onChunk() { if (phase === 'consumer') throw secretError },
    }))
    expect(error).toBeInstanceOf(SafeFetchStreamError)
    expect(error).toMatchObject({ code: `${phase}-failed` })
    expect(String(error)).not.toContain('synthetic-sensitive')
    expect(error).not.toHaveProperty('cause')
  })

  it('bounds a hung asynchronous consumer and cancels its transport', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])) }, cancel }))
    const result = capture(safeFetchStream(target, policy, {
      ...defaults, fetchImpl: makeFetch(response), onChunk: () => new Promise(() => {}), idleTimeoutMs: 10,
    }))
    await vi.advanceTimersByTimeAsync(11)
    expect(await result).toMatchObject({ code: 'idle-timeout' })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body!.locked).toBe(false)
  })

  it.each([
    { raw: 'https://outside.invalid/chat', addresses: ['93.184.216.34'], reason: 'host-not-allowed' },
    { raw: target, addresses: ['127.0.0.1'], reason: 'private-address' },
    { raw: target, addresses: ['not-an-ip'], reason: 'dns-failed' },
  ])('retains safeFetch policy rejection: $reason', async ({ raw, addresses, reason }) => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(safeFetchStream(raw, policy, { ...defaults, resolve: async () => addresses, fetchImpl }))
      .rejects.toMatchObject({ code: 'policy-rejected', policyReason: reason })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('revalidates a redirected hostname and refuses a private address before a second request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302, headers: { location: 'https://other.huya.com/chat' },
    }))
    await expect(safeFetchStream(target, policy, {
      ...defaults, fetchImpl, resolve: async host => host === 'chat.huya.com' ? ['93.184.216.34'] : ['10.0.0.1'],
    })).rejects.toMatchObject({ code: 'policy-rejected', policyReason: 'private-address' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    { connectTimeoutMs: 0 }, { readTimeoutMs: NaN }, { idleTimeoutMs: Infinity },
    { idleTimeoutMs: 2_147_483_648 }, { maxBufferedBytes: -1 }, { maxBufferedBytes: 1.5 },
  ])('rejects invalid bounds before connecting %#', async options => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(safeFetchStream(target, policy, { ...defaults, ...options, fetchImpl } as SafeFetchStreamOptions))
      .rejects.toMatchObject({ code: 'invalid-options' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
