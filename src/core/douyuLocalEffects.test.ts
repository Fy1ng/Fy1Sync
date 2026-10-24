import { describe, expect, it } from 'vitest'
import {
  douyuGiftLabel, hasLocalPhantomIdentity, localGiftEffectFor, LocalGiftEffectSlots,
  LOCAL_GIFT_EFFECT_DURATION_MS, MAX_LOCAL_GIFT_EFFECTS,
  normalizeDouyuGift, normalizeDouyuSender, normalizeDouyuUid,
} from './douyuLocalEffects'
import type { DanmakuMessage } from './danmakuTimeline'

const message: DanmakuMessage = {
  id: 'real-event', user: '原昵称', text: '粉丝荧光棒 x 2', color: '#fff', scheduleTime: 10, receivedAt: 100,
  sender: { uid: '42', level: 28, nobleLevel: 3 }, gift: { kind: 'prop', id: '268', count: 2 },
}

describe('local Douyu presentation boundary', () => {
  it('matches the chosen UID only when enabled and never decorates gift notices as chat', () => {
    const chat = { sender: message.sender }
    const settings = { localPhantomIdentity: true, localPhantomUid: '42' }
    expect(hasLocalPhantomIdentity(chat, settings)).toBe(true)
    expect(hasLocalPhantomIdentity(chat, { ...settings, localPhantomIdentity: false })).toBe(false)
    expect(hasLocalPhantomIdentity(chat, { ...settings, localPhantomUid: '43' })).toBe(false)
    expect(hasLocalPhantomIdentity(chat, { ...settings, localPhantomUid: '' })).toBe(false)
    expect(hasLocalPhantomIdentity({}, settings)).toBe(false)
    expect(hasLocalPhantomIdentity(message, settings)).toBe(false)
  })

  it('builds a local visual from a real supported gift without changing its source', () => {
    const original = structuredClone(message)
    Object.freeze(message.sender)
    Object.freeze(message.gift)
    Object.freeze(message)
    expect(localGiftEffectFor(message, false)).toBeNull()
    expect(localGiftEffectFor(message, true)).toEqual({
      messageId: 'real-event', senderName: '原昵称', originalGift: '粉丝荧光棒', count: 2,
    })
    expect(message).toEqual(original)
  })

  it('does not reinterpret chat text, unknown gifts or mismatched gift/prop namespaces', () => {
    const chat = { ...message, gift: undefined, text: '荧光棒 x 100' }
    expect(localGiftEffectFor(chat, true)).toBeNull()
    expect(localGiftEffectFor({ ...message, gift: { kind: 'gift', id: '268', count: 2 } }, true)).toBeNull()
    expect(localGiftEffectFor({ ...message, gift: { kind: 'prop', id: '824', count: 2 } }, true)).toBeNull()
    expect(localGiftEffectFor({ ...message, gift: { kind: 'gift', id: '999999', count: 2 } }, true)).toBeNull()
    expect(localGiftEffectFor({ ...message, gift: { kind: 'gift', id: '824', count: 2 } }, true)?.originalGift).toBe('粉丝荧光棒')
    expect(douyuGiftLabel({ kind: 'gift', id: '999999', count: 2 })).toBe('礼物 #999999')
  })

  it('rejects coercions and strips non-public metadata at the IPC boundary', () => {
    for (const invalid of [42, '042', ' 42 ', '42.0', '1e2', '0', '-1', 'x'.repeat(1_000)]) {
      expect(normalizeDouyuUid(invalid)).toBe('')
    }
    expect(normalizeDouyuSender({ uid: '42', level: 28, nobleLevel: 3, secret: 'discard' })).toEqual(message.sender)
    expect(normalizeDouyuSender({ uid: 'x', level: Infinity, nobleLevel: '9' })).toBeUndefined()
    expect(normalizeDouyuGift({ ...message.gift, url: 'https://untrusted.invalid/', fakeName: '超火' })).toEqual(message.gift)
    for (const count of [0, -1, 0.5, NaN, Infinity, 1_000_001, '2']) {
      expect(normalizeDouyuGift({ ...message.gift, count })).toBeUndefined()
    }
    expect(normalizeDouyuGift({ kind: 'chat', id: '268', count: 1 })).toBeUndefined()
    expect(normalizeDouyuGift({ kind: 'gift', id: 'constructor', count: 1 })).toBeUndefined()
  })

  it('keeps the existing twenty-digit account UID contract without number conversion', () => {
    const uid = '99999999999999999999'
    expect(normalizeDouyuUid(uid)).toBe(uid)
    expect(normalizeDouyuUid(`${uid}9`)).toBe('')
    expect(hasLocalPhantomIdentity({ sender: { uid } }, { localPhantomIdentity: true, localPhantomUid: uid })).toBe(true)
  })
})

describe('bounded local gift occupancy', () => {
  it('has fixed occupancy regardless of event counts or bursts and never stores a backlog', () => {
    const slots = new LocalGiftEffectSlots()
    const admitted = Array.from({ length: 1_000 }, (_, index) => slots.take(`gift-${index}`, 100)).filter(slot => slot !== null)
    expect(admitted).toEqual(Array.from({ length: MAX_LOCAL_GIFT_EFFECTS }, (_, index) => index))
    expect(slots.take('late', 100 + LOCAL_GIFT_EFFECT_DURATION_MS - 1)).toBeNull()
    expect(slots.take('fresh', 100 + LOCAL_GIFT_EFFECT_DURATION_MS)).toBe(0)
  })

  it('drops duplicate active events and immediately frees slots when switched off', () => {
    const slots = new LocalGiftEffectSlots()
    expect(slots.take('same', 100)).toBe(0)
    expect(slots.take('same', 200)).toBeNull()
    expect(slots.take('bad-time', NaN)).toBeNull()
    slots.clear()
    expect(slots.take('new', 200)).toBe(0)
  })
})
