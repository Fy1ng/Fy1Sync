import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyHudStylePack } from '../../core/hudStylePack'
import type { ValidationPreview, ValidationRow } from './batchValidationTypes'
import { useBatchValidation } from './useBatchValidation'

const fake = vi.hoisted(() => ({ sessions: [] as Array<{
  rows: ValidationRow[]; signal: AbortSignal | null; progress: (() => void) | null
  finish: () => void; fail: (error: Error) => void
  previewSignal: AbortSignal | null; completePreview: (value: ValidationPreview) => void
}> }))
vi.mock('./batchValidationRunner', () => ({
  BatchValidationSession: class {
    rows: ValidationRow[] = []
    signal: AbortSignal | null = null
    progress: (() => void) | null = null
    finish = () => {}
    fail = (_error: Error) => {}
    previewSignal: AbortSignal | null = null
    completePreview = (_value: ValidationPreview) => {}
    run = { from: 0, to: 4, step: 1, total: 4, packId: 'test/iem', packName: 'IEM', packRevision: 1, sourceName: 'test.mp4' }
    constructor() { fake.sessions.push(this) }
    scan(signal: AbortSignal, progress: () => void) {
      this.signal = signal; this.progress = progress
      return new Promise<void>((resolve, reject) => { this.finish = resolve; this.fail = reject })
    }
    inspect(_index: number, signal: AbortSignal) {
      this.previewSignal = signal
      return new Promise<ValidationPreview>(resolve => { this.completePreview = resolve })
    }
  },
}))

beforeEach(() => { fake.sessions.length = 0 })
afterEach(() => vi.restoreAllMocks())
const range = { from: 0, to: 4, step: 1 }
const options = () => ({ source: 'app-media://local/a', sourceName: 'test.mp4', pack: createEmptyHudStylePack(), duration: 10 })
const row = (index: number) => ({ index, at: index } as ValidationRow)

describe('validation session hook', () => {
  it('deduplicates clicks and keeps the completed rows for review', async () => {
    const view = renderHook(() => useBatchValidation(options()))
    act(() => { view.result.current.start(range); view.result.current.start(range) })
    expect(fake.sessions).toHaveLength(1)
    expect(view.result.current.state.phase).toBe('running')
    const session = fake.sessions[0]!
    await act(async () => { session.rows.push(row(0)); session.progress?.(); session.finish() })
    expect(view.result.current.state.phase).toBe('complete')
    expect(view.result.current.state.rows).toHaveLength(1)
  })

  it('retains partial results when stopped without presenting an engine error', async () => {
    const view = renderHook(() => useBatchValidation(options()))
    act(() => view.result.current.start(range))
    const session = fake.sessions[0]!
    session.rows.push(row(0))
    act(() => view.result.current.stop())
    expect(session.signal!.aborted).toBe(true)
    await act(async () => session.fail(new Error('abort')))
    expect(view.result.current.state.phase).toBe('stopped')
    expect(view.result.current.state.rows).toHaveLength(1)
    expect(view.result.current.state.error).toBeNull()
  })

  it('cancels old work on source replacement and discards its late completion', async () => {
    const first = options()
    const view = renderHook(props => useBatchValidation(props), { initialProps: first })
    act(() => view.result.current.start(range))
    const old = fake.sessions[0]!
    view.rerender({ ...first, source: 'app-media://local/b' })
    expect(old.signal!.aborted).toBe(true)
    await act(async () => { old.rows.push(row(0)); old.progress?.(); old.finish() })
    expect(view.result.current.state.phase).toBe('idle')
    expect(view.result.current.state.rows).toHaveLength(0)
  })

  it('ignores an older preview after a newer row is selected and aborts it on unmount', async () => {
    const view = renderHook(() => useBatchValidation(options()))
    act(() => view.result.current.start(range))
    const session = fake.sessions[0]!
    await act(async () => { session.rows.push(row(0), row(1)); session.finish() })
    await waitFor(() => expect(view.result.current.state.phase).toBe('complete'))
    act(() => view.result.current.inspect(0))
    const finishFirst = session.completePreview
    const firstSignal = session.previewSignal!
    act(() => view.result.current.inspect(1))
    expect(firstSignal.aborted).toBe(true)
    await act(async () => finishFirst({ index: 0, at: 0, images: [] }))
    expect(view.result.current.state.preview).toBeNull()
    const secondSignal = session.previewSignal!
    view.unmount()
    expect(secondSignal.aborted).toBe(true)
    await act(async () => session.completePreview({ index: 1, at: 1, images: [] }))
  })
})
