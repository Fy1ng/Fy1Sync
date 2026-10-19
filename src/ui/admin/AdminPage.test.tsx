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

describe('publish conflicts', () => {
  it('offers reload and an overwrite that only beats the reported version', async () => {
    const calls: Array<{ method: string; args: unknown }> = []
    let attempt = 0
    const invoke = vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      if (method === 'listPresets') return { ok: true, value: { presets: [] } }
      if (method === 'savePreset') {
        attempt += 1
        return attempt === 1
          ? { ok: false, code: 'conflict', message: '预设已被其他会话修改', detail: { currentEtag: 'etag-theirs' } }
          : { ok: true, value: { id: 'x', etag: 'etag-mine', updatedAt: 1 } }
      }
      return { ok: false, code: 'not-found', message: '未知' }
    }) as StreamSyncerBridge['invoke']
    vi.stubGlobal('streamSyncer', { invoke, subscribeDanmaku: () => () => {} } satisfies StreamSyncerBridge)
    const session = new Session({ createSampler: () => null })
    sessions.push(session)
    render(<SessionProvider session={session}><AdminPage /></SessionProvider>)

    fireEvent.click(screen.getByRole('button', { name: '发布到本机' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('已在别处被修改')
    expect(screen.getByRole('button', { name: '载入对方版本（放弃本次修改）' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '用我的版本覆盖' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已发布为本机预设')
    const saves = calls.filter((call) => call.method === 'savePreset')
    expect(saves).toHaveLength(2)
    expect(saves[1]!.args).toEqual(expect.objectContaining({ etag: 'etag-theirs' }))
  })
})
