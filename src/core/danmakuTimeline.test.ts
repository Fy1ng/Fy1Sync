import { describe, expect, it } from 'vitest'
import { DanmakuTimeline, scheduleTimeFor, type DanmakuMessage } from './danmakuTimeline'
import {
  DanmakuLaneAllocator,
  PinnedSlotAllocator,
  estimateTextWidth,
} from './danmakuLanes'
import { compileDanmakuFilter } from './danmakuFilter'

function message(id: string, scheduleTime: number): DanmakuMessage {
  return { id, text: id, user: 'u', color: '#fff', scheduleTime, receivedAt: 0 }
}

describe('DanmakuTimeline', () => {
  it('holds messages until playback reaches their schedule time', () => {
    const timeline = new DanmakuTimeline()
    timeline.push(message('a', 10))
    timeline.push(message('b', 12))

    expect(timeline.advance(9.9)).toEqual([])
    expect(timeline.advance(10).map((m) => m.id)).toEqual(['a'])
    expect(timeline.advance(11.5)).toEqual([])
    expect(timeline.advance(12).map((m) => m.id)).toEqual(['b'])
  })

  it('keeps the queue ordered regardless of arrival order', () => {
    const timeline = new DanmakuTimeline({ maxLagSeconds: 60 })
    timeline.push(message('late', 30))
    timeline.push(message('early', 10))
    timeline.push(message('mid', 20))

    expect(timeline.advance(30).map((m) => m.id)).toEqual(['early', 'mid', 'late'])
  })

  it('releases in schedule order when pumped frame by frame', () => {
    const timeline = new DanmakuTimeline()
    timeline.push(message('late', 3))
    timeline.push(message('early', 1))
    timeline.push(message('mid', 2))

    const seen: string[] = []
    for (let t = 0; t <= 3; t += 1) {
      seen.push(...timeline.advance(t).map((m) => m.id))
    }
    expect(seen).toEqual(['early', 'mid', 'late'])
  })

  it('inherits the sync offset: a rewound commentary delays danmaku', () => {
    // Commentary live edge is at 100s; a message arrives now, so it belongs to
    // media time 100. The commentary has been rewound 5s to match a delayed
    // official picture, so it is playing 95.
    const timeline = new DanmakuTimeline()
    const scheduleTime = scheduleTimeFor({
      currentTime: 95,
      timebase: { kind: 'live', seekableEnd: 100 },
    })
    expect(scheduleTime).toBe(100)
    timeline.push(message('spoiler', scheduleTime))

    // Still nothing at the rewound playhead: no spoilers.
    expect(timeline.advance(95)).toEqual([])
    expect(timeline.advance(99.9)).toEqual([])
    // Shows up exactly when the picture catches up.
    expect(timeline.advance(100).map((m) => m.id)).toEqual(['spoiler'])
  })

  it('schedules against current time for VOD sources', () => {
    expect(scheduleTimeFor({ currentTime: 42, timebase: { kind: 'vod' } })).toBe(42)
  })

  it('expires messages left far behind a forward jump', () => {
    const timeline = new DanmakuTimeline({ maxLagSeconds: 5 })
    timeline.push(message('stale', 10))
    timeline.push(message('fresh', 28))

    expect(timeline.advance(30).map((m) => m.id)).toEqual(['fresh'])
    expect(timeline.stats().expired).toBe(1)
    expect(timeline.stats().released).toBe(1)
  })

  it('does not expire the queue after a backwards seek', () => {
    const timeline = new DanmakuTimeline({ maxLagSeconds: 5 })
    timeline.advance(100)
    timeline.push(message('pending', 100))
    timeline.handleSeek(95)

    expect(timeline.playhead).toBe(95)
    expect(timeline.advance(95)).toEqual([])
    expect(timeline.advance(100).map((m) => m.id)).toEqual(['pending'])
    expect(timeline.stats().expired).toBe(0)
  })

  it('drops the oldest messages past capacity', () => {
    const timeline = new DanmakuTimeline({ capacity: 3 })
    for (let index = 0; index < 5; index += 1) {
      timeline.push(message(`m${index}`, index))
    }
    expect(timeline.stats().pending).toBe(3)
    expect(timeline.stats().overflowed).toBe(2)
    expect(timeline.advance(10).map((m) => m.id)).toEqual(['m2', 'm3', 'm4'])
  })

  it('reset clears counters and queue', () => {
    const timeline = new DanmakuTimeline()
    timeline.push(message('a', 1))
    timeline.advance(1)
    timeline.reset()
    expect(timeline.stats()).toEqual({ pending: 0, released: 0, expired: 0, overflowed: 0 })
    expect(timeline.playhead).toBe(0)
  })
})

describe('compileDanmakuFilter', () => {
  it('passes ordinary messages', () => {
    const filter = compileDanmakuFilter()
    expect(filter.reject({ text: '这波好强', user: '路人' })).toBeNull()
  })

  it('blocks by regex, case-insensitively', () => {
    const filter = compileDanmakuFilter({
      blockedPatterns: ['广告|加群'],
      blockedUsers: [],
      maxLength: 0,
    })
    expect(filter.reject({ text: '快来加群', user: 'a' })).toBe('pattern')
    expect(filter.reject({ text: 'AD', user: 'a' })).toBeNull()
  })

  it('blocks by username regardless of case and padding', () => {
    const filter = compileDanmakuFilter({
      blockedPatterns: [],
      blockedUsers: [' SpamBot '],
      maxLength: 0,
    })
    expect(filter.reject({ text: 'hi', user: 'spambot' })).toBe('user')
    expect(filter.reject({ text: 'hi', user: 'someone' })).toBeNull()
  })

  it('reports invalid patterns instead of throwing, and ignores them', () => {
    const filter = compileDanmakuFilter({
      blockedPatterns: ['(unclosed', '好'],
      blockedUsers: [],
      maxLength: 0,
    })
    expect(filter.invalidPatterns).toHaveLength(1)
    expect(filter.invalidPatterns[0]?.source).toBe('(unclosed')
    expect(filter.reject({ text: '好球', user: 'a' })).toBe('pattern')
  })

  it('applies the length limit and drops blank text', () => {
    const filter = compileDanmakuFilter({ blockedPatterns: [], blockedUsers: [], maxLength: 4 })
    expect(filter.reject({ text: '12345', user: 'a' })).toBe('length')
    expect(filter.reject({ text: '1234', user: 'a' })).toBeNull()
    expect(filter.reject({ text: '   ', user: 'a' })).toBe('empty')
  })
})

describe('DanmakuLaneAllocator', () => {
  const layout = { laneHeight: 30, areaHeight: 300, width: 1000, speed: 200 }

  it('derives lane count from the usable area', () => {
    expect(new DanmakuLaneAllocator(layout).laneCount).toBe(10)
    expect(new DanmakuLaneAllocator({ ...layout, areaHeight: 95 }).laneCount).toBe(3)
  })

  it('fills lanes top-down and reuses a lane once the tail cleared', () => {
    const allocator = new DanmakuLaneAllocator({ ...layout, areaHeight: 60 })
    const first = allocator.allocateScroll(0, 200)
    const second = allocator.allocateScroll(0, 200)
    expect(first?.lane).toBe(0)
    expect(second?.lane).toBe(1)
    expect(first?.top).toBe(0)
    expect(second?.top).toBe(30)
    // travel = width + messageWidth = 1200px at 200px/s
    expect(first?.durationSeconds).toBeCloseTo(6, 5)

    // Lanes busy until 200/200 = 1s.
    expect(allocator.allocateScroll(0.5, 200)).toBeNull()
    expect(allocator.allocateScroll(1, 200)?.lane).toBe(0)
  })

  it('recomputes lanes when the layout changes', () => {
    const allocator = new DanmakuLaneAllocator(layout)
    allocator.setLayout({ ...layout, areaHeight: 60 })
    expect(allocator.laneCount).toBe(2)
  })
})

describe('PinnedSlotAllocator', () => {
  it('hands out slots and frees them after the dwell time', () => {
    const allocator = new PinnedSlotAllocator(2)
    expect(allocator.allocate(0, 4)).toBe(0)
    expect(allocator.allocate(0, 4)).toBe(1)
    expect(allocator.allocate(1, 4)).toBeNull()
    expect(allocator.allocate(4, 4)).toBe(0)
  })
})

describe('estimateTextWidth', () => {
  it('treats CJK as full width and latin as narrower', () => {
    expect(estimateTextWidth('四个汉字', 20)).toBe(80)
    expect(estimateTextWidth('abcd', 20)).toBe(44)
  })
})
