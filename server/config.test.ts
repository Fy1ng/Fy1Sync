import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROXY_HOSTS,
  exposureWarnings,
  hostAllowed,
  isLoopbackHost,
  readBooleanEnv,
  readHostList,
  readNumberEnv,
  resolveConfig,
} from './config'

describe('readBooleanEnv', () => {
  it('accepts the common truthy and falsy spellings', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(readBooleanEnv(value, false)).toBe(true)
    }
    for (const value of ['0', 'false', 'FALSE', ' no ', 'off']) {
      expect(readBooleanEnv(value, true)).toBe(false)
    }
  })

  it('falls back for an undefined or unrecognised value', () => {
    expect(readBooleanEnv(undefined, true)).toBe(true)
    expect(readBooleanEnv(undefined, false)).toBe(false)
    // A typo must not silently flip a security-relevant default.
    expect(readBooleanEnv('maybe', false)).toBe(false)
    expect(readBooleanEnv('', true)).toBe(true)
  })
})

describe('readNumberEnv', () => {
  it('parses numbers and falls back on anything unparseable', () => {
    expect(readNumberEnv('8080', 5178)).toBe(8080)
    expect(readNumberEnv('0', 5178)).toBe(0)
    expect(readNumberEnv(undefined, 5178)).toBe(5178)
    expect(readNumberEnv('abc', 5178)).toBe(5178)
    expect(readNumberEnv('Infinity', 5178)).toBe(5178)
    expect(readNumberEnv('NaN', 5178)).toBe(5178)
  })
})

describe('readHostList', () => {
  it('defaults to the built-in host list', () => {
    expect(readHostList(undefined)).toEqual(DEFAULT_PROXY_HOSTS)
    expect(readHostList('')).toEqual(DEFAULT_PROXY_HOSTS)
    expect(readHostList('  ,  ')).toEqual(DEFAULT_PROXY_HOSTS)
  })

  it('splits, trims and lowercases a custom list', () => {
    expect(readHostList('A.example.com, b.example.com ,,')).toEqual([
      'a.example.com',
      'b.example.com',
    ])
  })

  it('returns a copy so a caller cannot mutate the defaults', () => {
    const list = readHostList(undefined)
    list.push('evil.example.com')
    expect(readHostList(undefined)).not.toContain('evil.example.com')
  })
})

describe('isLoopbackHost', () => {
  it('recognises the loopback spellings', () => {
    for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.1 ']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
  })

  it('rejects wildcard and LAN binds', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('hostAllowed', () => {
  it('matches an exact host', () => {
    expect(hostAllowed('usher.ttvnw.net', ['usher.ttvnw.net'])).toBe(true)
    expect(hostAllowed('USHER.TTVNW.NET', ['usher.ttvnw.net'])).toBe(true)
  })

  it('matches a subdomain wildcard but never the bare apex', () => {
    expect(hostAllowed('video-weaver.lhr03.ttvnw.net', ['*.ttvnw.net'])).toBe(true)
    expect(hostAllowed('ttvnw.net', ['*.ttvnw.net'])).toBe(false)
  })

  it('does not treat the wildcard as a plain suffix', () => {
    // `evilttvnw.net` ends with the pattern text but is a different registrable domain.
    expect(hostAllowed('evilttvnw.net', ['*.ttvnw.net'])).toBe(false)
    expect(hostAllowed('nottvnw.net', ['*.ttvnw.net'])).toBe(false)
  })

  it('supports a bare * as allow-all', () => {
    expect(hostAllowed('anything.example.com', ['*'])).toBe(true)
  })

  it('strips IPv6 brackets before matching', () => {
    expect(hostAllowed('[::1]', ['::1'])).toBe(true)
  })

  it('rejects an empty pattern list', () => {
    expect(hostAllowed('example.com', [])).toBe(false)
  })

  it('allows the default Twitch, Douyu and Bilibili hosts', () => {
    for (const host of [
      'usher.ttvnw.net',
      'video-weaver.lhr03.ttvnw.net',
      'gql.twitch.tv',
      'hlsa.douyucdn.cn',
      'tx2play1.douyucdn.cn',
      'api.live.bilibili.com',
      'cn-hbyc-cmcc-bcache-10.bilivideo.com',
    ]) {
      expect(hostAllowed(host, DEFAULT_PROXY_HOSTS)).toBe(true)
    }
  })

  it('does not allow an unrelated host by default', () => {
    for (const host of ['evil.example.com', 'metadata.google.internal', '169.254.169.254']) {
      expect(hostAllowed(host, DEFAULT_PROXY_HOSTS)).toBe(false)
    }
  })
})

describe('resolveConfig', () => {
  it('defaults to a loopback bind with the proxy narrowly scoped', () => {
    const config = resolveConfig({}, '/app')
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(5178)
    expect(config.strictPort).toBe(false)
    expect(config.loopbackOnly).toBe(true)
    expect(config.clientDir).toBe('/app/dist/client')
    expect(config.dataDir).toBe('/app/data')
    expect(config.adminToken).toBe('stream-sync-admin')
    expect(config.proxy.enabled).toBe(true)
    expect(config.proxy.hosts).toEqual(DEFAULT_PROXY_HOSTS)
    // The dangerous switches stay off unless asked for explicitly.
    expect(config.proxy.allowNonStandardPorts).toBe(false)
    expect(config.proxy.allowNonLoopbackTargets).toBe(false)
    expect(config.proxy.maxRedirects).toBe(4)
    expect(config.proxy.requestTimeoutMs).toBe(15_000)
  })

  it('reads every override from the environment', () => {
    const config = resolveConfig(
      {
        STREAM_SYNC_HOST: '0.0.0.0',
        STREAM_SYNC_PORT: '8080',
        STREAM_SYNC_STRICT_PORT: 'true',
        STREAM_SYNC_CLIENT_DIR: '/srv/client',
        STREAM_SYNC_DATA_DIR: '/srv/data',
        STREAM_SYNC_ADMIN_TOKEN: 's3cret',
        STREAM_SYNC_MEDIA_PROXY_ENABLED: 'false',
        STREAM_SYNC_MEDIA_PROXY_HOSTS: 'a.example.com,b.example.com',
        STREAM_SYNC_MEDIA_PROXY_ALLOW_NONSTANDARD_PORTS: 'yes',
        STREAM_SYNC_MEDIA_PROXY_ALLOW_NON_LOOPBACK: '1',
        STREAM_SYNC_MEDIA_PROXY_MAX_REDIRECTS: '2',
        STREAM_SYNC_MEDIA_PROXY_TIMEOUT_MS: '3000',
      },
      '/app',
    )
    expect(config).toEqual({
      host: '0.0.0.0',
      port: 8080,
      strictPort: true,
      clientDir: '/srv/client',
      dataDir: '/srv/data',
      adminToken: 's3cret',
      loopbackOnly: false,
      proxy: {
        enabled: false,
        hosts: ['a.example.com', 'b.example.com'],
        allowNonStandardPorts: true,
        allowNonLoopbackTargets: true,
        maxRedirects: 2,
        requestTimeoutMs: 3_000,
      },
    })
  })

  it('drops loopbackOnly when bound to a non-loopback host', () => {
    expect(resolveConfig({ STREAM_SYNC_HOST: '192.168.1.5' }, '/app').loopbackOnly).toBe(false)
    expect(resolveConfig({ STREAM_SYNC_HOST: 'localhost' }, '/app').loopbackOnly).toBe(true)
  })

  it('treats a whitespace-only override as unset', () => {
    const config = resolveConfig(
      { STREAM_SYNC_HOST: '   ', STREAM_SYNC_ADMIN_TOKEN: '  ', STREAM_SYNC_DATA_DIR: ' ' },
      '/app',
    )
    expect(config.host).toBe('127.0.0.1')
    expect(config.adminToken).toBe('stream-sync-admin')
    expect(config.dataDir).toBe('/app/data')
  })
})

describe('exposureWarnings', () => {
  const base = (env: Record<string, string>) => resolveConfig(env, '/app')

  it('在本机绑定时不啰嗦', () => {
    expect(exposureWarnings(base({}))).toEqual([])
    expect(exposureWarnings(base({ STREAM_SYNC_HOST: 'localhost' }))).toEqual([])
  })

  it('绑定到外部地址且令牌是默认值时点明后果', () => {
    const lines = exposureWarnings(base({ STREAM_SYNC_HOST: '0.0.0.0' })).join('\n')
    expect(lines).toContain('0.0.0.0')
    // The pairing is what makes it dangerous: the loopback gate is off *and* the token is
    // the published default, so naming both is the point.
    expect(lines).toContain('管理令牌仍是默认值')
    expect(lines).toContain('STREAM_SYNC_ADMIN_TOKEN')
  })

  it('绑定到外部地址但换过令牌时只提绑定', () => {
    const lines = exposureWarnings(
      base({ STREAM_SYNC_HOST: '0.0.0.0', STREAM_SYNC_ADMIN_TOKEN: 'chosen-by-operator' }),
    ).join('\n')
    expect(lines).toContain('不再限制为本机访问')
    expect(lines).not.toContain('管理令牌仍是默认值')
  })

  it('代理放开内网目标时单独说一句', () => {
    const lines = exposureWarnings(
      base({
        STREAM_SYNC_HOST: '192.168.1.20',
        STREAM_SYNC_ADMIN_TOKEN: 'chosen-by-operator',
        STREAM_SYNC_MEDIA_PROXY_ALLOW_NON_LOOPBACK: 'true',
      }),
    ).join('\n')
    expect(lines).toContain('开放中继')
  })
})
