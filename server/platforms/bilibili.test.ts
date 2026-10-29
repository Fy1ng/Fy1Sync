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
  return { quality, fetchJson: vi.fn(async () => payload), fetchText: async () => { throw new Error('unexpected fetchText') }, proxify: url => url }
}

describe('Bilibili actual upstream quality', () => {
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
    expect(result.ok && result.stream.notes?.join(' ')).toContain('当前未登录, 请求蓝光, 实际为高清')
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
