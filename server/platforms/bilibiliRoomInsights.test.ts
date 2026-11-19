import { afterEach, expect, it, vi } from 'vitest'
import { BilibiliRoomMetrics, bilibiliWatchEvidenceStatus, summarizeBilibiliRoom } from './bilibiliRoomInsights'
import { parseBilibiliEmotePackages, readBilibiliEmoteCatalog } from './bilibiliEmotes'
import { readBilibiliRoomIdentity } from './bilibiliWeb'
import { parseBilibiliRoomEvent, type BilibiliChatMessage, type BilibiliCountSignal } from '../danmaku/bilibiliEvents'
import { bilibiliReplay, bilibiliReplayAt as checkedAt, bilibiliReplayRoom as canonical } from '../danmaku/bilibiliReplayFixture'
import { safeFetch } from '../safeFetch'

vi.mock('../safeFetch', () => ({ safeFetch: vi.fn() }))
afterEach(() => vi.resetAllMocks())

it('keeps latest pushes per room and excludes gifts and SC from the local text count', () => {
  const room = `bilibili:${canonical}`
  const metrics = new BilibiliRoomMetrics()
  const watched = parseBilibiliRoomEvent(bilibiliReplay.watched, canonical, checkedAt) as BilibiliCountSignal
  metrics.observe(watched)
  metrics.observe({ ...watched, receivedAt: checkedAt - 1, count: 99 })
  const messages = [bilibiliReplay.text, bilibiliReplay.inline, bilibiliReplay.gift, bilibiliReplay.superChat]
    .map(raw => parseBilibiliRoomEvent(raw, canonical, checkedAt) as BilibiliChatMessage)
  messages.push({ ...messages[0]!, room: 'bilibili:123457' })
  expect(summarizeBilibiliRoom({ room, messages, rate: { receivedLastMinute: 2 }, capacity: 10_000, truncated: false, checkedAt }, metrics.read(room)))
    .toMatchObject({ messages: 2, users: 1, superChats: 1, superChatYuan: 30, metrics: { watched: { count: 1024, checkedAt } } })
  expect(metrics.read('bilibili:123457')).toEqual({})
  expect(metrics.read(room).likes).toBeUndefined()
})

function respond(body: unknown): void {
  vi.mocked(safeFetch).mockResolvedValueOnce({
    response: new Response(JSON.stringify(body)),
    finalUrl: new URL('https://api.live.bilibili.com/'),
  })
}

it('binds short rooms to the canonical room and leaves personal watch fields unknown', async () => {
  respond({ code: 0, data: { room_id: 123456, short_id: 6, uid: 111, live_status: 1, live_time: checkedAt / 1000 } })
  const identity = await readBilibiliRoomIdentity('6')
  expect(identity).toEqual({ room: canonical, anchorUid: '111', live: true, liveStartedAt: checkedAt })
  expect(bilibiliWatchEvidenceStatus(identity, 'test-slot', checkedAt)).toMatchObject({
    room: canonical, accountRef: 'test-slot', reason: 'no-verified-reader', todaySeconds: null,
    cumulativeSeconds: null, watchTaskProgress: null, liveStartedAt: checkedAt,
  })
  expect(bilibiliWatchEvidenceStatus(identity, null, checkedAt)).toMatchObject({ accountRef: null, reason: 'login-required' })
  expect(bilibiliWatchEvidenceStatus({ room: '123457', live: false }, 'other-slot', checkedAt)).toMatchObject({
    room: '123457', accountRef: 'other-slot', reason: 'session-unconfirmed', liveStartedAt: null, watchTaskProgress: null,
  })
  respond({ code: 0, data: { room_id: 123456, short_id: 7, live_status: 1 } })
  await expect(readBilibiliRoomIdentity('6')).rejects.toThrow('未返回可核对')
})

it('uses native catalog labels and assets while leaving account send permission unverified', async () => {
  const packages = [{ pkg_name: '目录', emoticons: [
    { emoticon_id: 7, emoji: '[图]', url: '//i0.hdslb.com/bfs/emote/a.png', unlock_need_level: 5 },
    { emoji: '[外链]', url: 'https://external.test/bfs/emote/a.png' },
  ] }]
  const emotes = parseBilibiliEmotePackages(packages)[0]?.emotes
  expect(emotes).toEqual([{ id: '7', text: '[图]', url: 'https://i0.hdslb.com/bfs/emote/a.png', requiredMedalLevel: 5 }])
  respond({ code: 0, data: { data: packages } })
  await expect(readBilibiliEmoteCatalog(canonical, 'test-slot', async () => 'fixture=1')).resolves.toMatchObject({
    sendPermission: 'unverified', accountRef: 'test-slot', room: canonical, packages: [{ name: '目录', emotes }],
  })
  respond({ code: -101 })
  await expect(readBilibiliEmoteCatalog(canonical, 'test-slot', async () => '')).rejects.toMatchObject({ code: 'login-required' })
  const signal = AbortSignal.abort()
  await expect(readBilibiliEmoteCatalog(canonical, 'test-slot', async () => '', signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(safeFetch).toHaveBeenCalledTimes(2)
})
