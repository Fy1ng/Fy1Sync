import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SavedRoomsStore } from '../../electron/savedRooms'
import { SavedRoomImages } from '../../electron/savedRoomImages'
import { resolveConfig } from '../config'
import { safeFetch } from '../safeFetch'
import { createRoomMetadataCollector } from './roomMetadata'

vi.mock('../safeFetch', () => ({ safeFetch: vi.fn() }))
const CHANNEL = 'UC1234567890123456789012'
const CHANNEL_URL = `https://www.youtube.com/channel/${CHANNEL}/live`
const WATCH_URL = 'https://www.youtube.com/watch?v=We5j4c4AcDg'
const AVATAR = 'https://yt3.ggpht.com/avatar.jpg'
const NOW = Date.parse('2026-11-15T00:00:00Z')
const html = (name: string, value: unknown) => `<script>var ${name} = ${JSON.stringify(value)};document.createElement('meta');</script>`
const roots: string[] = []
afterEach(() => {
  vi.resetAllMocks()
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('youtube-metadata-')) throw new Error('Invalid test root')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function fixture(pages: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-metadata-'))
  roots.push(root)
  vi.mocked(safeFetch).mockImplementation(async url => {
    if (url === AVATAR) return { finalUrl: new URL(url), response: new Response(new Uint8Array([255, 216, 255, 224, 0, 0])) }
    if (!Object.hasOwn(pages, url)) throw new Error('Unexpected request')
    return { finalUrl: new URL(url), response: new Response(pages[url]) }
  })
  const collect = createRoomMetadataCollector({ proxy: resolveConfig({}).proxy, userDataDir: root,
    resolveRoom: async () => { throw new Error('Unexpected Douyu lookup') }, now: () => NOW })
  return { root, collect }
}

describe('YouTube favorite metadata collection', () => {
  it('normalizes a video ID, caches its avatar locally and persists the collected snapshot across restart', async () => {
    const page = html('ytInitialPlayerResponse', { videoDetails: { channelId: CHANNEL, isLiveContent: true, author: '频道甲', title: '当前直播' },
      microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true, startTimestamp: '2026-11-14T23:00:00Z' } } } })
      + html('ytInitialData', { contents: { twoColumnWatchNextResults: { results: { results: { videoSecondaryInfoRenderer: {
        owner: { videoOwnerRenderer: { thumbnail: { thumbnails: [{ url: AVATAR }] } } },
      } } } } } })
    const f = fixture({ [WATCH_URL]: page })
    const store = new SavedRoomsStore(f.root)
    const room = store.save({ platform: 'youtube', input: 'We5j4c4AcDg', label: 'YouTube', role: 'official' })
    const result = await f.collect(room, AbortSignal.timeout(1000))
    expect(result).toMatchObject({ roomId: CHANNEL, url: CHANNEL_URL, nickname: '频道甲', title: '当前直播', status: 'live', lastStartedAt: NOW - 3_600_000 })
    expect(result.avatarUrl).toMatch(/^\/room-image\/[a-f0-9]{64}\.jpg$/)
    expect(new SavedRoomImages(f.root).response(new Request(`https://local.test${result.avatarUrl}`)).status).toBe(200)
    store.recordAttempt(room.id, NOW, result)
    expect(new SavedRoomsStore(f.root).list()[0]?.metadata).toEqual(result)
    expect(vi.mocked(safeFetch).mock.calls.map(call => call[0])).toEqual([WATCH_URL, AVATAR])
    expect(vi.mocked(safeFetch).mock.calls.every(call => !call[2]?.headers?.Cookie)).toBe(true)
  })

  it('refreshes a saved channel through the modern streams tab when its live landing page has no player', async () => {
    const streams = CHANNEL_URL.replace(/\/live$/, '/streams')
    const pages = { [CHANNEL_URL]: '<html>No player on this page</html>', [streams]: html('ytInitialData', {
      metadata: { channelMetadataRenderer: { externalId: CHANNEL, title: '频道甲', avatar: { thumbnails: [{ url: AVATAR }] } } },
      contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true,
        endpoint: { commandMetadata: { webCommandMetadata: { url: '/@test/streams' } } }, content: { richGridRenderer: { contents: [{
          richItemRenderer: { content: { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
            metadata: { lockupMetadataViewModel: { title: { content: '当前直播' } } },
            contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBadgeViewModel: { badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE' } }] } },
          } } },
        }] } },
      } }] } },
    }) }
    const f = fixture(pages)
    const room = new SavedRoomsStore(f.root).save({ platform: 'youtube', input: CHANNEL_URL, label: 'YouTube', role: 'official' })
    expect(await f.collect(room, AbortSignal.timeout(1000))).toMatchObject({ nickname: '频道甲', title: '当前直播', status: 'live' })
    expect(vi.mocked(safeFetch).mock.calls.map(call => call[0])).toEqual([CHANNEL_URL, streams, AVATAR])
    pages[streams] = '<html>Request verification</html>'
    await expect(f.collect(room, AbortSignal.timeout(1000))).rejects.toThrow()
  })
})
