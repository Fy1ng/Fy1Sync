import { describe, expect, it, vi } from 'vitest'
import { HuyaRoomClient } from './huyaRoomClient'
import type { HuyaSource } from './huyaRoomClient'
import type { ChatMessage, DanmakuClientEvents, DanmakuState } from './types'

function fixture() {
  let now = 1000
  const ports = {} as Record<HuyaSource, DanmakuClientEvents>
  const close = { cdnws: vi.fn(), slice: vi.fn() }
  const connect = { cdnws: vi.fn(), slice: vi.fn() }
  const events = { onMessage: vi.fn(), onObservedMessage: vi.fn(), onSignal: vi.fn(), onState: vi.fn() }
  const client = new HuyaRoomClient('660002', events, { now: () => now, createSource: (source, callbacks) => {
    ports[source] = callbacks
    return { get state(): DanmakuState { return 'idle' }, connect: connect[source], close: close[source],
      diagnostics: { requests: 1 } }
  } })
  client.connect()
  const message = (id: number, system = false): ChatMessage => ({
    id: 'huya:660002:' + (system ? 6501 : 1400) + ':' + id, platform: 'huya', room: '660002',
    text: system ? '赠送虎粮 x2' : 'fixture chat', username: 'viewer-placeholder',
    color: 0, level: 0, system, receivedAt: now, ...(system ? { huyaGift: { id: '4', count: 2, name: '虎粮' } } : {}),
  })
  const receive = (source: HuyaSource, value: ChatMessage) => {
    ports[source].onObservedMessage?.(value)
    ports[source].onMessage(value)
  }
  return { client, ports, close, connect, events, message, receive, advance: (ms: number) => { now += ms } }
}
describe('Huya independent transports merged by lMsgId', () => {
  it('emits cross-source chat, gifts and signals exactly once before relay observation or presentation', () => {
    const f = fixture()
    for (const source of ['cdnws', 'slice'] as const) {
      f.receive(source, f.message(123))
      f.receive(source, f.message(124, true))
      f.ports[source].onSignal?.({ platform: 'huya', kind: 'viewers', room: '660002', receivedAt: 1000, count: 10, messageId: '125' })
    }
    expect(f.events.onMessage).toHaveBeenCalledTimes(2)
    expect(f.events.onObservedMessage).toHaveBeenCalledTimes(2)
    expect(f.events.onSignal).toHaveBeenCalledOnce()
    expect(f.client.diagnostics).toMatchObject({ duplicates: 3, crossSourceDuplicates: 3,
      coverage: { bothChats: 1, bothGifts: 1, bothSignals: 1, cdnwsOnlyChats: 0, sliceOnlyChats: 0 } })
    expect(f.client.diagnostics.sources).toMatchObject({
      cdnws: { chats: 1, gifts: 1, signals: 1 }, slice: { chats: 1, gifts: 1, signals: 1 },
    })
    f.client.close()
  })

  it('keeps equal text with different message IDs and accepts chat present in only one source', () => {
    const f = fixture()
    f.receive('cdnws', f.message(1))
    f.receive('slice', f.message(2))
    f.receive('slice', f.message(2))
    expect(f.events.onMessage).toHaveBeenCalledTimes(2)
    expect(f.client.diagnostics).toMatchObject({ sameSourceRepeats: 1,
      coverage: { cdnwsOnlyChats: 1, sliceOnlyChats: 1, bothChats: 0 } })
    f.receive('cdnws', f.message(2))
    expect(f.client.diagnostics.coverage).toMatchObject({ cdnwsOnlyChats: 1, sliceOnlyChats: 0, bothChats: 1 })
    f.client.close()
  })

  it('does not collapse equal numeric IDs in different URI namespaces', () => {
    const f = fixture()
    f.receive('cdnws', f.message(1))
    f.receive('slice', f.message(1, true))
    expect(f.events.onMessage).toHaveBeenCalledTimes(2)
    f.client.close()
  })

  it('continues receiving from either source while the other fails, and synthesizes OR-connected state', () => {
    const f = fixture()
    f.ports.cdnws.onState('connected')
    f.ports.slice.onState('reconnecting', 'upstream token=secret URL')
    expect(f.client.state).toBe('connected')
    f.receive('cdnws', f.message(1))
    f.ports.cdnws.onState('reconnecting')
    expect(f.client.state).toBe('reconnecting')
    f.ports.slice.onState('connected')
    f.receive('slice', f.message(2))
    expect(f.client.state).toBe('connected')
    expect(f.events.onMessage).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(f.events.onState.mock.calls)).not.toMatch(/secret|token|URL/)
    f.client.close()
    f.ports.slice.onState('connected')
    f.receive('cdnws', f.message(3))
    expect(f.client.state).toBe('closed')
    expect(f.events.onMessage).toHaveBeenCalledTimes(2)
    expect(f.close.cdnws).toHaveBeenCalledOnce()
    expect(f.close.slice).toHaveBeenCalledOnce()
  })

  it('ignores a source start exception without stopping the independent source', () => {
    const f = fixture()
    f.client.close()
    f.connect.cdnws.mockImplementationOnce(() => { throw Error('private') })
    f.client.connect()
    expect(f.connect.slice).toHaveBeenCalledTimes(2)
    f.ports.slice.onState('connected')
    f.receive('slice', f.message(1))
    expect(f.client.state).toBe('connected')
    expect(f.events.onMessage).toHaveBeenCalledOnce()
    f.client.close()
  })

  it('bounds ID retention and reports the bounded window separately from lifetime receive counters', () => {
    const f = fixture()
    for (let id = 1; id <= 8193; id++) f.receive('cdnws', f.message(id))
    expect(f.client.diagnostics.coverage).toMatchObject({ tracked: 8192, evicted: 1 })
    f.advance(10 * 60_000)
    expect(f.client.diagnostics.coverage).toMatchObject({ tracked: 0, expired: 8192 })
    f.receive('slice', f.message(8193))
    expect(f.events.onMessage).toHaveBeenCalledTimes(8194)
    expect(f.client.diagnostics.sources.cdnws.chats).toBe(8193)
    f.client.close()
  })

  it('only collapses equal no-ID viewer signals across sources for one second', () => {
    const f = fixture(), value = { platform: 'huya' as const, kind: 'viewers' as const, room: '660002', receivedAt: 1000, count: 10 }
    f.ports.cdnws.onSignal?.(value)
    f.ports.slice.onSignal?.(value)
    f.ports.cdnws.onSignal?.({ ...value, count: 11 })
    expect(f.events.onSignal).toHaveBeenCalledTimes(2)
    f.advance(1001)
    f.ports.slice.onSignal?.(value)
    expect(f.events.onSignal).toHaveBeenCalledTimes(3)
    expect(f.client.diagnostics).toMatchObject({ signalsWithoutId: 4, signalValueDuplicates: 1 })
    f.client.close()
  })

  it('applies gift presentation throttling after the shared observer and cross-source de-duplication', () => {
    const f = fixture()
    for (let id = 1; id <= 20; id++) {
      f.receive('cdnws', f.message(id, true))
      f.receive('slice', f.message(id, true))
    }
    expect(f.events.onObservedMessage).toHaveBeenCalledTimes(20)
    expect(f.events.onMessage).toHaveBeenCalledTimes(12)
    expect(f.client.diagnostics.duplicates).toBe(20)
    f.client.close()
  })
})
