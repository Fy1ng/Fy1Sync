import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import { primeMediaElement } from '../test/setup'
import type { RecognitionSampler } from '../recognition/sampler'
import type { RecognitionOutcome, SourceRole } from '../core/types'

const sessions: Session[] = []
const source = { kind: 'test' as const, url: '/test-sources/test.mp4', input: 'test', label: 'test', loop: false, viaProxy: false }
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.restoreAllMocks() })

async function harness(sampler: RecognitionSampler | null = null, readingClock?: () => number) {
  const session = new Session({ createSampler: () => sampler, readingClock })
  sessions.push(session)
  for (const role of ['official', 'commentary'] as const) {
    await session.loadSource(role, source)
    primeMediaElement(session.engine.element(role), { currentTime: 100, duration: 600 })
  }
  if (sampler) await session.setPlaying(true)
  return session
}

/** Preserve real MediaEngine confirmation while holding the native seeked event. */
function holdSeeks(element: HTMLVideoElement) {
  let position = element.currentTime
  let seeking = false
  const targets: number[] = []
  Object.defineProperty(element, 'currentTime', { configurable: true, get: () => position,
    set: value => { position = value; seeking = true; targets.push(value); element.dispatchEvent(new Event('seeking')) } })
  Object.defineProperty(element, 'seeking', { configurable: true, get: () => seeking })
  return {
    targets,
    finish(at = position) { position = at; seeking = false; element.dispatchEvent(new Event('seeked')); element.dispatchEvent(new Event('timeupdate')) },
    restore() { Reflect.deleteProperty(element, 'currentTime'); Reflect.deleteProperty(element, 'seeking') },
  }
}

describe('serialized manual offsets', () => {
  it('does not report a stale buffer limit when the live window grows before the second seek', async () => {
    const session = await harness()
    const official = session.engine.element('official'), commentary = session.engine.element('commentary')
    for (const video of [official, commentary]) primeMediaElement(video, { duration: Infinity, currentTime: 100, seekableStart: 0, seekableEnd: 110 })
    await session.seekPlayback('official', -5)
    await session.seekPlayback('commentary', -5)
    primeMediaElement(commentary, { duration: Infinity, currentTime: 95, seekableStart: 0, seekableEnd: 98 })
    const clock = holdSeeks(official)
    const pending = session.applyOffset(2)
    await tick()
    expect(clock.targets).toEqual([98])
    primeMediaElement(commentary, { duration: Infinity, currentTime: 95, seekableStart: 0, seekableEnd: 102 })
    clock.finish()
    const plan = await pending
    expect(official.currentTime).toBe(98)
    expect(commentary.currentTime).toBe(100)
    expect(plan.effectiveOffset).toBe(2)
    expect(plan.limited).toBe(false)
    expect(plan.limitReason).toBeUndefined()
    expect(plan.seeks.find(seek => seek.role === 'commentary')).toMatchObject({ from: 95, to: 100, requested: 100, clamped: false, shortfall: 0 })
    expect(session.flush().notices.some(notice => notice.text.includes('缓存长度不足'))).toBe(false)
  })

  it('records the actual later clamp when the live window becomes shorter during the first seek', async () => {
    const session = await harness()
    const official = session.engine.element('official'), commentary = session.engine.element('commentary')
    for (const video of [official, commentary]) primeMediaElement(video, { duration: Infinity, currentTime: 100, seekableStart: 0, seekableEnd: 102 })
    await session.seekPlayback('official', -5)
    await session.seekPlayback('commentary', -5)
    const clock = holdSeeks(official)
    const pending = session.applyOffset(2)
    await tick()
    primeMediaElement(commentary, { duration: Infinity, currentTime: 95, seekableStart: 0, seekableEnd: 98 })
    clock.finish()
    const plan = await pending
    expect(commentary.currentTime).toBe(98)
    expect(plan).toMatchObject({ effectiveOffset: 0, limited: true, limitReason: 'buffer-limit' })
    expect(plan.seeks.find(seek => seek.role === 'commentary')).toMatchObject({ from: 95, to: 98, requested: 100, clamped: true, shortfall: 2 })
    expect(session.flush().notices.some(notice => notice.text.includes('缓存长度不足'))).toBe(true)
  })

  it('retains the observed peer advance as seek residual without calling it a buffer limit', async () => {
    const session = await harness()
    const official = session.engine.element('official'), commentary = session.engine.element('commentary')
    const clock = holdSeeks(official)
    const pending = session.applyOffset(5)
    await tick()
    primeMediaElement(commentary, { currentTime: 100.3, duration: 600 })
    clock.finish()
    const plan = await pending
    expect(plan).toMatchObject({ requestedOffset: 5, effectiveOffset: 5.3, limited: false })
    expect(session.flush()).toMatchObject({ requestedOffsetSeconds: 5, offsetSeconds: 5.3, appliedRewind: { official: 5.3, commentary: 0 } })
    expect(session.flush().notices.some(notice => notice.text.includes('缓存长度不足'))).toBe(false)
  })

  it('finishes one seek and coalesces the remaining inputs to the latest target', async () => {
    const session = await harness()
    const official = session.engine.element('official')
    const clock = holdSeeks(official)
    const first = session.applyOffset(5)
    await tick()
    const second = session.applyOffset(10)
    const third = session.applyOffset(20)
    const last = session.applyOffset(12)
    expect(clock.targets).toEqual([95])
    clock.finish()
    await tick()
    expect(clock.targets).toEqual([95, 88])
    clock.finish()
    await Promise.all([first, second, third, last])
    expect(official.currentTime).toBe(88)
    expect(session.flush()).toMatchObject({ offsetSeconds: 12, requestedOffsetSeconds: 12, appliedRewind: { official: 12, commentary: 0 } })
  })

  it('drops an obsolete sign-flip second leg when the latest request resets to zero', async () => {
    const session = await harness()
    await session.applyOffset(5)
    const clock = holdSeeks(session.engine.element('official'))
    const change = session.applyOffset(-3)
    await tick()
    const reset = session.resetOffset()
    clock.finish()
    await Promise.all([change, reset])
    expect(clock.targets).toEqual([100])
    expect(session.engine.element('commentary').currentTime).toBe(100)
    expect(session.flush().appliedRewind).toEqual({ official: 0, commentary: 0 })
  })

  it('replans from an unsuccessful seek actual landing position', async () => {
    const session = await harness()
    const clock = holdSeeks(session.engine.element('official'))
    const first = session.applyOffset(5)
    await tick()
    const next = session.applyOffset(10)
    clock.finish(97)
    await tick()
    expect(clock.targets).toEqual([95, 90])
    clock.finish()
    await Promise.all([first, next])
    expect(session.flush().appliedRewind.official).toBe(10)
    expect(session.engine.element('official').currentTime).toBe(90)
  })

  it('invalidates pending inputs and late completion on source replacement', async () => {
    const session = await harness()
    const official = session.engine.element('official')
    const clock = holdSeeks(official)
    const first = session.applyOffset(5)
    await tick()
    const pending = session.applyOffset(15)
    clock.restore()
    await session.loadSource('official', { ...source, url: '/test-sources/new.mp4' })
    primeMediaElement(official, { currentTime: 40, duration: 600 })
    await Promise.all([first, pending])
    expect(official.currentTime).toBe(40)
    expect(clock.targets).toEqual([95])
    expect(session.flush()).toMatchObject({ requestedOffsetSeconds: 0, appliedRewind: { official: 0, commentary: 0 } })
  })

  it('accounts for a cancelled automatic seek before starting manual adjustment', async () => {
    let readingAt = 0
    const sampler = { dispose() {}, async sample(_window: number, emit: (role: SourceRole, outcome: RecognitionOutcome) => void) {
      for (const role of ['official', 'commentary'] as const) for (let index = 0; index < 3; index++) for (let stable = 0; stable < 2; stable++) {
        emit(role, { status: 'success', reading: { text: `0:${59 - index}`, seconds: 59 - index,
          scores: [0.95], confidence: 0.95, mediaTime: 100 + index + stable / 30,
          wallTime: (readingAt = 1000 + index * 1000 + stable * 1000 / 30 + (role === 'commentary' ? 5000 : 0)), frameIndex: index * 2 + stable } })
      }
    } } as unknown as RecognitionSampler
    const session = await harness(sampler, () => readingAt)
    const clock = holdSeeks(session.engine.element('official'))
    const automatic = session.syncNow()
    await tick()
    expect(clock.targets).toEqual([95])
    const manual = session.applyOffset(2)
    await tick()
    expect(clock.targets).toEqual([95])
    expect(session.autoSync.autoApplyAuthorized).toBe(false)
    clock.finish()
    await tick()
    expect(clock.targets).toEqual([95, 98])
    clock.finish()
    expect((await automatic).failure?.kind).toBe('cancelled')
    await manual
    expect(session.engine.element('official').currentTime).toBe(98)
    expect(session.flush().appliedRewind.official).toBe(2)
  })

  it('keeps actual movement on an unchanged source when only its peer is replaced', async () => {
    const session = await harness()
    const clock = holdSeeks(session.engine.element('official'))
    const first = session.applyOffset(5)
    await tick()
    await session.loadSource('commentary', { ...source, url: '/test-sources/replacement.mp4' })
    primeMediaElement(session.engine.element('commentary'), { currentTime: 40, duration: 600 })
    clock.finish()
    await first
    expect(session.flush().appliedRewind).toEqual({ official: 5, commentary: 0 })
    const next = session.applyOffset(8)
    await tick()
    expect(clock.targets).toEqual([95, 92])
    clock.finish()
    await next
    expect(session.flush().offsetSeconds).toBe(8)
    expect(session.engine.element('commentary').currentTime).toBe(40)
  })

  it('settles pending callers when the session is disposed during a seek', async () => {
    const session = await harness()
    holdSeeks(session.engine.element('official'))
    const first = session.applyOffset(5)
    await tick()
    const pending = session.applyOffset(8)
    session.dispose()
    await Promise.all([first, pending])
    await tick()
    expect(session.offsetBusy).toBe(false)
  })
})
