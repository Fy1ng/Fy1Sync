/**
 * Labelling a stretch of countdown at once.
 *
 * The viewer marks where a stretch starts and ends, and types the reading on its first frame.
 * Every frame in between is grabbed and cut into glyph boxes; this module turns those frames
 * into a proposal: which reading each frame shows, assuming the clock counts down by one each
 * time its picture changes. The viewer reviews the proposal by reading and saves it.
 *
 * Ticks are found from the picture, not from the clock on the wall: the stretch rarely starts
 * on a tick, and a HUD's text is identical frame to frame between ticks. A change that does not
 * come about a second after the last one (a replay cut, a fade, a frozen clock) stops the count:
 * the frames from there on are left for the viewer rather than guessed.
 */

import { cropBinary, type BinaryImage } from '../../core/imageOps'
import type { GlyphBox } from '../../core/segmentation'
import type { ClockChar } from '../../core/profileSchema'
import { parseCountdown } from '../../core/clockJump'
import { clockText, pairReading } from './reading'

/** One grabbed frame of the stretch, cut the same way the editor cuts a single frame. */
export interface StretchFrame {
  /** Media time of the presented frame. */
  at: number
  binary: BinaryImage
  boxes: GlyphBox[]
  /** Packed 32x48 glyphs returned by Rust for these boxes. */
  bitmaps: string[]
}

export type GroupState =
  /** The reading follows from the count; saved unless the viewer leaves it out. */
  | 'proposed'
  /** Boxes do not match the reading's characters: nothing sensible to save. */
  | 'box-mismatch'
  /** After a change the count cannot explain: left out until the viewer types its reading. */
  | 'unsure'

/** A run of frames that all show the same picture, so the same reading. */
export interface StretchGroup {
  from: number
  to: number
  frames: number
  /** Proposed reading; the viewer may correct it. */
  text: string
  state: GroupState
  /** Why a group is not `proposed`, in the editor's words. */
  note?: string
  /** Index of the frame shown as the group's picture. */
  sample: number
}

/** A tick lands within this of a second after the last one, or the count stops. */
const TICK_TOLERANCE = 0.25
/**
 * A glyph whose pixels differ by less than this share is the same glyph (compression noise).
 * Compared glyph by glyph: a tick changes one digit, a small part of a wide clock crop.
 */
const CHANGE_RATIO = 0.08

/** Share of differing pixels between two same-sized images; 1 when their shapes differ. */
function differing(a: BinaryImage, b: BinaryImage): number {
  if (a.width !== b.width || a.height !== b.height || a.data.length === 0) return 1
  let count = 0
  for (let index = 0; index < a.data.length; index++) if ((a.data[index] !== 0) !== (b.data[index] !== 0)) count++
  return count / a.data.length
}

/**
 * How much the picture changed between two frames: the largest change of any one glyph box.
 * A different number of boxes is a change outright.
 */
export function pictureChange(a: Pick<StretchFrame, 'binary' | 'boxes'>, b: Pick<StretchFrame, 'binary' | 'boxes'>): number {
  if (a.boxes.length !== b.boxes.length || a.boxes.length === 0) return 1
  let most = 0
  a.boxes.forEach((box, index) => {
    const other = b.boxes[index]!
    // The same box in both frames, so a moved edge counts as a change too.
    const union = {
      x: Math.min(box.x, other.x), y: Math.min(box.y, other.y),
      width: Math.max(box.x + box.width, other.x + other.width) - Math.min(box.x, other.x),
      height: Math.max(box.y + box.height, other.y + other.height) - Math.min(box.y, other.y),
    }
    most = Math.max(most, differing(cropBinary(a.binary, union), cropBinary(b.binary, union)))
  })
  return most
}

/**
 * Group the frames into runs of one picture and propose each run's reading, counting down
 * from `firstReading` by one per tick. `format` is the HUD's countdown format.
 */
export function proposeStretch(frames: StretchFrame[], firstReading: string, format: 'm:ss' | 'mm:ss' | 'ss'): StretchGroup[] {
  const groups: StretchGroup[] = []
  if (frames.length === 0) return groups
  let seconds = parseCountdown(firstReading.replace(/\s+/g, ''), format === 'ss' ? 'ss' : format)
  // Counting stops for good at the first change it cannot explain.
  let counting = seconds !== null
  let lastTick: number | null = null
  let start = 0
  const close = (end: number): void => {
    const first = frames[start]!, last = frames[end]!
    const text = seconds !== null ? clockText(seconds, format) : ''
    const group: StretchGroup = { from: first.at, to: last.at, frames: end - start + 1, text, state: 'proposed', sample: start + Math.floor((end - start) / 2) }
    if (!counting) Object.assign(group, { state: 'unsure', text: '', note: '画面变化不在整秒上，可能是回放、暂停或转场，请填写读数或不要存入' })
    else if (!pairReading(text, frames[group.sample]!.boxes.length).ok) {
      Object.assign(group, { state: 'box-mismatch', note: `切出 ${frames[group.sample]!.boxes.length} 个字符框，和读数 ${text} 对不上` })
    }
    groups.push(group)
  }
  for (let index = 1; index < frames.length; index++) {
    if (pictureChange(frames[index - 1]!, frames[index]!) < CHANGE_RATIO) continue
    close(index - 1)
    start = index
    const at = frames[index]!.at
    if (counting && seconds !== null) {
      // The first change after the start can come any time within the first second.
      const since = lastTick === null ? at - frames[0]!.at : at - lastTick
      const onBeat = lastTick === null ? since <= 1 + TICK_TOLERANCE : Math.abs(since - 1) <= TICK_TOLERANCE
      if (onBeat && seconds > 0) { seconds -= 1; lastTick = at }
      else counting = false
    }
  }
  close(frames.length - 1)
  return groups
}

/** A sample ready to store: the normalised glyph and the character it is. */
export interface StretchSample {
  char: ClockChar
  data: string
  /** Where it came from, for the sample's origin line. */
  at: number
}

/**
 * The samples a reviewed proposal adds: every frame of every kept group, each glyph box with
 * its character, keeping one copy of each distinct glyph picture. Between ticks a HUD draws
 * the same pixels every frame, so this keeps a stretch to a few samples per character.
 */
export function stretchSamples(frames: StretchFrame[], groups: StretchGroup[], keep: (group: StretchGroup) => boolean): StretchSample[] {
  const seen = new Set<string>()
  const samples: StretchSample[] = []
  for (const group of groups) {
    if (!keep(group)) continue
    for (const frame of frames) {
      if (frame.at < group.from - 1e-6 || frame.at > group.to + 1e-6) continue
      const paired = pairReading(group.text, frame.boxes.length)
      if (!paired.ok) continue
      paired.chars.forEach((char, index) => {
        const data = frame.bitmaps[index]
        if (!data) return
        const key = `${char}\u0000${data}`
        if (seen.has(key)) return
        seen.add(key)
        samples.push({ char, data, at: frame.at })
      })
    }
  }
  return samples
}
