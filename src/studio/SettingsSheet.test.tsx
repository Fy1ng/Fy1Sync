import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import type { PlatformLoginStatus } from '../../electron/login'
import type { DouyuAccountsSnapshot } from '../../server/douyu/types'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { forgetAll } from '../app/remembered'
import { SettingsSheet } from './SettingsSheet'

const anonymous: PlatformLoginStatus = { loggedIn: false, cookieCount: 0, authKeysPresent: [], hasSessionCookies: false, expiresAt: null }
const accounts: DouyuAccountsSnapshot = { revision: 1, activeAccountId: 'default', accounts: [
  { id: 'default', label: '默认账号', active: true, busy: false, login: anonymous },
] }
const sessions: Session[] = []
const invoke = vi.fn(async (method: string) => {
  if (method === 'loginStatus') return { ok: true, value: { douyu: anonymous, bilibili: anonymous, huya: anonymous, youtube: anonymous } }
  if (method === 'listDouyuAccounts') return { ok: true, value: accounts }
  if (method === 'getDouyuTasks') return { ok: true, value: { activeAccountId: 'default', retainedRooms: [], currentRoom: null,
    runtime: { foreground: true, locked: false, suspended: false }, tasks: [1, 2].map(id => ({
      id: `paused-${id}`, accountId: 'default', room: '288016', kind: 'room-sign', policy: 'foreground',
      repeatMinutes: null, createdAt: 1, status: 'paused', reason: null, lastRunAt: null, nextRunAt: null, lastResult: null,
    })) } }
  if (method === 'login' || method === 'loginDouyuAccount') return { ok: false, code: 'login-cancelled', message: '已取消登录' }
  return { ok: true, value: {} }
})

beforeEach(() => {
  forgetAll()
  invoke.mockClear()
  vi.stubGlobal('streamSyncer', {
    invoke: invoke as StreamSyncerBridge['invoke'], subscribeDanmaku: () => () => {},
    subscribeDouyuAccounts: () => () => {}, subscribeDouyuTasks: () => () => {},
  } satisfies StreamSyncerBridge)
})
afterEach(() => {
  cleanup()
  for (const session of sessions.splice(0)) session.dispose()
  vi.unstubAllGlobals()
})

function mount(room: string | null = null, session?: Session): ReturnType<typeof render> & { session: Session } {
  const current = session ?? new Session({ createSampler: () => null })
  if (!session) sessions.push(current)
  const view = render(<SessionProvider session={current}><SettingsSheet target={{ section: 'general' }} room={room}
    onClose={() => {}} onWatch={() => {}} onFill={() => {}} /></SessionProvider>)
  return { ...view, session: current }
}
function section(name: string): void {
  fireEvent.click(within(screen.getByRole('tablist', { name: '设置分区' })).getByRole('tab', { name }))
}
function platform(name: string): void {
  fireEvent.click(within(screen.getByRole('tablist', { name: '账号平台' })).getByRole('tab', { name }))
}
function douyuTab(name: string): HTMLElement {
  return within(screen.getByRole('tablist', { name: '斗鱼' })).getByRole('tab', { name: new RegExp('^' + name) })
}

describe('settings account navigation', () => {
  it('puts five platforms in 账号 and nests Douyu pages within the same sidebar', async () => {
    mount()
    const sections = screen.getByRole('tablist', { name: '设置分区' })
    expect(within(sections).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['通用', '账号', '弹幕记录', '房间数据', '倒计时样式'])
    const general = screen.getByRole('tablist', { name: '通用' })
    for (const name of ['斗鱼', '哔哩哔哩', '虎牙', '抖音', 'YouTube']) expect(within(general).queryByRole('tab', { name })).toBeNull()
    section('账号')
    platform('斗鱼')
    const platforms = screen.getByRole('tablist', { name: '账号平台' })
    const directTabs = within(platforms).getAllByRole('tab').filter(tab => tab.closest('[role="tablist"]') === platforms)
    expect(directTabs.map(tab => tab.textContent)).toEqual(['斗鱼', '哔哩哔哩', '虎牙', '抖音', 'YouTube'])
    const subnav = screen.getByRole('tablist', { name: '斗鱼' })
    const sidebar = platforms.closest('.side-nav')
    expect(sidebar).not.toBeNull()
    expect(subnav.closest('.side-nav')).toBe(sidebar)
    expect(document.querySelectorAll('.settings .side-nav')).toHaveLength(1)
    expect(within(subnav).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['账号', '关注', '背包', '实验性'])
    expect(await screen.findByRole('group', { name: '斗鱼账号 默认账号' })).toBeInTheDocument()
    platform('虎牙')
    expect(screen.queryByRole('tablist', { name: '斗鱼' })).toBeNull()
    expect(screen.getByRole('tabpanel', { name: '虎牙' })).toBeInTheDocument()
  })

  it('retains platform and Douyu subpage selections across switches and reopening', async () => {
    const view = mount()
    section('账号')
    platform('斗鱼')
    fireEvent.click(douyuTab('实验性'))
    platform('哔哩哔哩')
    platform('斗鱼')
    expect(douyuTab('实验性')).toHaveAttribute('aria-selected', 'true')
    platform('虎牙')
    view.unmount()
    mount(null, view.session)
    section('账号')
    expect(within(screen.getByRole('tablist', { name: '账号平台' })).getByRole('tab', { name: '虎牙' })).toHaveAttribute('aria-selected', 'true')
    platform('斗鱼')
    expect(douyuTab('实验性')).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps write-only pages gated while switching the setting', async () => {
    const view = mount()
    section('账号')
    platform('斗鱼')
    const subnav = screen.getByRole('tablist', { name: '斗鱼' })
    for (const name of ['房间任务', '批量任务', '粉丝牌']) expect(within(subnav).queryByRole('tab', { name })).toBeNull()
    await act(async () => view.session.updateSettings({ douyuWrites: true }))
    for (const name of ['房间任务', '批量任务', '粉丝牌']) expect(douyuTab(name)).toBeInTheDocument()
    await waitFor(() => expect(douyuTab('房间任务').querySelector('.tab-count')).toHaveTextContent('2'))
    fireEvent.click(douyuTab('房间任务'))
    await act(async () => view.session.updateSettings({ douyuWrites: false }))
    expect(douyuTab('账号')).toHaveAttribute('aria-selected', 'true')
    expect(within(subnav).queryByRole('tab', { name: '房间任务' })).toBeNull()
  })

  it('keeps every login entry reachable while watching a Huya room', async () => {
    mount('huya:kpl')
    section('账号')
    for (const [name, method, args] of [
      ['斗鱼', 'loginDouyuAccount', { id: 'default' }],
      ['哔哩哔哩', 'login', { platform: 'bilibili' }],
      ['虎牙', 'login', { platform: 'huya' }],
      ['YouTube', 'login', { platform: 'youtube' }],
    ] as const) {
      platform(name)
      await waitFor(() => expect(screen.getByRole('button', { name: '登录' })).toBeEnabled())
      fireEvent.click(screen.getByRole('button', { name: '登录' }))
      await waitFor(() => expect(invoke).toHaveBeenCalledWith(method, args))
    }
    expect(screen.queryByText('当前虎牙房间仅支持只读弹幕, 斗鱼操作与统计暂不可用')).toBeNull()
  })
})
