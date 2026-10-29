/**
 * A login finishes while the viewer is elsewhere in 设置: coming back must show the result,
 * not the 处理中 snapshot remembered from before they left.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import { forgetAll } from '../../app/remembered'
import { Accounts } from './Accounts'
import { useDouyu } from './useDouyu'

const snapshot = (busy: boolean, loggedIn: boolean) => ({
  activeAccountId: 'default',
  accounts: [{ id: 'default', label: '默认账号', active: true, busy, login: { loggedIn, cookieCount: loggedIn ? 4 : 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false } }],
})

let finishLogin: (() => void) | null = null
let current = snapshot(false, false)

beforeEach(() => {
  forgetAll()
  current = snapshot(false, false)
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'listDouyuAccounts') return { ok: true, value: current }
      if (method === 'getDouyuTasks') return { ok: true, value: { activeAccountId: 'default', currentRoom: null, retainedRooms: [], runtime: { foreground: true, locked: false, suspended: false }, tasks: [] } }
      if (method === 'loginDouyuAccount') {
        current = snapshot(true, false)
        await new Promise<void>((resolve) => { finishLogin = resolve })
        current = snapshot(false, true)
        return { ok: true, value: current }
      }
      return { ok: false, code: 'unexpected', message: 'unexpected' }
    }) as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
    subscribeDouyuTasks: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness(): React.ReactNode {
  return <Accounts data={useDouyu()} />
}

describe('pushed account snapshots', () => {
  it('lets a newer push win over a slower first read', async () => {
    let push: ((snapshot: unknown) => void) | null = null
    let answerRead: ((value: unknown) => void) | null = null
    vi.stubGlobal('streamSyncer', {
      invoke: vi.fn(async (method: string) => {
        if (method === 'listDouyuAccounts') return new Promise((resolve) => { answerRead = resolve })
        if (method === 'getDouyuTasks') return { ok: true, value: { activeAccountId: 'default', currentRoom: null, retainedRooms: [], runtime: { foreground: true, locked: false, suspended: false }, tasks: [] } }
        return { ok: false, code: 'unexpected', message: 'unexpected' }
      }) as unknown as StreamSyncerBridge['invoke'],
      subscribeDanmaku: () => () => {},
      subscribeDouyuTasks: () => () => {},
      subscribeDouyuAccounts: (listener) => { push = listener as (snapshot: unknown) => void; return () => { push = null } },
    } satisfies StreamSyncerBridge)
    render(<Harness />)
    await waitFor(() => expect(push).not.toBeNull())
    await act(async () => { push!({ ...snapshot(false, true), revision: 5 }) })
    expect(await screen.findByText(/已登录/)).toBeInTheDocument()
    // The first read was taken before the login and answers late, with an older revision.
    await act(async () => { answerRead!({ ok: true, value: { ...snapshot(false, false), revision: 3 } }); await Promise.resolve() })
    expect(screen.getByText(/已登录/)).toBeInTheDocument()
    expect(screen.queryByText('未登录')).toBeNull()
  })
})

describe('a Douyu login that ends while 斗鱼 is closed', () => {
  it('shows the finished login when the viewer returns', async () => {
    const first = render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: '登录' }))
    await waitFor(() => expect(finishLogin).not.toBeNull())
    // Leave 斗鱼 mid-login, then come back while it is still pending.
    first.unmount()
    const second = render(<Harness />)
    expect(await screen.findByText('处理中')).toBeInTheDocument()
    second.unmount()
    // The window closes with nothing of 斗鱼 on screen.
    await act(async () => { finishLogin!(); await Promise.resolve() })
    render(<Harness />)
    // The remembered snapshot is already the finished one, before any re-read lands.
    expect(screen.queryByText('处理中')).toBeNull()
    await waitFor(() => expect(screen.getByText(/已登录/)).toBeInTheDocument())
  })
})
