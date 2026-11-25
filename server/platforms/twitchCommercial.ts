/**
 * Detect whether a Twitch HLS media playlist's live edge is currently inside a
 * server-side stitched commercial break ("Commercial break in progress").
 *
 * Returns `null` for master playlists or empty manifests without media segments so
 * variant discovery never overwrites media-playlist state; returns `boolean` based
 * on the trailing segment of a media playlist so expired ad blocks still sitting in
 * the front of the sliding window do not linger after live video has resumed.
 */

interface AdDateRange {
  startMs: number
  endMs: number | null
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>()
  const pattern = /([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^,\r\n]+))(?:,|$)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1]?.toUpperCase()
    const value = match[2] ?? match[3] ?? ''
    if (key && !attrs.has(key)) attrs.set(key, value)
  }
  return attrs
}

function isTwitchAdDateRange(attrs: ReadonlyMap<string, string>): boolean {
  const className = (attrs.get('CLASS') ?? '').toLowerCase()
  const id = (attrs.get('ID') ?? '').toLowerCase()
  if (className === 'twitch-stitched-ad' || className === 'twitch-ad-quartile') return true
  if (id.startsWith('stitched-ad-') || id.startsWith('commercial-break')) return true
  for (const key of attrs.keys()) {
    if (key.startsWith('X-TV-TWITCH-AD-')) return true
  }
  return false
}

function parseDurationSeconds(attrs: ReadonlyMap<string, string>): number | null {
  for (const key of ['DURATION', 'X-TV-TWITCH-AD-POD-FILLED-DURATION', 'PLANNED-DURATION']) {
    const raw = attrs.get(key)
    if (raw === undefined) continue
    const value = Number(raw)
    if (Number.isFinite(value) && value > 0 && value <= 600) return value
  }
  return null
}

function isAdSegmentTitle(title: string): boolean {
  return /\b(?:amazon|stitched-ad|commercial)\b/i.test(title)
}

function isExplicitLiveTitle(title: string): boolean {
  return /^live(?:$|[|,;\s])/i.test(title.trim())
}

export function detectTwitchCommercialBreak(body: string): boolean | null {
  const normalized = body.replace(/^\uFEFF/, '').trim()
  if (!normalized.startsWith('#EXTM3U')) return null

  const lines = normalized.split(/\r?\n/)
  const adRanges: AdDateRange[] = []
  let hasSegments = false
  let pendingDuration: number | null = null
  let pendingTitle = ''
  let programDateMs: number | null = null
  let cueOutActive = false
  let inlineAdBudgetSeconds: number | null = null
  let lastSegmentIsAd = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('#EXT-X-DATERANGE:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-DATERANGE:'.length))
      if (isTwitchAdDateRange(attrs)) {
        const startRaw = attrs.get('START-DATE')
        const endRaw = attrs.get('END-DATE')
        const startMs = startRaw ? Date.parse(startRaw) : Number.NaN
        const endDateMs = endRaw ? Date.parse(endRaw) : Number.NaN
        const durationSec = parseDurationSeconds(attrs)
        if (Number.isFinite(startMs)) {
          const endMs = Number.isFinite(endDateMs) && endDateMs > startMs
            ? endDateMs
            : durationSec !== null ? startMs + durationSec * 1000 : null
          adRanges.push({ startMs, endMs })
        }
        inlineAdBudgetSeconds = durationSec ?? Number.POSITIVE_INFINITY
      }
      continue
    }

    if (line.startsWith('#EXT-X-CUE-OUT')) {
      cueOutActive = true
      continue
    }
    if (line.startsWith('#EXT-X-CUE-IN')) {
      cueOutActive = false
      inlineAdBudgetSeconds = null
      continue
    }

    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const parsed = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim())
      if (Number.isFinite(parsed)) programDateMs = parsed
      continue
    }

    if (line.startsWith('#EXTINF:')) {
      const rest = line.slice('#EXTINF:'.length)
      const commaIndex = rest.indexOf(',')
      const durationText = commaIndex >= 0 ? rest.slice(0, commaIndex) : rest
      const duration = Number(durationText)
      pendingDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
      pendingTitle = commaIndex >= 0 ? rest.slice(commaIndex + 1).trim() : ''
      continue
    }

    if (line.startsWith('#')) continue

    if (pendingDuration === null) continue
    hasSegments = true
    const explicitLive = isExplicitLiveTitle(pendingTitle)
    const explicitAd = isAdSegmentTitle(pendingTitle)

    if (explicitLive) inlineAdBudgetSeconds = null

    let inAdDateRange = false
    if (programDateMs !== null) {
      for (const range of adRanges) {
        if (range.endMs !== null) {
          if (programDateMs >= range.startMs - 250 && programDateMs < range.endMs - 50) {
            inAdDateRange = true
            break
          }
        } else if (!explicitLive && programDateMs >= range.startMs - 250) {
          inAdDateRange = true
          break
        }
      }
    } else if (!explicitLive && inlineAdBudgetSeconds !== null && inlineAdBudgetSeconds > 0.05) {
      inAdDateRange = true
    }

    lastSegmentIsAd = explicitAd || cueOutActive || inAdDateRange

    if (programDateMs !== null && pendingDuration > 0) {
      programDateMs += pendingDuration * 1000
    }
    if (inlineAdBudgetSeconds !== null && Number.isFinite(inlineAdBudgetSeconds) && pendingDuration > 0) {
      inlineAdBudgetSeconds = Math.max(0, inlineAdBudgetSeconds - pendingDuration)
    }
    pendingDuration = null
    pendingTitle = ''
  }

  return hasSegments ? lastSegmentIsAd : null
}
