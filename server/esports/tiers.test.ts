import { describe, expect, it } from 'vitest'
import sTier from './fixtures/liquipedia-s-tier.json'
import aTier from './fixtures/liquipedia-a-tier.json'
import bTier from './fixtures/liquipedia-b-tier.json'
import { lookupTier, normalizeTournamentPath, parseTierPage, TIER_PAGES, TierFormatError, type TournamentTier } from './tiers'

const htmlPayload = (html: string) => ({ parse: { text: { '*': html } } })
const changed = (from: string, to: string) => htmlPayload(aTier.parse.text['*'].replaceAll(from, to))

describe('Liquipedia tournament tier listing parsing', () => {
  it.each([
    ['S', sTier, ['PGL/2026/Singapore', 'PGL/2026/Masters', 'Intel_Extreme_Masters/2026/Kraków']],
    ['A', aTier, ['Stake_Ranked/Episode_5', 'PGL/2026/Bucharest']],
    ['B', bTier, ['Moscow_Cyber_Games/2026', 'Tesla_Cup/2026', 'NODWIN_Gaming/Clutch_Series/13']],
  ])('reads only retained %s-tier tournament rows', (_tier, fixture, paths) => {
    expect(parseTierPage(fixture)).toEqual(paths)
  })
  it('ignores real game icons, team placements and region links in the retained rows', () => {
    expect(sTier.parse.text['*']).toContain('/counterstrike/Team_Vitality')
    expect(aTier.parse.text['*']).toContain('/counterstrike/Counter-Strike_2')
    expect(bTier.parse.text['*']).toContain('/counterstrike/Category:Europe')
    const paths = [sTier, aTier, bTier].flatMap(parseTierPage)
    expect(paths).not.toContain('Team_Vitality')
    expect(paths).not.toContain('FUT_Esports')
    expect(paths).not.toContain('Counter-Strike_2')
    expect(paths).not.toContain('Category:Europe')
  })
  it('ignores navigation, unrelated tables, headers and icon links even when they resemble tournaments', () => {
    // Synthetic interference surrounds the unchanged captured A-tier listing.
    const fakeRow = '<tr class="table2__row--body"><td class="column__tournament"><a href="/counterstrike/Navigation/2026">Navigation</a></td></tr>'
    const navigation = `<nav><a href="/counterstrike/S-Tier_Tournaments">S</a><table class="table2__table"><tbody>${fakeRow}</tbody></table></nav>`
    const html = navigation + aTier.parse.text['*'].replace('<th colspan="2">Tournament</th>', '<th colspan="2"><a href="/counterstrike/Header/2026">Tournament</a></th>')
      .replace('/counterstrike/Counter-Strike_2', '/counterstrike/Icon/2026')
    expect(parseTierPage(htmlPayload(html))).toEqual(parseTierPage(aTier))
  })
  it('deduplicates tournament paths from repeated listing rows', () => {
    expect(parseTierPage(htmlPayload(aTier.parse.text['*'].repeat(2)))).toEqual(parseTierPage(aTier))
  })
  it('reuses the observed table layout for an explicitly synthetic C-tier sample', () => {
    const syntheticC = {
      parse: { title: 'C-Tier Tournaments (synthetic layout sample)', text: { '*': aTier.parse.text['*']
        .replaceAll('/counterstrike/Stake_Ranked/Episode_5', '/counterstrike/Synthetic_C/2026')
        .replaceAll('/counterstrike/PGL/2026/Bucharest', '/counterstrike/Synthetic_C/2025') } },
    }
    expect(parseTierPage(syntheticC)).toEqual(['Synthetic_C/2026', 'Synthetic_C/2025'])
    expect(TIER_PAGES).toEqual(['S-Tier_Tournaments', 'A-Tier_Tournaments', 'B-Tier_Tournaments', 'C-Tier_Tournaments'])
  })
  it.each([
    [null, 'parse.text.*'],
    [htmlPayload('<p>Unknown layout</p>'), '.tournaments-listing table.table2__table'],
    [changed('table2&#95;&#95;row--body', 'removed-row'), 'tr.table2__row--body'],
    [changed('column&#95;&#95;tournament', 'removed-column'), 'td.column__tournament'],
    [changed('href="/counterstrike/Stake_Ranked/Episode_5"', 'href="https://example.test/counterstrike/Stake_Ranked/Episode_5"'), 'a[href]'],
  ])('reports the failed selector instead of exposing partial membership: %#', (payload, selector) => {
    let error: unknown
    try { parseTierPage(payload) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(TierFormatError)
    expect((error as TierFormatError).selector).toContain(selector)
  })
  it('rejects ambiguous tournament columns and unexpected wrapping of their primary links', () => {
    expect(() => parseTierPage(changed('>Stake Ranked Episode 5</a>', '>Stake Ranked Episode 5</a><a href="/counterstrike/Other">Other</a>'))).toThrow(TierFormatError)
    const wrapped = aTier.parse.text['*'].replace(/(<td class="column&#95;&#95;tournament"[^>]*>)(<a[^>]*>[^<]*<\/a>)/, '$1<span>$2</span>')
    expect(() => parseTierPage(htmlPayload(wrapped))).toThrow(TierFormatError)
  })
})

describe('tournament URL identity and tier lookup', () => {
  const tiers = new Map<string, TournamentTier>([
    ['PGL/2026/Masters', 1], ['PGL/2026/Masters/Group_Stage', 2], ['Stake_Ranked/Episode_5', 2],
    ['Tesla_Cup/2026', 3], ['Synthetic_C/2026', 4], ['Intel_Extreme_Masters/2026/Kraków', 1],
  ])
  it('looks up the full path before parent paths and removes the anchor', () => {
    expect(lookupTier('https://liquipedia.net/counterstrike/PGL/2026/Masters#Round_3', tiers)).toBe(1)
    expect(lookupTier('https://liquipedia.net/counterstrike/PGL/2026/Masters/Group_Stage#Group_A', tiers)).toBe(2)
    expect(lookupTier('https://liquipedia.net/counterstrike/Stake_Ranked/Episode_5', tiers)).toBe(2)
    expect(lookupTier('https://liquipedia.net/counterstrike/Tesla_Cup/2026', tiers)).toBe(3)
    expect(lookupTier('https://liquipedia.net/counterstrike/Synthetic_C/2026', tiers)).toBe(4)
  })
  it('falls back by one or two path segments, but never by three', () => {
    expect(lookupTier('https://liquipedia.net/counterstrike/PGL/2026/Masters/Playoffs', tiers)).toBe(1)
    expect(lookupTier('https://liquipedia.net/counterstrike/PGL/2026/Masters/Playoffs/Final', tiers)).toBe(1)
    expect(lookupTier('https://liquipedia.net/counterstrike/PGL/2026/Masters/Playoffs/Final/Map_1', tiers)).toBeNull()
  })
  it('normalizes percent-encoded wiki paths identically for parsing and lookup', () => {
    expect(normalizeTournamentPath('/counterstrike/Intel_Extreme_Masters/2026/Krak%C3%B3w')).toBe('Intel_Extreme_Masters/2026/Kraków')
    expect(lookupTier('https://liquipedia.net/counterstrike/Intel_Extreme_Masters/2026/Krak%c3%b3w#Final', tiers)).toBe(1)
  })
  it('does not guess a tier from a name, sibling event or unrelated path', () => {
    expect(lookupTier('PGL Masters Bucharest 2026', tiers)).toBeNull()
    expect(lookupTier('https://liquipedia.net/counterstrike/PGL/2027/Masters', tiers)).toBeNull()
    expect(lookupTier('https://liquipedia.net/counterstrike/Unknown/2026', tiers)).toBeNull()
  })
  it.each([
    'http://liquipedia.net/counterstrike/PGL/2026/Masters',
    'https://liquipedia.net.example.test/counterstrike/PGL/2026/Masters',
    'https://example.test/counterstrike/PGL/2026/Masters',
    'https://user@liquipedia.net/counterstrike/PGL/2026/Masters',
    '//liquipedia.net/counterstrike/PGL/2026/Masters',
    'https://liquipedia.net/dota2/PGL/2026/Masters',
    'https://liquipedia.net/counterstrike/PGL/2026/Masters?oldid=1',
    '/counterstrike/PGL/2026/Masters/../Masters',
    '/counterstrike/PGL/2026/Masters/%2e%2e/Masters',
    '/counterstrike/PGL/2026%2fMasters',
    '/counterstrike/PGL/2026/Masters/%',
    '/counterstrike/PGL/2026/Masters/%00',
    '/counterstrike/Category:Europe',
    '/counterstrike/',
  ])('rejects an untrusted or malformed URL identity: %s', url => {
    expect(normalizeTournamentPath(url)).toBeNull()
    expect(lookupTier(url, tiers)).toBeNull()
  })
})
