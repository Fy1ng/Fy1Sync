import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Session, type SessionSnapshot } from '../app/session'
import type { AutoSyncRunResult } from '../sync/autoSync'
import { PlaybackRecoveryPrompt } from './sync'

let session: Session
let snapshot: SessionSnapshot
vi.mock('../app/SessionContext', () => ({ useSession: () => session, useSessionSnapshot: () => snapshot }))

beforeEach(() => {
  vi.useFakeTimers()
  session = new Session({ createSampler: () => null })
  const initial = session.flush()
  snapshot = { ...initial, autoSync: { ...initial.autoSync, ready: true }, media: {
    official: { ...initial.media.official, status: 'ready' },
    commentary: { ...initial.media.commentary, status: 'ready' },
  } }
  vi.spyOn(session, 'snapshot', 'get').mockImplementation(() => snapshot)
})
afterEach(() => { session.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('playback recovery controls', () => {
  it.each(['stall', 'reconnect'] as const)('shows %s evidence and uses explicit immediate sync', kind => {
    snapshot.playbackRecovery = { kind, driftSeconds: kind === 'stall' ? 2 : null }
    const sync = vi.spyOn(session, 'syncNow').mockResolvedValue({} as AutoSyncRunResult)
    render(<PlaybackRecoveryPrompt />)
    expect(screen.getByRole('status')).toHaveTextContent(kind === 'stall'
      ? '画面刚卡顿，两路可能错开了约 2.0 秒' : '重新连接后，两路可能错开了')
    fireEvent.click(screen.getByRole('button', { name: '重新对齐' }))
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('does not render without a recovery prompt', () => {
    const view = render(<PlaybackRecoveryPrompt />)
    expect(view.container).toBeEmptyDOMElement()
  })

  it('waits for synchronization readiness before offering recovery', () => {
    snapshot.playbackRecovery = { kind: 'stall', driftSeconds: 2 }
    snapshot.autoSync.ready = false
    render(<PlaybackRecoveryPrompt />)
    expect(screen.getByRole('button', { name: '重新对齐' })).toBeDisabled()
  })

  it('disables recovery while alignment is running', () => {
    snapshot.playbackRecovery = { kind: 'stall', driftSeconds: 2 }
    vi.spyOn(session.autoSync, 'isRunning', 'get').mockReturnValue(true)
    render(<PlaybackRecoveryPrompt />)
    expect(screen.getByRole('button', { name: '重新对齐' })).toBeDisabled()
  })
})
