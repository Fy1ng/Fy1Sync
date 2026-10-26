/**
 * Persisted UI settings.
 *
 * These are preferences, not state: volumes, danmaku appearance, manual offset step sizes.
 * They survive a reload; nothing about the current session (sources, offset, playback
 * position) belongs here.
 *
 * Every read goes through `mergeSettings`, so a stored blob written by an older build —
 * or hand-edited, or truncated — yields defaults for whatever it cannot supply instead
 * of an app that will not start.
 */

import type { DanmakuArea } from '../core/danmakuLanes'
import { DEFAULT_FILTER_SETTINGS, type DanmakuFilterSettings } from '../core/danmakuFilter'
import { normalizeSteps } from '../ui/controls/manualOffset'

export const SETTINGS_KEY = 'stream-sync.settings.v1'

export interface DanmakuSettings {
  enabled: boolean
  fontSize: number
  /** Scroll speed in px/s. */
  speed: number
  opacity: number
  area: DanmakuArea
  /** Fraction of incoming messages to keep, 0..1. */
  density: number
  filter: DanmakuFilterSettings
  /** Viewers' gift notices in the chat list. Off by default: in a busy room they bury the chat. */
  showGifts: boolean
}

export interface AppSettings {
  volume: Record<'official' | 'commentary', number>
  muted: Record<'official' | 'commentary', boolean>
  /** Which source's audio is unmuted by default. */
  audioRole: 'official' | 'commentary'
  /** Step of the inner ◀ / ▶ buttons, seconds. */
  smallStepSeconds: number
  /** Step of the outer ◀◀ / ▶▶ buttons, seconds; never below the small step. */
  largeStepSeconds: number
  danmaku: DanmakuSettings
  autoSyncEnabled: boolean
  autoSyncIntervalSeconds: number
  detectWindowSeconds: number
  seekThresholdSeconds: number
  sidebarVisible: boolean
  /** Prefer optional YouTube adaptive qualities when the token provider is available. */
  preferAdaptive: boolean
  /**
   * Which recognition preset the player loads on boot, by id. Empty means none.
   *
   * The id rather than the profile: templates are the bulk of a profile and localStorage is
   * a few megabytes, so caching them here would be the first thing to blow the quota. The
   * player fetches the preset at startup instead.
   */
  profileId: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  // The common watching mode from docs/ui-layout.md: official picture, commentary audio.
  volume: { official: 0, commentary: 1 },
  muted: { official: true, commentary: false },
  audioRole: 'commentary',
  smallStepSeconds: 0.5,
  largeStepSeconds: 5,
  danmaku: {
    enabled: true,
    fontSize: 24,
    speed: 160,
    opacity: 0.9,
    area: 'half',
    density: 1,
    filter: { ...DEFAULT_FILTER_SETTINGS },
    showGifts: false,
  },
  autoSyncEnabled: false,
  autoSyncIntervalSeconds: 30,
  detectWindowSeconds: 3,
  seekThresholdSeconds: 1.5,
  sidebarVisible: true,
  // On: YouTube's adaptive formats are where 1440p and up live; the HLS ladder stops lower.
  preferAdaptive: true,
  profileId: '',
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function area(value: unknown): DanmakuArea {
  return value === 'quarter' || value === 'half' || value === 'full'
    ? value
    : DEFAULT_SETTINGS.danmaku.area
}

function steps(stored: Partial<AppSettings>): Pick<AppSettings, 'smallStepSeconds' | 'largeStepSeconds'> {
  const { small, large } = normalizeSteps(stored.smallStepSeconds, stored.largeStepSeconds, {
    small: DEFAULT_SETTINGS.smallStepSeconds,
    large: DEFAULT_SETTINGS.largeStepSeconds,
  })
  return { smallStepSeconds: small, largeStepSeconds: large }
}

/** Fill in whatever a stored blob does not supply, field by field. */
export function mergeSettings(raw: unknown): AppSettings {
  const stored = (raw ?? {}) as Partial<AppSettings>
  const danmaku = (stored.danmaku ?? {}) as Partial<DanmakuSettings>
  const filter = (danmaku.filter ?? {}) as Partial<DanmakuFilterSettings>
  const defaults = DEFAULT_SETTINGS

  return {
    volume: {
      official: clamp(stored.volume?.official, 0, 1, defaults.volume.official),
      commentary: clamp(stored.volume?.commentary, 0, 1, defaults.volume.commentary),
    },
    muted: {
      official: boolean(stored.muted?.official, defaults.muted.official),
      commentary: boolean(stored.muted?.commentary, defaults.muted.commentary),
    },
    audioRole: stored.audioRole === 'official' ? 'official' : 'commentary',
    ...steps(stored),
    danmaku: {
      enabled: boolean(danmaku.enabled, defaults.danmaku.enabled),
      fontSize: clamp(danmaku.fontSize, 12, 56, defaults.danmaku.fontSize),
      speed: clamp(danmaku.speed, 40, 480, defaults.danmaku.speed),
      opacity: clamp(danmaku.opacity, 0.1, 1, defaults.danmaku.opacity),
      area: area(danmaku.area),
      density: clamp(danmaku.density, 0.05, 1, defaults.danmaku.density),
      filter: {
        blockedPatterns: strings(filter.blockedPatterns),
        blockedUsers: strings(filter.blockedUsers),
        maxLength: clamp(filter.maxLength, 0, 500, 0),
      },
      showGifts: boolean(danmaku.showGifts, defaults.danmaku.showGifts),
    },
    autoSyncEnabled: boolean(stored.autoSyncEnabled, defaults.autoSyncEnabled),
    // docs/sync-design.md fixes the interval choices at 15/30/60 s.
    autoSyncIntervalSeconds: clamp(stored.autoSyncIntervalSeconds, 10, 600, 30),
    // Only 2 s and 3 s windows are offered; anything else came from a bad blob.
    detectWindowSeconds: stored.detectWindowSeconds === 2 ? 2 : 3,
    seekThresholdSeconds: clamp(stored.seekThresholdSeconds, 0.2, 5, 1.5),
    sidebarVisible: boolean(stored.sidebarVisible, defaults.sidebarVisible),
    preferAdaptive: boolean(stored.preferAdaptive, defaults.preferAdaptive),
    // Bounded because it goes into a URL path when the preset is fetched.
    profileId: typeof stored.profileId === 'string' ? stored.profileId.slice(0, 200) : '',
  }
}

export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>

export function loadSettings(storage?: SettingsStorage): AppSettings {
  const store = storage ?? safeLocalStorage()
  if (!store) return { ...DEFAULT_SETTINGS }
  try {
    const raw = store.getItem(SETTINGS_KEY)
    return mergeSettings(raw ? (JSON.parse(raw) as unknown) : {})
  } catch {
    // Corrupt JSON, or a browser refusing storage access in private mode.
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: AppSettings, storage?: SettingsStorage): void {
  const store = storage ?? safeLocalStorage()
  if (!store) return
  try {
    store.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // A full or blocked quota must not interrupt playback.
  }
}

function safeLocalStorage(): SettingsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
