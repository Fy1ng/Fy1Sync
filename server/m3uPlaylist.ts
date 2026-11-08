export interface PlaylistEntry { name: string; group: string; url: string; headers: Record<string, string> }
export interface PlaylistView { kind: 'channels' | 'hls'; entries: { name: string; group: string; input: string }[]; url?: string }
export const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024

export function parseM3u(text: string, baseUrl?: string): { kind: 'channels' | 'hls'; entries: PlaylistEntry[] } {
  if (new TextEncoder().encode(text).length > MAX_PLAYLIST_BYTES) throw new Error('播放列表超过 2 MB')
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).map(line => line.trim())
  if (lines.some(line => /^#EXT-X-(?:STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE|MEDIA|I-FRAME-STREAM-INF):/.test(line))) return { kind: 'hls', entries: [] }
  const entries: PlaylistEntry[] = []
  let name = '', group = '', headers: Record<string, string> = {}
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      name = ''; group = ''; headers = {}
      let quoted = false, comma = -1
      for (let i = 8; i < line.length; i++) {
        if (line[i] === '"') quoted = !quoted
        if (line[i] === ',' && !quoted) { comma = i; break }
      }
      const attributes = Object.fromEntries([...line.slice(0, comma < 0 ? undefined : comma).matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1]!, match[2]!]))
      name = (comma < 0 ? '' : line.slice(comma + 1)) || attributes['tvg-name'] || ''
      group = attributes['group-title'] || ''
    } else if (line.startsWith('#EXTGRP:')) group = line.slice(8)
    else if (line.startsWith('#EXTVLCOPT:')) {
      const match = /^#EXTVLCOPT:http-(referrer|user-agent)=(.*)$/.exec(line)
      if (match && !/[\r\n\0]/.test(match[2]!) && match[2]!.length <= 4096) headers[match[1] === 'referrer' ? 'Referer' : 'User-Agent'] = match[2]!
    } else if (line && !line.startsWith('#')) {
      try {
        const url = new URL(line, baseUrl)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) entries.push({ name: name || url.hostname, group, url: url.href, headers: { ...headers } })
      } catch { /* Skip malformed entries, preserving valid channels. */ }
      name = ''; group = ''; headers = {}
      if (entries.length > 10000) throw new Error('播放列表频道数超过 10000')
    }
  }
  if (!entries.length) throw new Error('播放列表中没有可用的 HTTP/HTTPS 频道；本地相对路径和 UDP/RTP 直连暂不支持')
  return { kind: 'channels', entries }
}
