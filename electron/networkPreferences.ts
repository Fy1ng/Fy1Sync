import { openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { mkdir, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DomesticRouting, NetworkPolicy, ProxySummary } from '../server/networkPolicy'
import { DEFAULT_MEDIA_NETWORK, validMediaNetwork, type MediaNetworkOptions } from '../server/mediaNetworkOptions'
export interface NetworkPreferenceState { domesticRouting: DomesticRouting; systemProxy: ProxySummary; media?: MediaNetworkOptions }
export interface NetworkPreferencesService { get(): Promise<NetworkPreferenceState>; set(mode: DomesticRouting, media?: MediaNetworkOptions): Promise<NetworkPreferenceState> }
export function isDomesticRouting(value: unknown): value is DomesticRouting { return value === 'direct' || value === 'system' }
export class NetworkPreferences implements NetworkPreferencesService {
  onChanged?: () => void
  private mode: DomesticRouting = 'direct'
  private media: MediaNetworkOptions = { ...DEFAULT_MEDIA_NETWORK }
  private writes: Promise<unknown> = Promise.resolve()
  private policy?: NetworkPolicy
  constructor(private readonly directory: string) {
    let fd: number | undefined
    try {
      fd = openSync(join(directory, 'network-preferences.json'), 'r')
      const metadata = fstatSync(fd)
      if (!metadata.isFile() || metadata.size > 2 * 1_048_576) return
      const buffer = Buffer.alloc(2 * 1_048_576 + 1)
      let length = 0
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null)
        if (!count) break
        length += count
      }
      const bytes = buffer.subarray(0, length)
      const value = bytes.length <= 2 * 1_048_576 ? JSON.parse(bytes.toString('utf8')) : null
      if (value?.version === 1 && Object.keys(value).length === 2 && isDomesticRouting(value.domesticRouting)) this.mode = value.domesticRouting
      if (value?.version === 2 && Object.keys(value).length === 3 && isDomesticRouting(value.domesticRouting) && validMediaNetwork(value.media)) {
        this.mode = value.domesticRouting
        this.media = { ...DEFAULT_MEDIA_NETWORK, ...value.media }
      }
    } catch { /* Missing or invalid preferences use domestic DIRECT. */ }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  domesticRouting = (): DomesticRouting => this.mode
  mediaOptions = (): Readonly<MediaNetworkOptions> => structuredClone(this.media)
  extraStreamLimit = (): number => this.media.maxExtraStreams ?? 0
  attach(policy: NetworkPolicy): void { this.policy = policy }
  async get(): Promise<NetworkPreferenceState> {
    const systemProxy = await this.policy?.summary().catch(() => ({ type: 'PAC' as const, fallbackReason: 'proxy-resolution-failed' })) ?? { type: 'direct' as const }
    return { domesticRouting: this.mode, media: structuredClone(this.media), systemProxy }
  }
  set(mode: DomesticRouting, media?: MediaNetworkOptions): Promise<NetworkPreferenceState> {
    if (!isDomesticRouting(mode)) return Promise.reject(new Error('Invalid domestic routing'))
    if (media !== undefined && !validMediaNetwork(media)) return Promise.reject(new Error('Invalid media network options'))
    const requestedMedia = media === undefined ? undefined : structuredClone({ ...DEFAULT_MEDIA_NETWORK, ...media })
    const work = this.writes.then(async () => {
      const nextMedia = requestedMedia ?? this.media
      await mkdir(this.directory, { recursive: true })
      const temporary = join(this.directory, `.network-preferences-${randomUUID()}.tmp`)
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ version: 2, domesticRouting: mode, media: nextMedia }) + '\n'); await handle.sync() } finally { await handle.close() }
      await rename(temporary, join(this.directory, 'network-preferences.json'))
      this.mode = mode
      this.media = structuredClone(nextMedia)
      this.policy?.invalidate()
      try { this.onChanged?.() } catch { /* Observers cannot invalidate a saved preference. */ }
      return this.get()
    })
    this.writes = work.catch(() => {})
    return work
  }
}
