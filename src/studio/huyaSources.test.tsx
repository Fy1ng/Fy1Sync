import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { Intake } from './Intake'
import { SourceChip } from './SourceChip'
import { SourceLoaderProvider } from './sources'

const sessions: Session[] = []

function makeSession(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  return session
}

function mount(session: Session, children: React.ReactNode): void {
  render(<SessionProvider session={session}><SourceLoaderProvider>{children}</SourceLoaderProvider></SessionProvider>)
}

beforeEach(() => {
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'getToolsStatus') return { ok: true, value: { tools: [], fixturesAvailable: false } }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Huya sources', () => {
  it.each(['660000', 'kpl'])('resolves a selected Huya room without connecting Douyu chat: %s', async (room) => {
    const session = makeSession()
    session.connectDanmaku('9999')
    const connect = vi.spyOn(session, 'connectDanmaku')
    const disconnect = vi.spyOn(session, 'disconnectDanmaku')
    const load = vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: true, stream: {
      platform: 'huya', kind: 'hls', url: 'app://app/media/huya-session', label: '虎牙 660000',
      channel: '660000', sourceRoom: '660000', requiresProxy: false,
    } } })
    mount(session, <Intake onClose={() => {}} onSchedule={() => {}} pendingFile={null} />)
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: room } })
    fireEvent.submit(field.closest('form')!)
    fireEvent.click(screen.getByRole('button', { name: '虎牙' }))
    await waitFor(() => expect(load).toHaveBeenCalledWith('commentary', expect.objectContaining({
      platform: 'huya', input: room, sourceRoom: '660000',
    })))
    expect(resolve).toHaveBeenCalledWith(
      'https://www.huya.com/' + room, 'huya', 'commentary', undefined, true,
    )
    expect(connect).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(session.snapshot.danmaku.room).toBeNull()
  })

  it('keeps a loaded Huya room selected and replaces chat controls with an unsupported notice', async () => {
    const session = makeSession()
    await act(async () => { await session.loadSource('commentary', {
      kind: 'test', url: '/test-sources/commentary.mp4', input: '660000', label: '虎牙 660000',
      loop: false, viaProxy: false, platform: 'huya', sourceRoom: '660000',
    }) })
    mount(session, <SourceChip role="commentary" onEmpty={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /解说.*虎牙 660000/ }))
    expect(screen.getByRole('radio', { name: '虎牙' })).toBeChecked()
    expect(screen.getByText('虎牙弹幕暂未支持')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '连接' })).toBeNull()
    expect(screen.queryByLabelText('弹幕房间号')).toBeNull()
  })
})
