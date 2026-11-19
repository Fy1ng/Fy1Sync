import { describe, expect, it } from 'vitest'
import { matchBilibiliLotteryMessage } from './bilibiliLottery'
import { parseBilibiliLottery, bilibiliLotteryEmpty } from '../../server/platforms/bilibiliLottery'
import { BILIBILI_LOTTERY_FIXTURE_NOW as NOW, bilibiliLotteryFixture, bilibiliLotteryMessageFixture, bilibiliLotteryReplayFixture } from '../../server/platforms/fixtures/bilibiliLottery'

const sample = (patch: Record<string, unknown> = {}, checkedAt = NOW) => parseBilibiliLottery(bilibiliLotteryFixture(patch), '21452505', checkedAt)

describe('Bilibili same-room same-text replay', () => {
  it('replays the P07 room/activity timeline without labeling the alleged automatic sender', () => {
    const replay = bilibiliLotteryReplayFixture()
    const snapshots = replay.samples.map(sample => parseBilibiliLottery(sample.raw, '21452505', sample.checkedAt))
    expect(replay.messages.map(message => matchBilibiliLotteryMessage(message, snapshots)?.activityId ?? null))
      .toEqual(replay.expectedActivityIds)
    expect(replay.provenance.kind).toBe('synthetic')
  })
  it.each(['测试口令', '另一条精确口令', ' 测试口令 '])('emits only a clue for exact candidate %s', text => {
    expect(matchBilibiliLotteryMessage(bilibiliLotteryMessageFixture({ text }), [sample()])).toMatchObject({
      kind: 'same-text-clue', room: '21452505', activityId: '771', text, automatic: null, participated: null,
      serverReceivedAt: NOW + 5000,
    })
  })
  it('does not infer automatic sending from synthetic labels, duplicate text or unconfirmed flags', () => {
    const manual = bilibiliLotteryMessageFixture()
    const allegedAutomatic = { ...manual, id: 'synthetic-auto', lotteryId: 771, isLottery: true }
    expect(matchBilibiliLotteryMessage(manual, [sample()])?.kind).toBe('same-text-clue')
    expect(matchBilibiliLotteryMessage(allegedAutomatic, [sample()])?.automatic).toBeNull()
  })
  it.each(['测试', '测试口令!', ' 测试口令', '另一条精确口令 ', '测试口令\n'])('rejects inexact text %s', text => {
    expect(matchBilibiliLotteryMessage(bilibiliLotteryMessageFixture({ text }), [sample()])).toBeNull()
  })
  it.each([{ system: true }, { kind: 'announcement' as const }, { kind: 'super-chat' as const },
    { kind: 'gift' as const }, { room: 'bilibili:21452506' }, { room: 'douyu:21452505' }])('keeps ordinary unrelated message visible %j', patch => {
    expect(matchBilibiliLotteryMessage(bilibiliLotteryMessageFixture(patch), [sample()])).toBeNull()
  })
  it('uses arrival time and official anchor rather than rendering time or skewed client time', () => {
    const skew = -3600_000
    const snapshots = [sample({}, NOW + skew), sample({ id: 772, current_timestamp: (NOW + 30_000) / 1000 }, NOW + skew + 30_000)]
    const delayed = bilibiliLotteryMessageFixture({ receivedAt: NOW + skew + 5000 })
    expect(matchBilibiliLotteryMessage(delayed, snapshots)).toMatchObject({ activityId: '771', serverReceivedAt: NOW + 5000 })
    expect(matchBilibiliLotteryMessage({ ...delayed, receivedAt: NOW + skew + 35_000 }, snapshots)?.activityId).toBe('772')
  })
  it('rejects expired, uncertain boundary, stale and retroactive matching', () => {
    for (const offset of [-1, 0, 999, 65_001, 90_000]) {
      expect(matchBilibiliLotteryMessage(bilibiliLotteryMessageFixture({ receivedAt: NOW + offset }), [sample()])).toBeNull()
    }
    expect(matchBilibiliLotteryMessage(bilibiliLotteryMessageFixture({ receivedAt: NOW + 2000 }), [sample({ time: 3 })])).toBeNull()
    expect(matchBilibiliLotteryMessage(bilibiliLotteryMessageFixture(), [sample({}, NOW + 6000)])).toBeNull()
  })
  it('uses the newest pre-arrival state including activity replacement, empty and ended', () => {
    const message = bilibiliLotteryMessageFixture({ receivedAt: NOW + 35_000 })
    const next = sample({ id: 772, current_timestamp: (NOW + 30_000) / 1000, danmu: '新口令', danmu_new: [] }, NOW + 30_000)
    expect(matchBilibiliLotteryMessage(message, [sample(), next])).toBeNull()
    expect(matchBilibiliLotteryMessage({ ...message, text: '新口令' }, [sample(), next])?.activityId).toBe('772')
    expect(matchBilibiliLotteryMessage(message, [sample(), bilibiliLotteryEmpty('21452505', NOW + 30_000)])).toBeNull()
    expect(matchBilibiliLotteryMessage(message, [sample(), sample({ lot_status: 2 }, NOW + 30_000)])).toBeNull()
    expect(matchBilibiliLotteryMessage(message, [sample({}, NOW + 30_000), next])).toBeNull()
  })
  it('leaves gift/game conditions and missing official time unclassified', () => {
    for (const patch of [{ join_type: 1 }, { join_type: 2 }, { current_timestamp: undefined }]) {
      expect(matchBilibiliLotteryMessage(bilibiliLotteryMessageFixture(), [sample(patch)])).toBeNull()
    }
  })
  it('rejects inconsistent same-time gift metadata and invalid clock anchors', () => {
    const message = bilibiliLotteryMessageFixture()
    expect(matchBilibiliLotteryMessage(message, [sample(), sample({ join_type: 1 })])).toBeNull()
    for (const patch of [{ serverNow: NaN }, { clockUncertaintyMs: -1 }, { observedFrom: NaN }, { endsAt: Infinity }]) {
      expect(matchBilibiliLotteryMessage(message, [{ ...sample(), ...patch }])).toBeNull()
    }
  })
})
