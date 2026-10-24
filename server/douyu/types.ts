import type { PlatformLoginStatus } from '../../electron/login'

export interface DouyuAccountSummary {
  id: string
  label: string
  active: boolean
  busy: boolean
  login: PlatformLoginStatus
}

export interface DouyuAccountsSnapshot {
  activeAccountId: string | null
  accounts: DouyuAccountSummary[]
}

export const DOUYU_TASK_POLICIES = ['foreground', 'background-unlocked', 'background-locked'] as const
export type DouyuTaskPolicy = typeof DOUYU_TASK_POLICIES[number]
export const DOUYU_ACTIVITY_KINDS = ['auto-fish', 'gift-packet', 'treasure-box'] as const
export type DouyuActivityKind = typeof DOUYU_ACTIVITY_KINDS[number]
export const isDouyuActivityKind = (kind: unknown): kind is DouyuActivityKind =>
  typeof kind === 'string' && (DOUYU_ACTIVITY_KINDS as readonly string[]).includes(kind)
export const DOUYU_TASK_KINDS = ['room-sign', 'yuba-sign', 'message-loop', ...DOUYU_ACTIVITY_KINDS] as const
export type DouyuTaskKind = typeof DOUYU_TASK_KINDS[number]

export interface DouyuMessageSchedule {
  text: string
  /** Official color indices, in the user's rotation order. */
  colors: number[]
  intervalSeconds: number
  initialDelaySeconds: number
  /** Null continues until paused, cancelled or an unconfirmed result occurs. */
  maxRuns: number | null
}

export interface DouyuTaskDefinition {
  id: string
  accountId: string
  room: string
  kind: DouyuTaskKind
  policy: DouyuTaskPolicy
  /** Calendar repeat for check-ins. Activity adapters own their waits and use null. */
  repeatMinutes: number | null
  createdAt: number
  /** Required only for message-loop; all other task kinds must omit it. */
  message?: DouyuMessageSchedule
}

export interface DouyuTaskView extends DouyuTaskDefinition {
  status: 'paused' | 'queued' | 'running' | 'waiting-user' | 'succeeded' | 'failed' | 'stopped'
  reason: string | null
  lastRunAt: number | null
  nextRunAt: number | null
  lastResult: string | null
  /** Message tasks only. Resets on an explicit new start and is never persisted. */
  completedRuns?: number
}

export interface DouyuRuntimeState {
  foreground: boolean
  locked: boolean
  suspended: boolean
}

export interface DouyuTasksSnapshot {
  activeAccountId: string | null
  currentRoom: string | null
  retainedRooms: string[]
  runtime: DouyuRuntimeState
  tasks: DouyuTaskView[]
}

export interface DouyuTaskStorage {
  version: 1
  tasks: DouyuTaskDefinition[]
  retainedRooms: string[]
}

export type DouyuTerminalOutcome =
  | { status: 'succeeded'; message: string }
  | { status: 'waiting-user'; message: string }
  | { status: 'failed'; message: string }

/** Only activity adapters may schedule a fresh read after a known wait. */
export type DouyuTaskOutcome = DouyuTerminalOutcome
  | { status: 'scheduled'; message: string; nextRunAt: number }

export type CreateDouyuTask = Omit<DouyuTaskDefinition, 'id' | 'createdAt'>

/** One explicit send. Message text is never persisted in task configuration. */
export interface DouyuMessageInput {
  accountId: string
  room: string
  text: string
  color: number
}

export type DouyuMessageOutcome = DouyuTerminalOutcome & {
  /** Absolute deadline in milliseconds, if the gateway reports a cooldown. */
  nextAllowedAt: number | null
  /** Proven not sent, waiting only for a known cooldown. Never set after dispatch. */
  deferredUntil?: number
}

/** Main-process-only scope for an explicitly confirmed, nonpersistent operation. */
export interface DouyuAccountOperationContext {
  accountId: string
  originRoom: string | null
  rooms: string[]
}

export type DouyuAccountOperationOutcome<T> =
  | { status: 'completed'; value: T }
  | { status: 'cancelled'; started: boolean }
  | { status: 'busy' | 'unavailable' | 'failed' }
