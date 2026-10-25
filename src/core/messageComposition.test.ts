import { describe, expect, it, vi } from 'vitest'
import { buildReplyDraft, composeMessage, readMessageAffixes, readMessageSelection, selectMessageText } from './messageComposition'

describe('outgoing text composition', () => {
  const affixes = { enabled: true, prefix: '[前]', suffix: '[后]' }
  it('composes enabled affixes but leaves a +1 repeat unchanged', () => {
    expect(composeMessage('原文', { affixes })).toBe('[前]原文[后]')
    expect(composeMessage(' 原文 ', { affixes, mode: 'repeat' })).toBe(' 原文 ')
    expect(composeMessage('原文', { affixes: { ...affixes, enabled: false } })).toBe('原文')
    expect(buildReplyDraft('观众', '精彩')).toBe('@观众: 精彩')
  })

  it('validates the composed text instead of truncating a tail or a reply', () => {
    expect(() => composeMessage('a'.repeat(500), { affixes })).toThrow('组合后的弹幕')
    expect(() => buildReplyDraft('viewer', 'a'.repeat(500))).toThrow('组合后的弹幕')
    expect(composeMessage('😀'.repeat(250))).toHaveLength(500)
    for (const value of ['\ud800', 'line\nline', 'a\u2028b', '\0', '  ']) expect(() => composeMessage(value)).toThrow()
  })

  it('rejects malformed preferences and an accessor without invoking it', () => {
    const getter = vi.fn(() => 'secret')
    expect(readMessageAffixes(Object.defineProperty({}, 'prefix', { get: getter }))).toBeNull()
    expect(getter).not.toHaveBeenCalled()
    expect(readMessageAffixes({ prefix: 'a'.repeat(129) })).toBeNull()
    expect(readMessageAffixes({ enabled: 1 })).toBeNull()
  })

  it('selects sequential and random copies using injectable randomness', () => {
    const sequential = { mode: 'sequential', texts: ['第一条', '第二条'], template: 'cheer' } as const
    const parsed = readMessageSelection({ ...sequential, texts: [...sequential.texts] })!
    expect(selectMessageText(parsed, 3)).toEqual({ text: '第二条', index: 1 })
    expect(selectMessageText({ ...parsed, mode: 'random' }, 0, { random: () => 0.1 })).toEqual({ text: '第一条', index: 0 })
    expect(selectMessageText({ ...parsed, mode: 'random' }, 0, { random: () => 0.9 })).toEqual({ text: '第二条', index: 1 })
    expect(() => selectMessageText({ ...parsed, mode: 'random' }, 0, { random: () => 1 })).toThrow()
  })

  it('generates local template copy without network or interpreter input', () => {
    const selection = readMessageSelection({ mode: 'automatic', template: 'thanks' })!
    expect(selectMessageText(selection, 0, { streamer: '甲' }).text).toBe('感谢甲的精彩直播!')
    expect(selectMessageText(selection, 0, { streamer: '$&' }).text).toBe('感谢$&的精彩直播!')
    expect(readMessageSelection({ mode: 'automatic', template: 'remote-script' })).toBeNull()
    expect(readMessageSelection({ mode: 'sequential', texts: [] })).toBeNull()
    expect(readMessageSelection({ mode: 'sequential', texts: new Array(2) })).toBeNull()
  })
})
