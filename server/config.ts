/**
 * Server configuration, resolved from the environment once at startup.
 *
 * Every network-facing capability is off or narrowly scoped by default. This tool
 * runs on a developer's own machine and proxies third-party media, so an accidental
 * `0.0.0.0` bind or an unrestricted proxy target would turn it into an open relay.
 */

export type ServerConfig = {
  host: string
  port: number
  strictPort: boolean
  /** Directory holding built client assets; empty in dev where Vite serves them. */
  clientDir: string
  /** Directory for profile presets and other server-side state. */
  dataDir: string
  adminToken: string
  proxy: ProxyConfig
  /** Bound to a loopback address, which unlocks same-machine-only assumptions. */
  loopbackOnly: boolean
}

export type ProxyConfig = {
  enabled: boolean
  /** Allowed target hostnames; `*` suffix wildcards are supported. */
  hosts: string[]
  allowNonStandardPorts: boolean
  /** Allow targets that resolve to private/loopback addresses. Off by default. */
  allowNonLoopbackTargets: boolean
  maxRedirects: number
  requestTimeoutMs: number
}

export const DEFAULT_PROXY_HOSTS = [
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
  // Bilibili live.
  '*.bilivideo.com',
  '*.hdslb.com',
  'api.live.bilibili.com',
]

/**
 * Token used when `STREAM_SYNC_ADMIN_TOKEN` is unset.
 *
 * Named rather than inlined so the startup banner can recognise it and warn when the
 * default is still in use on a non-loopback bind — see `exposureWarnings`.
 */
export const DEFAULT_ADMIN_TOKEN = 'stream-sync-admin'

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
  if (value === undefined) return fallback
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

export type EnvLike = Record<string, string | undefined>

export function resolveConfig(env: EnvLike = process.env, cwd = process.cwd()): ServerConfig {
  const host = env.STREAM_SYNC_HOST?.trim() || '127.0.0.1'
  return {
    host,
    port: readNumberEnv(env.STREAM_SYNC_PORT, 5178),
    strictPort: readBooleanEnv(env.STREAM_SYNC_STRICT_PORT, false),
    clientDir: env.STREAM_SYNC_CLIENT_DIR?.trim() || `${cwd}/dist/client`,
    dataDir: env.STREAM_SYNC_DATA_DIR?.trim() || `${cwd}/data`,
    // Dev default is a fixed well-known token so the editor is reachable without setup;
    // it only ever guards a loopback listener.
    adminToken: env.STREAM_SYNC_ADMIN_TOKEN?.trim() || DEFAULT_ADMIN_TOKEN,
    loopbackOnly: isLoopbackHost(host),
    proxy: {
      enabled: readBooleanEnv(env.STREAM_SYNC_MEDIA_PROXY_ENABLED, true),
      hosts: readHostList(env.STREAM_SYNC_MEDIA_PROXY_HOSTS),
      allowNonStandardPorts: readBooleanEnv(
        env.STREAM_SYNC_MEDIA_PROXY_ALLOW_NONSTANDARD_PORTS,
        false,
      ),
      allowNonLoopbackTargets: readBooleanEnv(
        env.STREAM_SYNC_MEDIA_PROXY_ALLOW_NON_LOOPBACK,
        false,
      ),
      maxRedirects: readNumberEnv(env.STREAM_SYNC_MEDIA_PROXY_MAX_REDIRECTS, 4),
      requestTimeoutMs: readNumberEnv(env.STREAM_SYNC_MEDIA_PROXY_TIMEOUT_MS, 15_000),
    },
  }
}

/**
 * Warn about settings that are safe on loopback but not off it.
 *
 * Two defaults lean on the loopback bind: the API's `not-loopback` gate is derived from
 * the bind host, so binding wider switches it off by design, and the admin token falls
 * back to a fixed well-known string. Each is fine alone on 127.0.0.1; together on a LAN
 * address they leave preset writes open to anyone who can reach the port. The startup
 * banner prints the token in a copyable URL, so an operator who deliberately binds wide
 * should be told outright rather than left to infer it from this file.
 */
export function exposureWarnings(config: ServerConfig): string[] {
  if (config.loopbackOnly) return []
  const lines = [`  注意：已绑定 ${config.host}，不再限制为本机访问。`]
  if (config.adminToken === DEFAULT_ADMIN_TOKEN) {
    lines.push(
      '        管理令牌仍是默认值，任何能访问该端口的人都能改预设。',
      '        请设置 STREAM_SYNC_ADMIN_TOKEN。',
    )
  }
  if (config.proxy.allowNonLoopbackTargets) {
    lines.push('        媒体代理允许内网目标，形同开放中继。')
  }
  lines.push('')
  return lines
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
