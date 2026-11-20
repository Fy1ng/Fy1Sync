import { metadataUserAgent } from '../appIdentity'
import { metadataConfig } from '../config'
import { FeatureApiError } from '../featureApiError'
import { safeFetch, type PinnedDispatcherPool, type Resolver } from '../safeFetch'
import { object, readJson } from './metadataIo'
import { validEntry, validTwitchLogin } from './parser'
import type { StreamTitle, StreamTitleInput } from './types'

export const TITLE_TTL_MS = 120_000
let titleActive = 0
const titleWaiters: Array<() => void> = []
async function titleSlot<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (titleActive >= 4) await new Promise<void>(resolve => titleWaiters.push(resolve))
  else titleActive++
  try { signal.throwIfAborted(); return await run() }
  finally {
    const next = titleWaiters.shift()
    if (next) next()
    else titleActive--
  }
}

export function titleStage(title: string): string | null {
  const markers = new Set<string>()
  const bracket = /^\s*\[([A-D])\](?:\s|$)/i.exec(title)
  if (bracket) markers.add(bracket[1]!.toUpperCase())
  for (const match of title.matchAll(/\b(?:stream|stage)\s+([A-D])\b|\b([A-D])\s+(?:stream|stage)\b/gi)) markers.add((match[1] ?? match[2])!.toUpperCase())
  if (/\bmain\s+(?:stream|stage)\b|主舞台/i.test(title)) markers.add('主舞台')
  if (/\bsecondary\s+(?:stream|stage)\b|副舞台/i.test(title)) markers.add('副舞台')
  return markers.size === 1 ? [...markers][0]! : null
}

function cleanTitle(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() && raw.length <= 2_000 && !/[\x00-\x1f\x7f]/.test(raw) ? raw.trim() : null
}

const invalid = (): never => { throw new FeatureApiError('invalid-arguments') }
export function streamTitleArguments(raw: unknown): { streams: StreamTitleInput[] } {
  if (!object(raw) || Object.keys(raw).length !== 1 || !Array.isArray(raw.streams) || raw.streams.length > 12) return invalid()
  const streams = raw.streams.map(value => {
    if (!object(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'videoId')
      || (value.platform !== 'youtube' && value.platform !== 'twitch')
      || !(value.platform === 'twitch' ? validTwitchLogin(value.channel) : validEntry(value.channel))
      || (value.videoId !== null && (typeof value.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(value.videoId)))
      || (value.platform === 'twitch' && value.videoId !== null)) return invalid()
    return { platform: value.platform, channel: value.channel, videoId: value.videoId } as StreamTitleInput
  })
  return { streams }
}

interface Dependencies { version: string; request?: typeof fetch; resolve?: Resolver }

export class StreamTitles {
  private readonly titles = new Map<string, { at: number; value: StreamTitle }>()
  private readonly flights = new Map<string, Promise<StreamTitle>>()
  constructor(private readonly options: Dependencies, private readonly now: () => number,
    private readonly signal: AbortSignal, private readonly pool: PinnedDispatcherPool) {}

  async get(raw: { streams: StreamTitleInput[] }): Promise<StreamTitle[]> {
    const { streams } = streamTitleArguments(raw)
    this.signal.throwIfAborted()
    const unique = new Map(streams.map(stream => [JSON.stringify([stream.platform, stream.channel, stream.videoId]), stream]))
    return Promise.all([...unique].map(async ([key, stream]) => {
      const cached = this.titles.get(key), now = this.now()
      if (cached && now >= cached.at && now - cached.at < TITLE_TTL_MS) return structuredClone(cached.value)
      let work = this.flights.get(key)
      if (!work) {
        work = titleSlot(this.signal, () => this.fetchTitle(stream)).then(value => {
          if (this.titles.size >= 256) this.titles.delete(this.titles.keys().next().value!)
          this.titles.set(key, { at: this.now(), value }); return value
        }).finally(() => { this.flights.delete(key) })
        this.flights.set(key, work)
      }
      return structuredClone(await work)
    }))
  }

  private async fetchTitle(stream: StreamTitleInput): Promise<StreamTitle> {
    const fallback: StreamTitle = { ...stream, title: null, stage: null, live: null }
    if (stream.platform === 'youtube' && stream.videoId === null) return fallback
    try {
      const url = stream.platform === 'youtube'
        ? 'https://www.youtube.com/oembed?' + new URLSearchParams({ url: `https://www.youtube.com/watch?v=${stream.videoId}`, format: 'json' })
        : 'https://gql.twitch.tv/gql'
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(15_000)])
      const result = await safeFetch(url, metadataConfig(), { signal, resolve: this.options.resolve, dispatcherPool: this.pool,
        fetchImpl: this.options.request,
        headers: { 'User-Agent': metadataUserAgent(this.options.version), Accept: 'application/json', 'Accept-Encoding': 'gzip',
          ...(stream.platform === 'twitch' ? { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' } : {}) },
        ...(stream.platform === 'twitch' ? { method: 'POST', body: JSON.stringify({ operationName: 'StreamTitle',
          query: 'query StreamTitle($login: String!) { user(login: $login) { stream { title type } } }', variables: { login: stream.channel } }) } : {}),
      })
      const data = await readJson(result.response)
      if (!object(data)) return fallback
      if (stream.platform === 'youtube') {
        const title = cleanTitle(data.title)
        return { ...fallback, title, stage: title ? titleStage(title) : null }
      }
      if (data.errors || !object(data.data) || !object(data.data.user)) return fallback
      const liveStream = data.data.user.stream
      if (liveStream === null) return { ...fallback, live: false }
      if (!object(liveStream) || typeof liveStream.type !== 'string') return fallback
      const title = cleanTitle(liveStream.title)
      return { ...fallback, title, stage: title ? titleStage(title) : null, live: liveStream.type === 'live' }
    } catch { return fallback }
  }

  async dispose(): Promise<void> { await Promise.allSettled(this.flights.values()); this.titles.clear() }
}
