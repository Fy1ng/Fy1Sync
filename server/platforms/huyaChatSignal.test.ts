import { afterEach, describe, expect, it, vi } from 'vitest'
import fixture from './fixtures/huya-chat-signal.json'
import { safeFetch } from '../safeFetch'
import { HuyaTarsWriter as Writer } from './huyaWup'
import { decodeHuyaChatSignalResponse, encodeHuyaChatSignalRequest, requestHuyaChatSignal } from './huyaChatSignal'

const uid = BigInt(fixture.presenterUid)
const rawResponse = () => Buffer.from(fixture.response, 'hex')
const auth = `wsSecret=${fixture.wsSecret}&wsTime=${fixture.wsTime}`
const expectedUrl = `https://${fixture.host}/huyalive/chat-${uid}_48_0_66.slice?${auth}&baseIndex=0&quickTime=2000`
type WriteField = (writer: Writer) => void

function response(options: { fields?: Map<number, WriteField>; append?: WriteField; status?: number; duplicateKey?: boolean;
  method?: string; servant?: string; version?: number; outerAppend?: WriteField } = {}): Uint8Array {
  const fields = new Map<number, WriteField>([
    [0, writer => writer.int64(0, uid)], [1, writer => writer.string(1, `chat-${uid}`)],
    [2, writer => writer.int(2, 2)], [3, writer => writer.string(3, auth)], [4, writer => writer.int(4, 300)],
    [5, writer => writer.string(5, `${fixture.host}/huyalive`)], [6, writer => writer.string(6, '48')], [7, writer => writer.string(7, '0')],
    [8, writer => { writer.head(8, 8); writer.int(0, 1); writer.int(0, 2); writer.int(1, 13) }], [9, writer => writer.int(9, 13)],
  ])
  for (const [tag, field] of options.fields ?? []) fields.set(tag, field)
  const rsp = new Writer()
  rsp.head(0, 10)
  for (const field of fields.values()) field(rsp)
  options.append?.(rsp)
  rsp.head(0, 11)
  const status = new Writer()
  status.int(0, options.status ?? 0)
  const map = new Writer()
  map.head(0, 8)
  map.int(0, options.duplicateKey ? 3 : 2)
  map.string(0, '')
  map.bytes(1, status.finish())
  for (let i = 0; i < (options.duplicateKey ? 2 : 1); i++) { map.string(0, 'tRsp'); map.bytes(1, rsp.finish()) }
  const packet = new Writer()
  packet.int(1, options.version ?? 3)
  packet.int(2, 0)
  packet.int(3, 0)
  packet.int(4, 1)
  packet.string(5, options.servant ?? 'mediaui')
  packet.string(6, options.method ?? 'getP2PStreamInfo')
  packet.bytes(7, map.finish())
  packet.int(8, 0)
  for (const tag of [9, 10]) { packet.head(tag, 8); packet.int(0, 0) }
  options.outerAppend?.(packet)
  const body = packet.finish()
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length + 4)
  return Buffer.concat([length, body])
}

const replace = (tag: number, field: WriteField) => response({ fields: new Map([[tag, field]]) })
const decode = (bytes: Uint8Array) => decodeHuyaChatSignalResponse(bytes, uid, fixture.now)
const successfulFetch = (): typeof safeFetch => vi.fn(async () => ({ response: new Response(rawResponse()), finalUrl: new URL('https://wup.huya.com') }))

afterEach(() => vi.useRealTimers())

describe('anonymous Huya HTTP chat signal', () => {
  it('matches the reduced browser request byte for byte with synthetic UID', () => {
    expect(Buffer.from(encodeHuyaChatSignalRequest(uid)).toString('hex')).toBe(fixture.request)
  })

  it('decodes the independently captured, redacted response and issue-time TTL', () => {
    expect(decode(rawResponse())).toEqual({ url: expectedUrl, host: fixture.host, ttlSeconds: 300,
      issuedAt: fixture.now, expiresAt: fixture.now + 300_000, wsTime: fixture.wsTime })
    expect(decode(response())).toEqual(decode(rawResponse()))
  })

  it.each([0n, -1n, 0x8000_0000_0000_0000n, '1024', 1024])('rejects invalid presenter UID %s', input => {
    expect(() => encodeHuyaChatSignalRequest(input as bigint)).toThrow('无法读取虎牙聊天流签名.')
    expect(decodeHuyaChatSignalResponse(rawResponse(), input as bigint, fixture.now)).toBeNull()
  })

  it('preserves maximum signed 64-bit UID without precision loss', () => {
    const max = 0x7fff_ffff_ffff_ffffn
    expect(() => encodeHuyaChatSignalRequest(max)).not.toThrow()
    const bytes = response({ fields: new Map([[0, writer => writer.int64(0, max)], [1, writer => writer.string(1, `chat-${max}`)]]) })
    expect(decodeHuyaChatSignalResponse(bytes, max, fixture.now)?.url).toContain(`chat-${max}_48_0_66.slice`)
  })

  it('rejects every packet truncation, false length and extra bytes', () => {
    const raw = rawResponse()
    for (let end = 0; end < raw.length; end++) expect(decode(raw.subarray(0, end))).toBeNull()
    const falseLength = rawResponse()
    falseLength.writeUInt32BE(0xffff_ffff)
    expect(decode(falseLength)).toBeNull()
    expect(decode(Buffer.concat([rawResponse(), Buffer.from([0])]))).toBeNull()
    expect(decode(new Uint8Array(65_537))).toBeNull()
  })

  it('requires correct WUP service, method, version, success and unique fields', () => {
    for (const options of [{ version: 2 }, { servant: 'liveui' }, { method: 'other' }, { status: 1 }, { duplicateKey: true },
      { outerAppend: (writer: Writer) => writer.int(1, 3) }, { append: (writer: Writer) => writer.int(4, 300) }]) {
      expect(decode(response(options))).toBeNull()
    }
  })

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])('rejects an unexpected TARS field type at tag %i', tag => {
    expect(decode(replace(tag, writer => { writer.head(tag, 9); writer.int(0, 0) }))).toBeNull()
  })

  it('binds response UID and group to the requested anonymous room', () => {
    expect(decode(replace(0, writer => writer.int64(0, uid + 1n)))).toBeNull()
    expect(decode(replace(1, writer => writer.string(1, 'chat-1025')))).toBeNull()
    expect(decode(replace(2, writer => writer.int(2, 3)))).toBeNull()
  })

  it.each(['huya.com/huyalive', 'evilhuya.com/huyalive', 'al.huya.com.evil.test/huyalive', '127.0.0.1/huyalive',
    'al.huya.com:443/huyalive', 'https://al.huya.com/huyalive', 'user@al.huya.com/huyalive', 'al.huya.com./huyalive',
    'al.huya.com/huyalive?secret=1', 'al.huya.com/huyalive/../admin', 'al.huya.com/%68uyalive', 'al.huya.com\\huyalive',
    'al.huya.com/huyalive\n', `${'a'.repeat(64)}.huya.com/huyalive`, `${'a.'.repeat(125)}huya.com/huyalive`])('rejects unsafe host/path %s', hostPath => {
    expect(decode(replace(5, writer => writer.string(5, hostPath)))).toBeNull()
  })

  it.each(['-1', '+1', '01', '1.5', '2147483648', '9'.repeat(100), '48_0', '48/../../other', ''])('rejects unsafe URL channel components %s', component => {
    for (const tag of [6, 7]) expect(decode(replace(tag, writer => writer.string(tag, component)))).toBeNull()
  })

  it('rejects TTL bounds, stale/future timestamps and malformed auth', () => {
    for (const ttl of [0, -1, 3601]) expect(decode(replace(4, writer => writer.int(4, ttl)))).toBeNull()
    for (const token of ['', `${auth}&extra=1`, auth.replace('wsSecret=', 'secret='), auth.replace('wsTime=', 'wsTime=0x'),
      auth.replace(fixture.wsSecret, 'z'.repeat(32)), auth.replace(fixture.wsSecret, '0'.repeat(33)), `${auth}\r\nCookie:x`, 'x'.repeat(129)]) {
      expect(decode(replace(3, writer => writer.string(3, token)))).toBeNull()
    }
    expect(decodeHuyaChatSignalResponse(rawResponse(), uid, fixture.now + 300_000)).toBeNull()
    expect(decodeHuyaChatSignalResponse(rawResponse(), uid, fixture.now - 60_001)).toBeNull()
    expect(decodeHuyaChatSignalResponse(rawResponse(), uid, Number.NaN)).toBeNull()
  })

  it('accepts bounded unknown fields but rejects malformed dispatch maps', () => {
    expect(decode(response({ append: writer => writer.string(20, 'future-field') }))).not.toBeNull()
    expect(decode(replace(8, writer => { writer.head(8, 8); writer.int(0, 17) }))).toBeNull()
    expect(decode(replace(8, writer => { writer.head(8, 8); writer.int(0, 1); writer.int(0, 2); writer.string(1, '13') }))).toBeNull()
    expect(decode(replace(8, writer => { writer.head(8, 8); writer.int(0, 2); for (let i = 0; i < 2; i++) { writer.int(0, 2); writer.int(1, 13) } }))).toBeNull()
  })

  it('POSTs only an anonymous request through the restrictive safeFetch policy', async () => {
    const fetch = successfulFetch()
    const signal = new AbortController().signal
    await expect(requestHuyaChatSignal(uid, signal, { safeFetchImpl: fetch, now: () => fixture.now })).resolves.toMatchObject({ url: expectedUrl })
    const [url, config, options] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe('https://wup.huya.com')
    expect(config).toEqual({ enabled: true, hosts: ['wup.huya.com'], allowNonStandardPorts: false,
      allowNonLoopbackTargets: false, maxRedirects: 0, requestTimeoutMs: 15_000 })
    expect(options?.method).toBe('POST')
    expect(options?.headers).toEqual({ 'Content-Type': 'application/octet-stream' })
    expect(Buffer.from(options!.body as Uint8Array).toString('hex')).toBe(fixture.request)
  })

  it('enforces private DNS protection on the real safeFetch path', async () => {
    const network = vi.fn()
    const guarded: typeof safeFetch = (url, config, options) => safeFetch(url, config, {
      ...options, resolve: async () => ['127.0.0.1'], fetchImpl: network,
    })
    await expect(requestHuyaChatSignal(uid, new AbortController().signal, { safeFetchImpl: guarded })).rejects.toThrow('无法读取虎牙聊天流签名.')
    expect(network).not.toHaveBeenCalled()
  })

  it('rejects HTTP errors, redirected endpoints and invalid WUP without upstream details', async () => {
    for (const result of [{ response: new Response('private upstream failure', { status: 500 }), finalUrl: new URL('https://wup.huya.com') },
      { response: new Response(rawResponse()), finalUrl: new URL('https://other.huya.com') },
      { response: new Response('invalid'), finalUrl: new URL('https://wup.huya.com') }]) {
      await expect(requestHuyaChatSignal(uid, new AbortController().signal, { safeFetchImpl: async () => result, now: () => fixture.now })).rejects.toThrow('无法读取虎牙聊天流签名.')
    }
    await expect(requestHuyaChatSignal(uid, new AbortController().signal, { safeFetchImpl: async () => { throw new Error(`${expectedUrl}; Cookie=secret`) } })).rejects.toThrow(/^无法读取虎牙聊天流签名\.$/)
  })

  it.each(['65537', '9000000000', '-1', 'wat'])('rejects oversized or invalid advertised length %s and cancels the body', async advertised => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetch: typeof safeFetch = async () => ({ response: new Response(body, { headers: { 'content-length': advertised } }), finalUrl: new URL('https://wup.huya.com') })
    await expect(requestHuyaChatSignal(uid, new AbortController().signal, { safeFetchImpl: fetch })).rejects.toThrow('无法读取虎牙聊天流签名.')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects actual response bytes beyond 64 KiB and excessive empty chunks', async () => {
    for (const oversized of [true, false]) {
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(oversized ? 65_537 : 0)) }, cancel })
      const fetch: typeof safeFetch = async () => ({ response: new Response(body), finalUrl: new URL('https://wup.huya.com') })
      await expect(requestHuyaChatSignal(uid, new AbortController().signal, { safeFetchImpl: fetch })).rejects.toThrow('无法读取虎牙聊天流签名.')
      expect(cancel).toHaveBeenCalled()
    }
  })

  it('times out pending headers even when the injected transport ignores its signal', async () => {
    vi.useFakeTimers()
    const fetch: typeof safeFetch = async () => new Promise(() => {})
    const request = requestHuyaChatSignal(uid, new AbortController().signal, { safeFetchImpl: fetch, timeoutMs: 50 })
    const assertion = expect(request).rejects.toMatchObject({ name: 'AbortError', message: '虎牙聊天流签名请求已中止.' })
    await vi.advanceTimersByTimeAsync(50)
    await assertion
  })

  it('aborts a stalled body and prevents requests for already aborted callers', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetch: typeof safeFetch = vi.fn(async () => ({ response: new Response(body), finalUrl: new URL('https://wup.huya.com') }))
    const controller = new AbortController()
    const request = requestHuyaChatSignal(uid, controller.signal, { safeFetchImpl: fetch })
    const assertion = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    controller.abort(new Error('private abort reason'))
    await assertion
    expect(cancel).toHaveBeenCalledOnce()
    const never = successfulFetch()
    await expect(requestHuyaChatSignal(uid, controller.signal, { safeFetchImpl: never })).rejects.toMatchObject({ name: 'AbortError' })
    expect(never).not.toHaveBeenCalled()
  })
})
