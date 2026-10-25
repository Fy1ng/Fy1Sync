import { readFishingOptions, type DouyuFishingOptions } from '../server/douyu/fishingActions'
import { readRewardOptions, type DouyuRewardOptions } from '../server/douyu/rewardActions'

export interface ActivityPreferences { version: 1; fishing: DouyuFishingOptions; treasure: DouyuRewardOptions }
export class ActivityPreferencesStore {
  private value: ActivityPreferences = { version: 1, fishing: { mode: 'all' }, treasure: { crossRoom: false, claimDelayMs: 5_000 } }
  constructor(private readonly storage: { load(): unknown; save(value: ActivityPreferences): void }) {
    const raw = storage.load()
    if (raw !== undefined) this.value = this.read(raw)
  }
  get(): ActivityPreferences { return structuredClone(this.value) }
  set(raw: ActivityPreferences): ActivityPreferences {
    const value = this.read(raw)
    this.storage.save(value); this.value = value
    return this.get()
  }
  private read(raw: unknown): ActivityPreferences {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'fishing,treasure,version'
      || (raw as ActivityPreferences).version !== 1) throw new Error('活动设置无效')
    const value = raw as ActivityPreferences
    return { version: 1, fishing: readFishingOptions(value.fishing), treasure: readRewardOptions(value.treasure) }
  }
}
