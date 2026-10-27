import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROXY_HOSTS,
  hostAllowed,
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
    expect(readNumberEnv('', 5178)).toBe(5178)
    expect(readNumberEnv('   ', 5178)).toBe(5178)
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
      'huya.com', 'www.huya.com', 'wup.huya.com', 'tx.flv.huya.com', 'hs.flv.huya.com',
    ]) {
      expect(hostAllowed(host, DEFAULT_PROXY_HOSTS)).toBe(true)
    }
  })

  it('does not allow an unrelated host by default', () => {
    for (const host of ['evil.example.com', 'metadata.google.internal', '169.254.169.254', 'huya.com.evil.invalid', 'fakehuya.com']) {
      expect(hostAllowed(host, DEFAULT_PROXY_HOSTS)).toBe(false)
    }
  })
})

describe('resolveConfig', () => {
  it('returns only a narrowly scoped outbound media policy', () => {
    expect(resolveConfig({}, '/legacy-cwd')).toEqual({
      proxy: {
        enabled: true,
        hosts: DEFAULT_PROXY_HOSTS,
        allowNonStandardPorts: false,
        allowNonLoopbackTargets: false,
        maxRedirects: 4,
        requestTimeoutMs: 15_000,
      },
    })
  })

  it('reads the supported media overrides from the environment', () => {
    expect(resolveConfig({
      STREAM_SYNC_MEDIA_PROXY_ENABLED: 'false',
      STREAM_SYNC_MEDIA_PROXY_HOSTS: 'a.example.com,b.example.com',
      STREAM_SYNC_MEDIA_PROXY_MAX_REDIRECTS: '2',
      STREAM_SYNC_MEDIA_PROXY_TIMEOUT_MS: '3000',
    })).toEqual({
      proxy: {
        enabled: false,
        hosts: ['a.example.com', 'b.example.com'],
        allowNonStandardPorts: false,
        allowNonLoopbackTargets: false,
        maxRedirects: 2,
        requestTimeoutMs: 3_000,
      },
    })
  })

  it('ignores removed HTTP listener, asset, storage and admin-token settings', () => {
    const config = resolveConfig({
      STREAM_SYNC_HOST: '0.0.0.0',
      STREAM_SYNC_PORT: '8080',
      STREAM_SYNC_STRICT_PORT: 'true',
      STREAM_SYNC_CLIENT_DIR: '/legacy/client',
      STREAM_SYNC_DATA_DIR: '/legacy/data',
      STREAM_SYNC_ADMIN_TOKEN: 'obsolete-fixture-value',
    })
    expect(Object.keys(config)).toEqual(['proxy'])
    expect(config).toEqual(resolveConfig({}))
  })

  it('cannot enable private targets or non-standard ports through environment flags', () => {
    const config = resolveConfig({
      STREAM_SYNC_MEDIA_PROXY_ALLOW_NONSTANDARD_PORTS: 'true',
      STREAM_SYNC_MEDIA_PROXY_ALLOW_NON_LOOPBACK: '1',
    })
    expect(config.proxy.allowNonStandardPorts).toBe(false)
    expect(config.proxy.allowNonLoopbackTargets).toBe(false)
  })

  it.each(['0', '8'])('accepts redirect boundary %s', (value) => {
    expect(resolveConfig({ STREAM_SYNC_MEDIA_PROXY_MAX_REDIRECTS: value }).proxy.maxRedirects).toBe(Number(value))
  })

  it.each(['-1', '9', '1.5', 'Infinity', 'NaN', 'abc', '', ' '])(
    'uses the finite redirect default for invalid value %j', (value) => {
      expect(resolveConfig({ STREAM_SYNC_MEDIA_PROXY_MAX_REDIRECTS: value }).proxy.maxRedirects).toBe(4)
    },
  )

  it.each(['1', '120000'])('accepts timeout boundary %s', (value) => {
    expect(resolveConfig({ STREAM_SYNC_MEDIA_PROXY_TIMEOUT_MS: value }).proxy.requestTimeoutMs).toBe(Number(value))
  })

  it.each(['-1', '0', '120001', '1.5', 'Infinity', 'NaN', 'abc', '', ' '])(
    'uses the finite timeout default for invalid value %j', (value) => {
      expect(resolveConfig({ STREAM_SYNC_MEDIA_PROXY_TIMEOUT_MS: value }).proxy.requestTimeoutMs).toBe(15_000)
    },
  )
})
