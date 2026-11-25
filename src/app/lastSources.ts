import { parseSourceInput } from '../core/mediaSources'
import { savedRoomInput } from '../core/savedRoomIdentity'
import type { MediaDescriptor, PlatformId, SourceRole } from '../core/types'

export const LAST_SOURCES_STORAGE_KEY = 'stream-sync.last-sources.v1'
export interface LastSource { input: string; platform: PlatformId; label: string; customLabel?: boolean }
export type LastSources = Partial<Record<SourceRole, LastSource>>
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
const PLATFORMS = new Set(['youtube', 'twitch', 'douyu', 'bilibili', 'huya', 'douyin', 'direct', 'test'])

function storage(): StoragePort | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function validate(raw: unknown): LastSource | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Partial<LastSource>
  if (typeof value.input !== 'string' || !value.input.trim() || value.input.length > 8192 || /[\x00-\x1f\x7f]/.test(value.input)
    || typeof value.platform !== 'string' || !PLATFORMS.has(value.platform) || typeof value.label !== 'string' || value.label.length > 200) return null
  let input = savedRoomInput(value.platform, value.input)
  // Renderer capabilities, file paths and blob URLs cannot survive an application restart.
  if (value.platform === 'test') {
    if (!/^\/test-sources\/(?:[\w-]+\/)*[\w.-]+\.(?:mp4|m3u8|webm|mov|mkv|ts)$/.test(input)) return null
  } else {
    if (!/^https?:\/\//i.test(input)) {
      if (input.startsWith('/') || input.includes('://')) return null
      input = `https://${input}`
    }
    try {
      const url = new URL(input)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && value.platform !== 'direct')) return null
    } catch { return null }
  }
  const parsed = parseSourceInput(input)
  if (!parsed.ok || parsed.platform !== value.platform) return null
  const customLabel = value.platform === 'direct' && value.customLabel === true ? true : undefined
  return { input, platform: value.platform, label: value.label.replace(/[\x00-\x1f\x7f]/g, ''), ...(customLabel ? { customLabel } : {}) }
}

/** Store only reusable user inputs, never resolved media URLs, headers or session cookies. */
export function lastSource(descriptor: MediaDescriptor): LastSource | null {
  if (descriptor.platform === 'file' || descriptor.kind === 'file') return null
  const parsed = parseSourceInput(descriptor.input)
  const platform = descriptor.platform ?? (parsed.ok ? parsed.platform : 'direct')
  const input = platform === 'youtube' && /^UC[A-Za-z0-9_-]{22}$/.test(descriptor.sourceRoom ?? '')
    ? `https://www.youtube.com/channel/${descriptor.sourceRoom}/live` : descriptor.input
  return validate({
    input,
    platform,
    label: descriptor.label.slice(0, 200),
    ...(platform === 'direct' && descriptor.customLabel ? { customLabel: true } : {}),
  })
}

export function loadLastSources(port: StoragePort | null = storage()): LastSources {
  try {
    const text = port?.getItem(LAST_SOURCES_STORAGE_KEY)
    if (!text || text.length > 32_768) return {}
    const data = JSON.parse(text) as { version?: unknown; sources?: LastSources }
    if (data.version !== 1 || !data.sources || typeof data.sources !== 'object') return {}
    const result: LastSources = {}
    for (const role of ['official', 'commentary'] as const) {
      const source = validate(data.sources[role])
      if (source) result[role] = source
    }
    return result
  } catch { return {} }
}

export function saveLastSources(sources: LastSources, port: StoragePort | null = storage()): void {
  try { port?.setItem(LAST_SOURCES_STORAGE_KEY, JSON.stringify({ version: 1, sources })) }
  catch { /* Storage failure must not interrupt playback. */ }
}
