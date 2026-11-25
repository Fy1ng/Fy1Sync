import { describe, expect, it } from 'vitest'
import { isCommercialBreakActive, TWITCH_COMMERCIAL_BREAK_NOTICE } from './commercialBreak'

describe('isCommercialBreakActive', () => {
  it('exposes the approved Chinese notice copy', () => {
    expect(TWITCH_COMMERCIAL_BREAK_NOTICE).toBe(
      'Commercial Break为Twitch官方广告时段, 通常持续15~30s后自动恢复直播, 请勿重新载入',
    )
  })

  it('activates only for Twitch sources in non-empty, non-error states', () => {
    const commercialBreak = { live: true, ranges: [[0, 10]] as [number, number][] }
    expect(isCommercialBreakActive({ platform: 'douyu', status: 'ready', commercialBreak })).toBe(false)
    expect(isCommercialBreakActive({ platform: 'twitch', status: 'empty', commercialBreak })).toBe(false)
    expect(isCommercialBreakActive({ platform: 'twitch', status: 'error', commercialBreak })).toBe(false)
    expect(isCommercialBreakActive({ platform: 'twitch', status: 'loading', commercialBreak })).toBe(true)
  })

  it('tracks rewound playback against buffered commercial break ranges without premature show or hide', () => {
    // Buffer holds 90 s total: 0..30 live gameplay, 30..60 commercial break, 60..90 resumed gameplay.
    const commercialBreak = { live: false, ranges: [[30, 60]] as [number, number][] }
    const timebase = { kind: 'live' as const, seekableStart: 0, seekableEnd: 90 }

    expect(isCommercialBreakActive({
      platform: 'twitch', status: 'ready', commercialBreak, bufferSeconds: 90, currentTime: 20, timebase,
    })).toBe(false)
    expect(isCommercialBreakActive({
      platform: 'twitch', status: 'ready', commercialBreak, bufferSeconds: 90, currentTime: 45, timebase,
    })).toBe(true)
    expect(isCommercialBreakActive({
      platform: 'twitch', status: 'ready', commercialBreak, bufferSeconds: 90, currentTime: 65, timebase,
    })).toBe(false)
  })

  it('aligns offsets from seekableEnd minus bufferSeconds after 180 s retention eviction', () => {
    // Published playlist covers media time 70..250 (180 s), while MSE back-buffer starts at 62.
    // Commercial break occupies 130..160 inside the 180 s window (media time 200..230).
    const commercialBreak = { live: false, ranges: [[130, 160]] as [number, number][] }
    const timebase = { kind: 'live' as const, seekableStart: 62, seekableEnd: 250 }

    expect(isCommercialBreakActive({
      platform: 'twitch', status: 'ready', commercialBreak, bufferSeconds: 180, currentTime: 195, timebase,
    })).toBe(false)
    expect(isCommercialBreakActive({
      platform: 'twitch', status: 'ready', commercialBreak, bufferSeconds: 180, currentTime: 215, timebase,
    })).toBe(true)
    expect(isCommercialBreakActive({
      platform: 'twitch', status: 'ready', commercialBreak, bufferSeconds: 180, currentTime: 235, timebase,
    })).toBe(false)
  })
})
