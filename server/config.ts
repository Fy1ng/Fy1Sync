/** Outbound media policy for the Electron main process; no listener configuration. */

export type ProxyConfig = {
  enabled: boolean
  /** Allowed target hostnames; a leading `*.` wildcard matches subdomains. */
  hosts: string[]
  allowNonStandardPorts: boolean
  /** Low-level test seam; desktop policy always forbids private/loopback targets. */
  allowNonLoopbackTargets: boolean
  maxRedirects: number
  requestTimeoutMs: number
}

export const DEFAULT_PROXY_HOSTS = [
  // YouTube metadata and resolved live media.
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
  '*.googlevideo.com', '*.youtube.com',
  // Twitch playlists and segments.
  '*.ttvnw.net',
  'usher.ttvnw.net',
  'api.twitch.tv',
  'gql.twitch.tv',
  // Douyu playlists and segments.
  '*.douyucdn.cn',
  '*.douyucdn2.cn',
  '*.douyucdn3.cn',
  '*.dyscdn.com',
  '*.douyu.com',
  'www.douyu.com',
  // Douyu's own live-stream edge CDNs. getH5PlayV1 returns stream-*.edgesrv.com hosts;
  // the other two appear in the same published Douyu domain lists.
  '*.edgesrv.com',
  '*.douyuscdn.com',
  '*.bytefcdnrd.com',
  // Bilibili live.
  '*.bilivideo.com',
  '*.hdslb.com',
  'api.live.bilibili.com',
]

/** Metadata only. These hosts do not grant renderer/media-proxy access. */
export const METADATA_HOSTS = ['liquipedia.net', 'www.youtube.com', 'gql.twitch.tv'] as const
export function metadataConfig(): ProxyConfig {
  return { enabled: true, hosts: [...METADATA_HOSTS], allowNonStandardPorts: false,
    allowNonLoopbackTargets: false, maxRedirects: 0, requestTimeoutMs: 15_000 }
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

export function readBooleanEnv(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  return fallback
}

export function readNumberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || !value.trim()) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function readHostList(value: string | undefined): string[] {
  if (!value) return [...DEFAULT_PROXY_HOSTS]
  const hosts = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  return hosts.length > 0 ? hosts : [...DEFAULT_PROXY_HOSTS]
}

export type EnvLike = Record<string, string | undefined>

function readBoundedIntegerEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = readNumberEnv(value, fallback)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

/** The optional legacy cwd argument is ignored; storage is owned by Electron userData. */
export function resolveConfig(env: EnvLike = process.env, _cwd?: string): { proxy: ProxyConfig } {
  return {
    proxy: {
      enabled: readBooleanEnv(env.STREAM_SYNC_MEDIA_PROXY_ENABLED, true),
      hosts: readHostList(env.STREAM_SYNC_MEDIA_PROXY_HOSTS),
      // Environment variables cannot relax the desktop media SSRF boundary.
      allowNonStandardPorts: false,
      allowNonLoopbackTargets: false,
      maxRedirects: readBoundedIntegerEnv(env.STREAM_SYNC_MEDIA_PROXY_MAX_REDIRECTS, 4, 0, 8),
      requestTimeoutMs: readBoundedIntegerEnv(env.STREAM_SYNC_MEDIA_PROXY_TIMEOUT_MS, 15_000, 1, 120_000),
    },
  }
}

/** Host matching with a single leading `*.` wildcard, which never matches the bare apex. */
export function hostAllowed(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (patterns.includes('*')) return true
  for (const pattern of patterns) {
    if (pattern === host) return true
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length) return true
    }
  }
  return false
}
