/** Finding the channel behind a Liquipedia stream entry among an event page's links. */
import { describe, expect, it } from 'vitest'
import { channelFromLink, channelLinksUrl, eventChannels, matchChannel, type StreamChannel } from './streamChannels'

const twitch = (name: string): StreamChannel => ({ platform: 'twitch', name, url: `https://www.twitch.tv/${name}` })
/** The links the real PGL Masters Bucharest 2026 page gave on 2026-11-01, a few VODs and Kick kept as noise. */
const pglPage = { batchcomplete: true, query: { pages: [{ pageid: 1, ns: 0, title: 'PGL/2026/Masters', extlinks: [
  'https://www.twitch.tv/PGL', 'https://www.youtube.com/PGL', 'https://www.kick.com/PGL', 'https://kick.com/PGL',
  'https://www.twitch.tv/cs2_maincast', 'https://www.youtube.com/@cs2_maincast/live', 'https://www.twitch.tv/pgl_cs2',
  'https://www.youtube.com/PGL/streams', 'https://youtu.be/YcBD2QIKQAI?t=25', 'https://www.youtube.com/watch?v=6PbaO0zFSks',
  'https://www.twitch.tv/videos/123456', 'https://liquipedia.net/counterstrike/PGL', 'https://clips.twitch.tv/SlickClip',
].map(url => ({ url })) }] } }

describe('channel links', () => {
  it('asks one plain query for a page\'s external links', () => {
    const url = new URL(channelLinksUrl('Gamers_Club/Masters/VII'))
    expect(url.origin + url.pathname).toBe('https://liquipedia.net/counterstrike/api.php')
    expect(Object.fromEntries(url.searchParams)).toEqual({ action: 'query', format: 'json', formatversion: '2', prop: 'extlinks',
      ellimit: 'max', redirects: '1', titles: 'Gamers_Club/Masters/VII' })
  })

  it('keeps channel pages only, once each, and drops videos, clips and other sites', () => {
    expect(eventChannels(pglPage)).toEqual({
      twitch: [twitch('pgl'), twitch('cs2_maincast'), twitch('pgl_cs2')],
      youtube: [{ platform: 'youtube', name: 'PGL', url: 'https://www.youtube.com/PGL/live' },
        { platform: 'youtube', name: '@cs2_maincast', url: 'https://www.youtube.com/@cs2_maincast/live' }],
    })
  })

  it.each([
    ['https://m.twitch.tv/GamersClubCS/videos', twitch('gamersclubcs')],
    ['https://www.youtube.com/channel/UCu3pz0wE4Gb5u_7SPyHNTDQ', { platform: 'youtube', name: 'UCu3pz0wE4Gb5u_7SPyHNTDQ', url: 'https://www.youtube.com/channel/UCu3pz0wE4Gb5u_7SPyHNTDQ/live' }],
    ['https://youtube.com/c/BLASTPremier/featured', { platform: 'youtube', name: 'BLASTPremier', url: 'https://www.youtube.com/c/BLASTPremier/live' }],
  ])('reads %s as a channel', (link, channel) => {
    expect(channelFromLink(link)).toEqual(channel)
  })

  it.each(['https://www.twitch.tv/directory', 'https://www.youtube.com/live/abcdefghijk', 'https://www.youtube.com/feed',
    'https://twitch.tv.evil.example/pgl', 'ftp://www.twitch.tv/pgl', 'not a link'])('refuses %s', (link) => {
    expect(channelFromLink(link)).toBeNull()
  })

  it('reads a missing page as no channels and refuses anything that is not a page listing', () => {
    expect(eventChannels({ query: { pages: [{ ns: 0, title: 'Nowhere', missing: true }] } })).toEqual({ twitch: [], youtube: [] })
    expect(() => eventChannels({ error: { code: 'badvalue' } })).toThrow()
    expect(() => eventChannels({ query: { pages: [{ extlinks: 'x' }] } })).toThrow()
    expect(() => eventChannels(null)).toThrow()
  })
})

describe('pairing an entry with a channel', () => {
  const pgl = eventChannels(pglPage).twitch

  it('takes the channel of the same name, ignoring case, spaces and punctuation', () => {
    expect(matchChannel('PGL_CS2', pgl)?.name).toBe('pgl_cs2')
    expect(matchChannel('PGL CS2', pgl)?.name).toBe('pgl_cs2')
    expect(matchChannel('PGL', pgl)?.name).toBe('pgl')
    expect(matchChannel('DFRAG TV', [twitch('dfragtv'), twitch('other')])?.name).toBe('dfragtv')
  })

  it('takes the one channel whose name contains the entry', () => {
    expect(matchChannel('Gamers_Club', [twitch('gamersclubcs'), twitch('elsewhere')])?.name).toBe('gamersclubcs')
    expect(matchChannel('BLAST', [twitch('blastpremier'), twitch('betboom_cs_ru')])?.name).toBe('blastpremier')
  })

  it('never shortens an entry to a channel inside it, and gives up when two could be meant', () => {
    expect(matchChannel('PGL 2', pgl)).toBeNull()
    expect(matchChannel('ESL', [twitch('eslcs'), twitch('eslcsb')])).toBeNull()
    expect(matchChannel('PGL_CS2', [twitch('pgl_cs2'), twitch('pglcs2')])).toBeNull()
  })

  it('falls back to the event\'s only channel, and finds nothing among none', () => {
    expect(matchChannel('MCG', [twitch('gluck_esports')])?.name).toBe('gluck_esports')
    expect(matchChannel('Anything', [])).toBeNull()
  })
})
