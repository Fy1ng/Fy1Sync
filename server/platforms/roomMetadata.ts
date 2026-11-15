import type { SavedRoom, SavedRoomMetadata } from '../../electron/featureContracts'
import type { RoomMetadataCollector } from '../../electron/savedRoomsMonitor'
import { SavedRoomImages } from '../../electron/savedRoomImages'
import { savedRoomInput } from '../../src/core/savedRoomIdentity'
import { parseDouyinInput } from '../../src/core/douyinInput'
import { type ProxyConfig, hostAllowed } from '../config'
import { safeFetch } from '../safeFetch'
import { networkContext } from '../networkPolicy'
import { readPlatformText } from '../platformResponse'
import { parseDouyuRoom, type ResolveDouyuRoom } from './douyuRoom'
import { parseBilibiliRoom } from './bilibili'
import { jsonAfter, parseHuyaRoom } from './huya'
import { parseTwitchChannel } from './twitch'
import { parseYouTubeUrl } from './youtube'
import { parseDouyinPage, parseDouyinWebResponse, asRecord, type DouyinRoomData } from './douyinPage'
import type { PlatformKind } from './types'

type Metadata = Omit<SavedRoomMetadata, 'collectedAt' | 'startTimeSource'>
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36'
const HOSTS: Record<string, string[]> = {
  douyu: ['m.douyu.com', 'www.douyu.com', 'apic.douyucdn.cn', '*.douyucdn.cn', '*.douyucdn2.cn'],
  bilibili: ['api.live.bilibili.com', '*.hdslb.com'],
  huya: ['www.huya.com', 'huya.com', '*.huya.com', '*.msstatic.com'],
  douyin: ['live.douyin.com', 'v.douyin.com', 'webcast.amemv.com', '*.douyinpic.com', '*.douyincdn.com', '*.byteimg.com', '*.bytecdn.cn'],
  twitch: ['gql.twitch.tv', 'static-cdn.jtvnw.net'],
  youtube: ['www.youtube.com', 'youtube.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com', 'i.ytimg.com'],
}
const fail = (): never => { throw new Error('无法确认平台返回的直播间资料.') }
const text = (value: unknown, max = 500): string => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, max) : ''
const id = (value: unknown): string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : ''
export function metadataTime(value: unknown, now: number): number | null {
  let time: number
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    // Locale timestamps without an offset use the platform's China time zone.
    const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + '+08:00' : value
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(normalized)) return null
    time = Date.parse(normalized)
  } else {
    const numeric = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
    time = numeric < 100_000_000_000 ? numeric * 1000 : numeric
  }
  return Number.isSafeInteger(time) && time >= 946_684_800_000 && time <= now ? time : null
}
function imageUrl(value: unknown, platform: string): string | null {
  const raw = text(value, 2048)
  if (!raw) return null
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || !hostAllowed(url.hostname, HOSTS[platform] ?? [])) return null
    url.protocol = 'https:'
    return url.href
  } catch { return null }
}

export function douyuMetadata(raw: unknown, expected: string, now: number): Metadata {
  const payload = asRecord(raw), data = asRecord(payload.data)
  if (payload.error !== 0 || id(data.room_id) !== expected) return fail()
  const flag = String(data.show_status)
  if (!['0', '1', '2'].includes(flag)) return fail()
  const replay = [data.videoLoop, data.video_loop, data.is_loop, asRecord(data.room_biz_all).videoLoop].some(value => value === 1 || value === '1')
  return { roomId: expected, url: `https://www.douyu.com/${expected}`, nickname: text(data.nickname, 200),
    title: text(data.room_name), avatarUrl: imageUrl(typeof data.avatar === 'string' ? data.avatar : asRecord(data.avatar).big ?? data.avatar_big ?? data.owner_avatar, 'douyu'), coverUrl: null,
    status: flag === '1' ? replay ? 'replay' : 'live' : 'offline', lastStartedAt: metadataTime(data.show_time, now) }
}

export function bilibiliMetadata(raw: unknown, now: number): Metadata {
  const payload = asRecord(raw), data = asRecord(payload.data), room = asRecord(data.room_info), anchor = asRecord(asRecord(data.anchor_info).base_info)
  const roomId = id(room.room_id), status = room.live_status
  if (payload.code !== 0 || !roomId || ![0, 1, 2].includes(status as number)) return fail()
  return { roomId, url: `https://live.bilibili.com/${roomId}`, nickname: text(anchor.uname, 200), title: text(room.title),
    avatarUrl: imageUrl(anchor.face, 'bilibili'), coverUrl: null,
    status: status === 1 ? 'live' : status === 2 ? 'replay' : 'offline', lastStartedAt: metadataTime(room.live_start_time, now) }
}

export function huyaMetadata(html: string, now: number): Metadata {
  const page = html.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&amp;/g, '&')
  const room = asRecord(jsonAfter(page, /\bTT_ROOM_DATA\s*=\s*/, 65_536))
  const profile = asRecord(jsonAfter(page, /\bTT_PROFILE_INFO\s*=\s*/, 65_536))
  const roomId = id(room.profileRoom)
  if (!roomId || !['ON', 'OFF', 'REPLAY'].includes(String(room.state))) return fail()
  return { roomId, url: `https://www.huya.com/${roomId}`, nickname: text(profile.nick ?? room.nick, 200),
    title: text(room.introduction ?? room.roomName), avatarUrl: imageUrl(profile.avatar180 ?? profile.avatar ?? room.avatar180, 'huya'), coverUrl: null,
    status: room.state === 'OFF' ? 'offline' : room.state === 'REPLAY' || room.isReplay === true || room.isReplay === 1 ? 'replay' : 'live',
    lastStartedAt: metadataTime(room.liveStartTime ?? room.startTime, now) }
}

export function twitchMetadata(raw: unknown, expected: string, now: number): Metadata {
  const payload = asRecord(raw), user = asRecord(asRecord(payload.data).user)
  const stream = asRecord(user.stream)
  if (payload.errors || !id(user.id) || text(user.login).toLowerCase() !== expected || !Object.hasOwn(user, 'stream')) return fail()
  if (user.stream !== null && !id(stream.id)) return fail()
  return { roomId: text(user.login).toLowerCase(), url: `https://www.twitch.tv/${expected}`, nickname: text(user.displayName, 200),
    avatarUrl: imageUrl(user.profileImageURL, 'twitch'), title: text(stream.title ?? asRecord(user.broadcastSettings).title), coverUrl: null,
    status: user.stream === null ? 'offline' : stream.type === 'rerun' ? 'replay' : stream.type === 'live' ? 'live' : 'unknown',
    lastStartedAt: metadataTime(stream.createdAt, now) }
}

export function douyinMetadata(room: DouyinRoomData, now: number): Metadata {
  const roomId = room.webRoom
  if (!roomId || ![2, '2', 4, '4'].includes(room.status as number)) return fail()
  return { roomId, url: `https://live.douyin.com/${roomId}`, nickname: text(room.nickname, 200),
    title: text(room.title), avatarUrl: imageUrl(room.avatarUrl, 'douyin'), coverUrl: null,
    status: room.status === 2 || room.status === '2' ? 'live' : 'offline', lastStartedAt: metadataTime(room.startedAt, now) }
}

/** Only one bounded data tree is traversed; recommendation and playback scripts never run. */
function findRecord(root: unknown, name: string): Record<string, unknown> | null {
  const stack: unknown[] = [root]
  let budget = 20_000
  while (stack.length && --budget > 0) {
    const value = stack.pop()
    if (!value || typeof value !== 'object') continue
    const record = asRecord(value)
    if (record[name] && typeof record[name] === 'object') return asRecord(record[name])
    stack.push(...Object.values(value).reverse())
  }
  return null
}
const ytText = (value: unknown): string => {
  const row = asRecord(value)
  return text(row.simpleText ?? (Array.isArray(row.runs) ? row.runs.map(item => text(asRecord(item).text)).join('') : ''))
}

export function youtubeMetadata(html: string, url: string, now: number): Metadata {
  const player = asRecord(youtubeData(html, 'ytInitialPlayerResponse'))
  const details = asRecord(player.videoDetails), live = asRecord(asRecord(player.microformat).playerMicroformatRenderer)
  const broadcast = asRecord(live.liveBroadcastDetails)
  const channelId = text(details.channelId)
  if (channelId && /^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    if (details.isLiveContent !== true) return fail()
    const status = broadcast.isLiveNow === true ? 'live'
      : broadcast.endTimestamp || asRecord(player.playabilityStatus).status === 'LIVE_STREAM_OFFLINE' ? 'offline' : 'unknown'
    const data = youtubeData(html, 'ytInitialData')
    const owner = findRecord(data, 'videoOwnerRenderer')
    const thumbnails = asRecord(owner?.thumbnail).thumbnails
    return { roomId: channelId, url: `https://www.youtube.com/channel/${channelId}/live`, nickname: text(details.author, 200),
      title: text(details.title), avatarUrl: imageUrl(Array.isArray(thumbnails) ? asRecord(thumbnails.at(-1)).url : null, 'youtube'),
      coverUrl: null, status, lastStartedAt: metadataTime(broadcast.startTimestamp, now) }
  }
  // A channel with no current broadcast still exposes its own identity and profile.
  // The caller reads /streams (not the /live error page) before accepting offline.
  if (!new URL(url).pathname.endsWith('/streams')) return fail()
  const data = asRecord(youtubeData(html, 'ytInitialData'))
  const metadata = asRecord(asRecord(data.metadata).channelMetadataRenderer)
  const channel = text(metadata.externalId)
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channel) || !data.contents) return fail()
  const thumbnails = asRecord(metadata.avatar).thumbnails
  // A populated channel page alone cannot prove offline: require the selected streams tab.
  const selected = findSelectedTab(data.contents)
  if (!selected) return fail()
  const contents = JSON.stringify(selected.content ?? {})
  const liveNow = /"style":"BADGE_STYLE_TYPE_LIVE_NOW"|"style":"LIVE"/.test(contents)
  return { roomId: channel, url: `https://www.youtube.com/channel/${channel}/live`, nickname: text(metadata.title, 200),
    title: ytText(findRecord(selected.content, 'videoRenderer')?.title), avatarUrl: imageUrl(Array.isArray(thumbnails) ? asRecord(thumbnails.at(-1)).url : null, 'youtube'), coverUrl: null,
    status: liveNow ? 'live' : 'offline', lastStartedAt: null }
}
function findSelectedTab(root: unknown): Record<string, unknown> | null {
  const stack: unknown[] = [root]
  let budget = 20_000
  while (stack.length && --budget > 0) {
    const value = stack.pop()
    if (!value || typeof value !== 'object') continue
    const tab = asRecord(asRecord(value).tabRenderer)
    if (tab.selected === true) return tab
    stack.push(...Object.values(value).reverse())
  }
  return null
}

/** Parse complete JSON assignments, without evaluating any surrounding JavaScript. */
function youtubeData(html: string, variable: string): unknown {
  if (Buffer.byteLength(html) > 2_097_152) return undefined
  const assignment = new RegExp(`^(?:var\\s+)?${variable}\\s*=\\s*`)
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const body = script[1]!.trim()
    const match = assignment.exec(body)
    if (!match) continue
    try { return JSON.parse(body.slice(match[0].length).replace(/;\s*$/, '')) as unknown }
    catch { return undefined }
  }
  return undefined
}

export function createRoomMetadataCollector(options: { proxy: ProxyConfig; userDataDir: string; resolveRoom: ResolveDouyuRoom; now?: () => number }): RoomMetadataCollector {
  const images = new SavedRoomImages(options.userDataDir)
  return async (room: SavedRoom, signal: AbortSignal): Promise<SavedRoomMetadata> => {
    const platform = room.platform
    if (!HOSTS[platform] || !options.proxy.enabled) return fail()
    const now = (options.now ?? Date.now)()
    const input = savedRoomInput(platform, room.metadata?.url ?? room.input)
    const request = async (url: string, init?: RequestInit): Promise<{ response: Response; finalUrl: string }> => {
      const result = await safeFetch(url, { ...options.proxy, hosts: HOSTS[platform]!, maxRedirects: 3, allowNonStandardPorts: false }, {
        signal, network: networkContext(platform as PlatformKind), method: init?.method,
        body: typeof init?.body === 'string' ? init.body : undefined,
        headers: { 'User-Agent': AGENT, ...Object.fromEntries(new Headers(init?.headers).entries()) },
      })
      if (!result.response.ok) { await result.response.body?.cancel(); return fail() }
      return { response: result.response, finalUrl: result.finalUrl.href }
    }
    const read = async (url: string, init?: RequestInit) => {
      const result = await request(url, init)
      return { text: await readPlatformText(result.response, signal), finalUrl: result.finalUrl }
    }
    const json = async (url: string, init?: RequestInit): Promise<unknown> => JSON.parse((await read(url, init)).text) as unknown
    let result: Metadata
    if (platform === 'douyu') {
      const identity = await options.resolveRoom(input)
      if (!identity.ok || !parseDouyuRoom(identity.identity.room)) return fail()
      result = douyuMetadata(await json(`https://www.douyu.com/swf_api/h5room/${identity.identity.room}`), identity.identity.room, now)
    } else if (platform === 'bilibili') {
      const target = parseBilibiliRoom(input)
      if (!target) return fail()
      try { result = bilibiliMetadata(await json(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${target}`, { headers: { Referer: `https://live.bilibili.com/${target}` } }), now) }
      catch {
        if (signal.aborted) return fail()
        const legacy = asRecord(await json(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${target}`))
        const info = asRecord(legacy.data)
        if (legacy.code !== 0 || !id(info.room_id)) return fail()
        const anchor = asRecord(await json(`https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=${info.room_id as number}`))
        if (anchor.code !== 0) return fail()
        result = bilibiliMetadata({ code: 0, data: { room_info: { ...info, live_start_time: info.live_time }, anchor_info: { base_info: asRecord(anchor.data).info } } }, now)
      }
    } else if (platform === 'huya') {
      const target = parseHuyaRoom(input)
      if (!target) return fail()
      result = huyaMetadata((await read(`https://www.huya.com/${target}`)).text, now)
    } else if (platform === 'twitch') {
      const target = parseTwitchChannel(input)
      if (!target) return fail()
      result = twitchMetadata(await json('https://gql.twitch.tv/gql', { method: 'POST', headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'query RoomMetadata($login:String!){user(login:$login){id login displayName profileImageURL(width:150) broadcastSettings{title} stream{id title type createdAt}}}', variables: { login: target } }) }), target, now)
    } else if (platform === 'douyin') {
      const target = parseDouyinInput(input)
      if (!target) return fail()
      const page = await read(target.url)
      const final = parseDouyinInput(page.finalUrl)
      let data = parseDouyinPage(page.text, target.kind === 'room' ? target.room : final?.kind === 'room' ? final.room : undefined)
      const webRoom = data?.webRoom ?? (target.kind === 'room' ? target.room : final?.kind === 'room' ? final.room : undefined)
      if (!data && webRoom) data = parseDouyinWebResponse(await json(`https://live.douyin.com/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1&device_platform=web&web_rid=${webRoom}`), webRoom)
      if (!data) return fail()
      result = douyinMetadata(data, now)
    } else {
      const target = parseYouTubeUrl(input)
      if (!target) return fail()
      let page = await read(target)
      try { result = youtubeMetadata(page.text, target, now) }
      catch {
        if (!target.endsWith('/live')) throw new Error('无法读取 YouTube 直播资料.')
        const streams = target.slice(0, -5) + '/streams'
        page = await read(streams)
        result = youtubeMetadata(page.text, streams, now)
      }
    }
    // Avatar failures preserve the previous local image while other metadata can refresh.
    let avatarUrl = room.metadata?.avatarUrl ?? null
    if (result.avatarUrl) {
      try { avatarUrl = await images.cache(result.avatarUrl, async url => (await request(url)).response, signal) ?? avatarUrl }
      catch { if (signal.aborted) throw new Error('Metadata request cancelled') }
    }
    if (signal.aborted) return fail()
    return { ...result, nickname: result.nickname || room.metadata?.nickname || '', title: result.title || room.metadata?.title || '',
      avatarUrl, collectedAt: (options.now ?? Date.now)(), startTimeSource: result.lastStartedAt === null ? null : 'platform' }
  }
}
