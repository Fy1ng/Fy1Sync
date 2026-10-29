import { openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { mkdir, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DomesticRouting, NetworkPolicy, ProxySummary } from '../server/networkPolicy'
export interface NetworkPreferenceState { domesticRouting: DomesticRouting; systemProxy: ProxySummary }
export interface NetworkPreferencesService { get(): Promise<NetworkPreferenceState>; set(mode: DomesticRouting): Promise<NetworkPreferenceState> }
export function isDomesticRouting(value: unknown): value is DomesticRouting { return value === 'direct' || value === 'system' }
export class NetworkPreferences implements NetworkPreferencesService {
  private mode: DomesticRouting = 'direct'
  private writes: Promise<unknown> = Promise.resolve()
  private policy?: NetworkPolicy
  constructor(private readonly directory: string) {
    let fd: number | undefined
    try {
      fd = openSync(join(directory, 'network-preferences.json'), 'r')
      const metadata = fstatSync(fd)
      if (!metadata.isFile() || metadata.size > 4096) return
      const buffer = Buffer.alloc(4097)
      let length = 0
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null)
        if (!count) break
        length += count
      }
      const bytes = buffer.subarray(0, length)
      const value = bytes.length <= 4096 ? JSON.parse(bytes.toString('utf8')) : null
      if (value?.version === 1 && Object.keys(value).length === 2 && isDomesticRouting(value.domesticRouting)) this.mode = value.domesticRouting
    } catch { /* Missing or invalid preferences use domestic DIRECT. */ }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  domesticRouting = (): DomesticRouting => this.mode
  attach(policy: NetworkPolicy): void { this.policy = policy }
  async get(): Promise<NetworkPreferenceState> { return { domesticRouting: this.mode, systemProxy: await this.policy?.summary() ?? { type: 'direct' } } }
  set(mode: DomesticRouting): Promise<NetworkPreferenceState> {
    if (!isDomesticRouting(mode)) return Promise.reject(new Error('Invalid domestic routing'))
    const work = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true })
      const temporary = join(this.directory, `.network-preferences-${randomUUID()}.tmp`)
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ version: 1, domesticRouting: mode }) + '\n'); await handle.sync() } finally { await handle.close() }
      await rename(temporary, join(this.directory, 'network-preferences.json'))
      this.mode = mode
      this.policy?.invalidate()
      return this.get()
    })
    this.writes = work.catch(() => {})
    return work
  }
}
