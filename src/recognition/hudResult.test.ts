import { describe, expect, it } from 'vitest'
import type { HudFieldResult, HudFrameResult } from '../core/hudWasm'
import { HudReplaySession, hudClockOutcome, hudSyncOutcome } from './hudResult'

const read = (value: number, text = String(value)): HudFieldResult => ({ status: 'read',
  reading: { text, value, confidence: 1, scores: [1], source: 'derived' }, debug: null })

function hudResult(content: HudFrameResult['content'] = 'live', round: number | null = 17,
  phase: HudFrameResult['phase'] = 'active'): HudFrameResult {
  return { variantId: 'test', selectionReason: null, content, phase,
    fields: { clock: read(97, '1:37'), scoreLeft: read(8), scoreRight: read(8),
      round: round === null ? { status: 'failed', reason: 'score-failed', debug: null } : read(round) },
    cues: {}, states: {}, organizer: { status: 'not-matched', score: 0, debug: null } }
}

describe('source-local replay continuity', () => {
  it('uses the single-frame live result at cold start and preserves indeterminate recognition', () => {
    const session = new HudReplaySession()
    expect(session.observe(hudResult()).content).toBe('live')
    expect(session.observe(hudResult('indeterminate')).content).toBe('indeterminate')
  })

  it('holds replay after its marker vanishes until the derived round changes', () => {
    const session = new HudReplaySession()
    expect(session.observe(hudResult('replay', 17)).content).toBe('replay')
    expect(session.observe(hudResult('live', 17)).content).toBe('replay')
    expect(session.observe(hudResult('indeterminate', null)).content).toBe('replay')
    expect(session.observe(hudResult('live', 18)).content).toBe('live')
  })

  it('uses the last known round if the replay marker arrives on an unreadable score frame', () => {
    const session = new HudReplaySession()
    session.observe(hudResult('live', 17))
    session.observe(hudResult('replay', null))
    expect(session.observe(hudResult('live', 18)).content).toBe('live')
  })

  it('preserves an unresolved layout while retaining replay memory for the next selected frame', () => {
    const session = new HudReplaySession()
    session.observe(hudResult('replay', 17))
    const unresolved = { ...hudResult('indeterminate', null, 'indeterminate'), variantId: null, selectionReason: 'no-match' as const }
    expect(session.observe(unresolved)).toBe(unresolved)
    expect(session.observe(hudResult('live', 17)).content).toBe('replay')
    expect(session.observe(hudResult('live', 18)).content).toBe('live')
  })

  it('waits for an actual round change if no round was known when replay began', () => {
    const session = new HudReplaySession()
    session.observe(hudResult('replay', null))
    expect(session.observe(hudResult('live', 17)).content).toBe('replay')
    expect(session.observe(hudResult('live', 18)).content).toBe('live')
  })

  it('keeps an explicit replay marker authoritative on a changed round', () => {
    const session = new HudReplaySession()
    session.observe(hudResult('replay', 17))
    expect(session.observe(hudResult('replay', 18)).content).toBe('replay')
    expect(session.observe(hudResult('live', 18)).content).toBe('replay')
    expect(session.observe(hudResult('live', 19)).content).toBe('live')
  })

  it('keeps the content and planted phase independent and clears both round anchors on reset', () => {
    const session = new HudReplaySession()
    expect(session.observe(hudResult('replay', 17, 'planted'))).toMatchObject({ content: 'replay', phase: 'planted' })
    session.reset()
    expect(session.observe(hudResult('live', 17)).content).toBe('live')
    session.reset()
    session.observe(hudResult('replay', null))
    expect(session.observe(hudResult('live', 18)).content).toBe('replay')
  })
})

describe('HUD countdown sync eligibility', () => {
  const frame = { mediaTime: 12, wallTime: 2000, frameIndex: 7 }

  it.each(['active', 'paused', 'roundOver'] as const)('passes a live %s countdown unchanged', phase => {
    expect(hudClockOutcome(hudResult('live', 17, phase), frame)).toMatchObject({ status: 'success',
      reading: { seconds: 97, text: '1:37', ...frame } })
  })

  it.each([
    ['replay', 'active', 'hud-replay'],
    ['live', 'statistics', 'hud-statistics'],
    ['live', 'indeterminate', 'hud-phase-indeterminate'],
    ['indeterminate', 'active', 'hud-content-indeterminate'],
  ] as const)('excludes %s/%s from sync despite a valid clock', (content, phase, reason) => {
    expect(hudClockOutcome(hudResult(content, 17, phase), frame)).toEqual({ status: 'indeterminate', reason })
  })

  it('lets the clock through when the pack judges no phase of play', () => {
    expect(hudClockOutcome(hudResult('live', 17, 'unconfigured'), frame)).toMatchObject({ status: 'success', reading: { seconds: 97 } })
  })

  it('retains an absent clock and preserves actual recognition failures', () => {
    const hud = hudResult('live', 17, 'planted')
    hud.fields.clock = { status: 'absent', debug: null }
    expect(hudClockOutcome(hud, frame)).toEqual({ status: 'absent' })
    const failed = { status: 'failed', reason: 'no-candidates' } as const
    expect(hudSyncOutcome(hudResult('indeterminate'), failed)).toBe(failed)
  })
})
