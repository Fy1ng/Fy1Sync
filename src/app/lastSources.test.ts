import { describe, expect, it } from 'vitest'
import { lastSource, loadLastSources, saveLastSources, LAST_SOURCES_STORAGE_KEY } from './lastSources'
import type { MediaDescriptor } from '../core/types'

const descriptor: MediaDescriptor = { platform: 'bilibili', input: '123', label: '主播', kind: 'hls',
  url: 'app://app/buffer/private-capability/index.m3u8', loop: false, viaProxy: true }
function memory() {
  let text: string | null = null
  return { getItem: () => text, setItem: (_key: string, next: string) => { text = next } }
}
describe('last loaded sources', () => {
  it('persists both role assignments and only reusable source inputs', () => {
    const storage = memory()
    const official = lastSource(descriptor)!
    const commentary = lastSource({ ...descriptor, platform: 'douyin', input: '123' })!
    saveLastSources({ official, commentary }, storage)
    expect(loadLastSources(storage)).toEqual({ official: { input: 'https://live.bilibili.com/123', platform: 'bilibili', label: '主播' },
      commentary: { input: 'https://live.douyin.com/123', platform: 'douyin', label: '主播' } })
    expect(storage.getItem()).not.toContain('private-capability')
  })

  it('reopens the broadcaster channel rather than an expired YouTube broadcast', () => {
    expect(lastSource({ ...descriptor, platform: 'youtube', input: 'https://youtu.be/abcdefghijk', sourceRoom: 'UC1234567890123456789012' })?.input)
      .toBe('https://www.youtube.com/channel/UC1234567890123456789012/live')
  })

  it('remembers shorthand inputs with their explicitly selected platform', () => {
    expect(lastSource({ ...descriptor, input: 'b 123' })?.input).toBe('https://live.bilibili.com/123')
    expect(lastSource({ ...descriptor, input: 'dy123', platform: 'douyu' })?.input).toBe('https://www.douyu.com/123')
    expect(lastSource({ ...descriptor, input: 'hy kpl', platform: 'huya' })?.input).toBe('https://www.huya.com/kpl')
  })

  it.each(['blob:app://app/test', 'app://app/buffer/capability', 'file:///C:/test.mp4', 'https://user:secret@cdn.test/a.mp4', '/media/private-capability'])('does not retain temporary or credential-bearing inputs: %s', input => {
    expect(lastSource({ ...descriptor, input, platform: 'direct' })).toBeNull()
  })

  it('does not retain local files, but accepts a reusable media URL with a custom port', () => {
    expect(lastSource({ ...descriptor, platform: 'file', kind: 'file', input: 'video.mp4' })).toBeNull()
    expect(lastSource({ ...descriptor, platform: 'direct', input: 'http://localhost:8080/live.m3u8' })?.input).toBe('http://localhost:8080/live.m3u8')
  })

  it('retains valid slots when the other slot is invalid, and tolerates corrupt storage', () => {
    const storage = memory()
    storage.setItem(LAST_SOURCES_STORAGE_KEY, JSON.stringify({ version: 1, sources: { official: lastSource(descriptor), commentary: { input: 'file:///secret', platform: 'file', label: 'bad' } } }))
    expect(loadLastSources(storage)).toEqual({ official: lastSource(descriptor) })
    storage.setItem(LAST_SOURCES_STORAGE_KEY, '{broken')
    expect(loadLastSources(storage)).toEqual({})
    expect(() => saveLastSources({}, { getItem: () => null, setItem: () => { throw new Error('quota exceeded') } })).not.toThrow()
  })
})
