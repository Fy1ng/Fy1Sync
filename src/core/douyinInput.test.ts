import { describe, expect, it } from 'vitest'
import { parseDouyinInput } from './douyinInput'

describe('Douyin public input validation', () => {
  it.each(['1', '12345678901234567890'])('normalizes a bare web room without losing digit precision: %s', room => {
    expect(parseDouyinInput(room)).toEqual({ kind: 'room', room, url: `https://live.douyin.com/${room}` })
  })

  it('normalizes web rooms to HTTPS and removes tracking', () => {
    expect(parseDouyinInput(' http://live.douyin.com:80/12345/?from=share#live ')).toEqual({
      kind: 'room', room: '12345', url: 'https://live.douyin.com/12345',
    })
    expect(parseDouyinInput('live.douyin.com/12345')).toMatchObject({ kind: 'room', room: '12345' })
  })

  it('extracts a single short share link from a caption and trims closing punctuation', () => {
    expect(parseDouyinInput('3.14 主播正在直播, 打开抖音观看 (https://v.douyin.com/aB12C3/)。')).toEqual({
      kind: 'share', url: 'https://v.douyin.com/aB12C3/',
    })
    expect(parseDouyinInput('直播分享: https://v.douyin.com/aB12C3/?share_id=123&from=copy；')).toEqual({
      kind: 'share', url: 'https://v.douyin.com/aB12C3/?share_id=123',
    })
  })

  it('keeps the distinct reflow room id and only the required share context', () => {
    expect(parseDouyinInput('https://webcast.amemv.com/webcast/reflow/7123456789012345678?sec_user_id=MS4wLjABAAAA_test&app_id=1128&live_id=1&from=share')).toEqual({
      kind: 'reflow', room: '7123456789012345678',
      url: 'https://webcast.amemv.com/webcast/reflow/7123456789012345678?sec_user_id=MS4wLjABAAAA_test&app_id=1128&live_id=1',
    })
    expect(parseDouyinInput('https://webcast.amemv.com/webcast/reflow/7123456789012345678')).toMatchObject({ kind: 'reflow' })
  })

  it('accepts the public short-link reflow destination with its Douyin path prefix', () => {
    expect(parseDouyinInput('https://webcast.amemv.com/douyin/webcast/reflow/7123456789012345678?sec_user_id=MS4wLjABAAAA_test&from=share')).toEqual({
      kind: 'reflow', room: '7123456789012345678',
      url: 'https://webcast.amemv.com/douyin/webcast/reflow/7123456789012345678?sec_user_id=MS4wLjABAAAA_test',
    })
    expect(parseDouyinInput('直播分享: http://webcast.amemv.com/douyin/webcast/reflow/7123456789012345678/。')).toEqual({
      kind: 'reflow', room: '7123456789012345678',
      url: 'https://webcast.amemv.com/douyin/webcast/reflow/7123456789012345678/',
    })
  })

  it.each([
    '/fake/webcast/reflow/7123456789012345678',
    '/douyin/fake/webcast/reflow/7123456789012345678',
    '/douyin/douyin/webcast/reflow/7123456789012345678',
    '/douyin/webcast/reflow/7123456789012345678/extra',
    '/douyin/webcast/reflow/0123456789012345678',
    '/douyin/webcast/reflow/712345678901234567890',
    '/douyin%2Fwebcast/reflow/7123456789012345678',
  ])('rejects a forged or invalid prefixed reflow path: %s', path => {
    expect(parseDouyinInput(`https://webcast.amemv.com${path}`)).toBeNull()
  })

  it.each([
    '', '0', '0123', '123456789012345678901', '抖音号 12345',
    'https://live.douyin.com/', 'https://live.douyin.com/123/extra',
    'https://live.douyin.com/0123', 'https://live.douyin.com/123%2F456',
    'https://www.douyin.com/user/12345', 'https://www.douyin.com/12345',
    'https://v.douyin.com/a-b/', 'https://v.douyin.com/a/b',
    'https://webcast.amemv.com/webcast/reflow/0123',
    'https://webcast.amemv.com/webcast/reflow/123/extra',
    'ftp://live.douyin.com/123', 'javascript:https://v.douyin.com/abc/',
    'https://user:password@live.douyin.com/123', 'https://live.douyin.com:8443/123',
    'https://live.douyin.com.evil.example/123', 'https://www.live.douyin.com/123',
    'https://evil.example/live.douyin.com/123', 'https://live.douyin.com\\@evil.example/123',
    'https://live.douyin.com/12\n3', '\thttps://v.douyin.com/abc/',
    'https://v.douyin.com/abc/?sec_user_id=%0A',
    'https://v.douyin.com/abc/?share_id=1&share_id=2',
    'https://v.douyin.com/abc/?sec_user_id=https%3A%2F%2Fevil.example',
    'https://v.douyin.com/abc/?sec_user_id=https%253A%252F%252Fevil.example',
    'https://v.douyin.com/abc/ https://live.douyin.com/123',
    'https://v.douyin.com/abc/?from=share,https://v.douyin.com/def/',
    'https://v.douyin.com/abc/?from=share,v.douyin.com/def/',
    '分享 https://v.douyin.com/abc/ 与 https://example.com/',
    'https://v.douyin.com/' + 'a'.repeat(64) + '?from=' + 'x'.repeat(8192),
  ])('rejects ambiguous, non-room, or unsafe input: %s', input => {
    expect(parseDouyinInput(input)).toBeNull()
  })

  it('removes unneeded redirect parameters rather than forwarding nested targets', () => {
    expect(parseDouyinInput('https://v.douyin.com/abc/?redirect=https%3A%2F%2Fevil.example&share_id=123')).toEqual({
      kind: 'share', url: 'https://v.douyin.com/abc/?share_id=123',
    })
  })
})
