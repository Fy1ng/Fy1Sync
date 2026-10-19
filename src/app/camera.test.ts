import { describe, expect, it } from 'vitest'
import { CAMERA_STORAGE_KEY, CameraStore, cameraRoomKey, DEFAULT_CAMERA_WINDOW, normalizeCrop, normalizeWindow } from './camera'
import { clampWindow } from '../ui/CameraOverlay'

function memory(seed?: string) {
  const map = new Map<string, string>(seed ? [[CAMERA_STORAGE_KEY, seed]] : [])
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map }
}
const crop = { x: 0.05, y: 0.55, w: 0.2, h: 0.2 }

describe('camera configuration', () => {
  it('keys a room by platform and danmaku room, else by input', () => {
    expect(cameraRoomKey({ platform: 'douyu', danmakuRoom: '6979222', label: '斗鱼 6979222' })).toBe('douyu:6979222')
    expect(cameraRoomKey({ platform: 'direct', input: '/test-sources/commentary.mp4', label: '测试' })).toBe('direct:/test-sources/commentary.mp4')
    expect(cameraRoomKey(null)).toBeNull()
    expect(cameraRoomKey({ label: '  ' })).toBeNull()
  })

  it('persists per room and survives a reload', () => {
    const storage = memory()
    const store = new CameraStore(storage)
    store.set('douyu:1', { crop, window: DEFAULT_CAMERA_WINDOW, enabled: true, updatedAt: 1 })
    const reloaded = new CameraStore(storage)
    expect(reloaded.get('douyu:1')?.crop).toEqual(crop)
    expect(reloaded.get('douyu:2')).toBeNull()
    reloaded.remove('douyu:1')
    expect(new CameraStore(storage).get('douyu:1')).toBeNull()
  })

  it('drops corrupt entries and survives corrupt storage', () => {
    const bad = memory(JSON.stringify({ 'a': { crop: { x: 'no' } }, 'b': { crop, window: { width: 99 } } }))
    const store = new CameraStore(bad)
    expect(store.get('a')).toBeNull()
    expect(store.get('b')?.window.width).toBe(0.6)
    expect(new CameraStore(memory('{not json')).get('b')).toBeNull()
  })

  it('bounds the number of rooms, dropping the oldest', () => {
    const store = new CameraStore(memory())
    for (let n = 0; n < 205; n += 1) store.set(`r${n}`, { crop, window: DEFAULT_CAMERA_WINDOW, enabled: true, updatedAt: n })
    expect(store.get('r0')).toBeNull()
    expect(store.get('r204')).not.toBeNull()
  })

  it('normalizes crops and windows', () => {
    const edge = normalizeCrop({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })!
    expect(edge.w).toBeCloseTo(0.1, 9)
    expect(edge.h).toBeCloseTo(0.1, 9)
    expect(normalizeCrop({ x: 0, y: 0, w: 0.001, h: 0.5 })).toBeNull()
    expect(normalizeWindow({ radius: -3, border: 100 })).toMatchObject({ radius: 0, border: 8 })
  })

  it('keeps the window fully on the stage', () => {
    const stage = { width: 1000, height: 562 }
    const moved = clampWindow({ ...DEFAULT_CAMERA_WINDOW, x: 0.95, y: 0.95, width: 0.3 }, stage, 16 / 9)
    expect(moved.x + moved.width).toBeLessThanOrEqual(1)
    expect(moved.y + (moved.width * stage.width / (16 / 9)) / stage.height).toBeLessThanOrEqual(1.0001)
    // A very tall crop is shrunk to fit rather than spilling off the bottom.
    const tall = clampWindow({ ...DEFAULT_CAMERA_WINDOW, width: 0.6 }, stage, 0.3)
    expect((tall.width * stage.width / 0.3) / stage.height).toBeLessThanOrEqual(0.9501)
  })
})
