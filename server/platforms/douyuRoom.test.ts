import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { createDouyuRoomResolver, DouyuRoomResolver, parseDouyuRoom, parseDouyuRoomPage, validDouyuRoom } from './douyuRoom'

export const roomPage = (rid: unknown, extra: Record<string, unknown> = {}) => '<script id="vike_pageContext" type="application/json">' + JSON.stringify({ pageProps: { room: { roomInfo: { roomInfo: rid === null ? {} : { rid, ...extra } } } } }) + '</script>'
const proxy = resolveConfig({}).proxy

describe('anonymous Douyu source identity', () => {
  it.each(['6657', 'https://www.douyu.com/6657', 'douyu.com/6657?x=1', 'https://www.douyu.com/topic/x?rid=6657'])('normalizes numeric alias or URL %s', async input => {
    const fetchPage = vi.fn(async () => roomPage(6979222, { vipId: 6657 }))
    expect(await new DouyuRoomResolver(fetchPage).resolve(input)).toEqual({ ok: true, identity: { room: '6979222', inputRoom: '6657' } })
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith('6657')
  })
  it.each(['6979222', '1', '999999999999'])('accepts canonical positive ID %s', id => expect(validDouyuRoom(id)).toBe(id))
  it.each(['0', '001', '-1', '1.2', '1e3', '1;fetch(x)', '9'.repeat(13), '', 'https://evil.invalid/1', 'ftp://douyu.com/1', 'https://u:p@douyu.com/1', 'douyu.com:8080/1'])('rejects unsafe input %s', id => expect(parseDouyuRoom(id)).toBeNull())
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '1e3', '6979222.0', {}, [], '0006657', '9'.repeat(13)])('rejects malicious metadata ID %j', rid => {
    expect(parseDouyuRoomPage(roomPage(rid), '6657')).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
  })
  it('rejects noncanonical numeric JSON tokens rather than rounding them into room IDs', () => {
    for (const token of ['1e3', '1000.0', '9007199254740993']) {
      expect(parseDouyuRoomPage(roomPage('TOKEN').replace('\"TOKEN\"', token), '6657')).toMatchObject({ ok: false })
    }
  })
  it('reads an offline room identity and does not treat route or vipId as canonical', () => {
    expect(parseDouyuRoomPage(roomPage(6979222, { vipId: 6657, isLive: 0 }), '6657')).toMatchObject({ ok: true, identity: { room: '6979222' } })
  })
  it('distinguishes explicit missing room, malformed JSON and challenge HTML without disclosing bodies', () => {
    expect(parseDouyuRoomPage(roomPage(null), '6657')).toMatchObject({ ok: false, failure: { code: 'room-not-found' } })
    for (const text of ['<html>challenge secret</html>', '<script id="vike_pageContext" type="application/json">secret</script>', roomPage(1) + roomPage(2), roomPage(1) + ' '.repeat(1_048_576)]) {
      const result = parseDouyuRoomPage(text, '6657')
      expect(result).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
      expect(JSON.stringify(result)).not.toContain('secret')
    }
  })
  it('requires exact id/type attributes and rejects duplicate identity scripts', () => {
    for (const page of [roomPage(6979222).replace(' id=', ' data-id='), roomPage(6979222).replace(' type=', ' data-type='), roomPage(1) + roomPage(2), roomPage(1).replace(' id=', ' id=\"other\" id=')]) {
      expect(parseDouyuRoomPage(page, '6657')).toMatchObject({ ok: false })
    }
    expect(parseDouyuRoomPage(roomPage(1).replace(' id=', ' data-id=') + roomPage(6979222), '6657')).toMatchObject({ ok: true, identity: { room: '6979222' } })
  })
  it('bounds cache, expires aliases, coalesces pending work and retries failures', async () => {
    let now = 0
    const fetchPage = vi.fn(async (room: string) => roomPage(Number(room) + 1))
    const resolver = new DouyuRoomResolver(fetchPage, { now: () => now, ttlMs: 50, capacity: 2 })
    await Promise.all([resolver.resolve('1'), resolver.resolve('1'), resolver.resolve('douyu.com/1')])
    expect(fetchPage).toHaveBeenCalledTimes(1)
    await resolver.resolve('1')
    expect(fetchPage).toHaveBeenCalledTimes(1)
    now = 50
    await resolver.resolve('1')
    await resolver.resolve('2'); await resolver.resolve('3'); await resolver.resolve('1')
    expect(fetchPage).toHaveBeenCalledTimes(5)
    const failed = new DouyuRoomResolver(vi.fn().mockRejectedValueOnce(new Error('secret')).mockResolvedValueOnce(roomPage(1)))
    expect(await failed.resolve('1')).toMatchObject({ ok: false })
    expect(await failed.resolve('1')).toMatchObject({ ok: true })
  })
  it('bounds concurrent distinct pending lookups', async () => {
    let settle!: (value: string) => void
    const resolver = new DouyuRoomResolver(() => new Promise(resolve => { settle = resolve }), { capacity: 1 })
    const first = resolver.resolve('1')
    expect(await resolver.resolve('2')).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
    settle(roomPage(1)); await first
  })
  it('requests only fixed anonymous HTTPS metadata and applies DNS and redirect policy', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(roomPage(6979222)))
    const resolver = createDouyuRoomResolver(proxy, fetchImpl, async () => ['8.8.8.8'])
    expect(await resolver.resolve('https://douyu.com/topic/x?rid=6657')).toMatchObject({ ok: true, identity: { room: '6979222' } })
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe('https://m.douyu.com/6657')
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) })
    expect(JSON.stringify(init?.headers)).not.toMatch(/cookie|authorization/i)
    const privateFetch = vi.fn<typeof fetch>()
    expect(await createDouyuRoomResolver(proxy, privateFetch, async () => ['127.0.0.1']).resolve('1')).toMatchObject({ ok: false })
    expect(privateFetch).not.toHaveBeenCalled()
    const redirect = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid/1' } }))
    expect(await createDouyuRoomResolver(proxy, redirect, async () => ['8.8.8.8']).resolve('1')).toMatchObject({ ok: false })
    expect(redirect).toHaveBeenCalledTimes(1)
  })
  it('cancels an over-limit body during streaming and returns only a recoverable failure', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)) }, cancel })
    const resolver = createDouyuRoomResolver(proxy, async () => new Response(stream), async () => ['8.8.8.8'])
    expect(await resolver.resolve('6657')).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
