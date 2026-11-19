export const DOUYIN_LOTTERY_FIXTURE_TARGET = { room: 'douyin:100', roomId: '9000000000000000001' }

export function douyinLotteryFixture(now = Date.now(), seconds = 90) {
  return {
    status_code: 0,
    data: {
      lottery_info: {
        lottery_id_str: '9000000000000000042',
        room_id_str: DOUYIN_LOTTERY_FIXTURE_TARGET.roomId,
        status: 1,
        current_time: Math.floor(now / 1000),
        draw_time: Math.floor(now / 1000) + seconds,
        prize_info: { type: 1, name: '测试虚拟币', prize_description: '离线合成奖励' },
        prize_count: 100,
        lucky_count: 5,
        conditions: [{ type: 3, content: '测试口令' }, { type: 6 }],
      },
    },
  }
}
