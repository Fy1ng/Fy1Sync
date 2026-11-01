import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCameraTightenResult, tightenCamera } from './cameraTighten'
import type { CameraSample } from './cameraFrames'

const sample = (): CameraSample => ({ frames: new Uint8Array(20 * 20 * 4 * 6), width: 20, height: 20,
  region: { x: 0.2, y: 0.3, w: 0.4, h: 0.5 }, rough: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } })
const result = { roi: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, found: [true, true, true, true], ambiguous: false }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
function worker() {
  const stub = { terminate: vi.fn(), postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null, onerror: null as (() => void) | null }
  vi.stubGlobal('Worker', class { constructor() { return stub } })
  return stub
}
describe('isolated camera boundary analysis', () => {
  it('maps local detector coordinates back to the original frame', () => {
    const mapped = parseCameraTightenResult(result, sample())
    expect(mapped.roi.x).toBeCloseTo(0.28)
    expect(mapped.roi.y).toBeCloseTo(0.4)
    expect(mapped.roi.w).toBeCloseTo(0.24)
    expect(mapped.roi.h).toBeCloseTo(0.3)
  })
  it.each([
    null, { ...result, found: [true] }, { ...result, ambiguous: undefined },
    { ...result, roi: { ...result.roi, x: -1 } }, { ...result, roi: { ...result.roi, w: 0.9 } },
    { ...result, roi: { ...result.roi, h: Number.NaN } },
  ])('rejects malformed or expanding crops', value => expect(() => parseCameraTightenResult(value, sample())).toThrow())
  it('transfers frame ownership to a worker and always terminates it after a result', async () => {
    const stub = worker(), frames = sample()
    const pending = tightenCamera(frames, new AbortController().signal)
    expect(stub.postMessage).toHaveBeenCalledWith(frames, [frames.frames.buffer])
    stub.onmessage?.({ data: { ok: true, value: result } } as MessageEvent)
    expect((await pending).roi.x).toBeCloseTo(0.28)
    expect(stub.terminate).toHaveBeenCalledOnce()
  })
  it.each(['abort', 'timeout', 'error', 'invalid'])('ends %s without waiting for synchronous WASM on the UI thread', async mode => {
    vi.useFakeTimers()
    const stub = worker(), controller = new AbortController()
    const pending = tightenCamera(sample(), controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    if (mode === 'abort') controller.abort()
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(12001)
    if (mode === 'error') stub.onerror?.()
    if (mode === 'invalid') stub.onmessage?.({ data: { ok: true, value: {} } } as MessageEvent)
    await rejected
    expect(stub.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
