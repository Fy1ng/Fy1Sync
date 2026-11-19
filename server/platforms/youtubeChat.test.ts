import { describe, expect, it, vi } from 'vitest'
import {
  readYouTubeLiveChat, youtubeVideoTarget, YOUTUBE_CHAT_WRITE_CAPABILITIES,
  type YouTubeChatEvent, type YouTubeChatReadOptions, type YouTubeChatStatus,
} from './youtubeChat'
import { YouTubeChatReplay } from './youtubeChatEvents'
import {
  youtubeChatFixture as fixture, youtubeChatFixturePages as pages, youtubeChatFixtureVideo as metadata, youtubeFixtureMessage,
} from './fixtures/youtubeChat'

const { videoId, nextVideoId, channelId, liveChatId, otherChatId, startTime, nextStartTime } = fixture
const identity = { videoId, channelId, liveChatId }
const accountRef = 'test-account'
const receivedAt = Date.parse('2026-11-19T12:01:00Z')
const body = (data: unknown, status = 200, headers?: HeadersInit) => Response.json(data, { status, headers })
const chatPage = (page: unknown, video: unknown = metadata) => [body(page), body(video)]
const error = (reason: string, status = 403, headers?: HeadersInit) => body({ error: {
  message: 'raw upstream response stays private',
  errors: [{ reason }],
} }, status, headers)

function harness(...responses: (Response | Error)[]) {
  const controller = new AbortController()
  const states: YouTubeChatStatus[] = []
  const events: YouTubeChatEvent[] = []
  const fetch = vi.fn(async (_url: URL, _init: RequestInit) => {
    const response = responses.shift()
    if (!response) throw new Error('unexpected fetch in test')
    if (response instanceof Error) throw response
    return response
  })
  const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => {})
  const run = (overrides: Partial<YouTubeChatReadOptions> = {}) => readYouTubeLiveChat({
    accountRef,
    target: { videoId, channelId },
    grant: { accountRef, accessToken: 'fake-bearer' },
    signal: controller.signal,
    onStatus: status => states.push(status),
    onEvent: event => events.push(event),
    fetch,
    wait,
    now: () => receivedAt,
    ...overrides,
  })
  return { run, fetch, wait, states, events, controller }
}

describe('YouTube API chat replay', () => {
  it('maps text, membership, currency, accessibility fallbacks, available roles and poll fields', () => {
    const replay = new YouTubeChatReplay(identity)
    const events = replay.applyPage(pages[0], receivedAt)
    expect(events.every(event => event.identity === identity)).toBe(true)
    expect(events).toMatchObject([
      { type: 'upsert', message: {
        id: 'LCC.text-1', text: '直播好看 🎉 :channel_emoji:', receivedAt,
        author: { moderator: true, member: true, owner: false, verified: false }, content: { kind: 'text' },
      } },
      { type: 'upsert', message: { text: ':legacy_emoji:', author: { name: undefined, moderator: undefined, member: undefined } } },
      { type: 'upsert', message: { text: '加油', content: {
        kind: 'super-chat', amountMicros: '9007199254740993', currency: 'TWD', amountDisplay: 'NT$75.00', tier: 2,
      } } },
      { type: 'upsert', message: { text: '鼓掌', content: { kind: 'super-sticker', stickerId: 'fixture-sticker-A' } } },
      { type: 'upsert', message: { content: { kind: 'membership', level: '银级', upgrade: false } } },
      { type: 'upsert', message: { content: { kind: 'membership-milestone', months: 6, comment: '半年了' } } },
      { type: 'upsert', message: { content: { kind: 'membership-gift', count: 3, level: '银级' } } },
      { type: 'upsert', message: { content: {
        kind: 'membership-received', giftMessageId: 'LCC.gifted-1', gifterChannelId: fixture.viewerChannelId,
      } } },
      { type: 'upsert', message: { text: '一颗星星', content: { kind: 'gift', comboCount: 0, jewels: 25 } } },
      { type: 'remove', id: 'LCC.hidden', eventId: 'LCC.hidden', reason: 'tombstone' },
      { type: 'upsert', message: { content: { kind: 'poll', status: 'active', options: [{ text: '继续', tally: undefined }, { text: '休息' }] } } },
    ])
  })

  it('deduplicates by ID, preserves removals, and only advances gift combos and poll state', () => {
    const replay = new YouTubeChatReplay(identity)
    replay.applyPage(pages[0], receivedAt)
    expect(replay.applyPage(pages[1], receivedAt + 1)).toMatchObject([
      { type: 'upsert', message: { id: 'LCC.gift-1', content: { kind: 'gift', comboCount: 3 } } },
      { type: 'remove', id: 'LCC.text-1', eventId: 'LCC.delete', reason: 'deleted' },
      { type: 'remove', id: 'LCC.late', eventId: 'LCC.retract', reason: 'retracted' },
      { type: 'upsert', message: { id: 'LCC.poll-1', content: { kind: 'poll', options: [{ tally: '4' }, {}] } } },
    ])
    expect(replay.applyPage(pages[0], receivedAt + 2)).toEqual([])
    expect(replay.applyPage(pages[2], receivedAt + 3)).toMatchObject([
      { type: 'upsert', message: { id: 'LCC.poll-1', content: { kind: 'poll', status: 'closed' } } },
      { type: 'ended', eventId: 'LCC.end' },
    ])
    expect(replay.applyPage(pages[2], receivedAt + 4)).toEqual([])
  })

  it('filters history before a new video start even when a persistent chat ID is shared', () => {
    const initial = new YouTubeChatReplay(identity, Date.parse(startTime))
    expect(initial.applyPage(pages[0], receivedAt)).toHaveLength(11)
    const nextIdentity = { ...identity, videoId: nextVideoId }
    const next = new YouTubeChatReplay(nextIdentity, Date.parse(nextStartTime))
    expect(next.applyPage({
      items: [...pages[0].items, youtubeFixtureMessage('LCC.text-1', 'textMessageEvent', {
        publishedAt: '2026-11-19T13:00:01Z', displayMessage: '本场消息',
      })],
      offlineAt: '2026-11-19T12:30:00Z',
      activePollItem: pages[0].activePollItem,
    }, receivedAt)).toMatchObject([{ identity: nextIdentity, type: 'upsert', message: { text: '本场消息' } }])
    expect(next.applyPage({ offlineAt: '2026-11-19T13:20:00Z' }, receivedAt)).toMatchObject([
      { type: 'ended', identity: nextIdentity, publishedAt: Date.parse('2026-11-19T13:20:00Z') },
    ])
  })
})

describe('YouTube live chat reader', () => {
  it('uses only the canonical video identity from playback', () => {
    expect(youtubeVideoTarget({ platform: 'youtube', channel: videoId, sourceRoom: channelId })).toEqual({ videoId, channelId })
    expect(youtubeVideoTarget({ platform: 'youtube', channel: channelId })).toBeNull()
    expect(youtubeVideoTarget({ platform: 'youtube', channel: 'https://www.youtube.com/@test/live' })).toBeNull()
    expect(youtubeVideoTarget({ platform: 'twitch', channel: videoId })).toBeNull()
  })

  it.each([
    { accountRef: null }, { grant: null }, { grant: { accountRef: 'previous-account', accessToken: 'old-bearer' } },
  ])('does not request the API for an unauthorized account: %o', async overrides => {
    const test = harness()
    await test.run(overrides)
    expect(test.fetch).not.toHaveBeenCalled()
    expect(test.states.map(state => state.code)).toEqual(['authorization-required'])
    expect(Object.values(YOUTUBE_CHAT_WRITE_CAPABILITIES).every(value => value === 'unsupported')).toBe(true)
  })

  it.each([undefined, { accountRef, accessToken: 'Cookie: private' }])('rejects unavailable credentials without a network request', async grant => {
    const test = harness()
    await test.run({ grant })
    expect(test.fetch).not.toHaveBeenCalled()
    expect(test.states.at(-1)?.code).toBe('credentials-unavailable')
  })

  it('requests the official video and chat, honors cadence, and stops on an end event', async () => {
    const test = harness(body(metadata), ...pages.flatMap(page => chatPage(page)))
    await test.run()
    const requests = test.fetch.mock.calls
    expect(requests.map(([url]) => [url.origin, url.pathname, url.searchParams.get('id'), url.searchParams.get('pageToken')])).toEqual([
      ['https://www.googleapis.com', '/youtube/v3/videos', videoId, null],
      ['https://www.googleapis.com', '/youtube/v3/liveChat/messages', null, null],
      ['https://www.googleapis.com', '/youtube/v3/videos', videoId, null],
      ['https://www.googleapis.com', '/youtube/v3/liveChat/messages', null, 'cursor-1='],
      ['https://www.googleapis.com', '/youtube/v3/videos', videoId, null],
      ['https://www.googleapis.com', '/youtube/v3/liveChat/messages', null, 'cursor-2='],
      ['https://www.googleapis.com', '/youtube/v3/videos', videoId, null],
    ])
    expect(requests.filter(([url]) => url.pathname.endsWith('/messages'))
      .every(([url]) => url.searchParams.get('liveChatId') === liveChatId)).toBe(true)
    expect(requests[1]?.[1]).toMatchObject({
      method: 'GET', credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer fake-bearer' },
    })
    expect(test.states.map(state => state.code)).toEqual(['connecting', 'connected', 'ended'])
    expect(test.states.at(-1)).toMatchObject({ accountRef, identity })
    expect(JSON.stringify([test.states, test.events])).not.toContain('fake-bearer')
    expect(test.wait.mock.calls.map(([ms]) => ms)).toEqual([2800, 3900])
    expect(test.events.at(-1)).toMatchObject({ type: 'ended', identity })
  })

  it.each([
    [{ ...metadata.items[0], id: nextVideoId }, 'video-unavailable'],
    [{ ...metadata.items[0], snippet: { channelId: fixture.viewerChannelId } }, 'video-unavailable'],
    [{ ...metadata.items[0], liveStreamingDetails: {} }, 'chat-unavailable'],
    [{ ...metadata.items[0], liveStreamingDetails: { actualEndTime: fixture.messageTime } }, 'ended'],
  ])('stops if official video metadata does not authorize a chat: %s', async (video, status) => {
    const test = harness(body({ items: [video] }))
    await test.run()
    expect(test.fetch).toHaveBeenCalledTimes(1)
    expect(test.states.at(-1)?.code).toBe(status)
  })

  it.each([
    ['liveChatDisabled', 403, 'chat-disabled'], ['liveChatEnded', 403, 'ended'],
    ['liveChatNotFound', 404, 'chat-unavailable'], ['insufficientPermissions', 403, 'permission-denied'],
    ['authError', 401, 'credentials-expired'], ['accessNotConfigured', 403, 'credentials-unavailable'],
    ['quotaExceeded', 403, 'quota-exhausted'], ['dailyLimitExceeded', 403, 'quota-exhausted'],
  ])('maps %s without exposing upstream errors or retrying terminal failures', async (reason, status, code) => {
    const test = harness(body(metadata), error(reason, status))
    await test.run()
    expect(test.states.map(state => state.code)).toEqual(['connecting', code])
    expect(test.wait).not.toHaveBeenCalled()
    expect(JSON.stringify(test.states)).not.toContain('raw upstream response')
  })

  it('retains the cursor across retries and resets expired cursors once with a gap warning', async () => {
    const test = harness(body(metadata), ...chatPage(pages[0]), error('rateLimitExceeded', 429, { 'Retry-After': '9' }),
      new Error('temporary network error'), error('invalidPageToken', 400), ...chatPage(pages[0]), ...chatPage(pages[2]))
    await test.run()
    expect(test.fetch.mock.calls.filter(([url]) => url.pathname.endsWith('/messages')).map(([url]) => url.searchParams.get('pageToken'))).toEqual([
      null, 'cursor-1=', 'cursor-1=', 'cursor-1=', null, 'cursor-1=',
    ])
    expect(test.states.map(state => [state.code, state.historyGapPossible])).toEqual([
      ['connecting', false], ['connected', false], ['reconnecting', false], ['reconnecting', true], ['connected', true], ['ended', true],
    ])
    expect(test.wait.mock.calls.map(([ms]) => ms)).toEqual([2800, 9000, 4000, 2800, 2800])
    expect(test.events.filter(event => event.type === 'upsert' && event.message.id === 'LCC.text-1')).toHaveLength(1)
  })

  it('stops after the retry budget and honors the last official interval', async () => {
    const test = harness(body(metadata), body({ nextPageToken: 'next', pollingIntervalMillis: 4500 }),
      ...Array.from({ length: 5 }, () => error('rateLimitExceeded', 429)))
    await test.run()
    expect(test.fetch).toHaveBeenCalledTimes(7)
    expect(test.wait.mock.calls.map(([ms]) => ms)).toEqual([4500, 4500, 4500, 8000, 16000])
    expect(test.states.at(-1)?.code).toBe('rate-limited')
  })

  it('does not lose a valid update when a malformed page omits its cursor', async () => {
    const test = harness(body(metadata), ...chatPage({ items: [pages[0].items[0]] }), ...chatPage(pages[0]), ...chatPage(pages[2]))
    await test.run()
    expect(test.events.filter(event => event.type === 'upsert' && event.message.id === 'LCC.text-1')).toHaveLength(1)
    expect(test.states.map(state => state.code)).toEqual(['connecting', 'connected', 'reconnecting', 'connected', 'ended'])
  })

  it('does not publish a page from a shared persistent chat that switched videos during polling', async () => {
    const ended = { items: [{
      ...metadata.items[0], liveStreamingDetails: { actualEndTime: '2026-11-19T13:00:00Z' },
    }] }
    const test = harness(body(metadata), ...chatPage(pages[0]), ...chatPage({
      items: [youtubeFixtureMessage('LCC.foreign', 'textMessageEvent', {
        publishedAt: '2026-11-19T13:00:01Z', displayMessage: '下一场消息',
      })],
      nextPageToken: 'next',
    }, ended))
    await test.run()
    expect(test.events).toHaveLength(11)
    expect(test.states.map(state => state.code)).toEqual(['connecting', 'connected', 'ended'])
    expect(test.fetch.mock.calls.at(-1)?.[0].searchParams.get('id')).toBe(videoId)
  })

  it('never delivers a late response after a switch, and resolves the next video independently', async () => {
    const old = harness()
    let resolveLate!: (response: Response) => void
    const oldFetch = vi.fn(async (url: URL) => url.pathname.endsWith('/videos')
      ? body(metadata)
      : new Promise<Response>(resolve => { resolveLate = resolve }))
    const pending = old.run({ fetch: oldFetch })
    await vi.waitFor(() => expect(oldFetch).toHaveBeenCalledTimes(2))
    old.controller.abort()
    const newMetadata = { items: [{
      ...metadata.items[0], id: nextVideoId, liveStreamingDetails: { activeLiveChatId: otherChatId, actualStartTime: nextStartTime },
    }] }
    const next = harness(body(newMetadata), ...chatPage({ items: [youtubeFixtureMessage('LCC.new', 'chatEndedEvent', {
      liveChatId: otherChatId, publishedAt: '2026-11-19T13:15:01Z',
    })] }, newMetadata))
    await next.run({ target: { videoId: nextVideoId, channelId } })
    resolveLate(body(pages[0]))
    await pending
    expect(old.states.map(state => state.code)).toEqual(['connecting'])
    expect(old.events).toEqual([])
    expect(next.fetch.mock.calls[1]?.[0].searchParams.get('pageToken')).toBeNull()
    expect(next.events).toMatchObject([{ identity: { videoId: nextVideoId, channelId, liveChatId: otherChatId }, type: 'ended' }])
  })

  it('cancels during the wait without making another request', async () => {
    const test = harness(body(metadata), ...chatPage(pages[0]))
    await test.run({ wait: async (_ms, signal) => {
      test.controller.abort()
      signal.throwIfAborted()
    } })
    expect(test.fetch).toHaveBeenCalledTimes(3)
    expect(test.states.map(state => state.code)).toEqual(['connecting', 'connected'])
  })
})
