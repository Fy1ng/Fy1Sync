import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HuyaSliceClient, type HuyaSliceClientDeps } from './huyaSliceClient'
import { SafeFetchStreamError, type SafeFetchStreamOptions, type SafeFetchStreamResult, safeFetchStream } from '../safeFetchStream'
import type { HuyaChatSignal } from '../platforms/huyaChatSignal'
import type { HuyaDanmakuRoom } from '../platforms/huyaDanmaku'
import type { DanmakuClientEvents } from './types'

const metadata = { room: '660002', presenterUid: 12345n, topSid: 456n, subSid: 789n }
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/huya-slice-real.json', import.meta.url), 'utf8')) as {
  samples: Array<{ name: string; hex: string }>
}
const bytes = (name: string) => Buffer.from(fixtures.samples.find(value => value.name === name)!.hex, 'hex')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function signature(index = 0, remainingMs = 300_000): HuyaChatSignal {
  return { url: `https://chat-placeholder.huya.com/chat?wsSecret=SIGNATURE_PLACEHOLDER_${index}`,
    host: 'chat-placeholder.huya.com', ttlSeconds: 300, issuedAt: Date.now(),
    expiresAt: Date.now() + remainingMs, wsTime: 'TIME_PLACEHOLDER' }
}

const clients = new Set<HuyaSliceClient>()
function setup(deps: HuyaSliceClientDeps = {}, ignoreStreamAbort = false) {
  const attempts: Array<{ url: string; options: SafeFetchStreamOptions;
    done: ReturnType<typeof deferred<SafeFetchStreamResult>>;
    open: () => void; chunk: (data: Uint8Array) => Promise<void>;
    end: () => void; fail: (error: unknown) => void }> = []
  const events = { onMessage: vi.fn(), onObservedMessage: vi.fn(), onState: vi.fn(), onSignal: vi.fn() } satisfies DanmakuClientEvents
  const resolveRoom = vi.fn(async () => metadata)
  const requestSignal = vi.fn(async (_uid: bigint, _signal: AbortSignal) => signature(requestSignal.mock.calls.length))
  const stream = vi.fn<typeof safeFetchStream>((url, _config, options) => {
    const done = deferred<SafeFetchStreamResult>()
    const abort = () => done.reject(new SafeFetchStreamError('aborted'))
    if (!ignoreStreamAbort) options.signal?.addEventListener('abort', abort, { once: true })
    attempts.push({ url, options, done, open: () => options.onOpen?.(),
      chunk: async data => {
        try { await options.onChunk(data) } catch (error) { done.reject(error) }
      },
      end: () => done.resolve({ bytesRead: 0, chunksRead: 0 }), fail: error => done.reject(error) })
    return done.promise.finally(() => options.signal?.removeEventListener('abort', abort))
  })
  const client = new HuyaSliceClient(metadata.room, events, { resolveRoom, requestSignal, stream, ...deps })
  clients.add(client)
  return { client, events, resolveRoom, requestSignal, stream, attempts }
}
async function start(context: ReturnType<typeof setup>) {
  context.client.connect()
  await vi.advanceTimersByTimeAsync(0)
  const attempt = context.attempts.at(-1)!
  attempt?.open()
  return attempt
}
async function settle() { await vi.advanceTimersByTimeAsync(0) }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
afterEach(async () => {
  for (const client of clients) client.close()
  clients.clear()
  await settle()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('Huya HTTP chat receive-only lifecycle', () => {
  it('incrementally decodes anonymized chats and gifts and waits for valid framing before connecting', async () => {
    const context = setup()
    const attempt = await start(context)
    expect(context.resolveRoom).toHaveBeenCalledWith(metadata.room)
    expect(context.requestSignal).toHaveBeenCalledWith(metadata.presenterUid, attempt.options.signal)
    expect(context.client.state).toBe('connecting')
    const chat = bytes('singleChat')
    for (let offset = 0; offset < chat.length - 1; offset++) await attempt.chunk(chat.subarray(offset, offset + 1))
    expect(context.events.onMessage).not.toHaveBeenCalled()
    expect(context.client.state).toBe('connecting')
    await attempt.chunk(chat.subarray(chat.length - 1))
    await attempt.chunk(bytes('singleGift'))
    expect(context.client.state).toBe('connected')
    expect(context.events.onMessage.mock.calls.map(([message]) => ({ platform: message.platform, room: message.room,
      username: message.username, system: message.system }))).toEqual([
      { platform: 'huya', room: metadata.room, username: 'viewer-placeholder', system: false },
      { platform: 'huya', room: metadata.room, username: 'viewer-placeholder', system: true },
    ])
    expect(context.events.onObservedMessage.mock.calls).toEqual(context.events.onMessage.mock.calls)
    expect(context.client.diagnostics).toMatchObject({ chats: 1, gifts: 1, connections: 1, signatureRequests: 1,
      parser: { packets: 2, bufferedBytes: 0, sequenceGaps: 0, fragmentFailures: 0 } })
    expect(context.stream.mock.calls[0]![1]).toEqual({ enabled: true, hosts: ['*.huya.com'], allowNonStandardPorts: false,
      allowNonLoopbackTargets: false, maxRedirects: 0, requestTimeoutMs: 15_000 })
    expect(attempt.options).toMatchObject({ connectTimeoutMs: 15_000, readTimeoutMs: 30_000,
      idleTimeoutMs: 60_000, maxBufferedBytes: 262_144 })
  })

  it.each([
    { name: 'EOF', error: null, failure: 'ended', counter: undefined },
    { name: 'HTTP error', error: new SafeFetchStreamError('http-status', 503), failure: 'http', counter: 'httpErrors' },
    { name: 'read timeout', error: new SafeFetchStreamError('read-timeout'), failure: 'timeout', counter: 'timeouts' },
    { name: 'idle timeout', error: new SafeFetchStreamError('idle-timeout'), failure: 'timeout', counter: 'timeouts' },
    { name: 'connect timeout', error: new SafeFetchStreamError('connect-timeout'), failure: 'timeout', counter: 'timeouts' },
    { name: 'read error', error: new SafeFetchStreamError('read-failed'), failure: 'stream', counter: undefined },
  ])('fetches a fresh signature after $name and never reuses the previous URL', async ({ error, failure, counter }) => {
    const context = setup()
    const first = await start(context)
    await first.chunk(bytes('singleChat'))
    if (error) first.fail(error)
    else first.end()
    await settle()
    expect(first.options.signal?.aborted).toBe(true)
    expect(context.client.state).toBe('reconnecting')
    expect(context.client.diagnostics).toMatchObject({ lastFailure: failure, failures: 1, reconnects: 1,
      ...(counter ? { [counter]: 1 } : {}) })
    await vi.advanceTimersByTimeAsync(999)
    expect(context.requestSignal).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(context.requestSignal).toHaveBeenCalledTimes(2)
    expect(context.attempts).toHaveLength(2)
    expect(context.attempts[1]!.url).not.toBe(first.url)
    expect(context.client.diagnostics).toMatchObject({ signatureRequests: 2, resigns: 1 })
  })

  it('caps exponential reconnect delays at 30 seconds', async () => {
    const context = setup()
    let attempt = await start(context)
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      attempt.fail(new SafeFetchStreamError('http-status', 502))
      await settle()
      const count = context.attempts.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(context.attempts).toHaveLength(count)
      await vi.advanceTimersByTimeAsync(1)
      expect(context.attempts).toHaveLength(count + 1)
      attempt = context.attempts.at(-1)!
      attempt.open()
    }
    expect(new Set(context.attempts.map(value => value.url)).size).toBe(8)
    expect(context.client.diagnostics).toMatchObject({ signatureRequests: 8, resigns: 7, httpErrors: 7 })
  })

  it.each([{ age: 29_999, delay: 2_000 }, { age: 30_000, delay: 1_000 }])(
    'resets reconnect backoff only after valid packets at a stable age, age=$age', async ({ age, delay }) => {
      const context = setup()
      const first = await start(context)
      first.end()
      await settle()
      await vi.advanceTimersByTimeAsync(1_000)
      const second = context.attempts.at(-1)!
      second.open()
      await vi.advanceTimersByTimeAsync(age)
      await second.chunk(bytes('singleChat'))
      second.end()
      await settle()
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(context.attempts).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(context.attempts).toHaveLength(3)
    })

  it('does not reset backoff merely because a long-lived stream supplied an incomplete packet', async () => {
    const context = setup()
    const first = await start(context)
    first.end()
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    const second = context.attempts[1]!
    second.open()
    await vi.advanceTimersByTimeAsync(30_000)
    await second.chunk(bytes('singleChat').subarray(0, 20))
    expect(context.client.state).toBe('connecting')
    second.end()
    await settle()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(context.attempts).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(context.attempts).toHaveLength(3)
  })

  it.each([0, -1, 5_000, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects expired, near-expiry and nonfinite signatures before opening a stream, remaining=%s', async remaining => {
      const context = setup({ requestSignal: async () => signature(1, remaining) })
      await start(context)
      expect(context.stream).not.toHaveBeenCalled()
      expect(context.client.state).toBe('reconnecting')
      expect(context.client.diagnostics).toMatchObject({ staleSignatures: 1, lastFailure: 'stale-signature' })
    })

  it('keeps a healthy established stream past its 300 second opening TTL', async () => {
    const context = setup()
    const attempt = await start(context)
    for (let index = 0; index < 7; index++) {
      await attempt.chunk(bytes('singleChat'))
      await vi.advanceTimersByTimeAsync(50_000)
    }
    await attempt.chunk(bytes('singleChat'))
    expect(context.requestSignal).toHaveBeenCalledOnce()
    expect(context.attempts).toHaveLength(1)
    expect(attempt.options.signal?.aborted).toBe(false)
    expect(context.client.state).toBe('connected')
    expect(context.client.diagnostics).toMatchObject({ signatureTtlSeconds: 300, connectionAgeSeconds: 350,
      connectedBeyondTtl: true, reconnects: 0, resigns: 0 })
    attempt.end()
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(context.requestSignal).toHaveBeenCalledTimes(2)
    expect(context.attempts[1]!.url).not.toBe(attempt.url)
  })

  it('clears partial framing and sequence state between attempts while retaining lifetime counters', async () => {
    const context = setup()
    const first = await start(context)
    await first.chunk(bytes('singleChat'))
    await first.chunk(bytes('singleGift').subarray(0, 29))
    expect(context.client.diagnostics.parser.bufferedBytes).toBeGreaterThan(0)
    first.end()
    await settle()
    expect(context.client.diagnostics.parser.bufferedBytes).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await context.attempts[1]!.chunk(bytes('singleChat'))
    expect(context.events.onMessage).toHaveBeenCalledTimes(2)
    expect(context.client.diagnostics).toMatchObject({ chats: 2, parser: { packets: 2, bufferedBytes: 0,
      sequenceDuplicates: 0, sequenceGaps: 0, malformedPackets: 0 } })
  })

  it('discards unfinished fragments on reconnect and accepts the complete fixture on the new stream', async () => {
    const context = setup()
    const first = await start(context)
    const fragmented = bytes('fragmented')
    await first.chunk(fragmented.subarray(0, fragmented.readUInt16LE(8)))
    expect(context.client.diagnostics.parser.pendingFragments).toBe(1)
    first.end()
    await settle()
    expect(context.client.diagnostics.parser).toMatchObject({ pendingFragments: 0, fragmentFailures: 1, bufferedBytes: 0 })
    await vi.advanceTimersByTimeAsync(1_000)
    await context.attempts[1]!.chunk(fragmented)
    expect(context.events.onMessage).not.toHaveBeenCalled()
    expect(context.client.diagnostics).toMatchObject({ unknownUris: 1, unknownUriCounts: { '6210': 1 } })
    expect(context.client.diagnostics.parser).toMatchObject({ pendingFragments: 0, fragmentMessages: 1,
      fragmentFailures: 1, sequenceGaps: 0, sequenceDuplicates: 0 })
  })

  it.each(['metadata', 'signature'] as const)('bounds a nonsettling %s operation and ignores its late result', async stage => {
    const pending = deferred<HuyaDanmakuRoom & HuyaChatSignal>()
    const context = setup(stage === 'metadata' ? { resolveRoom: () => pending.promise } : { requestSignal: () => pending.promise })
    context.client.connect()
    await settle()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(context.client.state).toBe('connecting')
    await vi.advanceTimersByTimeAsync(1)
    expect(context.client.state).toBe('reconnecting')
    expect(context.client.diagnostics).toMatchObject({ lastFailure: 'timeout', timeouts: 1 })
    pending.resolve({ ...metadata, ...signature() })
    await settle()
    expect(context.stream).not.toHaveBeenCalled()
    context.client.close()
    await settle()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['metadata', 'signature'] as const)('does not revive after close while %s is pending', async stage => {
    const pending = deferred<HuyaDanmakuRoom & HuyaChatSignal>()
    const context = setup(stage === 'metadata' ? { resolveRoom: () => pending.promise } : { requestSignal: () => pending.promise })
    context.client.connect()
    await settle()
    context.client.close()
    pending.resolve({ ...metadata, ...signature() })
    await settle()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(context.client.state).toBe('closed')
    expect(context.stream).not.toHaveBeenCalled()
    expect(context.client.diagnostics.reconnects).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('isolates callbacks and completion from a closed stream after a new connect', async () => {
    const context = setup({}, true)
    const old = await start(context)
    context.client.close()
    const current = await start(context)
    const chat = bytes('singleChat')
    await current.chunk(chat.subarray(0, 20))
    old.open()
    await old.chunk(bytes('singleGift'))
    old.end()
    await settle()
    expect(context.client.diagnostics.connections).toBe(2)
    expect(current.options.signal?.aborted).toBe(false)
    expect(context.client.diagnostics.parser.bufferedBytes).toBe(20)
    await current.chunk(chat.subarray(20))
    expect(context.events.onMessage).toHaveBeenCalledOnce()
    expect(context.events.onMessage.mock.calls[0]![0].system).toBe(false)
    expect(context.client.state).toBe('connected')
    expect(context.client.diagnostics).toMatchObject({ failures: 0, gifts: 0, chats: 1 })
  })

  it('does not let an old metadata completion cancel the current signature deadline', async () => {
    const oldMetadata = deferred<HuyaDanmakuRoom>()
    const newSignature = deferred<HuyaChatSignal>()
    const resolveRoom = vi.fn().mockImplementationOnce(() => oldMetadata.promise).mockResolvedValue(metadata)
    const requestSignal = vi.fn(() => newSignature.promise)
    const context = setup({ resolveRoom, requestSignal })
    context.client.connect()
    await settle()
    context.client.close()
    context.client.connect()
    await settle()
    oldMetadata.resolve(metadata)
    await settle()
    expect(requestSignal).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(context.client.state).toBe('reconnecting')
    expect(context.client.diagnostics).toMatchObject({ timeouts: 1, failures: 1 })
    newSignature.resolve(signature())
    await settle()
    expect(context.stream).not.toHaveBeenCalled()
  })

  it('bounds its total parser buffer and reconnects after an oversized consumer chunk', async () => {
    const context = setup()
    const attempt = await start(context)
    await attempt.chunk(Buffer.alloc(1_048_577))
    await settle()
    expect(context.client.state).toBe('reconnecting')
    expect(context.client.diagnostics).toMatchObject({ bytes: 0, chunks: 0, failures: 1,
      parser: { bufferedBytes: 0 }, lastFailure: 'stream' })
  })

  it('makes connect idempotent and clears pending retry and stage timers on close', async () => {
    const context = setup()
    const first = await start(context)
    context.client.connect()
    await settle()
    expect(context.requestSignal).toHaveBeenCalledOnce()
    first.end()
    await settle()
    expect(vi.getTimerCount()).toBe(1)
    context.client.close()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(context.attempts).toHaveLength(1)
    expect(context.client.state).toBe('closed')
  })

  it('aborts an active read on close without scheduling another signature request', async () => {
    const context = setup()
    const attempt = await start(context)
    await attempt.chunk(bytes('singleChat'))
    context.client.close()
    await settle()
    expect(attempt.options.signal?.aborted).toBe(true)
    expect(context.client.state).toBe('closed')
    expect(context.client.diagnostics).toMatchObject({ reconnects: 0, failures: 0 })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(context.requestSignal).toHaveBeenCalledOnce()
  })

  it('stops delivery when the observer closes the client', async () => {
    const context = setup()
    context.events.onObservedMessage.mockImplementationOnce(() => context.client.close())
    const attempt = await start(context)
    await attempt.chunk(bytes('merged'))
    await settle()
    expect(context.events.onObservedMessage).toHaveBeenCalledOnce()
    expect(context.events.onMessage).not.toHaveBeenCalled()
    expect(context.client.state).toBe('closed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not deliver old merged records when the observer closes and reconnects synchronously', async () => {
    const context = setup()
    context.events.onObservedMessage.mockImplementationOnce(() => {
      context.client.close()
      context.client.connect()
    })
    const attempt = await start(context)
    await attempt.chunk(bytes('merged'))
    await settle()
    expect(context.events.onObservedMessage).toHaveBeenCalledOnce()
    expect(context.events.onMessage).not.toHaveBeenCalled()
    expect(context.attempts).toHaveLength(2)
    await context.attempts[1]!.chunk(bytes('singleChat'))
    expect(context.events.onObservedMessage).toHaveBeenCalledTimes(2)
    expect(context.events.onMessage).toHaveBeenCalledOnce()
  })

  it.each(['metadata', 'signature', 'stream'] as const)('keeps signed URLs and upstream %s error text out of diagnostics and states', async stage => {
    const privateError = new Error('https://private.huya.com/?wsSecret=RAW_SIGNATURE Cookie=RAW_COOKIE private-nickname:private-body')
    const context = setup(stage === 'metadata' ? { resolveRoom: async () => { throw privateError } }
      : stage === 'signature' ? { requestSignal: async () => { throw privateError } } : {})
    const attempt = await start(context)
    if (stage === 'stream') { attempt.fail(privateError); await settle() }
    expect(context.client.state).toBe('reconnecting')
    expect(JSON.stringify({ diagnostics: context.client.diagnostics, states: context.events.onState.mock.calls }))
      .not.toMatch(/https?:|wsSecret|wsTime|RAW_SIGNATURE|RAW_COOKIE|private-nickname|private-body|SIGNATURE_PLACEHOLDER|TIME_PLACEHOLDER/)
  })
})
