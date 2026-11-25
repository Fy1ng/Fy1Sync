/**
 * Extra streams: one stable video per id, closing disposes it, the add form sends what was
 * typed, and seek keys on a focused window do not reach the player's own shortcuts.
 * Mounted under StrictMode, which runs every effect's cleanup once before running it again.
 */

import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { FeatureEvent } from '../../../electron/featureContracts'
import type { StreamSessionView, StreamSessionsSnapshot } from '../../../electron/streamSessions'
import { ExtraStreams, openInputFor } from './ExtraStreams'
import { MAX_ENTRIES, arrangeStreams, boundLayout, clampRect, pruneLayout, readLayout, readLayoutPreference, resizedRect,
  selectLayoutMode, writeLayout, writeLayoutPreference } from './layout'
import type { MediaError } from '../../media/hlsController'

const fakes = vi.hoisted(() => ({ created: [] as FakeMediaShape[] }))
interface FakeMediaShape {
  id: string
  video: HTMLVideoElement
  disposed: boolean
  load: ReturnType<typeof vi.fn>
  emitError: (error: MediaError | null) => void
  controls: { seekBy: ReturnType<typeof vi.fn>; returnToLive: ReturnType<typeof vi.fn>; toggleNativePip: ReturnType<typeof vi.fn> }
}

vi.mock('../../media/independentMedia', () => ({
  IndependentMedia: class {
    readonly video: HTMLVideoElement
    disposed = false
    load = vi.fn(async () => {})
    private readonly errorListeners = new Set<(error: MediaError | null) => void>()
    subscribeErrors(listener: (error: MediaError | null) => void): () => void { this.errorListeners.add(listener); listener(null); return () => { this.errorListeners.delete(listener) } }
    emitError(error: MediaError | null): void { for (const listener of this.errorListeners) listener(error) }
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

  it('switches through all layouts without remounting video or losing the old window position', async () => {
    const legacyKey = 'studio.extraStreams.layout.v1'
    const legacy = JSON.stringify({ [ID]: { x: 35, y: 80, w: 300, h: 200 } })
    localStorage.setItem(legacyKey, legacy)
    const { container } = renderStreams(true)
    await flush()
    const node = windowFor(ID)
    const video = node.querySelector('video')
    const stage = container.querySelector('.streams-stage')
    expect(stage).toHaveAttribute('data-split', 'side-by-side')
    expect(screen.getByRole('radio', { name: '左右分屏' })).toBeChecked()
    expect(node.querySelector('.xs-resize')).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: '上下分屏' }))
    expect(stage).toHaveAttribute('data-split', 'stacked')
    fireEvent.click(screen.getByRole('radio', { name: '自定义' }))
    expect(screen.getByRole('separator', { name: '分屏分隔线' })).toHaveAttribute('aria-orientation', 'horizontal')
    fireEvent.click(screen.getByRole('radio', { name: '悬浮窗' }))
    expect(stage).not.toHaveAttribute('data-split')
    expect(node.querySelector('.xs-resize')).not.toBeNull()
    expect(node).toHaveStyle({ left: '35px', top: '80px', width: '300px', height: '200px' })
    expect(localStorage.getItem(legacyKey)).toBe(legacy)
    expect(windowFor(ID)).toBe(node)
    expect(windowFor(ID).querySelector('video')).toBe(video)
    expect(fakes.created[0]!.load).toHaveBeenCalledTimes(1)
  })

  it('keeps old positions intact when the first session snapshot is empty', async () => {
    const legacyKey = 'studio.extraStreams.layout.v1'
    const legacy = JSON.stringify({ [ID]: { x: 35, y: 80, w: 300, h: 200 } })
    localStorage.setItem(legacyKey, legacy)
    sessions = []
    const { container } = renderStreams(true)
    await flush()
    fireEvent.click(screen.getByRole('radio', { name: '上下分屏' }))
    expect(container.querySelector('.streams-stage')).not.toHaveAttribute('data-split')
    expect(localStorage.getItem(legacyKey)).toBe(legacy)
  })

  it('adjusts and remembers the custom divider within the measured stage', async () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1008)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(608)
    const { unmount } = renderStreams(true)
    await flush()
    fireEvent.click(screen.getByRole('radio', { name: '自定义' }))
    const divider = screen.getByRole('separator', { name: '分屏分隔线' })
    expect(divider).toHaveAttribute('aria-orientation', 'vertical')
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(divider).toHaveAttribute('aria-valuenow', '48')
    fireEvent.keyDown(divider, { key: 'End' })
    expect(divider).toHaveAttribute('aria-valuenow', '78')
    unmount()
    renderStreams(true)
    await flush()
    expect(screen.getByRole('radio', { name: '自定义' })).toBeChecked()
    expect(screen.getByRole('separator', { name: '分屏分隔线' })).toHaveAttribute('aria-valuenow', '78')
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
    fireEvent.click(screen.getByRole('button', { name: '查看原始错误' }))
    expect(screen.getByRole('region', { name: '原始错误信息' })).toHaveTextContent('unsupported')
  })

  it('shows the attachment diagnostic fields and clears the failure on recovery', async () => {
    renderStreams()
    await flush()
    const media = fakes.created[0]!
    act(() => media.emitError({ fatal: true, message: 'HLS 分片失败', detail: { type: 'networkError', details: 'fragLoadError', status: 503, token: 'private-token' } }))
    fireEvent.click(await screen.findByRole('button', { name: '查看原始错误' }))
    const details = screen.getByRole('region', { name: '原始错误信息' })
    expect(JSON.parse(details.querySelector('code')!.textContent!)).toMatchObject({ message: 'HLS 分片失败', detail: { type: 'networkError', details: 'fragLoadError', status: 503, token: '[redacted]' } })
    act(() => media.emitError(null))
    expect(within(windowFor(ID)).queryByRole('button', { name: '查看原始错误' })).toBeNull()
    expect(screen.queryByText('HLS 分片失败')).toBeNull()
  })

  it('switches quality and opens the enhanced window for this stream', async () => {
    renderStreams()
    await flush()
    fireEvent.change(screen.getByLabelText('清晰度'), { target: { value: 'hd' } })
    await flush()
    expect(invoke).toHaveBeenCalledWith('switchStreamSessionQuality', { id: ID, quality: 'hd' })
    fireEvent.click(screen.getByRole('button', { name: '画中画' }))
    await flush()
    expect(invoke).toHaveBeenCalledWith('openEnhancedPip', { id: ID })
  })

  it('disables login-gated qualities in extra stream windows until the platform signs in', async () => {
    let douyuLoggedIn = false
    sessions = [view(ID, {
      stream: {
        platform: 'douyu', url: `/media/${ID}.m3u8`, kind: 'hls', label: '斗鱼 6829849', channel: '6829849', requiresProxy: false,
        qualities: [
          { id: '0', label: '原画1080P60', requiresLogin: true },
          { id: '4', label: '蓝光4M' },
          { id: '3', label: '超清' },
        ],
        quality: '4',
      },
    })]
    invoke.mockImplementation(async (method: string, args: unknown) => {
      if (method === 'getStreamSessions') return { ok: true, value: snapshot() }
      if (method === 'getEnhancedPip') return { ok: true, value: { phase: 'closed', streamId: null } }
      if (method === 'loginStatus') {
        return {
          ok: true,
          value: {
            douyu: { loggedIn: douyuLoggedIn },
            youtube: { loggedIn: false },
            twitch: { loggedIn: false },
            bilibili: { loggedIn: false },
            huya: { loggedIn: false },
            douyin: { loggedIn: false },
          },
        }
      }
      if (method === 'switchStreamSessionQuality') return { ok: true, value: sessions[0] }
      return { ok: false, code: 'unexpected', message: `${method}:${JSON.stringify(args)}` }
    })

    const { notifyLoginStateChanged } = await import('../../core/loginEvents')
    renderStreams()
    await flush()

    const select = screen.getByLabelText('清晰度') as HTMLSelectElement
    const options = within(select).getAllByRole('option') as HTMLOptionElement[]
    expect(options.map((item) => ({ text: item.textContent, disabled: item.disabled }))).toEqual([
      { text: '原画1080P60（需登录）', disabled: true },
      { text: '蓝光4M', disabled: false },
      { text: '超清', disabled: false },
    ])

    fireEvent.change(select, { target: { value: '0' } })
    await flush()
    expect(invoke).not.toHaveBeenCalledWith('switchStreamSessionQuality', expect.anything())

    douyuLoggedIn = true
    act(() => notifyLoginStateChanged(['douyu'], 'login'))
    await waitFor(() => expect((within(select).getAllByRole('option')[0] as HTMLOptionElement).disabled).toBe(false))
    expect(within(select).getAllByRole('option')[0]!.textContent).toBe('原画1080P60')

    fireEvent.change(select, { target: { value: '0' } })
    await flush()
    expect(invoke).toHaveBeenCalledWith('switchStreamSessionQuality', { id: ID, quality: '0' })
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

  it('opens a Huya vanity room using the selected platform', async () => {
    renderStreams(true)
    await flush()
    const field = screen.getByLabelText('直播间房间号或链接')
    fireEvent.change(field, { target: { value: 'kpl' } })
    fireEvent.click(screen.getByRole('radio', { name: '虎牙' }))
    fireEvent.submit(field.closest('form')!)
    await flush()
    expect(invoke).toHaveBeenCalledWith('openStreamSession', { input: 'kpl', platform: 'huya' })
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
    expect(openInputFor(' 660000 ', 'huya')).toEqual({ input: '660000', platform: 'huya' })
    expect(openInputFor('虎牙 kpl', 'douyu')).toEqual({ input: 'kpl', platform: 'huya' })
    expect(openInputFor('https://m.huya.com/lpl', 'douyu')).toEqual({ input: 'https://m.huya.com/lpl' })
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

describe('split layout', () => {
  const bounds = { w: 1008, h: 648 }
  const initial = { mode: 'side-by-side', direction: 'side-by-side', ratio: 0.5 } as const

  it('uses the whole stage without streams, independently of the saved mode', () => {
    for (const mode of ['side-by-side', 'stacked', 'custom', 'floating'] as const) {
      expect(arrangeStreams(selectLayoutMode(initial, mode), 0, bounds)).toEqual({ kind: 'single' })
    }
  })

  it.each(['side-by-side', 'stacked'] as const)('splits 50/50 in %s mode and shares only the extra pane', (mode) => {
    const preference = selectLayoutMode({ ...initial, ratio: 0.65 }, mode)
    expect(arrangeStreams(preference, 1, bounds)).toMatchObject({ kind: 'split', direction: mode, divider: 0, ratio: 0.5, streamShare: 1 })
    expect(arrangeStreams(preference, 4, bounds)).toMatchObject({ kind: 'split', direction: mode, divider: 0, ratio: 0.5, streamShare: 0.25 })
  })

  it('uses floating positions instead of dividing the stage', () => {
    expect(arrangeStreams(selectLayoutMode(initial, 'floating'), 4, bounds)).toEqual({ kind: 'floating' })
  })

  it('keeps the last direction and clamps the visible ratio, without changing the preference', () => {
    const custom = selectLayoutMode({ ...initial, ratio: 0.9 }, 'custom')
    expect(arrangeStreams(custom, 3, bounds)).toMatchObject({ direction: 'side-by-side', divider: 8, ratio: 0.78, min: 0.22, max: 0.78, streamShare: 1 / 3 })
    const stacked = selectLayoutMode(selectLayoutMode(initial, 'stacked'), 'floating')
    const above = selectLayoutMode({ ...stacked, ratio: 0.1 }, 'custom')
    expect(arrangeStreams(above, 2, bounds)).toMatchObject({ direction: 'stacked', ratio: 0.25, min: 0.25, max: 0.75, streamShare: 0.5 })
    expect(arrangeStreams(custom, 1, { w: 400, h: 648 })).toMatchObject({ ratio: 0.5, min: 0.5, max: 0.5 })
    expect(arrangeStreams(above, 1, { w: 1008, h: 300 })).toMatchObject({ ratio: 0.5, min: 0.5, max: 0.5 })
    expect(arrangeStreams(custom, 1, { w: 2208, h: 648 })).toMatchObject({ ratio: 0.9 })
  })

  it('defaults missing or invalid preferences and round-trips all modes without touching old positions', () => {
    const legacy = { [ID]: { x: 12, y: 65, w: 280, h: 160 } }
    writeLayout(legacy)
    expect(readLayoutPreference()).toEqual(initial)
    for (const mode of ['side-by-side', 'stacked', 'custom', 'floating'] as const) {
      const preference = selectLayoutMode({ ...initial, direction: 'stacked', ratio: 0.65 }, mode)
      writeLayoutPreference(preference)
      expect(readLayoutPreference()).toEqual(preference)
    }
    expect(readLayout()).toEqual(legacy)
    localStorage.setItem('studio.extraStreams.view.v1', '{')
    expect(readLayoutPreference()).toEqual(initial)
    localStorage.setItem('studio.extraStreams.view.v1', JSON.stringify({ mode: 'grid', ratio: 2 }))
    expect(readLayoutPreference()).toEqual(initial)
  })
})
