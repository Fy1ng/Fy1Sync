import { describe, expect, it, vi } from 'vitest'
import { CandidateMatcher, CandidateStreak, CURRENT_PICTURE, bestCandidate, type PictureSampler } from './candidateMatcher'
import type { FrameMeasurement } from './frameHashSampler'

const measured = (confidence: number | null): FrameMeasurement => confidence === null
  ? { samples: { official: 0, commentary: 0 }, message: '未找到可靠的共同画面' }
  : { samples: { official: 30, commentary: 30 }, estimate: { confidence } as FrameMeasurement['estimate'] }

describe('bestCandidate', () => {
  it('picks the backup that clearly beats the current picture', () => {
    expect(bestCandidate(0.2, [{ key: 'a', confidence: 0.5 }, { key: 'b', confidence: 0.8 }])).toBe('b')
  })

  it('treats a current picture without an estimate as zero', () => {
    expect(bestCandidate(null, [{ key: 'a', confidence: 0.4 }])).toBe('a')
  })

  it('keeps the current picture when no backup wins by the margin or reaches the floor', () => {
    expect(bestCandidate(0.7, [{ key: 'a', confidence: 0.8 }])).toBeNull()
    expect(bestCandidate(null, [{ key: 'a', confidence: 0.2 }])).toBeNull()
    expect(bestCandidate(null, [{ key: 'a', confidence: null }])).toBeNull()
    expect(bestCandidate(null, [])).toBeNull()
  })
})

describe('CandidateStreak', () => {
  it('needs the same winner twice in a row', () => {
    const streak = new CandidateStreak(2)
    expect(streak.observe('a')).toBeNull()
    expect(streak.observe('b')).toBeNull()
    expect(streak.observe('b')).toBe('b')
    // A decision starts the count over.
    expect(streak.observe('b')).toBeNull()
  })

  it('is broken by a comparison without a winner', () => {
    const streak = new CandidateStreak(2)
    expect(streak.observe('a')).toBeNull()
    expect(streak.observe(null)).toBeNull()
    expect(streak.observe('a')).toBeNull()
    expect(streak.observe('a')).toBe('a')
  })
})

describe('CandidateMatcher', () => {
  const video = (): HTMLVideoElement => document.createElement('video')

  function matcher(confidences: Record<string, number | null>) {
    const created: { key: string; sampler: PictureSampler & { dispose: ReturnType<typeof vi.fn> } }[] = []
    let next = ''
    const instance = new CandidateMatcher({
      commentary: video, commentaryRevision: () => 'c', config: () => ({ regions: {} as never, masks: [] }),
      createSampler: () => {
        const key = next
        const sampler = { measure: vi.fn(async () => measured(confidences[key] ?? null)), dispose: vi.fn() }
        created.push({ key, sampler })
        return sampler
      },
    })
    const sync = (pictures: { key: string; video: HTMLVideoElement }[]): void => {
      for (const picture of pictures) {
        next = picture.key
        instance.sync(pictures.slice(0, pictures.indexOf(picture) + 1).map(item => ({ ...item, revision: () => item.key })))
      }
    }
    return { instance, created, sync }
  }

  it('scores the current picture apart from the backups', async () => {
    const { instance, sync } = matcher({ [CURRENT_PICTURE]: 0.1, a: 0.6, b: null })
    sync([{ key: CURRENT_PICTURE, video: video() }, { key: 'a', video: video() }, { key: 'b', video: video() }])
    expect(instance.size).toBe(3)
    await expect(instance.compare({ aborted: false })).resolves.toEqual({
      current: 0.1, scores: [{ key: 'a', confidence: 0.6 }, { key: 'b', confidence: null }],
    })
  })

  it('drops samplers of pictures that left and restarts one whose element changed', () => {
    const { instance, created, sync } = matcher({})
    const current = video()
    sync([{ key: CURRENT_PICTURE, video: current }, { key: 'a', video: video() }])
    expect(created).toHaveLength(2)
    sync([{ key: CURRENT_PICTURE, video: video() }])
    expect(created[0]!.sampler.dispose).toHaveBeenCalled()
    expect(created[1]!.sampler.dispose).toHaveBeenCalled()
    expect(instance.size).toBe(1)
    instance.dispose()
    expect(created[2]!.sampler.dispose).toHaveBeenCalled()
    expect(instance.size).toBe(0)
  })
})
