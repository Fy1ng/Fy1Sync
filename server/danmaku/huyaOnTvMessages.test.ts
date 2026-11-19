import { expect, it } from 'vitest'
import { decodeHuyaFrame, decodeHuyaPush } from './huyaProtocol'
import messages from './fixtures/huya-on-tv-messages.json'
import { huyaOnTvIdentity } from '../platforms/fixtures/huyaOnTvFixture'

const now = 1_800_000_000_000
const { room, presenterUid } = huyaOnTvIdentity
const frame = (hex: string) => decodeHuyaFrame(Buffer.from(hex, 'hex'), room, now, { presenterUid })

it('uses the 6298 notification, preserving same-text 1400 chat and its format and separate identities', () => {
  const [normal] = frame(messages.text).messages
  const [onTv] = frame(messages.onTv).messages
  expect(normal).toMatchObject({ text: 'replay-word', system: false, huyaChat: {
    kind: 'text', textColor: 0x11ff, bulletColor: null, sender: { nobleLevel: 0, fansBadge: null },
  } })
  expect(onTv).toMatchObject({ text: normal?.text, receivedAt: now, room, system: false, huyaChat: {
    kind: 'on-tv-barrage', textColor: null, bulletColor: null, sender: {
      userLevel: null, fansBadge: { name: 'badge-placeholder', level: 7 }, nobleLevel: 1,
      guardLevel: null, superFan: null, roomAdmin: null,
    },
  } })
  expect(onTv?.id).not.toBe(normal?.id)
  expect(onTv).not.toHaveProperty('huyaGift')
  expect(decodeHuyaPush(Buffer.from(messages.onTvPush, 'hex'), room, now, { presenterUid }).messages)
    .toEqual([onTv])
})

it('rejects absent or foreign presenter context and keeps unrelated notices unclassified', () => {
  expect(decodeHuyaFrame(Buffer.from(messages.onTv, 'hex'), room, now).messages).toHaveLength(0)
  expect(frame(messages.wrongPresenter).messages).toHaveLength(0)
  expect(frame(messages.unclassified)).toMatchObject({ messages: [], unknownUriCounts: { '6297': 1 } })
})
