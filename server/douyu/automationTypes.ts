import type { DouyuActionDependencies } from './actions'
import type { DouyuFollowedRooms } from './insightsTypes'
import type { DouyuTaskOutcome } from './types'

export const DOUYU_CHECK_IN_KINDS = ['followed-room-sign', 'yuba-sign-all', 'client-sign', 'arena-sign', 'fans-home-sign', 'diamond-fans-sign'] as const
export const DOUYU_LEVEL_REWARD_KINDS = ['yuba-read', 'follow-task', 'points-sign', 'anchor-star-sign', 'anchor-star-follow', 'level-reward', 'watch-points'] as const
export const DOUYU_AUTOMATION_KINDS = [...DOUYU_CHECK_IN_KINDS, ...DOUYU_LEVEL_REWARD_KINDS] as const
export type DouyuAutomationKind = typeof DOUYU_AUTOMATION_KINDS[number]

export type DouyuAutomationTarget =
  | { type: 'account' }
  | { type: 'room'; room: string }
  | { type: 'group'; groupId: string }
  | { type: 'batch'; source: 'followed-rooms' | 'followed-yuba' }
  | { type: 'batch'; source: 'selected-rooms'; rooms: string[] }

/** Options never contain a URL, cookie, script, arbitrary endpoint or free-form activity ID. */
export interface DouyuAutomationOptions {
  yubaMode?: 'normal' | 'fast' | 'supplement'
  /** Explicit maximum number of already-owned cards this run may consume. */
  maxSupplementCards?: number
  arena?: 'actqzs' | 'cardArena'
  postIds?: string[]
  /** Room identities chosen by the user, never inferred from a third-party promotion. */
  followRooms?: string[]
  maxItems?: number
}

export interface DouyuAutomationRequest {
  taskId: string
  accountId: string
  target: DouyuAutomationTarget
  kind: DouyuAutomationKind
  options: DouyuAutomationOptions
}

export interface DouyuAutomationProgress {
  completed: number
  total: number | null
  skipped: number
  current: string | null
  /** A POST receipt is deliberately separate from a confirmed read-back. */
  evidence: 'none' | 'official-state' | 'receipt-received' | 'unconfirmed'
}
export type DouyuAutomationOutcome = DouyuTaskOutcome & { progress?: DouyuAutomationProgress }

export interface DouyuAutomationDependencies extends DouyuActionDependencies {
  now?: () => number
  /** Shared account gateway. A partial directory must never start an all-followed run. */
  readFollowedRooms?: (accountId: string, signal: AbortSignal) => Promise<DouyuFollowedRooms>
}

const id = (value: unknown, max = 20): value is string => typeof value === 'string' && new RegExp(`^[1-9][0-9]{0,${max - 1}}$`).test(value)
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
const keys = (value: Record<string, unknown>, allowed: string[]) => Reflect.ownKeys(value).every(key => typeof key === 'string'
  && allowed.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))

/** Validate and detach caller-owned objects before any async work begins. */
export function readAutomationRequest(raw: unknown): DouyuAutomationRequest {
  const invalid = (): never => { throw new Error('斗鱼自动任务参数无效.') }
  try {
    if (!plain(raw) || !keys(raw, ['taskId', 'accountId', 'target', 'kind', 'options'])
      || typeof raw.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.taskId)
      || typeof raw.accountId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.accountId)
      || !DOUYU_AUTOMATION_KINDS.includes(raw.kind as DouyuAutomationKind)
      || !plain(raw.target) || !plain(raw.options)) return invalid()
    const target = raw.target
    if (target.type === 'account') { if (!keys(target, ['type'])) return invalid() }
    else if (target.type === 'room') { if (!keys(target, ['type', 'room']) || !id(target.room, 12)) return invalid() }
    else if (target.type === 'group') { if (!keys(target, ['type', 'groupId']) || !id(target.groupId)) return invalid() }
    else if (target.type === 'batch') {
      if (target.source === 'selected-rooms') {
        if (!keys(target, ['type', 'source', 'rooms']) || !validIds(target.rooms, 12)) return invalid()
      } else if (!['followed-rooms', 'followed-yuba'].includes(target.source as string) || !keys(target, ['type', 'source'])) return invalid()
    } else return invalid()
    const options = raw.options
    const allowed: Record<DouyuAutomationKind, string[]> = {
      'followed-room-sign': ['maxItems'], 'yuba-sign-all': ['yubaMode', 'maxSupplementCards', 'maxItems'],
      'client-sign': [], 'arena-sign': ['arena', 'maxItems'], 'fans-home-sign': ['maxItems'], 'diamond-fans-sign': ['maxItems'],
      'yuba-read': ['postIds', 'maxItems'], 'follow-task': ['followRooms', 'maxItems'], 'points-sign': [],
      'anchor-star-sign': ['maxItems'], 'anchor-star-follow': ['followRooms', 'maxItems'], 'level-reward': ['maxItems'], 'watch-points': ['maxItems'],
    }
    const kind = raw.kind as DouyuAutomationKind
    if (!keys(options, allowed[kind])) return invalid()
    if (options.maxItems !== undefined && (!Number.isInteger(options.maxItems) || Number(options.maxItems) < 1 || Number(options.maxItems) > 2_000)) return invalid()
    if (options.yubaMode !== undefined && !['normal', 'fast', 'supplement'].includes(options.yubaMode as string)) return invalid()
    if (options.maxSupplementCards !== undefined && (!Number.isInteger(options.maxSupplementCards) || Number(options.maxSupplementCards) < 1 || Number(options.maxSupplementCards) > 100)) return invalid()
    if ((options.yubaMode === 'supplement') !== (options.maxSupplementCards !== undefined)) return invalid()
    if (options.arena !== undefined && !['actqzs', 'cardArena'].includes(options.arena as string)) return invalid()
    if (options.postIds !== undefined && !validIds(options.postIds, 20)) return invalid()
    if (options.followRooms !== undefined && !validIds(options.followRooms, 12)) return invalid()
    if (kind === 'followed-room-sign' && (target.type !== 'batch' || target.source !== 'followed-rooms')) return invalid()
    if (kind === 'yuba-sign-all' && !(target.type === 'group' || target.type === 'batch' && target.source === 'followed-yuba')) return invalid()
    if (['client-sign', 'points-sign', 'watch-points'].includes(kind) && target.type !== 'account') return invalid()
    if (['arena-sign', 'fans-home-sign', 'diamond-fans-sign'].includes(kind) && !(target.type === 'room'
      || target.type === 'batch' && ['followed-rooms', 'selected-rooms'].includes(String(target.source)))) return invalid()
    if (['anchor-star-sign', 'anchor-star-follow', 'level-reward'].includes(kind) && target.type !== 'room') return invalid()
    if (kind === 'yuba-read' && (target.type !== 'account' || !validIds(options.postIds, 20))) return invalid()
    if (['follow-task', 'anchor-star-follow'].includes(kind) && !validIds(options.followRooms, 12)) return invalid()
    if (kind === 'follow-task' && target.type !== 'account') return invalid()
    if (options.yubaMode === 'fast' && target.type !== 'batch') return invalid()
    return structuredClone({ taskId: raw.taskId, accountId: raw.accountId, target, kind, options }) as unknown as DouyuAutomationRequest
  } catch { return invalid() }
}

function validIds(raw: unknown, length: number): raw is string[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length < 1 || raw.length > 100
    || Reflect.ownKeys(raw).length !== raw.length + 1) return false
  for (let index = 0; index < raw.length; index++) {
    const field = Object.getOwnPropertyDescriptor(raw, String(index))
    if (!field || !('value' in field) || !id(field.value, length)) return false
  }
  return new Set(raw).size === raw.length
}
