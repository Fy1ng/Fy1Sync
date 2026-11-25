import { describe, expect, it } from 'vitest'
import {
  draftFromDirectOptions,
  EMPTY_DIRECT_DRAFT,
  parseDirectDraft,
  validateDirectHeaders,
  validateDirectOptions,
} from './directStream'
import { parseDanmakuRoomInput } from './sourceDanmaku'

describe('directStream options and draft validation', () => {
  it('returns undefined options for an empty draft', () => {
    expect(parseDirectDraft({ ...EMPTY_DIRECT_DRAFT })).toEqual({ ok: true })
  })

  it('parses label, Referer, User-Agent, and custom header lines', () => {
    const parsed = parseDirectDraft({
      label: '  主舞台原画  ',
      referer: 'https://live.example.com/',
      userAgent: 'CustomPlayer/1.0',
      customHeaders: 'Origin: https://live.example.com\nX-Stream-Token: token-123\n',
    })
    expect(parsed).toEqual({
      ok: true,
      options: {
        label: '主舞台原画',
        headers: {
          Referer: 'https://live.example.com/',
          'User-Agent': 'CustomPlayer/1.0',
          Origin: 'https://live.example.com',
          'X-Stream-Token': 'token-123',
        },
      },
    })
    if (parsed.ok) {
      expect(draftFromDirectOptions(parsed.options)).toEqual({
        label: '主舞台原画',
        referer: 'https://live.example.com/',
        userAgent: 'CustomPlayer/1.0',
        customHeaders: 'Origin: https://live.example.com\nX-Stream-Token: token-123',
      })
    }
  })

  it('rejects duplicate headers, forbidden headers, and malformed lines', () => {
    expect(parseDirectDraft({
      ...EMPTY_DIRECT_DRAFT,
      referer: 'https://a.example/',
      customHeaders: 'referer: https://b.example/',
    })).toMatchObject({ ok: false })

    expect(parseDirectDraft({
      ...EMPTY_DIRECT_DRAFT,
      customHeaders: 'Host: evil.example',
    })).toMatchObject({ ok: false })

    expect(parseDirectDraft({
      ...EMPTY_DIRECT_DRAFT,
      customHeaders: 'MissingColonLine',
    })).toMatchObject({ ok: false })

    expect(parseDirectDraft({
      ...EMPTY_DIRECT_DRAFT,
      label: 'bad\nlabel',
    })).toMatchObject({ ok: false })
  })

  it('validates IPC objects strictly and rejects CRLF or accessor properties', () => {
    expect(validateDirectOptions(undefined)).toBeUndefined()
    expect(validateDirectOptions({})).toBeUndefined()
    expect(validateDirectOptions({ label: '测试源', headers: { Referer: 'https://example.com/' } })).toEqual({
      label: '测试源',
      headers: { Referer: 'https://example.com/' },
    })
    expect(validateDirectOptions({ extra: 1 })).toBeNull()
    expect(validateDirectHeaders({ Referer: 'https://example.com/\r\nInjected: 1' })).toBeNull()
    expect(validateDirectHeaders({ Host: 'example.com' })).toBeNull()

    const withGetter = {}
    Object.defineProperty(withGetter, 'Referer', { enumerable: true, get: () => 'https://example.com/' })
    expect(validateDirectHeaders(withGetter)).toBeNull()
  })
})

describe('parseDanmakuRoomInput', () => {
  it('supports bare numbers across all four danmaku platforms while keeping Douyu unprefixed', () => {
    expect(parseDanmakuRoomInput('6657', 'douyu')).toEqual({ key: '6657', name: '6657', platform: 'douyu' })
    expect(parseDanmakuRoomInput('21470454', 'bilibili')).toEqual({ key: 'bilibili:21470454', name: '21470454', platform: 'bilibili' })
    expect(parseDanmakuRoomInput('660000', 'huya')).toEqual({ key: 'huya:660000', name: '660000', platform: 'huya' })
    expect(parseDanmakuRoomInput('123456789', 'douyin')).toEqual({ key: 'douyin:123456789', name: '123456789', platform: 'douyin' })
  })

  it('parses full room URLs and platform prefixes regardless of fallback platform', () => {
    expect(parseDanmakuRoomInput('https://live.bilibili.com/21470454', 'douyu')).toEqual({
      key: 'bilibili:21470454',
      name: '21470454',
      platform: 'bilibili',
    })
    expect(parseDanmakuRoomInput('https://www.huya.com/kpl', 'douyu')).toEqual({
      key: 'huya:kpl',
      name: 'kpl',
      platform: 'huya',
    })
    expect(parseDanmakuRoomInput('https://live.douyin.com/987654321', 'douyu')).toEqual({
      key: 'douyin:987654321',
      name: '987654321',
      platform: 'douyin',
    })
    expect(parseDanmakuRoomInput('https://www.douyu.com/6657', 'bilibili')).toEqual({
      key: '6657',
      name: '6657',
      platform: 'douyu',
    })
    expect(parseDanmakuRoomInput('bili:100', 'douyu')).toEqual({
      key: 'bilibili:100',
      name: '100',
      platform: 'bilibili',
    })
    expect(parseDanmakuRoomInput('https://www.douyu.com/dyshow', 'douyu')).toEqual({
      key: 'dyshow',
      name: 'dyshow',
      platform: 'douyu',
      douyuLookup: 'https://www.douyu.com/dyshow',
    })
  })
})
