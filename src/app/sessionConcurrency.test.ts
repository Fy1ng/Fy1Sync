import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import { apiClient } from './apiClient'
import { createEmptyProfile } from '../core/profileSchema'
import { primeMediaElement } from '../test/setup'
import type { RecognitionSampler } from '../recognition/sampler'
import type { RecognitionOutcome, SourceRole } from '../core/types'

const sessions: Session[] = []
const source = { kind: 'test' as const, url: '/test-sources/test.mp4', input: 'test', label: 'test', loop: false, viaProxy: false }
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.restoreAllMocks() })

async function harness(sampler: RecognitionSampler | null = null) {
  const session = new Session({ createSampler: () => sampler })
  sessions.push(session)
  for (const role of ['official', 'commentary'] as const) {
    await session.loadSource(role, source)
    primeMediaElement(session.engine.element(role), { currentTime: 100, duration: 600 })
  }
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
    const sampler = { dispose() {}, async sample(_window: number, emit: (role: SourceRole, outcome: RecognitionOutcome) => void) {
      for (const role of ['official', 'commentary'] as const) for (let index = 0; index < 3; index++) for (let stable = 0; stable < 2; stable++) {
        emit(role, { status: 'success', reading: { text: `0:${59 - index}`, seconds: 59 - index,
          scores: [0.95], confidence: 0.95, mediaTime: 100 + index + stable / 30,
          wallTime: 1000 + index * 1000 + stable * 1000 / 30 + (role === 'commentary' ? 5000 : 0), frameIndex: index * 2 + stable } })
      }
    } } as unknown as RecognitionSampler
    const session = await harness(sampler)
    session.setProfileForAll(createEmptyProfile('test', 'test'))
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

describe('latest profile selection', () => {
  it('ignores a late preset response after selecting no profile', async () => {
    const session = await harness()
    let finish!: (value: Awaited<ReturnType<typeof apiClient.getPreset>>) => void
    vi.spyOn(apiClient, 'getPreset').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const loading = session.selectProfile('old')
    await session.selectProfile('')
    finish({ ok: true, value: { profile: createEmptyProfile('old'), etag: 'old' } })
    expect(await loading).toBe(false)
    expect(session.settings.profileId).toBe('')
    expect(session.profileFor('official')).toBeNull()
  })

  it('does not restore the boot preset after a new explicit choice', async () => {
    const session = await harness()
    session.updateSettings({ profileId: 'boot' })
    vi.spyOn(apiClient, 'listPresets').mockResolvedValue({ ok: true, value: { presets: [{ id: 'boot', name: 'boot', etag: 'boot', templateChars: 11, updatedAt: 1 }] } })
    let finish!: (value: Awaited<ReturnType<typeof apiClient.getPreset>>) => void
    vi.spyOn(apiClient, 'getPreset').mockImplementation(id => id === 'boot'
      ? new Promise(resolve => { finish = resolve })
      : Promise.resolve({ ok: true, value: { profile: createEmptyProfile(id), etag: id } }))
    const boot = session.boot()
    await tick()
    await session.selectProfile('new')
    finish({ ok: true, value: { profile: createEmptyProfile('boot'), etag: 'boot' } })
    await boot
    expect(session.settings.profileId).toBe('new')
    expect(session.profileFor('official')?.id).toBe('new')
  })

  it('ignores an old boot list before starting a preset fetch', async () => {
    const session = await harness()
    session.updateSettings({ profileId: 'boot' })
    let finish!: (value: Awaited<ReturnType<typeof apiClient.listPresets>>) => void
    vi.spyOn(apiClient, 'listPresets').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const fetch = vi.spyOn(apiClient, 'getPreset')
    const boot = session.boot()
    await session.selectProfile('')
    finish({ ok: true, value: { presets: [] } })
    await boot
    expect(fetch).not.toHaveBeenCalled()
    expect(session.settings.profileId).toBe('')
  })
})
