/**
 * Recognition against real decoded video frames.
 *
 * The rest of the recognition tests draw their glyphs with `src/test/glyphFont.ts`, so they
 * prove the algorithms agree with themselves. What they cannot see is anything that only
 * appears in a real picture: chroma subsampling around the strokes, the encoder's ringing on
 * a hard edge, the exact ROI the fixture generator chose. The E2E suite does see it, but
 * through a browser, a worker and two media elements at once — so when it fails, "the
 * recogniser cannot read this frame" and "the frame never arrived" look identical.
 *
 * This sits in between: real frames from `public/test-sources`, decoded by ffmpeg, fed
 * straight into the pipeline in-process. Templates are taught here too, from the same
 * frames, the way the editor teaches them — a template rasterised by another machine's ffmpeg
 * would not match this machine's decode, which is also why `fixture-profile.json` ships with
 * none.
 *
 * Skips when the fixtures or ffmpeg are missing, like the E2E specs do.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { packBitmap } from '../core/bitmapCodec'
import { binarize, cropBinary, normalizeGlyph, roiToPixels, toGrayscale } from '../core/imageOps'
import {
  CLOCK_CHARS,
  createEmptyProfile,
  validateProfile,
  type RecognitionProfile,
} from '../core/profileSchema'
import { segmentGlyphs } from '../core/segmentation'
import { compileTemplates, recognizeFrame, type CompiledTemplates } from '../core/templateMatch'
import { FULL_FRAME_ROI } from './frameGrabber'

// From the project root, not `import.meta.url`: under jsdom the module URL is an http one,
// and `fileURLToPath` rejects it. Vitest always runs with the root as cwd.
const sourceDir = join(process.cwd(), 'public', 'test-sources')
const officialPath = join(sourceDir, 'official.mp4')
const commentaryPath = join(sourceDir, 'commentary.mp4')

/** The fixture's own ROI and geometry, from `scripts/generate-test-sources.mjs`. */
const ROI = { x: 0.42, y: 0.045, w: 0.16, h: 0.13 }
const FRAME_WIDTH = 1280
const FRAME_HEIGHT = 720

/** The generator's countdown: `0:%{eif: max(0, 20 - floor(t - delay)) :d:2}`. */
const COUNTDOWN_FROM = 20
const COMMENTARY_DELAY = 5

function expectedText(mediaTime: number, delaySeconds: number): string {
  const remaining = Math.max(0, COUNTDOWN_FROM - Math.floor(mediaTime - delaySeconds))
  return `0:${String(remaining).padStart(2, '0')}`
}

function ffmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const ready = existsSync(officialPath) && existsSync(commentaryPath) && ffmpegAvailable()

interface Frame {
  data: Uint8ClampedArray
  width: number
  height: number
}

/**
 * Decode exactly one frame as RGBA.
 *
 * `-ss` goes after `-i` on purpose: input seeking is keyframe-based, and these fixtures are
 * a still picture with a changing overlay, so a fast seek can hand back a frame from the
 * wrong second — which would make this test lie about which digit was on screen.
 */
function decodeFrame(file: string, atSeconds: number): Frame {
  const stdout = execFileSync(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-i', file,
      '-ss', atSeconds.toFixed(3),
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  )
  const expected = FRAME_WIDTH * FRAME_HEIGHT * 4
  if (stdout.length < expected) {
    throw new Error(`解码 ${file} @${atSeconds}s 只得到 ${stdout.length} 字节，期望 ${expected}`)
  }
  return {
    data: new Uint8ClampedArray(stdout.buffer, stdout.byteOffset, expected),
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
  }
}

/** Crop the ROI out of a full frame and binarize it, exactly as the browser path does. */
function roiBinary(frame: Frame, profile: RecognitionProfile) {
  const rect = roiToPixels(profile.roi, frame.width, frame.height)
  const gray = toGrayscale(frame.data, frame.width, frame.height)
  const cropped = cropBinary({ data: gray.data, width: gray.width, height: gray.height }, rect)
  return binarize(cropped, profile.preprocess)
}

/**
 * Recognise a frame the way the player does: cropped on the main thread, then handed to a
 * worker whose profile ROI is the whole image (see `RecognitionClient.configure`).
 */
function recognizeCropped(
  frame: Frame,
  profile: RecognitionProfile,
  templates: CompiledTemplates,
  mediaTime: number,
) {
  const rect = roiToPixels(profile.roi, frame.width, frame.height)
  const gray = toGrayscale(frame.data, frame.width, frame.height)
  const cropped = cropBinary({ data: gray.data, width: gray.width, height: gray.height }, rect)
  // Back to RGBA: the worker receives pixels, not a grey plane.
  const rgba = new Uint8ClampedArray(cropped.width * cropped.height * 4)
  for (let index = 0; index < cropped.data.length; index += 1) {
    const value = cropped.data[index] as number
    rgba[index * 4] = value
    rgba[index * 4 + 1] = value
    rgba[index * 4 + 2] = value
    rgba[index * 4 + 3] = 255
  }
  return recognizeFrame(
    { data: rgba, width: cropped.width, height: cropped.height },
    { ...profile, roi: { ...FULL_FRAME_ROI } },
    templates,
    { mediaTime, wallTime: mediaTime * 1000, frameIndex: 0 },
  )
}

/** Sample times and what the official clock reads there, for teaching every character. */
const LESSONS = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5]

describe.skipIf(!ready)('真实帧识别', () => {
  let profile: RecognitionProfile
  let templates: CompiledTemplates
  const taught: string[] = []

  beforeAll(() => {
    const base = createEmptyProfile('fixture/real-frames', '真实帧测试')
    const seed: RecognitionProfile = { ...base, roi: ROI }
    const collected: Record<string, Array<{ id: string; data: string; createdAt: number }>> = {}

    for (const at of LESSONS) {
      const text = expectedText(at, 0)
      const binary = roiBinary(decodeFrame(officialPath, at), seed)
      const { boxes } = segmentGlyphs(binary)
      // One box per character or the labels would land on the wrong glyph; a frame that
      // segments badly is skipped rather than guessed at.
      if (boxes.length !== text.length) continue
      for (let index = 0; index < boxes.length; index += 1) {
        const char = text[index] as string
        if (collected[char]) continue
        const mask = normalizeGlyph(cropBinary(binary, boxes[index] as never))
        collected[char] = [{ id: `${char}-0`, data: packBitmap(mask), createdAt: 1 }]
        taught.push(char)
      }
    }

    const result = validateProfile({ ...seed, templates: collected })
    if (!result.profile) throw new Error(`教出的档案不合法：${JSON.stringify(result.issues)}`)
    profile = result.profile
    templates = compileTemplates(profile)
  })

  it('从真实帧里教出全部时钟字符', () => {
    expect([...taught].sort()).toEqual([...CLOCK_CHARS])
  })

  it('读出官方源在识别窗口内的每一秒', () => {
    // The window the E2E spec samples: both elements start at 12 s and play on for 3 s.
    const readings: string[] = []
    for (const at of [12.2, 12.6, 13.2, 13.6, 14.2, 14.6]) {
      const result = recognizeCropped(decodeFrame(officialPath, at), profile, templates, at)
      readings.push(
        result.outcome.status === 'success'
          ? result.outcome.reading.text
          : `失败(${result.outcome.reason}:${result.outcome.detail ?? ''})`,
      )
    }
    expect(readings).toEqual([
      expectedText(12.2, 0),
      expectedText(12.6, 0),
      expectedText(13.2, 0),
      expectedText(13.6, 0),
      expectedText(14.2, 0),
      expectedText(14.6, 0),
    ])
  })

  it('用同一套字形读出解说源，尽管它慢 5 秒', () => {
    const readings: string[] = []
    for (const at of [12.2, 13.2, 14.2]) {
      const result = recognizeCropped(decodeFrame(commentaryPath, at), profile, templates, at)
      readings.push(
        result.outcome.status === 'success'
          ? result.outcome.reading.text
          : `失败(${result.outcome.reason}:${result.outcome.detail ?? ''})`,
      )
    }
    expect(readings).toEqual([
      expectedText(12.2, COMMENTARY_DELAY),
      expectedText(13.2, COMMENTARY_DELAY),
      expectedText(14.2, COMMENTARY_DELAY),
    ])
  })
})
