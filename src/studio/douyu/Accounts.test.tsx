import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { DouyuAccountsSnapshot } from '../../../server/douyu/types'
import { forgetAll } from '../../app/remembered'
import { Accounts } from './Accounts'
import { useDouyu } from './useDouyu'

const addedId = '11111111-1111-4111-8111-111111111111'
const anonymous = { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false }

let state: DouyuAccountsSnapshot
let invoke: ReturnType<typeof vi.fn>

function Harness(): React.ReactNode {
  return <Accounts data={useDouyu()} />
}

beforeEach(() => {
  forgetAll()
  state = {
    revision: 1,
    activeAccountId: 'default',
    accounts: [{ id: 'default', label: '默认账号', active: true, busy: false, login: { ...anonymous } }],
  }
  invoke = vi.fn(async (method: string, args: unknown) => {
    if (method === 'listDouyuAccounts') return { ok: true, value: state }
    if (method === 'getDouyuTasks') {
      return { ok: true, value: { activeAccountId: state.activeAccountId, currentRoom: null, retainedRooms: [], runtime: { foreground: true, locked: false, suspended: false }, tasks: [] } }
    }
    if (method === 'addDouyuAccount') {
      state = {
        revision: state.revision + 1,
        activeAccountId: state.activeAccountId,
        accounts: [...state.accounts, { id: addedId, label: `账号 ${state.accounts.length + 1}`, active: false, busy: false, login: { ...anonymous } }],
      }
      return { ok: true, value: state }
    }
    if (method === 'removeDouyuAccount') {
      const id = (args as { id: string }).id
      state = {
        revision: state.revision + 1,
        activeAccountId: state.activeAccountId === id ? null : state.activeAccountId,
        accounts: state.accounts.filter((item) => item.id !== id),
      }
      return { ok: true, value: state }
    }
    return { ok: false, code: 'unexpected', message: 'unexpected' }
  })
  vi.stubGlobal('streamSyncer', {
    invoke: invoke as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
    subscribeDouyuAccounts: () => () => {},
    subscribeDouyuTasks: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Douyu Accounts view without custom naming', () => {
  it('exposes only the add-account button, hides rename controls, and adds an unnamed account directly', async () => {
    render(<Harness />)
    const first = await screen.findByRole('group', { name: '斗鱼账号 默认账号' })
    expect(within(first).queryByRole('button', { name: '重命名' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '新账号名称' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '账号名称' })).toBeNull()
    expect(first.querySelector('.account-name')).toBeNull()

    const add = screen.getByRole('button', { name: '添加账号' })
    expect(add).toBeEnabled()
    fireEvent.click(add)

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('addDouyuAccount', undefined))
    const second = await screen.findByRole('group', { name: '斗鱼账号 账号 2' })
    expect(within(second).queryByRole('button', { name: '重命名' })).toBeNull()
    expect(second.querySelector('.account-name')).toBeNull()
    expect(within(second).getByText('未登录')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('已添加账号')
  })

  it('shows Douyu nickname and avatar when signed in and confirms removal cleanly', async () => {
    state = {
      revision: 1,
      activeAccountId: 'default',
      accounts: [{
        id: 'default',
        label: '解说甲',
        active: true,
        busy: false,
        login: { ...anonymous, loggedIn: true, cookieCount: 3, nickname: '解说甲', avatar: 'data:image/png;base64,AQ==' },
      }],
    }
    render(<Harness />)
    const row = await screen.findByRole('group', { name: '斗鱼账号 解说甲' })
    expect(within(row).getByText('解说甲')).toHaveClass('account-name')
    expect(within(row).getByRole('img', { name: '解说甲的头像' })).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: '重命名' })).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: '删除' }))
    expect(within(row).getByText('删除该账号及其任务？')).toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: '取消' }))
    expect(within(row).queryByText('删除该账号及其任务？')).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: '删除' }))
    fireEvent.click(within(row).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('removeDouyuAccount', { id: 'default' }))
    expect(await screen.findByText('暂无账号')).toBeInTheDocument()
  })
})
