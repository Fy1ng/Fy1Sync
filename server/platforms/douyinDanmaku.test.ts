import { describe, expect, it, vi } from 'vitest'
import { DouyinSigner } from '../danmaku/douyinSigner'
import { douyinProtoField as field } from '../danmaku/douyinProtocol'
import { joinDouyinBytes as join, syntheticDouyinIds as ids, syntheticDouyinPage, syntheticDouyinResponse } from '../danmaku/fixtures/douyin-synthetic'
import { createDouyinDanmakuResolver, DOUYIN_USER_AGENT, douyinWebSocketRequest, resolveDouyinDanmakuRoom, validateDouyinPushServer, type DouyinDanmakuResolverDeps } from './douyinDanmaku'

const deps = (overrides: Partial<DouyinDanmakuResolverDeps> = {}): DouyinDanmakuResolverDeps => ({ fetchPage: vi.fn(async (url: string) => ({ text: syntheticDouyinPage(), finalUrl: url, setCookie: ['ttwid=synthetic-anonymous; Path=/; Secure', 'UIFID_TEMP=synthetic-other'] })),
  fetchBytes: vi.fn(async () => syntheticDouyinResponse([])), fetchJson: vi.fn(), ...overrides })

describe('main-only Douyin chat session resolver', () => {
  it('resolves current string room IDs and dynamic IM state without a signing service', async () => {
    const context = deps()
    const result = await createDouyinDanmakuResolver(context)(ids.webRoom)
    expect(result).toEqual({ ...ids, messageId: undefined, logId: undefined, cookie: 'ttwid=synthetic-anonymous', userAgent: DOUYIN_USER_AGENT,
      cursor: 'synthetic-cursor', internalExt: 'synthetic-internal', pushServer: 'wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/', heartbeatMs: 15000 })
    const [raw, init] = vi.mocked(context.fetchBytes!).mock.calls[0]!
    const url = new URL(raw)
    expect(url.pathname).toBe('/webcast/im/fetch/')
    expect(url.searchParams.get('room_id')).toBe(ids.roomId)
    expect(url.searchParams.get('user_unique_id')).toBe(ids.userUniqueId)
    expect(url.searchParams.has('a_bogus')).toBe(false)
    expect(init?.headers).toMatchObject({ Cookie: 'ttwid=synthetic-anonymous' })
    expect(context.fetchJson).not.toHaveBeenCalled()
  })
  it('uses an optional logged-in HTTP cookie only on exact page/API paths and limits WS cookies to ttwid', async () => {
    const cookieHeader = vi.fn(async (url: string) => url.includes('/webcast/im/fetch/')
      ? 'sessionid=synthetic-api; ttwid=synthetic-old' : 'sessionid=synthetic-page; ttwid=synthetic-old')
    const context = deps({ cookieHeader })
    const result = await resolveDouyinDanmakuRoom('100', context)
    expect(vi.mocked(context.fetchPage!).mock.calls[0]![1]?.headers).toMatchObject({ Cookie: 'sessionid=synthetic-page; ttwid=synthetic-old' })
    expect(vi.mocked(context.fetchBytes!).mock.calls[0]![1]?.headers).toMatchObject({ Cookie: 'sessionid=synthetic-api; ttwid=synthetic-anonymous' })
    expect(cookieHeader).toHaveBeenCalledTimes(2)
    expect(cookieHeader.mock.calls[0]![0]).toBe('https://live.douyin.com/100')
    expect(cookieHeader.mock.calls[1]![0]).toMatch(/^https:\/\/live\.douyin\.com\/webcast\/im\/fetch\//)
    const request = douyinWebSocketRequest(result, new DouyinSigner(() => 1))
    expect(request.headers).toMatchObject({ Cookie: 'ttwid=synthetic-anonymous', Origin: 'https://live.douyin.com' })
    expect(JSON.stringify(request)).not.toContain('sessionid')
    expect(new URL(request.url).searchParams.get('signature')).toHaveLength(16)
  })
  it('obtains a fresh anonymous cookie if the live page did not set one', async () => {
    const context = deps({ fetchPage: vi.fn(async (url: string) => ({ text: syntheticDouyinPage(), finalUrl: url,
      setCookie: url.includes('ttwid.bytedance.com') ? ['ttwid=registered-anonymous'] : [] })) })
    expect((await resolveDouyinDanmakuRoom('100', context)).cookie).toBe('ttwid=registered-anonymous')
    expect(vi.mocked(context.fetchPage!).mock.calls[1]![0]).toBe('https://ttwid.bytedance.com/ttwid/union/register/')
    expect(vi.mocked(context.fetchPage!).mock.calls[1]![1]).toMatchObject({ method: 'POST' })
  })
  it('rejects invalid rooms, conflicting page identities, offsite redirects and empty IM responses', async () => {
    await expect(resolveDouyinDanmakuRoom('100\r\nCookie:x', deps())).rejects.toThrow()
    await expect(resolveDouyinDanmakuRoom('100', deps({ cookieHeader: async () => 'x\r\nInjected:1' }))).rejects.toThrow()
    await expect(resolveDouyinDanmakuRoom('100', deps({ fetchPage: async () => ({ text: syntheticDouyinPage(), finalUrl: 'https://evil.invalid/100', setCookie: [] }) }))).rejects.toThrow()
    await expect(resolveDouyinDanmakuRoom('100', deps({ fetchPage: async url => ({ text: syntheticDouyinPage() + '<script>{"user_unique_id":"999"}</script>', finalUrl: url, setCookie: [] }) }))).rejects.toThrow()
    await expect(resolveDouyinDanmakuRoom('100', deps({ fetchBytes: async () => new Uint8Array() }))).rejects.toThrow()
  })
  it('rejects missing IM route state and untrusted dynamic endpoints', async () => {
    await expect(resolveDouyinDanmakuRoom('100', deps({ fetchBytes: async () => field(14, 'wss://evil.invalid/') }))).rejects.toThrow()
    await expect(resolveDouyinDanmakuRoom('100', deps({ fetchBytes: async () => join(field(2, 'cursor'), field(5, 'internal'), field(14, 'wss://evil.invalid/')) }))).rejects.toThrow()
    for (const value of ['ws://webcast100-ws-web-hl.douyin.com/', 'wss://webcast100-ws-web-hl.douyin.com.evil.invalid/', 'wss://evil@webcast100-ws-web-hl.douyin.com/', 'wss://webcast100-ws-web-hl.douyin.com:8080/', 'wss://webcast100-ws-web-hl.douyin.com/other', 'wss://webcast100-ws-web-hl.douyin.com/?x=1']) expect(() => validateDouyinPushServer(value)).toThrow()
    expect(validateDouyinPushServer('https://webcast100-ws-web-hl.douyin.com/')).toBe('wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/')
  })
})
