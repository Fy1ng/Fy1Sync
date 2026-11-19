import type { BilibiliLotteryMessage } from '../../../src/core/bilibiliLottery'

export const bilibiliLotteryFixtureSource = {
  kind: 'synthetic',
  sourceCommit: 'ddc420a6c432329ba5cebc6a8fdd2ca36729fe07',
  inspectedAt: '2026-11-17',
  metadataSource: '旧 05 记录的官方网页资源 lotteryUser.f511da66.js 和 102.a9b57d6d.js',
  gap: '未捕获真实同房活动及对应弹幕. 活动时间, 活动 ID, 手打与自动标签均为合成测试设计. 未确认任何自动口令标记或参与成功.',
} as const

export const BILIBILI_LOTTERY_FIXTURE_NOW = 1_794_844_800_000
export const bilibiliLotteryFixture = (patch: Record<string, unknown> = {}) => ({ code: 0, data: {
  id: 771, room_id: 21452505, award_name: '主播提供的测试奖品', award_num: 3, join_type: 0, require_type: 1,
  require_value: 0, require_text: '关注主播', danmu: '测试口令', danmu_new: [{ danmu: '另一条精确口令' }, { danmu: ' 测试口令 ' }],
  status: 1, lot_status: 0, time: 90, current_timestamp: BILIBILI_LOTTERY_FIXTURE_NOW / 1000, ...patch,
} })

export function bilibiliLotteryMessageFixture(patch: Partial<BilibiliLotteryMessage> = {}): BilibiliLotteryMessage {
  return { id: 'synthetic-hand-typed', platform: 'bilibili', room: 'bilibili:21452505',
    text: '测试口令', receivedAt: BILIBILI_LOTTERY_FIXTURE_NOW + 5_000, system: false, kind: 'chat', ...patch }
}

export function bilibiliLotteryReplayFixture() {
  const now = BILIBILI_LOTTERY_FIXTURE_NOW
  return {
    provenance: bilibiliLotteryFixtureSource,
    samples: [
      { checkedAt: now, raw: bilibiliLotteryFixture() },
      { checkedAt: now + 30_000, raw: bilibiliLotteryFixture({ id: 772, current_timestamp: (now + 30_000) / 1000,
        danmu: '下一轮口令', danmu_new: [], time: 60 }) },
      { checkedAt: now + 60_000, raw: { code: 0, data: null } },
    ],
    messages: [
      bilibiliLotteryMessageFixture(),
      bilibiliLotteryMessageFixture({ id: 'synthetic-alleged-auto-without-marker' }),
      bilibiliLotteryMessageFixture({ id: 'synthetic-second-candidate', text: '另一条精确口令' }),
      bilibiliLotteryMessageFixture({ id: 'synthetic-announcement', kind: 'announcement', text: '测试口令' }),
      bilibiliLotteryMessageFixture({ id: 'synthetic-wrong-room', room: 'bilibili:21452506' }),
      bilibiliLotteryMessageFixture({ id: 'synthetic-previous-activity', receivedAt: now + 35_000 }),
      bilibiliLotteryMessageFixture({ id: 'synthetic-next-activity', text: '下一轮口令', receivedAt: now + 35_000 }),
      bilibiliLotteryMessageFixture({ id: 'synthetic-after-empty', text: '下一轮口令', receivedAt: now + 65_000 }),
    ],
    expectedActivityIds: ['771', '771', '771', null, null, null, '772', null],
  }
}
