import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HuyaOnTvClient } from './huyaOnTvClient'
import { huyaOnTvIdentity, huyaOnTvWire } from '../platforms/fixtures/huyaOnTvFixture'
import { DanmakuRelay } from './relay'
import { HuyaRoomClient } from './huyaRoomClient'
import { HuyaTarsWriter } from '../platforms/huyaWup'
import type { WebSocketLike } from './types'
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1800000000000) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
it('reads on connection, polls once per shared room and cancels on disconnect/reconnect/close', async () => {
  const readPanel = vi.fn(async () => huyaOnTvWire()), publish = vi.fn()
  const client = new HuyaOnTvClient('99798', publish, { readPanel })
  client.setIdentity(huyaOnTvIdentity); client.setConnected(true); client.setConnected(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(readPanel).toHaveBeenCalledTimes(1)
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'active' }))
  await vi.advanceTimersByTimeAsync(15000); expect(readPanel).toHaveBeenCalledTimes(2)
  client.setConnected(false); expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unavailable' }))
  await vi.advanceTimersByTimeAsync(30000); expect(readPanel).toHaveBeenCalledTimes(2)
  client.setConnected(true); await vi.advanceTimersByTimeAsync(0); expect(readPanel).toHaveBeenCalledTimes(3)
  client.close(); expect(vi.getTimerCount()).toBe(0)
})
it('aborts in-flight reads and ignores late results after room release', async () => {
  let finish!: (bytes: Uint8Array) => void, signal!: AbortSignal
  const publish = vi.fn(), readPanel = vi.fn((_room, abort: AbortSignal) => { signal = abort; return new Promise<Uint8Array>(resolve => { finish = resolve }) })
  const client = new HuyaOnTvClient('99798', publish, { readPanel })
  client.setIdentity(huyaOnTvIdentity); client.setConnected(true); client.close()
  expect(signal.aborted).toBe(true)
  publish.mockClear(); finish(huyaOnTvWire()); await vi.advanceTimersByTimeAsync(0)
  expect(publish).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
})
it('publishes a fixed error and retries malformed responses without leaking network details', async () => {
  const readPanel = vi.fn().mockRejectedValueOnce(new Error('private-token')).mockResolvedValue(huyaOnTvWire())
  const publish = vi.fn(), client = new HuyaOnTvClient('99798', publish, { readPanel })
  client.setIdentity(huyaOnTvIdentity); client.setConnected(true); await vi.advanceTimersByTimeAsync(0)
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unavailable' }))
  expect(JSON.stringify(publish.mock.calls)).not.toContain('private-token')
  await vi.advanceTimersByTimeAsync(15000); expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'active' })); client.close()
})
it('clears the previous activity when refreshed presenter metadata changes and rejects the old presenter panel', async () => {
  let finish!: (bytes: Uint8Array) => void
  const readPanel = vi.fn().mockResolvedValueOnce(huyaOnTvWire()).mockImplementationOnce(() => new Promise<Uint8Array>(resolve => { finish = resolve }))
  const publish = vi.fn(), client = new HuyaOnTvClient('99798', publish, { readPanel })
  client.setIdentity(huyaOnTvIdentity); client.setConnected(true); await vi.advanceTimersByTimeAsync(0)
  client.setIdentity({ ...huyaOnTvIdentity, presenterUid: 2048n })
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'loading', activity: null }))
  finish(huyaOnTvWire()); await vi.advanceTimersByTimeAsync(0)
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unavailable', activity: null })); client.close()
})
it('shares one activity reader between windows and stops it on room disposal', async () => {
  const readPanel = vi.fn(async () => huyaOnTvWire())
  const onSnapshot = vi.fn()
  const sockEvents = new Map<string, (data: unknown) => void>()
  const socket = {
    close: vi.fn(), send: vi.fn(), binaryType: '',
    addEventListener(type, listener) { sockEvents.set(type, listener) },
  } satisfies WebSocketLike
  const relay = new DanmakuRelay({ createClient: (_platform, room, callbacks) => new HuyaRoomClient(room, callbacks, {
    resolveRoom: async () => huyaOnTvIdentity,
    createSocket: () => socket,
    slice: { requestSignal: () => new Promise(() => {}) },
    onTv: { onSnapshot, readPanel },
  }) })
  const first = vi.fn(), second = vi.fn()
  const release1 = relay.subscribe('huya:99798', { write: first, close() {} })!
  const release2 = relay.subscribe('huya:99798', { write: second, close() {} })!
  await vi.advanceTimersByTimeAsync(0)
  expect(readPanel).not.toHaveBeenCalled()
  sockEvents.get('open')?.({})
  const ack = new HuyaTarsWriter()
  ack.int(0, 0); ack.head(1, 9); ack.int(0, 1); ack.string(0, 'chat:1024')
  const frame = new HuyaTarsWriter()
  frame.int(0, 17); frame.bytes(1, ack.finish())
  sockEvents.get('message')?.({ data: frame.finish() })
  await vi.advanceTimersByTimeAsync(0)
  expect(readPanel).toHaveBeenCalledOnce()
  expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ room: 'huya:99798', status: 'active' }))
  release1()
  expect(socket.close).not.toHaveBeenCalled()
  release2()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(socket.close).toHaveBeenCalledOnce()
  expect(readPanel).toHaveBeenCalledOnce()
  expect(relay.roomCount).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not restart the reader for duplicate transport identities or extend a replayed deadline', async () => {
  const publish = vi.fn(), readPanel = vi.fn(async () => huyaOnTvWire())
  const client = new HuyaOnTvClient('99798', publish, { readPanel })
  client.setIdentity(huyaOnTvIdentity); client.setConnected(true)
  await vi.advanceTimersByTimeAsync(0)
  client.setIdentity({ ...huyaOnTvIdentity })
  expect(readPanel).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(15_000)
  expect(readPanel).toHaveBeenCalledTimes(2)
  expect(publish).toHaveBeenCalledTimes(2)
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ observedAt: 1_800_000_000_000, status: 'active' }))
  client.close()
})
