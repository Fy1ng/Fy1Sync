/**
 * The 定时弹幕 editor's draft and its translation into a `DouyuMessageSchedule`. Texts are
 * one per line; 自动文案 uses only the bundled local templates. The number of sends is
 * never filled in for the viewer: either a count is typed, or 持续发送 is switched on.
 */

import {
  LOCAL_MESSAGE_TEMPLATES, MessageCompositionError, composeMessage,
  type LocalMessageTemplate, type MessageSelection,
} from '../../core/messageComposition'
import { readMessageSchedule } from '../../../server/douyu/taskConfig'
import type { DouyuMessageSchedule } from '../../../server/douyu/types'

export const SELECTION_LABEL: Record<MessageSelection['mode'], string> = { sequential: '顺序', random: '随机', automatic: '自动文案' }
export const TEMPLATE_LABEL: Record<LocalMessageTemplate, string> = { cheer: '加油', thanks: '感谢', 'good-game': '精彩对局' }

export interface LoopDraft {
  lines: string
  mode: MessageSelection['mode']
  template: LocalMessageTemplate
  colors: number[]
  interval: string
  delay: string
  runs: string
  unlimited: boolean
  limitDuration: boolean
  duration: string
}

export const EMPTY_LOOP: LoopDraft = {
  lines: '', mode: 'sequential', template: 'cheer', colors: [0], interval: '60', delay: '0',
  runs: '', unlimited: false, limitDuration: false, duration: '',
}

/** Template lines as they will read, with the streamer placeholder filled in. */
export const templateLines = (template: LocalMessageTemplate): string[] =>
  LOCAL_MESSAGE_TEMPLATES[template].map((line) => line.replaceAll('{streamer}', '主播'))

export const messageLines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

const integer = (text: string, min: number, max: number): number | null => {
  const value = Number(text)
  return text.trim() !== '' && Number.isInteger(value) && value >= min && value <= max ? value : null
}

export function buildMessageSchedule(draft: LoopDraft): { schedule: DouyuMessageSchedule } | { error: string } {
  const automatic = draft.mode === 'automatic'
  const texts = automatic ? [] : messageLines(draft.lines)
  if (!automatic) {
    if (texts.length === 0) return { error: '请填写发送内容，每行一条' }
    if (texts.length > 100) return { error: '发送内容最多 100 条' }
    for (const [index, line] of texts.entries()) {
      try { composeMessage(line) } catch (error) {
        const tooLong = error instanceof MessageCompositionError && error.code === 'too-long'
        return { error: `第 ${index + 1} 条${tooLong ? '超过 500 字' : '包含不支持的字符'}` }
      }
    }
  }
  if (draft.colors.length === 0) return { error: '请至少选择一种颜色' }
  const intervalSeconds = integer(draft.interval, 1, 86_400)
  if (intervalSeconds === null) return { error: '发送间隔须为 1 至 86400 秒的整数' }
  const initialDelaySeconds = integer(draft.delay, 0, 86_400)
  if (initialDelaySeconds === null) return { error: '启动延迟须为 0 至 86400 秒的整数' }
  const maxRuns = draft.unlimited ? null : integer(draft.runs, 1, 1_000)
  if (!draft.unlimited && maxRuns === null) return { error: '请填写发送次数（1 至 1000），或选择持续发送' }
  const maxDurationSeconds = draft.limitDuration ? integer(draft.duration, 1, 86_400) : null
  if (draft.limitDuration && maxDurationSeconds === null) return { error: '总时长须为 1 至 86400 秒的整数' }

  const raw: DouyuMessageSchedule = {
    // With a selection the sender picks the text; `text` stays the first line for display.
    text: automatic ? templateLines(draft.template)[0]! : texts[0]!,
    colors: [...draft.colors], intervalSeconds, initialDelaySeconds, maxRuns,
    ...(draft.limitDuration ? { maxDurationSeconds } : {}),
    selection: { mode: draft.mode, texts, template: draft.template },
  }
  const schedule = readMessageSchedule(raw)
  return schedule ? { schedule } : { error: '发送配置无效，请检查各项设置' }
}

export function durationText(seconds: number): string {
  if (seconds >= 3_600 && seconds % 3_600 === 0) return `${seconds / 3_600} 小时`
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
}
