import { describe, expect, it } from 'vitest'
import { parseDouyinLottery } from '../../server/douyin/douyinLotteryReader'
import { DOUYIN_LOTTERY_FIXTURE_TARGET as target, douyinLotteryFixture } from '../../server/douyin/fixtures/douyinLotteryFixture'
import { DOUYIN_LOTTERY_POLL_MS, matchDouyinLotteryComment, type DouyinLotteryComment } from './douyinLottery'

const observedAt = 1_795_000_000_000
const snapshot = parseDouyinLottery(douyinLotteryFixture(observedAt, 5), target, observedAt)
const comment: DouyinLotteryComment = {
  room: target.room, receivedAt: observedAt + 300, platform: 'douyin', text: '测试口令',
  douyin: { roomId: target.roomId, method: 'WebcastChatMessage', plainTextExact: true },
}

describe('ordinary lottery comment folding hints', () => {
  it('marks exact matching live comments as candidates, including indistinguishable manually typed comments', () => {
    expect(matchDouyinLotteryComment(snapshot, comment)).toEqual({
      ...target, kind: 'matching-command', activityId: '9000000000000000042',
    })
  })

  it.each([
    { text: '测试口令!' }, { text: ' 测试口令' }, { receivedAt: observedAt - 1 }, { receivedAt: observedAt + 5000 },
    { room: 'douyin:101' }, { platform: undefined }, { platform: 'huya' }, { system: true }, { douyin: undefined },
    { douyin: { roomId: '9000000000000000002', method: 'WebcastChatMessage', plainTextExact: true } },
    { douyin: { roomId: target.roomId, method: 'WebcastChatMessage', plainTextExact: false } },
    { douyin: { roomId: target.roomId, method: 'WebcastRoomMessage' } },
    { douyin: { roomId: target.roomId, method: 'WebcastGiftMessage' } },
    { douyin: { roomId: target.roomId, method: 'WebcastEmojiChatMessage' } },
  ] satisfies Array<Partial<DouyinLotteryComment>>)('preserves chat or announcements outside the exact scope, %j', override => {
    expect(matchDouyinLotteryComment(snapshot, { ...comment, ...override })).toBeNull()
  })

  it('expires old evidence, ignores empty and restricted snapshots, and requires the current exact command', () => {
    const fresh = douyinLotteryFixture(observedAt)
    const longRound = parseDouyinLottery(fresh, target, observedAt)
    expect(matchDouyinLotteryComment(longRound, { ...comment, receivedAt: observedAt + DOUYIN_LOTTERY_POLL_MS })).toBeNull()
    expect(matchDouyinLotteryComment(parseDouyinLottery({ status_code: 0, data: {} }, target, observedAt), comment)).toBeNull()
    expect(matchDouyinLotteryComment(parseDouyinLottery({ status_code: 403 }, target, observedAt), comment)).toBeNull()
    fresh.data.lottery_info.conditions[0]!.content = '变更口令'
    const changed = parseDouyinLottery(fresh, target, observedAt)
    expect(matchDouyinLotteryComment(changed, comment)).toBeNull()
    expect(matchDouyinLotteryComment(changed, { ...comment, text: '变更口令' })?.activityId).toBe(fresh.data.lottery_info.lottery_id_str)
  })
})
