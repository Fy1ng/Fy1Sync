import { createHash } from 'node:crypto'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import type { Cs2Match, Cs2Stream, Cs2Team } from './types'
import { normalizeLogoPath } from './teamLogos'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
const element = (node: Node): node is Element => 'tagName' in node
const children = (node: Node): Node[] => 'childNodes' in node ? node.childNodes : []
const attr = (node: Node, name: string): string | undefined => element(node) ? node.attrs.find(a => a.name === name)?.value : undefined
const hasClass = (node: Node, name: string): boolean => (attr(node, 'class') ?? '').split(/\s+/).includes(name)
function all(node: Node, predicate: (node: Node) => boolean): Node[] {
  const found: Node[] = [], stack = [node]
  while (stack.length) {
    const next = stack.pop()!
    if (predicate(next)) found.push(next)
    stack.push(...children(next).toReversed())
  }
  return found
}
const byClass = (node: Node, name: string): Node[] => all(node, n => hasClass(n, name))
function rawText(node: Node): string { return 'value' in node ? node.value : children(node).map(rawText).join('') }
function text(node: Node): string { return rawText(node).replace(/\s+/g, ' ').trim() }

export class ScheduleFormatError extends Error {
  constructor(readonly selector: string) { super('赛程格式已变化, 暂时无法读取'); this.name = 'ScheduleFormatError' }
}
const fail = (selector: string): never => { throw new ScheduleFormatError(selector) }
function one(nodes: Node[], selector: string): Node { return nodes.length === 1 ? nodes[0]! : fail(selector) }
function bounded(value: string, selector: string, limit = 500): string {
  if (!value || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) return fail(selector)
  return value
}

function team(node: Node): Cs2Team {
  const names = byClass(node, 'name')
  if (!names.length) {
    const literal = one(byClass(node, 'brkts-opponent-block-literal'), '.match-info-header-opponent .name or .brkts-opponent-block-literal')
    const label = text(literal).replace(/[\u200b\ufeff]/g, '').trim()
    return { name: label ? bounded(label, '.brkts-opponent-block-literal') : 'TBD', short: null, logo: null }
  }
  const name = one(names, '.match-info-header-opponent .name')
  const anchors = children(name).filter(n => element(n) && n.tagName === 'a' && attr(n, 'title') !== undefined)
  if (anchors.length === 0 && text(name) === 'TBD') return { name: 'TBD', short: null, logo: null }
  const anchor = one(anchors, '.name > a[title]')
  const full = bounded((attr(anchor, 'title') ?? '').replace(/ \(page does not exist\)$/, ''), '.name > a[title]')
  const short = bounded(text(anchor), '.name > a[title] text')
  return { name: full, short: short === full ? null : short, logo: null }
}

/** Scope the icon search to the opponent's team block, never the tournament container. */
export function teamLogoPath(node: Node): string | null {
  const candidates: Array<{ path: string; priority: number }> = []
  for (const block of byClass(node, 'block-team')) for (const icon of byClass(block, 'team-template-image-icon')) {
    for (const image of all(icon, value => element(value) && value.tagName === 'img')) {
      // Tournament icons carry wiki paths in alt; team icons use an empty alt.
      if ((attr(image, 'alt') ?? '').includes('/')) continue
      const source = normalizeLogoPath(attr(image, 'src'))
      if (!source) continue
      const twoX = (attr(image, 'srcset') ?? '').split(',').map(value => /^\s*(\S+)\s+2x\s*$/.exec(value)?.[1])
        .map(value => normalizeLogoPath(value)).find(value => value !== null)
      const path = twoX ?? source
      const marker = `${attr(icon, 'class') ?? ''} ${path}`.toLowerCase()
      const priority = marker.includes('darkmode') ? 3 : marker.includes('allmode') ? 2 : marker.includes('lightmode') ? 1 : 2
      candidates.push({ path, priority })
    }
  }
  return candidates.sort((a, b) => b.priority - a.priority)[0]?.path ?? null
}

function tier(node: Node): Cs2Match['tournament']['tier'] {
  // The global filter buttons are not per-match metadata. Never infer a tier from them.
  let current: Node | null = node
  while (current) {
    const raw = attr(current, 'data-liquipediatier') ?? attr(current, 'data-filter-liquipediatier')
      ?? (attr(current, 'data-filter-group') === 'filterbuttons-liquipediatier' ? attr(current, 'data-filter-category') : undefined)
    if (raw !== undefined) return /^(?:[1-4]|-1)$/.test(raw) ? Number(raw) as 1 | 2 | 3 | 4 | -1 : null
    const parent: Node | null = 'parentNode' in current ? current.parentNode : null
    if (!parent || byClass(parent, 'match-info').length !== 1) break
    current = parent
  }
  return null
}

function streams(node: Node): Cs2Stream[] {
  const links = one(byClass(node, 'match-info-links'), '.match-info-links')
  const result = new Map<string, Cs2Stream>()
  for (const anchor of all(links, n => element(n) && n.tagName === 'a')) {
    const href = attr(anchor, 'href') ?? ''
    if (!href.startsWith('/counterstrike/Special:Stream/')) continue
    const parts = href.slice('/counterstrike/Special:Stream/'.length).split('/')
    const platform = parts[0]
    if (platform !== 'youtube' && platform !== 'twitch') continue
    let channel: string
    try { channel = decodeURIComponent(parts[1] ?? '') } catch { return fail('.match-info-links stream channel') }
    const videoId = parts[2] || null
    if (parts.length > 3 || !validChannel(platform, channel) || (videoId !== null && !/^[A-Za-z0-9_-]{11}$/.test(videoId))
      || (platform === 'twitch' && videoId !== null)) return fail('.match-info-links stream URL')
    const url = platform === 'twitch' ? `https://www.twitch.tv/${encodeURIComponent(channel)}`
      : videoId ? `https://www.youtube.com/watch?v=${videoId}` : `https://www.youtube.com/@${encodeURIComponent(channel.replace(/^@/, ''))}/live`
    result.set(`${platform}:${channel}:${videoId}`, { platform, channel, videoId, url })
  }
  return [...result.values()]
}

export function validChannel(platform: 'youtube' | 'twitch', channel: unknown): channel is string {
  return typeof channel === 'string' && (platform === 'twitch' ? /^[A-Za-z0-9_]{3,25}$/.test(channel)
    : /^@?[\p{L}\p{N}_.-]{1,100}$/u.test(channel))
}

/**
 * Parse the whole payload before exposing any matches.
 *
 * One odd match (a scoreboard Liquipedia left half-filled, say) is skipped and reported through
 * `onSkip`, so it cannot take the other ninety down with it. Selector drift breaks every match,
 * not one, so the response is still refused when nothing parses or most matches fail.
 */
export function parseSchedule(payload: unknown, logoPaths?: Map<string, string>,
  onSkip?: (selector: string) => void): Cs2Match[] {
  const html = (payload as { parse?: { text?: { '*'?: unknown } } } | null)?.parse?.text?.['*']
  if (typeof html !== 'string' || html.length > 2_000_000) return fail('parse.text.*')
  const nodes = byClass(parse(html), 'match-info')
  if (!nodes.length || nodes.length > 500) return fail('.match-info')
  const skipped: string[] = []
  const matches = nodes.flatMap((node): Cs2Match[] => {
    const pending = new Map<string, string>()
    try {
      const match = parseMatch(node, pending)
      for (const [key, path] of pending) logoPaths?.set(key, path)
      return [match]
    } catch (error) {
      if (!(error instanceof ScheduleFormatError)) throw error
      skipped.push(error.selector)
      return []
    }
  })
  // Drift fails everywhere; a few bad matches is the page, not the parser.
  if (!matches.length || skipped.length * 2 > nodes.length) return fail(skipped[0] ?? '.match-info')
  for (const selector of skipped) onSkip?.(selector)
  if (new Set(matches.map(match => match.id)).size !== matches.length) return fail('.match-info duplicate identity')
  return matches
}

function parseMatch(node: Node, logoPaths: Map<string, string>): Cs2Match {
  const timer = one(byClass(node, 'timer-object'), '.timer-object[data-timestamp]')
  const rawTime = attr(timer, 'data-timestamp') ?? ''
  const startsAt = Number(rawTime) * 1000
  if (!/^\d{9,11}$/.test(rawTime) || !Number.isSafeInteger(startsAt)) return fail('.timer-object[data-timestamp]')
  const opponents = byClass(node, 'match-info-header-opponent')
  if (opponents.length !== 2) return fail('.match-info-header-opponent')
  const teams: [Cs2Team, Cs2Team] = [team(opponents[0]!), team(opponents[1]!)]
  const scoreText = text(one(byClass(node, 'match-info-header-scoreholder-upper'), '.match-info-header-scoreholder-upper')).replace(/\s/g, '')
  const parsedScore = /^(\d{1,2}):(\d{1,2})$/.exec(scoreText)
  // A bare divider (both score cells empty) is a match without a score yet, like 'vs'.
  if (scoreText !== 'vs' && scoreText !== ':' && !parsedScore) return fail('.match-info-header-scoreholder-upper score')
  const score: [number, number] | null = parsedScore ? [Number(parsedScore[1]), Number(parsedScore[2])] : null
  const lower = byClass(node, 'match-info-header-scoreholder-lower')
  if (lower.length > 1) return fail('.match-info-header-scoreholder-lower')
  const bestOfText = lower.length ? text(lower[0]!) : ''
  const bo = /^\(Bo(\d{1,2})\)$/i.exec(bestOfText)
  if (bestOfText && !bo) return fail('.match-info-header-scoreholder-lower bestOf')
  const bestOf = bo ? Number(bo[1]) : null
  const tournamentNode = one(byClass(node, 'match-info-tournament-name'), '.match-info-tournament-name')
  const tournamentLink = one(all(tournamentNode, n => element(n) && n.tagName === 'a' && attr(n, 'href') !== undefined), '.match-info-tournament-name a[href]')
  const titleNode = one(all(tournamentLink, n => element(n) && n.tagName === 'span'), '.match-info-tournament-name span')
  const fullName = bounded(text(titleNode), '.match-info-tournament-name span')
  const href = attr(tournamentLink, 'href') ?? ''
  if (!href.startsWith('/counterstrike/') || /[\x00-\x20\\]/.test(href)) return fail('.match-info-tournament-name a[href]')
  const url = new URL(href, 'https://liquipedia.net').href
  const split = fullName.lastIndexOf(' - ')
  const name = split < 0 ? fullName : fullName.slice(0, split)
  const stage = split < 0 ? null : fullName.slice(split + 3) || null
  const finished = attr(timer, 'data-finished') === 'finished' || byClass(node, 'match-info-header-winner').length > 0
  const state: Cs2Match['state'] = finished ? 'finished' : score ? 'live' : 'upcoming'
  const id = createHash('sha256').update(JSON.stringify([url, startsAt, ...teams.map(t => t.name)])).digest('hex').slice(0, 24)
  const result: Cs2Match = { id, startsAt, state, teams, score, bestOf, tournament: { name, stage, tier: tier(node), url }, streams: streams(node) }
  opponents.forEach((opponent, index) => { const path = teamLogoPath(opponent); if (path) logoPaths.set(`${id}:${index}`, path) })
  return result
}

export function currentMatches(matches: Cs2Match[], now: number): Cs2Match[] {
  return matches.filter(match => match.startsAt >= now - 12 * 60 * 60_000 && match.startsAt <= now + 48 * 60 * 60_000)
    .sort((a, b) => Number(b.state === 'live') - Number(a.state === 'live') || a.startsAt - b.startsAt || a.id.localeCompare(b.id))
}
