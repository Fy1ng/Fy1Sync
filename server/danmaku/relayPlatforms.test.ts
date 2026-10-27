import { describe, expect, it, vi } from 'vitest'
import { DanmakuRelay, type RawDanmakuEvent } from './relay'
import type { ChatMessage, DanmakuClientEvents, DanmakuPlatform } from './types'

describe('platform-neutral danmaku relay', () => {
  function fixture() {
    const clients: Array<{ platform: DanmakuPlatform; room: string; events: DanmakuClientEvents; close: ReturnType<typeof vi.fn> }> = []
    const relay = new DanmakuRelay({ createClient: (platform, room, events) => {
      const client = { platform, room, events, state: 'idle' as const, connect: vi.fn(), close: vi.fn() }
      clients.push(client)
      return client
    } })
    const observed: RawDanmakuEvent[] = []
    relay.observe(event => observed.push(event))
    return { relay, clients, observed }
  }
  const subscriber = () => ({ write: vi.fn(), close: vi.fn() })
  const message: ChatMessage = { id: 'fixture', room: '660002', username: 'fixture', text: 'hello', color: 0, level: 0, receivedAt: 1000, system: false }

  it('shares explicit and legacy Douyu identities while separating the same Huya number', () => {
    const f = fixture()
    f.relay.subscribe('660002', subscriber())
    f.relay.subscribe('douyu:660002', subscriber())
    f.relay.subscribe('huya:660002', subscriber())
    expect(f.clients.map(({ platform, room }) => ({ platform, room }))).toEqual([
      { platform: 'douyu', room: '660002' }, { platform: 'huya', room: '660002' },
    ])
    expect(f.relay.roomCount).toBe(2)
    expect(f.relay.subscriberCount('660002')).toBe(2)
    expect(f.relay.subscriberCount('huya:660002')).toBe(1)
    f.relay.closeAll()
    expect(f.clients.every(client => client.close.mock.calls.length === 1)).toBe(true)
  })

  it('tags live messages, signals and states and preserves tags in bounded replay', () => {
    const f = fixture(), dy = subscriber(), hy = subscriber()
    f.relay.subscribe('660002', dy)
    f.relay.subscribe('huya:660002', hy)
    const events = f.clients[1]!.events
    events.onObservedMessage?.(message)
    events.onMessage(message)
    events.onState('connected')
    events.onSignal?.({ platform: 'huya', kind: 'viewers', room: '660002', receivedAt: 1000, count: 42 })
    expect(dy.write.mock.calls.filter(([type]) => type === 'danmaku')).toHaveLength(0)
    expect(hy.write).toHaveBeenCalledWith('danmaku', { ...message, platform: 'huya', room: 'huya:660002' })
    expect(f.observed).toEqual([
      { platform: 'huya', type: 'message', message: { ...message, platform: 'huya', room: 'huya:660002' } },
      { platform: 'huya', type: 'state', room: 'huya:660002', state: 'connected' },
      { platform: 'huya', type: 'signal', signal: { platform: 'huya', kind: 'viewers', room: 'huya:660002', receivedAt: 1000, count: 42 } },
    ])
    const late = subscriber()
    f.relay.subscribe('huya:660002', late)
    expect(late.write).toHaveBeenCalledWith('danmaku', { ...message, platform: 'huya', room: 'huya:660002' })
    expect(f.observed).toHaveLength(3)
    f.relay.closeAll()
  })
})
