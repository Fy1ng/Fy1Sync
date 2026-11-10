import { describe, expect, it } from 'vitest'
import {
  BASIC_CLOCK_MEMORY_LIMIT, basicClockFileKey, basicClockSourceKey, findBasicClockMemory,
  forgetBasicClockMemory, normalizeBasicClockMemory, rememberBasicClock, type BasicClockMemoryEntry,
} from './basicClockMemory'
import type { MediaDescriptor } from './types'

function source(input: string, extra: Partial<MediaDescriptor> = {}): MediaDescriptor {
  return { kind: 'progressive', url: 'app://app/media/temporary-id', input, label: '测试', viaProxy: true, loop: false, ...extra }
}
const roi = { x: .42, y: .04, w: .16, h: .13 }
function entry(id = 'one', updatedAt = 1000, aspectRatio = 16 / 9): BasicClockMemoryEntry {
  return { key: basicClockSourceKey(source(`https://example.test/${id}.mp4`, { platform: 'direct' }))!, roi: { ...roi }, aspectRatio, updatedAt }
}

describe('clock memory source identity', () => {
  it('uses the YouTube video identity across page forms, quality changes and transient playback URLs', () => {
    const first = basicClockSourceKey(source('https://www.youtube.com/watch?v=swMquqtyh-A&utm_source=test', { platform: 'youtube', sourceQuality: '2160p' }))
    for (const input of ['https://youtu.be/swMquqtyh-A?si=tracking', 'https://www.youtube.com/live/swMquqtyh-A', 'youtube.com/embed/swMquqtyh-A']) {
      expect(basicClockSourceKey(source(input, { platform: 'youtube', url: 'https://cdn.test/new?token=secret', sourceQuality: '1080p' }))).toBe(first)
    }
    expect(basicClockSourceKey(source('https://youtube.com/watch?v=another-id', { platform: 'youtube' }))).not.toBe(first)
    expect(first).toMatch(/^clock-v1:youtube:[a-f0-9]{16}$/)
    expect(basicClockSourceKey(source('https://youtube.com/channel', { platform: 'youtube' }))).toBeNull()
  })

  it('isolates confirmed rooms and platforms while accepting page and short room input forms', () => {
    const confirmed = basicClockSourceKey(source('https://www.douyu.com/6657', { platform: 'douyu', sourceRoom: '6979222' }))
    expect(basicClockSourceKey(source('6979222', { platform: 'douyu' }))).toBe(confirmed)
    expect(basicClockSourceKey(source('', { platform: 'douyu', sourceRoom: '6979222' }))).toBe(confirmed)
    expect(basicClockSourceKey(source('https://www.douyu.com/topic/event?rid=6979222'))).toBe(confirmed)
    expect(basicClockSourceKey(source('https://www.huya.com/6979222', { platform: 'huya' }))).not.toBe(confirmed)
    expect(basicClockSourceKey(source('6979223', { platform: 'douyu' }))).not.toBe(confirmed)
    expect(basicClockSourceKey(source('https://www.twitch.tv/PGL_CS2?referrer=test', { platform: 'twitch' })))
      .toBe(basicClockSourceKey(source('https://twitch.tv/pgl_cs2', { platform: 'twitch', sourceQuality: 'low' })))
    expect(basicClockSourceKey(source('https://twitch.tv/pgl_cs2/clip/AbCd', { platform: 'twitch' })))
      .not.toBe(basicClockSourceKey(source('https://twitch.tv/pgl_cs2/clip/abcd', { platform: 'twitch' })))
    expect(basicClockSourceKey(source('https://live.bilibili.com/21452505?from=test', { platform: 'bilibili' })))
      .toBe(basicClockSourceKey(source('21452505', { platform: 'bilibili' })))
  })

  it('keeps direct stream-selecting query parameters without persisting their text or credentials', () => {
    const first = basicClockSourceKey(source('https://viewer:password@example.test/live.m3u8?channel=one&token=private', { platform: 'direct' }))
    expect(first).not.toBe(basicClockSourceKey(source('https://viewer:password@example.test/live.m3u8?channel=two&token=private', { platform: 'direct' })))
    for (const secret of ['viewer', 'password', 'example.test', 'channel', 'private']) expect(first).not.toContain(secret)
    expect(first!.length).toBeLessThanOrEqual(96)
    expect(basicClockSourceKey(source('/test-sources/auto-official.mp4'))).toBe(basicClockSourceKey(source('/test-sources/auto-official.mp4', { url: 'app://app/new' })))
    expect(basicClockSourceKey(source('/test-sources/../private.mp4'))).toBeNull()
  })

  it('keys files from metadata across blob lifetimes and refuses filename-only fallback', () => {
    const metadata = { name: '赛事录像.mkv', size: 123456, lastModified: 1720000000000 }
    const key = basicClockFileKey(metadata)
    const first = source(metadata.name, { kind: 'file', platform: 'file', recognitionSourceKey: key, url: 'blob:app://app/first' })
    expect(basicClockSourceKey(first)).toBe(key)
    expect(basicClockSourceKey({ ...first, url: 'blob:app://app/restarted', recognitionSourceKey: basicClockFileKey({ ...metadata }) })).toBe(key)
    expect(basicClockFileKey({ ...metadata, size: metadata.size + 1 })).not.toBe(key)
    expect(basicClockFileKey({ ...metadata, lastModified: metadata.lastModified + 1 })).not.toBe(key)
    expect(basicClockSourceKey({ ...first, recognitionSourceKey: undefined })).toBeNull()
    expect(basicClockSourceKey({ ...first, recognitionSourceKey: metadata.name })).toBeNull()
    expect(key).not.toContain(metadata.name)
    expect(basicClockSourceKey(source('blob:app://app/first'))).toBeNull()
    expect(basicClockSourceKey(source('display label only'))).toBeNull()
    expect(basicClockSourceKey(null)).toBeNull()
  })
})

describe('bounded clock region memory', () => {
  it('normalizes, clones and orders valid entries while dropping malformed or secret-bearing data', () => {
    const old = entry('one', 1), current = entry('one', 4), other = entry('two', 3)
    const throwing = Object.defineProperty({}, 'key', { get() { throw new Error('bad input') } })
    const invalid = [null, [], 'region', throwing, { ...old, key: 'https://secret.test/token' }, { ...old, aspectRatio: NaN },
      { ...old, aspectRatio: 0 }, { ...old, updatedAt: Infinity }, { ...old, updatedAt: -1 },
      { ...old, roi: { ...roi, w: 0 } }, { ...old, roi: { ...roi, x: .99 } }, { ...old, roi: { ...roi, h: 'small' } }]
    const normalized = normalizeBasicClockMemory([old, ...invalid, other, current])
    expect(normalized).toEqual([current, other])
    normalized[0]!.roi.x = 0
    expect(current.roi.x).toBe(.42)
    for (const raw of [undefined, null, {}, 'cache']) expect(normalizeBasicClockMemory(raw)).toEqual([])
  })

  it('reuses the same frame shape across resolutions and isolates incompatible layouts', () => {
    const wide = entry(), square = entry('one', 1001, 4 / 3)
    const entries = [wide, square]
    expect(findBasicClockMemory(entries, wide.key, 3840, 2160)).toBe(wide)
    expect(findBasicClockMemory(entries, wide.key, 1280, 720)).toBe(wide)
    expect(findBasicClockMemory(entries, wide.key, 800, 600)).toBe(square)
    expect(findBasicClockMemory([wide], wide.key, 800, 600)).toBeNull()
    expect(findBasicClockMemory(entries, entry('other').key, 1920, 1080)).toBeNull()
    for (const [width, height] of [[0, 1080], [1920, 0], [-1, 1], [Infinity, 1], [NaN, 1]]) {
      expect(findBasicClockMemory(entries, wide.key, width!, height!)).toBeNull()
    }
  })

  it('avoids writes for unchanged geometry and ignores older observations', () => {
    const first = entry()
    const entries = [first]
    expect(rememberBasicClock(entries, { ...first, updatedAt: 2000 })).toBe(entries)
    expect(rememberBasicClock(entries, { ...first, aspectRatio: first.aspectRatio + .001, updatedAt: 2000 })).toBe(entries)
    expect(rememberBasicClock(entries, { ...first, roi: { ...roi, x: .4 }, updatedAt: 999 })).toBe(entries)
    const updated = rememberBasicClock(entries, { ...first, roi: { ...roi, x: .4 }, updatedAt: 2000 })
    expect(updated).not.toBe(entries)
    expect(updated[0]).toMatchObject({ updatedAt: 2000, roi: { x: .4 } })
    expect(entries[0]!.roi.x).toBe(.42)
  })

  it('evicts the oldest regions without merging another source or aspect ratio', () => {
    let entries: BasicClockMemoryEntry[] = []
    for (let index = 0; index < 80; index++) entries = rememberBasicClock(entries, entry(String(index), index))
    expect(entries).toHaveLength(BASIC_CLOCK_MEMORY_LIMIT)
    expect(entries[0]!.updatedAt).toBe(79)
    expect(entries.at(-1)!.updatedAt).toBe(16)
    const newest = entries[0]!
    entries = rememberBasicClock(entries, { ...newest, aspectRatio: 4 / 3, updatedAt: 100 })
    expect(entries.filter(value => value.key === newest.key)).toHaveLength(2)
    expect(normalizeBasicClockMemory(Array.from({ length: 80 }, (_, index) => entry(String(index), index)))).toHaveLength(64)
  })

  it('forgets only explicitly selected source/layout memories and preserves no-op identity', () => {
    const wide = entry(), square = entry('one', 1001, 4 / 3), peer = entry('peer')
    const entries = [wide, square, peer]
    expect(forgetBasicClockMemory(entries, null)).toBe(entries)
    expect(forgetBasicClockMemory(entries, entry('unknown').key)).toBe(entries)
    expect(forgetBasicClockMemory(entries, wide.key, 1920, 1080)).toEqual([square, peer])
    expect(forgetBasicClockMemory(entries, wide.key)).toEqual([peer])
    expect(forgetBasicClockMemory(entries, wide.key, 0, 0)).toEqual([peer])
    expect(entries).toHaveLength(3)
  })
})
