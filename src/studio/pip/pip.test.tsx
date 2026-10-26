/**
 * The enhanced PiP window against a stubbed bridge: nothing here reaches main or a platform.
 * What matters is what main is told and when: ready only after real playback, progress
 * read off the element, sends bound to a freshly read context, and nothing left behind.
 */

import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { FeatureEvent } from '../../../electron/featureContracts'
import type { PipState } from '../../../electron/pipManager'
import { primeMediaElement } from '../../test/setup'
import PipPage, { sendBlock } from './PipPage'
import { PipSettings } from './PipSettings'

type Call = { method: string; args: unknown }

function pipState(patch: Partial<PipState> = {}): PipState {
  return {
    phase: 'opening',
    streamId: 'official',
    source: { platform: 'direct', url: '/test-sources/official.mp4', kind: 'progressive', label: '测试', channel: 'x', requiresProxy: false, sourceRoom: '9999' },
    options: { lowPower: false, recoverStalls: true, width: 480, height: 270 },
    audioOwner: 'main',
    recoveryRevision: 0,
    recoveryAttempts: 0,
    message: null,
    sendContext: { accountId: 'acc-1', room: '9999', canAttempt: true },
    ...patch,
  }
}

let calls: Call[]
let featureListeners: Set<(event: FeatureEvent) => void>
let featureReleases: number
let danmakuRooms: string[]
let danmakuReleases: number
let states: PipState[]
let frameCallbacks: Array<() => void>

function invoked(method: string): Call[] {
  return calls.filter((call) => call.method === method)
}

function install(initial: PipState, handlers: Record<string, (args: unknown) => unknown> = {}): void {
  states = [initial]
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      if (handlers[method]) return { ok: true, value: handlers[method]!(args) }
      if (method === 'getEnhancedPip') return { ok: true, value: states.length > 1 ? states.shift()! : states[0]! }
      if (method === 'reportEnhancedPip') return { ok: true, value: states[0]! }
      if (method === 'getDanmakuFeatures') return { ok: false, code: 'x', message: 'x' }
      if (method === 'activateDouyuRoom') return { ok: true, value: { room: (args as { room: string }).room } }
      if (method === 'sendComposedDouyuMessage') return { ok: true, value: { status: 'succeeded', message: '发送成功', nextAllowedAt: null } }
      return { ok: true, value: states[0]! }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: (room: string) => {
      danmakuRooms.push(room)
      return () => { danmakuReleases += 1 }
    },
    subscribeFeatures: (listener: (event: FeatureEvent) => void) => {
      featureListeners.add(listener)
      return () => { featureListeners.delete(listener); featureReleases += 1 }
    },
  } satisfies StreamSyncerBridge)
}

function push(state: PipState): void {
  act(() => { for (const listener of featureListeners) listener({ topic: 'pip', data: state }) })
}

const flush = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

beforeEach(() => {
  calls = []
  featureListeners = new Set()
  featureReleases = 0
  danmakuRooms = []
  danmakuReleases = 0
  frameCallbacks = []
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value(callback: () => void) { frameCallbacks.push(callback); return frameCallbacks.length },
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', { configurable: true, value() {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback
})

function presentFrame(): void {
  act(() => { for (const callback of frameCallbacks.splice(0)) callback() })
}

describe('the PiP window', () => {
  it('reports ready only once frames are presented, then a pause as not playing', async () => {
    install(pipState())
    const { container } = render(<StrictMode><PipPage /></StrictMode>)
    await flush()
    await flush()
    const video = container.querySelector('video')!
    expect(video).toBeTruthy()
    expect(video.getAttribute('src')).toBe('/test-sources/official.mp4')
    // play() resolved, but there is no picture yet.
    expect(video.paused).toBe(false)
    expect(invoked('reportEnhancedPip')).toHaveLength(0)

    primeMediaElement(video, { currentTime: 3, duration: 600 })
    await act(async () => { await video.play() })
    expect(invoked('reportEnhancedPip')).toHaveLength(0)

    presentFrame()
    await waitFor(() => expect(invoked('reportEnhancedPip')).toHaveLength(1))
    expect(invoked('reportEnhancedPip')[0]!.args).toEqual({ ready: true, playing: true, mediaTime: 3, frameCount: 1 })

    act(() => video.pause())
    await waitFor(() => expect(invoked('reportEnhancedPip')).toHaveLength(2))
    expect(invoked('reportEnhancedPip')[1]!.args).toMatchObject({ ready: true, playing: false, mediaTime: 3 })
  })

  it('reloads the same source on the same element when recovery is asked for', async () => {
    install(pipState({ phase: 'ready' }))
    const { container } = render(<PipPage />)
    await flush()
    const video = container.querySelector('video')!
    const load = vi.spyOn(video, 'load')
    push(pipState({ phase: 'ready', recoveryRevision: 1, recoveryAttempts: 1 }))
    await flush()
    expect(load).toHaveBeenCalled()
    expect(container.querySelector('video')).toBe(video)
    expect(video.getAttribute('src')).toBe('/test-sources/official.mp4')
  })

  it('subscribes only to the selected room', async () => {
    install(pipState({ phase: 'ready' }))
    render(<PipPage />)
    await flush()
    expect(danmakuRooms).toEqual(['9999'])
  })

  it('keeps the send bar off with a reason when sending may not be attempted', async () => {
    install(pipState({ phase: 'ready', sendContext: { accountId: 'acc-1', room: '9999', canAttempt: false } }))
    render(<PipPage />)
    await flush()
    const input = screen.getByLabelText('发送弹幕')
    expect(input).toBeDisabled()
    expect(input).toHaveAttribute('placeholder', '当前不可发送')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(sendBlock({ accountId: null, room: '9999', canAttempt: true })).toBe('未登录斗鱼账号')
    expect(sendBlock({ accountId: 'a', room: null, canAttempt: true })).toBe('未关联斗鱼直播间')
  })

  it('reads the context again right before sending and uses that one', async () => {
    install(pipState({ phase: 'ready' }))
    render(<PipPage />)
    await flush()
    // The account changed while the bar was open.
    states.unshift(pipState({ phase: 'ready', sendContext: { accountId: 'acc-2', room: '9999', canAttempt: true } }))
    const input = screen.getByLabelText('发送弹幕')
    fireEvent.change(input, { target: { value: '你好' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    await flush()
    expect(invoked('sendComposedDouyuMessage')).toHaveLength(0)

    const reads = invoked('getEnhancedPip').length
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(invoked('sendComposedDouyuMessage')).toHaveLength(1))
    expect(invoked('getEnhancedPip').length).toBe(reads + 1)
    const order = calls.map((call) => call.method).filter((method) => ['getEnhancedPip', 'activateDouyuRoom', 'sendComposedDouyuMessage'].includes(method))
    expect(order.slice(-3)).toEqual(['getEnhancedPip', 'activateDouyuRoom', 'sendComposedDouyuMessage'])
    expect(invoked('sendComposedDouyuMessage')[0]!.args).toEqual({ accountId: 'acc-2', room: '9999', text: '你好', color: 0, mode: 'message' })
    expect(await screen.findByText('发送成功')).toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('does not send when the fresh context forbids it', async () => {
    install(pipState({ phase: 'ready' }))
    render(<PipPage />)
    await flush()
    states.unshift(pipState({ phase: 'ready', sendContext: { accountId: 'acc-1', room: '9999', canAttempt: false } }))
    const input = screen.getByLabelText('发送弹幕')
    fireEvent.change(input, { target: { value: '你好' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('当前不可发送', { selector: '.pip-outcome' })).toBeInTheDocument()
    expect(invoked('sendComposedDouyuMessage')).toHaveLength(0)
  })

  it('releases every subscription and the video on unmount', async () => {
    install(pipState({ phase: 'ready' }))
    const { container, unmount } = render(<StrictMode><PipPage /></StrictMode>)
    await flush()
    const video = container.querySelector('video')!
    expect(featureListeners.size).toBeGreaterThan(0)
    unmount()
    expect(featureListeners.size).toBe(0)
    expect(featureReleases).toBeGreaterThan(0)
    expect(danmakuReleases).toBe(danmakuRooms.length)
    expect(video.isConnected).toBe(false)
  })

  it('shows the failure main reports', async () => {
    install(pipState({ phase: 'failed', message: '画中画窗口已失去响应' }))
    render(<PipPage />)
    await flush()
    expect(screen.getByRole('status')).toHaveTextContent('画中画窗口已失去响应')
  })
})

describe('PiP settings', () => {
  it('switches the options in main and offers recovery while a window is open', async () => {
    install(pipState({ phase: 'ready' }), {
      setEnhancedPipOptions: (args) => pipState({ phase: 'ready', options: { ...pipState().options, ...(args as object) } }),
    })
    render(<div className="studio"><PipSettings /></div>)
    await flush()
    expect(screen.getByText('已打开')).toBeInTheDocument()
    const lowPower = screen.getByRole('switch', { name: /低功耗/ })
    expect(lowPower).not.toBeChecked()
    fireEvent.click(lowPower)
    await waitFor(() => expect(lowPower).toBeChecked())
    expect(invoked('setEnhancedPipOptions')[0]!.args).toEqual({ lowPower: true })
    fireEvent.click(screen.getByRole('switch', { name: /卡顿时自动恢复/ }))
    await waitFor(() => expect(invoked('setEnhancedPipOptions')).toHaveLength(2))
    expect(invoked('setEnhancedPipOptions')[1]!.args).toEqual({ recoverStalls: false })
    fireEvent.click(screen.getByRole('button', { name: '恢复画面' }))
    await waitFor(() => expect(invoked('recoverEnhancedPip')).toHaveLength(1))
  })

  it('hides recovery when no window is open', async () => {
    install(pipState({ phase: 'closed', streamId: null, source: null }))
    render(<div className="studio"><PipSettings /></div>)
    await flush()
    expect(screen.getByText('未打开')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复画面' })).toBeNull()
  })
})
