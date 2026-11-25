/**
 * Tolerant HLS multivariant (master) playlist parser and inspector for direct `.m3u8` sources.
 *
 * Unlike Twitch's strict usher parser, direct streams in the wild may omit `RESOLUTION` or
 * `CODECS`, list multiple bitrates at the same resolution, or include extra whitespace.
 * Playlists with external `#EXT-X-MEDIA:TYPE=AUDIO` renditions keep the master URL so FFmpeg
 * receives both video and audio groups through the local media gateway.
 */

import { mediaRequestPolicy, type ProxyConfig } from '../config'
import { httpErrorDetails } from '../httpError'
import { mediaChild, mediaEntry, type MediaAccess } from '../mediaAccess'
import { httpFailure, StreamFailureError } from '../networkFailure'
import type { NetworkContext } from '../networkPolicy'
import { timeoutSignal } from '../mediaNetworkOptions'
import { readPlatformText } from '../platformResponse'
import { safeFetch } from '../safeFetch'
import type { QualityOption, ResolvedStream } from './types'

export interface DirectHlsVariant {
  id: string
  label: string
  url: string
  width: number
  height: number
  fps: number
  bandwidth: number
}

const VIDEO_CODEC = /(?:^|,)\s*(?:avc1|avc3|hvc1|hev1|dvh1|dvhe|vp09|vp9|av01)(?:\.|,|\s|$)/i
const AUDIO_ONLY_CODEC = /(?:^|,)\s*(?:mp4a|opus|ac-3|ec-3|flac|vorbis)(?:\.|,|\s|$)/i

function parseAttributes(raw: string): Map<string, string> {
  const result = new Map<string, string>()
  const pattern = /([A-Za-z0-9-]+)\s*=\s*(?:"([^"\r\n]*)"|([^,\r\n]+))\s*(?:,|$)/gy
  let cursor = 0
  const text = raw.trim()
  while (cursor < text.length) {
    pattern.lastIndex = cursor
    const match = pattern.exec(text)
    if (!match) break
    const key = match[1]!.toUpperCase()
    if (!result.has(key)) result.set(key, (match[2] ?? match[3] ?? '').trim())
    cursor = pattern.lastIndex
  }
  return result
}

function parsePositiveNumber(value: string | undefined): number {
  if (!value) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function formatBandwidth(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1).replace(/\.0$/, '')} Mbps`
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} kbps`
  return ''
}

/**
 * Parse a direct HLS master playlist into sorted video renditions.
 * Returns `null` for media playlists, non-HLS payloads, or demuxed external-audio masters.
 */
export function parseDirectHlsMaster(body: string, baseUrl: string | URL): DirectHlsVariant[] | null {
  const cleaned = body.replace(/^\uFEFF/, '').trimStart()
  if (!cleaned.startsWith('#EXTM3U')) return null
  const lines = cleaned.split(/\r?\n/).map(line => line.trim())
  // Keep master URL intact when audio lives in a separate EXT-X-MEDIA URI rendition.
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue
    const mediaAttrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length))
    if (mediaAttrs.get('TYPE')?.toUpperCase() === 'AUDIO' && mediaAttrs.get('URI')) {
      return null
    }
  }

  const rawVariants: Array<{
    url: string
    width: number
    height: number
    fps: number
    bandwidth: number
    videoId?: string
  }> = []

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
    if (rawVariants.length >= 128) break
    const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length))
    let next = index + 1
    while (next < lines.length && (!lines[next] || lines[next]!.startsWith('#'))) {
      if (lines[next]!.startsWith('#EXT-X-STREAM-INF:')) break
      next++
    }
    const uri = lines[next]
    if (!uri || uri.startsWith('#') || uri.length > 16_384 || /[\x00-\x20\x7f]/.test(uri)) continue
    index = next
    let resolved: URL
    try {
      resolved = new URL(uri, baseUrl)
    } catch {
      continue
    }
    if (!['http:', 'https:'].includes(resolved.protocol) || resolved.username || resolved.password) continue

    const resolution = attrs.get('RESOLUTION')
    const size = resolution ? /^([1-9]\d{0,4})x([1-9]\d{0,4})$/i.exec(resolution) : null
    const codecs = attrs.get('CODECS') ?? ''
    if (!size && codecs && AUDIO_ONLY_CODEC.test(codecs) && !VIDEO_CODEC.test(codecs)) continue

    const width = size ? Number(size[1]) : 0
    const height = size ? Number(size[2]) : 0
    const fps = Math.round(parsePositiveNumber(attrs.get('FRAME-RATE')))
    const bandwidth = Math.round(parsePositiveNumber(attrs.get('AVERAGE-BANDWIDTH') ?? attrs.get('BANDWIDTH')))
    const videoGroup = attrs.get('VIDEO')
    rawVariants.push({
      url: resolved.href,
      width,
      height,
      fps,
      bandwidth,
      ...(videoGroup && /^[A-Za-z0-9_.-]{1,64}$/.test(videoGroup) ? { videoId: videoGroup } : {}),
    })
  }

  if (rawVariants.length === 0) return null

  rawVariants.sort((a, b) => b.height - a.height || b.fps - a.fps || b.bandwidth - a.bandwidth || b.width - a.width)

  // Deduplicate identical resolved URLs while keeping highest-ranked metadata.
  const uniqueUrls = new Set<string>()
  const deduped = rawVariants.filter(item => {
    if (uniqueUrls.has(item.url)) return false
    uniqueUrls.add(item.url)
    return true
  })

  const baseLabelFor = (item: typeof deduped[number], index: number): string => {
    if (item.height > 0) return `${item.height}p${item.fps > 30 ? item.fps : ''}`
    const rate = formatBandwidth(item.bandwidth)
    return rate || `线路 ${index + 1}`
  }

  const labelCounts = new Map<string, number>()
  for (let i = 0; i < deduped.length; i++) {
    const base = baseLabelFor(deduped[i]!, i)
    labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1)
  }

  const usedIds = new Set<string>()
  const usedLabels = new Set<string>()
  return deduped.map((item, index) => {
    const baseLabel = baseLabelFor(item, index)
    const rate = formatBandwidth(item.bandwidth)
    let label = (labelCounts.get(baseLabel) ?? 0) > 1 && rate && baseLabel !== rate
      ? `${baseLabel} (${rate})`
      : baseLabel
    if (usedLabels.has(label)) {
      label = `${label} #${index + 1}`
    }
    usedLabels.add(label)

    const candidateId = item.videoId
      ?? (item.height > 0 ? `${item.height}p${item.fps || ''}${item.bandwidth ? `-${item.bandwidth}` : ''}` : `variant-${item.bandwidth || index + 1}`)
    let id = candidateId
    let suffix = 2
    while (usedIds.has(id)) {
      id = `${candidateId}-${suffix++}`
    }
    usedIds.add(id)

    return {
      id,
      label,
      url: item.url,
      width: item.width,
      height: item.height,
      fps: item.fps,
      bandwidth: item.bandwidth,
    }
  })
}

/**
 * Inspect an HLS direct stream for multivariant renditions or mislabelled binary media.
 * Mutates a cloned stream descriptor with selected variant URL, qualities, and mediaAccess.
 */
export async function inspectDirectHlsStream(
  stream: ResolvedStream,
  quality: string | undefined,
  proxy: ProxyConfig,
  network: NetworkContext,
  fetchImpl?: typeof fetch,
): Promise<ResolvedStream> {
  const signal = timeoutSignal(network.media?.requestTimeoutMs ?? proxy.requestTimeoutMs, network.signal)
  const entryAccess: MediaAccess = stream.mediaAccess ?? mediaEntry(stream.url)
  const { response, finalUrl } = await safeFetch(stream.url, mediaRequestPolicy(proxy), {
    signal,
    fetchImpl,
    network,
    headers: stream.headers,
    mediaAccess: entryAccess,
  })
  if (!response.ok) {
    throw new StreamFailureError(httpFailure(response.status, await httpErrorDetails(response)))
  }

  // Peek prefix first so a mislabelled continuous binary stream (e.g. FLV behind .m3u8) is not read to 2 MiB.
  const reader = response.body?.getReader()
  if (!reader) return { ...stream, mediaAccess: entryAccess }

  const chunks: Uint8Array[] = []
  let prefixLength = 0
  let isPlaylist = false
  let streamDone = false
  try {
    while (prefixLength < 512) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) { streamDone = true; break }
      if (!next.value.byteLength) continue
      chunks.push(next.value)
      prefixLength += next.value.byteLength
      const sample = Buffer.concat(chunks).subarray(0, Math.min(512, prefixLength))
      const text = new TextDecoder().decode(sample).replace(/^\uFEFF/, '').trimStart()
      if (text.startsWith('#EXTM3U')) { isPlaylist = true; break }
      if (text && !'#EXTM3U'.startsWith(text) && ![0xef, 0xbb].includes(sample.at(-1)!)) break
    }
    if (!isPlaylist) {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      return { ...stream, kind: 'progressive', mediaAccess: entryAccess }
    }
    const replay = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (chunks.length > 0) { controller.enqueue(chunks.shift()!); return }
        if (streamDone) { reader.releaseLock(); controller.close(); return }
        try {
          const next = await reader.read()
          if (next.done) { streamDone = true; reader.releaseLock(); controller.close() }
          else controller.enqueue(next.value)
        } catch (error) { controller.error(error) }
      },
      async cancel(reason) { await reader.cancel(reason).catch(() => {}) },
    })
    const body = await readPlatformText(new Response(replay), signal)
    const variants = parseDirectHlsMaster(body, finalUrl)
    if (!variants) {
      return { ...stream, mediaAccess: entryAccess }
    }
    const selected = (!quality || quality === 'auto'
      ? variants[0]
      : variants.find(item => item.id === quality)) ?? variants[0]!
    const notes = [...(stream.notes ?? [])]
    if (quality && quality !== 'auto' && selected.id !== quality) {
      notes.push(`所选画质不可用，已切换为 ${selected.label}`)
    }
    const qualities: QualityOption[] = variants.map(variant => ({
      id: variant.id,
      label: variant.label,
      ...(variant.height ? { height: variant.height } : {}),
      ...(variant.fps ? { fps: variant.fps } : {}),
    }))
    return {
      ...stream,
      url: selected.url,
      mediaAccess: mediaChild(entryAccess),
      ...(qualities.length > 1 ? { qualities, quality: selected.id } : { quality: selected.id }),
      notes,
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* Already released by replay stream. */ }
    throw error
  }
}
