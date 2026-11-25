import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
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
    { offset: 2.5, caption: '画面延后', seconds: '2.5' },
    { offset: -2.5, caption: '解说延后', seconds: '2.5' },
    { offset: 0, caption: '未调整', seconds: '0.0' },
  ])('shows $caption in the visible and accessible readout for $offset', ({ offset, caption, seconds }) => {
    snapshot.requestedOffsetSeconds = snapshot.offsetSeconds = offset
    render(<SyncCapsule />)

    const readout = within(screen.getByRole('button', { name: `${caption} ${seconds} 秒，点击输入` }))
    expect(readout.getByText(caption)).toBeVisible()
    expect(readout.getByText(seconds)).toBeVisible()
  })

  it.each([
    { label: '画面延后', offset: 2.5 },
    { label: '解说延后', offset: -2.5 },
  ])('applies $offset when entering an offset with $label selected', ({ label, offset }) => {
    snapshot.requestedOffsetSeconds = snapshot.offsetSeconds = 0
    const apply = vi.spyOn(session, 'applyOffset').mockResolvedValue(snapshot.lastPlan!)
    render(<SyncCapsule />)

    fireEvent.click(screen.getByRole('button', { name: '未调整 0.0 秒，点击输入' }))
    const dialog = within(screen.getByRole('dialog', { name: '输入画面偏移' }))
    expect(dialog.getByText('哪边快了就延后哪边')).toBeVisible()
    const direction = within(dialog.getByRole('radiogroup', { name: '画面偏移方向' }))
    fireEvent.click(direction.getByRole('radio', { name: label }))
    fireEvent.change(dialog.getByRole('textbox', { name: '秒数' }), { target: { value: '2' } })
    fireEvent.click(dialog.getByRole('button', { name: '+0.5s' }))
    fireEvent.click(dialog.getByRole('button', { name: '应用' }))

    expect(apply).toHaveBeenCalledExactlyOnceWith(offset)
  })

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
