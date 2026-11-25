/** Select a video rendition before a copy-only buffer discards the master playlist. */
export interface HlsVariant { url: string; height: number; width: number; fps: number; bandwidth: number }
export interface HlsRendition extends HlsVariant { id: string }

const invalid = () => new Error('Invalid HLS variant playlist')

function attributes(text: string): Map<string, string> {
  const values = new Map<string, string>()
  const pattern = /([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^,\s]+))(?:,|$)/gy
  let cursor = 0
  while (cursor < text.length) {
    const match = pattern.exec(text)
    if (!match || match.index !== cursor || values.has(match[1]!)) throw invalid()
    values.set(match[1]!, match[2] ?? match[3]!)
    cursor = pattern.lastIndex
  }
  return values
}

function numeric(value: string | undefined): number {
  if (value === undefined) return 0
  if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw invalid()
  return Number(value)
}

/** Null means a media playlist. URLs still require the caller's DNS/host policy. */
export function hlsVariants(body: string, baseUrl: string | URL): HlsRendition[] | null {
  const lines = body.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.trim())
  if (lines[0] !== '#EXTM3U') throw invalid()
  const variants: Array<HlsRendition & { portrait: boolean }> = []
  let streams = 0
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
    if (++streams > 256) throw invalid()
    const data = attributes(line.slice('#EXT-X-STREAM-INF:'.length))
    let next = index + 1
    while (next < lines.length && !lines[next]) next++
    const uri = lines[next]
    if (!uri || uri.startsWith('#') || uri.length > 16_384 || /[\x00-\x20\x7f]/.test(uri)) throw invalid()
    index = next
    const url = new URL(uri, baseUrl)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw invalid()
    const resolution = data.get('RESOLUTION')
    const size = resolution?.match(/^([1-9]\d{0,4})x([1-9]\d{0,4})$/)
    if (resolution && !size) throw invalid()
    const codecs = data.get('CODECS') ?? ''
    const width = size ? Number(size[1]) : 0
    const height = size ? Number(size[2]) : 0
    const video = data.get('VIDEO') ?? data.get('STABLE-VARIANT-ID')
    // Twitch includes an audio-only rendition in the same master. Never buffer it
    // as video, even when the server lists it first or gives it a large bandwidth.
    if ((!size && !/(?:^|,)(?:avc1|avc3|hvc1|hev1|vp09|vp9|av01)(?:\.|,|$)/i.test(codecs))
      || video === 'audio_only' || video === 'audio') continue
    const fps = numeric(data.get('FRAME-RATE'))
    const id = video && /^[A-Za-z0-9_.-]{1,64}$/.test(video) ? video : `video-${height}p${fps}`
    const groups = (data.get('IVS-GROUPS') ?? '').split(',').map(group => group.trim().toLowerCase())
    const portrait = groups.includes('portrait') || (width > 0 && height > width)
    variants.push({ id, url: url.href, width, height, fps, bandwidth: numeric(data.get('BANDWIDTH')), portrait })
  }
  if (!streams) {
    if (!lines.some(line => line.startsWith('#EXT-X-TARGETDURATION:'))) throw invalid()
    return null
  }
  if (!variants.length) throw invalid()
  const hasLandscape = variants.some(variant => !variant.portrait)
  const filtered = hasLandscape ? variants.filter(variant => !variant.portrait) : variants
  return filtered
    .sort((a, b) => b.height - a.height || b.fps - a.fps || b.width - a.width || b.bandwidth - a.bandwidth)
    .map(({ portrait: _portrait, ...variant }) => variant)
}

export function highestHlsVariant(body: string, baseUrl: string | URL): HlsVariant | null {
  const selected = hlsVariants(body, baseUrl)?.[0]
  if (!selected) return null
  const { id: _id, ...variant } = selected
  return variant
}
