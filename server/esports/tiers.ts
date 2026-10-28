export type TournamentTier = 1 | 2 | 3 | 4

const CATEGORY_TIERS = { S: 1, A: 2, B: 3, C: 4 } as const
const CATEGORIES = Object.keys(CATEGORY_TIERS).map(tier => `Category:${tier}-Tier Tournaments`).join('|')
const API_URL = 'https://liquipedia.net/counterstrike/api.php'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const titleKey = (title: string): string => title.replaceAll('_', ' ')
const validTitle = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2_000
  && !/[\x00-\x1f\x7f\\|#?]/.test(value) && !value.split('/').some(segment => !segment || segment === '.' || segment === '..')
  && !value.split('/')[0]!.includes(':')

/** A wiki path is an identity, not a tournament name. Never accept another origin or namespace. */
export function normalizeTournamentPath(value: string): string | null {
  if (!value || value.length > 2_000 || /[\x00-\x20\x7f\\]/.test(value)
    || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|[?#]|$)/i.test(value)) return null
  if (!value.startsWith('/counterstrike/') && !value.startsWith('https://')) return null
  try {
    const url = new URL(value, 'https://liquipedia.net')
    if (url.origin !== 'https://liquipedia.net' || url.username || url.password || url.search || !url.pathname.startsWith('/counterstrike/')) return null
    const segments = url.pathname.slice('/counterstrike/'.length).split('/').map(segment => decodeURIComponent(segment))
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\x00-\x1f\x7f\\/?#|]/.test(segment))
      || segments[0]!.includes(':')) return null
    return segments.join('/')
  } catch { return null }
}

interface PageCategories { missing: boolean; tiers: Set<TournamentTier> }
interface TierPage { missing: boolean; tier: TournamentTier | null }

/** Consume every category continuation before deciding whether a page is unclassified or conflicting. */
async function queryBatch(paths: readonly string[], request: (url: string) => Promise<unknown>): Promise<Map<string, TierPage>> {
  const aliases = new Map<string, string>(), pages = new Map<string, PageCategories>()
  const seen = new Set<string>()
  let continuation: Record<string, string> = {}
  for (let turn = 0; ; turn++) {
    if (turn >= 100) throw new Error('Too many tier query continuations')
    const params = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', prop: 'categories',
      redirects: '1', cllimit: 'max', clcategories: CATEGORIES, titles: paths.join('|'), ...continuation })
    const payload = await request(`${API_URL}?${params}`)
    if (!object(payload) || payload.error !== undefined || !object(payload.query) || !Array.isArray(payload.query.pages)) {
      throw new Error('Invalid tier query response')
    }
    for (const name of ['normalized', 'redirects']) {
      const entries = payload.query[name]
      if (entries === undefined) continue
      if (!Array.isArray(entries)) throw new Error('Invalid tier title mappings')
      for (const entry of entries) {
        if (!object(entry) || !validTitle(entry.from) || !validTitle(entry.to)) throw new Error('Invalid tier title mapping')
        const from = titleKey(entry.from), to = titleKey(entry.to)
        if (from === to) continue
        if (aliases.has(from) && aliases.get(from) !== to) throw new Error('Conflicting tier title mappings')
        aliases.set(from, to)
      }
    }
    for (const page of payload.query.pages) {
      if (!object(page) || !validTitle(page.title) || page.invalid !== undefined
        || (page.missing !== undefined && typeof page.missing !== 'boolean')
        || (page.categories !== undefined && !Array.isArray(page.categories))) throw new Error('Invalid tier query page')
      const key = titleKey(page.title), missing = page.missing === true
      let current = pages.get(key)
      if (current && current.missing !== missing) throw new Error('Inconsistent tier query page')
      if (!current) { current = { missing, tiers: new Set() }; pages.set(key, current) }
      for (const category of page.categories ?? []) {
        if (!object(category) || typeof category.title !== 'string') throw new Error('Invalid tier query category')
        const match = /^Category:([SABC])-Tier Tournaments$/.exec(category.title)
        if (match) current.tiers.add(CATEGORY_TIERS[match[1] as keyof typeof CATEGORY_TIERS])
      }
    }
    if (payload.continue === undefined) break
    if (!object(payload.continue) || !Object.keys(payload.continue).length
      || Object.entries(payload.continue).some(([key, value]) => !/^(?:continue|[a-z]+continue)$/.test(key) || typeof value !== 'string')) {
      throw new Error('Invalid tier query continuation')
    }
    continuation = payload.continue as Record<string, string>
    const token = JSON.stringify(Object.entries(continuation).sort(([left], [right]) => left.localeCompare(right)))
    if (seen.has(token)) throw new Error('Repeated tier query continuation')
    seen.add(token)
  }
  const result = new Map<string, TierPage>()
  for (const path of paths) {
    let key = titleKey(path)
    const visited = new Set<string>()
    while (aliases.has(key)) {
      if (visited.has(key)) throw new Error('Cyclic tier title mappings')
      visited.add(key); key = aliases.get(key)!
    }
    const page = pages.get(key)
    if (!page) throw new Error('Missing requested tier query page')
    result.set(titleKey(path), { missing: page.missing, tier: page.tiers.size === 1 ? [...page.tiers][0]! : null })
  }
  return result
}

/** Only a genuinely missing page can inherit a parent, at most two segments above the original path. */
export async function queryTournamentTiers(paths: readonly string[], request: (url: string) => Promise<unknown>): Promise<{
  tiers: Map<string, TournamentTier | null>; failed: string[]
}> {
  const tiers = new Map<string, TournamentTier | null>(), failed = new Set<string>()
  const pending = new Map<string, { path: string; depth: number }>()
  const known = new Map<string, TierPage | null>()
  for (const path of new Set(paths)) {
    if (!validTitle(path)) { failed.add(path); continue }
    pending.set(path, { path, depth: 0 })
  }
  while (pending.size) {
    const titles = [...new Map([...pending.values()].filter(value => !known.has(titleKey(value.path)))
      .map(value => [titleKey(value.path), value.path])).values()]
    for (let start = 0; start < titles.length; start += 50) {
      const batch = titles.slice(start, start + 50)
      try { for (const [key, page] of await queryBatch(batch, request)) known.set(key, page) }
      catch { for (const path of batch) known.set(titleKey(path), null) }
    }
    for (const [original, state] of pending) {
      const page = known.get(titleKey(state.path))
      if (!page) { failed.add(original); pending.delete(original); continue }
      if (!page.missing) { tiers.set(original, page.tier); pending.delete(original); continue }
      const slash = state.path.lastIndexOf('/')
      if (state.depth >= 2 || slash < 0) { tiers.set(original, null); pending.delete(original); continue }
      pending.set(original, { path: state.path.slice(0, slash), depth: state.depth + 1 })
    }
  }
  return { tiers, failed: [...failed] }
}
