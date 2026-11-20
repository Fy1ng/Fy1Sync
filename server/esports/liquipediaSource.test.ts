import { describe, expect, it, vi } from 'vitest'
import fixture from './fixtures/liquipedia-source.json'
import { loadLiquipediaSource, parseLiquipediaSource, readLiquipediaSource, searchLiquipediaSource } from './liquipediaSource'
import { matchChannel } from './streamChannels'
import { normalizeTournamentPath } from './tiers'

const captured = (index: number) => {
  const page = fixture.query.pages[index]!
  return parseLiquipediaSource({ title: page.title, wikitext: page.revisions[0]!.slots.main.content })
}

describe('captured Liquipedia wikitext', () => {
  it('keeps simultaneous Stage 1 matches and their distinct Twitch registrations', () => {
    const event = captured(0)
    expect(event).toMatchObject({ path: 'PGL/2026/Singapore/Stage_1', name: 'PGL Major Singapore 2026: Stage 1', tier: 1,
      channels: [], skipped: [] })
    expect(event.path).toBe(normalizeTournamentPath('/counterstrike/PGL/2026/Singapore/Stage_1'))
    expect(event.matches).toHaveLength(3)
    const sameTime = Date.UTC(2026, 10, 24, 4)
    expect(event.matches[0]).toMatchObject({ opponents: ['heroic', 'imp'], startsAt: sameTime, finished: false,
      streams: [{ platform: 'twitch', entry: 'PGL', videoId: null }, { platform: 'youtube', entry: 'PGL', videoId: null }],
      params: { hltv: '2400494\n\t' } })
    expect(event.matches[1]).toMatchObject({ opponents: ['9z', 'lvg'], startsAt: sameTime,
      streams: [{ platform: 'twitch', entry: 'PGL CS2', videoId: null }, { platform: 'youtube', entry: 'PGL', videoId: null }] })
    expect(event.matches[2]).toMatchObject({ opponents: [null, null], startsAt: null })
  })

  it('keeps explicit Bucharest YouTube IDs, not map VODs', () => {
    const event = captured(2)
    expect(event.tier).toBe(2)
    expect(event.matches).toHaveLength(2)
    expect(event.matches.map(match => match.streams.find(stream => stream.platform === 'youtube'))).toEqual([
      { platform: 'youtube', entry: 'PGL', videoId: 'SL7HSvnChgw' },
      { platform: 'youtube', entry: 'PGL', videoId: 'HisidZ23hYA' },
    ])
    expect(event.matches[0]).toMatchObject({ startsAt: Date.UTC(2026, 3, 5, 7), finished: true })
    expect(event.matches[0]?.params.map1).toContain('Ij_GZp96V58')
  })

  it('extracts channels by source, including multi-stream rows, handles and channel IDs', () => {
    const singapore = captured(1)
    expect(singapore.matches).toEqual([])
    expect(singapore.channels).toContainEqual({ platform: 'youtube', source: 'streams', name: 'PGL',
      url: 'https://www.youtube.com/PGL/live', ytMultiple: true })
    expect(singapore.channels.filter(channel => channel.platform === 'youtube')).toHaveLength(2)
    expect(singapore.channels).toContainEqual({ platform: 'youtube', source: 'infobox', name: 'PGL',
      url: 'https://www.youtube.com/PGL/live', ytMultiple: false })
    expect(captured(6).channels.filter(channel => channel.platform === 'youtube')).toMatchObject([
      { name: '@elisaesports', source: 'streams', url: 'https://www.youtube.com/@elisaesports/live' },
      { name: '@elisaesports', source: 'infobox', url: 'https://www.youtube.com/@elisaesports/live' },
    ])
    expect(captured(5).channels).toContainEqual({ platform: 'youtube', source: 'infobox', name: 'UCrN2GuYzV7D8hcyMrq7ImUA',
      url: 'https://www.youtube.com/channel/UCrN2GuYzV7D8hcyMrq7ImUA/live', ytMultiple: false })
  })

  it('does not infer per-match registrations from Kick or the event channels', () => {
    expect(captured(4)).toMatchObject({ channels: [], matches: [{ streams: [], params: { kick: 'Nodwin CS\n\t' } }] })
    expect(captured(5).matches[0]?.streams).toEqual([])
  })

  it('retains Brno Matchlist and Bracket matches and leaves registry-to-channel matching separate', () => {
    const event = captured(3)
    expect(event).toMatchObject({ name: 'RUSH:Brno 2026', tier: 3, skipped: [] })
    expect(event.matches.map(match => match.params.hltv?.trim())).toEqual(['2400518', '2400526', '2400527', '2400528', '2400529', '2400530'])
    const youtube = event.matches[0]?.streams.find(stream => stream.platform === 'youtube')
    expect(youtube).toEqual({ platform: 'youtube', entry: 'PLAYzone', videoId: null })
    expect(matchChannel(youtube!.entry, event.channels.filter(channel => channel.platform === 'youtube' && channel.source === 'streams')))
      .toMatchObject({ name: 'PLAYzoneczsk', ytMultiple: true })
  })
})

// The remaining page and API response variants are synthetic and never make network requests.
const parse = (wikitext: string) => parseLiquipediaSource({ title: 'Synthetic Cup', wikitext })
const match = (fields: string) => `{{Match|${fields}}}`
const revision = (title: string, content = '') => ({ title, ns: 0, revisions: [{ slots: { main: { content } } }] })
const hits = (...titles: string[]) => ({ query: { search: titles.map(title => ({ ns: 0, title })) } })
const pages = (...records: unknown[]) => ({ query: { pages: records } })
const params = (url: string) => new URL(url).searchParams

describe('wikitext parsing boundaries', () => {
  it.each([
    ['November 24, 2026 - 9:00 {{Abbr/CET}}', Date.UTC(2026, 10, 24, 8)],
    ['November 2, 2026 - 07:00 {{Abbr/CST}}', Date.UTC(2026, 10, 1, 23)],
    ['November 2, 2026 - 07:00 {{Abbr/AST}}', Date.UTC(2026, 10, 2, 4)],
    ['November 2, 2026 - 07:00 {{Abbr/IST}}', Date.UTC(2026, 10, 2, 1, 30)],
    ['November 2, 2026 - 07:00 {{Abbr/NPT}}', Date.UTC(2026, 10, 2, 1, 15)],
    ['November 2, 2026 - 07:00 {{Abbr/NDT}}', Date.UTC(2026, 10, 2, 10, 30)],
    ['November 2, 2026 - 07:00 {{Abbr/CEST}}', Date.UTC(2026, 10, 2, 5)],
    ['February 29, 2028 - 07:00 {{Abbr/utc}}', Date.UTC(2028, 1, 29, 7)],
    ['November 2, 2026 - 07:00 {{Abbr/UNKNOWN}}', null],
    ['February 29, 2026 - 07:00 {{Abbr/CET}}', null],
    ['November 2, 2026 - 24:00 {{Abbr/CET}}', null],
    ['November 2, 2026 - 07:00', null],
    ['', null],
  ])('interprets %j using Liquipedia offsets, or leaves it unknown', (date, expected) => {
    expect(parse(match(`date=${date}`)).matches[0]?.startsAt).toBe(expected)
  })

  it.each([['S-Tier', 1], ['A-Tier', 2], ['B-Tier', 3], ['C-Tier', 4], ['-1', -1], ['Unmapped', null]])(
    'uses the explicit %s tier without inventing a qualifier override', (value, tier) => {
      const event = parse(`{{HiddenDataBox|name=Fallback|liquipediatier=C-Tier}}{{Infobox league|name=My&nbsp;Cup|liquipediatier=${value}|liquipediatiertype=Qualifier}}`)
      expect(event).toMatchObject({ tier, name: 'My Cup', matches: [], channels: [] })
    },
  )

  it('ignores comments, nowiki and embedded link templates without rewriting raw values', () => {
    const fake = match('date=|youtube=Fake')
    const raw = ` [[Page|label=${fake}]] {{Map|a=b|twitch=NotARegistration}} <!-- }}|twitch=fake --> <NoWiki>|youtube=fake ]]</NoWiki> `
    const result = parse(`<!-- ${fake} --><nowiki>${fake}</nowiki>{{Bracket|R1M1=${match(
      `opponent1={{TeamOpponent|some club\n |substitutes={{PlayerSubstitutions|{{Substitution|in=A|out=B}}}}}}|opponent2={{Placeholder|1}}|note=${raw}|youtube=Real`,
    )}}}<!-- ${fake}`)
    expect(result.skipped).toEqual([])
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ opponents: ['some club', null], params: { note: raw },
      streams: [{ platform: 'youtube', entry: 'Real', videoId: null }] })
    expect(result.matches[0]?.params).not.toHaveProperty('twitch')
    expect(parse(`<nowiki/>${match('opponent1={{TeamOpponent|TBD}}|opponent2=')}<nowiki>${fake}`).matches[0]?.opponents).toEqual([null, null])
  })

  it('recovers at a later match after invalid registrations and unfinished nested markup', () => {
    const good = match('youtube=Real|finished=true')
    const source = [match('twitch=bad?entry'), match('youtube=good/short'), match('twitch=entry/12345678901'),
      match('youtube=entry/12345678901/extra'), '{{Match|map1={{Map|vod=', good, '{{Match|note=[[unclosed', good,
      '{{Match|date='].join('\n')
    const event = parse(source)
    expect(event.matches.map(item => item.finished)).toEqual([true, true])
    expect(event.skipped.map(skip => skip.reason)).toEqual([
      'Invalid twitch stream registration', 'Invalid youtube stream registration', 'Invalid twitch stream registration',
      'Invalid youtube stream registration', 'Unclosed Match template', 'Unclosed Match template', 'Unclosed Match template',
    ])
    expect(event.skipped.every(skip => source.startsWith('{{Match', skip.offset))).toBe(true)
  })

  it('allows empty pages and refuses overlong sources, too many matches and deep nesting', () => {
    expect(parse('')).toEqual({ path: 'Synthetic_Cup', name: null, tier: null, matches: [], channels: [], skipped: [] })
    expect(parse(' '.repeat(2_000_000)).matches).toEqual([])
    expect(() => parse(' '.repeat(2_000_001))).toThrow('size limit')
    expect(parse(match('date=').repeat(500)).matches).toHaveLength(500)
    expect(() => parse(match('date=').repeat(501))).toThrow('record limit')
    const nested = (depth: number) => '{{Wrapper|'.repeat(depth) + match('date=') + '}}'.repeat(depth)
    expect(parse(nested(63)).matches).toHaveLength(1)
    expect(() => parse(nested(64))).toThrow('nesting limit')
  })
})

describe('injected Liquipedia queries', () => {
  it('searches separately per calendar date, follows numeric offsets and deduplicates titles', async () => {
    const request = vi.fn(async (url: string) => {
      const query = params(url)
      expect(new URL(url).origin).toBe('https://liquipedia.net')
      expect(Object.fromEntries(query)).toMatchObject({ action: 'query', list: 'search', formatversion: '2',
        srnamespace: '0', srwhat: 'text', srlimit: '50' })
      if (query.get('srsearch') === 'insource:"November 2, 2026"') {
        if (!query.has('sroffset')) return { ...hits('One Cup'), continue: { continue: '-||', sroffset: 1 } }
        expect(query.get('continue')).toBe('-||')
        expect(query.get('sroffset')).toBe('1')
        return hits('One_Cup', 'Two')
      }
      expect(query.get('srsearch')).toBe('insource:"November 21, 2026"')
      return hits('Two', 'Three')
    })
    const result = await searchLiquipediaSource(['2026-11-02', '2026-11-21', '2026-11-02', '2026-02-29'], request)
    expect(result).toEqual({ titles: ['One Cup', 'Two', 'Three'], failed: [{ date: '2026-02-29', reason: 'Invalid calendar date' }] })
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('requests at most 50 titles per read and rejects invalid titles before requesting', async () => {
    const request = vi.fn(async (url: string) => {
      expect(Object.fromEntries(params(url))).toMatchObject({ action: 'query', prop: 'revisions', rvprop: 'content|ids|timestamp',
        rvslots: 'main', redirects: '1', formatversion: '2' })
      return pages(...params(url).get('titles')!.split('|').map(title => revision(title)))
    })
    const titles = Array.from({ length: 51 }, (_, index) => `Cup/${index}`)
    const invalid = ['Cup|Other', 'Category:Cup', 'Cup/../Other', '_ _', 'Too long'.repeat(251)]
    const result = await readLiquipediaSource([...titles, titles[0]!, ...invalid], request)
    expect(request.mock.calls.map(([url]) => params(url).get('titles')!.split('|').length)).toEqual([50, 1])
    expect(result.pages.map(page => page.title)).toEqual(titles)
    expect(result.failed.map(failure => failure.title)).toEqual(invalid)
  })

  it('merges continuation, normalized titles, and redirects without losing unreadable sibling pages', async () => {
    const request = vi.fn(async (url: string) => {
      if (!params(url).has('rvcontinue')) return {
        query: { normalized: [{ from: 'old_Cup', to: 'Old Cup' }], redirects: [{ from: 'Old Cup', to: 'New Cup' }],
          pages: [{ title: 'Final Cup', ns: 0 }, revision('Other')], },
        continue: { continue: '||', rvcontinue: '20261121|5' },
      }
      expect(params(url).get('rvcontinue')).toBe('20261121|5')
      expect(params(url).get('continue')).toBe('||')
      return { query: { redirects: [{ from: 'New Cup', to: 'Final Cup' }],
        pages: [revision('Final Cup', 'source'), { title: 'Missing', missing: true }, { title: 'Bad', revisions: [{ slots: {} }] }] } }
    })
    expect(await readLiquipediaSource(['old_Cup', 'old Cup', 'Final_Cup', 'Other', 'Missing', 'Bad', 'Omitted'], request)).toEqual({
      pages: [{ title: 'Final Cup', wikitext: 'source' }, { title: 'Other', wikitext: '' }],
      failed: [{ title: 'Missing', reason: 'Page is missing' }, { title: 'Bad', reason: 'Missing or invalid wikitext revision' },
        { title: 'Omitted', reason: 'Requested page not returned' }],
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('reports cyclic and conflicting mappings without failing unrelated titles', async () => {
    const result = await readLiquipediaSource(['Cycle', 'Conflict', 'Good'], async () => ({ query: {
      redirects: [{ from: 'Cycle', to: 'Other' }, { from: 'Other', to: 'Cycle' },
        { from: 'Conflict', to: 'Good' }, { from: 'Conflict', to: 'Other' }], pages: [revision('Good')],
    } }))
    expect(result.pages).toEqual([{ title: 'Good', wikitext: '' }])
    expect(result.failed).toEqual([{ title: 'Cycle', reason: 'Cyclic revisions title mappings' },
      { title: 'Conflict', reason: 'Conflicting revisions title mappings' }])
  })

  it.each([undefined, { error: {} }, { query: { search: {} } }, { query: { search: [{ title: 'Category:Foo', ns: 14 }] } },
    hits(...Array.from({ length: 51 }, (_, index) => `Cup/${index}`)), { ...hits('Discarded'), continue: { action: 'parse' } },
  ])('rejects a malformed search response without contributing titles: %j', async payload => {
    const result = await searchLiquipediaSource(['2026-11-21'], async () => payload)
    expect(result.titles).toEqual([])
    expect(result.failed).toHaveLength(1)
  })

  it.each([null, { query: { pages: {} } }, pages({ title: 7 }), { ...pages(revision('Cup')), continue: { titles: 'Bad' } },
    { query: { pages: [], redirects: 'Bad' } },
  ])('rejects a malformed revisions response: %j', async payload => {
    const result = await readLiquipediaSource(['Cup'], async () => payload)
    expect(result.pages).toEqual([])
    expect(result.failed).toHaveLength(1)
  })

  it('stops repeated and excessive continuation without exposing a partial result', async () => {
    const repeating = vi.fn(async () => ({ ...hits('Cup'), continue: { sroffset: 1 } }))
    expect(await searchLiquipediaSource(['2026-11-21'], repeating)).toMatchObject({ titles: [],
      failed: [{ reason: 'Repeated search continuation' }] })
    expect(repeating).toHaveBeenCalledTimes(2)
    let offset = 0
    const search = vi.fn(async () => ({ ...hits('Cup'), continue: { sroffset: ++offset } }))
    expect(await searchLiquipediaSource(['2026-11-21'], search)).toMatchObject({ titles: [],
      failed: [{ reason: 'Too many search continuations' }] })
    expect(search).toHaveBeenCalledTimes(10)
    const read = vi.fn(async () => ({ ...pages(revision('Cup')), continue: { rvcontinue: String(++offset) } }))
    expect(await readLiquipediaSource(['Cup'], read)).toMatchObject({ pages: [],
      failed: [{ reason: 'Too many revisions continuations' }] })
    expect(read).toHaveBeenCalledTimes(10)
  })

  it('reports date, read and parse failures independently from the tournaments', async () => {
    const request = vi.fn(async (url: string) => {
      if (params(url).get('list') === 'search') {
        if (params(url).get('srsearch')?.includes('21,')) throw new Error('Offline')
        return hits('PGL/2026/Singapore/Stage 1', 'Too big', 'Missing')
      }
      return pages(fixture.query.pages[0], revision('Too big', ' '.repeat(2_000_001)), { title: 'Missing', missing: true })
    })
    const result = await loadLiquipediaSource(['2026-11-20', '2026-11-21'], request)
    expect(result).toEqual({ tournaments: [captured(0)], failedDates: [{ date: '2026-11-21', reason: 'Offline' }],
      failedReads: [{ title: 'Missing', reason: 'Page is missing' }],
      failedParses: [{ title: 'Too big', reason: 'Wikitext size limit exceeded' }] })
    expect(request).toHaveBeenCalledTimes(3)
  })
})
