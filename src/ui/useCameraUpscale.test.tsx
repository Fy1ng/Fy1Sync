import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionSnapshot } from '../app/session'
import { DEFAULT_CAMERA_WINDOW, type CameraConfig } from '../app/camera'
import { DEFAULT_SETTINGS } from '../app/settings'
import { CameraUpscaler, probeWebGpu, type UpscaleDiagnostics } from '../media/upscale/renderer'
import { useCameraUpscale } from './useCameraUpscale'

const context = vi.hoisted(() => ({ session: null as unknown as Session, snapshot: null as unknown as SessionSnapshot }))
vi.mock('../app/SessionContext', () => ({ useSession: () => context.session, useSessionSnapshot: () => context.snapshot }))
vi.mock('../media/upscale/renderer', () => ({ CameraUpscaler: { create: vi.fn() }, probeWebGpu: vi.fn() }))

type CreateOptions = Parameters<typeof CameraUpscaler.create>[0]
interface PendingRenderer {
  config: CreateOptions
  update: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  resolve(): Promise<void>
}

let pending: PendingRenderer[]
let video: HTMLVideoElement
const config: CameraConfig = {
  crop: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }, window: DEFAULT_CAMERA_WINDOW, enabled: true, updatedAt: 1,
}

function Probe({ camera = config, width = 600, height = 400 }: { camera?: CameraConfig; width?: number; height?: number }): React.ReactNode {
  const upscale = useCameraUpscale(camera, width, height)
  return <div data-testid="state" data-mode={upscale.state.mode} data-reason={upscale.state.reason}>
    {upscale.active && <canvas key={upscale.canvasKey} ref={upscale.canvas} />}
  </div>
}

beforeEach(() => {
  pending = []
  video = document.createElement('video')
  Object.defineProperties(video, { videoWidth: { configurable: true, value: 1920 }, videoHeight: { configurable: true, value: 1080 } })
  context.session = { engine: { element: () => video }, notice: vi.fn(), updateSettings: vi.fn() } as unknown as Session
  context.snapshot = {
    settings: { ...DEFAULT_SETTINGS, cameraUpscale: 'quality' }, pipPresentationReduced: false,
    media: { commentary: { descriptor: { input: 'fixture-a' } } },
  } as unknown as SessionSnapshot
  vi.mocked(probeWebGpu).mockReset().mockResolvedValue(true)
  vi.mocked(CameraUpscaler.create).mockReset().mockImplementation((options) => {
    let resolve: (instance: CameraUpscaler) => void = () => {}
    const promise = new Promise<CameraUpscaler>((done) => { resolve = done })
    const update = vi.fn()
    const dispose = vi.fn()
    pending.push({ config: options, update, dispose, resolve: async () => {
      await act(async () => { resolve({ update, dispose } as unknown as CameraUpscaler); await promise })
    } })
    return promise
  })
})

afterEach(() => { cleanup() })

describe('camera GPU ownership', () => {
  it('applies the latest display size, crop and metadata after asynchronous initialization', async () => {
    const view = render(<Probe />)
    await waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0]!.config.options.cssWidth).toBe(600)
    const camera = { ...config, crop: { x: 0.2, y: 0.1, w: 0.25, h: 0.5 } }
    view.rerender(<Probe camera={camera} width={900} height={600} />)
    Object.defineProperties(video, { videoWidth: { configurable: true, value: 3840 }, videoHeight: { configurable: true, value: 2160 } })
    act(() => { video.dispatchEvent(new Event('loadedmetadata')); window.dispatchEvent(new Event('resize')) })
    await pending[0]!.resolve()
    expect(pending[0]!.update).toHaveBeenLastCalledWith(expect.objectContaining({
      crop: { x: 768, y: 216, width: 960, height: 1080 }, cssWidth: 900, cssHeight: 600, tier: 'quality',
    }))
    expect(CameraUpscaler.create).toHaveBeenCalledTimes(1)
  })

  it.each(['disable', 'unmount'] as const)('disposes a pending initialization after %s without adopting it', async (action) => {
    const view = render(<Probe />)
    await waitFor(() => expect(pending).toHaveLength(1))
    if (action === 'disable') view.rerender(<Probe camera={{ ...config, enabled: false }} />)
    else view.unmount()
    await pending[0]!.resolve()
    expect(pending[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(pending[0]!.update).not.toHaveBeenCalled()
  })

  it('uses the fallback during PiP low power and releases an active renderer', async () => {
    context.snapshot.pipPresentationReduced = true
    const view = render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('state')).toHaveAttribute('data-reason', 'low-power'))
    expect(CameraUpscaler.create).not.toHaveBeenCalled()
    context.snapshot.pipPresentationReduced = false
    view.rerender(<Probe />)
    await waitFor(() => expect(pending).toHaveLength(1))
    await pending[0]!.resolve()
    act(() => pending[0]!.config.onState?.({ tier: 'quality' } as UpscaleDiagnostics))
    expect(screen.getByTestId('state')).toHaveAttribute('data-mode', 'webgpu')
    context.snapshot.pipPresentationReduced = true
    view.rerender(<Probe />)
    expect(pending[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('state')).toHaveAttribute('data-mode', '2d')
    expect(screen.getByTestId('state')).toHaveAttribute('data-reason', 'low-power')
  })

  it('allows one device-loss reinitialization for the session', async () => {
    const view = render(<Probe />)
    await waitFor(() => expect(pending).toHaveLength(1))
    await pending[0]!.resolve()
    act(() => pending[0]!.config.onFailure?.('device-lost'))
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(pending[1]!.config.canvas).not.toBe(pending[0]!.config.canvas)
    await pending[1]!.resolve()
    act(() => pending[1]!.config.onFailure?.('device-lost'))
    expect(pending[1]!.dispose).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('state')).toHaveAttribute('data-mode', '2d')
    expect(screen.getByTestId('state')).toHaveAttribute('data-reason', 'device-lost')
    view.rerender(<Probe camera={{ ...config, enabled: false }} />)
    view.rerender(<Probe />)
    expect(CameraUpscaler.create).toHaveBeenCalledTimes(2)
  })

  it('preserves an overload cap across hide/show and room changes without changing preferences', async () => {
    const view = render(<Probe />)
    await waitFor(() => expect(pending).toHaveLength(1))
    await pending[0]!.resolve()
    act(() => pending[0]!.config.onDowngrade?.('performance'))
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[1]!.config.options.tier).toBe('performance')
    await pending[1]!.resolve()
    view.rerender(<Probe camera={{ ...config, enabled: false }} />)
    expect(pending[1]!.dispose).toHaveBeenCalledTimes(1)
    context.snapshot.media.commentary.descriptor = { input: 'fixture-b' } as SessionSnapshot['media']['commentary']['descriptor']
    view.rerender(<Probe />)
    await waitFor(() => expect(pending).toHaveLength(3))
    expect(pending[2]!.config.options.tier).toBe('performance')
    await pending[2]!.resolve()
    act(() => pending[2]!.config.onDowngrade?.('off'))
    expect(screen.getByTestId('state')).toHaveAttribute('data-reason', 'overload')
    expect(pending[2]!.dispose).toHaveBeenCalledTimes(1)
    expect(context.snapshot.settings.cameraUpscale).toBe('quality')
    expect(context.session.updateSettings).not.toHaveBeenCalled()
    expect(context.session.notice).toHaveBeenCalledTimes(2)
  })
})
