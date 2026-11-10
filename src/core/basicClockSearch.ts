/** Author-defined search bounds are bundled with the build, never read from viewer preferences. */
import bundledConfig from '../recognition/basicSearchRegion.json'
import type { RoiRect } from './profileSchema'

export interface BasicClockSearchConfig {
  schemaVersion: 1
  configured: boolean
  roi: RoiRect | null
}

const ERROR_PREFIX = '生产寻找区间配置无效: '

function invalid(reason: string): never { throw new Error(ERROR_PREFIX + reason) }

/** Read only exact own data properties, including when this parser receives IPC input. */
function fields(raw: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(label + '必须是对象')
  const prototype = Object.getPrototypeOf(raw)
  if (prototype !== Object.prototype && prototype !== null) invalid(label + '不是普通配置对象')
  const keys = Reflect.ownKeys(raw)
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) {
    invalid(label + '字段必须为 ' + expected.join(', '))
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)
    if (!descriptor || !('value' in descriptor)) invalid(label + '不能使用动态属性')
    result[key] = descriptor.value
  }
  return result
}

/** Invalid author data must fail clearly instead of silently expanding search to the whole picture. */
export function parseBasicClockSearchConfig(raw: unknown): BasicClockSearchConfig {
  try {
    const config = fields(raw, ['schemaVersion', 'configured', 'roi'], '配置')
    if (config.schemaVersion !== 1) invalid('不支持的 schemaVersion')
    if (typeof config.configured !== 'boolean') invalid('configured 必须为布尔值')
    if (!config.configured) {
      if (config.roi !== null) invalid('未设定时 roi 必须为 null')
      return { schemaVersion: 1, configured: false, roi: null }
    }
    const values = fields(config.roi, ['x', 'y', 'w', 'h'], 'roi')
    if (![values.x, values.y, values.w, values.h].every(value => typeof value === 'number' && Number.isFinite(value))) {
      invalid('roi 坐标必须为有限数值')
    }
    const roi = { x: values.x, y: values.y, w: values.w, h: values.h } as RoiRect
    if (roi.x < 0 || roi.y < 0 || roi.x >= 1 || roi.y >= 1 || roi.w <= 0 || roi.h <= 0
      || roi.x + roi.w > 1 || roi.y + roi.h > 1) {
      invalid('roi 必须在画面内且宽高大于零')
    }
    return { schemaVersion: 1, configured: true, roi }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(ERROR_PREFIX)) throw error
    invalid('无法读取配置字段')
  }
}

/** Return independent values so authoring drafts and recognition profiles cannot mutate the asset. */
export function getBasicClockSearchConfig(): BasicClockSearchConfig {
  return parseBasicClockSearchConfig(bundledConfig)
}

export function getBasicClockSearchRoi(): RoiRect | null {
  return getBasicClockSearchConfig().roi
}
