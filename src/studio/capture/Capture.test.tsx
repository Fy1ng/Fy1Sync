/**
 * Capture only exists while switched on, and a GIF is fed to the main process one frame at a
 * time with consecutive indexes; cancel and unmount both cancel the recording there.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { FeatureEvent } from '../../../electron/featureContracts'
import { CaptureControls, CaptureSettings } from './Capture'

vi.mock('../../media/frameCapture', () => ({
  captureVideoFrame: vi.fn((_video: HTMLVideoElement, width?: number) => `data:image/png;base64,${width ?? 'full'}`),
}))

type Call = { method: string; args: unknown }
let calls: Call[] = []
let listeners: Array<(event: FeatureEvent) => void> = []
let enabled = true
let appendDelay = 0
let hangAppend = false
let inFlight = 0
let maxInFlight = 0

const state = () => ({ settings: { version: 1, enabled }, recordings: [] })

beforeEach(() => {
  calls = []
  listeners = []
  enabled = true
  appendDelay = 0
  hangAppend = false
  inFlight = 0
  maxInFlight = 0
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      switch (method) {
        case 'getCaptureState': return { ok: true, value: state() }
        case 'setCaptureEnabled': enabled = (args as { enabled: boolean }).enabled; return { ok: true, value: state() }
        case 'savePlaybackScreenshot': return { ok: true, value: { status: 'cancelled', path: null } }
        case 'beginGifRecording': return { ok: true, value: { id: 'g1', frames: 0, maxFrames: 3, options: args, phase: 'recording' } }
        case 'appendGifFrame': {
          const { index } = args as { index: number }
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          if (hangAppend && index >= 1) await new Promise(() => {})
          await new Promise((resolve) => setTimeout(resolve, appendDelay))
          inFlight -= 1
          return { ok: true, value: { id: 'g1', frames: index + 1, maxFrames: 3, options: {}, phase: 'recording' } }
        }
        case 'finishGifRecording': return { ok: true, value: { status: 'saved', path: 'C:/x.gif' } }
        case 'cancelGifRecording': return { ok: true, value: { cancelled: true } }
        default: return { ok: false, code: 'unknown', message: method }
      }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
    subscribeFeatures: (listener: (event: FeatureEvent) => void) => {
      listeners.push(listener)
      return () => { listeners = listeners.filter((entry) => entry !== listener) }
    },
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const video = document.createElement('video')
const methods = () => calls.map((call) => call.method)

async function startGif(): Promise<void> {
  await screen.findByRole('button', { name: '截图' })
  fireEvent.click(screen.getByRole('button', { name: 'GIF 录制' }))
  fireEvent.change(screen.getByLabelText('帧率'), { target: { value: '15' } })
  fireEvent.change(screen.getByLabelText('时长'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: '开始录制' }))
}

describe('CaptureControls', () => {
  it('renders nothing while capture is disabled and follows the capture topic', async () => {
    enabled = false
    const { container } = render(<CaptureControls source={() => video} />)
    await waitFor(() => expect(methods()).toContain('getCaptureState'))
    expect(container).toBeEmptyDOMElement()
    act(() => { for (const listener of listeners) listener({ topic: 'capture', data: { settings: { version: 1, enabled: true }, recordings: [] } }) })
    expect(await screen.findByRole('button', { name: '截图' })).toBeInTheDocument()
  })

  it('treats a cancelled screenshot dialog as not an error', async () => {
    render(<CaptureControls source={() => video} />)
    fireEvent.click(await screen.findByRole('button', { name: '截图' }))
    expect(await screen.findByText('已取消保存')).toBeInTheDocument()
    expect(calls.find((call) => call.method === 'savePlaybackScreenshot')?.args).toEqual({ png: 'data:image/png;base64,full' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('appends GIF frames one at a time with consecutive indexes, then finishes', async () => {
    appendDelay = 15
    render(<CaptureControls source={() => video} />)
    await startGif()
    await waitFor(() => expect(methods()).toContain('finishGifRecording'), { timeout: 2000 })
    const begin = calls.find((call) => call.method === 'beginGifRecording')
    expect(begin?.args).toEqual({ fps: 15, seconds: 1, width: 640 })
    const appends = calls.filter((call) => call.method === 'appendGifFrame').map((call) => call.args as { id: string; index: number; png: string })
    expect(appends.map((args) => args.index)).toEqual([0, 1, 2])
    expect(appends.every((args) => args.id === 'g1' && args.png === 'data:image/png;base64,640')).toBe(true)
    expect(maxInFlight).toBe(1)
    expect(await screen.findByText('GIF 已保存')).toBeInTheDocument()
  })

  it('rejects out-of-range form values without contacting the main process', async () => {
    render(<CaptureControls source={() => video} />)
    await screen.findByRole('button', { name: '截图' })
    fireEvent.click(screen.getByRole('button', { name: 'GIF 录制' }))
    fireEvent.change(screen.getByLabelText('帧率'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '开始录制' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('帧率须为 1 至 15 之间的整数')
    expect(methods()).not.toContain('beginGifRecording')
  })

  it('cancels the recording from the popover', async () => {
    hangAppend = true
    render(<CaptureControls source={() => video} />)
    await startGif()
    await screen.findByText('录制中 1/3', {}, { timeout: 2000 })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'cancelGifRecording', args: { id: 'g1' } }))
    expect(methods()).not.toContain('finishGifRecording')
    expect(screen.queryByText(/录制中/)).toBeNull()
  })

  it('cancels the recording on unmount', async () => {
    hangAppend = true
    const view = render(<CaptureControls source={() => video} />)
    await startGif()
    await screen.findByText('录制中 1/3', {}, { timeout: 2000 })
    view.unmount()
    await waitFor(() => expect(calls).toContainEqual({ method: 'cancelGifRecording', args: { id: 'g1' } }))
  })
})

describe('CaptureSettings', () => {
  it('switches capture on through setCaptureEnabled', async () => {
    enabled = false
    render(<CaptureSettings />)
    const toggle = await screen.findByRole('switch', { name: /启用截图与 GIF/ })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    fireEvent.click(toggle)
    await waitFor(() => expect(calls).toContainEqual({ method: 'setCaptureEnabled', args: { enabled: true } }))
    await waitFor(() => expect(toggle).toBeChecked())
    expect(screen.getByText('仅截取正在播放的画面，不截取桌面。')).toBeInTheDocument()
  })
})
