import { expect, it } from 'vitest'
import { huyaChatColorHex, readHuyaChatMetadata } from './huyaChat'

it('preserves validated colors and distinct identity fields through the renderer boundary', () => {
  const data = readHuyaChatMetadata({ kind: 'on-tv-barrage', textColor: 0, bulletColor: 0xfabcde,
    sender: { fansBadge: { name: '合成徽章', level: 7 }, nobleLevel: 1, roomAdmin: null, udb_uid: 'placeholder' } })
  expect(data).toEqual({ kind: 'on-tv-barrage', textColor: 0, bulletColor: 0xfabcde, sender: {
    userLevel: null, fansBadge: { name: '合成徽章', level: 7 }, nobleLevel: 1,
    guardLevel: null, superFan: null, roomAdmin: null,
  } })
  expect(huyaChatColorHex(data?.textColor)).toBe('#000000')
  expect(huyaChatColorHex(data?.bulletColor)).toBe('#fabcde')
})

it('ignores legacy type tags and keeps absent or malformed optional fields unknown', () => {
  expect(readHuyaChatMetadata({ msgType: 2 })).toBeNull()
  expect(readHuyaChatMetadata({ kind: 'text', textColor: -1, bulletColor: 'red',
    sender: { nobleLevel: '1', fansBadge: { name: '\x00', level: 7 } } })).toEqual({
    kind: 'text', textColor: null, bulletColor: null,
    sender: { userLevel: null, fansBadge: null, nobleLevel: null, guardLevel: null, superFan: null, roomAdmin: null },
  })
  expect(huyaChatColorHex(null)).toBeUndefined()
})
