import { describe, expect, it } from 'vitest'
import { DeliveryTracker } from './deliveryTracker'
import type { ChatMessage } from './douyuProtocol'

const input = { accountId: 'a', room: '1', uid: '42', text: 'hello', color: 0 }
const echo = (changes: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'c1', room: '1', text: 'hello', username: 'viewer',
  color: 0, level: 1, receivedAt: 1_100, system: false, sender: { uid: '42' }, ...changes })

describe('independent delivery evidence', () => {
  it('records a room echo independently from gateway acknowledgement and returns detached metadata', () => {
    const tracker = new DeliveryTracker({ now: () => 1_000, id: () => 'send-1' })
    const id = tracker.begin(input)
    expect(tracker.observe(echo())).toBe(id)
    expect(tracker.get(id)).toMatchObject({ gateway: 'pending', roomEcho: 'observed' })
    tracker.accept(id)
    expect(tracker.get(id)).toMatchObject({ gateway: 'accepted', roomEcho: 'observed', messageId: 'c1' })
    const view = tracker.get(id)!
    view.roomEcho = 'pending'
    expect(tracker.get(id)!.roomEcho).toBe('observed')
    expect(JSON.stringify(tracker.get(id))).not.toMatch(/hello|viewer|"uid"/)
  })

  it('keeps accepted-without-echo distinct from failure after the observation window', () => {
    let now = 1_000
    const tracker = new DeliveryTracker({ now: () => now, windowMs: 1_000 })
    const id = tracker.begin(input)
    tracker.accept(id)
    now = 2_000
    expect(tracker.get(id)).toMatchObject({ gateway: 'accepted', roomEcho: 'not-observed' })
    expect(tracker.observe(echo({ receivedAt: 2_000 }))).toBeNull()
  })

  it('rejects mismatched identities, rooms, text, colors, old messages and gift notices', () => {
    const tracker = new DeliveryTracker({ now: () => 1_000 })
    tracker.begin(input)
    for (const change of [{ sender: { uid: '43' } }, { room: '2' }, { text: 'other' }, { color: 2 }, { receivedAt: 999 }, { system: true }]) {
      expect(tracker.observe(echo(change))).toBeNull()
    }
    expect(tracker.observe(echo())).not.toBeNull()
  })

  it('does not attribute ambiguous identical sends or reuse one public message twice', () => {
    let sequence = 0
    const tracker = new DeliveryTracker({ now: () => 1_000, id: () => 'send-' + ++sequence })
    const a = tracker.begin(input)
    const b = tracker.begin(input)
    expect(tracker.observe(echo())).toBeNull()
    tracker.reject(b)
    expect(tracker.observe(echo())).toBe(a)
    tracker.begin(input)
    expect(tracker.observe(echo())).toBeNull()
  })

  it('never revives a cancelled account with a late receipt or echo and bounds records', () => {
    let sequence = 0
    const tracker = new DeliveryTracker({ now: () => 1_000, id: () => 'send-' + ++sequence, capacity: 2 })
    const a = tracker.begin(input)
    tracker.cancelAccount('a')
    tracker.accept(a)
    expect(tracker.observe(echo())).toBeNull()
    expect(tracker.get(a)).toMatchObject({ gateway: 'unknown', roomEcho: 'not-observed' })
    tracker.begin({ ...input, text: 'second' })
    tracker.begin({ ...input, text: 'third' })
    expect(tracker.list()).toHaveLength(2)
    expect(tracker.get(a)).toBeNull()
  })
})
