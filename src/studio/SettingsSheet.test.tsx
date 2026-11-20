import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import type { PlatformLoginStatus } from '../../electron/login'
import type { DouyuAccountsSnapshot } from '../../server/douyu/types'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { apiClient } from '../app/apiClient'
import { forgetAll, remember } from '../app/remembered'
import { DEFAULT_SETTINGS, loadSettings } from '../app/settings'
import { SettingsSheet } from './SettingsSheet'
import { DEFAULT_MEDIA_NETWORK } from '../../server/mediaNetworkOptions'
import type { NetworkPreferenceState } from '../../electron/networkPreferences'

const anonymous: PlatformLoginStatus = { loggedIn: false, cookieCount: 0, authKeysPresent: [], hasSessionCookies: false, expiresAt: null }
const accounts: DouyuAccountsSnapshot = { revision: 1, activeAccountId: 'default', accounts: [
  { id: 'default', label: '默认账号', active: true, busy: false, login: anonymous },
] }
const sessions: Session[] = []
const invoke = vi.fn(async (method: string): Promise<unknown> => {
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
  vi.restoreAllMocks()
})

function mount(room: string | null = null, session?: Session, onClose: () => void = () => {}): ReturnType<typeof render> & { session: Session } {
  const current = session ?? new Session({ createSampler: () => null })
  if (!session) sessions.push(current)
  const view = render(<SessionProvider session={current}><SettingsSheet target={{ section: 'general' }} room={room}
    onClose={onClose} onWatch={() => {}} onFill={() => {}} /></SessionProvider>)
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

function generalPage(name: string): void {
  fireEvent.click(within(screen.getByRole('tablist', { name: '通用' })).getByRole('tab', { name }))
}

function shortcutRow(action: string): ReturnType<typeof within> {
  return within(screen.getByRole('rowheader', { name: action }).closest('tr')!)
}

describe('player shortcut settings', () => {
  it('lists all nine player actions after the alignment tab and shows the actual steps', async () => {
    mount()
    const tabs = within(screen.getByRole('tablist', { name: '通用' })).getAllByRole('tab')
    expect(tabs.slice(0, 3).map(tab => tab.textContent)).toEqual(['对齐', '快捷键', '网络'])
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: '10 秒' })) })
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: '0.25 秒' })) })
    generalPage('快捷键')
    const expected = [
      ['播放／暂停', '空格'], ['主画面后退', '←'], ['主画面前进', '→'],
      ['回退画面', ',', '['], ['快进画面', '.', ']'], ['自动对齐', 'A'],
      ['开关弹幕', 'D'], ['展开／收起弹幕栏', 'C'], ['全屏', 'F'],
    ] as const
    expect(screen.getAllByRole('rowheader').map(header => header.textContent)).toEqual(expected.map(([action]) => action))
    for (const [action, ...keys] of expected) {
      for (const key of keys) expect(shortcutRow(action).getByRole('button', { name: `${action}：修改 ${key}` })).toHaveTextContent(key)
    }
    for (const action of ['主画面后退', '主画面前进']) {
      expect(shortcutRow(action).getByText('5 秒')).toBeInTheDocument()
      expect(shortcutRow(action).getByText('Shift：30 秒')).toBeInTheDocument()
    }
    for (const action of ['回退画面', '快进画面']) {
      expect(shortcutRow(action).getByText('10 秒')).toBeInTheDocument()
      expect(shortcutRow(action).getByText('Shift：0.25 秒')).toBeInTheDocument()
    }
  })

  it('rejects reserved keys and chords, and Escape cancels recording without closing the sheet', () => {
    const onClose = vi.fn()
    const { session } = mount(null, undefined, onClose)
    generalPage('快捷键')
    const row = shortcutRow('开关弹幕')
    const button = row.getByRole('button', { name: '开关弹幕：修改 D' })
    fireEvent.click(button)
    expect(button).toHaveFocus()
    for (const key of [
      { code: 'Tab' }, { code: 'Enter' }, { code: 'NumpadEnter' }, { code: 'ShiftLeft' },
      { code: 'ControlRight' }, { code: 'AltLeft' }, { code: 'MetaRight' }, { code: 'Unidentified' },
      { code: 'KeyK', ctrlKey: true }, { code: 'KeyK', altKey: true },
      { code: 'KeyK', metaKey: true }, { code: 'KeyK', shiftKey: true },
    ]) {
      fireEvent.keyDown(button, key)
      expect(session.settings.shortcuts).toEqual(DEFAULT_SETTINGS.shortcuts)
      expect(row.getByText('按下新按键')).toBeInTheDocument()
    }
    expect(row.getByRole('alert')).toHaveTextContent('不能绑定此按键')
    expect(fireEvent.keyDown(button, { code: 'Escape', key: 'Escape' })).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(row.queryByText('按下新按键')).not.toBeInTheDocument()
    expect(button).toHaveTextContent('D')
    expect(fireEvent.keyDown(button, { code: 'Escape', key: 'Escape', repeat: true })).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('warns about a conflict in the edited row and transfers only the confirmed key', async () => {
    const { session } = mount()
    generalPage('快捷键')
    const row = shortcutRow('开关弹幕')
    const button = row.getByRole('button', { name: '开关弹幕：修改 D' })
    fireEvent.click(button)
    fireEvent.keyDown(button, { code: 'Comma' })
    expect(row.getByRole('status')).toHaveTextContent(', 已被「回退画面」占用')
    expect(session.settings.shortcuts).toEqual(DEFAULT_SETTINGS.shortcuts)
    fireEvent.click(row.getByRole('button', { name: '取消' }))
    expect(session.settings.shortcuts).toEqual(DEFAULT_SETTINGS.shortcuts)
    expect(row.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.click(button)
    fireEvent.keyDown(button, { code: 'Comma' })
    await act(async () => { fireEvent.click(row.getByRole('button', { name: '替换' })) })
    expect(row.getByRole('button', { name: '开关弹幕：修改 ,' })).toBeInTheDocument()
    expect(shortcutRow('回退画面').getByRole('button', { name: '回退画面：修改 [' })).toBeInTheDocument()
    expect(loadSettings().shortcuts).toMatchObject({ nudgeBack: ['BracketLeft'], toggleDanmaku: ['Comma'] })
  })

  it('clears individual keys, accepts two distinct keys and restores defaults immediately', async () => {
    const { session } = mount()
    await act(async () => session.updateSettings({ largeStepSeconds: 10 }))
    generalPage('快捷键')
    const row = shortcutRow('回退画面')
    await act(async () => { fireEvent.click(row.getByRole('button', { name: '回退画面：清除 ,' })) })
    expect(session.settings.shortcuts.nudgeBack).toEqual(['BracketLeft'])
    await act(async () => { fireEvent.click(row.getByRole('button', { name: '回退画面：清除 [' })) })
    expect(loadSettings().shortcuts.nudgeBack).toEqual([])
    const empty = row.getByRole('button', { name: '回退画面：添加按键（未设置）' })
    expect(empty).toHaveTextContent('未设置')
    fireEvent.click(empty)
    await act(async () => { fireEvent.keyDown(empty, { code: 'KeyJ' }) })
    const add = row.getByRole('button', { name: '回退画面：添加按键' })
    fireEvent.click(add)
    fireEvent.keyDown(add, { code: 'KeyJ' })
    expect(row.getByRole('alert')).toHaveTextContent('此动作已绑定 J')
    await act(async () => { fireEvent.keyDown(add, { code: 'KeyK' }) })
    expect(loadSettings().shortcuts.nudgeBack).toEqual(['KeyJ', 'KeyK'])
    expect(row.queryByRole('button', { name: /添加按键/ })).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '恢复默认' })) })
    expect(loadSettings()).toMatchObject({ shortcuts: DEFAULT_SETTINGS.shortcuts, largeStepSeconds: 10 })
    expect(row.getByRole('button', { name: '回退画面：修改 ,' })).toBeInTheDocument()
  })
})

describe('account logout confirmation', () => {
  it.each([
    ['youtube', 'YouTube'], ['douyin', '抖音'], ['bilibili', '哔哩哔哩'], ['huya', '虎牙'],
  ] as const)('confirms %s logout in place and allows retry after failure', async (id, name) => {
    const signedOut = { douyu: anonymous, youtube: anonymous, douyin: anonymous, bilibili: anonymous, huya: anonymous }
    const loginStatus = vi.spyOn(apiClient, 'loginStatus').mockResolvedValue({ ok: true, value: {
      ...signedOut, [id]: { ...anonymous, loggedIn: true, cookieCount: 1 },
    } })
    vi.spyOn(apiClient, 'getDouyinSendState').mockResolvedValue({ ok: true, value: {
      loggedIn: true, canSend: true, loginState: 'authenticated', message: '已登录',
    } })
    let fail!: () => void
    const logout = vi.spyOn(apiClient, 'logout')
      .mockImplementationOnce(() => new Promise(resolve => {
        fail = () => resolve({ ok: false, code: 'logout-failed', message: '退出失败，请重试' })
      }))
      .mockImplementation(async () => {
        loginStatus.mockResolvedValue({ ok: true, value: signedOut })
        return { ok: true, value: { ok: true } }
      })
    const close = vi.fn()
    mount(null, undefined, close)
    section('账号')
    platform(name)
    const button = (label: string) => screen.getByRole('button', { name: label })
    await waitFor(() => expect(button('退出')).toBeEnabled())

    fireEvent.click(button('退出'))
    expect(logout).not.toHaveBeenCalled()
    expect(button('取消')).toHaveFocus()
    fireEvent.click(button('取消'))
    expect(button('退出')).toHaveFocus()
    fireEvent.click(button('退出'))
    button('重新登录').focus()
    expect(fireEvent.keyDown(button('重新登录'), { key: 'Escape' })).toBe(false)
    expect(button('退出')).toHaveFocus()
    expect(close).not.toHaveBeenCalled()
    expect(logout).not.toHaveBeenCalled()

    fireEvent.click(button('退出'))
    fireEvent.click(button('确认退出'))
    expect(button('确认退出')).toBeDisabled()
    expect(button('取消')).toBeDisabled()
    expect(logout).toHaveBeenCalledExactlyOnceWith(id)
    await act(async () => fail())
    expect(screen.getByRole('alert')).toHaveTextContent('退出失败，请重试')
    expect(button('退出')).toBeEnabled()
    expect(screen.queryByRole('button', { name: '确认退出' })).toBeNull()

    fireEvent.click(button('退出'))
    expect(logout).toHaveBeenCalledTimes(1)
    fireEvent.click(button('确认退出'))
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认退出' })).toBeNull())
    expect(screen.queryByRole('button', { name: '退出' })).toBeNull()
    expect(logout.mock.calls).toEqual([[id], [id]])
    expect(close).not.toHaveBeenCalled()
  })
})

const networkPreferences: NetworkPreferenceState = { domesticRouting: 'direct', systemProxy: { type: 'direct' }, media: { ...DEFAULT_MEDIA_NETWORK } }

async function mountNetwork(onClose: () => void = () => {}): Promise<ReturnType<typeof mount>> {
  vi.spyOn(apiClient, 'getNetworkPreferences').mockResolvedValue({ ok: true, value: networkPreferences })
  const view = mount(null, undefined, onClose)
  generalPage('网络')
  await screen.findByRole('textbox', { name: '来源地址' })
  return view
}

describe('network settings draft', () => {
  it.each([false, true])('hides editable values until the first read with cached state %s completes', async cached => {
    if (cached) remember('network', { ...networkPreferences, media: { ...DEFAULT_MEDIA_NETWORK, routing: 'custom', proxyUrl: 'http://cached.invalid:7890' } })
    let complete!: (result: { ok: true; value: NetworkPreferenceState }) => void
    vi.spyOn(apiClient, 'getNetworkPreferences').mockImplementation(() => new Promise(resolve => { complete = resolve }))
    mount()
    generalPage('网络')
    expect(screen.getByText('正在读取')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '取流连接方式' })).toBeNull()
    expect(screen.queryByRole('switch', { name: /^国内平台直接连接/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '保存取流网络设置' })).toBeNull()
    await act(async () => complete({ ok: true, value: { ...networkPreferences, domesticRouting: 'system', media: { ...DEFAULT_MEDIA_NETWORK, routing: 'custom', proxyUrl: 'socks5://fresh.invalid:1080' } } }))
    expect(screen.getByRole('switch', { name: /^国内平台直接连接/ })).not.toBeChecked()
    expect(screen.getByRole('textbox', { name: '取流代理地址' })).toHaveValue('socks5://fresh.invalid:1080')
    expect(screen.getByRole('button', { name: '保存取流网络设置' })).toBeDisabled()
  })

  it('keeps cached values hidden after a failed read and refreshes them on retry', async () => {
    remember('network', { ...networkPreferences, media: { ...DEFAULT_MEDIA_NETWORK, requestTimeoutMs: 99000 } })
    vi.spyOn(apiClient, 'getNetworkPreferences')
      .mockResolvedValueOnce({ ok: false, code: 'read-failed', message: '读取失败' })
      .mockResolvedValueOnce({ ok: true, value: networkPreferences })
    mount()
    generalPage('网络')
    await screen.findByRole('alert')
    expect(screen.queryByRole('spinbutton', { name: '请求超时秒数' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('spinbutton', { name: '请求超时秒数' })).toHaveValue(0)
  })

  it('saves domestic routing with the rest of the draft only when it differs and reports success in place', async () => {
    const save = vi.spyOn(apiClient, 'setNetworkPreferences').mockResolvedValue({ ok: true, value: { ...networkPreferences, domesticRouting: 'system', media: { ...DEFAULT_MEDIA_NETWORK, requestTimeoutMs: 30000 } } })
    await mountNetwork()
    const button = screen.getByRole('button', { name: '保存取流网络设置' })
    const direct = screen.getByRole('switch', { name: /^国内平台直接连接/ })
    expect(button).toBeDisabled()
    expect(screen.getByRole('button', { name: '放弃改动' })).toBeDisabled()
    fireEvent.click(direct)
    expect(button).toBeEnabled()
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(direct)
    expect(button).toBeDisabled()
    fireEvent.click(direct)
    fireEvent.change(screen.getByRole('spinbutton', { name: '请求超时秒数' }), { target: { value: '30' } })
    fireEvent.click(button)
    expect(await screen.findByText('网络设置已保存')).toBeInTheDocument()
    expect(save).toHaveBeenCalledExactlyOnceWith('system', { ...DEFAULT_MEDIA_NETWORK, requestTimeoutMs: 30000 })
    expect(button).toBeDisabled()
    fireEvent.click(direct)
    expect(screen.queryByText('网络设置已保存')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '放弃改动' }))
    expect(direct).not.toBeChecked()
    expect(button).toBeDisabled()
  })

  it('discards media, added rules and unadded editor content back to the saved state', async () => {
    await mountNetwork()
    fireEvent.click(screen.getByRole('switch', { name: /^国内平台直接连接/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '来源地址' }), { target: { value: 'https://first.invalid' } })
    fireEvent.click(screen.getByRole('button', { name: '加入来源设置' }))
    fireEvent.change(screen.getByRole('textbox', { name: '来源地址' }), { target: { value: 'https://second.invalid' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '请求超时秒数' }), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('button', { name: '放弃改动' }))
    expect(screen.getByRole('switch', { name: /^国内平台直接连接/ })).toBeChecked()
    expect(screen.getByRole('textbox', { name: '来源地址' })).toHaveValue('')
    expect(screen.getByRole('spinbutton', { name: '请求超时秒数' })).toHaveValue(0)
    expect(screen.queryByRole('button', { name: '编辑来源 https://first.invalid' })).toBeNull()
    expect(screen.getByRole('button', { name: '保存取流网络设置' })).toBeDisabled()
  })

  it('includes a valid unadded source in the same save and clears it only on success', async () => {
    const rule = { origin: 'https://media.invalid:8443', headers: { Referer: 'https://media.invalid/' }, verifyTls: false, verifyProxyTls: true }
    const save = vi.spyOn(apiClient, 'setNetworkPreferences').mockResolvedValue({ ok: true, value: { ...networkPreferences, media: { ...DEFAULT_MEDIA_NETWORK, sourceRules: [rule] } } })
    await mountNetwork()
    fireEvent.change(screen.getByRole('textbox', { name: '来源地址' }), { target: { value: rule.origin + '/live' } })
    fireEvent.change(screen.getByRole('textbox', { name: '来源请求头' }), { target: { value: 'Referer: https://media.invalid/' } })
    fireEvent.click(screen.getByRole('switch', { name: '校验该来源服务器证书' }))
    fireEvent.click(screen.getByRole('button', { name: '保存取流网络设置' }))
    await screen.findByText('网络设置已保存')
    expect(save).toHaveBeenCalledExactlyOnceWith('direct', { ...DEFAULT_MEDIA_NETWORK, sourceRules: [rule] })
    expect(screen.getByRole('textbox', { name: '来源地址' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: '来源请求头' })).toHaveValue('')
    expect(screen.getByRole('button', { name: '编辑来源 ' + rule.origin })).toBeInTheDocument()
  })

  it.each([
    { origin: '', headers: 'Referer: https://media.invalid/' },
    { origin: 'file:///synthetic', headers: '' },
    { origin: 'blob:https://media.invalid/synthetic', headers: '' },
    { origin: 'https://media.invalid', headers: 'invalid header' },
    { origin: 'https://media.invalid', headers: 'Referer: first\nreferer: second' },
  ])('stops saving for an invalid unadded source $origin $headers', async ({ origin, headers }) => {
    const save = vi.spyOn(apiClient, 'setNetworkPreferences')
    await mountNetwork()
    fireEvent.change(screen.getByRole('spinbutton', { name: '请求超时秒数' }), { target: { value: '30' } })
    fireEvent.change(screen.getByRole('textbox', { name: '来源地址' }), { target: { value: origin } })
    fireEvent.change(screen.getByRole('textbox', { name: '来源请求头' }), { target: { value: headers } })
    fireEvent.click(screen.getByRole('button', { name: '保存取流网络设置' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请输入有效的 HTTP/HTTPS 来源')
    expect(screen.getByRole('textbox', { name: '来源地址' })).toHaveValue(origin)
    expect(screen.getByRole('textbox', { name: '来源请求头' })).toHaveValue(headers)
    expect(screen.getByRole('spinbutton', { name: '请求超时秒数' })).toHaveValue(30)
    expect(save).not.toHaveBeenCalled()
  })

  it('reports an oversized source collection at the editor without saving', async () => {
    const sourceRules = Array.from({ length: 8 }, (_, index) => ({ origin: `https://source-${index}.invalid`,
      headers: { 'X-Fixture': 'a'.repeat(64000) }, verifyTls: true, verifyProxyTls: true }))
    vi.spyOn(apiClient, 'getNetworkPreferences').mockResolvedValue({ ok: true, value: { ...networkPreferences, media: { ...DEFAULT_MEDIA_NETWORK, sourceRules } } })
    const save = vi.spyOn(apiClient, 'setNetworkPreferences')
    mount()
    generalPage('网络')
    const origin = await screen.findByRole('textbox', { name: '来源地址' })
    fireEvent.change(origin, { target: { value: 'https://incoming.invalid' } })
    fireEvent.change(screen.getByRole('textbox', { name: '来源请求头' }), { target: { value: `X-Fixture: ${'b'.repeat(20000)}` } })
    fireEvent.click(screen.getByRole('button', { name: '保存取流网络设置' }))
    expect(screen.getByRole('alert')).toHaveTextContent('来源设置总大小超出限制')
    expect(origin).toHaveFocus()
    expect(save).not.toHaveBeenCalled()
  })

  it.each(['result', 'rejected'] as const)('keeps the whole draft and editor after a %s save failure and permits retry', async failure => {
    const save = vi.spyOn(apiClient, 'setNetworkPreferences')
    if (failure === 'result') save.mockResolvedValueOnce({ ok: false, code: 'write-failed', message: '网络设置保存失败' })
    else save.mockRejectedValueOnce(new Error('synthetic write failure'))
    await mountNetwork()
    fireEvent.click(screen.getByRole('switch', { name: /^国内平台直接连接/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '来源地址' }), { target: { value: 'https://media.invalid/live' } })
    fireEvent.change(screen.getByRole('textbox', { name: '来源请求头' }), { target: { value: 'Referer: https://media.invalid/' } })
    fireEvent.click(screen.getByRole('button', { name: '保存取流网络设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('网络设置保存失败')
    expect(screen.getByRole('switch', { name: /^国内平台直接连接/ })).not.toBeChecked()
    expect(screen.getByRole('textbox', { name: '来源地址' })).toHaveValue('https://media.invalid/live')
    expect(screen.getByRole('textbox', { name: '来源请求头' })).toHaveValue('Referer: https://media.invalid/')
    expect(screen.getByRole('button', { name: '保存取流网络设置' })).toBeEnabled()
    const media = { ...DEFAULT_MEDIA_NETWORK, sourceRules: [{ origin: 'https://media.invalid', headers: { Referer: 'https://media.invalid/' }, verifyTls: true, verifyProxyTls: true }] }
    save.mockResolvedValueOnce({ ok: true, value: { ...networkPreferences, domesticRouting: 'system', media } })
    fireEvent.click(screen.getByRole('button', { name: '保存取流网络设置' }))
    await screen.findByText('网络设置已保存')
    expect(save).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('treats editing an unchanged saved rule as unchanged even when header or rule order differs', async () => {
    const first = { origin: 'https://first.invalid', headers: { Zebra: 'last', Alpha: 'first' }, verifyTls: true, verifyProxyTls: true }
    const second = { origin: 'https://second.invalid', headers: {}, verifyTls: true, verifyProxyTls: true }
    vi.spyOn(apiClient, 'getNetworkPreferences').mockResolvedValue({ ok: true, value: { ...networkPreferences, media: { ...DEFAULT_MEDIA_NETWORK, sourceRules: [first, second] } } })
    mount()
    generalPage('网络')
    fireEvent.click(await screen.findByRole('button', { name: '编辑来源 ' + first.origin }))
    expect(screen.getByRole('button', { name: '保存取流网络设置' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: '来源请求头' }), { target: { value: 'Alpha: first\nZebra: last' } })
    fireEvent.click(screen.getByRole('button', { name: '加入来源设置' }))
    expect(screen.getByRole('button', { name: '保存取流网络设置' })).toBeDisabled()
    generalPage('对齐')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('removes an edited source without silently adding it back on save', async () => {
    const rule = { origin: 'https://media.invalid', headers: {}, verifyTls: true, verifyProxyTls: true }
    vi.spyOn(apiClient, 'getNetworkPreferences').mockResolvedValue({ ok: true, value: { ...networkPreferences, media: { ...DEFAULT_MEDIA_NETWORK, sourceRules: [rule] } } })
    const save = vi.spyOn(apiClient, 'setNetworkPreferences').mockResolvedValue({ ok: true, value: networkPreferences })
    mount()
    generalPage('网络')
    fireEvent.click(await screen.findByRole('button', { name: '编辑来源 ' + rule.origin }))
    fireEvent.change(screen.getByRole('textbox', { name: '来源地址' }), { target: { value: rule.origin + '/live' } })
    fireEvent.change(screen.getByRole('textbox', { name: '来源请求头' }), { target: { value: 'Referer: synthetic' } })
    fireEvent.click(screen.getByRole('button', { name: '移除来源 ' + rule.origin }))
    expect(screen.getByRole('textbox', { name: '来源地址' })).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '保存取流网络设置' }))
    await screen.findByText('网络设置已保存')
    expect(save).toHaveBeenCalledExactlyOnceWith('direct', { ...DEFAULT_MEDIA_NETWORK, sourceRules: [] })
  })
})

describe('network settings leaving confirmation', () => {
  it('does not retain a stale confirmation when changes are reverted before navigating', async () => {
    await mountNetwork()
    const direct = screen.getByRole('switch', { name: /^国内平台直接连接/ })
    fireEvent.click(direct)
    generalPage('对齐')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    fireEvent.click(direct)
    generalPage('对齐')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    generalPage('网络')
    await screen.findByRole('textbox', { name: '来源地址' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('button', { name: '保存取流网络设置' })).toBeDisabled()
  })

  it.each(['section', 'page', 'close', 'escape', 'native-escape', 'backdrop'] as const)('keeps drafts in place and offers continue or discard for %s', async path => {
    const close = vi.fn()
    await mountNetwork(close)
    fireEvent.change(screen.getByRole('textbox', { name: '来源地址' }), { target: { value: 'https://unadded.invalid' } })
    const dialog = screen.getByRole('dialog', { name: '设置' })
    const navigate = (): void => {
      if (path === 'section') section('画面匹配')
      else if (path === 'page') generalPage('解码')
      else if (path === 'close') fireEvent.click(screen.getByRole('button', { name: '关闭' }))
      else if (path === 'escape') fireEvent.keyDown(screen.getByRole('textbox', { name: '来源地址' }), { key: 'Escape' })
      else {
        const cancel = new Event('cancel', { cancelable: true })
        fireEvent(dialog, cancel)
        expect(cancel.defaultPrevented).toBe(true)
      }
    }
    navigate()
    expect(screen.getByRole('alertdialog', { name: '未保存的网络设置' })).toBeInTheDocument()
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '来源地址' })).toHaveValue('https://unadded.invalid')
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    navigate()
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    await waitFor(() => {
      if (path === 'section') expect(screen.getByRole('tabpanel', { name: '画面匹配' })).toBeInTheDocument()
      else if (path === 'page') expect(screen.getByRole('tabpanel', { name: '解码' })).toBeInTheDocument()
      else expect(close).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('saves the unadded editor and domestic routing before completing a page switch', async () => {
    const rule = { origin: 'https://media.invalid', headers: {}, verifyTls: true, verifyProxyTls: true }
    const save = vi.spyOn(apiClient, 'setNetworkPreferences').mockResolvedValue({ ok: true, value: { ...networkPreferences, domesticRouting: 'system', media: { ...DEFAULT_MEDIA_NETWORK, sourceRules: [rule] } } })
    await mountNetwork()
    fireEvent.click(screen.getByRole('switch', { name: /^国内平台直接连接/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '来源地址' }), { target: { value: rule.origin } })
    generalPage('对齐')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByRole('radiogroup', { name: '单击步长' })
    expect(save).toHaveBeenCalledExactlyOnceWith('system', { ...DEFAULT_MEDIA_NETWORK, sourceRules: [rule] })
  })

  it.each(['invalid-source', 'save-failure'] as const)('keeps editing after %s blocks save-and-close', async failure => {
    const close = vi.fn()
    const save = vi.spyOn(apiClient, 'setNetworkPreferences').mockResolvedValue({ ok: false, code: 'write-failed', message: '网络设置保存失败' })
    await mountNetwork(close)
    const origin = failure === 'invalid-source' ? 'invalid' : 'https://media.invalid'
    fireEvent.change(screen.getByRole('textbox', { name: '来源地址' }), { target: { value: origin } })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByRole('alert')).toHaveTextContent(failure === 'invalid-source' ? '请输入有效的 HTTP/HTTPS 来源' : '网络设置保存失败')
    expect(screen.getByRole('textbox', { name: '来源地址' })).toHaveValue(origin)
    expect(close).not.toHaveBeenCalled()
    if (failure === 'invalid-source') expect(save).not.toHaveBeenCalled()
    else expect(save).toHaveBeenCalledTimes(1)
  })

  it('blocks native close while a save is pending and prevents duplicate saves', async () => {
    const close = vi.fn()
    let complete!: (result: { ok: true; value: NetworkPreferenceState }) => void
    const save = vi.spyOn(apiClient, 'setNetworkPreferences').mockImplementation(() => new Promise(resolve => { complete = resolve }))
    await mountNetwork(close)
    fireEvent.click(screen.getByRole('switch', { name: /^国内平台直接连接/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存取流网络设置' }))
    const cancel = new Event('cancel', { cancelable: true })
    fireEvent(screen.getByRole('dialog', { name: '设置' }), cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(save).toHaveBeenCalledTimes(1)
    await act(async () => complete({ ok: true, value: { ...networkPreferences, domesticRouting: 'system' } }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('closes a clean settings sheet through native cancel without prompting and ignores nested dialogs', async () => {
    const close = vi.fn()
    await mountNetwork(close)
    const dialog = screen.getByRole('dialog', { name: '设置' })
    const nested = document.createElement('dialog')
    dialog.append(nested)
    fireEvent(nested, new Event('cancel', { bubbles: true, cancelable: true }))
    expect(close).not.toHaveBeenCalled()
    nested.remove()
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(close).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('settings account navigation', () => {
  it('lists the normal step first and updates the large and Shift step settings under their matching labels', async () => {
    const { session } = mount()
    const normal = screen.getByRole('radiogroup', { name: '单击步长' })
    const fine = screen.getByRole('radiogroup', { name: '按住 Shift 步长' })
    expect(normal.compareDocumentPosition(fine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(normal).getByRole('radio', { name: `${session.settings.largeStepSeconds} 秒` })).toBeChecked()
    expect(within(fine).getByRole('radio', { name: `${session.settings.smallStepSeconds} 秒` })).toBeChecked()
    fireEvent.click(within(normal).getByRole('radio', { name: '10 秒' }))
    expect(session.settings.largeStepSeconds).toBe(10)
    await waitFor(() => expect(within(normal).getByRole('radio', { name: '10 秒' })).toBeChecked())
    fireEvent.click(within(fine).getByRole('radio', { name: '0.25 秒' }))
    expect(session.settings.smallStepSeconds).toBe(0.25)
    expect(session.settings.largeStepSeconds).toBe(10)
    expect(screen.queryByText('长按或 Shift 步长')).toBeNull()
  })

  it.each(['failure', 'rejected'] as const)('distinguishes a YouTube status %s from loading or logged out and retries in place', async (failure) => {
    const read = vi.spyOn(apiClient, 'loginStatus')
    if (failure === 'failure') read.mockResolvedValueOnce({ ok: false, code: 'unavailable', message: '账号读取失败' })
    else read.mockRejectedValueOnce(new Error('read failed'))
    mount()
    section('账号')
    platform('YouTube')
    expect(screen.getByText('正在检查登录状态')).toBeInTheDocument()
    expect(await screen.findByText('登录状态读取失败')).toBeInTheDocument()
    expect(screen.queryByText('正在检查登录状态')).toBeNull()
    expect(screen.queryByText('未登录')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('未登录')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.each([
    { page: '网络', method: 'getNetworkPreferences' as const, loading: '正在读取', control: '保存取流网络设置',
      value: { domesticRouting: 'direct', systemProxy: { type: 'direct' }, media: { ...DEFAULT_MEDIA_NETWORK } } },
    { page: '解码', method: 'getDecoderPreferences' as const, loading: '正在读取解码设置', control: '软件解码',
      value: { mode: 'auto', effectiveMode: 'auto', restartRequired: false, forcedByCommandLine: false } },
  ].flatMap(item => (['failure', 'rejected'] as const).map(failure => ({ ...item, failure }))))('retries $failure $page settings reads without keeping a loading state', async ({ page, method, loading, control, value, failure }) => {
    const read = vi.spyOn(apiClient, method)
    if (failure === 'rejected') read.mockRejectedValueOnce(new Error('read failed'))
    else read.mockResolvedValueOnce({ ok: false, code: 'unavailable', message: '读取失败' })
    read.mockResolvedValueOnce({ ok: true, value } as never)
    mount()
    fireEvent.click(within(screen.getByRole('tablist', { name: '通用' })).getByRole('tab', { name: page }))
    expect(screen.getByText(loading)).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('读取失败')
    expect(screen.queryByText(loading)).toBeNull()
    if (page === '网络') expect(screen.queryByRole('button', { name: control })).toBeNull()
    else expect(screen.getByRole('switch', { name: new RegExp('^' + control) })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: page === '网络' ? /^国内平台直接连接/ : new RegExp('^' + control) })).toBeEnabled())
    if (page === '网络') expect(screen.getByRole('button', { name: control })).toBeDisabled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('edits origin-bound headers and certificate trust without showing header values in the rule list', async () => {
    invoke.mockImplementationOnce(async () => ({ ok: true, value: { domesticRouting: 'direct', systemProxy: { type: 'direct' }, media: { ...DEFAULT_MEDIA_NETWORK } } }))
    mount()
    fireEvent.click(within(screen.getByRole('tablist', { name: '通用' })).getByRole('tab', { name: '网络' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '来源地址' })).toBeEnabled())
    fireEvent.change(screen.getByRole('textbox', { name: '来源地址' }), { target: { value: 'https://media.invalid:8443/live' } })
    fireEvent.change(screen.getByRole('textbox', { name: '来源请求头' }), { target: { value: 'Authorization: Bearer synthetic\nReferer: https://media.invalid/' } })
    fireEvent.click(screen.getByRole('switch', { name: '校验该来源服务器证书' }))
    fireEvent.click(screen.getByRole('button', { name: '加入来源设置' }))
    expect(screen.getByRole('textbox', { name: '来源请求头' })).toHaveValue('')
    expect(screen.queryByText('Bearer synthetic')).toBeNull()
    fireEvent.change(screen.getByRole('spinbutton', { name: '同屏直播数量上限' }), { target: { value: '300' } })
    const rule = { origin: 'https://media.invalid:8443', headers: { Authorization: 'Bearer synthetic', Referer: 'https://media.invalid/' }, verifyTls: false, verifyProxyTls: true }
    invoke.mockImplementationOnce(async () => ({ ok: true, value: { domesticRouting: 'direct', systemProxy: { type: 'direct' }, media: { ...DEFAULT_MEDIA_NETWORK, sourceRules: [rule], maxExtraStreams: 300 } } }))
    fireEvent.click(screen.getByRole('button', { name: '保存取流网络设置' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('setNetworkPreferences', expect.objectContaining({ media: expect.objectContaining({ sourceRules: [rule], maxExtraStreams: 300 }) })))
  })
  it('shows open playback defaults and saves route, certificate and wait settings explicitly', async () => {
    invoke.mockImplementationOnce(async () => ({ ok: true, value: { domesticRouting: 'direct', systemProxy: { type: 'direct' }, media: { ...DEFAULT_MEDIA_NETWORK } } }))
    mount()
    fireEvent.click(within(screen.getByRole('tablist', { name: '通用' })).getByRole('tab', { name: '网络' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: '取流连接方式' })).toBeEnabled())
    expect(screen.getByRole('switch', { name: '校验取流服务器证书' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: '校验 HTTPS 代理证书' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: '允许媒体访问本机和局域网' })).toBeChecked()
    expect(screen.getByRole('spinbutton', { name: '请求超时秒数' })).toHaveValue(0)
    fireEvent.change(screen.getByRole('combobox', { name: '取流连接方式' }), { target: { value: 'custom' } })
    fireEvent.change(screen.getByRole('textbox', { name: '取流代理地址' }), { target: { value: 'socks5://127.0.0.1:1080' } })
    fireEvent.click(screen.getByRole('switch', { name: '校验取流服务器证书' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: '请求超时秒数' }), { target: { value: '30' } })
    const media = { ...DEFAULT_MEDIA_NETWORK, routing: 'custom', proxyUrl: 'socks5://127.0.0.1:1080', verifyTls: true, requestTimeoutMs: 30000 }
    invoke.mockImplementationOnce(async () => ({ ok: true, value: { domesticRouting: 'direct', systemProxy: { type: 'direct' }, media } }))
    fireEvent.click(screen.getByRole('button', { name: '保存取流网络设置' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('setNetworkPreferences', { domesticRouting: 'direct', media }))
  })
  it('toggles the optional recognition panel without changing recognition mode or running sync', async () => {
    const { session } = mount()
    const sync = vi.spyOn(session, 'syncNow')
    const toggle = screen.getByRole('switch', { name: /^显示基础识别面板/ })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(session.settings).toMatchObject({ basicRecognitionPanelVisible: true, recognitionMode: 'basic' })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(session.settings.recognitionMode).toBe('basic')
    expect(sync).not.toHaveBeenCalled()
  })
  it('puts five platforms in 账号 and nests Douyu pages within the same sidebar', async () => {
    mount()
    const sections = screen.getByRole('tablist', { name: '设置分区' })
    expect(within(sections).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['通用', '账号', '弹幕记录', '房间数据', '画面匹配'])
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
    expect(screen.queryByText('弹幕记录仅支持斗鱼')).toBeNull()
  })
})
