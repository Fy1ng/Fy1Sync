import { describe, expect, it } from 'vitest'
import { parseSchedule } from '../server/esports/parser'
import fixture from '../server/esports/fixtures/liquipedia-matches.json'
import type { Cs2Match, Cs2Stream } from '../server/esports/types'
import { scheduleFocuses, focusArgument } from './focus'

const NOW = Date.parse('2026-10-26T20:00:00Z')
const base = parseSchedule(fixture)[0]!
const match = (state: Cs2Match['state'], startsAt: number, path = 'PGL/2026/Masters'): Cs2Match => ({ ...base,
  state, startsAt, tournament: { ...base.tournament, url: `https://liquipedia.net/counterstrike/${path}` }, streams: [] })

describe('relay focus rotation', () => {
  it.each([
    ['live', -45 * 60_000, true], ['finished', 0, false],
    ['upcoming', 15 * 60_000, true], ['upcoming', 15 * 60_000 + 1, false],
    ['upcoming', -30 * 60_000, true], ['upcoming', -30 * 60_000 - 1, false],
  ] as const)('chooses %s at offset %i only if active=%s', (state, offset, active) => {
    expect(scheduleFocuses([match(state, NOW + offset)], null, NOW).active).toBe(active ? 'PGL/2026/Masters' : null)
  })

  it('rotates between distinct active events and returns null if none remain', () => {
    const matches = [match('live', NOW, 'First'), match('live', NOW, 'First'), match('upcoming', NOW, 'Second')]
    expect(scheduleFocuses(matches, null, NOW)).toEqual({ waiting: [], active: 'First' })
    expect(scheduleFocuses(matches, 'First', NOW).active).toBe('Second')
    expect(scheduleFocuses(matches, 'Second', NOW).active).toBe('First')
    expect(scheduleFocuses(matches, 'removed/event', NOW).active).toBe('First')
    expect(scheduleFocuses([], 'First', NOW).active).toBeNull()
  })

  it('deduplicates waiting events independently of activity, including failed but not unmatched streams', () => {
    const waiting = (path: string, ...missing: Cs2Stream['missing'][]): Cs2Match => ({ ...match('finished', NOW, path),
      streams: missing.map(value => ({ platform: 'twitch', entry: 'pgl', channel: null, videoId: null, url: null, missing: value })) })
    expect(scheduleFocuses([waiting('First', 'finding', 'failed'), waiting('First', 'failed'), waiting('Second', 'failed'),
      waiting('Third', 'unmatched', null)], null, NOW)).toEqual({ waiting: ['First', 'Second'], active: null })
  })

  it('ignores invalid tournament paths and encodes normalized identities for the service', () => {
    const invalid = match('live', NOW)
    invalid.tournament.url = 'https://untrusted.invalid/counterstrike/PGL'
    expect(scheduleFocuses([invalid], null, NOW)).toEqual({ waiting: [], active: null })
    expect(focusArgument(null)).toEqual({ eventPath: null })
    expect(focusArgument('赛事/Season 1')).toEqual({ eventPath: '/counterstrike/%E8%B5%9B%E4%BA%8B/Season%201' })
  })
})
