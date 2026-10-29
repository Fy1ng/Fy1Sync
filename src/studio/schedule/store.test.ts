/** The start-up schedule read: one request, shared, and remembered for the sheet. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { Cs2Schedule } from '../../../electron/featureContracts'

const schedule: Cs2Schedule = { fetchedAt: 1, source: 'liquipedia', attribution: '', stale: false, matches: [] }

async function fresh(reply: (args: unknown) => unknown) {
  vi.resetModules()
  const invoke = vi.fn(async (_method: string, args: unknown) => reply(args))
  const listeners: Array<(event: { topic: string; data: unknown }) => void> = []
  vi.stubGlobal('streamSyncer', { invoke, subscribeFeatures: (listener: (event: { topic: string; data: unknown }) => void) => { listeners.push(listener); return () => {} } } as unknown as StreamSyncerBridge)
  const emit = (topic: string) => { for (const listener of listeners) listener({ topic, data: { type: 'tiers-updated' } }) }
  return { invoke, emit, store: await import('./store') }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('schedule store', () => {
  it('joins a plain read already in flight and remembers what it read', async () => {
    const { invoke, store } = await fresh(() => ({ ok: true, value: schedule }))
    expect(store.lastSchedule()).toBeNull()
    store.prefetchSchedule()
    const result = await store.readSchedule()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: true, value: schedule })
    expect(store.lastSchedule()).toEqual(schedule)
  })

  it('sends a refresh even while a plain read is pending', async () => {
    const { invoke, store } = await fresh(() => ({ ok: true, value: schedule }))
    store.prefetchSchedule()
    await store.readSchedule(true)
    expect(invoke.mock.calls.map((call) => call[1])).toEqual([undefined, { refresh: true }])
  })

  it('reads again when main says tiers or crests landed, and only then', async () => {
    const { invoke, emit, store } = await fresh(() => ({ ok: true, value: schedule }))
    store.prefetchSchedule()
    store.prefetchSchedule()
    await store.readSchedule()
    emit('insights')
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)
    emit('cs2-schedule')
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
  })

  it('reads once more for a change that arrived while a read was in flight', async () => {
    const later = { ...schedule, fetchedAt: 2 }
    let release!: () => void
    let calls = 0
    const { invoke, emit, store } = await fresh(() => {
      calls += 1
      if (calls === 1) return new Promise((resolve) => { release = () => resolve({ ok: true, value: schedule }) })
      return { ok: true, value: later }
    })
    const seen: number[] = []
    store.onSchedule((value) => seen.push(value.fetchedAt))
    store.prefetchSchedule()
    // The crest lands while the first read is still out: that read predates it.
    emit('cs2-schedule')
    emit('cs2-schedule')
    expect(invoke).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(store.lastSchedule()?.fetchedAt).toBe(2))
    // Two events while in flight still make just one trailing read.
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(seen).toEqual([1, 2])
  })

  it('does not let an older reply replace a newer one', async () => {
    const releases: Array<() => void> = []
    const { store } = await fresh((args) => new Promise((resolve) => {
      releases.push(() => resolve({ ok: true, value: { ...schedule, fetchedAt: args ? 2 : 1 } }))
    }))
    const plain = store.readSchedule()
    const refresh = store.readSchedule(true)
    releases[1]!()
    await refresh
    releases[0]!()
    await plain
    expect(store.lastSchedule()?.fetchedAt).toBe(2)
  })

  it('keeps the last good schedule when a later read fails', async () => {
    let fail = false
    const { store } = await fresh(() => fail ? { ok: false, code: 'unavailable', message: '赛程暂时无法读取' } : { ok: true, value: schedule })
    await store.readSchedule()
    fail = true
    expect((await store.readSchedule()).ok).toBe(false)
    expect(store.lastSchedule()).toEqual(schedule)
  })
})
