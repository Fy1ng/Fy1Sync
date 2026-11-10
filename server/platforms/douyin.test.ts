import { describe, expect, it, vi } from 'vitest'
import { StreamFailureError } from '../networkFailure'
import { resolveDouyin } from './douyin'
import { parseDouyinPage, parseDouyinWebResponse } from './douyinPage'
import { detectPlatform, resolveStream } from './index'
import { syntheticDouyinPage, syntheticDouyinReflow, syntheticDouyinRoom } from './fixtures/douyinFixture'
import type { ResolverDeps } from './types'

function deps(overrides: Partial<ResolverDeps> = {}): ResolverDeps {
  return { fetchText: vi.fn(async () => syntheticDouyinPage()), fetchJson: vi.fn(async () => { throw new Error('Unexpected API') }),
    proxify: url => url, ...overrides }
}

describe('Douyin page data', () => {
  it('reads room identity and status from RSC without converting 64-bit ids to numbers', () => {
    expect(parseDouyinPage(syntheticDouyinPage(), '100')).toMatchObject({ webRoom: '100', roomId: '9000000000000000001', status: 2 })
    expect(parseDouyinPage(syntheticDouyinPage(), '200')).toBeNull()
    expect(parseDouyinWebResponse({ status_code: 0, data: { data: [syntheticDouyinRoom()] } }, '100'))
      .toMatchObject({ roomId: '9000000000000000001' })
  })

  it('resolves text and object references across chunks using UTF-8 byte lengths', () => {
    // The title is six UTF-8 bytes, followed immediately by another RSC record.
    const flight = '1:T6,原画2:{"web_rid":"100","roomId":"9000000000000000001","room":{"status":2,"title":"$1"}}\n'
      + '0:["$","div",null,{"state":{"roomStore":{"roomInfo":"$2"}}}]\n'
    const chunks = [flight.slice(0, 9), flight.slice(9, 40), flight.slice(40)]
    const html = chunks.map(chunk => `<script>self.__pace_f.push(${JSON.stringify([1, chunk])});</script>`).join('')
    expect(parseDouyinPage(html, '100')).toMatchObject({ status: 2, title: '原画', roomId: '9000000000000000001' })
  })

  it('does not evaluate JavaScript or follow cyclic references', () => {
    const script = '<script>self.__pace_f.push((globalThis.__douyinUnsafe=true,[1,"0:{}\\n"]))</script>'
    expect(parseDouyinPage(script)).toBeNull()
    expect(Reflect.get(globalThis, '__douyinUnsafe')).toBeUndefined()
    const cycle = `<script>self.__pace_f.push(${JSON.stringify([1, '0:{"state":"$1"}\n1:"$0"\n'])})</script>`
    expect(parseDouyinPage(cycle)).toBeNull()
    expect(parseDouyinPage(`<script>self.__pace_f.push(${JSON.stringify([1, '1:Tffffffff,x'])})</script>`)).toBeNull()
  })

  it('supports the camelCase official share page and keeps old-session status', () => {
    expect(parseDouyinPage(syntheticDouyinReflow('100'))).toMatchObject({ webRoom: '100', roomId: '9000000000000000001', status: 4,
      stream: { flv_pull_url: { FULL_HD1: 'https://media.douyincdn.com/expired.flv' } } })
  })

  it('supports a bounded legacy JSON script and rejects oversized pages', () => {
    const value = { state: { roomStore: { roomInfo: { web_rid: '100', room: syntheticDouyinRoom() } } } }
    expect(parseDouyinPage(`<script id="RENDER_DATA" type="application/json">${encodeURIComponent(JSON.stringify(value))}</script>`))
      .toMatchObject({ status: 2, roomId: '9000000000000000001' })
    expect(parseDouyinPage(' '.repeat(2 * 1_048_576 + 1))).toBeNull()
  })
})

describe('Douyin stream resolution', () => {
  it('dispatches supported links and keeps bare platform inference unchanged', async () => {
    expect(detectPlatform('https://live.douyin.com/100')).toBe('douyin')
    expect(detectPlatform('分享 https://v.douyin.com/Fixture/')).toBe('douyin')
    expect(detectPlatform('100')).toBeNull()
    const result = await resolveStream('100', deps(), 'douyin')
    expect(result).toMatchObject({ ok: true, stream: { platform: 'douyin', channel: '100', quality: 'origin', kind: 'progressive',
      sourceRoom: '9000000000000000001', qualities: [{ id: 'origin', height: 1080, fps: 60 }, { id: 'sd', height: 720, fps: 30 }] } })
    if (result.ok) expect(result.stream.danmakuRoom).toBe('douyin:100')
  })

  it('selects a requested advertised quality, and uses its HLS URL when FLV is absent', async () => {
    const room = syntheticDouyinRoom()
    const streams = JSON.parse(room.stream_url.live_core_sdk_data.pull_data.stream_data)
    streams.data.sd.main.flv = ''
    room.stream_url.live_core_sdk_data.pull_data.stream_data = JSON.stringify(streams)
    const result = await resolveDouyin('100', deps({ quality: 'sd', fetchText: async () => syntheticDouyinPage(room) }))
    expect(result).toMatchObject({ ok: true, stream: { kind: 'hls', quality: 'sd', url: expect.stringContaining('fixture-low.m3u8') } })
  })

  it('prefers the explicit H.264 camera stream over the default H.265 stream', async () => {
    const h264 = syntheticDouyinRoom().stream_url
    const room = syntheticDouyinRoom()
    room.stream_url.live_core_sdk_data.pull_data.stream_data = room.stream_url.live_core_sdk_data.pull_data.stream_data.replaceAll('h264', 'h265').replaceAll('fixture-', 'hevc-')
    const result = await resolveDouyin('100', deps({ fetchText: async () => syntheticDouyinPage(room, '100', h264) }))
    expect(result).toMatchObject({ ok: true, stream: { url: expect.stringContaining('fixture-high.flv') } })
  })

  it('rejects an unavailable quality without silently switching to another one', async () => {
    const result = await resolveDouyin('100', deps({ quality: 'missing' }))
    expect(result).toMatchObject({ ok: false, failure: { code: 'unsupported-url' } })
  })

  it('rejects offline rooms even when expired media URLs remain in the page', async () => {
    const room = syntheticDouyinRoom(); room.status = 4
    const d = deps({ fetchText: async () => syntheticDouyinPage(room) })
    expect(await resolveDouyin('100', d)).toMatchObject({ ok: false, failure: { code: 'not-live' } })
    expect(d.fetchJson).not.toHaveBeenCalled()
  })

  it('does not advertise H.265, audio-only, or preview SDK streams', async () => {
    const room = syntheticDouyinRoom()
    const streams = JSON.parse(room.stream_url.live_core_sdk_data.pull_data.stream_data)
    streams.data.ao = streams.data.sd
    streams.data.md = streams.data.sd
    streams.data.tsl = streams.data.sd
    delete streams.data.sd
    streams.data.origin.main.sdk_params = '{"VCodec":"h265"}'
    room.stream_url.live_core_sdk_data.pull_data.stream_data = JSON.stringify(streams)
    const page = syntheticDouyinPage({ ...room, stream_url: { ...room.stream_url,
      flv_pull_url: { FULL_HD1: 'https://media.douyincdn.com/unmarked-hevc.flv' },
    } })
    expect(await resolveDouyin('100', deps({ fetchText: async () => page })))
      .toMatchObject({ ok: false, failure: { code: 'needs-manual-url' } })
  })

  it.each(['http://user:pass@media.douyincdn.com/live.flv', 'file:///live.flv', 'https://media.douyincdn.com/live.flv\r\nCookie:x'])
    ('does not accept unsafe media metadata %s', async url => {
      const room = syntheticDouyinRoom()
      room.stream_url.live_core_sdk_data.pull_data.stream_data = JSON.stringify({ data: { origin: { main: { flv: url } } } })
      expect(await resolveDouyin('100', deps({ fetchText: async () => syntheticDouyinPage(room) })))
        .toMatchObject({ ok: false, failure: { code: 'needs-manual-url' } })
    })

  it('follows a share owner to the current web room instead of playing the expired shared session', async () => {
    const fetchPage = vi.fn<NonNullable<ResolverDeps['fetchPage']>>(async url => url.includes('v.douyin.com')
      ? { text: syntheticDouyinReflow('100'), finalUrl: 'https://webcast.amemv.com/douyin/webcast/reflow/9000000000000000001', setCookie: [] }
      : { text: syntheticDouyinPage(), finalUrl: url, setCookie: [] })
    const result = await resolveDouyin('https://v.douyin.com/Fixture/', deps({ fetchPage }))
    expect(result).toMatchObject({ ok: true, stream: { channel: '100', url: expect.stringContaining('fixture-high.flv') } })
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual(['https://v.douyin.com/Fixture/', 'https://live.douyin.com/100'])
  })

  it('does not treat a long shared room id as a web room without a confirmed owner', async () => {
    const fetchPage = vi.fn<NonNullable<ResolverDeps['fetchPage']>>(async url => ({ text: syntheticDouyinReflow(), finalUrl: url, setCookie: [] }))
    expect(await resolveDouyin('https://webcast.amemv.com/douyin/webcast/reflow/9000000000000000001', deps({ fetchPage })))
      .toMatchObject({ ok: false, failure: { code: 'not-live' } })
    expect(fetchPage).toHaveBeenCalledOnce()
  })

  it('uses a fresh anonymous cookie for an API fallback without exposing it in the stream', async () => {
    const fetchPage = vi.fn<NonNullable<ResolverDeps['fetchPage']>>(async url => ({ text: '', finalUrl: url,
      setCookie: url.includes('ttwid.bytedance.com') ? ['ttwid=ANONYMOUS_FIXTURE; Path=/; Secure'] : [] }))
    const fetchJson = vi.fn(async () => ({ status_code: 0, data: { data: [syntheticDouyinRoom()] } }))
    const result = await resolveDouyin('100', deps({ fetchPage, fetchJson }))
    expect(result).toMatchObject({ ok: true, stream: { quality: 'origin' } })
    expect(fetchPage).toHaveBeenCalledWith('https://ttwid.bytedance.com/ttwid/union/register/', expect.objectContaining({ method: 'POST' }))
    expect(fetchJson).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/live\.douyin\.com\/webcast\/room\/web\/enter\//), expect.objectContaining({ headers: expect.objectContaining({ Cookie: 'ttwid=ANONYMOUS_FIXTURE' }) }))
    expect(JSON.stringify(result)).not.toContain('ANONYMOUS_FIXTURE')
    expect(JSON.stringify(result)).not.toContain('Cookie')
  })

  it('reuses only the page anonymous cookie for the fixed API and does not register another session', async () => {
    const fetchPage = vi.fn<NonNullable<ResolverDeps['fetchPage']>>(async url => ({ text: '', finalUrl: url,
      setCookie: ['unrelated=DO_NOT_USE; Path=/', 'ttwid=ANONYMOUS_FIXTURE; Path=/'] }))
    const fetchJson = vi.fn(async () => ({ status_code: 0, data: { data: [syntheticDouyinRoom()] } }))
    expect((await resolveDouyin('100', deps({ fetchPage, fetchJson }))).ok).toBe(true)
    expect(fetchPage).toHaveBeenCalledOnce()
    expect(JSON.stringify(fetchJson.mock.calls)).not.toContain('DO_NOT_USE')
  })

  it.each(['https://unrelated.invalid/live', 'https://live.douyin.com/200'])('rejects an unexpected final room %s', async finalUrl => {
    expect(await resolveDouyin('100', deps({ fetchPage: async () => ({ text: syntheticDouyinPage(), finalUrl, setCookie: [] }) })))
      .toMatchObject({ ok: false })
  })

  it('reports anonymous access failure without claiming that the room is offline', async () => {
    const fetchPage = async (url: string) => ({ text: '', finalUrl: url, setCookie: [] })
    expect(await resolveDouyin('100', deps({ fetchPage }))).toMatchObject({ ok: false, failure: { code: 'restricted' } })
  })

  it('preserves classified network failures and never reflects raw upstream diagnostics', async () => {
    const error = new StreamFailureError({ stage: 'resolve', code: 'dns-failed', message: 'fixture' })
    await expect(resolveDouyin('100', deps({ fetchText: async () => { throw error } }))).rejects.toBe(error)
    const result = await resolveDouyin('100', deps({ fetchText: async () => { throw new Error('Cookie=SECRET upstream URL') } }))
    expect(result).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
    expect(JSON.stringify(result)).not.toMatch(/SECRET|upstream URL/)
  })

  it('rejects invalid input and quality syntax before any request', async () => {
    const d = deps({ quality: 'bad\r\nheader' })
    expect((await resolveDouyin('100', d)).ok).toBe(false)
    expect((await resolveDouyin('https://live.douyin.com.evil.invalid/100', deps())).ok).toBe(false)
    expect(d.fetchText).not.toHaveBeenCalled()
  })
})
