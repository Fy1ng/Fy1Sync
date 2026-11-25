import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { notifyLoginStateChanged } from '../core/loginEvents'
import { describeLevels } from '../media/quality'
import { primeMediaElement } from '../test/setup'
import { QualityMenu } from './QualityMenu'
import { Studio } from './Studio'

const sessions: Session[] = []
let douyuLoggedIn = false
let bilibiliLoggedIn = false

function makeSession(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  return session
}

beforeEach(() => {
  douyuLoggedIn = false
  bilibiliLoggedIn = false
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'loginStatus') {
        return {
          ok: true,
          value: {
            douyu: { loggedIn: douyuLoggedIn },
            youtube: { loggedIn: false },
            twitch: { loggedIn: false },
            bilibili: { loggedIn: bilibiliLoggedIn },
            huya: { loggedIn: false },
            douyin: { loggedIn: false },
          },
        }
      }
      if (method === 'getToolsStatus') return { ok: true, value: { tools: [], fixturesAvailable: false } }
      if (method === 'getEmbeddedLogin') return { ok: true, value: null }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('QualityMenu and dock quality feedback', () => {
  it('disables login-gated Douyu and Bilibili options when signed out and unlocks them on sign-in', async () => {
    const session = makeSession()
    const changeSpy = vi.spyOn(session, 'changeSourceQuality').mockResolvedValue(undefined)
    await session.loadSource('official', {
      kind: 'hls',
      url: 'app://app/buffer/official/index.m3u8',
      input: '6829849',
      label: '斗鱼 6829849',
      loop: false,
      viaProxy: false,
      platform: 'douyu',
      sourceQuality: '4',
      sourceQualities: [
        { id: '0', label: '原画1080P60', requiresLogin: true },
        { id: '4', label: '蓝光4M' },
        { id: '3', label: '超清' },
      ],
    })
    await session.loadSource('commentary', {
      kind: 'hls',
      url: 'app://app/buffer/commentary/index.m3u8',
      input: 'https://live.bilibili.com/6',
      label: '哔哩哔哩直播 · 6',
      loop: false,
      viaProxy: false,
      platform: 'bilibili',
      sourceQuality: '250',
      sourceQualities: [
        { id: '10000', label: '原画', requiresLogin: true },
        { id: '400', label: '蓝光', requiresLogin: true },
        { id: '250', label: '超清' },
        { id: '150', label: '高清', requiresLogin: true },
      ],
    })
    session.flush()

    render(<StrictMode><SessionProvider session={session}><div className="studio"><QualityMenu /></div></SessionProvider></StrictMode>)

    fireEvent.click(screen.getByRole('button', { name: '画面清晰度' }))
    const officialDialog = screen.getByRole('dialog', { name: '画面清晰度' })
    const officialItems = within(officialDialog).getAllByRole('menuitemradio')
    expect(officialItems[0]).toBeDisabled()
    expect(officialItems[0]).toHaveTextContent('原画1080P60')
    expect(officialItems[0]).toHaveTextContent('需登录')
    expect(officialItems[1]).toBeEnabled()
    expect(officialItems[2]).toBeEnabled()
    fireEvent.click(officialItems[0]!)
    expect(changeSpy).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '解说清晰度' }))
    const commentaryDialog = screen.getByRole('dialog', { name: '解说清晰度' })
    const commentaryItems = within(commentaryDialog).getAllByRole('menuitemradio')
    expect(commentaryItems.map((item) => (item as HTMLButtonElement).disabled)).toEqual([true, true, false, true])

    douyuLoggedIn = true
    bilibiliLoggedIn = true
    act(() => notifyLoginStateChanged(['douyu', 'bilibili'], 'login'))

    await waitFor(() => {
      const unlocked = within(screen.getByRole('dialog', { name: '画面清晰度' })).getAllByRole('menuitemradio')[0]!
      expect(unlocked).toBeEnabled()
      expect(unlocked).not.toHaveTextContent('需登录')
    })
    const unlockedBilibili = within(screen.getByRole('dialog', { name: '解说清晰度' })).getAllByRole('menuitemradio')
    expect(unlockedBilibili.every((item) => !(item as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(within(screen.getByRole('dialog', { name: '画面清晰度' })).getAllByRole('menuitemradio')[0]!)
    expect(changeSpy).toHaveBeenCalledWith('official', '0')
  })

  it('disables a lone compatible quality and explains why no other option exists', async () => {
    const session = makeSession()
    const changeSpy = vi.spyOn(session, 'changeSourceQuality')
    await session.loadSource('official', {
      kind: 'progressive',
      url: 'app://app/buffer/official/index.m3u8',
      input: 'https://live.douyin.com/12345',
      label: '抖音 / 12345',
      loop: false,
      viaProxy: false,
      platform: 'douyin',
      sourceQuality: 'origin',
      sourceQualities: [{ id: 'origin', label: '原画' }],
    })
    session.flush()

    render(<StrictMode><SessionProvider session={session}><div className="studio"><QualityMenu /></div></SessionProvider></StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: '画面清晰度' }))
    const dialog = screen.getByRole('dialog', { name: '画面清晰度' })
    const onlyItem = within(dialog).getByRole('menuitemradio')
    expect(onlyItem).toBeDisabled()
    expect(onlyItem).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog).getByText('当前直播间仅提供此画质')).toBeInTheDocument()
    fireEvent.click(onlyItem)
    expect(changeSpy).not.toHaveBeenCalled()
  })

  it('omits the phantom menu for single-rendition local HLS buffers and avoids 0 kbps labels', async () => {
    const syntheticLevels = describeLevels([{ bitrate: 1 }])
    expect(syntheticLevels).toEqual([
      { level: -1, label: '自动' },
      { level: 0, label: '未知', detail: undefined },
    ])

    const session = makeSession()
    await session.loadSource('official', {
      kind: 'progressive',
      url: 'app://app/buffer/official/index.m3u8',
      input: 'https://example.invalid/single.m3u8',
      label: '单路直链',
      loop: false,
      viaProxy: false,
      platform: 'direct',
    })
    // Simulate a single-variant hls.js level list (自动 + 1 rendition).
    ;(session.engine as unknown as { state: Record<string, { quality: typeof syntheticLevels }> }).state.official!.quality = syntheticLevels
    session.flush()

    const { container } = render(<StrictMode><SessionProvider session={session}><div className="studio"><QualityMenu /></div></SessionProvider></StrictMode>)
    expect(container.querySelector('.quality-pair')).toBeNull()
  })

  it('keeps the player dock visible while a quality switch is in progress', async () => {
    vi.useFakeTimers()
    const session = makeSession()
    await session.loadSource('official', {
      kind: 'progressive',
      url: 'https://example.test/official.mp4',
      input: 'https://www.huya.com/998',
      label: '虎牙 998',
      loop: false,
      viaProxy: false,
      platform: 'huya',
      sourceQuality: '4000',
      sourceQualities: [{ id: '0', label: '原画' }, { id: '4000', label: '蓝光4M' }],
    })
    primeMediaElement(session.engine.element('official'))
    await session.setPlaying(true)
    session.flush()

    let resolveSwitch!: (value: Awaited<ReturnType<typeof apiClient.switchQuality>>) => void
    vi.spyOn(apiClient, 'switchQuality').mockImplementation(() => new Promise((resolve) => { resolveSwitch = resolve }))

    const { container } = render(<StrictMode><SessionProvider session={session}><Studio /></SessionProvider></StrictMode>)
    const theater = container.querySelector('.theater')!
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(theater).toHaveAttribute('data-chrome', 'off')

    let pending!: Promise<void>
    act(() => {
      pending = session.changeSourceQuality('official', '0')
      session.flush()
    })
    expect(screen.getByRole('button', { name: '画面清晰度' })).toHaveTextContent('切换中')
    expect(theater).toHaveAttribute('data-chrome', 'on')

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(theater).toHaveAttribute('data-chrome', 'on')

    await act(async () => {
      resolveSwitch({
        ok: true,
        value: {
          ok: true,
          stream: {
            platform: 'huya',
            kind: 'progressive',
            url: 'https://example.test/official-next.mp4',
            label: '虎牙 998',
            channel: '998',
            requiresProxy: false,
            quality: '0',
            qualities: [{ id: '0', label: '原画' }, { id: '4000', label: '蓝光4M' }],
          },
        },
      })
      await pending
      session.flush()
    })

    act(() => { vi.advanceTimersByTime(4_000) })
    expect(theater).toHaveAttribute('data-chrome', 'off')
  })
})
