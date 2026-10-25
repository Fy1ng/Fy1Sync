import type { DouyuMessageSchedule } from './types'
import { readMessageAffixes, readMessageSelection } from '../../src/core/messageComposition'

const KEYS = ['text', 'colors', 'intervalSeconds', 'initialDelaySeconds', 'maxRuns']
const UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f\u2028\u2029\uD800-\uDFFF]/u

/** Parse only bounded plain data; callers retain ownership of all incoming objects. */
export function readMessageSchedule(raw: unknown): DouyuMessageSchedule | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const prototype: unknown = Object.getPrototypeOf(raw)
    if (prototype !== Object.prototype && prototype !== null) return null
    const optional = ['maxDurationSeconds', 'selection', 'affixes'].filter(key => Object.hasOwn(raw, key))
    const keys = [...KEYS, ...optional]
    if (Reflect.ownKeys(raw).length !== keys.length) return null
    const fields: Record<string, unknown> = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key)
      if (!descriptor || !('value' in descriptor)) return null
      fields[key] = descriptor.value
    }
    if (typeof fields.text !== 'string' || fields.text.length > 500 || !fields.text.trim() || UNSAFE_TEXT.test(fields.text)
      || typeof fields.intervalSeconds !== 'number' || !Number.isInteger(fields.intervalSeconds)
      || fields.intervalSeconds < 1 || fields.intervalSeconds > 86_400
      || typeof fields.initialDelaySeconds !== 'number' || !Number.isInteger(fields.initialDelaySeconds)
      || fields.initialDelaySeconds < 0 || fields.initialDelaySeconds > 86_400
      || (fields.maxRuns !== null && (typeof fields.maxRuns !== 'number' || !Number.isInteger(fields.maxRuns)
        || fields.maxRuns < 1 || fields.maxRuns > 1_000))) return null
    const rawColors = fields.colors
    if (!Array.isArray(rawColors) || Object.getPrototypeOf(rawColors) !== Array.prototype) return null
    const length: unknown = Object.getOwnPropertyDescriptor(rawColors, 'length')?.value
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > 7
      || Reflect.ownKeys(rawColors).length !== length + 1) return null
    const colors: number[] = []
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(rawColors, String(index))
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'number'
        || !Number.isInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 6
        || colors.includes(descriptor.value)) return null
      colors.push(descriptor.value)
    }
    const duration = fields.maxDurationSeconds
    if (optional.includes('maxDurationSeconds') && duration !== null && (typeof duration !== 'number'
      || !Number.isSafeInteger(duration) || duration < 1 || duration > 86_400)) return null
    const selection = optional.includes('selection') ? readMessageSelection(fields.selection) : undefined
    const affixes = optional.includes('affixes') ? readMessageAffixes(fields.affixes) : undefined
    if (selection === null || affixes === null) return null
    return { text: fields.text, colors, intervalSeconds: fields.intervalSeconds,
      initialDelaySeconds: fields.initialDelaySeconds, maxRuns: fields.maxRuns as number | null,
      ...(optional.includes('maxDurationSeconds') ? { maxDurationSeconds: duration as number | null } : {}),
      ...(selection ? { selection } : {}), ...(affixes ? { affixes } : {}) }
  } catch { return null }
}
