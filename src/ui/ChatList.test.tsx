import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient, type ApiResult } from '../app/apiClient'
import { SessionProvider } from '../app/SessionContext'
import type { Session } from '../app/session'
import type { DanmakuMessage } from '../core/danmakuTimeline'
import type { DouyuMessageOutcome } from '../../server/douyu/types'
import { ChatList } from './ChatList'
import { CHAT_ROW_HEIGHT } from './chatWindow'

const makeMessage = (index: number, text = `已显示弹幕 ${index}`): DanmakuMessage => ({ id: `message-${index}`, user: `观众${index}`, text, color: '#fff', scheduleTime: 0, receivedAt: 0 })

function feed(initial: DanmakuMessage[]) {
  let messages = initial
  let total = messages.length
  const listeners = new Set<() => void>()
  const session = {
    chatHistory: () => messages,
    chatCount: () => total,
    subscribeChat: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    pushDanmaku: vi.fn(),
  }
  return {
    session,
    append(message: DanmakuMessage) { messages = [...messages, message]; total++; listeners.forEach(listener => listener()) },
  }
}

beforeEach(() => {
  vi.spyOn(apiClient, 'listDouyuAccounts').mockResolvedValue({ ok: true, value: { activeAccountId: 'first', accounts: [
    { id: 'first', label: '测试账号', active: true, busy: false, login: { loggedIn: true, cookieCount: 1, authKeysPresent: [], hasSessionCookies: true, expiresAt: null } },
  ] } })
  vi.spyOn(apiClient, 'getDouyuTasks').mockResolvedValue({ ok: true, value: { activeAccountId: 'first', currentRoom: '1234', retainedRooms: [], tasks: [], runtime: { foreground: true, locked: false, suspended: false } } })
  vi.spyOn(apiClient, 'subscribeDouyuTasks').mockReturnValue(() => {})
  vi.spyOn(apiClient, 'sendDouyuMessage').mockResolvedValue({ ok: true, value: { status: 'succeeded', message: '服务器确认发送成功.', nextAllowedAt: null } })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('chat-scroller') ? 260 : 0 })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return Number.parseFloat(this.querySelector<HTMLElement>('.chat-track')?.style.height ?? '0') })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function open(store: ReturnType<typeof feed>, connected = true, localIdentity?: React.ComponentProps<typeof ChatList>['localIdentity']) {
  return render(<SessionProvider session={store.session as unknown as Session}><ChatList connected={connected} room="9999" localIdentity={localIdentity} /></SessionProvider>)
}

describe('ChatList manual +1', () => {
  it('adds a labelled local identity badge without changing the repeat text or real sender', async () => {
    const chat = { ...makeMessage(1, '原始发言'), sender: { uid: '42', level: 1, nobleLevel: 0 } }
    const store = feed([chat, { ...makeMessage(2), sender: { uid: '99' } }])
    open(store, true, { localPhantomIdentity: true, localPhantomUid: '42' })
    expect(screen.getAllByText('本地幻神')).toHaveLength(1)
    const repeat = screen.getByRole('button', { name: '+1 复读 观众1 的弹幕' })
    await waitFor(() => expect(repeat).toBeEnabled())
    fireEvent.click(repeat)
    await screen.findByText('服务器确认发送成功.')
    expect(apiClient.sendDouyuMessage).toHaveBeenCalledExactlyOnceWith({ accountId: 'first', room: '9999', text: '原始发言', color: 0 })
    expect(store.session.chatHistory()[0]).toEqual(chat)
  })

  it('shows the original gift notice without offering to repeat it as chat', async () => {
    const gift = { ...makeMessage(1, '粉丝荧光棒 x 2'), gift: { kind: 'prop' as const, id: '268', count: 2 } }
    const store = feed([gift, makeMessage(2, '我想送荧光棒')])
    open(store)
    expect(screen.getByText('粉丝荧光棒 x 2')).toBeVisible()
    expect(screen.queryByRole('button', { name: '+1 复读 观众1 的弹幕' })).not.toBeInTheDocument()
    const repeat = screen.getByRole('button', { name: '+1 复读 观众2 的弹幕' })
    await waitFor(() => expect(repeat).toBeEnabled())
    fireEvent.click(repeat)
    await screen.findByText('服务器确认发送成功.')
    expect(apiClient.sendDouyuMessage).toHaveBeenCalledExactlyOnceWith({ accountId: 'first', room: '9999', text: '我想送荧光棒', color: 0 })
    expect(store.session.chatHistory()[0]).toEqual(gift)
  })

  it('sends displayed text verbatim once and never inserts a local success message', async () => {
    const text = '  原始中文内容 😀  '
    const store = feed([makeMessage(1, text)])
    open(store)
    const repeat = screen.getByRole('button', { name: '+1 复读 观众1 的弹幕' })
    await waitFor(() => expect(repeat).toBeEnabled())
    fireEvent.click(repeat)
    await screen.findByText('服务器确认发送成功.')
    expect(apiClient.sendDouyuMessage).toHaveBeenCalledExactlyOnceWith({ accountId: 'first', room: '9999', text, color: 0 })
    expect(store.session.pushDanmaku).not.toHaveBeenCalled()
    expect(store.session.chatHistory()).toHaveLength(1)
    expect(screen.getByText('1 条')).toBeVisible()
    expect(within(screen.getByRole('log')).queryByText('服务器确认发送成功.')).not.toBeInTheDocument()
  })

  it('keeps row positions, scroll anchoring and unread counts while a repeat is pending', async () => {
    let resolve!: (value: ApiResult<DouyuMessageOutcome>) => void
    vi.mocked(apiClient.sendDouyuMessage).mockReturnValueOnce(new Promise(done => { resolve = done }))
    const store = feed(Array.from({ length: 100 }, (_, index) => makeMessage(index)))
    const view = open(store)
    await screen.findByText('当前账号: 测试账号 / 房间: 9999')
    const scroller = screen.getByRole('log')
    scroller.scrollTop = 260
    fireEvent.scroll(scroller)
    act(() => { store.append(makeMessage(100)) })
    const jump = screen.getByRole('button', { name: '1 条新消息' })
    expect(scroller.scrollTop).toBe(260)
    const rows = [...view.container.querySelectorAll<HTMLElement>('.chat-row')]
    expect(rows.length).toBeLessThan(101)
    expect(rows[1]!.style.transform).toBe(`translateY(${(4 + 1) * CHAT_ROW_HEIGHT}px)`)
    expect(view.container.querySelector<HTMLElement>('.chat-track')!.style.height).toBe(`${101 * CHAT_ROW_HEIGHT}px`)
    fireEvent.change(screen.getByLabelText('弹幕内容'), { target: { value: '另写一条' } })
    const repeat = within(rows[0]!).getByRole('button')
    fireEvent.click(repeat)
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: /^\+1 复读/ }).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(jump).toBeVisible()
    expect(scroller.scrollTop).toBe(260)
    await act(async () => { resolve({ ok: true, value: { status: 'waiting-user', message: '请到官方房间核对.', nextAllowedAt: null } }) })
    expect(scroller.scrollTop).toBe(260)
    expect(store.session.chatHistory()).toHaveLength(101)
    expect(screen.getByRole('button', { name: '1 条新消息' })).toBeVisible()
    expect(screen.getByLabelText('弹幕内容')).toHaveValue('另写一条')
    expect(store.session.pushDanmaku).not.toHaveBeenCalled()
  })

  it('keeps all repeat buttons disabled after disconnection', async () => {
    const store = feed([makeMessage(1)])
    open(store, false)
    await screen.findByText('当前账号: 测试账号 / 房间: 9999')
    const repeat = screen.getByRole('button', { name: '+1 复读 观众1 的弹幕' })
    expect(repeat).toBeDisabled()
    fireEvent.click(repeat)
    expect(apiClient.sendDouyuMessage).not.toHaveBeenCalled()
  })
})
