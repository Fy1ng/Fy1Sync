import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Session, type SessionSnapshot } from '../app/session'
import { SyncCapsule } from './sync'

let session: Session
let snapshot: SessionSnapshot
vi.mock('../app/SessionContext', () => ({ useSession: () => session, useSessionSnapshot: () => snapshot }))

beforeEach(() => {
  session = new Session({ createSampler: () => null })
  const initial = session.flush()
  snapshot = { ...initial, requestedOffsetSeconds: 9.43, offsetSeconds: 9.714,
    appliedRewind: { official: 9.736, commentary: 0.022 },
    media: { official: { ...initial.media.official, status: 'ready' }, commentary: { ...initial.media.commentary, status: 'ready' } },
    lastPlan: { requestedOffset: 9.43, effectiveOffset: 9.714, rewindAfter: { official: 9.736, commentary: 0.022 },
      seeks: [], limited: false, missingRoles: [] } }
})
afterEach(() => session.dispose())

describe('manual offset result feedback', () => {
  it.each([
    { dryRun: true, applied: false, authorized: true, aligned: false },
    { dryRun: true, applied: true, authorized: true, aligned: false },
    { dryRun: false, applied: false, authorized: true, aligned: false },
    { dryRun: false, applied: true, authorized: false, aligned: false },
    { dryRun: false, applied: true, authorized: true, aligned: true },
  ])('only labels an applied alignment as locked: %j', ({ dryRun, applied, authorized, aligned }) => {
    snapshot.requestedOffsetSeconds = snapshot.offsetSeconds
    snapshot.autoSync = { ...snapshot.autoSync, phase: 'done', authorized,
      lastResult: { phase: 'done', dryRun, applied, estimate: null, plan: null, failure: null, divergence: null,
        samples: { official: 0, commentary: 0 }, jumps: { official: 0, commentary: 0 }, startedAt: 0, finishedAt: 1 } }
    render(<SyncCapsule />)
    expect(screen.queryByText('已对齐') !== null).toBe(aligned)
    expect(screen.getByRole('group', { name: '对齐' })).toHaveAttribute('data-state', aligned ? 'locked' : 'idle')
  })

  it('reports the observed seek residual without calling an unlimited move a buffer shortage', () => {
    render(<SyncCapsule />)
    expect(screen.queryByText(/缓冲不足/)).toBeNull()
    expect(screen.getByText(/还差/)).toHaveTextContent('0.3 秒')
  })

  it('keeps the buffer warning when the executed move really hit its window boundary', () => {
    snapshot.lastPlan = { ...snapshot.lastPlan!, limited: true, limitReason: 'buffer-limit' }
    render(<SyncCapsule />)
    expect(screen.getByText(/缓冲不足/)).toHaveTextContent('0.3 秒')
  })

  it('distinguishes an unavailable source from a buffer shortage', () => {
    snapshot.lastPlan = { ...snapshot.lastPlan!, limited: true, limitReason: 'not-ready', missingRoles: ['official'] }
    snapshot.media.official.status = 'loading'
    render(<SyncCapsule />)
    expect(screen.queryByText(/缓冲不足/)).toBeNull()
    expect(screen.getByText('片源未就绪，未完全调整')).toBeInTheDocument()
  })
})
