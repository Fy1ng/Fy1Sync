type Entry = { accountId: string; expiresAt: number; value?: unknown }

/** Only public read DTOs enter this cache. Writes always use their original providers. */
export class DouyuReadCache {
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly now: () => number = Date.now) {}

  async read<T>(kind: 'followed' | 'inventory' | 'watch', accountId: string, room: string,
    refresh: boolean | undefined, load: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([kind, accountId, room])
    const cached = this.entries.get(key)
    if (!refresh && cached?.value !== undefined && this.now() < cached.expiresAt) return structuredClone(cached.value) as T
    // Identity also acts as a generation: invalidated/replaced requests cannot repopulate it.
    const entry: Entry = { accountId, expiresAt: 0 }
    if (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!)
    this.entries.set(key, entry)
    try {
      const value = await load()
      if (this.entries.get(key) === entry) {
        entry.value = structuredClone(value)
        entry.expiresAt = this.now() + (kind === 'watch' ? 120_000 : 60_000)
      }
      return structuredClone(value)
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw error
    }
  }

  invalidate(accountId?: string): void {
    for (const [key, entry] of this.entries) if (accountId === undefined || entry.accountId === accountId) this.entries.delete(key)
  }
}
