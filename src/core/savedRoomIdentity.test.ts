import { describe, expect, it } from 'vitest'
import { savedRoomInput, savedRoomKey } from './savedRoomIdentity'

describe('favorite room identities', () => {
  it('normalizes bare room identifiers for each selected platform', () => {
    expect(savedRoomInput('bilibili', '123')).toBe('https://live.bilibili.com/123')
    expect(savedRoomInput('douyin', '抖音:123')).toBe('https://live.douyin.com/123')
    expect(savedRoomInput('huya', 'huya123')).toBe('https://www.huya.com/huya123')
    expect(savedRoomInput('huya', 'huya:123')).toBe('https://www.huya.com/123')
  })

  it('preserves case-sensitive YouTube video and channel ids while normalizing handles', () => {
    expect(savedRoomKey('youtube', 'https://youtu.be/ABC123abcDE')).toBe(savedRoomKey('youtube', 'https://www.youtube.com/watch?v=ABC123abcDE&from=test'))
    expect(savedRoomKey('youtube', 'https://www.youtube.com/channel/UCABCdef/live')).not.toBe(savedRoomKey('youtube', 'https://www.youtube.com/channel/UCabcDEF/live'))
    expect(savedRoomKey('youtube', 'https://www.youtube.com/@PGL/live')).toBe(savedRoomKey('youtube', 'https://www.youtube.com/@pgl'))
  })
})
