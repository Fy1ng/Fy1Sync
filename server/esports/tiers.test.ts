import { describe, expect, it, vi } from 'vitest'
import { normalizeTournamentPath, queryTournamentTiers } from './tiers'

const page = (title: string, categories?: string[]) => ({ title, ...(categories ? { categories: categories.map(title => ({ title })) } : {}) })
const category = (tier: string) => `Category:${tier}-Tier Tournaments`
const response = (...pages: unknown[]) => ({ query: { pages } })
const titles = (url: string) => new URL(url).searchParams.get('titles')!.split('|')

// Every network response in this suite is synthetic.
describe('Liquipedia tournament category queries', () => {
  it('queries only the four exact categories with at most 50 distinct titles per request', async () => {
    const paths = Array.from({ length: 103 }, (_, index) => `Cup/${index}`)
    const request = vi.fn(async (url: string) => response(...titles(url).map(title => page(title, [category('B')]))))
    const result = await queryTournamentTiers([...paths, paths[0]!], request)
    expect(request.mock.calls.map(([url]) => titles(url).length)).toEqual([50, 50, 3])
    expect(result.tiers.size).toBe(103)
    expect([...result.tiers.values()].every(tier => tier === 3)).toBe(true)
    expect(result.failed).toEqual([])
    for (const [url] of request.mock.calls) {
      expect(new URL(url).origin).toBe('https://liquipedia.net')
      expect(Object.fromEntries(new URL(url).searchParams)).toMatchObject({ action: 'query', format: 'json', formatversion: '2',
        prop: 'categories', redirects: '1', cllimit: 'max', clcategories: ['S', 'A', 'B', 'C'].map(category).join('|') })
    }
  })

  it('maps normalized titles and multiple redirect hops back to every original path', async () => {
    const request = vi.fn(async () => ({ query: {
      normalized: [{ from: 'old_Cup/2026', to: 'Old Cup/2026' }],
      redirects: [{ from: 'Old Cup/2026', to: 'Renamed Cup/2026' }, { from: 'Renamed Cup/2026', to: 'Final Cup/2026' }],
      pages: [page('Final Cup/2026', [category('A')])],
    } }))
    const result = await queryTournamentTiers(['old_Cup/2026', 'Old Cup/2026', 'Final_Cup/2026'], request)
    expect([...result.tiers]).toEqual([['old_Cup/2026', 2], ['Old Cup/2026', 2], ['Final_Cup/2026', 2]])
    expect(result.failed).toEqual([])
  })

  it('merges continuation categories before deciding conflicts and retains prior title mappings', async () => {
    const request = vi.fn(async (url: string) => {
      if (!new URL(url).searchParams.has('clcontinue')) return {
        query: { normalized: [{ from: 'old_Cup', to: 'Old Cup' }], redirects: [{ from: 'Old Cup', to: 'New Cup' }],
          pages: [page('New Cup', [category('S')]), page('Other', [category('B')])] },
        continue: { continue: '||', clcontinue: '123|Category:A-Tier Tournaments' },
      }
      expect(new URL(url).searchParams.get('continue')).toBe('||')
      return response(page('New Cup', [category('A')]), page('Other', [category('B')]))
    })
    const result = await queryTournamentTiers(['old_Cup', 'Other'], request)
    expect(request).toHaveBeenCalledTimes(2)
    expect([...result.tiers]).toEqual([['old_Cup', null], ['Other', 3]])
  })

  it('keeps the child classification even when its parent has a different tier', async () => {
    const request = vi.fn(async () => response(page('EXTREMESLAND/2026', [category('A')]), page('EXTREMESLAND/2026/South Asia', [category('C')])))
    const result = await queryTournamentTiers(['EXTREMESLAND/2026', 'EXTREMESLAND/2026/South_Asia'], request)
    expect([...result.tiers]).toEqual([['EXTREMESLAND/2026', 2], ['EXTREMESLAND/2026/South_Asia', 4]])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no categories', undefined],
    ['unrelated categories', ['Category:Women Tournaments', 'Category:S-Tier Tournament', 'Category:A-Tier Tournaments/2026']],
    ['conflicting categories', [category('S'), category('A')]],
  ])('returns null without parent fallback for an existing page with %s', async (_label, categories) => {
    const request = vi.fn(async () => response(page('Cup/2026/Qualifier', categories)))
    const result = await queryTournamentTiers(['Cup/2026/Qualifier'], request)
    expect(result.tiers.get('Cup/2026/Qualifier')).toBeNull()
    expect(result.failed).toEqual([])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('accepts one unique category even when a continuation repeats it', async () => {
    const request = vi.fn(async () => response(page('Cup', [category('S'), category('S')])))
    expect((await queryTournamentTiers(['Cup'], request)).tiers.get('Cup')).toBe(1)
  })

  it('falls back only for missing pages, deduplicating shared parents', async () => {
    const request = vi.fn(async (url: string) => response(...titles(url).map(title => title === 'PGL/2026/Masters'
      ? page(title, [category('S')]) : { title, missing: true })))
    const paths = ['PGL/2026/Masters/Group Stage', 'PGL/2026/Masters/Playoffs/Final']
    const result = await queryTournamentTiers(paths, request)
    expect([...result.tiers]).toEqual(paths.map(path => [path, 1]))
    expect(request.mock.calls.flatMap(([url]) => titles(url)).filter(title => title === 'PGL/2026/Masters')).toHaveLength(1)
  })

  it('never removes more than two path segments and stops at a single-segment title', async () => {
    const request = vi.fn(async (url: string) => response(...titles(url).map(title => ({ title, missing: true }))))
    const result = await queryTournamentTiers(['Cup/2026/Stage/Final/Map', 'Root'], request)
    expect([...result.tiers]).toEqual([['Root', null], ['Cup/2026/Stage/Final/Map', null]])
    expect(request.mock.calls.map(([url]) => titles(url))).toEqual([
      ['Cup/2026/Stage/Final/Map', 'Root'], ['Cup/2026/Stage/Final'], ['Cup/2026/Stage'],
    ])
  })

  it('stops missing-page fallback at an existing unclassified parent', async () => {
    const request = vi.fn(async (url: string) => titles(url)[0] === 'Cup/2026/Stage'
      ? response({ title: 'Cup/2026/Stage', missing: true }) : response(page('Cup/2026')))
    expect((await queryTournamentTiers(['Cup/2026/Stage'], request)).tiers.get('Cup/2026/Stage')).toBeNull()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('retains successful batches and reports only failed original paths', async () => {
    const paths = Array.from({ length: 51 }, (_, index) => `Cup/${index}`)
    const request = vi.fn(async (url: string) => {
      if (titles(url).includes('Cup/0')) throw new Error('offline')
      return response(page('Cup/50', [category('C')]))
    })
    const result = await queryTournamentTiers(paths, request)
    expect([...result.tiers]).toEqual([['Cup/50', 4]])
    expect(result.failed).toEqual(paths.slice(0, 50))
  })

  it('attributes a failed fallback query to each dependent original child', async () => {
    const request = vi.fn(async (url: string) => {
      if (titles(url)[0] === 'Cup/2026') return { error: { code: 'maxlag' } }
      return response(...titles(url).map(title => ({ title, missing: true })))
    })
    const result = await queryTournamentTiers(['Cup/2026/Group', 'Cup/2026/Playoffs'], request)
    expect([...result.tiers]).toEqual([])
    expect(result.failed).toEqual(['Cup/2026/Group', 'Cup/2026/Playoffs'])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([
    null, {}, { error: { code: 'failed' } }, { query: { pages: {} } }, response(),
    response({ title: 'Cup', invalid: true }), response({ title: 'Cup', categories: 'changed' }),
    response({ title: 'Cup', missing: '' }), response({ title: 'Cup', categories: [{}] }),
    { query: { pages: [page('Cup')], redirects: [{ from: 'Cup', to: 'Alias' }, { from: 'Alias', to: 'Cup' }] } },
    { query: { pages: [page('Cup')] }, continue: { action: 'parse' } },
  ])('marks malformed and API error responses as failures instead of null: %#', async payload => {
    const request = vi.fn(async () => payload)
    const result = await queryTournamentTiers(['Cup'], request)
    expect(result.tiers.has('Cup')).toBe(false)
    expect(result.failed).toEqual(['Cup'])
  })

  it('fails a batch if pagination fails after an apparently successful category', async () => {
    const request = vi.fn().mockResolvedValueOnce({ ...response(page('Cup', [category('S')])), continue: { continue: '||', clcontinue: '1|A' } })
      .mockRejectedValueOnce(new Error('offline'))
    const result = await queryTournamentTiers(['Cup'], request)
    expect(result.tiers.has('Cup')).toBe(false)
    expect(result.failed).toEqual(['Cup'])
  })

  it('rejects a repeated continuation instead of looping indefinitely', async () => {
    const request = vi.fn(async () => ({ ...response(page('Cup')), continue: { continue: '||', clcontinue: '1|A' } }))
    const result = await queryTournamentTiers(['Cup'], request)
    expect(result.failed).toEqual(['Cup'])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not query an empty title list or unsafe title parameters', async () => {
    const request = vi.fn(async () => response())
    expect((await queryTournamentTiers([], request)).tiers.size).toBe(0)
    const result = await queryTournamentTiers(['', 'Cup|Injected', 'Category:Europe', 'Cup/../Other'], request)
    expect(result.failed).toEqual(['', 'Cup|Injected', 'Category:Europe', 'Cup/../Other'])
    expect(request).not.toHaveBeenCalled()
  })
})

describe('tournament URL identity', () => {
  it('preserves the complete decoded subpage and removes only the fragment', () => {
    expect(normalizeTournamentPath('https://liquipedia.net/counterstrike/EXTREMESLAND/2026/South_Asia#Group_A')).toBe('EXTREMESLAND/2026/South_Asia')
    expect(normalizeTournamentPath('/counterstrike/Intel_Extreme_Masters/2026/Krak%C3%B3w%20Final#Final')).toBe('Intel_Extreme_Masters/2026/Kraków Final')
  })
  it.each([
    'PGL Masters 2026', 'http://liquipedia.net/counterstrike/Cup', 'https://example.test/counterstrike/Cup',
    'https://liquipedia.net.example.test/counterstrike/Cup', 'https://user@liquipedia.net/counterstrike/Cup',
    '//liquipedia.net/counterstrike/Cup', 'https://liquipedia.net/dota2/Cup', '/counterstrike/Cup?oldid=1',
    '/counterstrike/Cup/../Other', '/counterstrike/Cup/%2e%2e/Other', '/counterstrike/Cup%2fOther',
    '/counterstrike/Cup/%', '/counterstrike/Cup/%00', '/counterstrike/Category:Europe', '/counterstrike/',
    '/counterstrike/Cup%7COther',
  ])('rejects an untrusted or malformed identity: %s', url => {
    expect(normalizeTournamentPath(url)).toBeNull()
  })
})
