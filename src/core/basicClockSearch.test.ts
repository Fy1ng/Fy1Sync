import { describe, expect, it, vi } from 'vitest'
import bundledConfig from '../recognition/basicSearchRegion.json'
import { getBasicClockSearchConfig, getBasicClockSearchRoi, parseBasicClockSearchConfig } from './basicClockSearch'

const roi = { x: .3, y: .01, w: .4, h: .2 }
const configured = { schemaVersion: 1, configured: true, roi }

describe('author-defined clock search bounds', () => {
  it('accepts an unconfigured build and explicit valid or full-picture bounds', () => {
    expect(parseBasicClockSearchConfig({ schemaVersion: 1, configured: false, roi: null }))
      .toEqual({ schemaVersion: 1, configured: false, roi: null })
    expect(parseBasicClockSearchConfig(configured)).toEqual(configured)
    expect(parseBasicClockSearchConfig({ ...configured, roi: { x: 0, y: 0, w: 1, h: 1 } }).roi)
      .toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('rejects unknown versions, missing or additional fields and inconsistent state', () => {
    for (const raw of [null, [], 'config', {}, { ...configured, schemaVersion: 2 },
      { ...configured, schemaVersion: '1' }, { ...configured, configured: 1 },
      { ...configured, roi: null }, { ...configured, configured: false },
      { schemaVersion: 1, configured: false }, { ...configured, userOverride: true },
      { ...configured, roi: { ...roi, threshold: 150 } }]) {
      expect(() => parseBasicClockSearchConfig(raw)).toThrow(/^生产寻找区间配置无效: /)
    }
  })

  it('rejects nonfinite, nonnumeric, empty and out-of-frame regions without clamping', () => {
    const regions = [
      null, [], 'region', { ...roi, x: '0.3' }, { ...roi, x: -1 }, { ...roi, y: -.001 },
      { ...roi, x: 1 }, { ...roi, y: 1 }, { ...roi, w: 0 }, { ...roi, h: -1 },
      { ...roi, w: Number.NaN }, { ...roi, h: Infinity }, { ...roi, x: .99 }, { ...roi, y: .99 },
    ]
    for (const value of regions) expect(() => parseBasicClockSearchConfig({ ...configured, roi: value }))
      .toThrow(/^生产寻找区间配置无效: /)
  })

  it('rejects dynamic, symbolic or nonplain input fields without evaluating accessors', () => {
    const getter = vi.fn(() => roi)
    const dynamic = Object.defineProperty({ schemaVersion: 1, configured: true }, 'roi', { enumerable: true, get: getter })
    const symbolic = { ...configured, [Symbol('override')]: true }
    const instance = Object.assign(new Date(), configured)
    const hostile = new Proxy({}, { ownKeys() { throw new Error('unexpected internal detail') } })
    for (const raw of [dynamic, symbolic, instance, hostile]) {
      expect(() => parseBasicClockSearchConfig(raw)).toThrow(/^生产寻找区间配置无效: /)
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it('returns independent parsed values without exposing mutable input regions', () => {
    const input = { ...configured, roi: { ...roi } }
    const parsed = parseBasicClockSearchConfig(input)
    parsed.roi!.x = 0
    expect(input.roi.x).toBe(.3)
    input.roi.w = .1
    expect(parsed.roi!.w).toBe(.4)
  })

  it('reads only the bundled asset and isolates getter results from later calls', () => {
    const expected = parseBasicClockSearchConfig(bundledConfig)
    const first = getBasicClockSearchConfig()
    expect(first).toEqual(expected)
    expect(first).not.toBe(bundledConfig)
    first.configured = !first.configured
    first.roi = { ...roi }
    first.roi.x = 0
    expect(getBasicClockSearchConfig()).toEqual(expected)
    const firstRoi = getBasicClockSearchRoi()
    if (firstRoi) {
      firstRoi.x = firstRoi.x === 0 ? .01 : 0
      expect(getBasicClockSearchRoi()).toEqual(expected.roi)
    } else expect(getBasicClockSearchRoi()).toBeNull()
  })
})
