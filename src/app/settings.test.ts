/**
 * Settings tests, aimed at one property: a stored blob can never stop the app.
 *
 * `mergeSettings` is the only door into persisted state, and everything reaching it is
 * untrusted — written by an older build, hand-edited, truncated by a full quota. So the
 * tests feed it wrong types and out-of-range numbers rather than well-formed settings,
 * and check the field it *should* have kept survives alongside the ones it repaired.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  mergeSettings,
  saveSettings,
  type SettingsStorage,
} from './settings'

/** An in-memory Storage stand-in, so nothing here depends on jsdom's localStorage. */
function fakeStorage(initial?: string): SettingsStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key: string) {
      return key === SETTINGS_KEY ? this.value : null
    },
    setItem(key: string, next: string) {
      if (key === SETTINGS_KEY) this.value = next
    },
  }
}

describe('mergeSettings', () => {
  it('returns defaults for an empty or absent blob', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps valid values', () => {
    const merged = mergeSettings({
      volume: { official: 0.4, commentary: 0.8 },
      audioRole: 'official',
      smallStepSeconds: 0.25,
      largeStepSeconds: 10,
      sidebarVisible: false,
      autoSyncEnabled: true,
      autoSyncIntervalSeconds: 60,
      detectWindowSeconds: 2,
    })
    expect(merged.volume).toEqual({ official: 0.4, commentary: 0.8 })
    expect(merged.audioRole).toBe('official')
    expect(merged.smallStepSeconds).toBe(0.25)
    expect(merged.largeStepSeconds).toBe(10)
    expect(merged.sidebarVisible).toBe(false)
    expect(merged.autoSyncEnabled).toBe(true)
    expect(merged.autoSyncIntervalSeconds).toBe(60)
    expect(merged.detectWindowSeconds).toBe(2)
  })

  it('clamps volumes into 0..1 instead of rejecting the blob', () => {
    const merged = mergeSettings({ volume: { official: 4, commentary: -2 } })
    expect(merged.volume).toEqual({ official: 1, commentary: 0 })
  })

  it('falls back when a number is not a number', () => {
    // A single bad field must not cost the neighbouring good ones.
    const merged = mergeSettings({
      volume: { official: 'loud', commentary: Number.NaN },
      danmaku: { fontSize: 'big', speed: Number.POSITIVE_INFINITY },
    } as unknown)
    expect(merged.volume).toEqual(DEFAULT_SETTINGS.volume)
    expect(merged.danmaku.fontSize).toBe(DEFAULT_SETTINGS.danmaku.fontSize)
    expect(merged.danmaku.speed).toBe(DEFAULT_SETTINGS.danmaku.speed)
  })

  it('rejects enum values it does not know', () => {
    const merged = mergeSettings({
      audioRole: 'both',
      smallStepSeconds: 'tiny',
      danmaku: { area: 'everywhere' },
    } as unknown)
    expect(merged.audioRole).toBe('commentary')
    expect(merged.smallStepSeconds).toBe(DEFAULT_SETTINGS.smallStepSeconds)
    expect(merged.danmaku.area).toBe(DEFAULT_SETTINGS.danmaku.area)
  })

  it('only accepts the two offered detection windows', () => {
    // docs/sync-design.md offers 2 s and 3 s; 5 came from a bad blob, not from the UI.
    expect(mergeSettings({ detectWindowSeconds: 2 }).detectWindowSeconds).toBe(2)
    expect(mergeSettings({ detectWindowSeconds: 5 }).detectWindowSeconds).toBe(3)
    expect(mergeSettings({ detectWindowSeconds: 'fast' } as unknown).detectWindowSeconds).toBe(3)
  })

  it('drops non-string entries from the danmaku filter lists', () => {
    const merged = mergeSettings({
      danmaku: { filter: { blockedPatterns: ['广告', 42, null], blockedUsers: 'nope' } },
    } as unknown)
    expect(merged.danmaku.filter.blockedPatterns).toEqual(['广告'])
    expect(merged.danmaku.filter.blockedUsers).toEqual([])
  })

  it('bounds the profile id, because it becomes a URL path segment', () => {
    expect(mergeSettings({ profileId: 'cs2/iem' }).profileId).toBe('cs2/iem')
    expect(mergeSettings({ profileId: 42 } as unknown).profileId).toBe('')
    expect(mergeSettings({ profileId: 'x'.repeat(500) }).profileId).toHaveLength(200)
  })

  it('never shares mutable structure with the defaults', () => {
    // A merged object that aliased DEFAULT_SETTINGS would let one session's edit leak
    // into the next `mergeSettings({})`.
    const merged = mergeSettings({})
    merged.volume.official = 0.5
    merged.danmaku.filter.blockedPatterns.push('x')
    expect(DEFAULT_SETTINGS.volume.official).toBe(0)
    expect(DEFAULT_SETTINGS.danmaku.filter.blockedPatterns).toEqual([])
  })
})

describe('loadSettings', () => {
  it('reads a stored blob through the merge', () => {
    const storage = fakeStorage(JSON.stringify({ largeStepSeconds: 15, volume: { official: 9 } }))
    const settings = loadSettings(storage)
    expect(settings.largeStepSeconds).toBe(15)
    expect(settings.volume.official).toBe(1)
  })

  it('falls back to defaults on corrupt JSON', () => {
    expect(loadSettings(fakeStorage('{"volume":'))).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to defaults when storage throws', () => {
    // Private-mode browsers throw on access rather than returning null.
    const hostile: SettingsStorage = {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('denied')
      },
    }
    expect(loadSettings(hostile)).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips through save', () => {
    const storage = fakeStorage()
    saveSettings({ ...DEFAULT_SETTINGS, profileId: 'cs2/iem', smallStepSeconds: 0.1 }, storage)
    const restored = loadSettings(storage)
    expect(restored.profileId).toBe('cs2/iem')
    expect(restored.smallStepSeconds).toBe(0.1)
  })
})

describe('saveSettings', () => {
  it('swallows a write failure rather than interrupting playback', () => {
    const full: SettingsStorage = {
      getItem: () => null,
      setItem() {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => saveSettings(DEFAULT_SETTINGS, full)).not.toThrow()
  })
})
