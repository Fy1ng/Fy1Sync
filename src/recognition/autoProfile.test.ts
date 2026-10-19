import { describe, expect, it, vi } from 'vitest'
import { createEmptyProfile } from '../core/profileSchema'
import type { RecognitionOutcome, SourceRole } from '../core/types'
import type { GrabbedFrame } from './frameGrabber'
import { AutoProfileController, CLOCK_LOST_MS } from './autoProfile'
import type { LearnResult, LocateResult } from './protocol'

const profile = createEmptyProfile('saved/example', '原预设')
const candidate = { roi: profile.roi, score: 0.96, eventTimes: [1, 2, 3], period: 1, jitter: 0, persistence: 1, glyphScore: 1 }
const located: LocateResult = { status: 'success', backend: 'wasm', candidates: [candidate], windowId: 1 }
const learned: LearnResult = { status: 'success', backend: 'wasm', profile, report: {
  profile, confidence: 0.95, learnedChars: ['0', '1', ':'], missingChars: ['2'],
  reason: null, observations: 12, consistentOffsets: 1,
} }
const failed: RecognitionOutcome = { status: 'failed', reason: 'no-candidates' }

function frame(time: number): GrabbedFrame {
  return { pixels: new Uint8ClampedArray([255, 255, 255, 255]), width: 1, height: 1, mediaTime: time, wallTime: time * 1000 }
}
function harness() {
  let now = 0
  const clients = {
    official: { locate: vi.fn(async (): Promise<LocateResult> => located), learn: vi.fn(async (): Promise<LearnResult> => learned), cancel: vi.fn(), dispose: vi.fn() },
    commentary: { locate: vi.fn(async (): Promise<LocateResult> => located), learn: vi.fn(async (): Promise<LearnResult> => learned), cancel: vi.fn(), dispose: vi.fn() },
  }
  const capture = vi.fn(async (_role: SourceRole, _signal: { aborted: boolean }) => Array.from({ length: 30 }, (_, i) => frame(i / 8)))
  const use = vi.fn()
  const controller = new AutoProfileController({ client: role => clients[role], capture, use, now: () => now })
  return { controller, clients, capture, use, time: (value: number) => { now = value } }
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('source-local automatic profiles', () => {
  it('waits for explicit acceptance and keeps two independent candidates without modifying a saved profile', async () => {
    const h = harness()
    const before = structuredClone(profile)
    const official = h.controller.acquire('official')
    const commentary = h.controller.acquire('commentary')
    await settle()
    expect(h.controller.state('official').phase).toBe('ready')
    expect(h.use).not.toHaveBeenCalled()
    h.controller.accept('official')
    expect(await official).toBe(true)
    expect(h.controller.state('commentary').accepted).toBe(false)
    h.controller.accept('commentary')
    expect(await commentary).toBe(true)
    expect(h.use.mock.calls.map(call => [call[0], call[1].id])).toEqual([
      ['official', 'session/official'], ['commentary', 'session/commentary'],
    ])
    expect(profile).toEqual(before)
  })

  it('reuses the worker-owned window without copying or retransferring pixels', async () => {
    const h = harness()
    const run = h.controller.acquire('official')
    await settle()
    expect(h.clients.official.locate).toHaveBeenCalledWith(expect.any(Array), { retainForLearning: true })
    expect(h.clients.official.learn).toHaveBeenCalledWith([], candidate.roi, { windowId: 1 })
    h.controller.cancel('official')
    expect(await run).toBe(false)
  })

  it('cancels during capture and ignores a late window', async () => {
    const h = harness()
    let finish!: (frames: GrabbedFrame[]) => void
    h.capture.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const run = h.controller.acquire('official')
    h.controller.cancel('official')
    expect(await run).toBe(false)
    finish(Array.from({ length: 30 }, (_, i) => frame(i)))
    await settle()
    expect(h.clients.official.locate).not.toHaveBeenCalled()
    expect(h.controller.state('official').phase).toBe('cancelled')
    expect(h.use).not.toHaveBeenCalled()
  })

  it('ignores an obsolete result after reset and a fresh acquisition', async () => {
    const h = harness()
    let finish!: (value: LocateResult) => void
    h.clients.official.locate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = h.controller.acquire('official')
    await settle()
    h.controller.reset('official')
    expect(await old).toBe(false)
    const fresh = h.controller.acquire('official')
    await settle()
    finish({ status: 'failed', reason: 'old failure' })
    await settle()
    expect(h.controller.state('official').phase).toBe('ready')
    h.controller.accept('official')
    expect(await fresh).toBe(true)
  })

  it('exposes TypeScript unsupported and leaves the manual flow available', async () => {
    const h = harness()
    h.clients.official.locate.mockResolvedValue({ status: 'unsupported', backend: 'typescript', reason: '自动定位不可用, 请使用手动预设' })
    expect(await h.controller.acquire('official')).toBe(false)
    expect(h.controller.state('official')).toMatchObject({ phase: 'unsupported', accepted: false })
    expect(h.clients.official.learn).not.toHaveBeenCalled()
    expect(h.use).not.toHaveBeenCalled()
  })

  it('reports an unsupported learn instead of accepting a profile', async () => {
    const h = harness()
    h.clients.official.learn.mockResolvedValue({ status: 'unsupported', backend: 'typescript', reason: '不支持自动学习' })
    expect(await h.controller.acquire('official')).toBe(false)
    expect(h.controller.state('official').phase).toBe('unsupported')
    expect(h.use).not.toHaveBeenCalled()
  })

  it.each([{ candidates: [] }, { candidates: [candidate, { ...candidate, score: 0.94 }] }])('rejects missing or ambiguous clocks', async ({ candidates }) => {
    const h = harness()
    h.clients.official.locate.mockResolvedValue({ status: 'success', backend: 'wasm', candidates })
    expect(await h.controller.acquire('official')).toBe(false)
    expect(h.controller.state('official').phase).toBe('not-found')
    expect(h.clients.official.learn).not.toHaveBeenCalled()
  })

  it('reports a learning refusal', async () => {
    const h = harness()
    h.clients.official.learn.mockResolvedValue({ ...learned, profile: null, report: { ...learned.report, reason: 'ambiguous-labels' } })
    expect(await h.controller.acquire('official')).toBe(false)
    expect(h.controller.state('official')).toMatchObject({ phase: 'not-found', reason: '字形标签存在歧义, 请重新识别或手动编辑' })
  })

  it('re-acquires accepted candidates after continuous loss and reuses session consent', async () => {
    const h = harness()
    const run = h.controller.acquire('official')
    await settle(); h.controller.accept('official'); await run
    h.controller.observe('official', failed)
    h.time(CLOCK_LOST_MS - 1); h.controller.observe('official', failed)
    expect(h.capture).toHaveBeenCalledTimes(1)
    h.time(CLOCK_LOST_MS); h.controller.observe('official', failed)
    await settle()
    expect(h.capture).toHaveBeenCalledTimes(2)
    expect(h.use).toHaveBeenCalledTimes(2)
    expect(h.controller.state('official')).toMatchObject({ phase: 'ready', accepted: true })
    expect(h.clients.commentary.locate).not.toHaveBeenCalled()
  })

  it('requires fresh consent after a source replacement and suppresses cancelled retries', async () => {
    const h = harness()
    const run = h.controller.acquire('official')
    await settle(); h.controller.accept('official'); await run
    h.controller.reset('official')
    expect(h.controller.state('official').accepted).toBe(false)
    h.controller.cancel('official')
    h.controller.observe('official', failed)
    h.time(100_000); h.controller.observe('official', failed)
    await settle()
    expect(h.capture).toHaveBeenCalledTimes(1)
  })

  it('does not let low-confidence readings hide a continuously lost clock', async () => {
    const h = harness()
    const run = h.controller.acquire('official')
    await settle(); h.controller.accept('official'); await run
    const low: RecognitionOutcome = { status: 'success', reading: {
      text: '0:20', seconds: 20, scores: [0.7], confidence: 0.7, mediaTime: 1, wallTime: 1000, frameIndex: 1,
    } }
    h.controller.observe('official', low)
    h.time(CLOCK_LOST_MS); h.controller.observe('official', low)
    await settle()
    expect(h.capture).toHaveBeenCalledTimes(2)
    expect(h.use).toHaveBeenCalledTimes(2)
  })

  it('resolves all pending consent on disposal', async () => {
    const h = harness()
    const a = h.controller.acquire('official')
    const b = h.controller.acquire('commentary')
    await settle()
    h.controller.dispose()
    expect(await a).toBe(false)
    expect(await b).toBe(false)
    expect(await h.controller.acquire('official')).toBe(false)
  })
})
