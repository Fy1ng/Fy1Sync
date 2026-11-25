import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HuyaOfficialStreamMatcher, huyaOfficialLookupArguments, titleMatchesTeam } from './huyaOfficialMatch'
import { eventHuyaRooms } from './streamChannels'
import type { Cs2Schedule } from './types'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function huyaRoomHtml(room: number, nick: string, introduction: string, state: 'ON' | 'OFF' | 'REPLAY' = 'ON'): string {
  return `<script>var TT_ROOM_DATA = ${JSON.stringify({ state, profileRoom: room, introduction })};\n`
    + `var hyPlayerConfig = { stream: ${JSON.stringify({ data: [{ gameLiveInfo: { nick, introduction }, gameStreamInfoList: [] }], vMultiStreamInfo: [] })} };</script>`
}

const sampleSchedule = (now: number): Cs2Schedule => ({
  fetchedAt: now,
  source: 'liquipedia',
  attribution: '赛程数据来自 Liquipedia（CC-BY-SA 3.0）',
  stale: false,
  matches: [
    {
      id: 'match-main',
      startsAt: now - 15 * 60_000,
      state: 'live',
      teams: [
        { name: 'Ninjas in Pyjamas', short: 'NIP', logo: null },
        { name: 'Team Liquid', short: 'Liquid', logo: null },
      ],
      score: [1, 0],
      bestOf: 3,
      tournament: {
        name: 'PGL Major Singapore 2026',
        stage: 'Stage 1',
        tier: 1,
        url: 'https://liquipedia.net/counterstrike/PGL/2026/Singapore#Stage_1',
        logo: null,
      },
      streams: [
        { platform: 'twitch', entry: 'PGL', channel: 'pgl', url: 'https://www.twitch.tv/pgl', missing: null, videoId: null },
        { platform: 'youtube', entry: 'PGL', channel: 'PGL', url: 'https://www.youtube.com/watch?v=mainVideo11', missing: null, videoId: 'mainVideo11' },
      ],
    },
    {
      id: 'match-b',
      startsAt: now - 10 * 60_000,
      state: 'live',
      teams: [
        { name: 'BC.Game Esports', short: 'BC.Game', logo: null },
        { name: 'Cloud9', short: 'CW', logo: null },
      ],
      score: [0, 1],
      bestOf: 3,
      tournament: {
        name: 'PGL Major Singapore 2026',
        stage: 'Stage 1',
        tier: 1,
        url: 'https://liquipedia.net/counterstrike/PGL/2026/Singapore#Stage_1',
        logo: null,
      },
      streams: [
        { platform: 'twitch', entry: 'PGL_CS2', channel: 'pgl_cs2', url: 'https://www.twitch.tv/pgl_cs2', missing: null, videoId: null },
        { platform: 'youtube', entry: 'PGL 2', channel: 'PGL', url: 'https://www.youtube.com/watch?v=sideVideo22', missing: null, videoId: 'sideVideo22' },
      ],
    },
  ],
})

describe('Huya official tournament stream matching', () => {
  it('extracts canonical Huya rooms from Liquipedia extlinks in page order', () => {
    const rooms = eventHuyaRooms({
      query: {
        pages: [{
          extlinks: [
            { url: 'https://www.twitch.tv/PGL' },
            { url: 'https://www.douyu.com/6200' },
            { url: 'https://www.huya.com/825801' },
            { url: 'https://www.huya.com/825802' },
            { url: 'https://www.huya.com/825801' },
          ],
        }],
      },
    })
    expect(rooms).toEqual(['825801', '825802'])
  })

  it('matches team names and shorthand abbreviations accurately', () => {
    expect(titleMatchesTeam('NIP vs Liquid PGL新加坡Major2026 Stage1', { name: 'Team Liquid', short: 'Liquid', logo: null })).toBe(true)
    expect(titleMatchesTeam('BC.G vs CW PGL新加坡Major2026 Stage1', { name: 'BC.Game Esports', short: 'BC.Game', logo: null })).toBe(true)
    expect(titleMatchesTeam('NIP vs Liquid PGL新加坡Major2026 Stage1', { name: 'BC.Game Esports', short: 'BC.Game', logo: null })).toBe(false)
  })

  it('pairs main stage and B-stream matches with their corresponding live Huya official rooms while ignoring replays', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fy1sync-huya-match-'))
    roots.push(root)
    const now = 1_795_000_000_000
    const userAgents: string[] = []
    const request = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (url.includes('liquipedia.net')) {
        userAgents.push(new Headers(init?.headers).get('user-agent') ?? '')
        return Response.json({
          query: {
            pages: [{
              extlinks: [
                { url: 'https://www.twitch.tv/PGL' },
                { url: 'https://www.huya.com/660729' },
                { url: 'https://www.huya.com/825801' },
                { url: 'https://www.huya.com/825802' },
              ],
            }],
          },
        })
      }
      if (url === 'https://www.huya.com/660729') {
        return new Response(huyaRoomHtml(660729, 'BLAST赛事主舞台', '【重播】恭喜FURIA获得总冠军！'))
      }
      if (url === 'https://www.huya.com/825801') {
        return new Response(huyaRoomHtml(825801, '完美世界电竞频道一', 'NIP vs Liquid PGL新加坡Major2026 Stage1'))
      }
      if (url === 'https://www.huya.com/825802') {
        return new Response(huyaRoomHtml(825802, '完美世界电竞频道二', 'BC.G vs CW PGL新加坡Major2026 Stage1'))
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const matcher = new HuyaOfficialStreamMatcher({
      userDataDir: root,
      version: '0.5.1',
      getSchedule: async () => sampleSchedule(now),
      request,
      resolve: async () => ['93.184.216.34'],
      now: () => now,
    })
    try {
      const mainMatch = await matcher.find({ platform: 'youtube', input: 'https://www.youtube.com/watch?v=mainVideo11', channel: 'mainVideo11' })
      expect(mainMatch).toEqual({
        room: '825801',
        url: 'https://www.huya.com/825801',
        nickname: '完美世界电竞频道一',
        title: 'NIP vs Liquid PGL新加坡Major2026 Stage1',
        tournament: 'PGL Major Singapore 2026',
      })

      const secondaryMatch = await matcher.find({ platform: 'twitch', input: 'https://www.twitch.tv/pgl_cs2', channel: 'pgl_cs2' })
      expect(secondaryMatch).toEqual({
        room: '825802',
        url: 'https://www.huya.com/825802',
        nickname: '完美世界电竞频道二',
        title: 'BC.G vs CW PGL新加坡Major2026 Stage1',
        tournament: 'PGL Major Singapore 2026',
      })
      expect(userAgents).toEqual(['Fy1Sync/0.5.1 (local desktop app; sync@fy1ng.cn)'])
    } finally {
      await matcher.dispose()
    }
  })

  it('rejects malformed lookup arguments', () => {
    expect(() => huyaOfficialLookupArguments(null)).toThrow()
    expect(() => huyaOfficialLookupArguments({ platform: 'douyu', input: '6200' })).toThrow()
    expect(() => huyaOfficialLookupArguments({ platform: 'youtube', input: '' })).toThrow()
    expect(() => huyaOfficialLookupArguments({ platform: 'youtube', input: 'https://www.youtube.com/watch?v=abcdefghijk', extra: 1 })).toThrow()
  })
})
