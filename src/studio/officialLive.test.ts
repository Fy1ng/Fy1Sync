/** One tap tries the CS2 channels in order and stops at the first that is live. */
import { describe, expect, it, vi } from 'vitest'
import { CS2_CHANNELS, channelLiveUrl, findLiveOfficial } from './officialLive'

describe('findLiveOfficial', () => {
  it('tries channels in order and returns the first that loads', async () => {
    const load = vi.fn(async (url: string) => url.includes('@PGL/'))
    const tried: string[] = []
    const found = await findLiveOfficial(load, (channel) => tried.push(channel.handle))
    expect(found?.handle).toBe('PGL')
    expect(tried).toEqual(['BLASTPremier', 'ESLCS', 'PGL'])
    expect(load).toHaveBeenLastCalledWith('https://www.youtube.com/@PGL/live')
  })

  it('returns null when none is live, after trying each once', async () => {
    const load = vi.fn(async () => false)
    expect(await findLiveOfficial(load)).toBeNull()
    expect(load).toHaveBeenCalledTimes(CS2_CHANNELS.length)
  })

  it('stops when cancelled', async () => {
    let calls = 0
    const found = await findLiveOfficial(async () => { calls++; return false }, () => {}, CS2_CHANNELS, () => calls >= 2)
    expect(found).toBeNull()
    expect(calls).toBe(2)
  })

  it('builds channel /live addresses the resolver accepts', () => {
    for (const channel of CS2_CHANNELS) expect(channelLiveUrl(channel)).toMatch(/^https:\/\/www\.youtube\.com\/@[\w.-]+\/live$/)
  })
})
