import { describe, expect, it } from 'vitest'
import {
  douyuGiftLabel, normalizeDouyuGift, normalizeDouyuSender, normalizeDouyuUid,
} from './douyuMetadata'

describe('Douyu public message metadata', () => {
  it('keeps known gift names in their correct gift/prop namespaces', () => {
    expect(douyuGiftLabel({ kind: 'prop', id: '268', count: 2 })).toBe('粉丝荧光棒')
    expect(douyuGiftLabel({ kind: 'gift', id: '824', count: 2 })).toBe('粉丝荧光棒')
    expect(douyuGiftLabel({ kind: 'gift', id: '268', count: 2 })).toBe('礼物 #268')
    expect(douyuGiftLabel({ kind: 'prop', id: '824', count: 2 })).toBe('道具 #824')
    expect(douyuGiftLabel({ kind: 'gift', id: '999999', count: 2 })).toBe('礼物 #999999')
  })

  it('rejects coercions and strips non-public metadata at the IPC boundary', () => {
    for (const invalid of [42, '042', ' 42 ', '42.0', '1e2', '0', '-1', 'x'.repeat(1_000)]) {
      expect(normalizeDouyuUid(invalid)).toBe('')
    }
    expect(normalizeDouyuSender({ uid: '42', level: 28, nobleLevel: 3, secret: 'discard' }))
      .toEqual({ uid: '42', level: 28, nobleLevel: 3 })
    expect(normalizeDouyuSender({ uid: 'x', level: Infinity, nobleLevel: '9' })).toBeUndefined()
    const gift = { kind: 'prop', id: '268', count: 2 }
    expect(normalizeDouyuGift({ ...gift, url: 'https://untrusted.invalid/', fakeName: '超火' })).toEqual(gift)
    for (const count of [0, -1, 0.5, NaN, Infinity, 1_000_001, '2']) {
      expect(normalizeDouyuGift({ ...gift, count })).toBeUndefined()
    }
    expect(normalizeDouyuGift({ kind: 'chat', id: '268', count: 1 })).toBeUndefined()
    expect(normalizeDouyuGift({ kind: 'gift', id: 'constructor', count: 1 })).toBeUndefined()
  })

  it('keeps the existing twenty-digit account UID contract without number conversion', () => {
    const uid = '99999999999999999999'
    expect(normalizeDouyuUid(uid)).toBe(uid)
    expect(normalizeDouyuUid(`${uid}9`)).toBe('')
  })

  it('retains bounded public fans-badge facts without guessing missing badges', () => {
    const badge = { room: '288016', name: '粉丝牌', level: 12 }
    const value = normalizeDouyuSender({ uid: '42', fansBadge: { ...badge, icon: 'https://untrusted.invalid/' } })!
    expect(value).toEqual({ uid: '42', fansBadge: badge })
    value.fansBadge!.name = 'changed'
    expect(badge.name).toBe('粉丝牌')
    for (const invalid of [{ ...badge, room: '01' }, { ...badge, level: 0 }, { ...badge, level: '2' }, { ...badge, name: 'bad\nname' }, { ...badge, name: 'x'.repeat(65) }]) {
      expect(normalizeDouyuSender({ uid: '42', fansBadge: invalid })).toEqual({ uid: '42' })
    }
  })
})
