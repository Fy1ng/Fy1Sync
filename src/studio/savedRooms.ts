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

export type { SavedRoom }

/** Platforms whose link can be loaded again; files and fixtures have nothing to keep. */
const KEEPABLE = new Set(['youtube', 'twitch', 'douyu', 'bilibili', 'huya'])

export function canSave(descriptor: MediaDescriptor | null | undefined): descriptor is MediaDescriptor {
  return !!descriptor && !!descriptor.input && KEEPABLE.has(descriptor.platform ?? '')
}

let rooms: SavedRoom[] | null = null
let pending: Promise<void> | null = null
const listeners = new Set<() => void>()
const publish = (next: SavedRoom[]): void => { rooms = next; for (const listener of listeners) listener() }

function load(): Promise<void> {
  pending ??= apiClient.feature('listSavedRooms', undefined).then((result) => {
    if (result.ok && Array.isArray(result.value)) publish(result.value)
  }).catch(() => undefined).finally(() => { pending = null })
  return pending
}

/** The saved rooms, newest first; `null` until the first read. Reads once per window. */
export function useSavedRooms(): SavedRoom[] | null {
  const [value, setValue] = useState(rooms)
  useEffect(() => {
    const listener = (): void => setValue(rooms)
    listeners.add(listener)
    if (rooms === null) void load()
    else setValue(rooms)
    return () => { listeners.delete(listener) }
  }, [])
  return value
}

export function savedFor(list: readonly SavedRoom[] | null, role: SourceRole, descriptor: MediaDescriptor | null | undefined): SavedRoom | null {
  if (!list || !descriptor) return null
  return list.find((room) => room.role === role && room.platform === descriptor.platform && room.input === descriptor.input) ?? null
}

export async function saveRoom(role: SourceRole, descriptor: MediaDescriptor): Promise<string | null> {
  if (!canSave(descriptor)) return '本地文件不能收藏'
  const result = await apiClient.feature('saveRoom', { role, input: descriptor.input, platform: descriptor.platform!, label: sourceTitle(descriptor) })
  if (!result.ok) return result.message
  publish([result.value, ...(rooms ?? []).filter((room) => room.id !== result.value.id)])
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
}
