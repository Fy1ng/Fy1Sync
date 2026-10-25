/**
 * The studio's own rules: which side a pasted link goes to, how the crossfader splits two
 * volumes, and which way "解说早了 / 解说晚了" moves the offset. Mounted under StrictMode for
 * the same reason the player always has been — the media mounts must survive a remount.
 */

import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { parseRoomInput, roomFromInput, routeFor, sourceTitle } from './sources'
import { Studio } from './Studio'
import { balanceOf, volumesFor } from './transport'

const sessions: Session[] = []

function makeSession(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  return session
}

function renderStudio(session: Session): ReturnType<typeof render> {
  return render(<StrictMode><SessionProvider session={session}><Studio /></SessionProvider></StrictMode>)
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'getToolsStatus') return { ok: true, value: { tools: [], fixturesAvailable: false } }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.unstubAllGlobals()
})

describe('routing a pasted link', () => {
  it('sends match platforms to the picture and Chinese platforms to the voice', () => {
    expect(routeFor('youtube')).toBe('official')
    expect(routeFor('twitch')).toBe('official')
    expect(routeFor('douyu')).toBe('commentary')
    expect(routeFor('bilibili')).toBe('commentary')
  })

  it('leaves links that cannot say to the viewer', () => {
    expect(routeFor('direct')).toBeNull()
    expect(routeFor('file')).toBeNull()
  })
})

describe('typed rooms', () => {
  it('leaves a bare number to the viewer and reads a platform prefix', () => {
    expect(parseRoomInput('6979222')).toEqual({ room: '6979222', platform: null })
    expect(parseRoomInput('b 21452505')).toEqual({ room: '21452505', platform: 'bilibili' })
    expect(parseRoomInput('斗鱼9999')).toEqual({ room: '9999', platform: 'douyu' })
    expect(parseRoomInput('https://www.douyu.com/9999')).toBeNull()
  })

  it('names a room by what was typed, not by the id it resolved to', () => {
    expect(roomFromInput('https://www.douyu.com/9999')).toBe('9999')
    expect(roomFromInput('https://www.douyu.com/topic/xyz?rid=288016')).toBe('288016')
    expect(roomFromInput('https://live.bilibili.com/21452505?spm=1')).toBe('21452505')
    const douyu = { kind: 'hls' as const, url: 'x', input: 'douyu.com/9999', label: '斗鱼 6979222', loop: false, viaProxy: true, platform: 'douyu' as const, sourceRoom: '6979222' }
    expect(sourceTitle(douyu)).toBe('斗鱼 9999')
  })

  it('does not say the platform twice', () => {
    expect(sourceTitle({ kind: 'hls', url: 'x', input: 'https://www.youtube.com/watch?v=a', label: 'YouTube 直播', loop: false, viaProxy: false, platform: 'youtube' }))
      .toBe('YouTube 直播')
  })
})

describe('the balance slider', () => {
  it('plays both at full in the middle and silences the far side at each end', () => {
    expect(volumesFor(0)).toEqual({ official: 1, commentary: 1 })
    expect(volumesFor(1)).toEqual({ official: 0, commentary: 1 })
    expect(volumesFor(-1)).toEqual({ official: 1, commentary: 0 })
    expect(volumesFor(0.25)).toEqual({ official: 0.75, commentary: 1 })
  })

  it('reads back the position it set', () => {
    for (const position of [-1, -0.4, 0, 0.3, 1]) {
      const { official, commentary } = volumesFor(position)
      expect(balanceOf(official, commentary)).toBeCloseTo(position, 2)
    }
  })
})

describe('the studio', () => {
  it('opens on the paste screen when nothing is loaded', async () => {
    renderStudio(makeSession())
    await flush()
    expect(screen.getByRole('dialog', { name: '添加直播间' })).toBeInTheDocument()
    expect(screen.getByLabelText('直播间链接')).toBeInTheDocument()
  })

  it('mounts both media elements and keeps them through a StrictMode remount', async () => {
    const { container } = renderStudio(makeSession())
    await flush()
    const roles = [...container.querySelectorAll('video')].map((video) => video.dataset.role).sort()
    expect(roles).toEqual(['commentary', 'official'])
  })

  it('can be skipped into an empty player, with a way back to adding sources', async () => {
    renderStudio(makeSession())
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    expect(screen.queryByRole('dialog', { name: '添加直播间' })).toBeNull()
    // Nothing to align yet, so the nudges are off rather than silently doing nothing.
    expect(screen.getByRole('button', { name: '解说延后' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '添加直播间' }))
    expect(screen.getByRole('dialog', { name: '添加直播间' })).toBeInTheDocument()
  })

  it('asks which platform a bare room number belongs to', async () => {
    renderStudio(makeSession())
    await flush()
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: '6979222' } })
    fireEvent.submit(field.closest('form')!)
    const ask = screen.getByRole('group', { name: '选择房间号所属平台' })
    expect(ask).toHaveTextContent('6979222')
    expect(screen.getByRole('button', { name: '斗鱼' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '哔哩哔哩' })).toBeInTheDocument()
  })

  it('closes the paste screen on Escape even with nothing loaded', async () => {
    renderStudio(makeSession())
    await flush()
    fireEvent.keyDown(screen.getByLabelText('直播间链接'), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '添加直播间' })).toBeNull()
  })

  it('holds the voice back for 解说延后 and the picture back for 画面延后', async () => {
    const session = makeSession()
    // Both sides present: an offset only means something between two sources.
    for (const role of ['official', 'commentary'] as const) {
      void session.loadSource(role, { kind: 'test', url: `/test-sources/${role}.mp4`, input: role, label: role, loop: true, viaProxy: false, platform: 'test' })
    }
    const apply = vi.spyOn(session, 'applyOffset')
    renderStudio(session)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: '解说延后' }))
    await waitFor(() => expect(apply).toHaveBeenCalled())
    expect(apply.mock.calls.at(-1)![0]).toBeLessThan(0)

    apply.mockClear()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '画面延后' }))
    fireEvent.click(screen.getByRole('button', { name: '画面延后' }))
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2))
    expect(apply.mock.calls.at(-1)![0]).toBeGreaterThan(apply.mock.calls[0]![0] as number)
  })

  it('says which side waits, not a signed number', async () => {
    const session = makeSession()
    renderStudio(session)
    await flush()
    expect(screen.getByRole('button', { name: /未调整/ })).toBeInTheDocument()
  })
})
