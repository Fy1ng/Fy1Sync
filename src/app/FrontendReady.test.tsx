import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FrontendReady } from './FrontendReady'

const api = vi.hoisted(() => ({ health: vi.fn(), feature: vi.fn() }))
vi.mock('./apiClient', () => ({ apiClient: api }))
beforeEach(() => {
  vi.useFakeTimers()
  api.health.mockReset().mockResolvedValue({ ok: true, value: { ok: true } })
  api.feature.mockReset().mockResolvedValue({ ok: true, value: { accepted: true } })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('frontend boot acknowledgement', () => {
  it('acknowledges only after the mounted tree and IPC bridge survive the grace period', async () => {
    render(<FrontendReady />)
    await act(() => vi.advanceTimersByTimeAsync(1999))
    expect(api.feature).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(api.feature).toHaveBeenCalledExactlyOnceWith('reportFrontendReady', { bridgeVersion: 1 })
  })
  it('does not acknowledge a tree that failed or unmounted before it became healthy', async () => {
    const view = render(<FrontendReady />)
    await act(() => vi.advanceTimersByTimeAsync(500))
    view.unmount()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(api.feature).not.toHaveBeenCalled()
  })
  it('does not confuse a present but failing preload bridge with a healthy application', async () => {
    api.health.mockResolvedValue({ ok: false, message: 'bridge unavailable' })
    render(<FrontendReady />)
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(api.feature).not.toHaveBeenCalled()
  })
})
