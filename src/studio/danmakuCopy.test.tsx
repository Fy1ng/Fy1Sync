import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { ChatDrawer } from './ChatDrawer'
import { ComposerProvider } from './composer'
import { DanmakuActionsProvider, useDanmakuActions } from './danmakuActions'
import { DanmakuStage } from './DanmakuStage'
import { SourceLoaderProvider } from './sources'

const sessions: Session[] = []
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
let nextFrame: FrameRequestCallback | null
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>

beforeEach(() => {
  nextFrame = null
  writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(450)
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => ({ ok: true, value: method === 'listDouyuAccounts'
      ? { activeAccountId: null, accounts: [] }
      : method === 'getDouyuTasks' ? { activeAccountId: null, tasks: [] }
        : method === 'getDanmakuFeatures' ? { affixes: { enabled: false, prefix: '', suffix: '' }, preferences: {} } : {} })),
    subscribeDanmaku: () => () => {},
  } as unknown as StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length) sessions.pop()?.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

function createSession(room = 'huya:660000') {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  session.connectDanmaku(room)
  session.flush()
  return session
}

function Wrapper({ session, children }: { session: Session; children: React.ReactNode }) {
  return <SessionProvider session={session}><SourceLoaderProvider><ComposerProvider>
    <DanmakuActionsProvider onOpenRecords={() => {}}>{children}</DanmakuActionsProvider>
  </ComposerProvider></SourceLoaderProvider></SessionProvider>
}

type Mode = 'list' | 'overlay'
async function mountMenu(mode: Mode, platform: 'huya' | 'douyu' = 'huya') {
  const session = createSession(platform === 'douyu' ? '9999' : 'huya:660000')
  const notice = vi.spyOn(session, 'notice')
  const view = render(<Wrapper session={session}>{mode === 'list'
    ? <ChatDrawer onClose={() => {}} onOpenSettings={() => {}} onOpenRecords={() => {}} />
    : <DanmakuStage onReply={() => {}} />}</Wrapper>)
  await act(async () => { await Promise.resolve() })
  act(() => {
    session.pushDanmaku({ text: '复制合成文本甲', user: '合成观众', color: '#fff', platform })
    session.pushDanmaku({ text: '复制合成文本乙', user: '合成观众', color: '#fff', platform })
    if (mode === 'overlay') nextFrame?.(100)
    else session.drainDanmaku()
    session.flush()
  })
  const open = (text = '复制合成文本甲') => {
    if (mode === 'list') fireEvent.click(screen.getByRole('button', { name: `更多操作：${text}` }))
    else fireEvent.pointerOver(screen.getByText(text))
  }
  open()
  return { session, notice, view, open }
}

describe.each<Mode>(['list', 'overlay'])('copy feedback from the %s menu', mode => {
  it('does not attach an earlier favorite result to a different danmaku menu', async () => {
    const { open } = await mountMenu(mode, 'douyu')
    const invoke = vi.mocked(window.streamSyncer!.invoke)
    const original = invoke.getMockImplementation()!
    let finish!: (result: unknown) => void
    invoke.mockImplementation((async (method: string, args: unknown) => method === 'addDanmakuFavorite'
      ? new Promise<unknown>(resolve => { finish = resolve }) : original(method as never, args as never)) as StreamSyncerBridge['invoke'])
    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    open('复制合成文本乙')
    await act(async () => { finish({ ok: false, code: 'OLD_FAVORITE', message: '旧收藏失败', detail: { requestId: 'old-menu' } }); await Promise.resolve() })
    const menu = mode === 'overlay' ? screen.getByRole('toolbar') : screen.getByRole('dialog', { name: /弹幕操作/ })
    expect(within(menu).queryByText('旧收藏失败')).toBeNull()
    expect(within(menu).queryByRole('button', { name: '查看原始错误' })).toBeNull()
  })

  it('keeps a favorite failure attached to the menu result and leaves the success plain', async () => {
    const { notice } = await mountMenu(mode, 'douyu')
    const invoke = vi.mocked(window.streamSyncer!.invoke)
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((async (method: string, args: unknown) => method === 'addDanmakuFavorite'
      ? { ok: false, code: 'FAVORITE_STORE', message: '本地收藏失败', detail: { code: 'EACCES', token: 'private-token' } }
      : original(method as never, args as never)) as StreamSyncerBridge['invoke'])
    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    const menu = mode === 'overlay' ? screen.getByRole('toolbar') : screen.getByRole('dialog', { name: /弹幕操作/ })
    fireEvent.click(await within(menu).findByRole('button', { name: '查看原始错误' }))
    const details = within(menu).getByRole('region', { name: '原始错误信息' })
    expect(JSON.parse(details.querySelector('code')!.textContent!)).toMatchObject({ code: 'FAVORITE_STORE', detail: { code: 'EACCES', token: '[redacted]' } })
    expect(notice).toHaveBeenCalledWith('warn', '本地收藏失败', expect.objectContaining({ code: 'FAVORITE_STORE' }))
    invoke.mockImplementation(original)
    fireEvent.click(within(menu).getByRole('button', { name: '收藏' }))
    await within(menu).findByText('已收藏')
    expect(within(menu).queryByRole('button', { name: '查看原始错误' })).toBeNull()
  })

  it('copies exact text and reports success after the menu closes', async () => {
    const { notice } = await mountMenu(mode)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith('复制合成文本甲')
    expect(screen.queryByRole('button', { name: '复制' })).toBeNull()
    await waitFor(() => expect(notice).toHaveBeenCalledExactlyOnceWith('info', '弹幕已复制'))
  })

  it.each(['missing', 'rejected'] as const)('keeps the clipboard summary and adds redacted original fields when access is %s', async problem => {
    if (problem === 'missing') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    else writeText.mockRejectedValue(new Error('Cannot write C:\\Users\\PRIVATE\\clipboard.txt'))
    const { session, notice } = await mountMenu(mode)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await waitFor(() => expect(notice).toHaveBeenCalledExactlyOnceWith('warn', '复制失败, 请重试.', expect.any(Error)))
    const notices = session.flush().notices
    expect(JSON.stringify(notices)).not.toContain('PRIVATE')
    expect(notices.find(item => item.text === '复制失败, 请重试.')?.detail).toMatchObject({
      name: 'Error', message: problem === 'missing' ? 'Clipboard text writing unavailable' : 'Cannot write [user]\\clipboard.txt',
    })
  })

  it('keeps a pending copy from writing twice or putting its result into a different menu', async () => {
    let complete!: () => void
    writeText.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
    const { notice, open } = await mountMenu(mode)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    open('复制合成文本乙')
    const copy = screen.getByRole('button', { name: '复制' })
    expect(copy).toBeDisabled()
    fireEvent.click(copy)
    expect(writeText).toHaveBeenCalledOnce()
    await act(async () => { complete(); await Promise.resolve() })
    expect(copy).toBeEnabled()
    expect(notice).toHaveBeenCalledExactlyOnceWith('info', '弹幕已复制')
    const menu = mode === 'overlay' ? screen.getByRole('toolbar') : screen.getByRole('dialog', { name: /弹幕操作/ })
    expect(within(menu).queryByRole('status')).toBeNull()
  })

  it('does not publish late feedback after the provider unmounts', async () => {
    let fail!: (error: Error) => void
    writeText.mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    const { notice, view } = await mountMenu(mode)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    view.unmount()
    await act(async () => { fail(new Error('PRIVATE late clipboard error')); await Promise.resolve() })
    expect(notice).not.toHaveBeenCalled()
  })
})

function DuplicateCopyProbe() {
  const actions = useDanmakuActions()
  return <button type="button" onClick={() => { void actions.copy('同一事件'); void actions.copy('同一事件') }}>重复点击</button>
}

it('guards duplicate writes synchronously before React updates button state', async () => {
  let complete!: () => void
  writeText.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
  const session = createSession()
  render(<Wrapper session={session}><DuplicateCopyProbe /></Wrapper>)
  fireEvent.click(screen.getByRole('button', { name: '重复点击' }))
  expect(writeText).toHaveBeenCalledExactlyOnceWith('同一事件')
  await act(async () => { complete(); await Promise.resolve() })
})

it('does not show a previous room copy result in a newly connected room', async () => {
  let complete!: () => void
  writeText.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
  const { session, notice } = await mountMenu('list')
  fireEvent.click(screen.getByRole('button', { name: '复制' }))
  act(() => { session.connectDanmaku('huya:660001'); session.flush() })
  await act(async () => { complete(); await Promise.resolve() })
  expect(notice).not.toHaveBeenCalled()
})
