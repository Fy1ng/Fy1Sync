import { describe, expect, it } from 'vitest'
import { SOURCE_ROLES } from '../core/types'
import { createPlaybackProgress, observePlaybackProgress, type PlaybackProgressObservation, type PlaybackProgressResult } from './playbackProgress'

function harness() {
  let state = createPlaybackProgress()
  let at = 0
  const media: PlaybackProgressObservation = {
    at,
    official: { currentTime: 100, paused: false, seeking: false, ended: false },
    commentary: { currentTime: 400, paused: false, seeking: false, ended: false },
  }
  const results: PlaybackProgressResult[] = []
  const read = (enabled = true) => {
    media.at = at
    const result = observePlaybackProgress(state, media, enabled)
    state = result.state
    results.push(result)
    return result
  }
  read()
  return {
    media, results,
    read,
    step(official = 0.5, commentary = 0.5, elapsed = 500) {
      at += elapsed
      media.official.currentTime += official
      media.commentary.currentTime += commentary
      return read()
    },
    events() { return results.flatMap(result => result.recovery ? [result.recovery] : []) },
    state() { return state },
  }
}

describe('playback progress', () => {
  for (const role of SOURCE_ROLES) for (const duration of [2, 10]) {
    it(`detects ${role} stopping for ${duration}s and includes its confirmation window`, () => {
      const h = harness()
      for (let index = 0; index < duration * 2; index++) h.step(role === 'official' ? 0 : 0.5, role === 'commentary' ? 0 : 0.5)
      expect(h.results.flatMap(result => result.started)).toEqual([role])
      expect(h.events()).toEqual([])
      h.step()
      expect(h.events()).toEqual([])
      h.step()
      expect(h.events()).toEqual([{ driftSeconds: duration }])
      expect(h.results.flatMap(result => result.ended)).toEqual([role])
      for (let index = 0; index < 8; index++) h.step()
      expect(h.events()).toHaveLength(1)
    })
  }

  it('does not infer drift when both streams stop and recover together', () => {
    const h = harness()
    for (let index = 0; index < 20; index++) h.step(0, 0)
    expect(h.results.flatMap(result => result.started)).toEqual(['official', 'commentary'])
    h.step(); h.step()
    expect(h.results.flatMap(result => result.ended)).toEqual(['official', 'commentary'])
    expect(h.events()).toEqual([])
  })

  it('accumulates only the difference when the two stalled streams resume separately', () => {
    const h = harness()
    for (let index = 0; index < 4; index++) h.step(0, 0)
    for (let index = 0; index < 6; index++) h.step(0.5, 0)
    expect(h.results.flatMap(result => result.ended)).toEqual(['official'])
    h.step(); h.step()
    expect(h.events()).toEqual([{ driftSeconds: 3 }])
    expect(h.results.flatMap(result => result.ended)).toEqual(['official', 'commentary'])
  })

  for (const flag of ['paused', 'seeking', 'ended'] as const) for (const role of SOURCE_ROLES) {
    it(`excludes ${role} ${flag} and rebuilds the baseline`, () => {
      const h = harness()
      h.media[role][flag] = true
      for (let index = 0; index < 6; index++) h.step(0, 0.5)
      h.media[role][flag] = false
      h.read()
      h.step(); h.step(); h.step()
      expect(h.events()).toEqual([])
      expect(h.results.flatMap(result => result.started)).toEqual([])
    })
  }

  it('abandons a pending stall when observation is suspended', () => {
    const h = harness()
    for (let index = 0; index < 4; index++) h.step(0, 0.5)
    expect(h.state().episode).not.toBeNull()
    h.read(false)
    h.step(); h.step(); h.step()
    expect(h.events()).toEqual([])
    expect(h.state().episode).toBeNull()
  })

  it('does not turn late timers or their missing samples into a stall', () => {
    const h = harness()
    h.step(0, 5, 5000)
    h.step(); h.step(); h.step()
    expect(h.events()).toEqual([])
    expect(h.results.flatMap(result => result.started)).toEqual([])
  })

  it('discards an active incident across a scheduling gap', () => {
    const h = harness()
    h.step(0); h.step(0); h.step(0)
    h.step(0, 5, 5000)
    h.step(); h.step()
    expect(h.events()).toEqual([])
  })

  it('requires a full 1.5 second window with less than 0.1 seconds of progress', () => {
    const h = harness()
    h.step(0); h.step(0)
    expect(h.results.flatMap(result => result.started)).toEqual([])
    h.step(0.11)
    expect(h.results.flatMap(result => result.started)).toEqual([])
    h.step(0); h.step(0)
    expect(h.results.flatMap(result => result.started)).toEqual([])
    h.step(0)
    expect(h.results.flatMap(result => result.started)).toEqual(['official'])
  })

  it('requires at least 0.5 seconds of accumulated difference', () => {
    const h = harness()
    for (let index = 0; index < 3; index++) h.step(0, 0.12)
    h.step(); h.step()
    expect(h.events()).toEqual([])
  })

  it('restarts the recovery window when playback stops again', () => {
    const h = harness()
    h.step(0); h.step(0); h.step(0)
    h.step()
    h.step(0)
    h.step()
    expect(h.events()).toEqual([])
    h.step()
    expect(h.events()).toEqual([{ driftSeconds: 2 }])
  })

  it('does not mutate prior state or keep references to mutable inputs', () => {
    const h = harness()
    const previous = h.state()
    const before = structuredClone(previous)
    h.step(0)
    h.media.official.currentTime = 999
    expect(previous).toEqual(before)
    expect(h.state().samples.at(-1)?.official.currentTime).toBe(100)
  })

  it('discards backwards positions and invalid clocks', () => {
    const h = harness()
    h.step(-5)
    h.step(); h.step(); h.step()
    expect(h.events()).toEqual([])
    const invalid = { ...h.media, at: Number.NaN }
    expect(observePlaybackProgress(h.state(), invalid).state.samples).toEqual([])
  })
})
