/**
 * Which channel a schedule stream is on.
 *
 * Liquipedia's `Special:Stream/<platform>/<entry>` names an entry in its stream registry, not a
 * channel: `twitch/Gamers_Club` is broadcast on twitch.tv/gamersclubcs, while twitch.tv/gamers_club
 * is another, idle channel. The registry sits behind a human check, so the channel is looked for
 * among the external links on the event's own page (its streams table lists them) and paired
 * with the entry by name.
 */

import { parseTwitchChannel } from '../platforms/twitch'
import { parseYouTubeUrl } from '../platforms/youtube'

export interface StreamChannel {
  platform: 'twitch' | 'youtube'
  /** The login, `@handle`, old-style name or channel id, as the link gave it. */
  name: string
  /** The channel's live page. */
  url: string
}
export interface EventChannels { twitch: StreamChannel[]; youtube: StreamChannel[] }

const API_URL = 'https://liquipedia.net/counterstrike/api.php'
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'])
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])
/** Tabs of a YouTube channel page that still mean the channel. */
const YOUTUBE_TAB = /\/(?:live|streams|videos|featured|about)\/?$/i

/** One plain query for a page's external links; the page's streams table comes first among them. */
export function channelLinksUrl(path: string): string {
  return `${API_URL}?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', prop: 'extlinks',
    ellimit: 'max', redirects: '1', titles: path })}`
}

/** A link to a channel's own page, as that channel. Videos, clips and other sites are not channels. */
export function channelFromLink(link: string): StreamChannel | null {
  let url: URL
  try { url = new URL(link) } catch { return null }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  if (TWITCH_HOSTS.has(host)) {
    const login = parseTwitchChannel(`https://www.twitch.tv${url.pathname}`)
    return login ? { platform: 'twitch', name: login, url: `https://www.twitch.tv/${login}` } : null
  }
  if (!YOUTUBE_HOSTS.has(host)) return null
  // The query is dropped on purpose: watch?v=… is a video, not the channel.
  const live = parseYouTubeUrl(`https://www.youtube.com${url.pathname.replace(YOUTUBE_TAB, '')}`)
  if (!live?.endsWith('/live')) return null
  let name: string
  try { name = decodeURIComponent(new URL(live).pathname.split('/').at(-2)!) } catch { return null }
  return { platform: 'youtube', name, url: live }
}

/** The channels linked from a page, once each. A response that is not a page listing is refused. */
export function eventChannels(payload: unknown): EventChannels {
  const pages = (payload as { query?: { pages?: unknown } } | null)?.query?.pages
  if (!Array.isArray(pages) || (payload as { error?: unknown }).error !== undefined) throw new Error('Invalid channel links response')
  const result: EventChannels = { twitch: [], youtube: [] }
  const seen = new Set<string>()
  for (const page of pages) {
    const links = (page as { extlinks?: unknown } | null)?.extlinks
    if (links === undefined) continue
    if (!Array.isArray(links)) throw new Error('Invalid channel links response')
    for (const link of links.slice(0, 500)) {
      const url = (link as { url?: unknown } | null)?.url
      const channel = typeof url === 'string' && url.length <= 2_000 ? channelFromLink(url) : null
      if (!channel) continue
      const key = `${channel.platform}:${channel.name.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      result[channel.platform].push(channel)
    }
  }
  return result
}

/** Letters and digits only, lower case: `PGL_CS2`, `PGL CS2` and `pgl_cs2` read the same. */
const plain = (value: string): string => value.replace(/^@/, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** Registry names whose current channel names differ, verified against IEM's event links. */
const ENTRY_CHANNEL_NAMES = new Map([
  ['eslcounterstrike', 'eslcs'],
  ['eslcounterstrikeb', 'eslcsb'],
])

/**
 * The channel an entry stands for among the event's channels on that platform, or null when it
 * cannot be told: the same name (`PGL_CS2` → pgl_cs2), else the one channel whose name contains
 * the entry's (`Gamers_Club` → gamersclubcs), else the event's only channel. Known registry
 * aliases require their exact channel among the event links, preserving the broadcast stage.
 * Other entries are never shortened to a channel inside them: `PGL 2` is not `PGL`.
 */
export function matchChannel(entry: string, channels: readonly StreamChannel[]): StreamChannel | null {
  const wanted = plain(entry)
  const alias = ENTRY_CHANNEL_NAMES.get(wanted)
  const rules = [(name: string) => name === wanted, (name: string) => alias
    ? name === alias : wanted.length >= 3 && name.includes(wanted)]
  for (const rule of wanted ? rules : []) {
    const found = channels.filter(channel => rule(plain(channel.name)))
    if (found.length === 1) return found[0]!
    if (found.length > 1) return null
  }
  return !alias && channels.length === 1 ? channels[0]! : null
}
