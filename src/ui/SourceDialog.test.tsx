/** Verify the renderer cannot bypass main's remote media registration path. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { SourceDialog } from './SourceDialog'

let session: Session
let bridge: StreamSyncerBridge

beforeEach(() => {
  session = new Session({ createSampler: () => null })
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
    expect(await screen.findByRole('alert')).toHaveTextContent('禁止访问内网媒体地址')
    expect(session.engine.getState().official.descriptor).toBeNull()
  })

  it('loads same-origin fixtures without a remote registration', async () => {
    const panel = within(openDialog())
    fireEvent.click(panel.getByRole('button', { name: /测试源 · 官方画面/ }))
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
    fireEvent.click(screen.getByRole('button', { name: '登录 YouTube' }))
    expect(screen.getByRole('button', { name: '登录斗鱼' })).toBeDisabled()
    expect(await screen.findByText(/请在打开的 Chrome 窗口中登录/)).toBeInTheDocument()
    finishLogin()
    await waitFor(() => expect(screen.getByRole('button', { name: '登录斗鱼' })).toBeEnabled())
    expect(bridge.invoke).toHaveBeenCalledWith('login', { platform: 'youtube' })
  })
})
