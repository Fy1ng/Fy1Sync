/** Check against existing glyphs before a generated reading can teach its own evidence. */
import type { HudStylePack } from '../../core/hudStylePack'
import type { HudFrameResult } from '../../core/hudWasm'

export function checkAutoCountdown(result: HudFrameResult, pack: HudStylePack, variantId: string, expected: string): string[] {
  const variant = pack.variants.find(item => item.id === variantId)
  const field = variant?.fields.clock
  if (!field || !field.enabled || result.variantId !== variantId) throw new Error('倒计时字段已关闭或无法确认当前布局')
  if (result.content !== 'live') throw new Error('检测到回放或无法判断的画面')
  if (result.phase !== 'active' && result.phase !== 'unconfigured') throw new Error(`当前不是连续倒计时阶段 (${result.phase})`)
  if (variant.organizer?.enabled && result.organizer.status !== 'matched') throw new Error('主办方标记不匹配或无法判断')
  for (const id of ['replay', 'bomb', 'timeout', 'roundOver', 'roundHistory', 'scoreboard'] as const) {
    if (result.cues[id]?.status === 'matched') throw new Error(`检测到画面状态 ${id}, 需要重新确认倒计时`)
  }
  const clock = result.fields.clock
  if (clock.status === 'read') {
    if (clock.reading.text !== expected) throw new Error(`倒计时不匹配: 预计 ${expected}, 实际识别为 ${clock.reading.text}`)
    return []
  }
  if (clock.status !== 'failed' || clock.reason !== 'insufficient-templates') {
    throw new Error(clock.status === 'disabled' ? '倒计时字段已关闭' : clock.status === 'absent' ? '画面没有倒计时' : `倒计时识别失败: ${clock.reason}`)
  }
  const debug = clock.debug
  if (!debug || debug.boxes.length !== expected.length || debug.matches.length !== expected.length
    || debug.inkRatio < 0.004 || debug.inkRatio > 0.85) throw new Error('倒计时字符框或前景像素异常')
  const inferred: string[] = []
  for (const [index, char] of [...expected].entries()) {
    const match = debug.matches[index]!
    const known = field.glyphs[char as keyof typeof field.glyphs]?.length
    const confident = match.char !== null && match.score >= field.match.minScore
      && match.score - match.runnerUpScore >= field.match.minMargin
    if (known) {
      if (!confident || match.char !== char) throw new Error(`第 ${index + 1} 个字符与预计的 ${char} 不匹配, 请人工确认`)
    } else {
      if (confident) throw new Error(`第 ${index + 1} 个字符预计为 ${char}, 却匹配已有字符 ${match.char}, 请人工确认`)
      // An unseen digit can be proposed by countdown arithmetic, never reported as independently verified.
      inferred.push(char)
    }
  }
  return inferred
}
