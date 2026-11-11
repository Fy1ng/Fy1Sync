import { describe, expect, it } from 'vitest'
import { parseDouyuPcRoomStatus, parseDouyuRoomStatus } from './roomStatus'

export function pcRoomStatusFixture(room = '100', replay = 1, show = 1): string {
  const record = `2d:${JSON.stringify(['$', 'Room', null, { children: { roomInfo: { room: { room_id: Number(room), rid: Number(room), show_status: show, room_biz_all: { videoLoop: replay } } } } }])}\n`
  const split = Math.floor(record.length / 2)
  return [record.slice(0, split), record.slice(split)].map(part => `<script>self.__next_f.push(${JSON.stringify([1, part])})</script>`).join('')
}

describe('official Douyu stream and replay flags', () => {
  it.each([0, 1])('reads videoLoop=%i from the correct PC streamed room data', replay => {
    expect(parseDouyuPcRoomStatus(pcRoomStatusFixture('6979222', replay), '6979222')).toEqual({ live: true, replay: replay === 1 })
  })
  it('distinguishes offline from replay and preserves missing or conflicting flags', () => {
    expect(parseDouyuPcRoomStatus(pcRoomStatusFixture('100', 0, 2), '100')).toEqual({ live: false, replay: false })
    expect(parseDouyuRoomStatus({ room_id: '100', show_status: 1 }, '100')).toEqual({ live: true, replay: null })
    expect(parseDouyuRoomStatus({ room_id: '100', show_status: 1, videoLoop: 0, room_biz_all: { videoLoop: 1 } }, '100')).toEqual({ live: true, replay: null })
    expect(parseDouyuRoomStatus({ room_id: '200', show_status: 1, videoLoop: 0 }, '100')).toBeNull()
  })
  it('rejects wrong-room and contradictory records without evaluating page scripts', () => {
    expect(parseDouyuPcRoomStatus(pcRoomStatusFixture('200'), '100')).toBeNull()
    expect(parseDouyuPcRoomStatus(pcRoomStatusFixture('100', 0) + pcRoomStatusFixture('100', 1), '100')).toBeNull()
    expect(parseDouyuPcRoomStatus('<script>throw new Error("remote execution")</script>' + pcRoomStatusFixture(), '100')).toEqual({ live: true, replay: true })
    expect(parseDouyuPcRoomStatus('x'.repeat(2 * 1_048_576 + 1), '100')).toBeNull()
  })
})
