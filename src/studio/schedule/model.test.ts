/** Grouping the schedule by event and telling the two stages of one event apart. */
import { describe, expect, it } from 'vitest'
import type { Cs2Match, Cs2Schedule, StreamTitle } from '../../../electron/featureContracts'
import { eventPath, formatStart, groupEvents, matchStage, orderedStreams, stageLabel, streamTitle, tierLabel, titleKey, titleRequests } from './model'

const at = Date.parse('2026-10-27T10:00:00Z')
function match(id: string, over: Partial<Cs2Match> & { event?: string; tier?: Cs2Match['tournament']['tier']; logo?: string | null } = {}): Cs2Match {
  const { event = 'PGL/2026/Masters', tier = null, logo = null, ...rest } = over
  return {
    id, startsAt: at, state: 'upcoming', teams: [{ name: 'A', short: null, logo: null }, { name: 'B', short: null, logo: null }], score: null, bestOf: 3,
    tournament: { name: event.replace(/\//g, ' '), stage: 'Round 3', tier, url: `https://liquipedia.net/counterstrike/${event}#Round_3`, logo },
    streams: [], ...rest,
  }
}
const schedule = (matches: Cs2Match[]): Cs2Schedule => ({ fetchedAt: at, source: 'liquipedia', attribution: '', stale: false, matches })

describe('groupEvents', () => {
  it('puts events with a live match first and splits each by state', () => {
    const groups = groupEvents(schedule([
      match('u1', { event: 'Tesla/Cup', startsAt: at + 3_600_000 }),
      match('l1', { state: 'live', startsAt: at - 600_000 }),
      match('f1', { state: 'finished', startsAt: at - 7_200_000 }),
      match('l2', { state: 'live', startsAt: at - 300_000 }),
    ]))
    expect(groups.map((group) => group.name)).toEqual(['PGL 2026 Masters', 'Tesla Cup'])
    expect(groups[0]!.live.map((item) => item.id)).toEqual(['l1', 'l2'])
    expect(groups[0]!.finished.map((item) => item.id)).toEqual(['f1'])
  })

  it('keeps one event together across stage anchors and orders by tier, then by time', () => {
    const playoffs = match('a2', { event: 'A/Event', tier: 1 })
    playoffs.tournament = { ...playoffs.tournament, url: 'https://liquipedia.net/counterstrike/A/Event#Playoffs' }
    const groups = groupEvents(schedule([
      match('b', { event: 'B/Event', tier: 2, startsAt: at }),
      match('a', { event: 'A/Event', tier: 1, startsAt: at + 999 }),
      playoffs,
    ]))
    expect(groups.map((group) => group.key)).toEqual(['https://liquipedia.net/counterstrike/A/Event', 'https://liquipedia.net/counterstrike/B/Event'])
    expect(groups[0]!.upcoming).toHaveLength(2)
  })

  it('sorts by tier first, so an S-tier event leads even with nothing on now', () => {
    const groups = groupEvents(schedule([
      match('b-live', { event: 'B/Cup', tier: 3, state: 'live' }),
      match('s', { event: 'Major/2026', tier: 1, startsAt: at + 86_400_000 }),
      match('misc', { event: 'Misc/Cup', tier: -1, state: 'live' }),
      match('unknown', { event: 'Unknown/Cup', tier: null, state: 'live' }),
      match('a', { event: 'A/Cup', tier: 2 }),
    ]))
    expect(groups.map((group) => group.tier)).toEqual([1, 2, 3, -1, null])
  })

  it('labels tiers the way Liquipedia names them', () => {
    expect([1, 2, 3, 4, -1, null].map((tier) => tierLabel(tier as never))).toEqual(['S', 'A', 'B', 'C', '其他', null])
  })

  it('is empty without a schedule', () => {
    expect(groupEvents(null)).toEqual([])
  })

  it('takes the event icon from the first match that has one, never from another event', () => {
    const groups = groupEvents(schedule([
      match('a'), match('b', { logo: 'app://app/team-logo/pgl' }), match('c', { logo: 'app://app/team-logo/other' }),
      match('t', { event: 'Tesla/Cup' }),
    ]))
    expect(groups.map((group) => [group.name, group.logo])).toEqual([['PGL 2026 Masters', 'app://app/team-logo/pgl'], ['Tesla Cup', null]])
  })
})

describe('stages', () => {
  const yt = { platform: 'youtube' as const, entry: 'PGL', channel: null, url: 'https://www.youtube.com/watch?v=sx5tneE-ILg', missing: null, videoId: 'sx5tneE-ILg' }
  const tw = { platform: 'twitch' as const, entry: 'PGL_CS2', channel: 'pgl_cs2', url: 'https://www.twitch.tv/pgl_cs2', missing: null, videoId: null }

  it('reads the stage from a stream title first', () => {
    const title: StreamTitle = { platform: 'youtube', channel: 'PGL', videoId: 'sx5tneE-ILg', title: '[B] G2 vs DENDELE', stage: 'B', live: null }
    const titles = new Map<string, StreamTitle>([[titleKey(title), title]])
    expect(matchStage(match('m', { state: 'live', streams: [tw, yt] }), titles, 2)).toEqual({ label: 'B 舞台', from: 'title' })
  })

  it('falls back to the channel only when two matches of one event are live', () => {
    const live = match('m', { state: 'live', streams: [tw] })
    expect(matchStage(live, new Map(), 2)).toEqual({ label: '频道 pgl_cs2', from: 'channel' })
    expect(matchStage(live, new Map(), 1)).toBeNull()
    expect(matchStage(match('u', { streams: [tw] }), new Map(), 2)).toBeNull()
    // A channel not found yet is named by its entry.
    expect(matchStage(match('w', { state: 'live', streams: [{ ...tw, channel: null, url: null, missing: 'finding' }] }), new Map(), 2))
      .toEqual({ label: '频道 PGL_CS2', from: 'channel' })
  })

  it('labels a lone letter and keeps longer organiser wording', () => {
    expect(stageLabel('a')).toBe('A 舞台')
    expect(stageLabel('Main Stage')).toBe('Main Stage')
    expect(stageLabel(null)).toBeNull()
  })

  it('offers YouTube before Twitch', () => {
    expect(orderedStreams(match('m', { streams: [tw, yt] })).map((stream) => stream.platform)).toEqual(['youtube', 'twitch'])
  })

  it('asks for titles of live and next matches only, de-duplicated', () => {
    const [group] = groupEvents(schedule([
      match('l', { state: 'live', streams: [yt, tw] }),
      match('u', { startsAt: at + 1, streams: [yt] }),
      match('f', { state: 'finished', streams: [{ ...tw, channel: 'old' }] }),
    ]))
    expect(titleRequests(group)).toEqual([
      { platform: 'youtube', channel: 'PGL', videoId: 'sx5tneE-ILg' },
      { platform: 'twitch', channel: 'pgl_cs2', videoId: null },
    ])
    expect(titleRequests(undefined)).toEqual([])
  })

  it('reads a title only once the stream names a video or its channel is known', () => {
    const finding = { ...tw, channel: null, url: null, missing: 'finding' as const }
    const page = { ...yt, url: 'https://www.youtube.com/@PGL/live', channel: '@PGL', videoId: null }
    const [group] = groupEvents(schedule([match('l', { state: 'live', streams: [finding, page] })]))
    expect(titleRequests(group)).toEqual([])
    // The title answers by what was asked: the video's id, the channel's login.
    const title: StreamTitle = { platform: 'twitch', channel: 'PGL_CS2', videoId: null, title: 'Main', stage: null, live: true }
    const titles = new Map([[titleKey(title), title]])
    expect(streamTitle(titles, tw)?.title).toBe('Main')
    expect(streamTitle(titles, finding)).toBeUndefined()
  })
})

describe('formatStart', () => {
  it('says today, tomorrow and yesterday plainly', () => {
    const now = new Date(2026, 9, 27, 12, 0).getTime()
    expect(formatStart(new Date(2026, 9, 27, 19, 30).getTime(), now)).toBe('19:30')
    expect(formatStart(new Date(2026, 9, 28, 1, 0).getTime(), now)).toBe('明天 01:00')
    expect(formatStart(new Date(2026, 9, 26, 23, 0).getTime(), now)).toBe('昨天 23:00')
    expect(formatStart(new Date(2026, 9, 30, 9, 5).getTime(), now)).toBe('10月30日 09:05')
  })
})

describe('the event path sent to main', () => {
  it('is the Liquipedia path without the site or the stage anchor, the same for both stages', () => {
    const [group] = groupEvents({ matches: [match('a'), match('b', { tournament: { ...match('b').tournament, url: 'https://liquipedia.net/counterstrike/PGL/2026/Masters#Final' } })] } as Cs2Schedule)
    expect(eventPath(group)).toBe('/counterstrike/PGL/2026/Masters')
    expect(eventPath({ key: 'https://liquipedia.net/counterstrike/Regional_Cup/2026/Kraków_Final' })).toBe('/counterstrike/Regional_Cup/2026/Krak%C3%B3w_Final')
  })
  it('is null for an event known only by name, another site or no event', () => {
    expect(eventPath({ key: 'Some Cup' })).toBeNull()
    expect(eventPath({ key: 'https://example.com/counterstrike/PGL' })).toBeNull()
    expect(eventPath({ key: 'https://liquipedia.net/dota2/PGL' })).toBeNull()
    expect(eventPath(undefined)).toBeNull()
  })
})
