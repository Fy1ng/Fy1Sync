export const MAX_COMPOSED_MESSAGE_UNITS = 500
export const MAX_COMPOSED_MESSAGE_BYTES = 2_000
// Same set the main process rejects (server/featureApi.ts boundedText), bidi overrides included:
// they reorder what the room sees and would only come back as 扩展接口参数无效.
const UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
const BROKEN_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

export type CompositionErrorCode = 'empty' | 'too-long' | 'invalid-text' | 'invalid-options'
export class MessageCompositionError extends Error {
  constructor(readonly code: CompositionErrorCode) {
    super({ empty: '请输入弹幕内容.', 'too-long': '组合后的弹幕超过本地 500 字符或 2000 字节上限.',
      'invalid-text': '弹幕包含不支持的字符.', 'invalid-options': '弹幕文案配置无效.' }[code])
    this.name = 'MessageCompositionError'
  }
}

export interface MessageAffixes { enabled: boolean; prefix: string; suffix: string }
export const DEFAULT_MESSAGE_AFFIXES: Readonly<MessageAffixes> = Object.freeze({ enabled: false, prefix: '', suffix: '' })

function textValid(value: unknown, limit: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= limit && (allowEmpty || value.trim().length > 0)
    && !UNSAFE_TEXT.test(value) && !BROKEN_SURROGATE.test(value)
}

function fields(raw: unknown, keys: string[]): Record<string, unknown> | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw) as object | null)) return null
    if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key))) return null
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(raw, key)
      if (!field) continue
      if (!('value' in field)) return null
      result[key] = field.value
    }
    return result
  } catch { return null }
}

export function readMessageAffixes(raw: unknown): MessageAffixes | null {
  const value = fields(raw, ['enabled', 'prefix', 'suffix'])
  if (!value) return null
  const enabled = value.enabled ?? false
  const prefix = value.prefix ?? ''
  const suffix = value.suffix ?? ''
  if (typeof enabled !== 'boolean' || !textValid(prefix, 128, true) || !textValid(suffix, 128, true)) return null
  return { enabled, prefix, suffix }
}

/** A repeat stays verbatim, including when normal sends use a prefix or suffix. */
export function composeMessage(text: string, options: { affixes?: MessageAffixes; mode?: 'message' | 'repeat' } = {}): string {
  if (typeof text !== 'string' || UNSAFE_TEXT.test(text) || BROKEN_SURROGATE.test(text)) throw new MessageCompositionError('invalid-text')
  if (!text.trim()) throw new MessageCompositionError('empty')
  if (options.mode !== undefined && options.mode !== 'message' && options.mode !== 'repeat') throw new MessageCompositionError('invalid-options')
  const affixes = readMessageAffixes(options.affixes ?? DEFAULT_MESSAGE_AFFIXES)
  if (!affixes) throw new MessageCompositionError('invalid-options')
  const result = options.mode !== 'repeat' && affixes.enabled ? affixes.prefix + text + affixes.suffix : text
  if (result.length > MAX_COMPOSED_MESSAGE_UNITS || new TextEncoder().encode(result).byteLength > MAX_COMPOSED_MESSAGE_BYTES) throw new MessageCompositionError('too-long')
  return result
}

export function buildReplyDraft(username: string, quotedText: string): string {
  if (!textValid(username, 64)) throw new MessageCompositionError('invalid-text')
  return composeMessage('@' + username + ': ' + quotedText, { mode: 'repeat' })
}

export const LOCAL_MESSAGE_TEMPLATES = {
  cheer: ['{streamer}加油!', '继续加油, 支持{streamer}!'],
  thanks: ['感谢{streamer}的精彩直播!', '辛苦了, {streamer}!'],
  'good-game': ['精彩的一局!', '这波打得漂亮!'],
} as const
export type LocalMessageTemplate = keyof typeof LOCAL_MESSAGE_TEMPLATES
export interface MessageSelection {
  mode: 'sequential' | 'random' | 'automatic'
  texts: string[]
  template: LocalMessageTemplate
}

export function readMessageSelection(raw: unknown): MessageSelection | null {
  const value = fields(raw, ['mode', 'texts', 'template'])
  if (!value) return null
  const mode = value.mode ?? 'sequential'
  const template = value.template ?? 'cheer'
  if ((mode !== 'sequential' && mode !== 'random' && mode !== 'automatic')
    || (template !== 'cheer' && template !== 'thanks' && template !== 'good-game')) return null
  const texts = value.texts ?? []
  if (!Array.isArray(texts) || Object.getPrototypeOf(texts) !== Array.prototype || texts.length > 100
    || Reflect.ownKeys(texts).length !== texts.length + 1 || (mode !== 'automatic' && texts.length === 0)) return null
  const copy: string[] = []
  try {
    for (let i = 0; i < texts.length; i++) {
      const field = Object.getOwnPropertyDescriptor(texts, String(i))
      if (!field || !('value' in field) || !textValid(field.value, MAX_COMPOSED_MESSAGE_UNITS)) return null
      copy.push(composeMessage(field.value))
    }
  } catch { return null }
  return { mode, texts: copy, template }
}

/** Local templates only. This function never reads a remote text service or account data. */
export function selectMessageText(selection: MessageSelection, completedRuns: number,
  options: { random?: () => number; streamer?: string } = {}): { text: string; index: number } {
  const config = readMessageSelection(selection)
  if (!config || !Number.isSafeInteger(completedRuns) || completedRuns < 0) throw new MessageCompositionError('invalid-options')
  const streamer = options.streamer ?? '主播'
  if (!textValid(streamer, 64)) throw new MessageCompositionError('invalid-options')
  const candidates = config.mode === 'automatic' ? [...LOCAL_MESSAGE_TEMPLATES[config.template]] : config.texts
  let index = completedRuns % candidates.length
  if (config.mode === 'random') {
    const sample = (options.random ?? Math.random)()
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new MessageCompositionError('invalid-options')
    index = Math.floor(sample * candidates.length)
  }
  const text = config.mode === 'automatic' ? candidates[index]!.replaceAll('{streamer}', () => streamer) : candidates[index]!
  return { text: composeMessage(text), index }
}
