export type DanmakuDuplicateMode = 'all' | 'single' | 'combo'

export interface DanmakuPreferences {
  verticalGapPx: number
  duplicateMode: DanmakuDuplicateMode
  duplicateWindowSeconds: number
  filterSuspectedBots: boolean
  showUserDetails: boolean
}

export const DEFAULT_DANMAKU_PREFERENCES: Readonly<DanmakuPreferences> = Object.freeze({
  verticalGapPx: 10,
  duplicateMode: 'all',
  duplicateWindowSeconds: 8,
  filterSuspectedBots: false,
  showUserDetails: false,
})

const KEYS = Object.keys(DEFAULT_DANMAKU_PREFERENCES)

/** Stored preferences and IPC patches share a bounded, accessor-free schema. */
export function readDanmakuPreferences(raw: unknown): DanmakuPreferences | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (![Object.prototype, null].includes(Object.getPrototypeOf(raw) as object | null)) return null
    if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !KEYS.includes(key))) return null
    const result = { ...DEFAULT_DANMAKU_PREFERENCES }
    for (const key of KEYS as Array<keyof DanmakuPreferences>) {
      const field = Object.getOwnPropertyDescriptor(raw, key)
      if (!field) continue
      if (!('value' in field)) return null
      const value: unknown = field.value
      if (key === 'verticalGapPx') {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 64) return null
        result.verticalGapPx = value
      } else if (key === 'duplicateWindowSeconds') {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 30) return null
        result.duplicateWindowSeconds = value
      } else if (key === 'duplicateMode') {
        if (value !== 'all' && value !== 'single' && value !== 'combo') return null
        result.duplicateMode = value
      } else {
        if (typeof value !== 'boolean') return null
        result[key] = value
      }
    }
    return result
  } catch { return null }
}

export function danmakuLaneHeight(fontSize: number, verticalGapPx: number): number {
  if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 128
    || !Number.isFinite(verticalGapPx) || verticalGapPx < 0 || verticalGapPx > 64) {
    throw new Error('弹幕字号或间距无效.')
  }
  return fontSize + verticalGapPx
}

export interface ProcessableDanmaku {
  text: string
  platform?: 'douyu' | 'huya'
  room?: string
  /** Public intelligent-filter score, not a bot identity or authentication claim. */
  dms?: number
  system?: boolean
  gift?: unknown
}

export type DanmakuProcessingResult = {
  kind: 'show' | 'hide' | 'merge'
  text: string
  count: number
  groupId: string | null
  reason: 'duplicate' | 'missing-dms' | 'invalid' | null
}

type Group = { id: string; expiresAt: number; count: number }

/** One instance per playback timeline. Call only when a message is released for display. */
export class DanmakuProcessor {
  private preferences: DanmakuPreferences
  private readonly groups = new Map<string, Group>()
  private lastMediaTime = -Infinity
  private sequence = 0
  private readonly capacity: number

  constructor(preferences: DanmakuPreferences = { ...DEFAULT_DANMAKU_PREFERENCES }, capacity = 2_000) {
    const parsed = readDanmakuPreferences(preferences)
    if (!parsed || !Number.isInteger(capacity) || capacity < 1 || capacity > 10_000) throw new Error('弹幕处理配置无效.')
    this.preferences = parsed
    this.capacity = capacity
  }

  configure(preferences: DanmakuPreferences): void {
    const parsed = readDanmakuPreferences(preferences)
    if (!parsed) throw new Error('弹幕处理配置无效.')
    this.preferences = parsed
    this.reset()
  }

  reset(): void {
    this.groups.clear()
    this.lastMediaTime = -Infinity
  }

  get trackedGroups(): number { return this.groups.size }

  process(message: ProcessableDanmaku, mediaTimeSeconds: number): DanmakuProcessingResult {
    const text = typeof message?.text === 'string' ? message.text : ''
    const result = (kind: DanmakuProcessingResult['kind'], count = 1, groupId: string | null = null,
      reason: DanmakuProcessingResult['reason'] = null): DanmakuProcessingResult => ({ kind, text, count, groupId, reason })
    if (!text.trim() || text.length > 2_000 || !Number.isFinite(mediaTimeSeconds)
      || (message.room !== undefined && (typeof message.room !== 'string' || message.room.length > 64))) return result('hide', 0, null, 'invalid')
    if (mediaTimeSeconds < this.lastMediaTime) this.reset()
    this.lastMediaTime = mediaTimeSeconds
    if (message.system || message.gift !== undefined) return result('show')
    // DouyuEx uses absence of dms as a heuristic. It is explicitly opt-in here.
    if (message.platform !== 'huya' && this.preferences.filterSuspectedBots && (typeof message.dms !== 'number' || !Number.isFinite(message.dms))) return result('hide', 0, null, 'missing-dms')
    if (this.preferences.duplicateMode === 'all') return result('show')
    for (const [key, group] of this.groups) if (group.expiresAt <= mediaTimeSeconds) this.groups.delete(key)
    const key = JSON.stringify([message.room ?? '', text])
    const existing = this.groups.get(key)
    if (existing) {
      existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + 1)
      return result(this.preferences.duplicateMode === 'single' ? 'hide' : 'merge', existing.count, existing.id, 'duplicate')
    }
    if (this.groups.size >= this.capacity) this.groups.delete(this.groups.keys().next().value!)
    const group = { id: 'danmaku-group-' + ++this.sequence, expiresAt: mediaTimeSeconds + this.preferences.duplicateWindowSeconds, count: 1 }
    this.groups.set(key, group)
    return result('show', 1, group.id)
  }
}
