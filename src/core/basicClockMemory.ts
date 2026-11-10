/** Small, local-only clock-region memories keyed by source identity, never by a signed playback URL. */
import type { RoiRect } from './profileSchema'
import type { MediaDescriptor } from './types'

export interface BasicClockMemoryEntry {
  key: string
  roi: RoiRect
  aspectRatio: number
  updatedAt: number
}

export const BASIC_CLOCK_MEMORY_LIMIT = 64
const ASPECT_TOLERANCE = .005
const KEY_PATTERN = /^clock-v1:(?:youtube|twitch|douyu|bilibili|huya|direct|file|test):[a-f0-9]{16}$/

/** FNV-1a over UTF-16 bytes is an opaque local identifier, not a security primitive. */
function sourceHash(value: string): string {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    hash = BigInt.asUintN(64, (hash ^ BigInt(unit & 255)) * 0x100000001b3n)
    hash = BigInt.asUintN(64, (hash ^ BigInt(unit >>> 8)) * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

function keyFor(platform: string, identity: string): string {
  return `clock-v1:${platform}:${sourceHash(identity)}`
}

export function basicClockFileKey(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  if (!file.name || file.name.length > 1024 || !Number.isSafeInteger(file.size) || file.size < 0
    || !Number.isSafeInteger(file.lastModified) || file.lastModified < 0) return ''
  return keyFor('file', JSON.stringify([file.name, file.size, file.lastModified]))
}

function sourceUrl(input: string): URL | null {
  try {
    if (!/^https?:\/\//i.test(input) && !/^(?:[^:/?#]+\.[^:/?#]+|localhost)(?::\d+)?(?:[/?#]|$)/i.test(input)) return null
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch { return null }
}

function hostIs(host: string, domain: string): boolean { return host === domain || host.endsWith(`.${domain}`) }

/** Stable platform identity comes from the requested page or confirmed video room. */
export function basicClockSourceKey(descriptor: MediaDescriptor | null): string | null {
  if (!descriptor) return null
  if (descriptor.kind === 'file' || descriptor.platform === 'file') {
    const key = descriptor.recognitionSourceKey
    return typeof key === 'string' && /^clock-v1:file:[a-f0-9]{16}$/.test(key) ? key : null
  }
  const platform = descriptor.platform
  if (platform === 'douyu' || platform === 'huya' || platform === 'bilibili') {
    const room = descriptor.sourceRoom?.trim()
    if (room && room.length <= 200) return keyFor(platform, room.toLowerCase())
  }
  const input = descriptor.input.trim()
  if (!input || input.length > 16_384) return null
  if (/^\/test-sources\/[\w/.-]+$/.test(input) && !input.split('/').includes('..')) return keyFor('test', input)
  if (input.startsWith('/')) return null
  if (platform === 'douyu' || platform === 'huya' || platform === 'bilibili') {
    if (/^[1-9]\d{0,11}$/.test(input)) return keyFor(platform, input)
  }
  const url = sourceUrl(input)
  if (!url) return null
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)
  if (hostIs(host, 'youtube.com') || hostIs(host, 'youtu.be')) {
    const video = hostIs(host, 'youtu.be') ? parts[0]
      : parts[0] === 'watch' ? url.searchParams.get('v') ?? undefined
        : ['live', 'embed', 'shorts'].includes(parts[0] ?? '') ? parts[1] : undefined
    if (video && /^[a-z0-9_-]{6,64}$/i.test(video)) return keyFor('youtube', `video:${video}`)
    if (((parts[0]?.startsWith('@') && parts[0].length > 1)
      || (['channel', 'c', 'user'].includes(parts[0] ?? '') && parts[1])) && parts.length <= 3) {
      const identity = parts[0]!.startsWith('@') ? parts[0]!.toLowerCase() : parts.slice(0, 2).join('/')
      return identity ? keyFor('youtube', `channel:${identity}`) : null
    }
    return null
  }
  if (hostIs(host, 'twitch.tv')) {
    if (!parts.length) return null
    if (host === 'clips.twitch.tv') return keyFor('twitch', `clip:${parts.join('/')}`)
    return keyFor('twitch', [parts[0]!.toLowerCase(), ...parts.slice(1)].join('/'))
  }
  for (const [domain, roomPlatform] of [['douyu.com', 'douyu'], ['huya.com', 'huya'], ['live.bilibili.com', 'bilibili']] as const) {
    if (!hostIs(host, domain)) continue
    const room = roomPlatform === 'douyu' ? url.searchParams.get('rid') || parts[0] : parts[0]
    return room ? keyFor(roomPlatform, room.toLowerCase()) : null
  }
  // A generic direct URL may select its stream through query parameters. Preserve them in
  // the hash while keeping credentials, tokens and the URL itself out of saved settings.
  if (platform && !['direct', 'test'].includes(platform)) return null
  url.hash = ''
  return keyFor('direct', url.href)
}

function validEntry(value: unknown): BasicClockMemoryEntry | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const raw = value as Record<string, unknown>
    if (typeof raw.key !== 'string' || !KEY_PATTERN.test(raw.key)
      || typeof raw.aspectRatio !== 'number' || !Number.isFinite(raw.aspectRatio) || raw.aspectRatio <= 0
      || typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0 || raw.updatedAt > Number.MAX_SAFE_INTEGER
      || !raw.roi || typeof raw.roi !== 'object' || Array.isArray(raw.roi)) return null
    const roi = raw.roi as Record<string, unknown>
    if (![roi.x, roi.y, roi.w, roi.h].every(value => typeof value === 'number' && Number.isFinite(value))) return null
    const rect = roi as unknown as RoiRect
    if (rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 || rect.x >= 1 || rect.y >= 1
      || rect.x + rect.w > 1 + 1e-9 || rect.y + rect.h > 1 + 1e-9) return null
    return { key: raw.key, aspectRatio: raw.aspectRatio, updatedAt: raw.updatedAt,
      roi: { x: rect.x, y: rect.y, w: Math.min(rect.w, 1 - rect.x), h: Math.min(rect.h, 1 - rect.y) } }
  } catch { return null }
}

function sameAspect(left: number, right: number): boolean { return Math.abs(left - right) <= ASPECT_TOLERANCE }
function aspectOf(width: number, height: number): number | null {
  const aspect = width / height
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 && Number.isFinite(aspect) && aspect > 0 ? aspect : null
}

/** Discard malformed persisted entries and retain only the most recent distinct regions. */
export function normalizeBasicClockMemory(raw: unknown): BasicClockMemoryEntry[] {
  try {
    if (!Array.isArray(raw)) return []
    const entries = raw.slice(0, 4096).map(validEntry).filter((entry): entry is BasicClockMemoryEntry => entry !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const result: BasicClockMemoryEntry[] = []
    for (const entry of entries) {
      if (result.some(existing => existing.key === entry.key && sameAspect(existing.aspectRatio, entry.aspectRatio))) continue
      result.push(entry)
      if (result.length === BASIC_CLOCK_MEMORY_LIMIT) break
    }
    return result
  } catch { return [] }
}

export function findBasicClockMemory(entries: readonly BasicClockMemoryEntry[], key: string | null,
  width: number, height: number): BasicClockMemoryEntry | null {
  const aspect = aspectOf(width, height)
  if (!key || aspect === null) return null
  let best: BasicClockMemoryEntry | null = null
  for (const entry of entries) {
    if (entry.key !== key || !sameAspect(entry.aspectRatio, aspect)) continue
    if (!best || Math.abs(entry.aspectRatio - aspect) < Math.abs(best.aspectRatio - aspect)
      || (entry.aspectRatio === best.aspectRatio && entry.updatedAt > best.updatedAt)) best = entry
  }
  return best
}

/** No-op writes preserve array identity so recognition frames do not churn local storage. */
export function rememberBasicClock(entries: readonly BasicClockMemoryEntry[], entry: BasicClockMemoryEntry): BasicClockMemoryEntry[] {
  const candidate = validEntry(entry)
  if (!candidate) return entries as BasicClockMemoryEntry[]
  const previous = entries.find(existing => existing.key === candidate.key && sameAspect(existing.aspectRatio, candidate.aspectRatio))
  if (previous && (previous.updatedAt > candidate.updatedAt
    || (previous.roi.x === candidate.roi.x && previous.roi.y === candidate.roi.y && previous.roi.w === candidate.roi.w && previous.roi.h === candidate.roi.h))) {
    return entries as BasicClockMemoryEntry[]
  }
  return normalizeBasicClockMemory([candidate, ...entries.filter(existing => existing.key !== candidate.key || !sameAspect(existing.aspectRatio, candidate.aspectRatio))])
}

export function forgetBasicClockMemory(entries: BasicClockMemoryEntry[], key: string | null,
  width?: number, height?: number): BasicClockMemoryEntry[] {
  if (!key) return entries
  const aspect = aspectOf(width ?? 0, height ?? 0)
  const result = entries.filter(entry => entry.key !== key || (aspect !== null && !sameAspect(entry.aspectRatio, aspect)))
  return result.length === entries.length ? entries : result
}
