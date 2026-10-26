/**
 * Live-notification state for the renderer (handoff item 69).
 *
 * The monitor runs in the main process for as long as the app does, while the 关注 tab is
 * mounted only while it is open. So the settings that were sent, the `insights` feature
 * subscription and the notices it produces live here, at module level, and survive the
 * tab closing. Notices are also handed to the session's toast line so they are seen while
 * watching, and to a system notification when the platform allows one.
 */

import { useSyncExternalStore } from 'react'
import { apiClient } from '../../app/apiClient'
import type { DouyuInsightsEvent } from '../../../server/douyu/insightsTypes'

export type NotifyScope = 'selected' | 'all'

export interface LiveNotice { id: string; room: string; text: string; at: number }

export interface LiveNoticeState {
  enabled: boolean
  scope: NotifyScope
  rooms: string[]
  /** The account the main-process monitor was started for; null when none was passed. */
  accountId: string | null
  pending: boolean
  error: string
  monitorError: string
  /** Why the reminder was switched off by the app rather than by the viewer. */
  stopped: string
  notices: LiveNotice[]
}

const MAX_NOTICES = 20
export const MAX_NOTIFY_ROOMS = 64

const INITIAL: LiveNoticeState = {
  enabled: false, scope: 'selected', rooms: [], accountId: null, pending: false, error: '', monitorError: '', stopped: '', notices: [],
}

type Sink = (text: string) => void

let state: LiveNoticeState = INITIAL
const listeners = new Set<() => void>()
const names = new Map<string, string>()
let unsubscribe: (() => void) | null = null
let sink: Sink | null = null
let generation = 0

function set(patch: Partial<LiveNoticeState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

const isEvent = (value: unknown): value is DouyuInsightsEvent =>
  !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'

function systemNotify(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    new Notification(title, { body })
  } catch { /* The in-app notice is enough. */ }
}

function onEvent(event: DouyuInsightsEvent): void {
  if (event.type === 'monitor-error') {
    if (state.accountId && event.accountId !== state.accountId) return
    set({ monitorError: event.message })
    return
  }
  if (event.type !== 'live') return
  const { notification } = event
  // The same notification may be delivered twice; it is not a new start.
  if (state.notices.some((notice) => notice.id === notification.id)) return
  const name = names.get(notification.room)
  const label = name ? `${name}（${notification.room}）` : `房间 ${notification.room}`
  const text = `${label} 已开播`
  set({ notices: [{ id: notification.id, room: notification.room, text, at: notification.occurredAt }, ...state.notices].slice(0, MAX_NOTICES) })
  try { sink?.(text) } catch { /* A closed session cannot stop the notice list. */ }
  systemNotify('开播提醒', text)
}

function listen(on: boolean): void {
  if (on && !unsubscribe) {
    unsubscribe = apiClient.subscribeFeatures((event) => {
      if (event.topic === 'insights' && isEvent(event.data)) onEvent(event.data)
    })
  } else if (!on && unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}

export interface ApplyInput { enabled: boolean; scope: NotifyScope; rooms: string[]; accountId: string | null }

/**
 * Send the settings to the main process. "所选房间" with nothing chosen would mean every room
 * to the backend, so it is sent as off. The follow-list monitor needs the account; with
 * "所选房间" it is passed too when there is one, so the chosen followed rooms are polled.
 */
export async function applyLiveNotices(input: ApplyInput): Promise<boolean> {
  const rooms = [...new Set(input.rooms)].slice(0, MAX_NOTIFY_ROOMS)
  const active = input.enabled && (input.scope === 'all' ? !!input.accountId : rooms.length > 0)
  const args = !active ? { enabled: false }
    : input.scope === 'all' ? { enabled: true, accountId: input.accountId! }
      : { enabled: true, rooms, ...(input.accountId ? { accountId: input.accountId } : {}) }
  const mine = ++generation
  set({ pending: true, error: '', monitorError: '', stopped: '', scope: input.scope, rooms })
  // Subscribe before the monitor starts so its first event cannot be missed.
  if (active) listen(true)
  const result = await apiClient.feature('setDouyuLiveNotifications', args)
  if (mine !== generation) return result.ok
  if (!result.ok) {
    set({ pending: false, error: result.message })
    if (!state.enabled) listen(false)
    return false
  }
  const enabled = result.value.enabled
  set({ pending: false, enabled: input.enabled, accountId: enabled ? result.value.followedAccountId : null })
  listen(enabled)
  return true
}

/**
 * The main process stops the follow monitor when the account changes and does not move it
 * to the new one; the switch follows, and says why.
 */
export async function stopForAccountChange(): Promise<void> {
  const ok = await applyLiveNotices({ enabled: false, scope: state.scope, rooms: state.rooms, accountId: null })
  if (ok) set({ stopped: '当前账号已变更，开播提醒已停止。' })
}

/** Scope and room choices made while the reminder is off; nothing is sent. */
export function draftLiveNotices(patch: { scope?: NotifyScope; rooms?: string[] }): void {
  set({ ...patch, ...(patch.rooms ? { rooms: [...new Set(patch.rooms)].slice(0, MAX_NOTIFY_ROOMS) } : {}) })
}

/** Room names for notice text, taken from the last followed-rooms read. */
export function rememberRoomNames(rooms: { room: string; roomName: string; nickname: string }[]): void {
  for (const room of rooms) {
    const name = room.roomName.trim() || room.nickname.trim()
    if (name) names.set(room.room, name)
  }
}

/** Where in-app notices go besides the list in the 关注 tab, usually the session's toasts. */
export function setNoticeSink(next: Sink | null): void { sink = next }

export function dismissLiveNotice(id: string): void {
  set({ notices: state.notices.filter((notice) => notice.id !== id) })
}

export function useLiveNotices(): LiveNoticeState {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => state,
    () => state,
  )
}

/** For tests: forget everything without contacting the main process. */
export function resetLiveNotices(): void {
  generation++
  listen(false)
  names.clear()
  sink = null
  state = INITIAL
  for (const listener of listeners) listener()
}
