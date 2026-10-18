/** The editor is local; main still validates every published profile. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import { Session } from '../../app/session'
import { SessionProvider } from '../../app/SessionContext'
import AdminPage from './AdminPage'

const sessions: Session[] = []

afterEach(() => {
  cleanup()
  sessions.splice(0).forEach((session) => session.dispose())
  vi.unstubAllGlobals()
})

describe('AdminPage desktop entry', () => {
  it('opens directly and shows main-process write validation without a token gate', async () => {
    const invoke = vi.fn(async (method: string) => method === 'listPresets'
      ? { ok: true, value: { presets: [] } }
      : { ok: false, code: 'invalid-profile', message: '配置校验未通过', detail: { issues: [{ path: 'roi.w', message: '必须大于 0' }] } },
    ) as StreamSyncerBridge['invoke']
    vi.stubGlobal('streamSyncer', { invoke, subscribeDanmaku: () => () => {} } satisfies StreamSyncerBridge)
    const session = new Session({ createSampler: () => null })
    sessions.push(session)
    render(<SessionProvider session={session}><AdminPage /></SessionProvider>)
    expect(screen.getByRole('heading', { name: '配置编辑器' })).toBeInTheDocument()
    expect(screen.queryByLabelText('管理令牌')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '发布到本机' }))
    expect(await screen.findByRole('status')).toHaveTextContent('roi.w 必须大于 0')
    expect(invoke).toHaveBeenCalledWith('savePreset', expect.objectContaining({ token: '', etag: undefined }))
    expect(vi.mocked(invoke).mock.calls.some(([method]) => method === 'verifyAdmin')).toBe(false)
  })
})
