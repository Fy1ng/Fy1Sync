import { parse, type DefaultTreeAdapterMap } from 'parse5'

export type TournamentTier = 1 | 2 | 3 | 4
export const TIER_PAGES = ['S-Tier_Tournaments', 'A-Tier_Tournaments', 'B-Tier_Tournaments', 'C-Tier_Tournaments'] as const

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
const isElement = (node: Node): node is Element => 'tagName' in node
const children = (node: Node): Node[] => 'childNodes' in node ? node.childNodes : []
const attr = (node: Node, name: string): string | undefined => isElement(node) ? node.attrs.find(value => value.name === name)?.value : undefined
const hasClass = (node: Node, name: string): boolean => (attr(node, 'class') ?? '').split(/\s+/).includes(name)
function all(node: Node, predicate: (value: Node) => boolean): Node[] {
  const result: Node[] = [], stack = [node]
  while (stack.length) {
    const value = stack.pop()!
    if (predicate(value)) result.push(value)
    stack.push(...children(value).toReversed())
  }
  return result
}

const TABLE_SELECTOR = '.tournaments-listing table.table2__table'
const ROW_SELECTOR = `${TABLE_SELECTOR} > tbody > tr.table2__row--body`
const LINK_SELECTOR = `${ROW_SELECTOR} > td.column__tournament > a[href]`

export class TierFormatError extends Error {
  constructor(readonly selector: string) { super('赛事级别格式已变化, 暂时无法读取'); this.name = 'TierFormatError' }
}
const fail = (selector: string): never => { throw new TierFormatError(selector) }

/** A wiki path is an identity, not a tournament name. Never accept another origin or namespace. */
export function normalizeTournamentPath(value: string): string | null {
  if (!value || value.length > 2_000 || /[\x00-\x20\x7f\\]/.test(value)
    || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|[?#]|$)/i.test(value)) return null
  if (!value.startsWith('/counterstrike/') && !value.startsWith('https://')) return null
  try {
    const url = new URL(value, 'https://liquipedia.net')
    if (url.origin !== 'https://liquipedia.net' || url.username || url.password || url.search || !url.pathname.startsWith('/counterstrike/')) return null
    const segments = url.pathname.slice('/counterstrike/'.length).split('/').map(segment => decodeURIComponent(segment))
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\x00-\x1f\x7f\\/?#]/.test(segment))
      || segments[0]!.includes(':')) return null
    return segments.join('/')
  } catch { return null }
}

/** Only the named tournament column in genuine listing body rows establishes membership. */
export function parseTierPage(payload: unknown): string[] {
  const html = (payload as { parse?: { text?: { '*'?: unknown } } } | null)?.parse?.text?.['*']
  if (typeof html !== 'string' || html.length > 2_000_000) return fail('parse.text.*')
  const root = parse(html)
  const listings = all(root, node => hasClass(node, 'tournaments-listing'))
  const tables = new Set(listings.flatMap(listing => all(listing, node => isElement(node) && node.tagName === 'table' && hasClass(node, 'table2__table'))))
  if (!tables.size) return fail(TABLE_SELECTOR)
  const result = new Set<string>()
  for (const table of tables) {
    const rows = children(table).filter(node => isElement(node) && node.tagName === 'tbody')
      .flatMap(body => children(body).filter(node => isElement(node) && node.tagName === 'tr' && hasClass(node, 'table2__row--body')))
    if (!rows.length) return fail(ROW_SELECTOR)
    for (const row of rows) {
      const cells = children(row).filter(node => isElement(node) && node.tagName === 'td' && hasClass(node, 'column__tournament'))
      if (cells.length !== 1) return fail(`${ROW_SELECTOR} > td.column__tournament`)
      const anchors = children(cells[0]!).filter(node => isElement(node) && node.tagName === 'a' && attr(node, 'href') !== undefined)
      if (anchors.length !== 1) return fail(LINK_SELECTOR)
      const path = normalizeTournamentPath(attr(anchors[0]!, 'href')!)
      if (path === null) return fail(LINK_SELECTOR)
      result.add(path)
    }
  }
  return [...result]
}

export function lookupTier(url: string, tiers: ReadonlyMap<string, TournamentTier>): TournamentTier | null {
  let path = normalizeTournamentPath(url)
  if (path === null) return null
  for (let removed = 0; removed <= 2; removed++) {
    const tier = tiers.get(path)
    if (tier !== undefined) return tier
    const slash = path.lastIndexOf('/')
    if (slash < 0) break
    path = path.slice(0, slash)
  }
  return null
}
