import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import type { PipState } from '../../electron/pipManager'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { ChatDrawer } from './ChatDrawer'
import { ComposerProvider } from './composer'
import { DanmakuActionsProvider } from './danmakuActions'
import { DanmakuPanel } from './DanmakuPanel'
import { DanmakuStage } from './DanmakuStage'
import { SettingsSheet } from './SettingsSheet'
import { SourceLoaderProvider } from './sources'
import PipPage from './pip/PipPage'
import { PipDanmaku } from './pip/PipDanmaku'
import { DEFAULT_DANMAKU_PREFERENCES } from '../core/danmakuProcessing'

const sessions: Session[] = []
let relay: ((event: { event: string; data: unknown }) => void) | null
let subscribedRooms: string[]

function makeSession(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  session.connectDanmaku('douyin:12345')
  relay?.({ event: 'state', data: { state: 'connected', room: 'douyin:12345' } })
  session.flush()
  return session
}
function mount(session: Session, children: React.ReactNode): void {
  render(<SessionProvider session={session}><SourceLoaderProvider><ComposerProvider>
    <DanmakuActionsProvider onOpenRecords={() => {}}>{children}</DanmakuActionsProvider>
  </ComposerProvider></SourceLoaderProvider></SessionProvider>)
}
beforeEach(() => {
  relay = null
  subscribedRooms = []
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'getDanmakuFeatures') return { ok: true, value: { affixes: { enabled: false, prefix: '', suffix: '' } } }
      if (method === 'listDouyuAccounts') return { ok: true, value: { activeAccountId: 'default', accounts: [{ id: 'default', label: '主号', busy: false, login: { loggedIn: true } }] } }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: (room, listener) => { subscribedRooms.push(room); relay = listener; return () => {} },
    subscribeFeatures: () => () => {},
  } satisfies StreamSyncerBridge)
})
afterEach(() => {
  cleanup()
  for (const session of sessions.splice(0)) session.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const DOUYU_OPERATIONS = ['sendComposedDouyuMessage', 'getDanmakuRate', 'previewDouyuMute', 'getDanmakuUserDetails', 'addDanmakuFavorite', 'activateDouyuRoom']

describe('Douyin read-only chat', () => {
  it('shows chat and copy/local blocking while hiding sending, replies, history and Douyu statistics', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320)
    const session = makeSession()
    session.pushDanmaku({ text: '抖音聊天', user: '观众甲', color: '#fff', platform: 'douyin', sender: { uid: '123' }, dms: 0 })
    session.drainDanmaku()
    const feature = vi.spyOn(apiClient, 'feature')
    mount(session, <ChatDrawer onClose={() => {}} onOpenSettings={() => {}} onOpenRecords={() => {}} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('抖音聊天')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /发送|\+1|房间数据|弹幕记录与收藏/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }))
    expect(screen.queryByRole('button', { name: /回复|收藏|禁言|历史弹幕|用户详情/ })).toBeNull()
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '屏蔽此用户' }))
    expect(session.settings.danmaku.filter.blockedUsers).toContain('观众甲')
    expect(feature.mock.calls.some(([method]) => DOUYU_OPERATIONS.includes(method))).toBe(false)
  })

  it('keeps appearance and local filters while hiding Douyu metadata and sending preferences', async () => {
    const session = makeSession()
    mount(session, <DanmakuPanel onClose={() => {}} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('switch', { name: /显示弹幕/ })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /显示礼物消息/ })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /机器人|用户详情|前缀与后缀/ })).toBeNull()
    expect(screen.queryByText('发送')).toBeNull()
  })

  it('keeps the overlay menu read-only and excludes gift events from scrolling text', async () => {
    let nextFrame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(450)
    const session = makeSession()
    mount(session, <DanmakuStage onReply={() => {}} />)
    await act(async () => { await Promise.resolve() })
    act(() => {
      session.updateDanmakuSettings({ enabled: true, showGifts: true })
      session.pushDanmaku({ text: '抖音浮层聊天', user: '观众甲', color: '#fff', platform: 'douyin' })
      session.pushDanmaku({ text: '平台礼物', user: '观众乙', color: '#fff', platform: 'huya', huyaGift: { id: '1', count: 1 } })
      nextFrame?.(100)
    })
    const text = screen.getByText('抖音浮层聊天')
    expect(screen.queryByText('平台礼物')).toBeNull()
    fireEvent.pointerOver(text)
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '屏蔽' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /\+1|回复|收藏|禁言|历史|详情/ })).toBeNull()
  })

  it.each(['douyu', 'records', 'insights'] as const)('isolates the %s backend panel with the correct platform name', async section => {
    const session = makeSession()
    const feature = vi.spyOn(apiClient, 'feature')
    render(<SessionProvider session={session}><SettingsSheet target={{ section }} room="douyin:12345"
      onClose={() => {}} onWatch={() => {}} onFill={() => {}} /></SessionProvider>)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(/当前抖音房间仅支持只读弹幕/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /赠送|签到|发送|创建任务/ })).toBeNull()
    expect(feature).not.toHaveBeenCalled()
  })
})

describe('Douyin picture-in-picture chat', () => {
  it.each([true, false])('uses only the source chat room while ignoring Douyu sending context, room available: %s', async withRoom => {
    const state: PipState = {
      phase: 'opening', streamId: 'commentary',
      source: { platform: 'douyin', kind: 'progressive', url: '/test-sources/commentary.mp4', label: '抖音', channel: '12345',
        sourceRoom: '7123456789012345678', ...(withRoom ? { danmakuRoom: 'douyin:12345' } : {}), requiresProxy: false },
      options: { lowPower: false, recoverStalls: true, width: 480, height: 270 }, audioOwner: 'main',
      recoveryRevision: 0, recoveryAttempts: 0, message: null,
      sendContext: { accountId: 'acc-1', room: '9999', canAttempt: true },
    }
    vi.spyOn(apiClient, 'feature').mockImplementation(async (method) => {
      if (method === 'getDanmakuFeatures') return { ok: false, code: 'fixture', message: 'fixture' }
      return { ok: true, value: state } as never
    })
    const { container } = render(<PipPage />)
    await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toBe('/test-sources/commentary.mp4'))
    if (withRoom) expect(subscribedRooms).toContain('douyin:12345')
    else expect(subscribedRooms).toEqual([])
    expect(subscribedRooms).not.toContain('9999')
    expect(subscribedRooms).not.toContain('7123456789012345678')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
  })

  it('normalizes Douyin messages so missing Douyu scoring does not hide them as bots', async () => {
    let nextFrame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(450)
    const video = document.createElement('video')
    render(<PipDanmaku video={video} room="douyin:12345" drawing resetKey={0} onProblem={() => {}}
      preferences={{ ...DEFAULT_DANMAKU_PREFERENCES, filterSuspectedBots: true }} />)
    act(() => {
      relay?.({ event: 'danmaku', data: { text: '抖音画中画聊天', username: '观众甲', platform: 'douyin' } })
      relay?.({ event: 'danmaku', data: { text: '礼物不进入浮层', username: '观众乙', platform: 'douyin', gift: { id: '1', count: 1 } } })
      nextFrame?.(100)
    })
    expect(screen.getByText('抖音画中画聊天')).toBeInTheDocument()
    expect(screen.queryByText('礼物不进入浮层')).toBeNull()
  })
})
