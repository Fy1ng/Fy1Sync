import type { HuyaChatMetadata } from '../../server/danmaku/huyaMessage'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function integer(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null
}

export function readHuyaChatMetadata(raw: unknown): HuyaChatMetadata | null {
  const { kind, textColor, bulletColor, sender } = record(raw)
  if (kind !== 'text' && kind !== 'on-tv-barrage') return null
  const identity = record(sender)
  const badge = record(identity.fansBadge)
  const badgeLevel = integer(badge.level, 1, 2147483647)
  const label = typeof badge.name === 'string' && badge.name.length <= 128 && !/[\x00-\x1f\x7f]/.test(badge.name)
    ? badge.name.trim() : ''
  return {
    kind,
    textColor: integer(textColor, 0, 0xffffff),
    bulletColor: integer(bulletColor, 0, 0xffffff),
    sender: {
      userLevel: integer(identity.userLevel, 0, 2147483647),
      fansBadge: label && badgeLevel !== null ? { name: label, level: badgeLevel } : null,
      nobleLevel: integer(identity.nobleLevel, 0, 2147483647),
      guardLevel: integer(identity.guardLevel, 0, 2147483647),
      superFan: typeof identity.superFan === 'boolean' ? identity.superFan : null,
      roomAdmin: typeof identity.roomAdmin === 'boolean' ? identity.roomAdmin : null,
    },
  }
}

export function huyaChatColorHex(color: number | null | undefined): string | undefined {
  const rgb = integer(color, 0, 0xffffff)
  return rgb === null ? undefined : `#${rgb.toString(16).padStart(6, '0')}`
}
