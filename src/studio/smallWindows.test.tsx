/**
 * Interaction tests for the streamer camera overlay, the secondary preview (.pip),
 * and their non-conflicting coexistence with interactive scrolling danmaku.
 */

import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CameraStore, DEFAULT_CAMERA_WINDOW, type CameraConfig } from '../app/camera'
import type { DanmakuEvent } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { setCameraStoreForTests, useCamera } from '../app/useCamera'
import type { StreamSyncerBridge } from '../../electron/contracts'
import type { ChatMessage } from '../../server/danmaku/types'
import { primeMediaElement } from '../test/setup'
import { CameraButton } from './CameraButton'
import { ComposerProvider } from './composer'
import { DanmakuActionsProvider } from './danmakuActions'
import { DanmakuPanel } from './DanmakuPanel'
import { DanmakuStage } from './DanmakuStage'
import { loadPreviewWindow, PREVIEW_WINDOW_STORAGE_KEY } from './PreviewPip'
import { Studio } from './Studio'
import { CameraOverlay } from '../ui/CameraOverlay'

const sessions: Session[] = []
const danmakuListeners = new Set<(event: DanmakuEvent) => void>()

function makeSession(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  return session
}

function mockRect(node: Element, rect: { left: number; top: number; width: number; height: number }): void {
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({}),
  } as DOMRect)
}

function installStageSize(width = 1000, height = 600): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('streams-primary') || this.classList.contains('danmaku-stage') || this.classList.contains('streams-stage')) {
        return width
      }
      return 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('streams-primary') || this.classList.contains('danmaku-stage') || this.classList.contains('streams-stage')) {
        return height
      }
      return 0
    },
  })
}

beforeEach(() => {
  localStorage.clear()
  danmakuListeners.clear()
  installStageSize(1000, 600)
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'getToolsStatus') return { ok: true, value: { tools: [], fixturesAvailable: false } }
      if (method === 'getEmbeddedLogin') return { ok: true, value: null }
      if (method === 'loginStatus') return { ok: true, value: { douyu: { loggedIn: false }, youtube: { loggedIn: false }, bilibili: { loggedIn: false }, huya: { loggedIn: false } } }
      if (method === 'getStreamSessions') return { ok: true, value: { maxExtraStreams: 4, sessions: [] } }
      if (method === 'getEnhancedPip') return { ok: true, value: { phase: 'closed', streamId: null, audioOwner: 'main', recoveryRevision: 0, options: { lowPower: false, autoRecover: true }, sendContext: { room: null, accountId: null, canAttempt: false } } }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: (_room, listener) => {
      danmakuListeners.add(listener)
      return () => { danmakuListeners.delete(listener) }
    },
    subscribeEmbeddedLogin: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
  setCameraStoreForTests(null)
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('camera overlay 8-way resize, menu controls, and danmaku coexistence', () => {
  const initialConfig: CameraConfig = {
    crop: { x: 0.05, y: 0.5, w: 0.2, h: 0.2 },
    window: { ...DEFAULT_CAMERA_WINDOW, x: 0.1, y: 0.1, width: 0.2 },
    enabled: true,
    updatedAt: 1,
  }

  function StageHarness({ onWindow }: { onWindow: (next: CameraConfig['window']) => void }) {
    const stageRef = useRef<HTMLDivElement | null>(null)
    const camera = useCamera()
    return (
      <div className="studio">
        <div className="streams-primary" ref={stageRef}>
          <DanmakuStage onReply={() => {}} />
          {camera.config && <CameraOverlay config={camera.config} onWindow={(w) => { camera.setWindow(w); onWindow(w) }} stageRef={stageRef} />}
        </div>
        <CameraButton camera={camera} onFrame={() => {}} stageRef={stageRef} />
        <DanmakuPanel onClose={() => {}} />
      </div>
    )
  }

  it('renders 8 directional handles without a close button, syncs layer switches, and resizes via handles and menu slider', async () => {
    const session = makeSession()
    const store = new CameraStore(null)
    store.set('douyu:6979222', initialConfig)
    setCameraStoreForTests(store)
    await session.loadSource('commentary', {
      kind: 'test', url: '/test-sources/commentary.mp4', input: '6979222', sourceRoom: '6979222',
      label: '斗鱼 6979222', loop: true, viaProxy: false, platform: 'douyu',
    })
    primeMediaElement(session.engine.element('commentary'))
    session.flush()

    const updates: CameraConfig['window'][] = []
    const { container } = render(
      <SessionProvider session={session}>
        <ComposerProvider>
          <DanmakuActionsProvider onOpenRecords={() => {}}>
            <StageHarness onWindow={(w) => updates.push(w)} />
          </DanmakuActionsProvider>
        </ComposerProvider>
      </SessionProvider>,
    )

    const overlay = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('.camera-overlay')
      expect(node).not.toBeNull()
      return node!
    })

    // Default floats danmaku over the camera picture, with no close button on the overlay.
    expect(overlay).toHaveAttribute('data-below-danmaku', 'true')
    expect(within(overlay).queryByRole('button')).toBeNull()
    const handles = overlay.querySelectorAll('.camera-handle')
    expect(handles).toHaveLength(8)
    expect(overlay.querySelectorAll('.camera-resize')).toHaveLength(1)

    // Resize from top-left (nw) handle: right edge stays anchored while width grows.
    const nw = overlay.querySelector<HTMLElement>('.camera-handle-nw')!
    fireEvent.pointerDown(nw, { button: 0, pointerId: 1, clientX: 100, clientY: 60 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 40, clientY: 50 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 50 })
    expect(updates.length).toBeGreaterThan(0)
    const afterNw = updates.at(-1)!
    expect(afterNw.width).toBeCloseTo(0.26, 2)
    expect(afterNw.x + afterNw.width).toBeCloseTo(0.3, 2)

    // Resize and toggle layer from the dock's 主播摄像头 menu.
    fireEvent.click(screen.getByRole('button', { name: '主播摄像头' }))
    const cameraMenu = screen.getByRole('dialog', { name: '主播摄像头' })
    const sizeSlider = within(cameraMenu).getByRole('slider', { name: '小窗大小' })
    fireEvent.change(sizeSlider, { target: { value: '35' } })
    expect(store.get('douyu:6979222')!.window.width).toBeCloseTo(0.35, 2)

    const menuSwitch = within(cameraMenu).getByRole('switch', { name: '弹幕浮于小窗上方' })
    expect(menuSwitch).toBeChecked()
    fireEvent.click(menuSwitch)
    await waitFor(() => expect(session.settings.danmaku.danmakuOverCamera).toBe(false))
    expect(overlay).not.toHaveAttribute('data-below-danmaku')

    const panelSwitch = within(screen.getByRole('complementary', { name: '弹幕设置' })).getByRole('switch', { name: '弹幕浮于摄像头上方' })
    expect(panelSwitch).not.toBeChecked()
    fireEvent.click(panelSwitch)
    await waitFor(() => expect(overlay).toHaveAttribute('data-below-danmaku', 'true'))
  })

  it('lets pointer hover pause danmaku over the camera while press-and-drag hands off to move the camera', async () => {
    const session = makeSession()
    const store = new CameraStore(null)
    store.set('douyu:6979222', initialConfig)
    setCameraStoreForTests(store)
    await session.loadSource('commentary', {
      kind: 'test', url: '/test-sources/commentary.mp4', input: '6979222', sourceRoom: '6979222',
      label: '斗鱼 6979222', loop: true, viaProxy: false, platform: 'douyu',
    })
    primeMediaElement(session.engine.element('commentary'))
    session.connectDanmaku('6979222')
    session.flush()

    const updates: CameraConfig['window'][] = []
    const { container } = render(
      <SessionProvider session={session}>
        <ComposerProvider>
          <DanmakuActionsProvider onOpenRecords={() => {}}>
            <StageHarness onWindow={(w) => updates.push(w)} />
          </DanmakuActionsProvider>
        </ComposerProvider>
      </SessionProvider>,
    )

    const primary = container.querySelector('.streams-primary')!
    const danmakuHost = container.querySelector('.danmaku-stage')!
    mockRect(primary, { left: 0, top: 0, width: 1000, height: 600 })
    mockRect(danmakuHost, { left: 0, top: 0, width: 1000, height: 600 })

    const overlay = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('.camera-overlay')
      expect(node).not.toBeNull()
      return node!
    })
    mockRect(overlay, { left: 100, top: 60, width: 200, height: 112 })

    // Inject a scrolling danmaku item through the preload boundary and simulate its rendered box over the camera.
    act(() => {
      const msg: ChatMessage = {
        id: 'dm-1', room: '6979222', username: '观众甲', text: '飘过小窗的弹幕',
        color: 0xffffff, level: 1, receivedAt: Date.now(), system: false,
      }
      for (const listener of danmakuListeners) {
        listener({ event: 'state', data: { room: '6979222', state: 'connected' } })
        listener({ event: 'danmaku', data: msg })
      }
    })
    const item = await waitFor(() => {
      const spawned = container.querySelector<HTMLElement>('.danmaku-item')
      expect(spawned).not.toBeNull()
      return spawned!
    })
    mockRect(item, { left: 120, top: 80, width: 140, height: 28 })

    // 1. Hovering the danmaku without dragging pauses it and opens its toolbar.
    fireEvent.pointerOver(item, { clientX: 160, clientY: 90, buttons: 0 })
    expect(screen.getByRole('toolbar', { name: '弹幕操作：飘过小窗的弹幕' })).toBeInTheDocument()
    expect(item).toHaveClass('is-held')

    // 2. Pressing and dragging right on that danmaku releases it, closes the menu, and moves the camera!
    fireEvent.pointerDown(item, { button: 0, pointerId: 7, clientX: 160, clientY: 90 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 280, clientY: 150, buttons: 1 })
    expect(screen.queryByRole('toolbar', { name: '弹幕操作：飘过小窗的弹幕' })).toBeNull()
    expect(item).not.toHaveClass('is-held')

    // While dragging, crossing danmaku does not re-open the menu.
    fireEvent.pointerOver(item, { clientX: 280, clientY: 150, buttons: 1 })
    expect(screen.queryByRole('toolbar', { name: '弹幕操作：飘过小窗的弹幕' })).toBeNull()

    fireEvent.pointerUp(window, { pointerId: 7, clientX: 280, clientY: 150 })
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.at(-1)!.x).toBeCloseTo(0.22, 2)
    expect(updates.at(-1)!.y).toBeCloseTo(0.2, 2)
  })
})

describe('secondary preview (.pip) drag, 8-way resize, persistence, and concise hide controls', () => {
  it('swaps on click, drags and resizes in all directions without swapping, persists layout, and uses exact labels', async () => {
    const session = makeSession()
    for (const role of ['official', 'commentary'] as const) {
      await session.loadSource(role, {
        kind: 'test', url: `/test-sources/${role}.mp4`, input: role, label: role, loop: true, viaProxy: false, platform: 'test',
      })
      primeMediaElement(session.engine.element(role))
    }
    session.flush()

    const { container, unmount } = render(
      <SessionProvider session={session}>
        <Studio />
      </SessionProvider>,
    )
    await new Promise((r) => setTimeout(r, 0))

    const primary = container.querySelector('.streams-primary')!
    const pip = container.querySelector<HTMLElement>('.pip')!
    mockRect(primary, { left: 0, top: 0, width: 1000, height: 600 })
    mockRect(pip, { left: 760, top: 380, width: 220, height: 124 })
    expect(pip.querySelectorAll('.pip-handle')).toHaveLength(8)

    // Tooltip on hide button is strictly "隐藏小画面" with no extra note.
    const hideBtn = screen.getByRole('button', { name: '隐藏小画面' })
    expect(hideBtn).toHaveAttribute('title', '隐藏小画面')
    expect(hideBtn.getAttribute('title')).not.toContain('声音')

    // Plain click swaps mainRole.
    fireEvent.click(screen.getByRole('button', { name: '将解说切换为主画面' }))
    await waitFor(() => expect(session.snapshot.mainRole).toBe('commentary'))
    fireEvent.click(screen.getByRole('button', { name: '将画面切换为主画面' }))
    await waitFor(() => expect(session.snapshot.mainRole).toBe('official'))

    // Dragging .pip-swap moves .pip, saves to localStorage, and does NOT swap roles!
    const currentSwap = screen.getByRole('button', { name: '将解说切换为主画面' })
    fireEvent.pointerDown(currentSwap, { button: 0, pointerId: 3, clientX: 800, clientY: 420 })
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 300, clientY: 160 })
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 300, clientY: 160 })
    fireEvent.click(currentSwap)
    expect(session.snapshot.mainRole).toBe('official')

    const savedAfterMove = loadPreviewWindow()
    expect(savedAfterMove).not.toBeNull()
    expect(savedAfterMove!.x).toBeCloseTo(0.26, 2)

    // Resize from north-east (ne) handle and verify persistence across remount.
    const ne = container.querySelector<HTMLElement>('.pip-handle-ne')!
    fireEvent.pointerDown(ne, { button: 0, pointerId: 4, clientX: 480, clientY: 140 })
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 580, clientY: 100 })
    fireEvent.pointerUp(window, { pointerId: 4, clientX: 580, clientY: 100 })

    const savedAfterResize = loadPreviewWindow()!
    expect(savedAfterResize.width).toBeGreaterThan(savedAfterMove!.width + 0.05)
    expect(localStorage.getItem(PREVIEW_WINDOW_STORAGE_KEY)).toBeTruthy()

    // SourcePanel offers concise "显示小画面" switch without "保留声音" subtext.
    fireEvent.click(screen.getByRole('button', { name: /^解说：/ }))
    const sourceDialog = screen.getByRole('dialog', { name: '解说片源' })
    const previewSwitch = within(sourceDialog).getByRole('switch', { name: '显示小画面' })
    expect(previewSwitch).toBeChecked()
    expect(sourceDialog.textContent).not.toContain('保留声音')
    fireEvent.click(previewSwitch)
    expect(container.querySelector('.pip')).toBeNull()
    fireEvent.click(previewSwitch)
    expect(container.querySelector('.pip')).not.toBeNull()

    unmount()
  })
})
