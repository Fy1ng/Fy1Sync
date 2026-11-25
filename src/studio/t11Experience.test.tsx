import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BufferState } from '../../electron/bufferManager'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { TWITCH_COMMERCIAL_BREAK_BADGE, TWITCH_COMMERCIAL_BREAK_NOTICE } from '../core/commercialBreak'
import { ComposerProvider } from './composer'
import { DanmakuActionsProvider } from './danmakuActions'
import { DanmakuPanel } from './DanmakuPanel'
import { DanmakuStage } from './DanmakuStage'
import { SourceLoaderProvider } from './sources'
import { Studio } from './Studio'

const sessions: Session[] = []
let nextFrame: FrameRequestCallback | null = null
let bufferListener: ((state: BufferState) => void) | null = null

beforeEach(() => {
  nextFrame = null
  bufferListener = null
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(340)
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => ({
      ok: true,
      value: method === 'listDouyuAccounts'
        ? { activeAccountId: null, accounts: [] }
        : method === 'getDouyuTasks'
          ? { activeAccountId: null, tasks: [] }
          : method === 'getDanmakuFeatures'
            ? { affixes: { enabled: false, prefix: '', suffix: '' }, preferences: { verticalGapPx: 10, duplicateMode: 'all', duplicateWindowSeconds: 8, filterSuspectedBots: false, showUserDetails: false } }
            : method === 'getStreamSessions'
              ? { maxExtraStreams: 4, sessions: [] }
              : method === 'getEnhancedPip'
                ? { phase: 'closed', streamId: null, source: null, options: { lowPower: false, recoverStalls: true }, sendContext: { room: null, accountId: null, canAttempt: false }, recoveryRevision: 0, recoveryAttempts: 0 }
                : method === 'listSavedRooms'
                  ? { rooms: [] }
                  : {},
    })),
    subscribeDanmaku: () => () => {},
    subscribeBuffer: (listener: (state: BufferState) => void) => {
      bufferListener = listener
      return () => { if (bufferListener === listener) bufferListener = null }
    },
    subscribeFeatures: () => () => {},
  } as unknown as StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length) sessions.pop()?.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function createSession() {
  const session = new Session({
    createSampler: () => null,
    storage: { getItem: () => null, setItem() {} },
  })
  sessions.push(session)
  return session
}

describe('custom danmaku max lines', () => {
  it('computes slider ceiling from full stage height, caps rendered lanes, and resets to unlimited on area change', () => {
    const session = createSession()
    session.connectDanmaku('huya:660000')
    session.flush()

    // stageHeight = 340, fontSize = 24, verticalGapPx = 10 -> laneHeight = 34 -> 10 full-stage lines, slider max = 11 (unlimited).
    render(
      <SessionProvider session={session}>
        <SourceLoaderProvider>
          <ComposerProvider>
            <DanmakuActionsProvider onOpenRecords={() => {}}>
              <DanmakuStage onReply={() => {}} />
              <DanmakuPanel onClose={() => {}} />
            </DanmakuActionsProvider>
          </ComposerProvider>
        </SourceLoaderProvider>
      </SessionProvider>,
    )

    const slider = screen.getByRole('slider', { name: '最大行数' }) as HTMLInputElement
    const sliderLabel = slider.closest('label')!
    expect(slider.min).toBe('1')
    expect(slider.max).toBe('11')
    expect(slider.value).toBe('11')
    expect(within(sliderLabel).getByText('不限')).toBeInTheDocument()

    act(() => {
      fireEvent.change(slider, { target: { value: '2' } })
      session.flush()
    })
    expect(session.settings.danmaku.maxLines).toBe(2)
    expect(screen.getByText('2 行')).toBeInTheDocument()

    act(() => {
      for (let i = 1; i <= 5; i += 1) {
        session.pushDanmaku({ text: `弹幕${i}`, user: `u${i}`, color: '#fff', platform: 'huya' })
      }
      nextFrame?.(100)
      session.flush()
    })
    expect(document.querySelectorAll('.danmaku-item')).toHaveLength(2)

    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: '顶部' }))
      session.flush()
    })
    expect(session.settings.danmaku.area).toBe('quarter')
    expect(session.settings.danmaku.maxLines).toBe(0)
    expect((screen.getByRole('slider', { name: '最大行数' }) as HTMLInputElement).value).toBe('11')
  })
})

describe('Twitch commercial break notice in Studio', () => {
  it('shows the approved Chinese notice during a Twitch commercial break, supports single-break dismissal, and marks the preview badge', async () => {
    const session = createSession()
    await act(async () => {
      await session.loadSource('official', {
        kind: 'progressive',
        url: 'app://app/buffer/s/official/g/index.m3u8',
        input: 'https://www.twitch.tv/pgl',
        label: 'Twitch · pgl',
        loop: false,
        viaProxy: false,
        platform: 'twitch',
      })
      await session.loadSource('commentary', {
        kind: 'progressive',
        url: 'app://app/buffer/s/commentary/g/index.m3u8',
        input: '6979222',
        label: '斗鱼 6979222',
        loop: false,
        viaProxy: false,
        platform: 'douyu',
      })
      session.flush()
    })

    render(<SessionProvider session={session}><Studio /></SessionProvider>)
    expect(screen.queryByText(TWITCH_COMMERCIAL_BREAK_NOTICE)).toBeNull()

    act(() => {
      bufferListener?.({
        role: 'official',
        state: 'ready',
        seconds: 10,
        hasVideo: true,
        completeSegments: 5,
        commercialBreak: { live: true, ranges: [[0, 10]] },
      })
      session.flush()
    })
    expect(screen.getByText(TWITCH_COMMERCIAL_BREAK_NOTICE)).toBeInTheDocument()

    // Dismissing hides the current commercial break, and a subsequent break shows again after recovery.
    fireEvent.click(screen.getByRole('button', { name: '关闭广告提示' }))
    expect(screen.queryByText(TWITCH_COMMERCIAL_BREAK_NOTICE)).toBeNull()

    act(() => {
      bufferListener?.({
        role: 'official',
        state: 'ready',
        seconds: 12,
        hasVideo: true,
        completeSegments: 6,
      })
      session.flush()
    })
    act(() => {
      bufferListener?.({
        role: 'official',
        state: 'ready',
        seconds: 14,
        hasVideo: true,
        completeSegments: 7,
        commercialBreak: { live: true, ranges: [[12, 14]] },
      })
      session.flush()
    })
    expect(screen.getByText(TWITCH_COMMERCIAL_BREAK_NOTICE)).toBeInTheDocument()

    // Swapping commentary to main moves Twitch to the secondary preview with its compact badge.
    act(() => {
      session.swapRoles()
      session.flush()
    })
    expect(screen.getByText(TWITCH_COMMERCIAL_BREAK_BADGE)).toBeInTheDocument()
  })

  it('shows commercial break status and notice inside an extra Twitch StreamWindow', async () => {
    const invoke = vi.mocked(window.streamSyncer!.invoke)
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((async (method: string, args: unknown) => {
      if (method === 'getStreamSessions') {
        return {
          ok: true,
          value: {
            maxExtraStreams: 4,
            sessions: [{
              id: 'stream-0123456789abcdef0123456789abcdef',
              input: 'https://www.twitch.tv/eslcs',
              phase: 'ready',
              stream: {
                platform: 'twitch',
                url: 'app://app/buffer/s/extra/g/index.m3u8',
                kind: 'hls',
                label: 'Twitch · eslcs',
                channel: 'eslcs',
                requiresProxy: false,
              },
              buffer: {
                role: 'stream-0123456789abcdef0123456789abcdef',
                state: 'ready',
                seconds: 8,
                hasVideo: true,
                completeSegments: 4,
                commercialBreak: { live: true, ranges: [[0, 8]] },
              },
              error: null,
            }],
          },
        }
      }
      return original(method as never, args as never)
    }) as StreamSyncerBridge['invoke'])

    const session = createSession()
    render(<SessionProvider session={session}><Studio /></SessionProvider>)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const extra = screen.getByRole('group', { name: 'Twitch eslcs' })
    expect(within(extra).getByText('广告时段')).toBeInTheDocument()
    expect(within(extra).getByText(TWITCH_COMMERCIAL_BREAK_NOTICE)).toBeInTheDocument()
  })
})
