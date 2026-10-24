import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient, type ApiResult } from '../app/apiClient'
import type { DouyuAccountsSnapshot, DouyuMessageOutcome, DouyuTasksSnapshot } from '../../server/douyu/types'
import { DouyuMessageComposer, useDouyuMessageComposer } from './DouyuMessageComposer'

// All accounts and send responses are synthetic; no real account is contacted.
function accounts(id: string | null = 'first', label = '日常账号', loggedIn = true): DouyuAccountsSnapshot {
  return {
    activeAccountId: id,
    accounts: id === null ? [] : [{ id, label, active: true, busy: false, login: {
      loggedIn, cookieCount: loggedIn ? 2 : 0, authKeysPresent: ['synthetic-private-key'], hasSessionCookies: loggedIn, expiresAt: null,
    } }],
  }
}
function tasks(activeAccountId: string | null = 'first'): DouyuTasksSnapshot {
  return { activeAccountId, currentRoom: '1234', retainedRooms: [], tasks: [], runtime: { foreground: true, locked: false, suspended: false } }
}
function ok<T>(value: T): ApiResult<T> { return { ok: true, value } }
function outcome(status: DouyuMessageOutcome['status'] = 'succeeded', message = '服务器确认发送成功.', nextAllowedAt: number | null = null): ApiResult<DouyuMessageOutcome> {
  return ok({ status, message, nextAllowedAt })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function Harness({ connected = true, room = '9999', repeatText = '  复读原文  ' }: { connected?: boolean; room?: string | null; repeatText?: string }) {
  const controller = useDouyuMessageComposer({ connected, room })
  return <>
    <DouyuMessageComposer controller={controller} />
    <button type="button" disabled={!controller.canSendText(repeatText)} title={controller.repeatProblem(repeatText) ?? ''}
      onClick={() => { void controller.repeat(repeatText) }}>+1 样例</button>
  </>
}

let publish!: (snapshot: DouyuTasksSnapshot) => void
let unsubscribe = vi.fn()
beforeEach(() => {
  vi.spyOn(apiClient, 'listDouyuAccounts').mockResolvedValue(ok(accounts()))
  vi.spyOn(apiClient, 'getDouyuTasks').mockResolvedValue(ok(tasks()))
  vi.spyOn(apiClient, 'sendDouyuMessage').mockResolvedValue(outcome())
  unsubscribe = vi.fn()
  vi.spyOn(apiClient, 'subscribeDouyuTasks').mockImplementation(listener => { publish = listener; return unsubscribe })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

async function open(props: React.ComponentProps<typeof Harness> = {}) {
  const view = render(<Harness {...props} />)
  await screen.findByText(/当前账号: 日常账号/)
  return view
}
const editor = () => screen.getByLabelText('弹幕内容')
const sendButton = () => screen.getByRole('button', { name: '发送' })
const repeatButton = () => screen.getByRole('button', { name: '+1 样例' })
function write(text: string) { fireEvent.change(editor(), { target: { value: text } }) }

describe('DouyuMessageComposer account and room context', () => {
  it('waits for initial identity before accepting text but preserves typing during a same-account refresh', async () => {
    const initial = deferred<ApiResult<DouyuAccountsSnapshot>>()
    const refresh = deferred<ApiResult<DouyuAccountsSnapshot>>()
    vi.mocked(apiClient.listDouyuAccounts).mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise)
    render(<Harness />)
    expect(editor()).toBeDisabled()
    await act(async () => { initial.resolve(ok(accounts())) })
    expect(editor()).toBeEnabled()
    fireEvent.focus(editor())
    expect(editor()).toBeEnabled()
    write('刷新期间的新草稿')
    expect(sendButton()).toBeDisabled()
    await act(async () => { refresh.resolve(ok(accounts())) })
    expect(editor()).toHaveValue('刷新期间的新草稿')
    expect(sendButton()).toBeEnabled()
  })

  it('shows the selected public account and actual session room without auth metadata', async () => {
    await open()
    expect(screen.getByRole('form', { name: '发送斗鱼弹幕' })).toBeVisible()
    expect(screen.getByText('当前账号: 日常账号 / 房间: 9999')).toBeVisible()
    expect(screen.queryByText(/synthetic-private-key/)).not.toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
    expect(repeatButton()).toBeEnabled()
    expect(apiClient.sendDouyuMessage).not.toHaveBeenCalled()
  })

  it.each([accounts(null), accounts('first', '日常账号', false)])('guides an unavailable login to source settings without sending', async snapshot => {
    vi.mocked(apiClient.listDouyuAccounts).mockResolvedValue(ok(snapshot))
    render(<Harness />)
    expect(await screen.findByText('请到片源设置登录并激活斗鱼账号.')).toBeVisible()
    write('待发送')
    expect(sendButton()).toBeDisabled()
    expect(repeatButton()).toBeDisabled()
    fireEvent.submit(screen.getByRole('form', { name: '发送斗鱼弹幕' }))
    expect(apiClient.sendDouyuMessage).not.toHaveBeenCalled()
  })

  it.each([{ connected: false }, { room: null }, { room: 'room-alias' }])('requires a live canonical danmaku connection %#', async props => {
    await open(props)
    write('不可发送')
    expect(screen.getByText('连接斗鱼弹幕后才能发送.')).toBeVisible()
    expect(sendButton()).toBeDisabled()
    expect(repeatButton()).toBeDisabled()
    expect(apiClient.sendDouyuMessage).not.toHaveBeenCalled()
  })

  it('refreshes account labels and login status when the window regains focus', async () => {
    await open()
    vi.mocked(apiClient.listDouyuAccounts).mockResolvedValue(ok(accounts('second', '比赛账号')))
    fireEvent(window, new Event('focus'))
    await screen.findByText('当前账号: 比赛账号 / 房间: 9999')
    write('给新账号')
    fireEvent.click(sendButton())
    await waitFor(() => expect(apiClient.sendDouyuMessage).toHaveBeenCalledExactlyOnceWith({ accountId: 'second', room: '9999', text: '给新账号', color: 0 }))
  })

  it('refreshes a same-account label on editor focus after source settings changes', async () => {
    await open()
    write('保留草稿')
    vi.mocked(apiClient.listDouyuAccounts).mockResolvedValue(ok(accounts('first', '新账号标签')))
    fireEvent.focus(editor())
    await screen.findByText('当前账号: 新账号标签 / 房间: 9999')
    expect(editor()).toHaveValue('保留草稿')
  })

  it('refreshes login completion even when a task event keeps the same account', async () => {
    vi.mocked(apiClient.listDouyuAccounts).mockResolvedValue(ok(accounts('first', '日常账号', false)))
    render(<Harness />)
    await screen.findByText('请到片源设置登录并激活斗鱼账号.')
    vi.mocked(apiClient.listDouyuAccounts).mockResolvedValue(ok(accounts()))
    act(() => { publish(tasks()) })
    await waitFor(() => expect(repeatButton()).toBeEnabled())
    expect(screen.queryByText('请到片源设置登录并激活斗鱼账号.')).not.toBeInTheDocument()
  })

  it('does not let an older account read overwrite a newer focus refresh', async () => {
    const older = deferred<ApiResult<DouyuAccountsSnapshot>>()
    vi.mocked(apiClient.listDouyuAccounts).mockReturnValueOnce(older.promise).mockResolvedValue(ok(accounts('second', '比赛账号')))
    render(<Harness />)
    fireEvent(window, new Event('focus'))
    await screen.findByText('当前账号: 比赛账号 / 房间: 9999')
    await act(async () => { older.resolve(ok(accounts())) })
    expect(screen.getByText('当前账号: 比赛账号 / 房间: 9999')).toBeVisible()
  })

  it('does not let an older initial task read undo an account event', async () => {
    const olderTasks = deferred<ApiResult<DouyuTasksSnapshot>>()
    vi.mocked(apiClient.getDouyuTasks).mockReturnValueOnce(olderTasks.promise)
    await open()
    vi.mocked(apiClient.listDouyuAccounts).mockResolvedValue(ok(accounts('second', '比赛账号')))
    act(() => { publish(tasks('second')) })
    await screen.findByText('当前账号: 比赛账号 / 房间: 9999')
    await act(async () => { olderTasks.resolve(ok(tasks())) })
    expect(screen.getByText('当前账号: 比赛账号 / 房间: 9999')).toBeVisible()
  })

  it('does not expose rejected account errors or allow sends from a stale account', async () => {
    await open()
    vi.mocked(apiClient.listDouyuAccounts).mockRejectedValue(new Error('synthetic private credentials'))
    fireEvent(window, new Event('focus'))
    await screen.findByText('无法确认当前账号, 请到片源设置刷新账号状态.')
    write('暂不发送')
    expect(sendButton()).toBeDisabled()
    expect(screen.queryByText(/synthetic private/)).not.toBeInTheDocument()
  })
})

describe('manual sends and repetition', () => {
  it('sends original text once with a bound account, room and ordinary color', async () => {
    const pending = deferred<ApiResult<DouyuMessageOutcome>>()
    vi.mocked(apiClient.sendDouyuMessage).mockReturnValueOnce(pending.promise)
    await open()
    write('  一条中文弹幕  ')
    act(() => {
      fireEvent.submit(screen.getByRole('form', { name: '发送斗鱼弹幕' }))
      fireEvent.submit(screen.getByRole('form', { name: '发送斗鱼弹幕' }))
      fireEvent.click(repeatButton())
    })
    expect(apiClient.sendDouyuMessage).toHaveBeenCalledExactlyOnceWith({ accountId: 'first', room: '9999', text: '  一条中文弹幕  ', color: 0 })
    expect(sendButton()).toBeDisabled()
    expect(repeatButton()).toBeDisabled()
    expect(screen.queryByText('服务器确认发送成功.')).not.toBeInTheDocument()
    expect(editor()).toHaveValue('  一条中文弹幕  ')
    await act(async () => { pending.resolve(outcome()) })
    expect(screen.getByRole('status')).toHaveTextContent('服务器确认发送成功.')
    expect(editor()).toHaveValue('')
  })

  it('uses the same lock for +1 and leaves the composer draft untouched', async () => {
    const pending = deferred<ApiResult<DouyuMessageOutcome>>()
    vi.mocked(apiClient.sendDouyuMessage).mockReturnValueOnce(pending.promise)
    await open()
    write('另一个草稿')
    fireEvent.click(repeatButton())
    fireEvent.click(repeatButton())
    fireEvent.click(sendButton())
    expect(apiClient.sendDouyuMessage).toHaveBeenCalledExactlyOnceWith({ accountId: 'first', room: '9999', text: '  复读原文  ', color: 0 })
    expect(sendButton()).toBeDisabled()
    await act(async () => { pending.resolve(outcome()) })
    expect(editor()).toHaveValue('另一个草稿')
    expect(sendButton()).toBeEnabled()
  })

  it.each(['新草稿', '原草稿'])('keeps a draft edited during a pending send, including editing back to the same text: %s', async replacement => {
    const pending = deferred<ApiResult<DouyuMessageOutcome>>()
    vi.mocked(apiClient.sendDouyuMessage).mockReturnValueOnce(pending.promise)
    await open()
    write('原草稿')
    fireEvent.click(sendButton())
    write('临时修改')
    write(replacement)
    await act(async () => { pending.resolve(outcome()) })
    expect(editor()).toHaveValue(replacement)
  })

  it.each(['failed', 'waiting-user'] as const)('preserves text and does not retry a %s outcome', async status => {
    vi.mocked(apiClient.sendDouyuMessage).mockResolvedValue(outcome(status, '请在官方房间核对.'))
    await open()
    write('保留供核对')
    fireEvent.click(sendButton())
    await screen.findByText('请在官方房间核对.')
    expect(editor()).toHaveValue('保留供核对')
    expect(apiClient.sendDouyuMessage).toHaveBeenCalledOnce()
    expect(screen.queryByText('服务器确认发送成功.')).not.toBeInTheDocument()
  })

  it('sanitizes transport exceptions as an unknown result and keeps the draft', async () => {
    vi.mocked(apiClient.sendDouyuMessage).mockRejectedValue(new Error('synthetic private payload'))
    await open()
    write('不重复发送')
    fireEvent.click(sendButton())
    await screen.findByText('发送结果尚无法确认. 请在官方房间核对后再决定是否重试.')
    expect(editor()).toHaveValue('不重复发送')
    expect(screen.queryByText(/synthetic private/)).not.toBeInTheDocument()
    expect(apiClient.sendDouyuMessage).toHaveBeenCalledOnce()
  })

  it('shows a fixed API rejection and does not clear the draft', async () => {
    vi.mocked(apiClient.sendDouyuMessage).mockResolvedValue({ ok: false, code: 'context-changed', message: '当前房间已变化.' })
    await open()
    write('原上下文')
    fireEvent.click(sendButton())
    await screen.findByText('当前房间已变化.')
    expect(editor()).toHaveValue('原上下文')
  })

  it('disables both actions through the server cooldown without automatically sending', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-24T02:00:00Z'))
    const until = Date.now() + 2_000
    vi.mocked(apiClient.sendDouyuMessage).mockResolvedValue(outcome('waiting-user', '发送过快, 请稍后再试.', until))
    render(<Harness />)
    await act(async () => {})
    write('冷却中的草稿')
    await act(async () => { fireEvent.click(sendButton()) })
    expect(screen.getByText('还需等待 2 秒后发送.')).toBeVisible()
    expect(sendButton()).toBeDisabled()
    expect(repeatButton()).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(screen.getByText('还需等待 1 秒后发送.')).toBeVisible()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(sendButton()).toBeEnabled()
    expect(repeatButton()).toBeEnabled()
    expect(editor()).toHaveValue('冷却中的草稿')
    expect(apiClient.sendDouyuMessage).toHaveBeenCalledOnce()
  })
})

describe('draft validation and Chinese input methods', () => {
  it.each([
    ['   ', '请输入弹幕内容.'], ['x'.repeat(501), '弹幕最多支持 500 个字符.'],
    ['😀'.repeat(251), '弹幕最多支持 500 个字符.'],
    ['含\n换行', '弹幕包含不支持的字符, 请修改后发送.'], ['含\u0000字符', '弹幕包含不支持的字符, 请修改后发送.'],
    ['含\u0085字符', '弹幕包含不支持的字符, 请修改后发送.'], ['\ud800', '弹幕包含不支持的字符, 请修改后发送.'],
    ['\udc00', '弹幕包含不支持的字符, 请修改后发送.'],
  ])('rejects invalid text without altering its content %#', async (text, expected) => {
    await open()
    write(text)
    expect(sendButton()).toBeDisabled()
    expect(screen.getByText(expected)).toBeVisible()
    expect(editor()).toHaveValue(text)
    fireEvent.submit(screen.getByRole('form', { name: '发送斗鱼弹幕' }))
    expect(apiClient.sendDouyuMessage).not.toHaveBeenCalled()
  })

  it('accepts well-formed text exactly 500 UTF-16 code units long', async () => {
    await open()
    const text = '😀'.repeat(250)
    write(text)
    expect(sendButton()).toBeEnabled()
    fireEvent.click(sendButton())
    await waitFor(() => expect(apiClient.sendDouyuMessage).toHaveBeenCalledExactlyOnceWith({ accountId: 'first', room: '9999', text, color: 0 }))
  })

  it('applies text validation to repeat actions as well', async () => {
    await open({ repeatText: '\ud800' })
    expect(repeatButton()).toBeDisabled()
    expect(repeatButton()).toHaveAttribute('title', '弹幕包含不支持的字符, 请修改后发送.')
    fireEvent.click(repeatButton())
    expect(apiClient.sendDouyuMessage).not.toHaveBeenCalled()
  })

  it('does not send on Enter or form submit while composing Chinese text', async () => {
    await open()
    fireEvent.compositionStart(editor())
    write('中文输入')
    fireEvent.keyDown(editor(), { key: 'Enter', isComposing: true, keyCode: 229 })
    fireEvent.submit(screen.getByRole('form', { name: '发送斗鱼弹幕' }))
    expect(apiClient.sendDouyuMessage).not.toHaveBeenCalled()
    fireEvent.compositionEnd(editor())
    fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 13 })
    await waitFor(() => expect(apiClient.sendDouyuMessage).toHaveBeenCalledExactlyOnceWith({ accountId: 'first', room: '9999', text: '中文输入', color: 0 }))
  })

  it.each([{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }])('ignores an IME or modified Enter without synthesizing a send %#', async modifiers => {
    await open()
    write('输入法文本')
    fireEvent.keyDown(editor(), { key: 'Enter', ...modifiers })
    expect(apiClient.sendDouyuMessage).not.toHaveBeenCalled()
  })
})

describe('context changes discard old replies', () => {
  it('clears the old draft on room change and ignores an old success and cooldown', async () => {
    const pending = deferred<ApiResult<DouyuMessageOutcome>>()
    vi.mocked(apiClient.sendDouyuMessage).mockReturnValueOnce(pending.promise)
    const view = await open()
    write('旧房间消息')
    fireEvent.click(sendButton())
    view.rerender(<Harness room="8888" />)
    expect(editor()).toHaveValue('')
    write('新房间草稿')
    expect(sendButton()).toBeDisabled()
    await act(async () => { pending.resolve(outcome('succeeded', '旧房间成功.', Date.now() + 60_000)) })
    expect(screen.queryByText('旧房间成功.')).not.toBeInTheDocument()
    expect(editor()).toHaveValue('新房间草稿')
    expect(sendButton()).toBeEnabled()
    expect(apiClient.sendDouyuMessage).toHaveBeenCalledExactlyOnceWith({ accountId: 'first', room: '9999', text: '旧房间消息', color: 0 })
    fireEvent.click(sendButton())
    await waitFor(() => expect(apiClient.sendDouyuMessage).toHaveBeenLastCalledWith({ accountId: 'first', room: '8888', text: '新房间草稿', color: 0 }))
  })

  it('invalidates a reply as soon as an account event arrives, before account metadata resolves', async () => {
    const pendingSend = deferred<ApiResult<DouyuMessageOutcome>>()
    const pendingAccount = deferred<ApiResult<DouyuAccountsSnapshot>>()
    vi.mocked(apiClient.sendDouyuMessage).mockReturnValueOnce(pendingSend.promise)
    await open()
    write('旧账号消息')
    fireEvent.click(sendButton())
    vi.mocked(apiClient.listDouyuAccounts).mockReturnValueOnce(pendingAccount.promise)
    act(() => { publish(tasks('second')) })
    expect(editor()).toHaveValue('')
    await act(async () => { pendingSend.resolve(outcome('succeeded', '旧账号成功.')) })
    expect(screen.queryByText('旧账号成功.')).not.toBeInTheDocument()
    await act(async () => { pendingAccount.resolve(ok(accounts('second', '比赛账号'))) })
    expect(screen.getByText('当前账号: 比赛账号 / 房间: 9999')).toBeVisible()
    write('新账号消息')
    fireEvent.click(sendButton())
    await waitFor(() => expect(apiClient.sendDouyuMessage).toHaveBeenLastCalledWith({ accountId: 'second', room: '9999', text: '新账号消息', color: 0 }))
  })

  it('clears prior notices and drafts on disconnection and does not send on reconnect', async () => {
    const view = await open()
    write('第一条')
    fireEvent.click(sendButton())
    await screen.findByText('服务器确认发送成功.')
    write('未发送草稿')
    view.rerender(<Harness connected={false} />)
    expect(editor()).toHaveValue('')
    expect(screen.queryByText('服务器确认发送成功.')).not.toBeInTheDocument()
    expect(repeatButton()).toBeDisabled()
    view.rerender(<Harness />)
    expect(editor()).toHaveValue('')
    expect(apiClient.sendDouyuMessage).toHaveBeenCalledOnce()
  })

  it('discards a late response after unmount and releases subscriptions', async () => {
    const pending = deferred<ApiResult<DouyuMessageOutcome>>()
    vi.mocked(apiClient.sendDouyuMessage).mockReturnValueOnce(pending.promise)
    const view = await open()
    write('离开视图')
    fireEvent.click(sendButton())
    view.unmount()
    await act(async () => { pending.resolve(outcome()) })
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(screen.queryByText('服务器确认发送成功.')).not.toBeInTheDocument()
    expect(apiClient.sendDouyuMessage).toHaveBeenCalledOnce()
  })
})
