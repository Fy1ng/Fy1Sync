/** Verify the renderer cannot bypass main's remote media registration path. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { Session } from '../app/session'
import { apiClient } from '../app/apiClient'
import { SessionProvider } from '../app/SessionContext'
import { SourceDialog } from './SourceDialog'

let session: Session
let bridge: StreamSyncerBridge

beforeEach(() => {
  session = new Session({ createSampler: () => null })
  const empty = { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false }
  vi.spyOn(apiClient, 'listDouyuAccounts').mockResolvedValue({ ok: true, value: {
    activeAccountId: 'default', accounts: [{ id: 'default', label: '默认账号', active: true, busy: false, login: empty }],
  } })
  vi.spyOn(apiClient, 'getDouyuTasks').mockResolvedValue({ ok: true, value: {
    activeAccountId: 'default', currentRoom: null, retainedRooms: [], tasks: [],
    runtime: { foreground: true, locked: false, suspended: false },
  } })
  vi.spyOn(apiClient, 'subscribeDouyuTasks').mockReturnValue(() => {})
  bridge = {
    invoke: vi.fn(async () => ({
      ok: true,
      value: {
        ok: true,
        stream: {
          platform: 'direct', channel: '', kind: 'hls', label: '远程片源',
          url: 'app://app/media/registered-id', requiresProxy: false,
        },
      },
    })) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  }
  vi.stubGlobal('streamSyncer', bridge)
})

afterEach(() => {
  cleanup()
  session.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function openDialog(): HTMLElement {
  const { container } = render(
    <SessionProvider session={session}>
      <SourceDialog onClose={() => {}} />
    </SessionProvider>,
  )
  return container.querySelector<HTMLElement>('.source-panel')!
}

describe('SourceDialog desktop media registration', () => {
  it('offers Douyu account management and defaults new tasks to the session danmaku room', async () => {
    session.connectDanmaku('6657')
    openDialog()
    await screen.findByText('活动账号: 默认账号, 未登录')
    fireEvent.click(screen.getByText(/^直播间签到任务/))
    expect(screen.getByLabelText('签到房间号或地址')).toHaveValue('6657')
    expect(screen.getByRole('button', { name: '登录 YouTube' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '登录斗鱼' })).toBeEnabled()
  })

  it('saves decoder settings without reloading or unloading the current media', async () => {
    await session.loadSource('official', { kind: 'test', url: '/test-sources/official.mp4', input: 'fixture', label: 'fixture', loop: true, viaProxy: false, platform: 'test' })
    const descriptor = session.engine.getState().official.descriptor
    vi.mocked(bridge.invoke).mockClear()
    const load = vi.spyOn(session, 'loadSource')
    const unload = vi.spyOn(session, 'unloadSource')
    vi.mocked(bridge.invoke).mockImplementation(async method => {
      const state = { mode: method === 'setDecoderPreferences' ? 'software' : 'auto', effectiveMode: 'auto', restartRequired: method === 'setDecoderPreferences', forcedByCommandLine: false }
      return { ok: true, value: state } as any
    })
    openDialog()
    const checkbox = screen.getByRole('checkbox', { name: '软件解码兼容模式' })
    await waitFor(() => expect(checkbox).toBeEnabled())
    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox).toBeChecked())
    expect(load).not.toHaveBeenCalled()
    expect(unload).not.toHaveBeenCalled()
    expect(session.engine.getState().official.descriptor).toBe(descriptor)
    expect(bridge.invoke).not.toHaveBeenCalledWith('stopBuffer', expect.anything())
  })
  it.each([false, true])('passes the persisted adaptive preference (%s) through the existing resolve path', async preferAdaptive => {
    session.updateSettings({ preferAdaptive })
    const panel = within(openDialog())
    fireEvent.change(panel.getByLabelText('直播间或媒体地址'), {
      target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' },
    })
    fireEvent.click(panel.getByRole('button', { name: '加载' }))
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith('resolve', {
      input: 'https://www.youtube.com/watch?v=abcdefghijk', platform: 'youtube', role: 'official',
      ...(preferAdaptive ? { preferAdaptive: true } : {}),
    }))
    session.updateSettings({ preferAdaptive: false })
  })

  it('registers pasted remote media and loads only the returned opaque URL', async () => {
    const panel = within(openDialog())
    fireEvent.change(panel.getByLabelText('直播间或媒体地址'), {
      target: { value: 'https://cdn.example.com/live/index.m3u8' },
    })
    fireEvent.click(panel.getByRole('button', { name: '加载' }))
    await waitFor(() => expect(session.engine.getState().official.descriptor?.url).toBe('app://app/media/registered-id'))
    await waitFor(() => expect(panel.getByRole('button', { name: '加载' })).toBeEnabled())
    expect(bridge.invoke).toHaveBeenCalledWith('resolve', {
      input: 'https://cdn.example.com/live/index.m3u8', platform: 'direct', role: 'official',
    })
  })

  it('keeps a rejected registration out of the media engine', async () => {
    vi.mocked(bridge.invoke).mockResolvedValue({ ok: false, code: 'blocked-target', message: '禁止访问内网媒体地址' })
    const panel = within(openDialog())
    fireEvent.change(panel.getByLabelText('直播间或媒体地址'), {
      target: { value: 'https://127.0.0.1/private.mp4' },
    })
    fireEvent.click(panel.getByRole('button', { name: '加载' }))
    expect(await panel.findByRole('alert')).toHaveTextContent('禁止访问内网媒体地址')
    expect(session.engine.getState().official.descriptor).toBeNull()
  })

  it('loads same-origin fixtures without a remote registration', async () => {
    vi.mocked(bridge.invoke).mockResolvedValue({ ok: true, value: { fixturesAvailable: true, tools: [], provider: { version: '不可用' }, update: { phase: 'idle', message: 'fixture' } } } as any)
    const panel = within(openDialog())
    fireEvent.click(await panel.findByRole('button', { name: /测试源 · 官方画面/ }))
    await waitFor(() => expect(session.engine.getState().official.descriptor?.url).toBe('/test-sources/official.mp4'))
    await waitFor(() => expect(panel.queryByRole('button', { name: '处理中…' })).not.toBeInTheDocument())
    expect(bridge.invoke).not.toHaveBeenCalledWith('resolve', expect.anything())
  })

  it('keeps resolver quality choices available after loading a local buffer', async () => {
    vi.mocked(bridge.invoke).mockResolvedValue({ ok: true, value: { ok: true, stream: {
      platform: 'youtube', channel: 'abcdefghijk', label: 'YouTube 直播', kind: 'hls', requiresProxy: false,
      url: 'app://app/buffer/session/official/generation/index.m3u8', quality: '301',
      qualities: [{ id: '308', label: '1440p60', height: 1440, fps: 60, adaptive: true }, { id: '301', label: '1080p60' }, { id: '300', label: '720p60' }],
    } } })
    const panel = within(openDialog())
    fireEvent.change(panel.getByLabelText('直播间或媒体地址'), { target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' } })
    fireEvent.click(panel.getByRole('button', { name: '加载' }))
    expect(await panel.findByRole('combobox', { name: '画质' })).toHaveValue('301')
    expect(panel.getByRole('option', { name: '1440p60' })).toBeInTheDocument()
    expect(session.engine.getState().official.descriptor?.sourceQualities?.[0]?.adaptive).toBe(true)
    expect(panel.getByRole('option', { name: '720p60' })).toBeInTheDocument()
  })

  it('shows account status and prevents duplicate login actions until Chrome closes', async () => {
    let finishLogin!: () => void
    const empty = { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false }
    vi.mocked(bridge.invoke).mockImplementation(async (method) => {
      if (method === 'login') {
        await new Promise<void>((resolve) => { finishLogin = resolve })
        return { ok: true, value: { cookieCount: 1, authKeysPresent: ['SID'] } } as any
      }
      return { ok: true, value: { youtube: empty, douyu: empty } } as any
    })
    openDialog()
    await waitFor(() => expect(screen.getByRole('button', { name: '登录斗鱼' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '登录 YouTube' }))
    expect(screen.getByRole('button', { name: '登录斗鱼' })).toBeDisabled()
    expect(await screen.findByText(/请在打开的 Chrome 窗口中登录/)).toBeInTheDocument()
    finishLogin()
    await waitFor(() => expect(screen.getByRole('button', { name: '登录斗鱼' })).toBeEnabled())
    expect(bridge.invoke).toHaveBeenCalledWith('login', { platform: 'youtube' })
  })
})


it('keeps raw room input for display while carrying the confirmed video room', async () => {
  vi.mocked(bridge.invoke).mockResolvedValue({ ok: true, value: { ok: true, stream: {
    platform: 'douyu', channel: '6979222', sourceRoom: '6979222', danmakuRoom: '6979222', kind: 'hls', label: '斗鱼 6979222',
    url: 'app://app/media/canonical', requiresProxy: false,
  } } })
  const panel = within(openDialog())
  fireEvent.change(panel.getByLabelText('直播间或媒体地址'), { target: { value: '6657' } })
  fireEvent.click(panel.getByRole('button', { name: '加载' }))
  await waitFor(() => expect(session.engine.getState().official.descriptor).toMatchObject({ input: '6657', sourceRoom: '6979222', label: '斗鱼 6979222' }))
})
