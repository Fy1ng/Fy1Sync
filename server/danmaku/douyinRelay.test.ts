import { afterEach, describe, expect, it, vi } from 'vitest'
import { DanmakuRelay } from './relay'
import type { DanmakuClientEvents } from './types'

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers()
  const clients = new Map<string, { events: DanmakuClientEvents; connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>()
  const relay = new DanmakuRelay({ createClient: (platform, room, events) => {
    const client = { events, state: 'idle' as const, connect: vi.fn(() => events.onState('connecting')), close: vi.fn(() => events.onState('closed')) }
    clients.set(`${platform}:${room}`, client)
    return client
  } })
  return { relay, clients }
}

describe('Douyin receive session lifecycle', () => {
  it('shares one upstream per platform room and refreshes only Douyin after login changes', () => {
    const { relay, clients } = fixture()
    const write = vi.fn()
    relay.subscribe('douyin:100', { write, close() {} })
    relay.subscribe('douyin:100', { write() {}, close() {} })
    relay.subscribe('100', { write() {}, close() {} })
    const douyin = clients.get('douyin:100')!
    expect(clients.size).toBe(2)
    expect(douyin.connect).toHaveBeenCalledOnce()
    relay.refreshPlatform('douyin')
    expect(douyin.close).toHaveBeenCalledOnce()
    expect(douyin.connect).toHaveBeenCalledTimes(2)
    expect(clients.get('douyu:100')!.close).not.toHaveBeenCalled()
    expect(relay.subscriberCount('douyin:100')).toBe(2)
    expect(relay.reconnectRoom('douyin:100')).toBe(true)
    expect(douyin.connect).toHaveBeenCalledTimes(3)
    expect(relay.subscriberCount('douyin:100')).toBe(2)
    expect(relay.reconnectRoom('douyin:200')).toBe(false)
    relay.closeAll()
  })

  it('refreshes a manually reconnected room and drops its replay buffer', () => {
    const { relay, clients } = fixture()
    const off = relay.subscribe('douyin:100', { write() {}, close() {} })!
    const client = clients.get('douyin:100')!
    client.events.onMessage({ platform: 'douyin', room: 'douyin:100', id: 'old', text: '过期消息', username: 'fixture',
      color: 0, level: 0, receivedAt: 1, system: false })
    off()
    const write = vi.fn()
    relay.subscribe('douyin:100', { write, close() {} })
    expect(client.connect).toHaveBeenCalledTimes(2)
    expect(write.mock.calls.some(call => call[0] === 'danmaku')).toBe(false)
    relay.closeAll()
  })
})
