import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { Studio } from './Studio'

const sessions: Session[] = []

beforeEach(() => {
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'getToolsStatus') return { ok: true, value: { tools: [], fixturesAvailable: false } }
      if (method === 'getEmbeddedLogin') return { ok: true, value: null }
      if (method === 'loginStatus') return { ok: true, value: { douyu: { loggedIn: false }, youtube: { loggedIn: false }, bilibili: { loggedIn: false }, huya: { loggedIn: false } } }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
    subscribeEmbeddedLogin: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('frame-matching-only alignment menu and Huya official fallback prompt', () => {
  it('shows only frame-matching description in 对齐选项 without any 基础模式 toggle', async () => {
    const session = new Session()
    sessions.push(session)
    render(<StrictMode><SessionProvider session={session}><Studio /></SessionProvider></StrictMode>)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    fireEvent.click(screen.getByRole('button', { name: '对齐选项' }))
    expect(screen.queryByText('基础模式')).toBeNull()
    expect(screen.getByText(/两路需有相同视角/)).toBeInTheDocument()
  })

  it('prompts to switch to Huya official stream when 1080p YouTube lags and loads Huya on confirm', async () => {
    let clock = 1_000
    let receive!: Parameters<typeof apiClient.subscribeBuffer>[0]
    vi.spyOn(apiClient, 'subscribeBuffer').mockImplementation(listener => { receive = listener; return () => {} })
    vi.spyOn(apiClient, 'feature').mockImplementation((async (method: string) => {
      if (method === 'findHuyaOfficialStream') {
        return {
          ok: true,
          value: {
            room: '825801',
            url: 'https://www.huya.com/825801',
            nickname: '完美世界电竞频道一',
            title: 'NIP vs Liquid PGL新加坡Major2026',
          },
        }
      }
      return { ok: false, code: 'unused', message: 'unused' }
    }) as typeof apiClient.feature)
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        stream: {
          platform: 'huya',
          url: 'app://app/buffer/session/official/huya/index.m3u8',
          kind: 'progressive',
          label: '虎牙 825801',
          channel: '825801',
          sourceRoom: '825801',
          requiresProxy: false,
        },
      },
    })

    const session = new Session({ now: () => clock })
    sessions.push(session)
    render(<StrictMode><SessionProvider session={session}><Studio /></SessionProvider></StrictMode>)
    await act(async () => {
      await session.loadSource('official', {
        kind: 'progressive',
        url: 'app://app/buffer/session/official/yt/index.m3u8',
        input: 'https://www.youtube.com/watch?v=abcdefghijk',
        sourceChannel: 'abcdefghijk',
        label: 'YouTube 直播',
        platform: 'youtube',
        viaProxy: false,
        loop: false,
        sourceQuality: '301',
        sourceQualities: [{ id: '301', label: '1080p60', height: 1080, fps: 60 }],
      })
      session.flush()
    })

    await act(async () => {
      receive({ role: 'official', state: 'ready', seconds: 10 })
      clock += 5_000
      receive({ role: 'official', state: 'reconnecting', seconds: 8 })
      receive({ role: 'official', state: 'ready', seconds: 12 })
      clock += 5_000
      receive({ role: 'official', state: 'stalled', seconds: 10 })
    })

    const banner = await screen.findByRole('status', { name: '切换虎牙官方流提示' })
    expect(banner).toHaveTextContent('当前代理观看较卡，是否切换至虎牙官方流（完美世界电竞频道一）？')
    fireEvent.click(screen.getByRole('button', { name: '切换虎牙官方流' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('https://www.huya.com/825801', 'huya', 'official', undefined, true))
    expect(screen.queryByRole('status', { name: '切换虎牙官方流提示' })).toBeNull()
  })
})
