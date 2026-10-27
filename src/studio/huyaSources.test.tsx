import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { Intake } from './Intake'
import { SourceChip } from './SourceChip'
import { SourceLoaderProvider, useSourceLoader } from './sources'
import { ChatDrawer } from './ChatDrawer'
import { ComposerProvider } from './composer'
import { DanmakuActionsProvider } from './danmakuActions'
import { DanmakuPanel } from './DanmakuPanel'
import { DanmakuStage } from './DanmakuStage'
import { SettingsSheet } from './SettingsSheet'
import type { MediaDescriptor } from '../core/types'

const sessions: Session[] = []
let relay: ((event: { event: string; data: unknown }) => void) | null = null

function makeSession(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  return session
}

function mount(session: Session, children: React.ReactNode): void {
  render(<SessionProvider session={session}><SourceLoaderProvider>{children}</SourceLoaderProvider></SessionProvider>)
}

beforeEach(() => {
  relay = null
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'getToolsStatus') return { ok: true, value: { tools: [], fixturesAvailable: false } }
      if (method === 'getDanmakuFeatures') return { ok: true, value: { affixes: { enabled: false, prefix: '', suffix: '' } } }
      if (method === 'listDouyuAccounts') return { ok: true, value: { activeAccountId: 'default', accounts: [{ id: 'default', label: '主号', busy: false, login: { loggedIn: true } }] } }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: (_room, listener) => { relay = listener; return () => {} },
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Huya sources', () => {
  it.each(['660000', 'kpl'])('connects the canonical Huya chat room after resolving a source: %s', async (room) => {
    const session = makeSession()
    session.connectDanmaku('9999')
    const connect = vi.spyOn(session, 'connectDanmaku')
    const disconnect = vi.spyOn(session, 'disconnectDanmaku')
    const load = vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: true, stream: {
      platform: 'huya', kind: 'hls', url: 'app://app/media/huya-session', label: '虎牙 660000',
      channel: '660000', sourceRoom: '660000', requiresProxy: false,
    } } })
    mount(session, <Intake onClose={() => {}} pendingFile={null} />)
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
    expect(connect).toHaveBeenCalledWith('huya:660000')
    expect(disconnect).toHaveBeenCalledOnce()
    expect(session.snapshot.danmaku.room).toBe('huya:660000')
  })

  it('keeps a loaded Huya room selected and shows chat state without a manual Douyu room editor', async () => {
    const session = makeSession()
    await act(async () => { await session.loadSource('commentary', {
      kind: 'test', url: '/test-sources/commentary.mp4', input: '660000', label: '虎牙 660000',
      loop: false, viaProxy: false, platform: 'huya', sourceRoom: '660000',
    }) })
    session.connectDanmaku('huya:660000')
    relay?.({ event: 'state', data: { state: 'connected', room: 'huya:660000' } })
    session.flush()
    mount(session, <SourceChip role="commentary" onEmpty={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /解说.*虎牙 660000/ }))
    expect(screen.getByRole('radio', { name: '虎牙' })).toBeChecked()
    expect(screen.getByText(/虎牙弹幕: 已连接房间/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '连接' })).toBeNull()
    expect(screen.queryByLabelText('弹幕房间号')).toBeNull()
  })

  it.each(['660000', undefined])('connects a restored Huya descriptor, with or without a canonical source room: %s', async (sourceRoom) => {
    const session = makeSession()
    const connect = vi.spyOn(session, 'connectDanmaku')
    vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
    const descriptor: MediaDescriptor = { kind: 'hls', url: 'app://app/media/restored', input: 'https://www.huya.com/kpl',
      label: '虎牙 kpl', platform: 'huya', loop: false, viaProxy: false, ...(sourceRoom ? { sourceRoom } : {}) }
    function Restore(): React.ReactNode {
      const loader = useSourceLoader()
      return <button onClick={() => void loader.loadDescriptor('commentary', descriptor)}>restore</button>
    }
    mount(session, <Restore />)
    fireEvent.click(screen.getByRole('button', { name: 'restore' }))
    await waitFor(() => expect(connect).toHaveBeenCalledWith(`huya:${sourceRoom ?? 'kpl'}`))
  })

  it('keeps Huya chat read-only in the drawer and its row menu while retaining copy and local blocking', async () => {
    const session = makeSession()
    session.connectDanmaku('huya:660000')
    relay?.({ event: 'state', data: { state: 'connected', room: 'huya:660000' } })
    session.pushDanmaku({ text: '虎牙聊天', user: '匿名观众', color: '#fff', platform: 'huya' })
    session.drainDanmaku()
    const feature = vi.spyOn(apiClient, 'feature')
    mount(session, <ComposerProvider><DanmakuActionsProvider onOpenRecords={() => {}}>
      <ChatDrawer onClose={() => {}} onOpenSettings={() => {}} onOpenRecords={() => {}} />
    </DanmakuActionsProvider></ComposerProvider>)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('虎牙聊天')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    expect(screen.queryByRole('button', { name: /\+1/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '房间数据' })).toBeNull()
    expect(screen.queryByRole('button', { name: '弹幕记录与收藏' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }))
    expect(screen.queryByRole('button', { name: /回复|收藏|禁言|历史弹幕|用户详情/ })).toBeNull()
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '屏蔽此用户' }))
    expect(session.settings.danmaku.filter.blockedUsers).toContain('匿名观众')
    expect(feature.mock.calls.some(([method]) => ['sendComposedDouyuMessage', 'getDanmakuRate', 'previewDouyuMute', 'getDanmakuUserDetails', 'addDanmakuFavorite'].includes(method))).toBe(false)
  })

  it('keeps appearance and gift visibility settings while hiding Douyu-only preferences', async () => {
    const session = makeSession()
    session.connectDanmaku('huya:660000')
    mount(session, <ComposerProvider><DanmakuPanel onClose={() => {}} /></ComposerProvider>)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('switch', { name: /显示礼物消息/ })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /显示弹幕/ })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /机器人|用户详情|前缀与后缀/ })).toBeNull()
    expect(screen.queryByText('发送')).toBeNull()
  })

  it('shows only copy and local blocking in the Huya overlay menu and keeps gifts out of the overlay', async () => {
    let nextFrame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(450)
    const session = makeSession()
    session.connectDanmaku('huya:660000')
    session.flush()
    const feature = vi.spyOn(apiClient, 'feature')
    mount(session, <ComposerProvider><DanmakuActionsProvider onOpenRecords={() => {}}>
      <DanmakuStage onReply={() => {}} />
    </DanmakuActionsProvider></ComposerProvider>)
    await act(async () => { await Promise.resolve() })
    act(() => {
      session.updateDanmakuSettings({ enabled: true, showGifts: true })
      session.pushDanmaku({ text: '虎牙浮层聊天', user: '匿名观众', color: '#fff', platform: 'huya' })
      session.pushDanmaku({ text: '虎牙礼物', user: '送礼观众', color: '#fff', platform: 'huya', huyaGift: { id: '1', count: 1 } })
      nextFrame?.(100)
    })
    const text = screen.getByText('虎牙浮层聊天')
    expect(screen.queryByText('虎牙礼物')).toBeNull()
    fireEvent.pointerOver(text)
    expect(screen.getByRole('toolbar')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '屏蔽' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /\+1|回复|收藏|禁言|历史|详情/ })).toBeNull()
    expect(feature.mock.calls.some(([method]) => ['sendComposedDouyuMessage', 'previewDouyuMute', 'getDanmakuUserDetails', 'addDanmakuFavorite'].includes(method))).toBe(false)
  })

  it.each(['douyu', 'records', 'insights'] as const)('does not mount the %s backend panel for a Huya room', async (section) => {
    const session = makeSession()
    const feature = vi.spyOn(apiClient, 'feature')
    mount(session, <SettingsSheet target={{ section }} room="huya:660000" onClose={() => {}} onWatch={() => {}} onFill={() => {}} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(/当前虎牙房间仅支持只读弹幕/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /赠送|签到|发送|创建任务/ })).toBeNull()
    expect(feature).not.toHaveBeenCalled()
  })
})
