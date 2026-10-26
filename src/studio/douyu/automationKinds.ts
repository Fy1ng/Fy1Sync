/**
 * What each account/batch automation may be pointed at and configured with. The table
 * mirrors `readAutomationRequest` in server/douyu/automationTypes.ts, which stays the
 * authority: the form only offers combinations that function accepts, and the request
 * builder emits exactly the keys it allows, never an activity ID, URL or cookie.
 */

import type { CreateAutomation } from '../../../electron/automationManager'
import type { DouyuAutomationKind, DouyuAutomationOptions, DouyuAutomationTarget } from '../../../server/douyu/automationTypes'
import type { DouyuTaskPolicy } from '../../../server/douyu/types'

export type TargetChoice = 'account' | 'room' | 'group' | 'followed-rooms' | 'followed-yuba' | 'selected-rooms'
export type OptionField = 'maxItems' | 'yuba' | 'arena' | 'postIds' | 'followRooms'
export type KindGroup = 'sign' | 'claim' | 'task'

export interface KindSpec {
  label: string
  group: KindGroup
  targets: TargetChoice[]
  fields: OptionField[]
  note: string
}

export const GROUP_LABEL: Record<KindGroup, string> = { sign: '签到', claim: '领取', task: '任务' }

export const KIND_SPEC: Record<DouyuAutomationKind, KindSpec> = {
  'followed-room-sign': {
    label: '关注房间签到', group: 'sign', targets: ['followed-rooms'], fields: ['maxItems'],
    note: '需完整读取该账号的全部关注列表，列表未读全时不执行。逐个房间签到，结果以官方状态为准。',
  },
  'yuba-sign-all': {
    label: '鱼吧签到', group: 'sign', targets: ['followed-yuba', 'group'], fields: ['yuba', 'maxItems'],
    note: '极速签到仅适用于全部关注的鱼吧，完成后逐个核对，未签到的鱼吧改为普通签到。补签仅消耗已有补签卡，不购买。',
  },
  'client-sign': {
    label: '客户端签到', group: 'sign', targets: ['account'], fields: [],
    note: '仅针对所选账号，奖励以官方状态为准。',
  },
  'arena-sign': {
    label: '右侧活动签到', group: 'sign', targets: ['room', 'selected-rooms', 'followed-rooms'], fields: ['arena', 'maxItems'],
    note: '按官方当期活动配置执行，未找到有效活动时停止。',
  },
  'fans-home-sign': {
    label: '粉丝家园签到', group: 'sign', targets: ['room', 'selected-rooms', 'followed-rooms'], fields: ['maxItems'],
    note: '需具备官方资格。签到状态无法确认时转为人工核对。',
  },
  'diamond-fans-sign': {
    label: '钻粉联赛签到', group: 'sign', targets: ['room', 'selected-rooms', 'followed-rooms'], fields: ['maxItems'],
    note: '需具备官方资格。签到状态无法确认时转为人工核对。',
  },
  'points-sign': {
    label: '积分签到', group: 'sign', targets: ['account'], fields: [],
    note: '当前积分活动来源可能不可用，不可用时任务停止。',
  },
  'anchor-star-sign': {
    label: '星推签到', group: 'sign', targets: ['room'], fields: ['maxItems'],
    note: '默认最多处理 3 个官方榜单房间。',
  },
  'level-reward': {
    label: '等级任务奖励', group: 'claim', targets: ['room'], fields: ['maxItems'],
    note: '仅领取官方已完成且未领取的等级任务奖励，每轮一项，领取后重新读取核对。',
  },
  'watch-points': {
    label: '观看积分', group: 'claim', targets: ['account'], fields: ['maxItems'],
    note: '仅领取官方已完成的观看积分，不模拟观看过程。当前积分活动来源可能不可用。',
  },
  'yuba-read': {
    label: '鱼吧阅读', group: 'task', targets: ['account'], fields: ['postIds', 'maxItems'],
    note: '仅读取所填帖子，不保证获得阅读奖励。',
  },
  'follow-task': {
    label: '关注任务', group: 'task', targets: ['account'], fields: ['followRooms', 'maxItems'],
    note: '仅关注所填房间，已关注的房间跳过，不取消已有关注。',
  },
  'anchor-star-follow': {
    label: '星推关注', group: 'task', targets: ['room'], fields: ['followRooms', 'maxItems'],
    note: '仅关注所填房间，已关注的房间跳过，不取消已有关注。',
  },
}

export const KIND_ORDER: DouyuAutomationKind[] = [
  'followed-room-sign', 'yuba-sign-all', 'client-sign', 'arena-sign', 'fans-home-sign', 'diamond-fans-sign', 'points-sign', 'anchor-star-sign',
  'level-reward', 'watch-points',
  'yuba-read', 'follow-task', 'anchor-star-follow',
]

export const TARGET_LABEL: Record<TargetChoice, string> = {
  account: '账号', room: '指定房间', group: '指定鱼吧', 'followed-rooms': '全部关注房间',
  'followed-yuba': '全部关注鱼吧', 'selected-rooms': '所选房间',
}

export const YUBA_MODE_LABEL = { normal: '普通', fast: '极速', supplement: '补签' } as const
export const ARENA_LABEL = { actqzs: '右侧活动', cardArena: 'cardArena' } as const

export interface AutomationDraft {
  accountId: string
  kind: DouyuAutomationKind
  target: TargetChoice
  /** Already resolved to the real numeric room. */
  room: string
  groupId: string
  rooms: string
  yubaMode: 'normal' | 'fast' | 'supplement'
  maxSupplementCards: string
  arena: 'actqzs' | 'cardArena'
  postIds: string
  followRooms: string
  maxItems: string
  policy: DouyuTaskPolicy
  repeat: boolean
  repeatMinutes: string
}

const ROOM = /^[1-9][0-9]{0,11}$/
const LONG_ID = /^[1-9][0-9]{0,19}$/

/** Split a pasted list on whitespace and commas; the result is checked, never repaired. */
export function parseIds(text: string, pattern: RegExp): { ids: string[]; error: string | null } {
  const ids = text.split(/[\s,，、;；]+/).filter(Boolean)
  if (ids.length === 0) return { ids, error: '请至少填写一个编号' }
  if (ids.length > 100) return { ids, error: '最多填写 100 个编号' }
  if (ids.some((id) => !pattern.test(id))) return { ids, error: '编号须为数字' }
  if (new Set(ids).size !== ids.length) return { ids, error: '编号存在重复' }
  return { ids, error: null }
}

const integer = (text: string, min: number, max: number): number | null => {
  const value = Number(text)
  return text.trim() !== '' && Number.isInteger(value) && value >= min && value <= max ? value : null
}

export function yubaModeAllowed(target: TargetChoice, mode: AutomationDraft['yubaMode']): boolean {
  return mode !== 'fast' || target === 'followed-yuba'
}

/** Either the exact create request, or the first reason the draft cannot be sent. */
export function buildAutomationRequest(draft: AutomationDraft): { request: CreateAutomation } | { error: string } {
  const spec = KIND_SPEC[draft.kind]
  if (!draft.accountId) return { error: '请选择账号' }
  if (!spec.targets.includes(draft.target)) return { error: '目标范围不适用于该任务' }

  let target: DouyuAutomationTarget
  switch (draft.target) {
    case 'account': target = { type: 'account' }; break
    case 'room':
      if (!ROOM.test(draft.room)) return { error: '请填写数字房间号' }
      target = { type: 'room', room: draft.room }; break
    case 'group':
      if (!LONG_ID.test(draft.groupId.trim())) return { error: '请填写数字鱼吧 ID' }
      target = { type: 'group', groupId: draft.groupId.trim() }; break
    case 'selected-rooms': {
      const { ids, error } = parseIds(draft.rooms, ROOM)
      if (error) return { error: `房间列表：${error}` }
      target = { type: 'batch', source: 'selected-rooms', rooms: ids }; break
    }
    case 'followed-rooms': target = { type: 'batch', source: 'followed-rooms' }; break
    case 'followed-yuba': target = { type: 'batch', source: 'followed-yuba' }; break
  }

  const options: DouyuAutomationOptions = {}
  if (spec.fields.includes('yuba')) {
    if (!yubaModeAllowed(draft.target, draft.yubaMode)) return { error: '极速签到仅适用于全部关注的鱼吧' }
    options.yubaMode = draft.yubaMode
    if (draft.yubaMode === 'supplement') {
      const cards = integer(draft.maxSupplementCards, 1, 100)
      if (cards === null) return { error: '请填写补签卡最多使用数量（1 至 100）' }
      options.maxSupplementCards = cards
    }
  }
  if (spec.fields.includes('arena')) options.arena = draft.arena
  if (spec.fields.includes('postIds')) {
    const { ids, error } = parseIds(draft.postIds, LONG_ID)
    if (error) return { error: `帖子 ID：${error}` }
    options.postIds = ids
  }
  if (spec.fields.includes('followRooms')) {
    const { ids, error } = parseIds(draft.followRooms, ROOM)
    if (error) return { error: `关注房间：${error}` }
    options.followRooms = ids
  }
  if (spec.fields.includes('maxItems') && draft.maxItems.trim() !== '') {
    const max = integer(draft.maxItems, 1, 2000)
    if (max === null) return { error: '最多处理数量须为 1 至 2000 的整数' }
    options.maxItems = max
  }

  let repeatMinutes: number | null = null
  if (draft.repeat) {
    repeatMinutes = integer(draft.repeatMinutes, 60, 43_200)
    if (repeatMinutes === null) return { error: '重复间隔须为 60 至 43200 分钟的整数' }
  }

  return { request: { accountId: draft.accountId, kind: draft.kind, target, options, policy: draft.policy, repeatMinutes } }
}
