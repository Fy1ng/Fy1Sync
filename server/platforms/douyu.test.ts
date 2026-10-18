import { describe, expect, it, vi } from 'vitest'
import { buildDouyuAuth, parseDouyuQualities, resolveDouyu, type DouyuEncryption } from './douyu'
import { detectPlatform, looksLikeDirectMedia, resolveStream } from './index'
import type { ResolverDeps } from './types'

const encryption: DouyuEncryption = { rand_str: 'seed', key: 'key', enc_time: 3, is_special: 0, enc_data: 'opaque-encryption-data' }
const multirates = [{ name: '原画2K60', rate: 0 }, { name: '蓝光4M', rate: 4 }, { name: '超清', rate: 3 }, { name: '高清', rate: 2 }]
const play = { error: 0, data: { rtmp_url: 'http://media.douyucdn.invalid/live', rtmp_live: '9999.flv?signature=fixture', rate: 0, multirates } }

function deps(overrides: Partial<ResolverDeps> = {}): ResolverDeps {
  return { fetchJson: async (url) => url.includes('getEncryption') ? { error: 0, data: encryption } : play, fetchText: vi.fn(), proxify: (url) => url, now: () => 1_792_257_600_000, ...overrides }
}

describe('Douyu iterated MD5 auth fixed vectors', () => {
  it.each([
    [0, 0, '30a001464ed490f5a42d271f2d8936e4'], [0, 1, 'e63f9e2eb526a157c797fcd143262499'],
    [1, 0, '5e03252d65d9414591567bff8d8abf05'], [1, 1, 'ca28c4f4601e1d239c6568ac571462f6'],
    [3, 0, 'e1f1bad6a0af372bf8779cbaaa5f0689'], [3, 1, '6e95aca4de205c758d8a05ee523b63c9'],
  ])('rounds=%i special=%i', (enc_time, is_special, expected) => {
    expect(buildDouyuAuth('9999', 1_792_257_600, { ...encryption, enc_time, is_special })).toBe(expected)
  })
})

describe('Douyu PC play API', () => {
  it('builds seed and signed play requests using the cookie did, preserving HTTP FLV and Referer', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const cookie = 'dy_did=abcdef0123456789abcdef0123456789; auth=private-cookie'
    const result = await resolveDouyu('9999', deps({ douyuCookie: cookie, quality: '4', fetchJson: async (url, init) => {
      requests.push({ url, init })
      return url.includes('getEncryption') ? { error: 0, data: encryption } : { ...play, data: { ...play.data, rate: 4 } }
    } }))
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe('https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did=abcdef0123456789abcdef0123456789')
    expect(requests[1]?.url).toBe('https://www.douyu.com/lapi/live/getH5PlayV1/9999')
    expect(requests[1]?.init).toMatchObject({ method: 'POST', headers: { Cookie: cookie, Referer: 'https://www.douyu.com/', 'Content-Type': 'application/x-www-form-urlencoded' } })
    const body = new URLSearchParams(String(requests[1]?.init?.body))
    expect(Object.fromEntries(body)).toEqual({ enc_data: 'opaque-encryption-data', tt: '1792257600', did: 'abcdef0123456789abcdef0123456789', auth: 'e1f1bad6a0af372bf8779cbaaa5f0689', cdn: '', rate: '4', hevc: '0', fa: '0', ive: '0' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stream).toMatchObject({ platform: 'douyu', kind: 'progressive', quality: '4', danmakuRoom: '9999', headers: { Referer: 'https://www.douyu.com/' } })
    expect(result.stream.url).toBe('http://media.douyucdn.invalid/live/9999.flv?signature=fixture')
    expect(result.stream.qualities).toEqual(multirates.map((item) => ({ id: String(item.rate), label: item.name })))
    expect(JSON.stringify(result)).not.toContain('private-cookie')
    expect(JSON.stringify(result)).not.toContain('abcdef0123456789abcdef0123456789')
  })

  it('uses fresh tt after obtaining each seed and re-requests play for a quality change', async () => {
    let clock = 1_792_257_600_000
    const bodies: URLSearchParams[] = []
    const d = deps({ now: () => clock, fetchJson: async (url, init) => {
      if (url.includes('getEncryption')) { clock += 2_000; return { error: 0, data: encryption } }
      bodies.push(new URLSearchParams(String(init?.body)))
      return play
    } })
    await resolveDouyu('9999', { ...d, quality: '0' })
    await resolveDouyu('9999', { ...d, quality: '3' })
    expect(bodies.map((body) => body.get('tt'))).toEqual(['1792257602', '1792257604'])
    expect(bodies.map((body) => body.get('rate'))).toEqual(['0', '3'])
    expect(bodies[0]?.get('auth')).not.toBe(bodies[1]?.get('auth'))
    expect(bodies[1]?.get('auth')).toBe(buildDouyuAuth('9999', 1_792_257_604, encryption))
    expect(bodies[0]?.get('did')).toBe('10000000000000000000000000001501')
  })

  it('surfaces an API downgrade instead of claiming source quality was delivered', async () => {
    const result = await resolveDouyu('9999', deps({ fetchJson: async (url) => url.includes('getEncryption') ? { error: 0, data: encryption } : { ...play, data: { ...play.data, rate: 4 } } }))
    expect(result.ok && result.stream.quality).toBe('4')
    expect(result.ok && result.stream.notes?.join('')).toContain('不同的画质')
  })

  it.each([[102, 'not-live'], [101, 'room-not-found'], [403, 'restricted'], [999, 'upstream-error']])('classifies play error %i', async (error, code) => {
    const result = await resolveDouyu('9999', deps({ fetchJson: async (url) => url.includes('getEncryption') ? { error: 0, data: encryption } : { error, msg: 'upstream diagnostic https://signed.invalid/?cookie=secret' } }))
    expect(!result.ok && result.failure.code).toBe(code)
    expect(!result.ok && result.failure.hint).toContain('9999')
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it.each(['请登录后观看', '房间设置密码', '仅限付费用户观看'])('classifies access messages: %s', async (msg) => {
    const result = await resolveDouyu('9999', deps({ fetchJson: async (url) => url.includes('getEncryption') ? { error: 0, data: encryption } : { error: -999, msg } }))
    expect(!result.ok && result.failure.code).toBe('restricted')
  })

  it('supports HLS results and preserves the danmaku room', async () => {
    const result = await resolveDouyu('9999', deps({ fetchJson: async (url) => url.includes('getEncryption') ? { error: 0, data: encryption } : { ...play, data: { ...play.data, rtmp_live: '9999.m3u8?signature=fixture' } } }))
    expect(result.ok && result.stream.kind).toBe('hls')
    expect(result.ok && result.stream.danmakuRoom).toBe('9999')
  })

  it('rejects malformed/boundless encryption seeds before signing', async () => {
    for (const enc_time of [-1, 0.5, 10_001, Infinity, '2']) {
      const fetchJson = vi.fn(async () => ({ error: 0, data: { ...encryption, enc_time } }))
      const result = await resolveDouyu('9999', deps({ fetchJson }))
      expect(!result.ok && result.failure.code).toBe('upstream-error')
      expect(fetchJson).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps network errors private and the room id available for danmaku', async () => {
    const result = await resolveDouyu('9999', deps({ fetchJson: async () => { throw new Error('Cookie: secret https://private.invalid/?token=secret') } }))
    expect(!result.ok && result.failure.code).toBe('upstream-error')
    expect(!result.ok && result.failure.hint).toContain('9999')
    expect(JSON.stringify(result)).not.toMatch(/secret|private.invalid/)
  })

  it('rejects invalid room, quality and cookie headers before HTTP', async () => {
    for (const [room, overrides] of [['bad', {}], ['9999', { quality: '4; injected' }], ['9999', { douyuCookie: 'auth=bad\r\nInjected: x' }]] as const) {
      const fetchJson = vi.fn()
      expect((await resolveDouyu(room, deps({ ...overrides, fetchJson }))).ok).toBe(false)
      expect(fetchJson).not.toHaveBeenCalled()
    }
  })

  it('keeps missing video URLs structured instead of inventing a playable URL', async () => {
    const result = await resolveDouyu('9999', deps({ fetchJson: async (url) => url.includes('getEncryption') ? { error: 0, data: encryption } : { error: 0, data: {} } }))
    expect(!result.ok && result.failure.code).toBe('needs-manual-url')
  })
})

describe('Douyu multirates and direct FLV', () => {
  it('deduplicates and validates rates without inferring dimensions from names', () => {
    expect(parseDouyuQualities([...multirates, multirates[0], { rate: -1 }, { rate: '4' }, { rate: 1, name: '  \r\n' }])).toEqual([
      { id: '0', label: '原画2K60' }, { id: '4', label: '蓝光4M' }, { id: '3', label: '超清' }, { id: '2', label: '高清' }, { id: '1', label: '画质 1' },
    ])
    expect(parseDouyuQualities(null)).toEqual([])
  })

  it('recognizes a direct FLV as a progressive ffmpeg input', async () => {
    const url = 'https://media.example.invalid/live.flv?signature=fixture'
    expect(looksLikeDirectMedia(url)).toBe(true)
    expect(detectPlatform(url)).toBe('direct')
    const result = await resolveStream(url, deps())
    expect(result.ok && result.stream.kind).toBe('progressive')
  })
})
