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
  it('registers pasted remote media and loads only the returned opaque URL', async () => {
    const panel = within(openDialog())
    fireEvent.change(panel.getByLabelText('直播间或媒体地址'), {
      target: { value: 'https://cdn.example.com/live/index.m3u8' },
    })
    fireEvent.click(panel.getByRole('button', { name: '加载' }))
    await waitFor(() => expect(session.engine.getState().official.descriptor?.url).toBe('app://app/media/registered-id'))
    await waitFor(() => expect(panel.getByRole('button', { name: '加载' })).toBeEnabled())
    expect(bridge.invoke).toHaveBeenCalledWith('resolve', {
      input: 'https://cdn.example.com/live/index.m3u8', platform: 'direct',
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
    expect(bridge.invoke).not.toHaveBeenCalled()
  })
})
