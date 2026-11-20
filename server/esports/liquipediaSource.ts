/**
 * Discover Liquipedia Counter-Strike event pages and parse their wikitext into tournaments and matches.
 * The caller supplies the request function for Action API queries; this module performs no network I/O itself.
 */

import { validEntry } from './parser'
import { channelFromLink, type StreamChannel } from './streamChannels'
import { CATEGORY_TIERS, validTournamentTitle } from './tiers'
import type { Cs2Match } from './types'

export interface LiquipediaSourcePage { title: string; wikitext: string }
export interface LiquipediaSourceFailure { title: string; reason: string }
export interface LiquipediaSourceStream {
  platform: StreamChannel['platform']
  entry: string
  videoId: string | null
}
export interface LiquipediaSourceChannel extends StreamChannel {
  source: 'streams' | 'infobox'
  ytMultiple: boolean
}
export interface LiquipediaSourceMatch {
  opponents: [string | null, string | null]
  startsAt: number | null
  finished: boolean
  streams: LiquipediaSourceStream[]
  params: Readonly<Record<string, string>>
}
export interface LiquipediaSourceTournament {
  path: string
  name: string | null
  tier: Cs2Match['tournament']['tier']
  channels: LiquipediaSourceChannel[]
  matches: LiquipediaSourceMatch[]
  skipped: { offset: number; reason: string }[]
}

type Request = (url: string) => Promise<unknown>
const API_URL = 'https://liquipedia.net/counterstrike/api.php'
const MAX_QUERY_TURNS = 10
const QUERY_PAGE_SIZE = 50
const MAX_SOURCE_LENGTH = 2_000_000
const MAX_MATCHES = 500
const MAX_DEPTH = 64
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// Source: Liquipedia Commons wiki, Module:Timezone/Data, retrieved 2026-11-21.
const TIMEZONE_MINUTES: Readonly<Record<string, number>> = {
  ABT: -360, ACST: 570, ACDT: 630, ADT: -180, ATST: -240, AEDT: 660, AEST: 600, AKST: -540, AKDT: -480,
  ALMT: 300, AMT: 240, AQTT: 300, ART: -180, AST: 180, AZT: 240, BOT: -240, BRST: -120, BRT: -180,
  BNT: 480, BDST: 360, BST: 60, BTT: 360, CAT: 120, CEST: 120, CET: 60, COT: -300, CLST: -180, CLT: -240,
  CST: 480, CDT: -300, CT: -360, EAT: 180, ECT: -300, EDT: -240, EEST: 180, EET: 120, EST: -300, GET: 240,
  GMT: 0, GST: 240, HKT: 480, ICT: 420, IDT: 180, IRDT: 270, IRST: 210, IST: 330, JST: 540, KGT: 360,
  KST: 540, MDT: -360, MMT: 390, MSK: 180, MST: -420, MUT: 240, MVT: 300, MYT: 480, NDT: -210, NPT: 345,
  NST: -210, NZDT: 780, NZST: 720, PCT: -420, PDT: -420, PET: -300, PHST: 480, PHT: 480, PKT: 300, PST: -480,
  PYT: -240, SAST: 120, SGT: 480, THA: 420, TJT: 300, TMT: 300, TRT: 180, TST: 480, ULAT: 480, UTC: 0,
  UZT: 300, VET: -240, VLAT: 600, WAT: 60, WEST: 60, WET: 0, WIB: 420, WITA: 480,
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const titleKey = (title: string): string => title.replaceAll('_', ' ').trim()
const validTitle = (value: unknown): value is string => validTournamentTitle(value) && titleKey(value).length > 0
  && !/[\[\]{}<>]/.test(value) && !titleKey(value).split('/').some(segment => !segment.trim() || /^(?:\.|\.\.)$/.test(segment.trim()))
const reasonFor = (error: unknown): string => error instanceof Error ? error.message : String(error)

function calendarTime(year: number, month: number, day: number, hour = 0, minute = 0): number | null {
  if (year < 1000 || month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
  const time = Date.UTC(year, month, day, hour, minute)
  return new Date(time).getUTCDate() === day ? time : null
}

async function* query(params: Record<string, string>, mode: 'search' | 'revisions', request: Request) {
  let continuation: Record<string, string> = {}
  const seen = new Set<string>()
  for (let turn = 0; turn < MAX_QUERY_TURNS; turn++) {
    const url = `${API_URL}?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params, ...continuation })}`
    const payload = await request(url)
    if (!object(payload) || payload.error !== undefined || !object(payload.query)) throw new Error(`Invalid ${mode} response`)
    yield payload.query
    if (payload.continue === undefined) return
    if (!object(payload.continue) || !Object.keys(payload.continue).length) throw new Error(`Invalid ${mode} continuation`)
    continuation = {}
    for (const [key, value] of Object.entries(payload.continue)) {
      if (mode === 'search' && key === 'sroffset' && ((typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        || (typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))))) {
        continuation[key] = String(Number(value))
      } else if ((key === 'continue' || (mode === 'revisions' && key === 'rvcontinue')) && typeof value === 'string') {
        continuation[key] = value
      } else throw new Error(`Invalid ${mode} continuation`)
    }
    const token = JSON.stringify(Object.entries(continuation).sort(([left], [right]) => left.localeCompare(right)))
    if (seen.has(token)) throw new Error(`Repeated ${mode} continuation`)
    seen.add(token)
  }
  throw new Error(`Too many ${mode} continuations`)
}

/** Dates are calendar dates in YYYY-MM-DD, not instants or local Date objects. */
export async function searchLiquipediaSource(dates: readonly string[], request: Request): Promise<{
  titles: string[]; failed: { date: string; reason: string }[]
}> {
  const titles = new Map<string, string>(), failed: { date: string; reason: string }[] = []
  for (const date of new Set(dates)) {
    try {
      const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
      if (!parts || calendarTime(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) === null) throw new Error('Invalid calendar date')
      const phrase = `${MONTHS[Number(parts[2]) - 1]} ${Number(parts[3])}, ${parts[1]}`
      const found: string[] = []
      for await (const result of query({ list: 'search', srsearch: `insource:"${phrase}"`, srnamespace: '0',
        srwhat: 'text', srlimit: String(QUERY_PAGE_SIZE) }, 'search', request)) {
        if (!Array.isArray(result.search) || result.search.length > QUERY_PAGE_SIZE) throw new Error('Invalid search results')
        for (const hit of result.search) {
          if (!object(hit) || !validTitle(hit.title) || (hit.ns !== undefined && hit.ns !== 0)) throw new Error('Invalid search hit')
          found.push(hit.title)
        }
      }
      for (const title of found) if (!titles.has(titleKey(title))) titles.set(titleKey(title), title)
    } catch (error) { failed.push({ date, reason: reasonFor(error) }) }
  }
  return { titles: [...titles.values()], failed }
}

function pageContent(page: Record<string, unknown>): string | undefined {
  if (page.invalid !== undefined || (page.ns !== undefined && page.ns !== 0)
    || (page.missing !== undefined && typeof page.missing !== 'boolean')) throw new Error('Invalid revisions page')
  if (page.missing) throw new Error('Page is missing')
  if (page.revisions === undefined) return undefined
  const revision = Array.isArray(page.revisions) && page.revisions.length === 1 ? page.revisions[0] : null
  const main = object(revision) && object(revision.slots) ? revision.slots.main : null
  if (!object(main) || typeof main.content !== 'string' || (main.contentmodel !== undefined && main.contentmodel !== 'wikitext')) {
    throw new Error('Missing or invalid wikitext revision')
  }
  return main.content
}

async function readBatch(titles: readonly string[], request: Request) {
  const aliases = new Map<string, string>()
  const pages = new Map<string, LiquipediaSourcePage>()
  const failures = new Map<string, string>()
  const returned = new Set<string>()
  for await (const result of query({ prop: 'revisions', rvprop: 'content|ids|timestamp', rvslots: 'main',
    redirects: '1', titles: titles.join('|') }, 'revisions', request)) {
    if (!Array.isArray(result.pages) || result.pages.length > QUERY_PAGE_SIZE) throw new Error('Invalid revisions pages')
    for (const name of ['normalized', 'redirects']) {
      const mappings = result[name]
      if (mappings === undefined) continue
      if (!Array.isArray(mappings)) throw new Error('Invalid revisions title mappings')
      for (const mapping of mappings) {
        if (!object(mapping) || !validTitle(mapping.from) || !validTitle(mapping.to)) throw new Error('Invalid revisions title mapping')
        const from = titleKey(mapping.from), to = titleKey(mapping.to)
        if (from === to) continue
        if (aliases.has(from) && aliases.get(from) !== to) failures.set(from, 'Conflicting revisions title mappings')
        else aliases.set(from, to)
      }
    }
    for (const page of result.pages) {
      if (!object(page) || !validTitle(page.title)) throw new Error('Invalid revisions page title')
      const key = titleKey(page.title)
      returned.add(key)
      try {
        const wikitext = pageContent(page)
        if (wikitext === undefined) continue
        const previous = pages.get(key)
        if (previous && previous.wikitext !== wikitext) throw new Error('Conflicting wikitext revisions')
        pages.set(key, { title: page.title, wikitext })
      } catch (error) { failures.set(key, reasonFor(error)) }
    }
  }
  return titles.map(title => {
    let key = titleKey(title)
    const seen = new Set<string>()
    while (!failures.has(key) && aliases.has(key)) {
      if (seen.has(key)) return { title, reason: 'Cyclic revisions title mappings' }
      seen.add(key)
      key = aliases.get(key)!
    }
    const reason = failures.get(key)
    if (reason !== undefined) return { title, reason }
    return pages.get(key) ?? { title, reason: returned.has(key) ? 'Missing wikitext revision' : 'Requested page not returned' }
  })
}

export async function readLiquipediaSource(titles: readonly string[], request: Request): Promise<{
  pages: LiquipediaSourcePage[]; failed: LiquipediaSourceFailure[]
}> {
  const pending = new Map<string, string[]>(), failed: LiquipediaSourceFailure[] = []
  const pages = new Map<string, LiquipediaSourcePage>()
  for (const title of new Set(titles)) {
    if (!validTitle(title)) { failed.push({ title, reason: 'Invalid tournament title' }); continue }
    const key = titleKey(title)
    const originals = pending.get(key)
    if (originals) originals.push(title)
    else pending.set(key, [title])
  }
  const groups = [...pending.values()]
  for (let start = 0; start < groups.length; start += QUERY_PAGE_SIZE) {
    const batch = groups.slice(start, start + QUERY_PAGE_SIZE)
    try {
      const results = await readBatch(batch.map(group => group[0]!), request)
      for (const [index, result] of results.entries()) {
        if ('reason' in result) for (const title of batch[index]!) failed.push({ title, reason: result.reason })
        else pages.set(titleKey(result.title), result)
      }
    } catch (error) {
      for (const title of batch.flat()) failed.push({ title, reason: reasonFor(error) })
    }
  }
  return { pages: [...pages.values()], failed }
}

function matchTime(value: string | undefined): number | null {
  const parts = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s*-\s*(\d{1,2}):(\d{2})\s*\{\{\s*Abbr\/([A-Z]+)\s*\}\}$/i.exec(value ?? '')
  if (!parts) return null
  const offset = TIMEZONE_MINUTES[parts[6]!.toUpperCase()]
  if (offset === undefined) return null
  const time = calendarTime(Number(parts[3]), MONTHS.findIndex(month => month.toLowerCase() === parts[1]!.toLowerCase()),
    Number(parts[2]), Number(parts[4]), Number(parts[5]))
  return time === null ? null : time - offset * 60_000
}

function opponent(value: string | undefined): string | null {
  if (!value?.endsWith('}}')) return null
  const name = /^\{\{\s*TeamOpponent\s*\|\s*(?:1\s*=\s*)?([^|{}\[\]<>\r\n=]+)\s*(?=[|]|\}\})/i.exec(value)?.[1]?.trim()
  return !name || /^tbd$/i.test(name) ? null : name
}

function sourceMatch(params: Record<string, string>, values: Record<string, string>): LiquipediaSourceMatch {
  if (!Object.keys(values).some(key => key && !/^\d+$/.test(key))) {
    throw new Error('Missing match parameters')
  }
  const streams: LiquipediaSourceStream[] = []
  for (const platform of ['twitch', 'youtube'] as const) {
    const value = values[platform]
    if (!value) continue
    const parts = value.split('/')
    const entry = parts[0]!, videoId = parts[1] || null
    if (parts.length > 2 || !validEntry(entry) || (videoId !== null && (platform !== 'youtube' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)))) {
      throw new Error(`Invalid ${platform} stream registration`)
    }
    streams.push({ platform, entry, videoId })
  }
  return {
    opponents: [opponent(values.opponent1), opponent(values.opponent2)], startsAt: matchTime(values.date),
    finished: /^(?:true|yes|1)$/i.test(values.finished ?? ''), streams, params,
  }
}

function sourceTier(value: string | undefined): LiquipediaSourceTournament['tier'] {
  const code = /^([SABC])-Tier$/i.exec(value ?? '')?.[1]?.toUpperCase() as keyof typeof CATEGORY_TIERS | undefined
  if (code) return CATEGORY_TIERS[code]
  return /^(?:[1-4]|-1)$/.test(value ?? '') ? Number(value) as 1 | 2 | 3 | 4 | -1 : null
}

function sourceChannel(platform: StreamChannel['platform'], value: string): StreamChannel | null {
  if (!value || value.length > 2_000 || /[\s\x00-\x1f\x7f\\{}\[\]<>]/.test(value)) return null
  const host = platform === 'youtube' ? 'www.youtube.com' : 'www.twitch.tv'
  const link = /^https?:\/\//i.test(value) ? value : value.startsWith('//') ? `https:${value}`
    : `https://${host}/${value}`
  const channel = channelFromLink(link)
  return channel?.platform === platform ? channel : null
}

interface TemplateFields {
  name: string
  params: Record<string, string>
  values: Record<string, string>
  start: number | null
  equals: number | null
  position: number
}

interface Frame { kind: 'template' | 'variable' | 'link'; offset: number; fields?: TemplateFields }

function closedLinks(source: string): Set<number> {
  const open: number[] = [], closed = new Set<number>()
  for (const token of source.matchAll(/\[\[|\]\]/g)) {
    if (token[0] === '[[') {
      if (open.length >= MAX_DEPTH) throw new Error('Wikitext nesting limit exceeded')
      open.push(token.index)
    } else if (open.length) closed.add(open.pop()!)
  }
  return closed
}

/** Scan supported templates without expanding them or inspecting the markup inside opaque regions. */
export function parseLiquipediaSource(page: LiquipediaSourcePage): LiquipediaSourceTournament {
  if (!validTitle(page.title)) throw new Error('Invalid tournament title')
  const raw = page.wikitext
  if (typeof raw !== 'string' || raw.length > MAX_SOURCE_LENGTH) throw new Error('Wikitext size limit exceeded')
  const source = raw.replace(/<!--(?:[\s\S]*?-->|[\s\S]*$)|<nowiki(?=[\s/>])[^<>]*\/\s*>|<nowiki(?=[\s/>])[^<>]*>(?:[\s\S]*?<\/nowiki\s*>|[\s\S]*$)/gi,
    opaque => ' '.repeat(opaque.length))
  const links = closedLinks(source)
  const result: LiquipediaSourceTournament = {
    path: titleKey(page.title).replaceAll(' ', '_'), name: null, tier: null, channels: [], matches: [], skipped: [],
  }
  const channels = new Map<string, LiquipediaSourceChannel>()
  const stack: Frame[] = []
  const delimiters = /\{\{\{(?!\{)|\{\{|\}\}\}?|\[\[|\]\]|[|=]/g
  const templateName = /\s*(Match|Infobox[ _]+league|HiddenDataBox|Streams)\s*(?=[|]|\}\})/iy
  let matchCount = 0, activeMatch = -1
  let infoboxValues: Record<string, string> | undefined, hiddenValues: Record<string, string> | undefined
  const field = (fields: TemplateFields, end: number) => {
    if (fields.start === null) return
    const key = fields.equals === null ? String(++fields.position) : source.slice(fields.start, fields.equals).trim()
    const start = fields.equals === null ? fields.start : fields.equals + 1
    fields.params[key] = raw.slice(start, end)
    fields.values[key] = source.slice(start, end).trim()
  }
  const emit = (fields: TemplateFields, offset: number) => {
    const { name, params, values } = fields
    if (name === 'match') {
      try { result.matches.push(sourceMatch(params, values)) }
      catch (error) { result.skipped.push({ offset, reason: reasonFor(error) }) }
      return
    }
    if (name === 'hiddendatabox') { hiddenValues ??= values; return }
    const infobox = name !== 'streams'
    if (infobox) infoboxValues ??= values
    for (const [key, value] of Object.entries(values)) {
      const parts = (infobox ? /^(youtube|twitch)$/ : /^(youtube|twitch)([1-9]\d*)$/).exec(key)
      if (!parts) continue
      const channel = sourceChannel(parts[1] as StreamChannel['platform'], value)
      if (!channel) continue
      const origin = infobox ? 'infobox' : 'streams'
      const identity = `${origin}:${channel.platform}:${channel.name.toLowerCase()}`
      const ytMultiple = channel.platform === 'youtube' && !infobox && /^(?:true|yes|1)$/i.test(values[`ytmultiple${parts[2]}`] ?? '')
      const previous = channels.get(identity)
      if (previous) previous.ytMultiple ||= ytMultiple
      else channels.set(identity, { ...channel, source: origin, ytMultiple })
    }
  }

  for (let token = delimiters.exec(source); token; token = delimiters.exec(source)) {
    const offset = token.index, delimiter = token[0]
    const top = stack.at(-1)
    if (delimiter === '{{' || delimiter === '{{{' || delimiter === '[[') {
      templateName.lastIndex = offset + 2
      let name = delimiter === '{{' ? templateName.exec(source)?.[1]?.toLowerCase() : undefined
      if (name && stack.some(frame => frame.kind === 'link' && links.has(frame.offset))) name = undefined
      if (name === 'match' && activeMatch >= 0) {
        result.skipped.push({ offset: stack[activeMatch]!.offset, reason: 'Unclosed Match template' })
        stack.length = activeMatch
        activeMatch = -1
      }
      if (name && stack.some(frame => frame.kind === 'link')) name = undefined
      if (name === 'match') {
        if (++matchCount > MAX_MATCHES) throw new Error('Match record limit exceeded')
        activeMatch = stack.length
      }
      if (stack.length >= MAX_DEPTH) throw new Error('Wikitext nesting limit exceeded')
      const fields = name ? { name, params: Object.create(null), values: Object.create(null), start: null, equals: null, position: 0 } : undefined
      stack.push({ kind: delimiter === '[[' ? 'link' : delimiter === '{{{' ? 'variable' : 'template', offset, fields })
    } else if (top && (top.kind === 'template' && delimiter.startsWith('}}')
      || top.kind === 'variable' && delimiter === '}}}' || top.kind === 'link' && delimiter === ']]')) {
      if (top.kind === 'template' && delimiter === '}}}') delimiters.lastIndex--
      stack.pop()
      if (top.fields) {
        if (top.fields.name === 'match') activeMatch = -1
        field(top.fields, offset)
        emit(top.fields, top.offset)
      }
    } else if (top?.fields) {
      if (delimiter === '|') {
        field(top.fields, offset)
        top.fields.start = offset + 1
        top.fields.equals = null
      } else if (delimiter === '=' && top.fields.start !== null && top.fields.equals === null) top.fields.equals = offset
    }
  }
  if (activeMatch >= 0) result.skipped.push({ offset: stack[activeMatch]!.offset, reason: 'Unclosed Match template' })
  const metadata = infoboxValues ?? hiddenValues
  result.name = metadata?.name?.replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim() || null
  result.tier = sourceTier(metadata?.liquipediatier)
  result.channels = [...channels.values()].sort((left, right) => Number(left.source === 'infobox') - Number(right.source === 'infobox'))
  return result
}

export async function loadLiquipediaSource(dates: readonly string[], request: Request): Promise<{
  tournaments: LiquipediaSourceTournament[]
  failedDates: { date: string; reason: string }[]
  failedReads: LiquipediaSourceFailure[]
  failedParses: LiquipediaSourceFailure[]
}> {
  const search = await searchLiquipediaSource(dates, request)
  const read = await readLiquipediaSource(search.titles, request)
  const tournaments: LiquipediaSourceTournament[] = [], failedParses: LiquipediaSourceFailure[] = []
  for (const page of read.pages) {
    try { tournaments.push(parseLiquipediaSource(page)) }
    catch (error) { failedParses.push({ title: page.title, reason: reasonFor(error) }) }
  }
  return { tournaments, failedDates: search.failed, failedReads: read.failed, failedParses }
}
