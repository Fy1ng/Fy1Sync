/** Platform-neutral receive-only danmaku contracts. */
import type { DouyuGiftMetadata, DouyuSenderMetadata } from '../../src/core/types'
import type { DouyuRoomSignal } from '../douyu/insightsTypes'

export type DanmakuPlatform = 'douyu' | 'huya'
export type ChatMessage = {
  id: string
  text: string
  username: string
  color: number
  level: number
  receivedAt: number
  room: string
  system: boolean
  /** Missing only on legacy saved/fixture messages, which belong to Douyu. */
  platform?: DanmakuPlatform
  sender?: DouyuSenderMetadata
  dms?: number
  gift?: DouyuGiftMetadata
  huyaGift?: { id: string; count: number; name?: string }
}

export type RoomSignal = (DouyuRoomSignal & { platform?: 'douyu' })
  | { platform: 'huya'; kind: 'viewers'; room: string; receivedAt: number; count: number; messageId?: string }
export type DanmakuState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'
export type DanmakuClientEvents = {
  onMessage: (message: ChatMessage) => void
  onState: (state: DanmakuState, detail?: string) => void
  /** Before presentation throttling and subscriber replay. */
  onObservedMessage?: (message: ChatMessage) => void
  onSignal?: (signal: RoomSignal) => void
}
export type WebSocketLike = {
  send: (data: ArrayBufferView | ArrayBuffer) => void
  close: () => void
  addEventListener: (type: string, listener: (event: any) => void) => void
  binaryType?: string
}
export type DanmakuClientDeps = {
  createSocket?: (url: string) => WebSocketLike
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}
export interface DanmakuClient {
  connect(): void
  close(): void
  readonly state: DanmakuState
}

/** Internal room identities always include a platform; legacy callers still see bare Douyu IDs. */
export function danmakuRoom(input: string): { platform: DanmakuPlatform; room: string; key: string; external: string } {
  const platform = input.startsWith('huya:') ? 'huya' : 'douyu'
  const room = input.startsWith(`${platform}:`) ? input.slice(platform.length + 1) : input
  return { platform, room, key: `${platform}:${room}`, external: platform === 'huya' ? `huya:${room}` : room }
}
