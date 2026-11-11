/** Validated public Douyin inputs. Web room ids and reflow room ids are distinct. */
export type DouyinInput =
  | { kind: 'room'; room: string; url: string }
  | { kind: 'share'; url: string }
  | { kind: 'reflow'; room: string; url: string }

const ROOM = /^[1-9][0-9]{0,19}$/
const CONTROLS = /[\x00-\x1f\x7f]/
const HOSTS = new Set(['live.douyin.com', 'v.douyin.com', 'webcast.amemv.com'])
// Only share identity context is forwarded. Redirect targets and tracking are not needed.
const SHARE_CONTEXT = new Set([
  'sec_user_id', 'app_id', 'live_id', 'share_id', 'share_user_id', 'share_app_id',
  'share_link_id', 'u_code',
])
const TRAILING_PUNCTUATION = /[.,!?;:，。！？；：、…）)\]】}>》」』]+$/u
const URL_START = /(?<![A-Za-z0-9_:/@.\-])(?:[a-z][a-z0-9+.-]*:\/\/|(?:live\.douyin\.com|v\.douyin\.com|webcast\.amemv\.com)\/)/giu

/** Parse one room/link, or one supported link embedded in a share caption. */
export function parseDouyinInput(raw: string): DouyinInput | null {
  if (raw.length > 8192 || CONTROLS.test(raw)) return null
  const input = raw.trim()
  if (!input) return null
  if (ROOM.test(input)) return { kind: 'room', room: input, url: `https://live.douyin.com/${input}` }

  const links = Array.from(input.matchAll(URL_START))
  if (links.length !== 1) return null
  const candidate = links[0]!
  // A malformed standalone address must not become a valid link by removing its prefix.
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && candidate.index !== 0) return null
  const link = /^[^\s<>"'“”‘’]+/u.exec(input.slice(candidate.index))?.[0]
  return link ? parseLink(link.replace(TRAILING_PUNCTUATION, '')) : null
}

function parseLink(input: string): DouyinInput | null {
  let url: URL
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`) }
  catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || !HOSTS.has(url.hostname.toLowerCase())
    || url.username || url.password || url.port || input.includes('\\')) return null

  const host = url.hostname.toLowerCase()
  const room = /^\/([1-9][0-9]{0,19})\/?$/.exec(url.pathname)?.[1]
  if (host === 'live.douyin.com') {
    if (!room) return null
    return { kind: 'room', room, url: `https://live.douyin.com/${room}` }
  }

  const reflow = /^\/(?:douyin\/)?webcast\/reflow\/([1-9][0-9]{0,19})\/?$/.exec(url.pathname)?.[1]
  if (host === 'webcast.amemv.com' && !reflow) return null
  if (host === 'v.douyin.com' && !/^\/[A-Za-z0-9_-]{1,64}\/?$/.test(url.pathname)) return null
  const query = new URLSearchParams()
  for (const [key, value] of url.searchParams) {
    if (!SHARE_CONTEXT.has(key)) continue
    if (query.has(key) || !value || value.length > 1024 || CONTROLS.test(value)
      || !/^[A-Za-z0-9_.=-]+$/.test(value)) return null
    query.set(key, value)
  }
  url.protocol = 'https:'
  url.hash = ''
  url.search = query.toString()
  if (host === 'webcast.amemv.com') return { kind: 'reflow', room: reflow!, url: url.href }
  return { kind: 'share', url: url.href }
}
