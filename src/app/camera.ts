/**
 * Camera overlay configuration, per commentary room.
 *
 * A streamer's camera sits in the same place every time they go live, so the crop is saved
 * against the room (Douyu room id, Bilibili room, or the stream label for anything else) and
 * comes back automatically next time. Separate from AppSettings on purpose: those are global
 * preferences, this is a small map that grows with the rooms a user watches.
 */

import type { RoiRect } from '../core/profileSchema'

export const CAMERA_STORAGE_KEY = 'stream-sync.camera.v1'
const MAX_ROOMS = 200

export interface CameraWindow {
  /** Position of the overlay on the stage, as fractions of the stage (top-left corner). */
  x: number
  y: number
  /** Overlay width as a fraction of the stage width; height follows the crop's aspect. */
  width: number
  radius: number
  border: number
}

export interface CameraConfig {
  /** Crop on the commentary picture, fractions of the video frame. */
  crop: RoiRect
  window: CameraWindow
  enabled: boolean
  updatedAt: number
}

export const DEFAULT_CAMERA_WINDOW: CameraWindow = { x: 0.02, y: 0.06, width: 0.22, radius: 10, border: 2 }

export type CameraStorage = Pick<Storage, 'getItem' | 'setItem'>

const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

export function normalizeCrop(raw: unknown): RoiRect | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<RoiRect>
  const x = clamp(r.x, 0, 1, Number.NaN)
  const y = clamp(r.y, 0, 1, Number.NaN)
  const w = clamp(r.w, 0, 1, Number.NaN)
  const h = clamp(r.h, 0, 1, Number.NaN)
  if (![x, y, w, h].every(Number.isFinite) || w < 0.02 || h < 0.02) return null
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) }
}

export function normalizeWindow(raw: unknown): CameraWindow {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<CameraWindow>
  const d = DEFAULT_CAMERA_WINDOW
  return {
    x: clamp(r.x, 0, 0.95, d.x),
    y: clamp(r.y, 0, 0.95, d.y),
    width: clamp(r.width, 0.08, 0.6, d.width),
    radius: clamp(r.radius, 0, 40, d.radius),
    border: clamp(r.border, 0, 8, d.border),
  }
}

function normalizeConfig(raw: unknown): CameraConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<CameraConfig>
  const crop = normalizeCrop(r.crop)
  if (!crop) return null
  return { crop, window: normalizeWindow(r.window), enabled: r.enabled !== false, updatedAt: clamp(r.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0) }
}

/** Room key from a commentary source: `douyu:6979222`, else the platform plus label. */
export function cameraRoomKey(source: { platform?: string; danmakuRoom?: string | null; label?: string; input?: string } | null): string | null {
  if (!source) return null
  if (source.danmakuRoom) return `${source.platform ?? 'room'}:${source.danmakuRoom}`
  const name = (source.input || source.label || '').trim()
  return name ? `${source.platform ?? 'source'}:${name.slice(0, 200)}` : null
}

export class CameraStore {
  private rooms: Record<string, CameraConfig>

  constructor(private readonly storage: CameraStorage | null) {
    this.rooms = {}
    try {
      const parsed = JSON.parse(storage?.getItem(CAMERA_STORAGE_KEY) ?? '{}') as Record<string, unknown>
      for (const [key, value] of Object.entries(parsed ?? {})) {
        const config = normalizeConfig(value)
        if (config && key.length <= 220) this.rooms[key] = config
      }
    } catch {
      this.rooms = {}
    }
  }

  get(room: string | null): CameraConfig | null {
    return room ? this.rooms[room] ?? null : null
  }

  set(room: string, config: CameraConfig): void {
    const normalized = normalizeConfig(config)
    if (!normalized) return
    this.rooms = { ...this.rooms, [room]: normalized }
    // Oldest rooms go first once the map is full; nobody keeps 200 streamers' crops in use.
    const keys = Object.keys(this.rooms)
    if (keys.length > MAX_ROOMS) {
      keys.sort((a, b) => this.rooms[a]!.updatedAt - this.rooms[b]!.updatedAt)
      for (const key of keys.slice(0, keys.length - MAX_ROOMS)) delete this.rooms[key]
    }
    this.persist()
  }

  remove(room: string): void {
    if (!(room in this.rooms)) return
    const { [room]: _removed, ...rest } = this.rooms
    this.rooms = rest
    this.persist()
  }

  private persist(): void {
    try {
      this.storage?.setItem(CAMERA_STORAGE_KEY, JSON.stringify(this.rooms))
    } catch {
      // A full quota must not interrupt playback; the crop simply is not remembered.
    }
  }
}
