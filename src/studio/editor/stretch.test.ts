import { describe, expect, it } from 'vitest'
import { normalizeGlyph, cropBinary } from '../../core/imageOps'
import { packBitmap } from '../../core/bitmapCodec'
import type { GlyphBox } from '../../core/segmentation'
import { pictureChange, proposeStretch, stretchSamples, type StretchFrame } from './stretch'

/** A 4-box crop whose ink pattern stands for one reading: same text, same pixels. */
function crop(text: string, noise = 0): Omit<StretchFrame, 'at'> {
  const width = 40, height = 10
  const data = new Uint8Array(width * height)
  const chars = [...text]
  chars.forEach((char, slot) => {
    // Ink a column per bit of a hash of the character: different characters differ in about
    // half their columns, as real digits do, not in one.
    const pattern = (Math.imul(char.charCodeAt(0), 2654435761) >>> 24) & 0xff
    for (let bit = 0; bit < 8; bit++) if ((pattern >> bit) & 1) for (let y = 1; y < 9; y++) data[y * width + slot * 10 + 1 + bit] = 255
  })
  for (let index = 0; index < noise; index++) data[index * 7 % data.length] = data[index * 7 % data.length]! ^ 255
  const boxes = chars.map((_, slot) => ({ x: slot * 10, y: 0, width: 10, height: 10 }) as GlyphBox)
  const binary = { data, width, height }
  return { binary, boxes, bitmaps: boxes.map(box => packBitmap(normalizeGlyph(cropBinary(binary, box)))) }
}

/** Frames at `fps` from `start`, each showing `readingAt(t)`. */
function stretch(fps: number, start: number, seconds: number, readingAt: (t: number) => string): StretchFrame[] {
  return Array.from({ length: Math.round(seconds * fps) }, (_, index) => {
    const at = start + index / fps
    return { at, ...crop(readingAt(at)) }
  })
}

/** A clock that shows `from` at t=0 and ticks down on each whole second. */
const ticking = (from: number) => (t: number) => {
  const left = Math.max(0, from - Math.floor(t))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

describe('pictureChange', () => {
  it('is 0 for the same picture, small for noise and large for a new reading', () => {
    expect(pictureChange(crop('1:23'), crop('1:23'))).toBe(0)
    expect(pictureChange(crop('1:23'), crop('1:23', 3))).toBeLessThan(0.08)
    // One digit of four changes: judged on that glyph, not diluted by the whole crop.
    expect(pictureChange(crop('1:23'), crop('1:22'))).toBeGreaterThan(0.08)
    expect(pictureChange(crop('1:23'), { ...crop('1:23'), boxes: crop('1:23').boxes.slice(0, 3) })).toBe(1)
  })
})

describe('proposeStretch', () => {
  it('counts down one per tick, from a start in the middle of a second', () => {
    // The stretch starts 0.4 s into the second showing 1:23.
    const frames = stretch(60, 0.4, 4, ticking(83))
    const groups = proposeStretch(frames, '1:23', 'm:ss')
    expect(groups.map((group) => [group.text, group.state])).toEqual([
      ['1:23', 'proposed'], ['1:22', 'proposed'], ['1:21', 'proposed'], ['1:20', 'proposed'], ['1:19', 'proposed'],
    ])
    expect(groups[0]!.frames).toBe(36)
    expect(groups[1]!.frames).toBe(60)
  })

  it('works at the 63 fps of a Douyu recording', () => {
    const groups = proposeStretch(stretch(63, 0, 3, ticking(10)), '0:10', 'm:ss')
    expect(groups.map((group) => group.text)).toEqual(['0:10', '0:09', '0:08'])
  })

  it('keeps one reading through a frozen clock', () => {
    // 0:05 holds for 3 s (the clock stopped), then the stretch ends: no tick, no guess.
    const groups = proposeStretch(stretch(60, 0, 3, () => '0:05'), '0:05', 'm:ss')
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ text: '0:05', state: 'proposed', frames: 180 })
  })

  it('stops counting at a change that is not on the beat, and leaves the rest to the viewer', () => {
    // Ticks normally to 1:21, then a replay cut 0.5 s later shows 1:40.
    const frames = stretch(60, 0, 3.5, (t) => (t < 2.5 ? ticking(83)(t) : '1:40'))
    const groups = proposeStretch(frames, '1:23', 'm:ss')
    expect(groups.map((group) => group.state)).toEqual(['proposed', 'proposed', 'proposed', 'unsure'])
    expect(groups[3]).toMatchObject({ text: '', note: expect.stringContaining('回放') })
  })

  it('marks a run whose boxes do not fit its reading', () => {
    const frames = stretch(60, 0, 2, ticking(83))
    // The second second's frames lost a box (two digits merged).
    for (const frame of frames) if (frame.at >= 1) frame.boxes = frame.boxes.slice(0, 3)
    const groups = proposeStretch(frames, '1:23', 'm:ss')
    expect(groups.map((group) => group.state)).toEqual(['proposed', 'box-mismatch'])
    expect(groups[1]!.note).toContain('切出 3 个字符框')
  })

  it('leaves everything to the viewer when the first reading is not a countdown', () => {
    const groups = proposeStretch(stretch(60, 0, 2, ticking(83)), 'abc', 'm:ss')
    expect(groups.every((group) => group.state === 'unsure')).toBe(true)
  })
})

describe('stretchSamples', () => {
  it('keeps one copy of each distinct glyph, only from groups the viewer kept', () => {
    const frames = stretch(60, 0, 3, ticking(83))
    const groups = proposeStretch(frames, '1:23', 'm:ss')
    const kept = stretchSamples(frames, groups, (group) => group.text !== '1:21')
    // 1:23 and 1:22: '1', ':', '2' are shared, '3' and '2' as last digit too; distinct pictures only.
    const byChar = kept.reduce<Record<string, number>>((count, sample) => ({ ...count, [sample.char]: (count[sample.char] ?? 0) + 1 }), {})
    expect(byChar).toEqual({ '1': 1, ':': 1, '2': 1, '3': 1 })
    expect(kept.some((sample) => sample.at >= 2)).toBe(false)
  })

  it('takes the reading the viewer corrected', () => {
    const frames = stretch(60, 0, 1, () => '0:07')
    const groups = proposeStretch(frames, '0:09', 'm:ss')
    groups[0]!.text = '0:07'
    expect(stretchSamples(frames, groups, () => true).map((sample) => sample.char).sort()).toEqual(['0', '7', ':'])
  })
})

describe('score stretch proposals', () => {
  it('holds between changes and suggests +1 without treating an irregular change as a clock tick', () => {
    const frames = stretch(10, 0, 7, t => t < 2.3 ? '8' : t < 5.6 ? '9' : '10')
    const groups = proposeStretch(frames, '8', 'ss', 'scoreLeft')
    expect(groups.map(group => [group.text, group.state])).toEqual([
      ['8', 'pending'], ['9', 'pending'], ['10', 'pending'],
    ])
    expect(groups.every(group => group.note?.includes('确认'))).toBe(true)
    expect(stretchSamples(frames, groups, () => false, 'scoreLeft')).toEqual([])
    expect(stretchSamples(frames, groups, () => true, 'scoreLeft').map(sample => sample.char).sort()).toEqual(['0', '1', '8', '9'])
  })

  it('keeps box mismatch checks and refuses invalid score corrections', () => {
    const frames = stretch(10, 0, 1, () => '10')
    const groups = proposeStretch(frames, '9', 'ss', 'scoreRight')
    expect(groups[0]!.state).toBe('box-mismatch')
    groups[0]!.text = '07'
    expect(stretchSamples(frames, groups, () => true, 'scoreRight')).toEqual([])
    groups[0]!.text = '10'
    expect(stretchSamples(frames, groups, () => true, 'scoreRight').map(sample => sample.char).sort()).toEqual(['0', '1'])
  })
})
