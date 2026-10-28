import { describe, expect, it } from 'vitest'
import { ScoreHistory, type ScoreReading } from './score'
import type { SourceRole } from '../core/types'

function reading(role: SourceRole, time: number, left = 8, right: number | null = 8,
  patch: Partial<ScoreReading> = {}): ScoreReading {
  return { left, right, leftQuality: .95, rightQuality: right === null ? 0 : .95,
    reason: right === null ? 'missing-right' : null, mediaTime: time, wallTime: time * 1000,
    source: role, generation: 1, width: 1920, height: 1080, segment: 1, frameIndex: time * 2, ...patch }
}
function feed(history: ScoreHistory, role: SourceRole, end: number,
  score: (time: number) => [number, number | null] = () => [8, 8]): void {
  for (let time = 0; time <= end; time += .5) history.push(role, reading(role, time, ...score(time)))
}

describe('score evidence at the predicted content time', () => {
  it.each([5, 18, 60, -5, -18, -60])('uses residual %s once, independent of each media epoch', delta => {
    const history = new ScoreHistory()
    const end = Math.abs(delta) + 12
    const boundary = end + Math.abs(delta) / 2
    feed(history, 'official', end, time => time + Math.max(delta, 0) >= boundary ? [9, 8] : [8, 8])
    feed(history, 'commentary', end, time => time + Math.max(-delta, 0) >= boundary ? [9, 8] : [8, 8])
    const result = history.evaluate(delta, end * 1000, 'valid')
    expect(result.status).toBe('pass')
    expect(result.generation).toBe('valid')
    expect(result.official?.left).toBe(result.commentary?.left)
  })

  it('rejects matching current scores when the candidate targets another round', () => {
    const history = new ScoreHistory()
    feed(history, 'official', 30, time => time < 20 ? [8, 8] : [9, 8])
    feed(history, 'commentary', 30, () => [9, 8])
    expect(history.evaluate(18, 30_000, 'valid')).toMatchObject({ status: 'mismatch',
      official: { left: 8, right: 8 }, commentary: { left: 9, right: 8 } })
  })

  it('never extrapolates a static score into missing history', () => {
    const history = new ScoreHistory()
    feed(history, 'official', 3)
    feed(history, 'commentary', 3)
    expect(history.evaluate(18, 3000, 'valid').status).toBe('unknown')
  })

  it('waits around observed score changes, including a change at the latest frame', () => {
    const history = new ScoreHistory()
    feed(history, 'official', 10)
    feed(history, 'commentary', 10, time => time < 10 ? [8, 8] : [9, 8])
    expect(history.evaluate(0, 10_000, 'valid').status).toBe('transition')
  })

  it('rejects a missing side and an unknown gap, without filling values from another frame', () => {
    const history = new ScoreHistory()
    feed(history, 'official', 10)
    feed(history, 'commentary', 10, time => time === 8 ? [8, null] : [8, 8])
    expect(history.evaluate(0, 10_000, 'valid').status).toBe('unknown')
  })

  it('requires distinct media frames covering at least one second', () => {
    const history = new ScoreHistory()
    for (const role of ['official', 'commentary'] as const) {
      for (let time = 0; time <= 10; time += .5) {
        history.push(role, reading(role, time, 8, 8, { mediaTime: time / 100 }))
      }
    }
    expect(history.evaluate(0, 10_000, 'valid').status).toBe('unknown')
  })

  it.each([
    { source: 'replacement' }, { generation: 2 }, { width: 3840 }, { height: 2160 }, { segment: 2 },
  ])('drops evidence when source/generation/dimensions/segment changes: %j', patch => {
    const history = new ScoreHistory()
    feed(history, 'official', 10)
    feed(history, 'commentary', 10)
    history.push('official', reading('official', 10.5, 8, 8, patch))
    expect(history.readings('official')).toHaveLength(1)
    expect(history.evaluate(0, 10_500, 'new').status).toBe('unknown')
  })

  it('does not use stale or discontinuous evidence', () => {
    const history = new ScoreHistory()
    feed(history, 'official', 10)
    feed(history, 'commentary', 10)
    expect(history.evaluate(0, 12_000, 'valid').status).toBe('unknown')
    history.clear('official')
    history.push('official', reading('official', 6))
    history.push('official', reading('official', 8))
    history.push('official', reading('official', 10))
    expect(history.evaluate(0, 10_000, 'valid').status).toBe('unknown')
  })

  it('bounds both record count and wall-clock retention', () => {
    const history = new ScoreHistory()
    for (let index = 0; index < 1000; index += 1) history.push('official', reading('official', index / 10))
    expect(history.readings('official')).toHaveLength(400)
    history.push('official', reading('official', 200))
    expect(history.readings('official')).toHaveLength(1)
  })

  it('discards a late same-generation response rather than replacing current evidence', () => {
    const history = new ScoreHistory()
    feed(history, 'official', 10)
    const count = history.readings('official').length
    history.push('official', reading('official', 7, 7, 7))
    expect(history.readings('official')).toHaveLength(count)
    expect(history.readings('official').at(-1)?.left).toBe(8)
  })
})
