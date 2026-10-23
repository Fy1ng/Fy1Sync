/**
 * Camera overlay state for the player page: which room is on the commentary side, what
 * crop is saved for it, and the actions the overlay bar and dialog call.
 */

import { useCallback, useMemo, useState } from 'react'
import { useSessionSnapshot } from './SessionContext'
import { CameraStore, cameraRoomKey, cameraLegacyKeys, DEFAULT_CAMERA_WINDOW, type CameraConfig, type CameraWindow } from './camera'
import type { RoiRect } from '../core/profileSchema'

let sharedStore: CameraStore | null = null
function store(): CameraStore {
  if (!sharedStore) {
    let storage: Storage | null = null
    try { storage = window.localStorage } catch { storage = null }
    sharedStore = new CameraStore(storage)
  }
  return sharedStore
}

/** Tests swap the store for one over memory. */
export function setCameraStoreForTests(next: CameraStore | null): void {
  sharedStore = next
}

export interface CameraControls {
  room: string | null
  config: CameraConfig | null
  /** Commentary is loaded and showing a picture, so a crop can be drawn. */
  available: boolean
  save: (crop: RoiRect) => void
  setWindow: (window: CameraWindow) => void
  setEnabled: (enabled: boolean) => void
  remove: () => void
}

export function useCamera(): CameraControls {
  const snapshot = useSessionSnapshot()
  const descriptor = snapshot.media.commentary.descriptor
  const room = cameraRoomKey(descriptor ? {
    platform: descriptor.platform,
    sourceRoom: descriptor.sourceRoom,
    danmakuRoom: snapshot.danmaku.room,
    label: descriptor.label,
    input: descriptor.input,
  } : null)
  const [revision, setRevision] = useState(0)
  const config = useMemo(() => store().getCompatible(room, cameraLegacyKeys(descriptor)), [room, descriptor, revision])
  const available = snapshot.media.commentary.status === 'ready'

  const write = useCallback((next: CameraConfig | null) => {
    if (!room) return
    if (next) store().set(room, { ...next, updatedAt: Date.now() })
    else store().remove(room)
    setRevision((n) => n + 1)
  }, [room, descriptor])

  return {
    room,
    config,
    available,
    save: (crop) => write({ crop, window: config?.window ?? DEFAULT_CAMERA_WINDOW, enabled: true, updatedAt: 0 }),
    setWindow: (window) => { if (config) write({ ...config, window }) },
    setEnabled: (enabled) => { if (config) write({ ...config, enabled }) },
    remove: () => write(null),
  }
}
