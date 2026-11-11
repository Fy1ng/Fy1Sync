import { describe, expect, it, vi } from 'vitest'
import { resolveBilibili } from './bilibili'
import type { ResolverDeps } from './types'
import { StreamFailureError } from '../networkFailure'

function fixture(current = 150, accept: number[] = [150, 250, 400, 10000]) {
  return { code: 0, data: { live_status: 1, playurl_info: { playurl: {
    g_qn_desc: [{ qn: 150, desc: '高清' }, { qn: 250, desc: '超清' }, { qn: 400, desc: '蓝光' }, { qn: 10000, desc: '原画' }],
    stream: [{ protocol_name: 'http_hls', format: [{ format_name: 'fmp4', codec: [
      { codec_name: 'hevc', current_qn: 250, accept_qn: accept, base_url: '/hevc.m3u8', url_info: [{ host: 'https://fixture.bilivideo.com' }] },
      { codec_name: 'avc', current_qn: current, accept_qn: accept, base_url: '/avc.m3u8', url_info: [{ host: 'https://fixture.bilivideo.com', extra: '?sig=fixture' }] },
    ] }] }],
  } } } }
}

function dependencies(quality?: string, payload = fixture()): ResolverDeps {
  return { quality, fetchJson: vi.fn(async () => payload), fetchText: vi.fn(async () => { throw new Error('unexpected fetchText') }), proxify: url => url }
}

function hlsFormat(name: string, current: number, accept: number[]) {
  return { format_name: name, codec: [
    { codec_name: 'avc', current_qn: current, accept_qn: accept, base_url: `/${name}.m3u8`,
      url_info: [{ host: 'https://fixture.bilivideo.com', extra: '?sig=fixture' }] },
  ] }
}

function formatsFixture(...formats: ReturnType<typeof hlsFormat>[]) {
  const payload = fixture()
  payload.data.playurl_info.playurl.stream = [{ protocol_name: 'http_hls', format: formats }]
  return payload
}

describe('Bilibili actual upstream quality', () => {
  it('reads fresh main-only cookies for the complete official play-info URL and keeps credentials out of streams', async () => {
    const deps = dependencies('400')
    deps.cookieHeader = vi.fn(async () => 'SESSDATA=fixture-private-session; DedeUserID=42')
    const result = await resolveBilibili('live.bilibili.com/12345', deps)
    const requestUrl = 'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=12345&protocol=0%2C1&format=0%2C1%2C2&codec=0%2C1&qn=400&platform=web&ptype=8'
    expect(deps.cookieHeader).toHaveBeenCalledExactlyOnceWith('bilibili', requestUrl)
    expect(deps.fetchJson).toHaveBeenCalledExactlyOnceWith(requestUrl, { headers: { Cookie: 'SESSDATA=fixture-private-session; DedeUserID=42' } })
    expect(result).toMatchObject({ ok: true, stream: { quality: '150' } })
    expect(JSON.stringify(result)).not.toMatch(/SESSDATA|DedeUserID|fixture-private-session|Cookie/)
    expect(deps.fetchText).not.toHaveBeenCalled()
  })

  it.each([undefined, ''] as const)('continues anonymously when the main cookie capability returns %s', async value => {
    const deps = dependencies()
    if (value !== undefined) deps.cookieHeader = vi.fn(async () => value)
    expect((await resolveBilibili('12345', deps)).ok).toBe(true)
    expect(vi.mocked(deps.fetchJson).mock.calls[0]![1]).toBeUndefined()
  })

  it('reports only explicit account-not-logged-in code as login-required without exposing upstream diagnostics', async () => {
    const deps = dependencies()
    deps.fetchJson = vi.fn(async () => ({ code: -101, message: 'PRIVATE_COOKIE=private-value' }))
    expect(await resolveBilibili('12345', deps)).toMatchObject({ ok: false, failure: { code: 'login-required', hint: '请登录B站后重新加载片源.' } })
    expect(JSON.stringify(await resolveBilibili('12345', deps))).not.toContain('PRIVATE_COOKIE')
  })

  it.each([-102, -111, -400, -352, 403, 500])('does not treat non-login API code %s as authentication failure', async code => {
    const deps = dependencies()
    deps.fetchJson = vi.fn(async () => ({ code }))
    expect(await resolveBilibili('12345', deps)).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
  })

  it('sanitizes credential-reader failures and never requests the media CDN with credentials', async () => {
    const deps = dependencies()
    deps.cookieHeader = vi.fn(async () => { throw new Error('SESSDATA=private-value') })
    const result = await resolveBilibili('12345', deps)
    expect(result).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
    expect(JSON.stringify(result)).not.toContain('private-value')
    expect(deps.fetchJson).not.toHaveBeenCalled()
  })

  it('requests the selected qn and reports the actual AVC rendition and advertised options', async () => {
    const deps = dependencies('400')
    const result = await resolveBilibili('12345', deps)
    expect(new URL(vi.mocked(deps.fetchJson).mock.calls[0]![0]).searchParams.get('qn')).toBe('400')
    expect(result).toMatchObject({ ok: true, stream: {
      quality: '150', qualities: [
        { id: '10000', label: '原画' }, { id: '400', label: '蓝光' }, { id: '250', label: '超清' }, { id: '150', label: '高清' },
      ],
    } })
    expect(result.ok && result.stream.url).toBe('https://fixture.bilivideo.com/avc.m3u8?sig=fixture')
    expect(result.ok && result.stream.notes?.join(' ')).toContain('请求蓝光, 实际为高清')
    expect(result.ok && result.stream.notes?.join(' ')).not.toContain('未登录')
  })

  it('uses TS original quality when the preferred fMP4 rendition is capped at super clear', async () => {
    const result = await resolveBilibili('12345', dependencies(undefined, formatsFixture(
      hlsFormat('fmp4', 250, [150, 250]), hlsFormat('ts', 10000, [150, 250, 400, 10000]),
    )))
    expect(result).toMatchObject({ ok: true, stream: {
      url: 'https://fixture.bilivideo.com/ts.m3u8?sig=fixture', quality: '10000',
      qualities: [{ id: '10000', label: '原画' }, { id: '400', label: '蓝光' }, { id: '250', label: '超清' }, { id: '150', label: '高清' }],
    } })
  })

  it('keeps the other HLS formats available after switching to a lower fMP4 quality', async () => {
    const result = await resolveBilibili('12345', dependencies('250', formatsFixture(
      hlsFormat('fmp4', 250, [150, 250]), hlsFormat('ts', 250, [150, 250, 400, 10000]),
    )))
    expect(result).toMatchObject({ ok: true, stream: {
      url: 'https://fixture.bilivideo.com/fmp4.m3u8?sig=fixture', quality: '250',
      qualities: [{ id: '10000', label: '原画' }, { id: '400', label: '蓝光' }, { id: '250', label: '超清' }, { id: '150', label: '高清' }],
    } })
  })

  it('selects the requested lower quality even if another format returns a higher quality', async () => {
    const result = await resolveBilibili('12345', dependencies('150', formatsFixture(
      hlsFormat('fmp4', 250, [150, 250]), hlsFormat('ts', 150, [150, 250, 400, 10000]),
    )))
    expect(result).toMatchObject({ ok: true, stream: { quality: '150', url: 'https://fixture.bilivideo.com/ts.m3u8?sig=fixture' } })
  })

  it('skips an incomplete fMP4 address and uses a valid TS rendition', async () => {
    const incomplete = hlsFormat('fmp4', 10000, [150, 10000])
    incomplete.codec[0]!.url_info = []
    const result = await resolveBilibili('12345', dependencies(undefined, formatsFixture(incomplete, hlsFormat('ts', 10000, [150, 10000]))))
    expect(result).toMatchObject({ ok: true, stream: { quality: '10000', url: 'https://fixture.bilivideo.com/ts.m3u8?sig=fixture' } })
  })

  it('does not treat a FLV response as a playable HLS source', async () => {
    const payload = formatsFixture(hlsFormat('flv', 10000, [10000]))
    payload.data.playurl_info.playurl.stream[0]!.protocol_name = 'http_stream'
    const result = await resolveBilibili('12345', dependencies(undefined, payload))
    expect(result).toMatchObject({ ok: false, failure: { code: 'needs-manual-url' } })
  })

  it.each([undefined, 'auto', 'garbage', '-1', '400&extra=1'])('defaults an unset or invalid selection to original quality: %s', async quality => {
    const deps = dependencies(quality)
    await resolveBilibili('12345', deps)
    expect(new URL(vi.mocked(deps.fetchJson).mock.calls[0]![0]).searchParams.get('qn')).toBe('10000')
  })

  it('does not report a mismatch when the requested qn was returned', async () => {
    const result = await resolveBilibili('12345', dependencies('400', fixture(400)))
    expect(result).toMatchObject({ ok: true, stream: { quality: '400' } })
    expect(result.ok && result.stream.notes?.join(' ')).not.toContain('实际为')
  })

  it('includes a returned quality missing from accept_qn and removes duplicate or invalid options', async () => {
    const result = await resolveBilibili('12345', dependencies('400', fixture(150, [400, 400, -1, Number.NaN])))
    expect(result).toMatchObject({ ok: true, stream: { qualities: [{ id: '400', label: '蓝光' }, { id: '150', label: '高清' }] } })
  })

  it('retains structured network errors without flattening them into resolve failures', async () => {
    const deps = dependencies('400')
    const error = new StreamFailureError({ stage: 'connect', code: 'tls-certificate', message: '服务器证书校验失败.' })
    deps.fetchJson = async () => { throw error }
    await expect(resolveBilibili('12345', deps)).rejects.toBe(error)
  })
})
