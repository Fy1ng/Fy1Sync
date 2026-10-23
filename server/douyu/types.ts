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
export type DouyuTaskKind = 'room-sign'

export interface DouyuTaskDefinition {
  id: string
  accountId: string
  room: string
  kind: DouyuTaskKind
  policy: DouyuTaskPolicy
  /** Null runs once; recurring work is armed only by an explicit start. */
  repeatMinutes: number | null
  createdAt: number
}

export interface DouyuTaskView extends DouyuTaskDefinition {
  status: 'paused' | 'queued' | 'running' | 'waiting-user' | 'succeeded' | 'failed' | 'stopped'
  reason: string | null
  lastRunAt: number | null
  nextRunAt: number | null
  lastResult: string | null
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

export type DouyuTaskOutcome =
  | { status: 'succeeded'; message: string }
  | { status: 'waiting-user'; message: string }
  | { status: 'failed'; message: string }

export type CreateDouyuTask = Omit<DouyuTaskDefinition, 'id' | 'createdAt'>
