import { describe, expect, it } from 'vitest'
import { createEmptyHudStylePack, type HudCue, type HudFieldId, type HudStylePack } from '../../core/hudStylePack'
import type { HudDebug, HudFieldResult, HudFrameResult, HudPresenceResult } from '../../core/hudWasm'
import { analyzeValidationFrame, failureValidationRow, summarizeValidation } from './batchValidationAnalysis'
import type { ValidationRow } from './batchValidationTypes'

function pack(): HudStylePack {
  const value = createEmptyHudStylePack('test/validation', '验收测试')
  const variant = value.variants[0]!
  for (const id of ['scoreLeft', 'scoreRight'] as const) variant.fields[id] = {
    ...structuredClone(variant.fields.clock!), grammar: { kind: 'integer', min: 0, max: 99 },
  }
  const cue = (): HudCue => ({ enabled: true, roi: { x: 0, y: 0, w: 10, h: 10 },
    preprocess: structuredClone(variant.fields.clock!.preprocess), templates: ['test'], minScore: 0.9 })
  variant.cues = { replay: cue(), bomb: cue(), timeout: cue(), timeoutRight: cue() }
  variant.organizer = cue()
  return value
}

const read = (value: number, text = String(value), confidence = 1): HudFieldResult => ({ status: 'read',
  reading: { text, value, confidence, scores: [confidence], source: 'recognized' }, debug: null })
const presence = (status: HudPresenceResult['status'] = 'not-matched', score = 0): HudPresenceResult =>
  status === 'failed' || status === 'indeterminate' ? { status, score: null, reason: 'test-failure', debug: null }
    : { status, score, debug: null }

function result(seconds = 97, left = 8, right = 3): HudFrameResult {
  return { variantId: 'official-top-1080', selectionReason: null, content: 'live', phase: 'active',
    fields: { clock: read(seconds), scoreLeft: read(left), scoreRight: read(right), round: read(left + right + 1) },
    cues: { replay: presence(), bomb: presence(), timeout: presence(), timeoutRight: presence() },
    organizer: presence('matched', 1), states: {} }
}

function frame(value = result(), previous: ValidationRow | null = null, at = previous ? previous.at + 1 : 0,
  profile = pack(), index = previous ? previous.index + 1 : 0) {
  return analyzeValidationFrame(value, profile, at, index, previous)
}
const issues = (row: ValidationRow) => row.notes.filter(note => note.kind === 'issue')
const codes = (row: ValidationRow) => issues(row).map(note => note.code)

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

describe('compact validation evidence', () => {
  it('does not mutate a frozen pack, result, or previous row and retains no debug arrays', () => {
    const profile = freeze(pack())
    const previous = freeze(frame(result(), null, 0, profile))
    const input = result(96)
    input.fields.clock.debug = { roiPixels: { x: 1, y: 2, width: 3, height: 4 },
      gray: { width: 1, height: 1, data: new Uint8Array([1]) }, binary: { width: 1, height: 1, data: new Uint8Array([255]) },
      boxes: [], projection: [255], inkRatio: 1, normalized: [new Uint8Array([255])], matches: [],
    }
    const before = JSON.stringify([profile, input, previous])
    const output = frame(freeze(input), previous, 1, profile)
    expect(JSON.stringify([profile, input, previous])).toBe(before)
    expect(output.fields.clock).toEqual({ status: 'read', text: '96', value: 96, confidence: 1, reason: null })
    expect(JSON.stringify(output)).not.toMatch(/debug|pixels|normalized|projection|roiPixels|scores/)
    output.fields.clock.text = 'changed evidence'
    expect(input.fields.clock.status === 'read' && input.fields.clock.reading.text).toBe('96')
  })

  it.each(['no-match', 'multiple-matches'] as const)('reports %s once without claiming fields were attempted', selectionReason => {
    const input = result()
    input.variantId = null
    input.selectionReason = selectionReason
    input.content = 'indeterminate'; input.phase = 'indeterminate'
    const output = frame(input)
    expect(output.notes).toHaveLength(1)
    expect(output.notes[0]).toMatchObject({ kind: 'issue', target: 'layout', code: selectionReason === 'no-match' ? 'no-layout' : 'multiple-layouts' })
    expect(summarizeValidation([output]).fields.clock).toEqual({ read: 0, attempted: 0, absent: 0, disabled: 0 })
  })

  it('treats an unrecognized layout ID as unavailable instead of trusting fabricated fields', () => {
    const output = frame({ ...result(), variantId: 'missing-layout' })
    expect(output.layout).toBeNull()
    expect(codes(output)).toEqual(['no-layout'])
  })

  it('reports enabled field failures and preserves disabled/absent as distinct results', () => {
    const input = result()
    input.fields.clock = { status: 'failed', reason: 'low-confidence', debug: null }
    input.fields.scoreLeft = { status: 'disabled', debug: null }
    input.fields.scoreRight = { status: 'absent', debug: null }
    const profile = pack(); profile.variants[0]!.fields.scoreLeft!.enabled = false
    const output = frame(input, null, 0, profile)
    expect(issues(output)).toEqual([{ kind: 'issue', target: 'clock', code: 'field-failed', message: '倒计时识别失败: low-confidence' }])
    expect(output.fields.scoreLeft.status).toBe('disabled')
    expect(output.fields.scoreRight.status).toBe('absent')
  })

  it('does not flag fields or cues deliberately omitted from the pack', () => {
    const input = result(), profile = pack()
    profile.variants[0]!.fields.scoreLeft = null
    profile.variants[0]!.fields.scoreRight = null
    profile.variants[0]!.organizer = null
    profile.variants[0]!.cues = {}
    input.fields.scoreLeft = input.fields.scoreRight = { status: 'failed', reason: 'not-configured', debug: null }
    input.organizer = presence('failed')
    input.cues = {}
    const output = frame(input, null, 0, profile)
    expect(issues(output)).toEqual([])
    expect(summarizeValidation([output]).fields.scoreLeft.attempted).toBe(0)
  })

  it('reports unknown content, phase, enabled cue failures and a missing configured cue', () => {
    const input = result()
    input.content = 'indeterminate'; input.phase = 'indeterminate'
    input.cues.timeout = presence('failed')
    delete input.cues.timeoutRight
    input.organizer = presence('indeterminate')
    const output = frame(input)
    expect(issues(output).map(note => note.target)).toEqual(['timeout', 'timeoutRight', 'organizer', 'state', 'state'])
    expect(codes(output)).toEqual(['cue-unreadable', 'cue-unreadable', 'cue-unreadable', 'content-indeterminate', 'phase-indeterminate'])
  })

  it('does not turn a known disabled cue into a failure or an appearance transition', () => {
    const input = result(), profile = pack()
    profile.variants[0]!.cues.timeout!.enabled = false
    input.cues.timeout = presence('disabled')
    const output = frame(input, null, 0, profile)
    expect(output.cues.timeout?.status).toBe('disabled')
    expect(output.notes.some(note => note.target === 'timeout')).toBe(false)
  })
})

describe('threshold-aware review findings', () => {
  it('uses each field threshold rather than a hardcoded confidence number', () => {
    const input = result(), profile = pack()
    profile.variants[0]!.fields.clock!.match.minScore = 0.9
    profile.variants[0]!.fields.scoreLeft!.match.minScore = 0.5
    input.fields.clock = read(97, '1:37', 0.905)
    input.fields.scoreLeft = read(8, '8', 0.905)
    const output = frame(input, null, 0, profile)
    expect(issues(output).map(note => [note.target, note.code])).toEqual([['clock', 'weak-score']])
  })

  it('checks the weakest glyph score and near-threshold runner-up margin', () => {
    const input = result(), profile = pack()
    const clock = read(97, '1:37', 0.98)
    if (clock.status === 'read') clock.reading.scores = [1, 1, 1, 0.825]
    clock.debug = { matches: [{ char: '7', score: 0.96, runnerUpScore: 0.927, sampleIndex: 0 }] } as HudDebug
    input.fields.clock = clock
    const output = frame(input, null, 0, profile)
    expect(codes(output)).toEqual(['weak-score', 'weak-margin'])
  })

  it('does not reintroduce a distinctive colon score into the digit aggregate', () => {
    const profile = pack(), input = result()
    profile.variants[0]!.fields.clock!.match.minScore = 0.84
    input.fields.clock = read(97, '1:37', 0.97)
    if (input.fields.clock.status === 'read') input.fields.clock.reading.scores = [0.99, 0.85, 0.97, 0.98]
    input.fields.clock.debug = { matches: [{ char: ':', score: 0.85, runnerUpScore: 0.3, sampleIndex: 0 }] } as HudDebug
    const before = JSON.stringify([profile, input])
    const output = frame(freeze(input), null, 0, freeze(profile))
    expect(issues(output)).toEqual([])
    expect(output.fields.clock.confidence).toBe(0.97)
    expect(JSON.stringify([profile, input])).toBe(before)
  })

  it('still flags a weak digit even when its colon is distinctive', () => {
    const input = result()
    input.fields.clock = read(97, '1:37', 0.825)
    if (input.fields.clock.status === 'read') input.fields.clock.reading.scores = [0.99, 0.85, 0.97, 0.825]
    input.fields.clock.debug = { matches: [{ char: ':', score: 0.85, runnerUpScore: 0.3, sampleIndex: 0 }] } as HudDebug
    expect(codes(frame(input))).toEqual(['weak-score'])
  })

  it('reports an ambiguous separator independently of otherwise strong digits', () => {
    const input = result()
    input.fields.clock = read(97, '1:37', 0.98)
    if (input.fields.clock.status === 'read') input.fields.clock.reading.scores = [0.99, 0.85, 0.99, 0.98]
    input.fields.clock.debug = { matches: [{ char: ':', score: 0.85, runnerUpScore: 0.817, sampleIndex: 0 }] } as HudDebug
    const output = frame(input)
    expect(codes(output)).toEqual(['weak-margin'])
    expect(issues(output)[0]?.message).toContain('冒号')
    expect(output.fields.clock.confidence).toBe(0.98)
  })

  it('uses the engine aggregate rather than guessing the positions in incomplete score metadata', () => {
    const input = result()
    input.fields.clock = read(97, '1:37', 0.98)
    if (input.fields.clock.status === 'read') input.fields.clock.reading.scores = [0.7]
    expect(issues(frame(input))).toEqual([])
    if (input.fields.clock.status === 'read') input.fields.clock.reading.confidence = 0.825
    expect(codes(frame(input))).toEqual(['weak-score'])
  })

  it.each(['clock', 'scoreLeft', 'scoreRight'] as const)('retains all numeric scores for separator-free %s', id => {
    const profile = pack(), input = result()
    profile.variants[0]!.fields.clock!.grammar = { kind: 'countdown', format: 'ss' }
    input.fields[id] = read(37, '37', 0.98)
    if (input.fields[id].status === 'read') input.fields[id].reading.scores = [0.825, 0.98]
    expect(issues(frame(input, null, 0, profile)).map(note => [note.target, note.code])).toEqual([[id, 'weak-score']])
  })

  it('does not call perfect matches weak when a user requires a perfect score', () => {
    const input = result(), profile = pack()
    profile.variants[0]!.fields.clock!.match.minScore = 1
    profile.variants[0]!.fields.clock!.match.minMargin = 0
    input.fields.clock.debug = { matches: [{ char: '7', score: 1, runnerUpScore: 1, sampleIndex: 0 }] } as HudDebug
    expect(codes(frame(input, null, 0, profile))).toEqual([])
  })
})

describe('conservative temporal findings', () => {
  it('accepts second-boundary quantization without an exact one-second countdown assumption', () => {
    const start = frame(result(60))
    expect(codes(frame(result(59), start, 1))).toEqual([])
    expect(codes(frame(result(60), start, 0.5))).toEqual([])
    expect(codes(frame(result(58), start, 1.02))).toEqual([])
    expect(codes(frame(result(54), start, 5))).toEqual([])
  })

  it('marks an implausible jump during a short, stable live round', () => {
    const output = frame(result(79), frame(result(97)))
    expect(codes(output)).toContain('clock-jump')
    expect(output.notes.find(note => note.code === 'clock-jump')?.message).toContain('1.00s')
  })

  it.each(['paused', 'planted', 'roundOver', 'statistics', 'indeterminate'] as const)('does not extrapolate through %s', phase => {
    const old = frame({ ...result(), phase })
    const same = frame({ ...result(20), phase }, old)
    const recovered = frame(result(110), old)
    expect(codes(same)).not.toContain('clock-jump')
    expect(codes(recovered)).not.toContain('clock-jump')
  })

  it('does not extrapolate through replay or unknown content', () => {
    for (const content of ['replay', 'indeterminate'] as const) {
      const old = frame({ ...result(), content })
      expect(codes(frame(result(10), old))).not.toContain('clock-jump')
      expect(codes(frame({ ...result(10), content }, frame(result())))).not.toContain('clock-jump')
    }
  })

  it('lists a normal score increment and clock reset as a round transition, not a clock error', () => {
    const output = frame(result(115, 9, 3), frame(result(7, 8, 3)))
    expect(codes(output)).toEqual([])
    expect(output.notes).toContainEqual({ kind: 'transition', target: 'scoreLeft', code: 'score-change', message: '左比分变化: 8 -> 9' })
  })

  it('keeps a paired side swap out of score-decrease and clock-jump findings', () => {
    const output = frame(result(115, 3, 8), frame(result(7, 8, 3)))
    expect(codes(output)).toEqual([])
    expect(output.notes.some(note => note.code === 'score-swap')).toBe(true)
  })

  it('flags an isolated short-interval score jump independently on the correct side', () => {
    const output = frame(result(96, 8, 8), frame(result()))
    expect(issues(output).map(note => [note.target, note.code])).toEqual([['scoreRight', 'score-jump']])
  })

  it('flags simultaneous non-swap increases in a short unchanged live phase', () => {
    const output = frame(result(96, 9, 4), frame(result()))
    expect(issues(output).map(note => [note.target, note.code])).toEqual([['scoreLeft', 'score-jump'], ['scoreRight', 'score-jump']])
  })

  it('does not insist a long gap can contain only one point or an uninterrupted countdown', () => {
    const output = frame(result(100, 12, 3), frame(result()), 240)
    expect(codes(output)).toEqual([])
    expect(output.notes.some(note => note.code === 'score-change')).toBe(true)
  })

  it('does not compare nonadjacent rows, reverse times, or a changed layout', () => {
    const old = frame(result())
    expect(codes(frame(result(10), old, 1, pack(), 3))).not.toContain('clock-jump')
    expect(codes(frame(result(10), old, -1))).not.toContain('clock-jump')
    const profile = pack(), next = structuredClone(profile.variants[0]!)
    next.id = 'other-layout'; profile.variants.push(next)
    const output = frame({ ...result(10), variantId: next.id }, old, 1, profile)
    expect(codes(output)).not.toContain('clock-jump')
    expect(output.notes.some(note => note.code === 'layout-change')).toBe(true)
  })

  it.each(['clock', 'scoreLeft', 'scoreRight'] as const)('interrupts continuity on an unreadable %s frame', id => {
    const unknown = result(30)
    unknown.fields[id] = { status: 'indeterminate', reason: 'unclear', debug: null }
    const middle = frame(unknown, frame(result()))
    expect(codes(middle)).not.toContain('clock-jump')
    expect(codes(frame(result(110), middle))).not.toContain('clock-jump')
  })

  it('does not use a borderline reading as a stable temporal anchor', () => {
    const weak = result(30); weak.fields.clock = read(30, '0:30', 0.825)
    const output = frame(weak, frame(result()))
    expect(codes(output)).toContain('weak-score')
    expect(codes(output)).not.toContain('clock-jump')
    expect(codes(frame(result(110), output))).not.toContain('clock-jump')
  })

  it('does not extrapolate if a relevant marker is unknown or visibly present despite active phase', () => {
    for (const status of ['failed', 'indeterminate', 'matched'] as const) {
      const input = result(30); input.cues.timeoutRight = presence(status, 1)
      expect(codes(frame(input, frame(result())))).not.toContain('clock-jump')
    }
  })

  it('requires readable stable scores to compare an unconfigured phase', () => {
    const first = frame({ ...result(), phase: 'unconfigured' })
    expect(codes(frame({ ...result(20), phase: 'unconfigured' }, first))).toContain('clock-jump')
    const profile = pack(), input = { ...result(20), phase: 'unconfigured' as const }
    for (const id of ['scoreLeft', 'scoreRight'] as const) {
      profile.variants[0]!.fields[id] = null
      input.fields[id] = { status: 'failed', reason: 'not-configured', debug: null }
    }
    expect(codes(frame(input, first, 1, profile))).not.toContain('clock-jump')
  })
})

describe('event transitions and summary accounting', () => {
  it('records left/right Timeout transitions separately without implying recognition failure', () => {
    const initial = frame(result())
    const left = { ...result(), phase: 'paused' as const }; left.cues.timeout = presence('matched', 1)
    const leftRow = frame(left, initial)
    expect(codes(leftRow)).toEqual([])
    expect(leftRow.notes.some(note => note.target === 'timeout' && note.code === 'cue-appeared')).toBe(true)
    const right = { ...result(), phase: 'paused' as const }; right.cues.timeoutRight = presence('matched', 1)
    const rightRow = frame(right, leftRow)
    expect(codes(rightRow)).toEqual([])
    expect(rightRow.notes.filter(note => note.target === 'timeout' || note.target === 'timeoutRight').map(note => [note.target, note.code]))
      .toEqual([['timeout', 'cue-disappeared'], ['timeoutRight', 'cue-appeared']])
  })

  it('records observed replay and bomb markers in the first frame, without inventing an onset time', () => {
    const input = { ...result(), content: 'replay' as const, phase: 'planted' as const }
    input.cues.replay = presence('matched', 1); input.cues.bomb = presence('matched', 1)
    const output = frame(input)
    expect(codes(output)).toEqual([])
    expect(output.notes.find(note => note.target === 'replay')?.message).toContain('当前观测到')
    expect(output.notes.find(note => note.target === 'bomb')?.message).toContain('当前观测到')
    expect(output.notes.some(note => note.code === 'content-observed')).toBe(true)
    expect(output.notes.some(note => note.code === 'phase-observed')).toBe(true)
  })

  it('does not interpret an unreadable marker as a disappearance', () => {
    const input = result(); input.cues.replay = presence('matched', 1)
    const before = frame(input)
    const next = result(); next.cues.replay = presence('failed')
    const output = frame(next, before)
    expect(output.notes.some(note => note.target === 'replay' && note.code === 'cue-disappeared')).toBe(false)
    expect(output.notes.some(note => note.target === 'replay' && note.code === 'cue-unreadable')).toBe(true)
  })

  it('creates an independent frame-failure row that breaks continuity and excludes per-field attempts', () => {
    const failed = freeze(failureValidationRow(1, 1, 'decoder timeout'))
    expect(failed.notes).toEqual([{ kind: 'issue', target: 'frame', code: 'frame-error', message: '取帧或识别调用失败: decoder timeout' }])
    const next = frame(result(20), failed)
    expect(codes(next)).not.toContain('clock-jump')
    const summary = summarizeValidation([frame(result()), failed, next])
    expect(summary.sampled).toBe(3)
    expect(summary.issueFrames).toBe(1)
    expect(summary.fields.clock).toEqual({ read: 2, attempted: 2, absent: 0, disabled: 0 })
  })

  it('counts issue frames once and separates absent/disabled from reading attempts', () => {
    const first = frame(result())
    const secondInput = result(96)
    secondInput.fields.clock = { status: 'failed', reason: 'low-confidence', debug: null }
    secondInput.fields.scoreLeft = { status: 'indeterminate', reason: 'unclear', debug: null }
    secondInput.fields.scoreRight = { status: 'absent', debug: null }
    const second = frame(secondInput, first)
    const thirdInput = result(95), profile = pack()
    for (const id of ['clock', 'scoreLeft', 'scoreRight'] as HudFieldId[]) {
      profile.variants[0]!.fields[id]!.enabled = false
      thirdInput.fields[id] = { status: 'disabled', debug: null }
    }
    const third = frame(thirdInput, second, 2, profile)
    const summary = summarizeValidation(freeze([first, second, third]))
    expect(summary.issueFrames).toBe(1)
    expect(summary.transitionFrames).toBe(1)
    expect(summary.fields.clock).toEqual({ read: 1, attempted: 2, absent: 0, disabled: 1 })
    expect(summary.fields.scoreLeft).toEqual({ read: 1, attempted: 2, absent: 0, disabled: 1 })
    expect(summary.fields.scoreRight).toEqual({ read: 1, attempted: 1, absent: 1, disabled: 1 })
    expect(JSON.stringify(summary)).not.toMatch(/accuracy|准确率/)
  })

  it('starts a fresh empty summary without sharing counters between calls', () => {
    const first = summarizeValidation([]), second = summarizeValidation([])
    first.fields.clock.attempted = 10
    expect(second).toEqual({ sampled: 0, issueFrames: 0, transitionFrames: 0,
      fields: { clock: { read: 0, attempted: 0, absent: 0, disabled: 0 }, scoreLeft: { read: 0, attempted: 0, absent: 0, disabled: 0 },
        scoreRight: { read: 0, attempted: 0, absent: 0, disabled: 0 } } })
  })
})
