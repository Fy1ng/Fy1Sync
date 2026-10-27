import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { buildHuyaAuth, parseHuyaPage, parseHuyaQualities, parseHuyaRoom, resolveHuya, rotateHuyaUid } from './huya'
import { detectPlatform, resolveStream } from './index'
import type { ResolverDeps } from './types'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/huya-${name}.html`, import.meta.url), 'utf8')
// The golden response originates in biliup/biliup (MIT); see huya-README.md and huya-biliup-LICENSE.txt.
const golden = JSON.parse(readFileSync(new URL('./fixtures/huya-biliup-golden.json', import.meta.url), 'utf8')) as { response: string }
const NOW = 1_792_257_600_000
const TOKEN = 'wsTime=6ad3bc50&fm=Zml4dHVyZV9zdHJlYW0%3D&ctype=huya_live&t=100&fs=bgct'
const sampleLine = (patch: Record<string, unknown> = {}) => ({
  sCdnType: 'TX', iWebPriorityRate: 100, sStreamName: 'example-stream', sFlvUrl: 'http://high.flv.huya.com/src',
  sFlvUrlSuffix: 'flv', lPresenterUid: '12345678', sFlvAntiCode: TOKEN, ...patch,
})
const page = (room: Record<string, unknown> = {}, lines: unknown[] = [sampleLine()], qualities: unknown = [{ iBitRate: 0, sDisplayName: '原画' }], live: Record<string, unknown> = {}) =>
  `<script>var TT_ROOM_DATA = ${JSON.stringify({ state: 'ON', profileRoom: 123456, introduction: '示例直播', ...room })};\n`
  + `var player = { stream: ${JSON.stringify({ data: [{ gameLiveInfo: live, gameStreamInfoList: lines }], vMultiStreamInfo: qualities })} };</script>`
const deps = (patch: Partial<ResolverDeps> = {}): ResolverDeps => ({
  fetchJson: vi.fn(), fetchText: vi.fn(async () => fixture('live')), proxify: url => url, now: () => NOW,
  fetchBytes: vi.fn(async () => { throw new Error('Offline WUP fixture') }), ...patch,
})

describe('Huya room input and platform detection', () => {
  it.each([
    ['123456', '123456'], ['  example-room  ', 'example-room'], ['EXAMPLE_room-1', 'EXAMPLE_room-1'],
    ['huya.com/123456', '123456'], ['https://www.huya.com/example-room', 'example-room'],
    ['http://m.huya.com/123456/', '123456'], ['https://HUYA.COM/example-room?share=fixture#player', 'example-room'],
    ['a'.repeat(64), 'a'.repeat(64)],
  ])('parses %s', (input, expected) => { expect(parseHuyaRoom(input)).toBe(expected) })
  it.each([
    '', ' ', 'a'.repeat(65), 'a'.repeat(8193), '房间', 'example room', '123/456', '../123',
    'https://huya.com/', 'https://huya.com/123/456', 'https://huya.com/%31%32%33',
    'https://huya.com.evil.invalid/123', 'https://evil.huya.com/123', 'https://user:secret@huya.com/123',
    'https://huya.com:8443/123', 'ftp://huya.com/123', 'javascript:alert(1)', 'https://m.huya.com/room\u0000name',
    'https://huya.com/exam\nple',
  ])('rejects invalid input %s', input => { expect(parseHuyaRoom(input)).toBeNull() })
  it.each([null, undefined, 123456, {}, ['123456']])('rejects non-string room input %j', input => {
    expect(parseHuyaRoom(input as string)).toBeNull()
  })
  it.each(['huya.com/123456', 'https://www.huya.com/example-room', 'http://m.huya.com/123456'])('detects %s as Huya', input => {
    expect(detectPlatform(input)).toBe('huya')
  })
  it('does not confuse another domain with Huya and supports explicit bare-room dispatch', async () => {
    expect(detectPlatform('https://huya.com.evil.invalid/123456')).not.toBe('huya')
    expect(detectPlatform('123456', 'huya')).toBe('huya')
    expect(await resolveStream('123456', deps(), 'huya')).toMatchObject({ ok: true, stream: { platform: 'huya', channel: '123456' } })
  })
})

describe('Huya bounded page metadata', () => {
  it('reads ON state, canonical numeric identity, escaped JSON and priority-sorted public CDN lines', () => {
    const result = parseHuyaPage(fixture('live'), '123456')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.room).toBe('123456')
    expect(result.lines.map(line => [line.cdn, line.priority, line.base, line.presenter])).toEqual([
      ['TX', 100, 'https://high.flv.huya.com/src', 12345678n],
      ['AL', 10, 'https://low.flv.huya.com/src', 12345678n],
    ])
    expect(result.qualities).toEqual([{ id: '0', label: '原画' }, { id: '8000', label: '蓝光 8M' }, { id: '4000', label: '超清 4M' }])
  })
  it.each([
    ['offline', 'not-live'], ['replay', 'not-live'], ['not-found', 'room-not-found'],
    ['restricted', 'restricted'], ['malformed', 'upstream-error'],
  ])('maps the %s fixture to %s', (name, code) => {
    expect(parseHuyaPage(fixture(name), '123456')).toMatchObject({ ok: false, failure: { code } })
  })
  it.each(['回放🎮示例赛事', '🎮回放示例赛事', '示例赛事🎮重播', '示例赛事重播🎮'])('rejects replay at a Unicode three-character title edge: %s', introduction => {
    expect(parseHuyaPage(page({ introduction }), '123456')).toMatchObject({ ok: false, failure: { code: 'not-live' } })
  })
  it('does not classify a replay word in the middle of a live title as a replay', () => {
    expect(parseHuyaPage(page({ introduction: '示例主播聊回放与赛事直播' }), '123456').ok).toBe(true)
  })
  it.each([{ introduction: '回放示例赛事' }, { roomName: '示例赛事重播' }])('also rejects replay markers in gameLiveInfo %j', live => {
    expect(parseHuyaPage(page({}, [sampleLine()], [], live), '123456')).toMatchObject({ ok: false, failure: { code: 'not-live' } })
  })
  it('rejects the explicit replay flag and both restricted-room notices', () => {
    expect(parseHuyaPage(page({ isReplay: true }), '123456')).toMatchObject({ ok: false, failure: { code: 'not-live' } })
    for (const notice of ['房间已被封禁', '主播已被封禁']) {
      expect(parseHuyaPage(`<p>${notice}</p>`, '123456')).toMatchObject({ ok: false, failure: { code: 'restricted' } })
    }
  })
  it('supports HTML-escaped JSON without evaluating surrounding player JavaScript', () => {
    expect(parseHuyaPage(fixture('live').replaceAll('"', '&quot;').replaceAll('&fm=', '&amp;fm='), '123456'))
      .toMatchObject({ ok: true, room: '123456', lines: [{ cdn: 'TX' }, { cdn: 'AL' }] })
  })
  it.each([null, 1, {}, 'x'.repeat(2 * 1_048_576 + 1)])('rejects invalid or oversized page input', raw => {
    expect(parseHuyaPage(raw as string, '123456')).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
  })
  it.each([
    '<script>var TT_ROOM_DATA = {"state":"ON";</script>',
    '<script>var TT_ROOM_DATA = {"state":true,"profileRoom":123456};</script>',
    '<script>var TT_ROOM_DATA = {"state":"ON","profileRoom":' + '['.repeat(33) + '0' + ']'.repeat(33) + '};</script>',
  ])('fails closed for malformed, wrongly typed or deeply nested room JSON', raw => {
    expect(parseHuyaPage(raw, '123456')).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
  })
  it('requires a canonical room for an alias but can retain a numeric room when profileRoom is absent', () => {
    expect(parseHuyaPage(page({ profileRoom: 'not-numeric' }), 'example-room')).toMatchObject({ ok: false, failure: { code: 'room-not-found' } })
    expect(parseHuyaPage(page({ profileRoom: null }), '123456')).toMatchObject({ ok: true, room: '123456' })
  })
  it.each([
    { sCdnType: 'hy' }, { sCdnType: 'HUYA' }, { sCdnType: 'HYZJ' }, { sCdnType: 'A'.repeat(17) },
    { sStreamName: 'a'.repeat(257) }, { sStreamName: '../escape' }, { sStreamName: 123 },
    { iWebPriorityRate: '100' }, { iWebPriorityRate: -1 }, { iWebPriorityRate: 1_000_001 },
    { sFlvUrlSuffix: 'm3u8' }, { sFlvUrl: 'https://huya.com.evil.invalid/live' },
    { sFlvUrl: 'https://user:secret@flv.huya.com/live' }, { sFlvUrl: 'https://flv.huya.com:8443/live' },
    { sFlvUrl: 'https://flv.huya.com/live?secret=fixture' }, { sFlvUrl: 'https://flv.huya.com/live#secret' },
    { sFlvUrl: 'https://flv.huya.com/line\nunsafe' }, { sFlvUrl: 'a'.repeat(32769) },
    { lPresenterUid: '18446744073709551616' }, { lPresenterUid: -1 }, { lPresenterUid: 9_007_199_254_740_992 },
    { lPresenterUid: {} },
  ])('drops invalid or unsupported line fields %j', patch => {
    expect(parseHuyaPage(page({}, [sampleLine(patch)]), '123456')).toMatchObject({ ok: true, lines: [] })
  })
  it('bounds line counts and antiCode length and preserves 64-bit presenter strings exactly', () => {
    expect(parseHuyaPage(page({}, Array.from({ length: 101 }, () => sampleLine())), '123456')).toMatchObject({ ok: true, lines: [] })
    const result = parseHuyaPage(page({}, [sampleLine({ lPresenterUid: '1311768465173141112', sFlvAntiCode: 'x'.repeat(16385) })]), '123456')
    expect(result).toMatchObject({ ok: true, lines: [{ presenter: 1311768465173141112n, antiCode: '' }] })
  })
  it('treats malformed stream JSON and wrongly typed stream collections as unavailable metadata', () => {
    for (const stream of ['{"data":[}', '{"data":{}}', '{"data":[{"gameStreamInfoList":{}}]}']) {
      const raw = '<script>var TT_ROOM_DATA = {"state":"ON","profileRoom":123456}; var player = {stream: ' + stream + '};</script>'
      expect(parseHuyaPage(raw, '123456')).toMatchObject({ ok: true, lines: [], qualities: [] })
    }
  })
})

describe('Huya quality metadata', () => {
  it('filters non-integer, duplicate, out-of-range and non-H264 entries and bounds labels', () => {
    expect(parseHuyaQualities([
      { iBitRate: 0, sDisplayName: ' 原画 ' }, { iBitRate: 0, sDisplayName: '重复' },
      { iBitRate: 8000, sDisplayName: '蓝光', iCodecType: 1 }, { iBitRate: 8000, sDisplayName: '蓝光 H264', iCodecType: 0 },
      { iBitRate: '4000' }, { iBitRate: -1 }, { iBitRate: 1.5 }, { iBitRate: 1_000_001 }, null,
      { iBitRate: 4000, sDisplayName: 'x'.repeat(81) }, { iBitRate: 2000, sDisplayName: '错误\n名称' },
    ])).toEqual([{ id: '0', label: '原画' }, { id: '8000', label: '蓝光 H264' }, { id: '4000', label: '画质 4000' }, { id: '2000', label: '画质 2000' }])
  })
  it.each([null, {}, 123, 'qualities', Array.from({ length: 101 }, () => ({ iBitRate: 0 }))])('bounds quality collections', value => {
    expect(parseHuyaQualities(value)).toEqual([])
  })
})

describe('Huya local signing fixed vectors', () => {
  // Derived independently with node:crypto from prefix "fixture", stream "example-stream"
  // and inner MD5 of "1792269945678|huya_live|100" = f61bc13f51f461cc7e1929af7a5aec06.
  // Full t=100 preimage: fixture_3160493568_example-stream_f61bc13f51f461cc7e1929af7a5aec06_6ad3bc50.
  it.each([
    [12345678n, TOKEN, 'f07971aeb7e7c3df1738dc5b20b5f68d', '1792269945678', '3160493568', '6ad3bc50'],
    [12345678n, TOKEN.replace('wsTime=6ad3bc50', 'wsTime=1'), '4301fab80505cc27aa64bc94a38de40c', '1792269945678', '3160493568', '6ad4ffc0'],
    [1311768465173141112n, TOKEN, 'b7d95b9854ca1692fde73b957ebfcd2e', '1311770257430741112', '1311768465745803282', '6ad3bc50'],
  ])('signs UID %s with exact 64-bit arithmetic', (uid, token, secret, seqid, converted, wsTime) => {
    const auth = buildHuyaAuth('example-stream', token, uid, { now: () => NOW, random: () => 0.25 })
    expect(auth).not.toBeNull()
    const params = new URLSearchParams(auth!)
    expect(Object.fromEntries(params)).toMatchObject({ wsSecret: secret, seqid, u: converted, wsTime, t: '100', ctype: 'huya_live' })
    expect(params.has('uid')).toBe(false)
  })
  it('uses the original UID for t=103 and deterministic UUID rather than the rotated UID', () => {
    const random = vi.fn().mockReturnValueOnce(0.25).mockReturnValueOnce(0.75)
    const auth = buildHuyaAuth('example-stream', TOKEN.replace('t=100', 't=103'), 12345678n, { now: () => NOW, random })
    const params = new URLSearchParams(auth!)
    expect(Object.fromEntries(params)).toMatchObject({ wsSecret: 'd53295eaf40c53843c95fef828cd6f47', uid: '12345678', uuid: '2047453580', seqid: '1792269945678', t: '103' })
    expect(params.has('u')).toBe(false)
    expect(random).toHaveBeenCalledTimes(2)
  })
  it.each([
    [[0.25, 0.5], '7e3fd22d60da4604af620eb4121af52a', '1792269945000', '3160320000'],
    [[0.75, 0.5], 'c179e673f324ab6c7dc331ca904f31f3', '3192262600000', '1399303389430'],
  ])('selects anonymous UID from deterministic RNG samples %j', (values, wsSecret, seqid, u) => {
    const samples = [...values]
    const params = new URLSearchParams(buildHuyaAuth('example-stream', TOKEN, 0n, { now: () => NOW, random: () => samples.shift()! })!)
    expect(Object.fromEntries(params)).toMatchObject({ wsSecret, seqid, u })
    expect(samples).toEqual([])
  })
  it('preserves the upper UID word and rotates the low word by eight bits', () => {
    expect(rotateHuyaUid(0x12345678_12345678n)).toBe(0x12345678_34567812n)
    expect(rotateHuyaUid(0xffff_ffff_ffff_ffffn)).toBe(0xffff_ffff_ffff_ffffn)
  })
  it('extends tokens only when less than twenty minutes remain', () => {
    const exactBoundary = (Math.floor(NOW / 1000) + 1200).toString(16)
    const params = new URLSearchParams(buildHuyaAuth('example-stream', TOKEN.replace('6ad3bc50', exactBoundary), 12345678n, { now: () => NOW })!)
    expect(params.get('wsTime')).toBe(exactBoundary)
    const nearlyExpired = (Math.floor(NOW / 1000) + 1199).toString(16)
    const extended = new URLSearchParams(buildHuyaAuth('example-stream', TOKEN.replace('6ad3bc50', nearlyExpired), 12345678n, { now: () => NOW })!)
    expect(extended.get('wsTime')).toBe('6ad4ffc0')
    expect(extended.get('wsSecret')).toBe('4301fab80505cc27aa64bc94a38de40c')
  })
  it.each([
    '', 'x'.repeat(16385), TOKEN + '&t=103', TOKEN.replace('fm=Zml4dHVyZV9zdHJlYW0%3D', 'fm=not-base64!'),
    TOKEN.replace('fm=Zml4dHVyZV9zdHJlYW0%3D', 'fm=%25broken'), TOKEN.replace('wsTime=6ad3bc50', 'wsTime=xyz'),
    TOKEN.replace('ctype=huya_live', 'ctype=bad%0D%0Avalue'), TOKEN + '&Cookie=private\nsecret',
    TOKEN + Array.from({ length: 65 }, (_, n) => `&p${n}=v`).join(''),
  ])('refuses malformed or unbounded signature parameters', token => {
    expect(buildHuyaAuth('example-stream', token, 12345678n, { now: () => NOW })).toBeNull()
  })
  it('rejects invalid streams, UID ranges and clock values before signing', () => {
    expect(buildHuyaAuth('../escape', TOKEN, 1n)).toBeNull()
    expect(buildHuyaAuth('example-stream', TOKEN, -1n)).toBeNull()
    expect(buildHuyaAuth('example-stream', TOKEN, 0x1_0000_0000_0000_0000n)).toBeNull()
    for (const now of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(buildHuyaAuth('example-stream', TOKEN, 1n, { now: () => now })).toBeNull()
    }
  })
})

describe('Huya resolver token fallback and media boundary', () => {
  it.each(['Ex', 'AntiCode'])('omits ratio for original quality and retains nonzero ratios with %s tokens', async source => {
    for (const quality of [undefined, '0', '8000']) {
      const result = await resolveHuya('123456', deps({ quality,
        fetchBytes: source === 'Ex' ? async () => Buffer.from(golden.response, 'hex') : undefined,
      }))
      expect(result).toMatchObject({ ok: true, stream: { quality: quality ?? '0' } })
      if (!result.ok) return
      const url = new URL(result.stream.url)
      expect(url.searchParams.get('codec')).toBe('264')
      expect(url.searchParams.get('ratio')).toBe(quality === '8000' ? '8000' : null)
      expect(result.stream.notes?.join(' ')).toContain(`令牌来源: ${source}`)
    }
  })
  it('uses WUP Ex before AntiCode, selects the highest-priority eligible line and never probes media', async () => {
    const fetchBytes = vi.fn(async () => Buffer.from(golden.response, 'hex'))
    const fetchText = vi.fn(async () => fixture('live'))
    const runYtDlp = vi.fn()
    const proxify = vi.fn(url => url)
    const result = await resolveHuya('123456', deps({ fetchBytes, fetchText, runYtDlp, proxify, quality: '8000' }))
    expect(result).toMatchObject({ ok: true, stream: { platform: 'huya', channel: '123456', sourceRoom: '123456', kind: 'progressive', quality: '8000', headers: { Referer: 'https://www.huya.com/' } } })
    if (!result.ok) return
    const url = new URL(result.stream.url)
    expect(url.origin).toBe('https://high.flv.huya.com')
    expect(url.pathname).toBe('/src/example-stream.flv')
    expect(url.searchParams.get('codec')).toBe('264')
    expect(url.searchParams.get('ratio')).toBe('8000')
    expect(result.stream.notes?.join(' ')).toMatch(/线路: TX.*令牌来源: Ex/)
    expect(result.stream.danmakuRoom).toBeUndefined()
    expect(JSON.stringify(result.stream.notes)).not.toMatch(/wsSecret|abc123|Cookie/)
    expect(fetchBytes).toHaveBeenCalledExactlyOnceWith('https://wup.huya.com', expect.objectContaining({ method: 'POST', body: expect.any(Uint8Array), headers: expect.objectContaining({ Referer: 'https://www.huya.com/', 'Content-Type': 'application/octet-stream' }) }))
    expect(fetchText).toHaveBeenCalledExactlyOnceWith('https://www.huya.com/123456', expect.any(Object))
    expect(proxify).toHaveBeenCalledExactlyOnceWith(result.stream.url)
    expect(runYtDlp).not.toHaveBeenCalled()
  })
  it('resolves a string room to its numeric page before signing or fetching WUP metadata', async () => {
    const events: string[] = []
    const fetchText = vi.fn(async (url: string) => { events.push(url); return url.endsWith('/example-room') ? fixture('alias') : fixture('live') })
    const fetchBytes = vi.fn(async () => { events.push('WUP'); return Buffer.from(golden.response, 'hex') })
    expect(await resolveHuya('www.huya.com/example-room', deps({ fetchText, fetchBytes }))).toMatchObject({ ok: true, stream: { channel: '123456', sourceRoom: '123456' } })
    expect(events).toEqual(['https://www.huya.com/example-room', 'https://www.huya.com/123456', 'WUP'])
  })
  it.each(['unavailable', 'malformed', 'missing'])('falls back from %s Ex to the page AntiCode', async mode => {
    const fetchBytes = mode === 'missing' ? undefined : vi.fn(async () => {
      if (mode === 'unavailable') throw new Error('Cookie: PRIVATE https://signed.huya.com/x?wsSecret=PRIVATE')
      return new Uint8Array([0, 1, 2])
    })
    const runYtDlp = vi.fn()
    const result = await resolveHuya('123456', deps({ fetchBytes, runYtDlp }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stream.notes?.join(' ')).toContain('令牌来源: AntiCode')
    expect(new URL(result.stream.url).searchParams.get('wsSecret')).toBe('f07971aeb7e7c3df1738dc5b20b5f68d')
    expect(runYtDlp).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
  it('tries the next eligible line with new token metadata before invoking yt-dlp', async () => {
    const fetchBytes = vi.fn(async () => { throw new Error('Unavailable WUP') })
    const runYtDlp = vi.fn()
    const result = await resolveHuya('123456', deps({ fetchText: async () => page({}, [sampleLine({ sFlvAntiCode: 'invalid' }), sampleLine({ sCdnType: 'AL', iWebPriorityRate: 10, sFlvUrl: 'http://low.flv.huya.com/src' })]), fetchBytes, runYtDlp }))
    expect(result.ok && result.stream.url).toMatch(/^https:\/\/low\.flv\.huya\.com\//)
    expect(result.ok && result.stream.notes?.join(' ')).toContain('线路: AL')
    expect(fetchBytes).toHaveBeenCalledTimes(2)
    expect(runYtDlp).not.toHaveBeenCalled()
  })
  it('uses yt-dlp only after Ex and all AntiCodes fail, enforcing HTTPS/H264 and keeping the room canonical', async () => {
    const events: string[] = []
    const runYtDlp = vi.fn(async (url: string) => {
      events.push('yt-dlp')
      expect(url).toBe('https://www.huya.com/123456')
      return { is_live: true, formats: [
        { url: 'https://unsafe.invalid/live.flv?wsSecret=PRIVATE', vcodec: 'h264' },
        { url: 'https://fallback.flv.huya.com/live.flv?wsSecret=PRIVATE&ratio=8000', vcodec: 'hevc' },
        { url: 'http://fallback.flv.huya.com/live.flv?wsSecret=PRIVATE&ratio=8000', vcodec: 'avc1' },
      ] }
    })
    const result = await resolveHuya('123456', deps({ quality: '8000', fetchText: async () => page({}, [sampleLine({ sFlvAntiCode: 'invalid' })], [{ iBitRate: 8000, sDisplayName: '蓝光' }]),
      fetchBytes: async () => { events.push('Ex'); throw new Error('Unavailable WUP') }, runYtDlp }))
    expect(result).toMatchObject({ ok: true, stream: { quality: '8000', headers: { Referer: 'https://www.huya.com/' } } })
    if (!result.ok) return
    expect(result.stream.url).toBe('https://fallback.flv.huya.com/live.flv?wsSecret=PRIVATE&ratio=8000&codec=264')
    expect(result.stream.notes?.join(' ')).toContain('令牌来源: yt-dlp')
    expect(result.stream.danmakuRoom).toBeUndefined()
    expect(events).toEqual(['Ex', 'yt-dlp'])
  })
  it.each([
    { quality: undefined, incomingRatio: '', expectedRatio: null },
    { quality: '0', incomingRatio: '', expectedRatio: null },
    { quality: '0', incomingRatio: '&ratio=0', expectedRatio: null },
    { quality: '8000', incomingRatio: '&ratio=8000', expectedRatio: '8000' },
  ])('preserves selected quality $quality in yt-dlp fallback without sending ratio=0', async ({ quality, incomingRatio, expectedRatio }) => {
    const result = await resolveHuya('123456', deps({ quality, fetchText: async () => page({}, [], [{ iBitRate: 0 }, { iBitRate: 8000 }]), runYtDlp: async () => ({
      formats: [
        { url: 'https://fallback.flv.huya.com/wrong.flv?wsSecret=fixture&ratio=4000', vcodec: 'h264' },
        { url: `https://fallback.flv.huya.com/live.flv?wsSecret=fixture${incomingRatio}`, vcodec: 'h264' },
      ],
    }) }))
    expect(result).toMatchObject({ ok: true, stream: { quality: quality ?? '0' } })
    if (!result.ok) return
    const url = new URL(result.stream.url)
    expect(url.pathname).toBe('/live.flv')
    expect(url.searchParams.get('codec')).toBe('264')
    expect(url.searchParams.get('ratio')).toBe(expectedRatio)
  })
  it.each([undefined, '0', '8000'])('rejects yt-dlp formats that do not match selected quality %s', async quality => {
    const result = await resolveHuya('123456', deps({ quality, fetchText: async () => page({}, [], [{ iBitRate: 0 }, { iBitRate: 8000 }]), runYtDlp: async () => ({
      formats: [{ url: 'https://fallback.flv.huya.com/live.flv?wsSecret=fixture&ratio=4000', vcodec: 'h264' }],
    }) }))
    expect(result).toMatchObject({ ok: false, failure: { code: 'needs-manual-url' } })
  })
  it.each([
    ['not live PRIVATE', 'not-live'], ['Forbidden PRIVATE Cookie: SECRET', 'restricted'],
    ['request failed https://signed.huya.com/x.flv?wsSecret=PRIVATE Cookie: SECRET', 'upstream-error'],
  ])('sanitizes every extractor error while classifying failure as %s', async (diagnostic, code) => {
    const loggers = (['error', 'warn', 'info', 'log'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    try {
      const result = await resolveHuya('123456', deps({ fetchText: async () => page({}, [sampleLine({ sFlvAntiCode: 'invalid' })]), runYtDlp: async () => { throw new Error(diagnostic) } }))
      expect(result).toMatchObject({ ok: false, failure: { code, message: expect.stringContaining('虎牙'), hint: expect.any(String) } })
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|signed\.huya|Cookie|wsSecret/)
      for (const logger of loggers) expect(logger).not.toHaveBeenCalled()
    } finally { for (const logger of loggers) logger.mockRestore() }
  })
  it.each([false, { is_live: false }, { live_status: 'was_live' }, { title: '回放示例赛事' }])('rejects an unusable extractor response %j', async metadata => {
    const result = await resolveHuya('123456', deps({ fetchText: async () => page({}, []), runYtDlp: async () => metadata }))
    expect(result).toMatchObject({ ok: false, failure: { code: metadata === false ? 'needs-manual-url' : 'not-live' } })
  })
  it('accepts nullable fields from the real yt-dlp projection after the page confirms a live room', async () => {
    const result = await resolveHuya('123456', deps({ fetchText: async () => page({}, []), runYtDlp: async () => ({
      is_live: null, live_status: null, formats: [{ vcodec: null, acodec: null,
        url: 'https://fallback.flv.huya.com/live.flv?wsSecret=fixture' }],
    }) }))
    expect(result).toMatchObject({ ok: true, stream: { platform: 'huya', quality: '0', notes: expect.arrayContaining([expect.stringContaining('yt-dlp')]) } })
  })
  it('reports missing backup tools and never forwards page request diagnostics', async () => {
    expect(await resolveHuya('123456', deps({ fetchText: async () => page({}, []) }))).toMatchObject({ ok: false, failure: { code: 'needs-manual-url' } })
    const result = await resolveHuya('123456', deps({ fetchText: async () => { throw new Error('Cookie: SECRET signed.huya.com/?wsSecret=PRIVATE') } }))
    expect(result).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|Cookie|signed\.huya|wsSecret/)
  })
  it.each(['-1', '1.5', '1000001', 'x', '0\n', '1'.repeat(128), '9000'])('rejects invalid or unavailable quality %j without WUP or extractor requests', async quality => {
    const fetchBytes = vi.fn()
    const runYtDlp = vi.fn()
    expect(await resolveHuya('123456', deps({ quality, fetchBytes, runYtDlp }))).toMatchObject({ ok: false, failure: { code: 'unsupported-url' } })
    expect(fetchBytes).not.toHaveBeenCalled()
    expect(runYtDlp).not.toHaveBeenCalled()
  })
  it.each(['offline', 'replay', 'not-found', 'restricted', 'malformed'])('never invokes token or extractor fallback for a %s room', async name => {
    const fetchBytes = vi.fn()
    const runYtDlp = vi.fn()
    expect((await resolveHuya('123456', deps({ fetchText: async () => fixture(name), fetchBytes, runYtDlp }))).ok).toBe(false)
    expect(fetchBytes).not.toHaveBeenCalled()
    expect(runYtDlp).not.toHaveBeenCalled()
  })
})
