import { describe, expect, it, vi } from 'vitest'
import { DanmakuProcessor, DEFAULT_DANMAKU_PREFERENCES, danmakuLaneHeight, readDanmakuPreferences } from './danmakuProcessing'

describe('danmaku appearance and duplicate processing', () => {
  it('keeps user details and the heuristic disabled until explicitly enabled', () => {
    expect(readDanmakuPreferences({})).toMatchObject({ showUserDetails: false, filterSuspectedBots: false, duplicateMode: 'all' })
    expect(danmakuLaneHeight(24, 8)).toBe(32)
    expect(danmakuLaneHeight(24, 0)).toBe(24)
    expect(() => danmakuLaneHeight(24, Infinity)).toThrow()
    expect(readDanmakuPreferences({ verticalGapPx: -1 })).toBeNull()
    expect(readDanmakuPreferences({ showUserDetails: 'yes' })).toBeNull()
    expect(readDanmakuPreferences({ duplicateWindowSeconds: 31 })).toBeNull()
    expect(readDanmakuPreferences({ unused: true })).toBeNull()
  })

  it('never executes a preference getter', () => {
    const getter = vi.fn(() => true)
    expect(readDanmakuPreferences(Object.defineProperty({}, 'showUserDetails', { get: getter }))).toBeNull()
    expect(getter).not.toHaveBeenCalled()
  })

  it('merges only already-released identical text in the same room without rewriting it', () => {
    const processor = new DanmakuProcessor({ ...DEFAULT_DANMAKU_PREFERENCES, duplicateMode: 'combo' })
    const a = processor.process({ text: '  加油!  ', room: '1' }, 100)
    const b = processor.process({ text: '  加油!  ', room: '1' }, 101)
    expect(a).toMatchObject({ kind: 'show', text: '  加油!  ', count: 1 })
    expect(b).toMatchObject({ kind: 'merge', text: '  加油!  ', count: 2, groupId: a.groupId })
    expect(processor.process({ text: '加油!', room: '1' }, 102).kind).toBe('show')
    expect(processor.process({ text: '  加油!  ', room: '2' }, 103).kind).toBe('show')
    expect(processor.process({ text: '  加油!  ', room: '1' }, 108)).toMatchObject({ kind: 'show', count: 1 })
  })

  it('clears grouping after a backward seek and when settings change', () => {
    const processor = new DanmakuProcessor({ ...DEFAULT_DANMAKU_PREFERENCES, duplicateMode: 'single' })
    processor.process({ text: 'a' }, 100)
    expect(processor.process({ text: 'a' }, 101).kind).toBe('hide')
    expect(processor.process({ text: 'a' }, 90).kind).toBe('show')
    processor.configure({ ...DEFAULT_DANMAKU_PREFERENCES, duplicateMode: 'all' })
    expect(processor.process({ text: 'a' }, 91).kind).toBe('show')
    expect(processor.trackedGroups).toBe(0)
  })

  it('keeps dms=0 and gifts, and labels missing-score filtering as a heuristic', () => {
    const processor = new DanmakuProcessor({ ...DEFAULT_DANMAKU_PREFERENCES, filterSuspectedBots: true })
    expect(processor.process({ text: 'a' }, 1)).toMatchObject({ kind: 'hide', reason: 'missing-dms' })
    expect(processor.process({ text: 'a', dms: 0 }, 2).kind).toBe('show')
    expect(processor.process({ text: 'gift', system: true }, 2).kind).toBe('show')
  })

  it('bounds room/text groups under a burst', () => {
    const processor = new DanmakuProcessor({ ...DEFAULT_DANMAKU_PREFERENCES, duplicateMode: 'combo' }, 2)
    for (const text of ['a', 'b', 'c']) processor.process({ text }, 1)
    expect(processor.trackedGroups).toBe(2)
    expect(processor.process({ text: 'a' }, 1).kind).toBe('show')
  })
})
