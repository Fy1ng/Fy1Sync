/**
 * Extra streams: one stable video per id, closing disposes it, the add form sends what was
 * typed, and seek keys on a focused window do not reach the player's own shortcuts.
 * Mounted under StrictMode, which runs every effect's cleanup once before running it again.
 */

import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { FeatureEvent } from '../../../electron/featureContracts'
import type { StreamSessionView, StreamSessionsSnapshot } from '../../../electron/streamSessions'
import { ExtraStreams, openInputFor } from './ExtraStreams'
import { MAX_ENTRIES, boundLayout, clampRect, pruneLayout, readLayout, resizedRect, writeLayout } from './layout'

const fakes = vi.hoisted(() => ({ created: [] as FakeMediaShape[] }))
interface FakeMediaShape {
  id: string
  video: HTMLVideoElement
  disposed: boolean
  load: ReturnType<typeof vi.fn>
  controls: { seekBy: ReturnType<typeof vi.fn>; returnToLive: ReturnType<typeof vi.fn>; toggleNativePip: ReturnType<typeof vi.fn> }
}

vi.mock('../../media/independentMedia', () => ({
  IndependentMedia: class {
    readonly video: HTMLVideoElement
    disposed = false
    load = vi.fn(async () => {})
    controls = {
      seekBy: vi.fn(async () => ({ ok: true, target: 0, clamped: true, reason: null })),
      returnToLive: vi.fn(async () => ({ ok: true, target: 10, clamped: false, reason: null })),
      toggleNativePip: vi.fn(async () => ({ ok: false, active: false, reason: 'unsupported' })),
    }
    constructor(readonly id: string) {
      this.video = document.createElement('video')
      this.video.dataset.streamId = id
      this.video.muted = true
      fakes.created.push(this as unknown as FakeMediaShape)
    }
    mount(container: HTMLElement | null): void {
      if (this.disposed || !container) { this.video.remove(); return }
      if (this.video.parentElement !== container) container.appendChild(this.video)
    }
    dispose(): void { this.disposed = true; this.video.remove() }
  },
}))

const ID = `stream-${'a'.repeat(32)}`
const ID_2 = `stream-${'b'.repeat(32)}`

function view(id: string, patch: Partial<StreamSessionView> = {}): StreamSessionView {
  return {
    id: id as StreamSessionView['id'],
    input: '6979222',
    phase: 'ready',
    stream: {
      platform: 'douyu', url: `/media/${id}.m3u8`, kind: 'hls', label: '斗鱼 6979222', channel: '6979222', requiresProxy: false,
      qualities: [{ id: 'origin', label: '原画' }, { id: 'hd', label: '超清' }], quality: 'origin',
    },
    buffer: null,
    error: null,
    ...patch,
  }
}

let listeners: Array<(event: FeatureEvent) => void>
let sessions: StreamSessionView[]
let invoke: ReturnType<typeof vi.fn>

const snapshot = (): StreamSessionsSnapshot => ({ maxExtraStreams: 16, sessions: structuredClone(sessions) })
const push = (data: StreamSessionsSnapshot): void => act(() => { for (const listener of listeners) listener({ topic: 'streams', data }) })
const flush = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

beforeEach(() => {
  fakes.created.length = 0
  listeners = []
  sessions = [view(ID)]
  invoke = vi.fn(async (method: string, args: unknown) => {
    switch (method) {
      case 'getStreamSessions': return { ok: true, value: snapshot() }
      case 'getEnhancedPip': return { ok: true, value: { phase: 'closed', streamId: null } }
      case 'closeStreamSession': {
        sessions = sessions.filter((item) => item.id !== (args as { id: string }).id)
        return { ok: true, value: snapshot() }
      }
      case 'openStreamSession': {
        const opened = view(ID_2, { input: (args as { input: string }).input, phase: 'opening', stream: null })
        sessions = [...sessions, opened]
        return { ok: true, value: opened }
      }
      case 'switchStreamSessionQuality': return { ok: true, value: view(ID) }
      default: return { ok: false, code: 'unexpected', message: method }
    }
  })
  vi.stubGlobal('streamSyncer', {
    invoke: invoke as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
    subscribeFeatures: (listener: (event: FeatureEvent) => void) => {
      listeners.push(listener)
      return () => { listeners = listeners.filter((item) => item !== listener) }
    },
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderStreams(adding = false, onAddingChange = vi.fn()) {
  const tree = (open: boolean) => (
    <StrictMode><div className="studio"><ExtraStreams adding={open} onAddingChange={onAddingChange} /></div></StrictMode>
  )
  const utils = render(tree(adding))
  return { ...utils, onAddingChange, rerenderWith: (open: boolean) => utils.rerender(tree(open)) }
}

const windowFor = (id: string): HTMLElement => document.querySelector<HTMLElement>(`.xs-window[data-stream-id="${id}"]`)!

describe('extra stream windows', () => {
  it('keeps exactly one video per id through StrictMode, snapshots and re-renders', async () => {
    const { rerenderWith } = renderStreams()
    await flush()
    const videos = document.querySelectorAll(`video[data-stream-id="${ID}"]`)
    expect(videos).toHaveLength(1)
    const first = videos[0]
    expect(fakes.created).toHaveLength(1)
    expect(fakes.created[0]!.load).toHaveBeenCalledTimes(1)

    // A buffer report is a new snapshot with the same source; it must not reload or rebuild.
    push({ maxExtraStreams: 16, sessions: [view(ID, { buffer: { role: ID as never, state: 'ready', seconds: 3 } })] })
    rerenderWith(true)
    rerenderWith(false)
    fireEvent.pointerDown(windowFor(ID))
    await flush()
    expect(document.querySelector(`video[data-stream-id="${ID}"]`)).toBe(first)
    expect(fakes.created).toHaveLength(1)
    expect(fakes.created[0]!.load).toHaveBeenCalledTimes(1)
    expect(windowFor(ID)).toHaveClass('is-selected')
  })

  it('ignores an initial read that answers after a newer push', async () => {
    let answer: (value: unknown) => void = () => {}
    invoke.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    renderStreams()
    push({ maxExtraStreams: 16, sessions: [view(ID_2)] })
    answer({ ok: true, value: { maxExtraStreams: 16, sessions: [view(ID)] } })
    await flush()
    expect(windowFor(ID_2)).not.toBeNull()
    expect(windowFor(ID)).toBeNull()
  })

  it('closes through the backend and disposes that video', async () => {
    renderStreams()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await flush()
    expect(invoke).toHaveBeenCalledWith('closeStreamSession', { id: ID })
    expect(fakes.created[0]!.disposed).toBe(true)
    expect(windowFor(ID)).toBeNull()
  })

  it('disposes a video whose stream left the snapshot, and every video on unmount', async () => {
    sessions = [view(ID), view(ID_2)]
    const { unmount } = renderStreams()
    await flush()
    push({ maxExtraStreams: 16, sessions: [view(ID_2)] })
    await flush()
    expect(fakes.created.find((media) => media.id === ID)!.disposed).toBe(true)
    expect(fakes.created.find((media) => media.id === ID_2)!.disposed).toBe(false)
    unmount()
    await flush()
    expect(fakes.created.every((media) => media.disposed)).toBe(true)
    expect(listeners).toHaveLength(0)
  })

  it('seeks on arrow keys and keeps them from the player shortcuts', async () => {
    renderStreams()
    await flush()
    const seen: boolean[] = []
    const onWindowKey = (event: KeyboardEvent): void => { seen.push(event.defaultPrevented) }
    window.addEventListener('keydown', onWindowKey)
    const node = windowFor(ID)
    node.focus()
    expect(fireEvent.keyDown(node, { key: 'ArrowLeft', code: 'ArrowLeft' })).toBe(false)
    expect(fireEvent.keyDown(node, { key: 'ArrowRight', code: 'ArrowRight' })).toBe(false)
    window.removeEventListener('keydown', onWindowKey)
    expect(seen).toEqual([true, true])
    const controls = fakes.created[0]!.controls
    expect(controls.seekBy.mock.calls).toEqual([[-5], [5]])
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已到最新位置'))

    // The volume slider keeps its own arrows.
    expect(fireEvent.keyDown(screen.getByLabelText('音量'), { key: 'ArrowLeft' })).toBe(true)
    expect(controls.seekBy).toHaveBeenCalledTimes(2)
  })

  it('reports why the system picture-in-picture did not open', async () => {
    renderStreams()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '系统画中画' }))
    expect(fakes.created[0]!.controls.toggleNativePip).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前环境不支持系统画中画'))
  })

  it('switches quality and opens the enhanced window for this stream', async () => {
    renderStreams()
    await flush()
    fireEvent.change(screen.getByLabelText('画质'), { target: { value: 'hd' } })
    await flush()
    expect(invoke).toHaveBeenCalledWith('switchStreamSessionQuality', { id: ID, quality: 'hd' })
    fireEvent.click(screen.getByRole('button', { name: '增强' }))
    await flush()
    expect(invoke).toHaveBeenCalledWith('openEnhancedPip', { id: ID })
  })

  it('starts muted and unmutes from its own button', async () => {
    renderStreams()
    await flush()
    const video = fakes.created[0]!.video
    expect(video.muted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消静音' }))
    expect(video.muted).toBe(false)
    expect(screen.getByRole('button', { name: '静音' })).toBeInTheDocument()
  })

  it('shows the failure and retries through the backend', async () => {
    sessions = [view(ID, { phase: 'failed', stream: null, error: '直播间未开播' })]
    renderStreams()
    await flush()
    expect(screen.getByText('直播间未开播')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    await flush()
    expect(invoke).toHaveBeenCalledWith('restartStreamSession', { id: ID })
  })
})

describe('the add form', () => {
  it('opens the typed room with the chosen platform and closes', async () => {
    const { onAddingChange } = renderStreams(true)
    await flush()
    const field = screen.getByLabelText('直播间房间号或链接')
    fireEvent.change(field, { target: { value: '6979222' } })
    fireEvent.click(screen.getByRole('radio', { name: '哔哩哔哩' }))
    fireEvent.submit(field.closest('form')!)
    await flush()
    expect(invoke).toHaveBeenCalledWith('openStreamSession', { input: '6979222', platform: 'bilibili' })
    expect(onAddingChange).toHaveBeenCalledWith(false)
    expect(windowFor(ID_2)).not.toBeNull()
  })

  it('shows the backend refusal and stays open', async () => {
    invoke.mockImplementation(async (method: string) => method === 'openStreamSession'
      ? { ok: false, code: 'stream-limit', message: '已达到当前直播会话资源上限' }
      : { ok: true, value: method === 'getStreamSessions' ? snapshot() : { phase: 'closed', streamId: null } })
    const { onAddingChange } = renderStreams(true)
    await flush()
    const field = screen.getByLabelText('直播间房间号或链接')
    fireEvent.change(field, { target: { value: 'https://www.twitch.tv/abc' } })
    fireEvent.submit(field.closest('form')!)
    await flush()
    expect(invoke).toHaveBeenCalledWith('openStreamSession', { input: 'https://www.twitch.tv/abc' })
    expect(screen.getByRole('alert')).toHaveTextContent('已达到当前直播会话资源上限')
    expect(onAddingChange).not.toHaveBeenCalledWith(false)
  })

  it('closes on Escape', async () => {
    const { onAddingChange } = renderStreams(true)
    await flush()
    fireEvent.keyDown(screen.getByLabelText('直播间房间号或链接'), { key: 'Escape' })
    expect(onAddingChange).toHaveBeenCalledWith(false)
  })

  it('reads a prefixed room and leaves links to the backend', () => {
    expect(openInputFor('b 21452505', 'douyu')).toEqual({ input: '21452505', platform: 'bilibili' })
    expect(openInputFor(' 9999 ', 'douyu')).toEqual({ input: '9999', platform: 'douyu' })
    expect(openInputFor(' https://www.youtube.com/watch?v=x ', 'douyu')).toEqual({ input: 'https://www.youtube.com/watch?v=x' })
  })
})

describe('window layout', () => {
  it('keeps windows inside the theater and above the minimum size', () => {
    const bounds = { w: 800, h: 450 }
    expect(clampRect({ x: 700, y: -20, w: 300, h: 200 }, bounds)).toEqual({ x: 500, y: 0, w: 300, h: 200 })
    expect(resizedRect({ x: 600, y: 300, w: 200, h: 150 }, 500, 500, bounds)).toEqual({ x: 580, y: 290, w: 220, h: 160 })
    expect(resizedRect({ x: 10, y: 10, w: 300, h: 200 }, -500, -500, bounds)).toMatchObject({ w: 220, h: 160 })
  })

  it('stores a bounded set and drops closed streams', () => {
    const layout = Object.fromEntries(Array.from({ length: MAX_ENTRIES + 5 }, (_, index) =>
      [`stream-${index.toString(16).padStart(32, '0')}`, { x: index, y: 0, w: 300, h: 200 }]))
    expect(Object.keys(boundLayout(layout))).toHaveLength(MAX_ENTRIES)
    writeLayout(layout)
    expect(Object.keys(readLayout())).toHaveLength(MAX_ENTRIES)
    const kept = pruneLayout({ [ID]: { x: 0, y: 0, w: 300, h: 200 }, [ID_2]: { x: 0, y: 0, w: 300, h: 200 } }, new Set([ID]))
    expect(Object.keys(kept)).toEqual([ID])
  })
})
