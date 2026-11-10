import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import { BASIC_CLOCK_PROFILE } from '../core/activeProfile'
import type { BasicClockProgress } from '../recognition/protocol'
import type { SettingsStorage } from './settings'
import * as buildSearch from '../core/basicClockSearch'

const sessions: Session[] = []
beforeEach(() => vi.spyOn(buildSearch, 'getBasicClockSearchRoi').mockReturnValue(null))
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.restoreAllMocks() })
const roi = { x: .42, y: .04, w: .16, h: .13 }
function create(storage?: SettingsStorage): Session {
  const session = new Session({ storage, createSampler: () => null })
  sessions.push(session)
  return session
}
const progress: BasicClockProgress = { diagnostic: { status: 'searching', mode: 'manual' }, debug: null, frameIndex: 1, receivedAt: 1000 }

describe('manual basic clock regions', () => {
  it('preserves one shared proportional manual region across source changes, modes and restart', async () => {
    let value: string | null = null
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next } }
    const session = create(storage)
    session.setBasicClockRoi(roi)
    const active = session.profileFor('official')
    expect(active).toMatchObject({ kind: 'basic-clock', roi })
    expect(session.profileFor('official')).toBe(active)
    expect(session.profileFor('commentary')).toMatchObject({ roi, roiOrigin: 'manual' })
    await session.loadSource('official', { kind: 'progressive', url: 'https://example.test/replaced.mp4', label: '另一片源', input: 'test', viaProxy: false, loop: false })
    expect(session.profileFor('official')).toBe(active)
    session.setRecognitionMode('style-pack')
    session.setRecognitionMode('basic')
    expect(session.profileFor('official')).toMatchObject({ roi })
    expect(create(storage).profileFor('official')).toMatchObject({ roi })
    session.setBasicClockRoi(null)
    expect(session.profileFor('official')).toBe(BASIC_CLOCK_PROFILE)
    expect(create(storage).profileFor('official')).toBe(BASIC_CLOCK_PROFILE)
  })

  it('invalidates progress and active work on an explicit region change without accepting an invalid region', () => {
    const session = create()
    session.setBasicClockRoi(roi)
    session.receiveBasicProgress('official', progress)
    expect(session.flush().basicProgress.official).toBe(progress)
    const cancel = vi.spyOn(session.autoSync, 'cancel')
    session.setBasicClockRoi({ ...roi, w: -1 })
    expect(session.profileFor('official')).toMatchObject({ roi })
    expect(cancel).not.toHaveBeenCalled()
    session.setBasicClockRoi(null)
    expect(cancel).toHaveBeenCalledWith(false)
    expect(session.flush().basicProgress.official).toBeNull()
  })

  it('clears old-source previews while keeping the manual selection authoritative', async () => {
    const session = create()
    session.setBasicClockRoi(roi)
    session.receiveBasicProgress('official', progress)
    await session.loadSource('official', { kind: 'progressive', url: 'https://example.test/new.mp4', label: '新片源', input: 'test', viaProxy: false, loop: false })
    expect(session.flush().basicProgress.official).toBeNull()
    expect(session.profileFor('official')).toMatchObject({ roi })
    session.setRecognitionMode('style-pack')
    session.receiveBasicProgress('official', progress)
    expect(session.flush().basicProgress.official).toBeNull()
  })

  it('uses the immutable production search region while allowing a shared exact crop', () => {
    const search = { x: .25, y: 0, w: .5, h: .25 }
    const configured = vi.spyOn(buildSearch, 'getBasicClockSearchRoi').mockReturnValue(search)
    const session = create()
    expect(session.profileFor('official')).toMatchObject({ searchRoi: search })
    expect(session.profileFor('commentary')).toMatchObject({ searchRoi: search })
    session.setBasicClockRoi(roi)
    for (const role of ['official', 'commentary'] as const) expect(session.profileFor(role)).toMatchObject({ roi, searchRoi: search, roiOrigin: 'manual' })
    session.setBasicClockRoi(null)
    for (const role of ['official', 'commentary'] as const) {
      expect(session.profileFor(role)).toMatchObject({ searchRoi: search })
      expect(session.profileFor(role)).not.toHaveProperty('roi')
    }
    configured.mockReturnValue(null)
    expect(session.profileFor('official')).toMatchObject({ searchRoi: search })
    expect(create().profileFor('official')).toBe(BASIC_CLOCK_PROFILE)
    expect(session).not.toHaveProperty('setBasicClockSearchRoi')
  })

  it('does not accept a search region from old user preferences', () => {
    const session = create({ getItem: () => JSON.stringify({ basicClockSearchRoi: { x: .1, y: .2, w: .3, h: .1 } }), setItem: vi.fn() })
    expect(session.profileFor('official')).not.toHaveProperty('searchRoi')
    expect(session.settings).not.toHaveProperty('basicClockSearchRoi')
  })
})
