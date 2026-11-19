import type { ChatMessage } from './types'

export interface HuyaSenderMetadata {
  userLevel: number | null
  fansBadge: { name: string; level: number } | null
  nobleLevel: number | null
  guardLevel: number | null
  superFan: boolean | null
  roomAdmin: boolean | null
}

export interface HuyaChatMetadata {
  kind: 'text' | 'on-tv-barrage'
  textColor: number | null
  bulletColor: number | null
  sender: HuyaSenderMetadata
}

export type HuyaChatMessage = ChatMessage & { huyaChat?: HuyaChatMetadata }

export function readHuyaChatColor(value: unknown): number | null {
  return typeof value === 'bigint' && value >= 0n && value <= 0xffffffn ? Number(value) : null
}

export function huyaSenderMetadata(
  nobleLevel: unknown, badgeName = '', badgeLevel: unknown = null,
): HuyaSenderMetadata {
  return {
    userLevel: null,
    fansBadge: badgeName && typeof badgeLevel === 'bigint' && badgeLevel > 0n && badgeLevel <= 2147483647n
      ? { name: badgeName, level: Number(badgeLevel) } : null,
    nobleLevel: typeof nobleLevel === 'bigint' && nobleLevel >= 0n && nobleLevel <= 2147483647n ? Number(nobleLevel) : null,
    guardLevel: null,
    superFan: null,
    roomAdmin: null,
  }
}
