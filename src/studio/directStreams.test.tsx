import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import type { FeatureEvent, SavedRoom } from '../../electron/featureContracts'
import { apiClient } from '../app/apiClient'
import { LAST_SOURCES_STORAGE_KEY, loadLastSources } from '../app/lastSources'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { primeMediaElement } from '../test/setup'
import { Favorites } from './favorites/Favorites'
import { Intake } from './Intake'
import { resetSavedRooms } from './savedRooms'
import { SourceChip } from './SourceChip'
import { SourceLoaderProvider } from './sources'
import { openInputFor } from './streams/ExtraStreams'
import { streamTitle } from './streams/StreamWindow'

const sessions: Session[] = []
let savedRooms: SavedRoom[] = []
let featureListeners: Set<(event: FeatureEvent) => void>

function makeSession(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  return session
}

function readyOnLoad(session: Session) {
  const load = session.loadSource.bind(session)
  return vi.spyOn(session, 'loadSource').mockImplementation(async (role, descriptor) => {
    await load(role, { ...descriptor, kind: 'progressive' })
    primeMediaElement(session.engine.element(role))
  })
}

beforeEach(() => {
  resetSavedRooms()
  localStorage.removeItem(LAST_SOURCES_STORAGE_KEY)
  savedRooms = []
  featureListeners = new Set()
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      if (method === 'listSavedRooms' || method === 'refreshSavedRooms') {
        return { ok: true, value: structuredClone(savedRooms) }
      }
      if (method === 'saveRoom') {
        const saved: SavedRoom = { ...(args as SavedRoom), id: `saved-${savedRooms.length + 1}`, savedAt: Date.now() }
        savedRooms = [saved, ...savedRooms]
        return { ok: true, value: structuredClone(saved) }
      }
      if (method === 'removeSavedRoom') {
        savedRooms = savedRooms.filter(item => item.id !== (args as { id: string }).id)
        return { ok: true, value: { removed: true } }
      }
      return { ok: true, value: {} }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: vi.fn(() => () => {}),
    subscribeFeatures: (listener: (event: FeatureEvent) => void) => {
      featureListeners.add(listener)
      return () => featureListeners.delete(listener)
    },
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  resetSavedRooms()
  localStorage.removeItem(LAST_SOURCES_STORAGE_KEY)
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pure live stream loading, options, favorites, and manual danmaku', () => {
  it('recognises m3u8/flv in Intake, sends custom name & headers, and remembers custom label in lastSources', async () => {
    const session = makeSession()
    readyOnLoad(session)
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        stream: {
          platform: 'direct',
          kind: 'hls',
          url: 'app://app/buffer/s/official/g/index.m3u8',
          label: '主舞台 FLV',
          channel: 'cdn.example.com',
          requiresProxy: false,
        },
      },
    })

    render(
      <SessionProvider session={session}>
        <SourceLoaderProvider>
          <Intake onClose={() => {}} onSchedule={() => {}} />
          <SourceChip role="official" />
        </SourceLoaderProvider>
      </SessionProvider>,
    )

    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const input = screen.getByLabelText('直播间链接')
    fireEvent.change(input, { target: { value: 'https://cdn.example.com/live/main.flv?token=1' } })
    expect(screen.getByText('已识别纯直播流直链')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '纯流选项' }))
    fireEvent.change(screen.getByLabelText('直链名称'), { target: { value: '主舞台 FLV' } })
    fireEvent.change(screen.getByLabelText('直链 Referer'), { target: { value: 'https://live.example.com/' } })
    fireEvent.change(screen.getByLabelText('直链 User-Agent'), { target: { value: 'Fy1CustomUA/1.0' } })
    fireEvent.change(screen.getByLabelText('直链其他请求头'), { target: { value: 'Origin: https://live.example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(
      'https://cdn.example.com/live/main.flv?token=1',
      'direct',
      'official',
      undefined,
      true,
      {
        label: '主舞台 FLV',
        headers: {
          Referer: 'https://live.example.com/',
          'User-Agent': 'Fy1CustomUA/1.0',
          Origin: 'https://live.example.com',
        },
      },
    ))

    await waitFor(() => expect(screen.getByRole('button', { name: '画面：主舞台 FLV' })).toBeInTheDocument())
    await waitFor(() => expect(loadLastSources().official).toEqual({
      input: 'https://cdn.example.com/live/main.flv?token=1',
      platform: 'direct',
      label: '主舞台 FLV',
      customLabel: true,
    }))
  })

  it('saves a loaded direct stream with headers from SourceChip and manually associates Bilibili/Huya/Douyin danmaku', async () => {
    const session = makeSession()
    readyOnLoad(session)
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        stream: {
          platform: 'direct',
          kind: 'hls',
          url: 'app://app/buffer/s/commentary/g/index.m3u8',
          label: '二路纯流',
          channel: 'stream.example.com',
          requiresProxy: false,
        },
      },
    })

    render(
      <SessionProvider session={session}>
        <SourceLoaderProvider>
          <SourceChip role="commentary" />
        </SourceLoaderProvider>
      </SessionProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '解说：未载入' }))
    fireEvent.change(screen.getByRole('textbox', { name: '解说链接' }), {
      target: { value: 'https://stream.example.com/live/cast.m3u8' },
    })
    fireEvent.click(screen.getByRole('button', { name: '纯流选项' }))
    fireEvent.change(screen.getByLabelText('直链名称'), { target: { value: '二路纯流' } })
    fireEvent.change(screen.getByLabelText('直链 Referer'), { target: { value: 'https://stream.example.com/' } })
    fireEvent.click(screen.getByRole('button', { name: '载入' }))

    const chip = await screen.findByRole('button', { name: '解说：二路纯流' })
    fireEvent.click(chip)

    // Save direct stream to favorites with headers
    fireEvent.click(await screen.findByRole('button', { name: '收藏' }))
    await waitFor(() => expect(savedRooms).toHaveLength(1))
    expect(savedRooms[0]).toMatchObject({
      role: 'commentary',
      platform: 'direct',
      input: 'https://stream.example.com/live/cast.m3u8',
      label: '二路纯流',
      headers: { Referer: 'https://stream.example.com/' },
    })

    // Associate Bilibili danmaku room manually while playing direct stream
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    const danmakuInput = screen.getByLabelText('弹幕房间号')
    fireEvent.change(danmakuInput, { target: { value: '21470454' } })
    fireEvent.click(screen.getByRole('radio', { name: '哔哩哔哩' }))
    fireEvent.submit(danmakuInput.closest('form')!)

    await waitFor(() => expect(session.snapshot.danmaku.room).toBe('bilibili:21470454'))
    expect(session.hasManualDanmakuRoom()).toBe(true)
  })

  it('adds and loads direct streams in Favorites without exposing secret header values', async () => {
    const session = makeSession()
    readyOnLoad(session)
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        stream: {
          platform: 'direct',
          kind: 'hls',
          url: 'app://app/buffer/s/official/g/index.m3u8',
          label: '副舞台 HLS',
          channel: 'hls.example.com',
          requiresProxy: false,
        },
      },
    })
    const onClose = vi.fn()

    render(
      <SessionProvider session={session}>
        <SourceLoaderProvider>
          <Favorites onClose={onClose} />
        </SourceLoaderProvider>
      </SessionProvider>,
    )

    await screen.findByText(/还没有收藏/)
    fireEvent.change(screen.getByLabelText('收藏平台'), { target: { value: 'direct' } })
    fireEvent.change(screen.getByLabelText('收藏直播间链接或房间号'), {
      target: { value: 'https://hls.example.com/2026/sub.m3u8' },
    })
    fireEvent.click(screen.getByRole('button', { name: '纯流选项' }))
    fireEvent.change(screen.getByLabelText('直链名称'), { target: { value: '副舞台 HLS' } })
    fireEvent.change(screen.getByLabelText('直链其他请求头'), { target: { value: 'Authorization: Bearer secret-fav-token' } })
    fireEvent.click(screen.getByRole('button', { name: '收藏房间' }))

    await screen.findByText('副舞台 HLS')
    expect(screen.getByText('直链片源')).toBeInTheDocument()
    expect(screen.getByText('附带 1 项请求头')).toBeInTheDocument()
    expect(screen.queryByText(/secret-fav-token/)).toBeNull()
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '载入画面' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(
      'https://hls.example.com/2026/sub.m3u8',
      'direct',
      'official',
      undefined,
      true,
      { label: '副舞台 HLS', headers: { Authorization: 'Bearer secret-fav-token' } },
    ))
    expect(onClose).toHaveBeenCalled()
  })

  it('normalises extra-stream direct inputs and displays custom direct labels instead of path numbers', () => {
    expect(openInputFor('cdn.example.com/2026/live.flv', 'douyu')).toEqual({
      input: 'https://cdn.example.com/2026/live.flv',
      platform: 'direct',
    })
    expect(openInputFor('https://cdn.example.com/2026/live.m3u8', 'douyu', { label: '同屏副舞台' })).toEqual({
      input: 'https://cdn.example.com/2026/live.m3u8',
      platform: 'direct',
      direct: { label: '同屏副舞台' },
    })
    expect(streamTitle({
      id: `stream-${'c'.repeat(32)}`,
      input: 'https://cdn.example.com/2026/live.m3u8',
      phase: 'ready',
      stream: {
        platform: 'direct',
        url: 'app://app/buffer/s/x/g/index.m3u8',
        kind: 'hls',
        label: '同屏副舞台',
        channel: 'cdn.example.com',
        requiresProxy: false,
      },
      buffer: null,
      error: null,
    })).toEqual({ platform: '直链', room: '同屏副舞台' })
  })
})
