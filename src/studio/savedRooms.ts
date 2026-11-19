/**
 * 收藏的直播间: links the viewer keeps to load again in one click, from 添加直播间 and from
 * either side's panel. Main stores them (`listSavedRooms`, `saveRoom`, `removeSavedRoom`);
 * this keeps the list for the window so both places show it at once and agree.
 */

import { useEffect, useState } from 'react'
import { apiClient } from '../app/apiClient'
import type { SavedRoom } from '../../electron/featureContracts'
import type { MediaDescriptor, SourceRole } from '../core/types'
import { sourceTitle } from './sources'
import { savedRoomKey } from '../core/savedRoomIdentity'
import { displayError } from '../core/errorDetails'

export type { SavedRoom }

/** Platforms whose link can be loaded again; files and fixtures have nothing to keep. */
const KEEPABLE = new Set(['youtube', 'twitch', 'douyu', 'bilibili', 'huya', 'douyin'])

export function canSave(descriptor: MediaDescriptor | null | undefined): descriptor is MediaDescriptor {
  return !!descriptor && !!descriptor.input && KEEPABLE.has(descriptor.platform ?? '')
}

let rooms: SavedRoom[] | null = null
let pending: Promise<void> | null = null
let releaseEvents: (() => void) | null = null
let revision = 0
let readError = ''
let loading = false
const listeners = new Set<() => void>()
const notify = (): void => { for (const listener of listeners) listener() }
const publish = (next: SavedRoom[]): void => { revision++; rooms = next; readError = ''; loading = false; notify() }

function load(): Promise<void> {
  if (pending) return pending
  const started = revision
  readError = ''
  loading = true
  notify()
  const request = apiClient.feature('listSavedRooms', undefined).then((result) => {
    if (started !== revision) return
    if (result.ok && Array.isArray(result.value)) publish(result.value)
    else readError = result.ok ? '收藏读取失败，请重试。' : displayError(result).message
  }).catch(caught => {
    if (started === revision) readError = displayError(caught, '收藏读取失败，请重试。').message
  }).finally(() => {
    if (pending === request) { pending = null; loading = false; notify() }
  })
  pending = request
  return pending
}

export function useSavedRoomsState(): { rooms: SavedRoom[] | null; error: string; loading: boolean; retry: () => void } {
  const snapshot = () => ({ rooms, error: readError, loading })
  const [value, setValue] = useState(snapshot)
  useEffect(() => {
    const listener = (): void => setValue(snapshot())
    listeners.add(listener)
    releaseEvents ??= apiClient.subscribeFeatures(event => {
      const value = event.data as { rooms?: SavedRoom[] } | null
      if (event.topic === 'saved-rooms' && Array.isArray(value?.rooms)) publish(value.rooms)
    })
    if (rooms === null && !readError) void load()
    listener()
    // Keep one subscription for the window even while every favorites panel is closed.
    return () => { listeners.delete(listener) }
  }, [])
  return { ...value, retry: () => { void load() } }
}

/** The saved rooms, newest first; `null` until the first successful read. */
export function useSavedRooms(): SavedRoom[] | null {
  return useSavedRoomsState().rooms
}

export function savedFor(list: readonly SavedRoom[] | null, role: SourceRole, descriptor: MediaDescriptor | null | undefined): SavedRoom | null {
  if (!list || !descriptor) return null
  const key = savedRoomKey(descriptor.platform ?? '', descriptor.input)
  return list.find(room => room.role === role && room.platform === descriptor.platform
    && (savedRoomKey(room.platform, room.input) === key || (room.metadata && savedRoomKey(room.platform, room.metadata.url) === key))) ?? null
}

export async function saveRoom(role: SourceRole, descriptor: MediaDescriptor): Promise<string | null> {
  if (!canSave(descriptor)) return '本地文件不能收藏'
  const result = await apiClient.feature('saveRoom', { role, input: descriptor.input, platform: descriptor.platform!, label: sourceTitle(descriptor) })
  if (!result.ok) return result.message
  const current = rooms?.find(room => room.id === result.value.id)
  publish([current && (current.lastAttemptAt ?? 0) > (result.value.lastAttemptAt ?? 0) ? { ...current, label: result.value.label } : result.value,
    ...(rooms ?? []).filter(room => room.id !== result.value.id)])
  return null
}

export async function addSavedRoom(input: import('../../electron/featureContracts').SaveRoomInput): Promise<string | null> {
  const result = await apiClient.feature('saveRoom', input)
  if (!result.ok) return result.message
  const current = rooms?.find(room => room.id === result.value.id)
  publish([current && (current.lastAttemptAt ?? 0) > (result.value.lastAttemptAt ?? 0) ? { ...current, label: result.value.label } : result.value,
    ...(rooms ?? []).filter(room => room.id !== result.value.id)])
  return null
}

export async function refreshSavedRooms(id?: string): Promise<string | null> {
  const started = revision
  const result = await apiClient.feature('refreshSavedRooms', id ? { id } : undefined)
  if (!result.ok) return result.message
  if (started === revision) publish(result.value)
  return null
}

export async function removeSavedRoom(id: string): Promise<string | null> {
  const result = await apiClient.feature('removeSavedRoom', { id })
  if (!result.ok) return result.message
  publish((rooms ?? []).filter((room) => room.id !== id))
  return null
}

/** Test seam. */
export function resetSavedRooms(): void {
  rooms = null
  pending = null
  readError = ''
  loading = false
  revision++
  releaseEvents?.()
  releaseEvents = null
}
