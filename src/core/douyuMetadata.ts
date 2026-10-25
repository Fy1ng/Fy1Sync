import type { DouyuGiftMetadata, DouyuSenderMetadata } from './types'

export const MAX_DOUYU_GIFT_COUNT = 1_000_000

/** Decimal identifiers remain strings, avoiding rounding or permissive numeric coercion. */
export function normalizeDouyuUid(value: unknown): string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value : ''
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function level(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000
    ? value
    : undefined
}

/** IPC data gets the same small allowlist as the socket parser. */
export function normalizeDouyuSender(value: unknown): DouyuSenderMetadata | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const uid = normalizeDouyuUid(raw.uid)
  const userLevel = level(raw.level)
  const nobleLevel = level(raw.nobleLevel)
  if (!uid && userLevel === undefined && nobleLevel === undefined) return undefined
  return {
    ...(uid ? { uid } : {}),
    ...(userLevel === undefined ? {} : { level: userLevel }),
    ...(nobleLevel === undefined ? {} : { nobleLevel }),
  }
}

export function normalizeDouyuGift(value: unknown): DouyuGiftMetadata | undefined {
  const raw = record(value)
  if (!raw || (raw.kind !== 'gift' && raw.kind !== 'prop')) return undefined
  const id = normalizeDouyuUid(raw.id)
  if (!id || typeof raw.count !== 'number' || !Number.isSafeInteger(raw.count) ||
      raw.count < 1 || raw.count > MAX_DOUYU_GIFT_COUNT) return undefined
  return { kind: raw.kind, id, count: raw.count }
}

// Public catalog names checked 2026-10-24. No images, scripts or assets are loaded at runtime.
// Gift catalog: https://webconf.douyucdn.cn/resource/common/prop_gift_list/prop_gift_config.json
// Prop names: https://gift.douyucdn.cn/api/prop/v5/web/single?pid=268 (also pid=2358).
const GLOWSTICK_GIFTS: Readonly<Record<string, string>> = {
  '824': '粉丝荧光棒',
  '1806': '粉丝荧光棒',
  '1838': '粉丝荧光棒',
  '1914': '粉丝荧光棒',
  '2161': 'VIP荧光棒',
  '20422': '粉丝荧光棒',
  '22831': '火力荧光棒',
  '22899': '钻粉荧光棒',
  '23493': '一根荧光棒',
  '23494': '一束荧光棒',
  '23495': '一捆荧光棒',
  '23496': '一堆荧光棒',
  '23497': '粉丝荧光棒',
  '23672': 'TI荧光棒',
}
const GLOWSTICK_PROPS: Readonly<Record<string, string>> = {
  '268': '粉丝荧光棒',
  '2358': '钻粉荧光棒',
}

function knownGlowstickName(gift: DouyuGiftMetadata): string | undefined {
  const names = gift.kind === 'prop' ? GLOWSTICK_PROPS : GLOWSTICK_GIFTS
  return Object.hasOwn(names, gift.id) ? names[gift.id] : undefined
}

export function douyuGiftLabel(gift: DouyuGiftMetadata): string {
  return knownGlowstickName(gift) ?? `${gift.kind === 'prop' ? '道具' : '礼物'} #${gift.id}`
}
