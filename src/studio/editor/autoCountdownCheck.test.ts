import { describe, expect, it } from 'vitest'
import { createEmptyHudStylePack } from '../../core/hudStylePack'
import type { HudFrameResult } from '../../core/hudWasm'
import type { ClockChar } from '../../core/profileSchema'
import { checkAutoCountdown } from './autoCountdownCheck'

function fixture(text = '0:18') {
  const pack = createEmptyHudStylePack()
  const variant = pack.variants[0]!
  const field = variant.fields.clock!
  for (const char of ['0', ':', '1', '9'] as const) field.glyphs[char] = [`seed-${char}`]
  const matches = [...text].map(char => ({ char: char === '8' ? null : char as ClockChar, score: char === '8' ? 0.4 : 0.96, runnerUpScore: 0.3, sampleIndex: 0 }))
  const result: HudFrameResult = { variantId: variant.id, selectionReason: null, content: 'live', phase: 'unconfigured',
    organizer: { status: 'failed', reason: 'not-configured', debug: null, score: null }, cues: {}, states: {},
    fields: { clock: { status: 'failed', reason: 'insufficient-templates', debug: {
      roiPixels: { x: 0, y: 0, width: 16, height: 8 }, gray: { data: new Uint8Array(128), width: 16, height: 8 },
      binary: { data: new Uint8Array(128), width: 16, height: 8 }, normalized: [], projection: [], inkRatio: 0.4, matches,
      boxes: Array.from({ length: text.length }, (_, index) => ({ x: index * 4, y: 0, width: 3, height: 8, ink: 20 })),
    } }, scoreLeft: { status: 'failed', reason: 'not-configured', debug: null },
    scoreRight: { status: 'failed', reason: 'not-configured', debug: null }, round: { status: 'failed', reason: 'not-configured', debug: null } } }
  return { pack, variant, result, matches }
}

describe('automatic countdown pre-teaching validation', () => {
  it('checks known glyphs while identifying genuinely unseen digits as inferred rather than verified', () => {
    const { pack, variant, result } = fixture()
    expect(checkAutoCountdown(result, pack, variant.id, '0:18')).toEqual(['8'])
  })

  it('rejects a frozen or reset clock even before every glyph has been taught', () => {
    const { pack, variant, result } = fixture('0:19')
    expect(() => checkAutoCountdown(result, pack, variant.id, '0:18')).toThrow('匹配已有字符 9')
  })

  it('rejects an ambiguous or incorrect known glyph', () => {
    const { pack, variant, result, matches } = fixture()
    matches[0]!.score = 0.5
    expect(() => checkAutoCountdown(result, pack, variant.id, '0:18')).toThrow('第 1 个字符')
  })

  it.each(['replay', 'indeterminate'] as const)('rejects %s content', content => {
    const { pack, variant, result } = fixture()
    result.content = content
    expect(() => checkAutoCountdown(result, pack, variant.id, '0:18')).toThrow('回放或无法判断')
  })

  it.each(['paused', 'planted', 'statistics', 'roundOver', 'indeterminate'] as const)('rejects the %s phase', phase => {
    const { pack, variant, result } = fixture()
    result.phase = phase
    expect(() => checkAutoCountdown(result, pack, variant.id, '0:18')).toThrow('不是连续倒计时')
  })

  it('refuses an absent field or a blank image instead of inventing new samples', () => {
    const { pack, variant, result } = fixture()
    result.fields.clock.debug!.inkRatio = 0
    expect(() => checkAutoCountdown(result, pack, variant.id, '0:18')).toThrow('前景像素异常')
    result.fields.clock = { status: 'absent', debug: null }
    expect(() => checkAutoCountdown(result, pack, variant.id, '0:18')).toThrow('没有倒计时')
  })

  it('requires a fully recognized clock to equal the expected reading', () => {
    const { pack, variant, result } = fixture()
    result.fields.clock = { status: 'read', debug: null, reading: {
      source: 'recognized', text: '0:19', value: 19, confidence: 1, scores: [1, 1, 1, 1],
    } }
    expect(() => checkAutoCountdown(result, pack, variant.id, '0:18')).toThrow('预计 0:18, 实际识别为 0:19')
    expect(checkAutoCountdown(result, pack, variant.id, '0:19')).toEqual([])
  })
})
