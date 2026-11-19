import type { HuyaOnTvActivity, HuyaOnTvSnapshot } from '../../server/platforms/huyaOnTv'

export function huyaOnTvFresh(snapshot: HuyaOnTvSnapshot, now: number): boolean {
  return now >= snapshot.observedAt && now - snapshot.observedAt <= 45_000
}

/** Activity time is anchored to the server's remaining time, never media progress. */
export function huyaOnTvRemaining(snapshot: HuyaOnTvSnapshot | null, now: number): number {
  if (!snapshot?.activity || snapshot.status !== 'active') return 0
  return Math.max(0, Math.ceil((snapshot.activity.endsAt - snapshot.activity.serverNow - Math.max(0, now - snapshot.observedAt)) / 1000))
}
export function readHuyaOnTvSnapshot(raw: unknown, room: string | null): HuyaOnTvSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as HuyaOnTvSnapshot
  if (data.room !== room || !/^huya:[1-9]\d{0,15}$/.test(data.room) || !Number.isSafeInteger(data.observedAt) || data.observedAt < 0
    || !['loading', 'none', 'active', 'ended', 'unavailable'].includes(data.status)) return null
  if (data.status === 'active' || data.status === 'ended') {
    const activity = data.activity
    if (!activity || typeof activity.id !== 'string' || !/^[1-9]\d{0,18}$/.test(activity.id) || activity.qualification !== 'unknown'
      || !Number.isSafeInteger(activity.mode) || activity.mode < -1 || activity.mode > 2147483647
      || !Number.isSafeInteger(activity.endsAt) || !Number.isSafeInteger(activity.serverNow) || activity.serverNow < 0
      || activity.endsAt < activity.serverNow || activity.endsAt - activity.serverNow > 86400_000
      || [activity.title, activity.prize, activity.cost].some(value => typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f]/.test(value))
      || !Array.isArray(activity.conditions) || activity.conditions.length > 8
      || activity.conditions.some(value => typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f]/.test(value))) return null
    const copy: HuyaOnTvActivity = { id: activity.id, title: activity.title, prize: activity.prize, mode: activity.mode,
      conditions: [...activity.conditions], cost: activity.cost, qualification: 'unknown', endsAt: activity.endsAt, serverNow: activity.serverNow }
    return { room: data.room, observedAt: data.observedAt, status: data.status, activity: copy }
  }
  return data.activity === null ? { room: data.room, observedAt: data.observedAt, status: data.status, activity: null } : null
}
export class HuyaOnTvReminders {
  private readonly reminded = new Map<string, number>()
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined
  private readonly key = 'fy1sync.huya-on-tv.reminded.v1'
  constructor(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    try {
      this.storage = storage ?? globalThis.localStorage
      const saved: unknown = JSON.parse(this.storage?.getItem(this.key) ?? '[]')
      if (Array.isArray(saved) && saved.length <= 1024) for (const item of saved) {
        if (Array.isArray(item) && item.length === 2 && typeof item[0] === 'string'
          && /^huya:[1-9]\d{0,15}:[1-9]\d{0,18}$/.test(item[0]) && Number.isSafeInteger(item[1]) && item[1] > 0) this.reminded.set(item[0], item[1])
      }
    } catch { /* A corrupt or unavailable UI cache cannot block viewing. */ }
  }
  shouldRemind(snapshot: HuyaOnTvSnapshot | null, enabled: boolean, now: number): boolean {
    if (!enabled || !snapshot?.activity || !huyaOnTvFresh(snapshot, now) || huyaOnTvRemaining(snapshot, now) < 1) return false
    const key = `${snapshot.room}:${snapshot.activity.id}`
    for (const [id, expires] of this.reminded) if (expires <= now) this.reminded.delete(id)
    // Stop additional reminders at capacity rather than forgetting old activity identities.
    if (this.reminded.has(key) || this.reminded.size >= 1024) return false
    this.reminded.set(key, now + huyaOnTvRemaining(snapshot, now) * 1000 + 3600_000)
    try { this.storage?.setItem(this.key, JSON.stringify([...this.reminded])) } catch { /* Keep the in-memory reminder guard. */ }
    return true
  }
}
