import { expect, it } from 'vitest'
import { matchBilibiliLotteryMessage } from '../../src/core/bilibiliLottery'
import { parseBilibiliLottery } from '../platforms/bilibiliLottery'
import { bilibiliLotteryReplayFixture } from '../platforms/fixtures/bilibiliLottery'
import { parseBilibiliRoomEvent } from './bilibiliEvents'
import { bilibiliReplay } from './bilibiliReplayFixture'

it('replays same-room web chat against the activity history using original receipt time and keeps ambiguous text', () => {
  const room = '21452505'
  const replay = bilibiliLotteryReplayFixture()
  const history = replay.samples.map(sample => parseBilibiliLottery(sample.raw, room, sample.checkedAt))
  const messages = replay.messages.map(fixture => {
    const canonical = fixture.room.slice('bilibili:'.length)
    const raw = { cmd: 'DANMU_MSG', info: [
      [...Array(15).fill(null), { extra: JSON.stringify({ id_str: fixture.id }) }],
      fixture.text, [42, '测试观众'],
    ] }
    const message = parseBilibiliRoomEvent(raw, canonical, fixture.receivedAt)
    if (!message || 'kind' in message) throw new Error('Missing replay message')
    return { ...message, kind: fixture.kind }
  })
  expect(messages.map(message => matchBilibiliLotteryMessage(message, history)?.activityId ?? null))
    .toEqual(replay.expectedActivityIds)
  for (const message of messages.slice(0, 2)) {
    expect(message.text).toBe('测试口令')
    expect(matchBilibiliLotteryMessage(message, history)).toMatchObject({ kind: 'same-text-clue', automatic: null, participated: null })
  }
  const picture = { ...messages[0]!, bilibiliEmoteKind: 'image' as const }
  expect(matchBilibiliLotteryMessage(picture, history)).toBeNull()
  const sc = parseBilibiliRoomEvent({ ...bilibiliReplay.superChat, data: {
    ...bilibiliReplay.superChat.data, room_id: Number(room), message: messages[0]!.text,
  } }, room, messages[0]!.receivedAt)
  if (!sc || 'kind' in sc) throw new Error('Missing replay SC')
  expect(matchBilibiliLotteryMessage(sc, history)).toBeNull()
})
