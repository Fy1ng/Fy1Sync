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

function createSession() {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  session.connectDanmaku('huya:660000')
  session.flush()
  return session
}

function Wrapper({ session, children }: { session: Session; children: React.ReactNode }) {
  return <SessionProvider session={session}><SourceLoaderProvider><ComposerProvider>
    <DanmakuActionsProvider onOpenRecords={() => {}}>{children}</DanmakuActionsProvider>
  </ComposerProvider></SourceLoaderProvider></SessionProvider>
}

type Mode = 'list' | 'overlay'
async function mountMenu(mode: Mode) {
  const session = createSession()
  const notice = vi.spyOn(session, 'notice')
  const view = render(<Wrapper session={session}>{mode === 'list'
    ? <ChatDrawer onClose={() => {}} onOpenSettings={() => {}} onOpenRecords={() => {}} />
    : <DanmakuStage onReply={() => {}} />}</Wrapper>)
  await act(async () => { await Promise.resolve() })
  act(() => {
    session.pushDanmaku({ text: '复制合成文本甲', user: '合成观众', color: '#fff', platform: 'huya' })
    session.pushDanmaku({ text: '复制合成文本乙', user: '合成观众', color: '#fff', platform: 'huya' })
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
  it('copies exact text and reports success after the menu closes', async () => {
    const { notice } = await mountMenu(mode)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith('复制合成文本甲')
    expect(screen.queryByRole('button', { name: '复制' })).toBeNull()
    await waitFor(() => expect(notice).toHaveBeenCalledExactlyOnceWith('info', '弹幕已复制'))
  })

  it.each(['missing', 'rejected'] as const)('reports a static failure when clipboard access is %s', async problem => {
    if (problem === 'missing') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    else writeText.mockRejectedValue(new Error('PRIVATE clipboard OS path'))
    const { session, notice } = await mountMenu(mode)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await waitFor(() => expect(notice).toHaveBeenCalledExactlyOnceWith('warn', '复制失败, 请重试.'))
    expect(JSON.stringify(session.flush().notices)).not.toContain('PRIVATE')
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
