import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Session, type SessionSnapshot } from '../app/session'
import type { AutoSyncRunResult } from '../sync/autoSync'
import { PlaybackRecoveryPrompt } from './sync'
import { PlaybackDiagnosticsPanel } from './SourceChip'

let session: Session
let snapshot: SessionSnapshot
vi.mock('../app/SessionContext', () => ({ useSession: () => session, useSessionSnapshot: () => snapshot }))

beforeEach(() => {
  vi.useFakeTimers()
  session = new Session({ createSampler: () => null })
  const initial = session.flush()
  snapshot = { ...initial, media: {
    official: { ...initial.media.official, status: 'ready' },
    commentary: { ...initial.media.commentary, status: 'ready' },
  } }
})
afterEach(() => { session.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('playback recovery controls', () => {
  it.each(['stall', 'reconnect'] as const)('shows %s evidence and uses explicit immediate sync', kind => {
    snapshot.playbackRecovery = { kind, driftSeconds: kind === 'stall' ? 2 : null }
    const sync = vi.spyOn(session, 'syncNow').mockResolvedValue({} as AutoSyncRunResult)
    render(<PlaybackRecoveryPrompt />)
    expect(screen.getByRole('status')).toHaveTextContent(kind === 'stall'
      ? '画面刚卡顿, 两路可能错开了约 2.0 秒' : '重新连接后, 两路可能错开了')
    fireEvent.click(screen.getByRole('button', { name: '重新对齐' }))
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('does not render without a recovery prompt', () => {
    const view = render(<PlaybackRecoveryPrompt />)
    expect(view.container).toBeEmptyDOMElement()
  })

  it('disables recovery while alignment is running', () => {
    snapshot.playbackRecovery = { kind: 'stall', driftSeconds: 2 }
    vi.spyOn(session.autoSync, 'isRunning', 'get').mockReturnValue(true)
    render(<PlaybackRecoveryPrompt />)
    expect(screen.getByRole('button', { name: '重新对齐' })).toBeDisabled()
  })
})

describe('source playback diagnostics', () => {
  it('shows the selected source stall duration and hint', () => {
    snapshot.playbackDiagnostics.official = { durationMs: 2500, category: 'fetch',
      hint: '本地有数据但播放器没拉到', ongoing: false }
    render(<PlaybackDiagnosticsPanel role="official" />)
    expect(screen.getByText(/最近卡顿 2.5 秒/)).toHaveTextContent('本地有数据但播放器没拉到')
  })

  it('downloads both sources in one local JSON Blob', async () => {
    vi.stubGlobal('Blob', NodeBlob)
    const create = vi.fn((_blob: Blob) => 'blob:diagnostics')
    const revoke = vi.fn()
    vi.stubGlobal('URL', class extends URL { static override createObjectURL = create; static override revokeObjectURL = revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const exported = vi.spyOn(session, 'exportPlaybackDiagnostics')
    render(<PlaybackDiagnosticsPanel role="commentary" />)
    fireEvent.click(screen.getByRole('button', { name: '导出播放诊断' }))
    expect(exported).toHaveBeenCalledTimes(1)
    const blob = create.mock.calls[0]![0] as unknown as Blob
    expect(blob.type).toBe('application/json')
    expect(JSON.parse(await blob.text())).toMatchObject({ version: 1,
      official: { samples: [], lastStall: null }, commentary: { samples: [], lastStall: null } })
    expect(click.mock.instances[0]).toHaveProperty('download', 'Fy1Sync-playback-diagnostics.json')
    expect(revoke).toHaveBeenCalledWith('blob:diagnostics')
  })
})
