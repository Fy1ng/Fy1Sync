/**
 * The send box and the danmaku actions against a stubbed bridge: which send mode each path
 * uses, what the delivery line says, and that muting needs the platform's permission and the
 * viewer's confirmation before anything is submitted.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { ComposerProvider, useComposer } from './composer'
import { DOUYU_MUTE_MINUTES } from '../../server/douyu/moderation'
import { DanmakuActionsProvider, MUTE_MINUTES, useDanmakuActions } from './danmakuActions'
import { credentialProblem, deliveryText } from './useStudioComposer'

type Handler = (args: unknown) => unknown
let handlers: Record<string, Handler>
let calls: Array<{ method: string; args: unknown }>
const sessions: Session[] = []

const ACCOUNTS = {
  activeAccountId: 'default',
  accounts: [{ id: 'default', label: '主号', active: true, busy: false, login: { loggedIn: true } }],
}

beforeEach(() => {
  calls = []
  handlers = {
    listDouyuAccounts: () => ACCOUNTS,
    getDouyuTasks: () => ({ activeAccountId: 'default', tasks: [] }),
    getDanmakuFeatures: () => ({ preferences: {}, affixes: { enabled: true, prefix: '【', suffix: '】' }, favoriteCount: 0 }),
    sendComposedDouyuMessage: () => ({ status: 'succeeded', message: '已发送', nextAllowedAt: null, deliveryId: 'd1' }),
    getDouyuDelivery: () => ({ id: 'd1', accountId: 'default', room: '288016', sentAt: 0, deadlineAt: Date.now() + 60_000,
      gateway: 'accepted', roomEcho: 'observed', observedAt: 1, messageId: null }),
  }
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      const handler = handlers[method]
      return handler ? { ok: true, value: handler(args) } : { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: (room: string, listener: (event: { event: string; data: unknown }) => void) => {
      queueMicrotask(() => listener({ event: 'state', data: { room, state: 'connected' } }))
      return () => {}
    },
    subscribeDouyuTasks: () => () => {},
    subscribeFeatures: () => () => {},
  } as unknown as StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.unstubAllGlobals()
})

async function connectedSession(): Promise<Session> {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  session.connectDanmaku('288016')
  await act(async () => { await Promise.resolve() })
  return session
}

function Probe(): React.ReactNode {
  const composer = useComposer()
  const actions = useDanmakuActions()
  return (
    <>
      <span data-testid="state">{composer.canEdit ? 'ready' : 'not-ready'}</span>
      <span data-testid="blocked">{composer.blockedReason ?? ''}</span>
      <span data-testid="relogin">{composer.needsRelogin ? 'relogin' : ''}</span>
      <span data-testid="delivery">{deliveryText(composer.delivery) ?? ''}</span>
      <button type="button" onClick={() => composer.setDraft('你好')}>draft</button>
      <button type="button" onClick={() => void composer.sendDraft()}>send</button>
      <button type="button" onClick={() => void composer.repeat('原文')}>repeat</button>
      <button type="button" onClick={() => actions.mute({ id: 'm', text: '刷屏', user: '某观众', color: '', scheduleTime: 0, receivedAt: 0, sender: { uid: '42' } })}>mute</button>
    </>
  )
}

function renderProbe(session: Session): void {
  render(
    <SessionProvider session={session}>
      <ComposerProvider>
        <DanmakuActionsProvider onOpenRecords={() => {}}>
          <Probe />
        </DanmakuActionsProvider>
      </ComposerProvider>
    </SessionProvider>,
  )
}

describe('the studio send box', () => {
  it('sends typed text as a message and +1 verbatim as a repeat', async () => {
    renderProbe(await connectedSession())
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready'))

    fireEvent.click(screen.getByText('draft'))
    fireEvent.click(screen.getByText('send'))
    await waitFor(() => expect(calls.some((call) => call.method === 'sendComposedDouyuMessage')).toBe(true))
    expect(calls.find((call) => call.method === 'sendComposedDouyuMessage')!.args)
      .toMatchObject({ accountId: 'default', room: '288016', text: '你好', mode: 'message' })

    await waitFor(() => expect(screen.getByTestId('delivery')).toHaveTextContent('平台已受理 · 已在房间中显示'))

    fireEvent.click(screen.getByText('repeat'))
    await waitFor(() => expect(calls.filter((call) => call.method === 'sendComposedDouyuMessage')).toHaveLength(2))
    expect(calls.filter((call) => call.method === 'sendComposedDouyuMessage')[1]!.args).toMatchObject({ text: '原文', mode: 'repeat' })
  })

  it('blocks a logged-in account that lacks send credentials and says what to do', async () => {
    handlers.listDouyuAccounts = () => ({ activeAccountId: 'default', accounts: [{ id: 'default', label: '主号', active: true, busy: false,
      login: { loggedIn: true, canSend: false, missingCredentialFields: ['acf_did', 'dy_did', 'did'] } }] })
    renderProbe(await connectedSession())
    await waitFor(() => expect(screen.getByTestId('relogin')).toHaveTextContent('relogin'))
    expect(screen.getByTestId('state')).toHaveTextContent('not-ready')
    expect(screen.getByTestId('blocked')).toHaveTextContent('缺少发送弹幕所需的设备标识')
    fireEvent.click(screen.getByText('repeat'))
    await act(async () => { await Promise.resolve() })
    expect(calls.some((call) => call.method === 'sendComposedDouyuMessage')).toBe(false)
  })

  it('treats an absent canSend as able to try, for an older main process', async () => {
    renderProbe(await connectedSession())
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready'))
    expect(screen.getByTestId('relogin')).toHaveTextContent('')
  })

  it("names missing credentials in the viewer's words, never as cookie names", () => {
    expect(credentialProblem(['acf_uid', 'acf_username'])).toBe('当前账号缺少发送弹幕所需的用户编号、用户名，请在斗鱼账号中重新登录。')
    expect(credentialProblem(['acf_auth_wl', 'acf_dmjwt_token'])).toContain('登录凭证')
    expect(credentialProblem([])).toContain('登录信息')
    expect(credentialProblem(['acf_did', 'dy_did'])).not.toMatch(/acf_|dy_/)
  })

  it('says a missing room echo is not proof of being blocked', () => {
    expect(deliveryText({ id: 'd', accountId: 'a', room: 'r', sentAt: 0, deadlineAt: 0, gateway: 'accepted',
      roomEcho: 'not-observed', observedAt: null, messageId: null })).toContain('不代表被屏蔽')
  })
})

describe('muting from a danmaku', () => {
  it('offers exactly the durations the backend accepts', () => {
    expect([...MUTE_MINUTES]).toEqual([...DOUYU_MUTE_MINUTES])
  })

  it('offers no confirmation when the platform denies the permission', async () => {
    handlers.previewDouyuMute = () => ({ allowed: false, code: 'permission-required', message: '斗鱼未授予当前账号在该房间禁言的权限.' })
    renderProbe(await connectedSession())
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready'))
    fireEvent.click(screen.getByText('mute'))
    expect(await screen.findByRole('alert')).toHaveTextContent('未授予')
    expect(screen.queryByRole('button', { name: /确认禁言/ })).toBeNull()
    expect(calls.some((call) => call.method === 'muteDouyuUser')).toBe(false)
  })

  it('submits once, with the chosen duration, only after confirmation', async () => {
    handlers.previewDouyuMute = () => ({ allowed: true, code: 'allowed', message: '' })
    handlers.muteDouyuUser = () => ({ status: 'succeeded', code: 'receipt-confirmed', message: '斗鱼已返回禁言成功回执.', submitted: true })
    renderProbe(await connectedSession())
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready'))
    fireEvent.click(screen.getByText('mute'))
    const confirm = await screen.findByRole('button', { name: /确认禁言/ })
    expect(calls.some((call) => call.method === 'muteDouyuUser')).toBe(false)
    fireEvent.change(screen.getByLabelText('禁言时长'), { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: /确认禁言/ }))
    fireEvent.click(confirm)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('禁言成功'))
    const mutes = calls.filter((call) => call.method === 'muteDouyuUser')
    expect(mutes).toHaveLength(1)
    expect(mutes[0]!.args).toMatchObject({ accountId: 'default', room: '288016', username: '某观众', minutes: 60 })
  })
})
