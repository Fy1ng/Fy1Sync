/**
 * Session tests: the sync bookkeeping, against a real engine on jsdom's media stub.
 *
 * A mocked engine would let these tests assert whatever the mock was told to return,
 * which is exactly the thing that must not be trusted here — `appliedRewind` is only
 * meaningful if it reflects where the elements actually landed. So the engine is real and
 * only the element clock is fake (src/test/setup.ts), and the assertions read the
 * elements' `currentTime` where the claim is about position.
 *
 * The recognition worker and the preload are the two things jsdom cannot provide;
 * `createSampler` is injected and the danmaku tests drive `pushDanmaku`/the private
 * ingest handlers through a stub subscription.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MediaEngine } from '../media/mediaEngine'
import { primeMediaElement } from '../test/setup'
import type { MediaDescriptor, SourceRole } from '../core/types'
import { DEFAULT_SETTINGS, type SettingsStorage } from './settings'
import { Session, roleName } from './session'

function descriptor(overrides: Partial<MediaDescriptor> = {}): MediaDescriptor {
  return {
    kind: 'progressive',
    url: 'https://example.test/official.mp4',
    input: 'https://example.test/official.mp4',
    label: '官方直播',
    loop: false,
    viaProxy: false,
    ...overrides,
  }
}

function memoryStorage(): SettingsStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>()
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  }
}

const sessions: Session[] = []

interface Harness {
  session: Session
  engine: MediaEngine
  storage: ReturnType<typeof memoryStorage>
}

/**
 * A session with both sources loaded as 600 s VOD, playheads at 100 s.
 *
 * 100 s in means both sides have rewind head-room, so a plan is limited by what the test
 * asks for rather than by the fixture. Tests about clamping set up their own positions.
 */
async function harness(
  options: { official?: number; commentary?: number; load?: boolean } = {},
): Promise<Harness> {
  const engine = new MediaEngine()
  const storage = memoryStorage()
  // No worker in jsdom, and none of these tests exercise recognition.
  const session = new Session({ engine, storage, createSampler: () => null })
  sessions.push(session)
  if (options.load !== false) {
    await session.loadSource('official', descriptor())
    await session.loadSource('commentary', descriptor({ label: '解说直播' }))
    primeMediaElement(engine.element('official'), {
      duration: 600,
      currentTime: options.official ?? 100,
    })
    primeMediaElement(engine.element('commentary'), {
      duration: 600,
      currentTime: options.commentary ?? 100,
    })
  }
  return { session, engine, storage }
}

function timeOf(engine: MediaEngine, role: SourceRole): number {
  return engine.element(role).currentTime
}

afterEach(() => {
  while (sessions.length > 0) sessions.pop()?.dispose()
})

describe('backend playback navigation and danmaku processing', () => {
  it('serializes relative playback seeks and accounts for the actual resulting rewind', async () => {
    const h = await harness()
    const video = h.engine.element('official')
    expect(await Promise.all([h.session.seekPlayback('official', -5), h.session.seekPlayback('official', -10)])).toEqual([true, true])
    expect(h.engine.element('official')).toBe(video)
    expect(video.currentTime).toBe(85)
    expect(h.session.flush().appliedRewind.official).toBe(15)
    expect(await h.session.returnPlaybackToLive('official')).toBe(false)
    expect(h.session.flush().autoSync.authorized).toBe(false)
  })

  it('applies media-time duplicate merging without changing the original message text', async () => {
    const h = await harness()
    h.session.configureDanmakuProcessing({ duplicateMode: 'combo', filterSuspectedBots: true })
    h.session.pushDanmaku({ text: 'same', user: 'one', color: '#fff', dms: 1 })
    h.session.pushDanmaku({ text: 'same', user: 'two', color: '#fff', dms: 1 })
    h.session.pushDanmaku({ text: 'suspected', user: 'three', color: '#fff' })
    const released = h.session.drainDanmaku()
    expect(released).toHaveLength(1)
    expect(released[0]).toMatchObject({ text: 'same', duplicateCount: 2 })
    h.session.pushDanmaku({ text: 'same', user: 'four', color: '#fff', dms: 1 })
    expect(h.session.drainDanmaku()).toHaveLength(0)
    expect(h.session.chatHistory()[0]).toMatchObject({ text: 'same', duplicateCount: 3 })
  })
})

describe('Session snapshot', () => {
  it('starts from stored settings', async () => {
    const engine = new MediaEngine()
    const storage = memoryStorage()
    storage.setItem(
      'stream-sync.settings.v1',
      JSON.stringify({ smallStepSeconds: 0.25, sidebarVisible: false, profileId: 'cs2/iem' }),
    )
    const session = new Session({ engine, storage, createSampler: () => null })
    sessions.push(session)
    expect(session.settings.smallStepSeconds).toBe(0.25)
    expect(session.settings.sidebarVisible).toBe(false)
    expect(session.settings.profileId).toBe('cs2/iem')
  })

  it('replaces the snapshot object on change so React sees a new reference', async () => {
    const { session } = await harness()
    const before = session.snapshot
    session.swapRoles()
    const after = session.flush()
    expect(after).not.toBe(before)
    expect(after.mainRole).toBe('commentary')
  })

  it('coalesces notifications into one microtask', async () => {
    const { session } = await harness()
    const listener = vi.fn()
    session.subscribe(listener)
    session.swapRoles()
    session.swapRoles()
    session.notice('info', 'x')
    expect(listener).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops notifying after unsubscribe', async () => {
    const { session } = await harness()
    const listener = vi.fn()
    const off = session.subscribe(listener)
    off()
    session.swapRoles()
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('Session offset bookkeeping', () => {
  it('rewinds the official source for a positive offset', async () => {
    const { session, engine } = await harness()
    await session.applyOffset(4)
    // A positive offset means the official side is shown 4 s in the past.
    expect(timeOf(engine, 'official')).toBeCloseTo(96, 3)
    expect(timeOf(engine, 'commentary')).toBeCloseTo(100, 3)
    expect(session.snapshot.appliedRewind).toEqual({ official: 4, commentary: 0 })
    expect(session.snapshot.offsetSeconds).toBeCloseTo(4, 3)
  })

  it('rewinds the commentary source for a negative offset', async () => {
    const { session, engine } = await harness()
    await session.applyOffset(-3)
    expect(timeOf(engine, 'official')).toBeCloseTo(100, 3)
    expect(timeOf(engine, 'commentary')).toBeCloseTo(97, 3)
    expect(session.snapshot.appliedRewind).toEqual({ official: 0, commentary: 3 })
    expect(session.snapshot.offsetSeconds).toBeCloseTo(-3, 3)
  })

  it('moves incrementally rather than re-seeking from scratch', async () => {
    const { session, engine } = await harness()
    await session.applyOffset(4)
    await session.applyOffset(6)
    // 2 s further back from 96, not 6 s back from wherever it is now.
    expect(timeOf(engine, 'official')).toBeCloseTo(94, 3)
    expect(session.snapshot.appliedRewind.official).toBeCloseTo(6, 3)
  })

  it('crosses zero by unwinding one side before rewinding the other', async () => {
    const { session, engine } = await harness()
    await session.applyOffset(5)
    expect(session.snapshot.appliedRewind).toEqual({ official: 5, commentary: 0 })
    await session.applyOffset(-2)
    // Only one side is ever rewound: the official side must return to 100 first.
    expect(timeOf(engine, 'official')).toBeCloseTo(100, 3)
    expect(timeOf(engine, 'commentary')).toBeCloseTo(98, 3)
    expect(session.snapshot.appliedRewind).toEqual({ official: 0, commentary: 2 })
  })

  it('keeps 目标 and 实际 apart when the buffer cannot absorb the request', async () => {
    // 3 s in, so a 30 s rewind has nowhere to go.
    const { session, engine } = await harness({ official: 3, commentary: 3 })
    await session.applyOffset(30)
    expect(session.snapshot.requestedOffsetSeconds).toBe(30)
    expect(session.snapshot.offsetSeconds).toBeLessThan(30)
    expect(timeOf(engine, 'official')).toBeGreaterThanOrEqual(0)
    expect(session.snapshot.lastPlan?.limitReason).toBe('buffer-limit')
    // And it says so, rather than showing an alignment it did not reach.
    expect(session.snapshot.notices.some((notice) => notice.kind === 'warn')).toBe(true)
  })

  it('nudges from the requested offset, not the achieved one', async () => {
    const { session } = await harness({ official: 3, commentary: 3 })
    await session.applyOffset(30)
    const clamped = session.snapshot.offsetSeconds
    await session.nudgeOffset(0.5)
    // Nudging from 实际 would silently discard the part of the request that is waiting
    // for more buffer.
    expect(session.snapshot.requestedOffsetSeconds).toBeCloseTo(30.5, 3)
    expect(clamped).toBeLessThan(30)
  })

  it('resets both sides to zero rewind', async () => {
    const { session, engine } = await harness()
    await session.applyOffset(-4)
    await session.resetOffset()
    expect(session.snapshot.appliedRewind).toEqual({ official: 0, commentary: 0 })
    expect(session.snapshot.offsetSeconds).toBeCloseTo(0, 3)
    expect(timeOf(engine, 'commentary')).toBeCloseTo(100, 3)
  })

  it('clears the applied rewind for a source that is replaced', async () => {
    const { session, engine } = await harness()
    await session.applyOffset(5)
    expect(session.snapshot.appliedRewind.official).toBe(5)

    await session.loadSource('official', descriptor({ url: 'https://example.test/other.mp4' }))
    primeMediaElement(engine.element('official'), { duration: 600, currentTime: 40 })
    // The new source starts at its own position, so the old rewind applies to nothing.
    expect(session.snapshot.appliedRewind.official).toBe(0)
    expect(session.snapshot.requestedOffsetSeconds).toBe(0)
  })

  it('clears the applied rewind for a source that is unloaded', async () => {
    const { session } = await harness()
    await session.applyOffset(-5)
    session.unloadSource('commentary')
    expect(session.flush().appliedRewind).toEqual({ official: 0, commentary: 0 })
  })

  it('revokes the scheduler authorization on manual input', async () => {
    const { session } = await harness()
    session.setAutoSyncEnabled(true)
    expect(session.flush().autoSync.authorized).toBe(true)
    await session.applyOffset(2)
    // A human moved the slider; a scheduled run must not quietly overwrite that.
    expect(session.flush().autoSync.authorized).toBe(false)
  })

  it('does not revoke authorization for a run of its own', async () => {
    const { session } = await harness()
    session.setAutoSyncEnabled(true)
    await session.applyOffset(2, { fromAuto: true })
    expect(session.flush().autoSync.authorized).toBe(true)
  })
})

describe('Session audio', () => {
  it('treats a volume of zero as a mute and remembers it', async () => {
    const { session, engine } = await harness()
    session.setVolume('commentary', 0)
    expect(engine.element('commentary').muted).toBe(true)
    expect(session.settings.muted.commentary).toBe(true)
    // Storage has to agree, or a reload would bring the sound back.
    expect(session.settings.volume.commentary).toBe(0)
  })

  it('unmutes when the volume is raised', async () => {
    const { session, engine } = await harness()
    session.setVolume('official', 0)
    session.setVolume('official', 0.6)
    expect(engine.element('official').muted).toBe(false)
    expect(engine.element('official').volume).toBeCloseTo(0.6, 3)
  })

  it('pushes stored volumes into a newly loaded source', async () => {
    const engine = new MediaEngine()
    const storage = memoryStorage()
    storage.setItem(
      'stream-sync.settings.v1',
      JSON.stringify({ volume: { official: 0.25, commentary: 0.75 }, muted: { official: false } }),
    )
    const session = new Session({ engine, storage, createSampler: () => null })
    sessions.push(session)
    await session.loadSource('official', descriptor())
    expect(engine.element('official').volume).toBeCloseTo(0.25, 3)
  })
})

describe('Session playback', () => {
  it('reports paused when a source refuses to start', async () => {
    const { session, engine } = await harness()
    // An autoplay refusal leaves the element paused; claiming "playing" would leave the
    // button in a state the user cannot correct.
    vi.spyOn(engine.element('official'), 'play').mockRejectedValue(new Error('NotAllowedError'))
    await session.setPlaying(true)
    expect(session.snapshot.playing).toBe(false)
  })

  it('toggles from whatever it currently reports', async () => {
    const { session } = await harness()
    await session.setPlaying(true)
    expect(session.snapshot.playing).toBe(true)
    await session.togglePlaying()
    expect(session.snapshot.playing).toBe(false)
  })
})

describe('Session notices', () => {
  it('keeps the newest and drops the oldest', async () => {
    const { session } = await harness({ load: false })
    for (let index = 0; index < 10; index += 1) session.notice('info', `n${index}`)
    const { notices } = session.flush()
    expect(notices).toHaveLength(6)
    expect(notices[0]?.text).toBe('n9')
  })

  it('dismisses by id', async () => {
    const { session } = await harness({ load: false })
    session.notice('warn', 'keep')
    session.notice('warn', 'drop')
    const target = session.flush().notices[0]
    session.dismissNotice(target!.id)
    expect(session.flush().notices.map((notice) => notice.text)).toEqual(['keep'])
  })
})

describe('roleName', () => {
  it('names both roles for the notice strip', () => {
    expect(roleName('official')).toBe('官方画面')
    expect(roleName('commentary')).toBe('国内解说')
  })
})

describe('Session settings writes', () => {
  it('persists through storage', async () => {
    const { session, storage } = await harness({ load: false })
    session.updateSettings({ sidebarVisible: false })
    expect(JSON.parse(storage.entries.get('stream-sync.settings.v1')!)).toMatchObject({
      sidebarVisible: false,
    })
  })

  it('recompiles the danmaku filter only when the filter changes', async () => {
    const { session } = await harness({ load: false })
    session.updateDanmakuSettings({ filter: { ...DEFAULT_SETTINGS.danmaku.filter, blockedPatterns: ['('] } })
    // An unbalanced group is a user typo, reported once here rather than per message.
    expect(session.invalidPatterns).toHaveLength(1)
  })
})


it('updates the displayed danmaku room to the final main-process identity and ignores stale subscription events', async () => {
  const { apiClient } = await import('./apiClient')
  const listeners: Array<(event: { event: string; data: unknown }) => void> = []
  const subscribe = vi.spyOn(apiClient, 'subscribeDanmaku').mockImplementation((_room, listener) => { listeners.push(listener); return () => {} })
  const session = new Session({ createSampler: () => null }); sessions.push(session)
  session.connectDanmaku('6657')
  listeners[0]!({ event: 'state', data: { state: 'connecting', room: '6979222' } })
  expect(session.flush().danmaku.room).toBe('6979222')
  session.connectDanmaku('1234')
  listeners[0]!({ event: 'state', data: { state: 'connected', room: '6979222' } })
  expect(session.flush().danmaku.room).toBe('1234')
  listeners[1]!({ event: 'state', data: { state: 'connected', room: '5678' } })
  expect(session.flush().danmaku).toMatchObject({ room: '5678', connected: true })
  subscribe.mockRestore()
})
