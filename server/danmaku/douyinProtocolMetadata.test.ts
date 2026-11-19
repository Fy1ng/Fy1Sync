import { describe, expect, it } from 'vitest'
import { decodeDouyinFrame, douyinProtoField as field } from './douyinProtocol'
import { joinDouyinBytes as join, syntheticDouyinFrame, syntheticDouyinIds as ids } from './fixtures/douyin-synthetic'

const anchorId = '9000000000000000100'
const common = (roomId = ids.roomId, messageId = ids.messageId) => join(field(2, BigInt(messageId)), field(3, BigInt(roomId)))
function envelope(method: string, payload: Uint8Array): Uint8Array {
  return join(field(1, method), field(2, payload), field(3, BigInt(ids.messageId)))
}
function chat(extra: Uint8Array = new Uint8Array(), user: Uint8Array = field(3, 'synthetic-viewer')): Uint8Array {
  return envelope('WebcastChatMessage', join(field(1, common()), field(2, user), field(3, '冲鸭 🦆'), extra))
}
function emoji(options: { image?: Uint8Array; defaultText?: string; pattern?: string; roomId?: string; pieces?: Uint8Array[] } = {}): Uint8Array {
  const rich = join(field(2, options.pattern ?? ''), ...(options.image ? [field(4, field(25, field(1, options.image)))] : []),
    ...(options.pieces ?? []).map(piece => field(4, piece)))
  return envelope('WebcastEmojiChatMessage', join(field(1, common(options.roomId)), field(2, field(3, 'synthetic-viewer')),
    field(3, 9000000000000000004n), field(4, rich), ...(options.defaultText === undefined ? [] : [field(5, options.defaultText)])))
}
function gift(options: { extra?: Uint8Array; gift?: Uint8Array; roomId?: string } = {}): Uint8Array {
  const details = options.gift ?? join(field(5, 9000000000000000005n), field(16, '合成礼物'), field(12, 10n), field(10, 1n), field(11, 1n))
  return envelope('WebcastGiftMessage', join(field(1, common(options.roomId)), field(2, 9000000000000000005n),
    field(7, join(field(3, 'synthetic-viewer'), field(5, 'synthetic-private-signature'), field(8, 'synthetic-private-phone'))),
    field(8, join(field(1, 9000000000000000006n), field(3, '合成嘉宾'))), field(15, details), options.extra ?? new Uint8Array()))
}
const decode = (messages: Uint8Array[], context = {}) => decodeDouyinFrame(syntheticDouyinFrame({ messages }), ids.webRoom, ids.roomId, 1234, context)

describe('Douyin protocol metadata from offline schema fixtures', () => {
  it('keeps ordinary Unicode emoji as text without native image metadata', () => {
    expect(decode([chat()]).messages[0]).toMatchObject({ text: '冲鸭 🦆', level: 0, douyin: { method: 'WebcastChatMessage', roomId: ids.roomId } })
    expect(decode([chat()]).messages[0]?.douyin.emoji).toBeUndefined()
  })
  it('marks display-normalized chat as ineligible for exact command matching', () => {
    const raw = envelope('WebcastChatMessage', join(field(1, common()), field(2, field(3, 'synthetic-viewer')), field(3, ' 合成口令 ')))
    expect(decode([raw]).messages[0]).toMatchObject({ text: '合成口令', douyin: { plainTextExact: false } })
  })
  it('retains a native emoji ID, safe resource and independent text fallback', () => {
    const image = join(field(1, 'https://p3-webcast.douyinpic.com/synthetic-emoji.webp'), field(3, 48n), field(4, 64n),
      field(8, field(4, '[合成欢呼]')), field(9, 1n))
    expect(decode([emoji({ image, defaultText: '[欢呼]' })]).messages[0]).toMatchObject({ text: '[欢呼]', system: false,
      douyin: { emoji: { id: '9000000000000000004', fallback: '[欢呼]', images: [{ url: 'https://p3-webcast.douyinpic.com/synthetic-emoji.webp',
        fallback: '[合成欢呼]', width: 64, height: 48, animated: true }] } } })
  })
  it('falls back with missing resources, alt-only rich text and unresolved templates', () => {
    const results = decode([emoji({ defaultText: '[缺资源]' }), emoji({ image: field(8, field(4, '[图片说明]')) }),
      emoji({ pattern: '{0:image}' }), emoji({ pattern: '[文本表情]' })]).messages
    expect(results.map(message => message.text)).toEqual(['[缺资源]', '[图片说明]', '[表情]', '[文本表情]'])
    expect(results[0]?.douyin.emoji?.images).toEqual([])
    expect(results[1]?.douyin.emoji?.images[0]?.url).toBeUndefined()
  })
  it.each(['javascript:alert(1)', 'data:image/png;base64,AA==', 'http://p3-webcast.douyinpic.com/emoji',
    'https://localhost/emoji', 'https://p3-webcast.douyinpic.com.evil.test/emoji', 'https://user:pass@p3-webcast.douyinpic.com/emoji',
    'https://p3-webcast.douyinpic.com:8443/emoji', 'https://p3-webcast.douyinpic.com/emoji#fragment'])('uses text fallback for an untrusted resource %s', url => {
    const message = decode([emoji({ image: join(field(1, url), field(8, field(4, '[安全回退]'))) })]).messages[0]
    expect(message?.text).toBe('[安全回退]')
    expect(message?.douyin.emoji?.images[0]?.url).toBeUndefined()
  })
  it('chooses a later safe image URL and bounds rich text pieces', () => {
    const image = join(field(1, 'https://evil.test/emoji'), field(1, 'https://p3-webcast.byteimg.com/synthetic-emoji.webp'))
    expect(decode([emoji({ image })]).messages[0]?.douyin.emoji?.images[0]?.url).toBe('https://p3-webcast.byteimg.com/synthetic-emoji.webp')
    expect(decode([chat(), emoji({ pieces: Array.from({ length: 65 }, () => field(11, 'synthetic')) })])).toMatchObject({ malformed: true, messages: [] })
  })
  it('reads consumption grade separately from generic User.level and live fans club grade', () => {
    const fans = join(field(1, '合成粉丝团'), field(2, 8n), field(3, 1n), field(6, BigInt(anchorId)))
    const user = join(field(3, 'synthetic-viewer'), field(6, 99n), field(23, field(6, 32n)), field(24, field(1, fans)))
    expect(decode([chat(new Uint8Array(), user)], { anchorId }).messages[0]).toMatchObject({ level: 32, douyin: { sender: {
      consumptionLevel: 32, liveFansClub: { name: '合成粉丝团', level: 8, anchorId, statusCode: 1, membership: 'member', lit: true, currentRoom: true },
    } } })
  })
  it.each([{ status: 0n, membership: 'non-member', lit: false }, { status: 2n, membership: 'member', lit: false },
    { status: 3n, membership: 'unknown', lit: null }])('keeps verified live club status %s distinct from shopping club status', ({ status, membership, lit }) => {
    const user = field(24, field(1, join(field(3, status), field(6, BigInt(anchorId)))))
    const message = decode([chat(new Uint8Array(), user)], { anchorId }).messages[0]
    expect(message?.douyin.sender?.liveFansClub).toMatchObject({ statusCode: Number(status), membership, lit, currentRoom: true })
    expect(message?.douyin.sender?.consumptionLevel).toBeUndefined()
  })
  it('leaves missing grade and club status unknown and does not claim another anchor belongs to the room', () => {
    const user = join(field(6, 99n), field(23, field(6, 0n)), field(24, field(1, field(6, BigInt(anchorId)))))
    const message = decode([chat(new Uint8Array(), user)]).messages[0]
    expect(message?.douyin.sender).toMatchObject({ consumptionLevel: 0, liveFansClub: { membership: 'unknown', lit: null, currentRoom: null } })
    expect(message?.douyin.sender?.liveFansClub?.level).toBeUndefined()
    expect(decode([chat(new Uint8Array(), user)], { anchorId: '123' }).messages[0]?.douyin.sender?.liveFansClub?.currentRoom).toBe(false)
    expect(decode([chat(new Uint8Array(), field(6, 99n))]).messages[0]?.douyin.sender).toBeUndefined()
  })
  it('preserves gift IDs, all distinct counts, group evidence, price and recipient without a fabricated total', () => {
    const message = decode([gift({ extra: join(field(44, 2n), field(29, 8n), field(4, 4n), field(5, 2n), field(6, 3n),
      field(11, 9000000000000000007n), field(9, 1n), field(3, 999n)) })]).messages[0]
    expect(message).toMatchObject({ system: true, username: 'synthetic-viewer', text: '送出 合成礼物 x2 给 合成嘉宾', douyin: { gift: {
      id: '9000000000000000005', name: '合成礼物', recipient: { id: '9000000000000000006', name: '合成嘉宾' },
      count: '2', totalCount: '8', groupCount: '4', repeatCount: '2', comboCount: '3', groupId: '9000000000000000007',
      repeatEnd: 1, combo: true, type: 1, fanTicketCount: '999', unitDiamonds: '10', totalDiamonds: null, valueReason: 'unverified-count-semantics',
    } } })
    expect(JSON.stringify(message)).not.toMatch(/synthetic-private/)
  })
  it('keeps missing count and price unknown, preserves explicit zero, and never treats repeats as gift count', () => {
    const missing = decode([gift({ gift: new Uint8Array(), extra: field(5, 12n) })]).messages[0]?.douyin.gift
    expect(missing).toMatchObject({ repeatCount: '12', valueReason: 'missing-unit-price', totalDiamonds: null })
    expect(missing?.count).toBeUndefined()
    expect(missing?.unitDiamonds).toBeUndefined()
    const unbound = decode([gift({ gift: field(12, 0n) })]).messages[0]?.douyin.gift
    expect(unbound?.unitDiamonds).toBeUndefined()
    const zero = decode([gift({ gift: join(field(5, 9000000000000000005n), field(12, 0n)), extra: field(44, 0n) })]).messages[0]?.douyin.gift
    expect(zero).toMatchObject({ count: '0', unitDiamonds: '0', totalDiamonds: null })
  })
  it('does not reuse name, price or combo from a conflicting gift ID', () => {
    const metadata = decode([gift({ gift: join(field(5, 123n), field(12, 50n), field(16, '其他礼物'), field(10, 0n)) })]).messages[0]?.douyin.gift
    expect(metadata).toMatchObject({ id: '9000000000000000005', valueReason: 'gift-id-mismatch', totalDiamonds: null })
    expect(metadata?.name).toBeUndefined()
    expect(metadata?.unitDiamonds).toBeUndefined()
    expect(metadata?.combo).toBeUndefined()
  })
  it('keeps 64-bit quantities exact and does not wrap signed prices or grades into a positive value', () => {
    const message = decode([gift({ gift: join(field(5, 9000000000000000005n), field(12, 0xffff_ffff_ffff_ffffn)), extra: field(44, 0xffff_ffff_ffff_ffffn) })]).messages[0]
    expect(message?.douyin.gift?.count).toBe('18446744073709551615')
    expect(message?.douyin.gift?.unitDiamonds).toBeUndefined()
    const user = field(23, field(6, 0xffff_ffff_ffff_ffffn))
    expect(decode([chat(new Uint8Array(), user)]).messages[0]?.douyin.sender).toBeUndefined()
  })
  it('retains chat_by as an uninterpreted clue and emits room announcements as system messages', () => {
    const announcement = envelope('WebcastRoomMessage', join(field(1, common()), field(2, '合成开奖公告'), field(4, 5n), field(20, 'synthetic-scene')))
    const result = decode([chat(), chat(field(20, 0n)), chat(field(20, 18446744073709551615n)), announcement])
    expect(result.messages.map(message => message.douyin.chatBy)).toEqual([undefined, '0', '18446744073709551615', undefined])
    expect(result.messages[3]).toMatchObject({ text: '合成开奖公告', username: '系统', system: true,
      douyin: { method: 'WebcastRoomMessage', roomMessage: { type: 5, bizScene: 'synthetic-scene' } } })
    expect(result.messages.slice(0, 3).every(message => !message.system)).toBe(true)
  })
  it('rejects other-room native emoji and gifts, and leaves activity methods unsupported', () => {
    const unknown = ['WebcastLotteryMessage', 'WebcastLuckyBoxMessage', 'WebcastEcomFansClubMessage']
      .map(method => envelope(method, Uint8Array.from([255])))
    expect(decode([emoji({ roomId: '999' }), gift({ roomId: '999' }), ...unknown])).toMatchObject({ malformed: false, messages: [], unknownMessages: 3 })
  })
  it('rejects conflicting singleton metadata and malformed gift payloads without partial delivery', () => {
    expect(decode([chat(), gift({ extra: join(field(44, 1n), field(44, 2n)) })])).toMatchObject({ malformed: true, messages: [] })
    expect(decode([chat(), envelope('WebcastGiftMessage', Uint8Array.from([255]))])).toMatchObject({ malformed: true, messages: [] })
    expect(decode([chat()], { anchorId: 'invalid' })).toMatchObject({ malformed: true, messages: [] })
  })
})
