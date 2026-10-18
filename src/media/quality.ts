/**
 * Quality level mapping for the player's quality dropdown.
 *
 * hls.js exposes levels in playlist order, which is usually ascending bitrate but
 * is not guaranteed. The UI wants highest-first with a stable "自动" entry, and it
 * needs labels that survive levels missing `height` or `name`, so the mapping lives
 * here as a pure function instead of inline in the component.
 */

export interface RawLevel {
  height?: number
  width?: number
  bitrate?: number
  name?: string
}

export interface QualityOption {
  /** hls.js level index, or -1 for automatic. */
  level: number
  label: string
  detail?: string
}

export const AUTO_QUALITY: QualityOption = { level: -1, label: '自动' }

function labelFor(level: RawLevel): string {
  if (level.height && level.height > 0) return `${level.height}p`
  if (level.name) return level.name
  if (level.bitrate && level.bitrate > 0) return `${Math.round(level.bitrate / 1000)} kbps`
  return '未知'
}

function detailFor(level: RawLevel): string | undefined {
  const parts: string[] = []
  if (level.width && level.height) parts.push(`${level.width}×${level.height}`)
  if (level.bitrate && level.bitrate > 0) parts.push(`${Math.round(level.bitrate / 1000)} kbps`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** Build the dropdown list: 自动 first, then levels highest quality first. */
export function describeLevels(levels: readonly RawLevel[]): QualityOption[] {
  const options = levels.map((level, index) => ({
    level: index,
    label: labelFor(level),
    detail: detailFor(level),
    // Levels carrying neither height nor bitrate (Douyu names its top variant
    // "原画" with no metadata) get no rank and keep their playlist position
    // rather than being pushed to the bottom as if they were the worst quality.
    rank:
      level.height || level.bitrate
        ? (level.height ?? 0) * 1_000_000 + (level.bitrate ?? 0)
        : null,
  }))
  options.sort((a, b) => (a.rank === null || b.rank === null ? 0 : b.rank - a.rank))

  // Two levels can render the same label (same height, different bitrate); make
  // them distinguishable so the dropdown is not ambiguous.
  const seen = new Map<string, number>()
  for (const option of options) {
    const count = seen.get(option.label) ?? 0
    seen.set(option.label, count + 1)
  }
  const used = new Map<string, number>()
  const result: QualityOption[] = [AUTO_QUALITY]
  for (const option of options) {
    let label = option.label
    if ((seen.get(option.label) ?? 0) > 1) {
      const nth = (used.get(option.label) ?? 0) + 1
      used.set(option.label, nth)
      label = option.detail ? `${option.label} (${option.detail})` : `${option.label} #${nth}`
    }
    result.push({ level: option.level, label, detail: option.detail })
  }
  return result
}

/** Label for the currently active level, including the auto-selected one. */
export function activeQualityLabel(
  options: readonly QualityOption[],
  selectedLevel: number,
  autoLevel: number,
): string {
  if (selectedLevel >= 0) {
    return options.find((option) => option.level === selectedLevel)?.label ?? '未知'
  }
  const auto = options.find((option) => option.level === autoLevel)
  return auto ? `自动 (${auto.label})` : '自动'
}
