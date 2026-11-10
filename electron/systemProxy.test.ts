import { describe, expect, it, vi } from 'vitest'
import { systemProxyMode, type RegistryRunner } from './systemProxy'

function runner(flags?: number, script?: string) {
  const blob = Buffer.alloc(12)
  blob.writeUInt32LE(0x46, 0)
  if (flags !== undefined) blob.writeUInt32LE(flags, 8)
  return vi.fn(async (_file: string, args: readonly string[]) => {
    if (args.at(-1) === 'AutoConfigURL') {
      if (script === undefined) throw new Error('registry value absent')
      return { stdout: `\r\nHKEY_CURRENT_USER\\fixture\r\n    AutoConfigURL    REG_SZ    ${script}\r\n` }
    }
    if (flags === undefined) throw new Error('registry value absent')
    return { stdout: `\r\nHKEY_CURRENT_USER\\fixture\\Connections\r\n    DefaultConnectionSettings    REG_BINARY    ${blob.toString('hex').toUpperCase()}\r\n` }
  }) as unknown as ReturnType<typeof vi.fn<RegistryRunner>>
}

describe('Windows automatic proxy source summary', () => {
  it.each(['linux', 'freebsd'] as const)('does not query registry on %s', async platform => {
    const run = runner()
    expect(await systemProxyMode({ platform, run })).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it('labels an enabled explicit PAC without returning its URL or credentials', async () => {
    const run = runner(5, 'https://user:PRIVATE@fixture.invalid/script.pac?secret=PRIVATE')
    const result = await systemProxyMode({ platform: 'win32', run })
    expect(result).toBe('PAC')
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|fixture|https/)
    expect(run).toHaveBeenCalledTimes(2)
    for (const [file, args, options] of run.mock.calls) {
      expect(file).toMatch(/\\System32\\reg\.exe$/)
      expect(args[0]).toBe('query')
      expect(args).toHaveLength(4)
      expect(args[2]).toBe('/v')
      expect(options).toMatchObject({ windowsHide: true, timeout: 3_000, maxBuffer: 32 * 1024, encoding: 'utf8' })
    }
    expect(run.mock.calls.map(call => call[1].at(-1))).toEqual(['AutoConfigURL', 'DefaultConnectionSettings'])
  })

  it('identifies WPAD even without an explicit PAC URL', async () => {
    expect(await systemProxyMode({ platform: 'win32', run: runner(9) })).toBe('PAC')
  })

  it.each([1, 3])('does not mistake a stale PAC URL for an enabled script when flags=%s', async flags => {
    expect(await systemProxyMode({ platform: 'win32', run: runner(flags, 'https://fixture.invalid/stale.pac') })).toBeUndefined()
  })

  it('does not label a script flag without a configured script URL', async () => {
    expect(await systemProxyMode({ platform: 'win32', run: runner(5) })).toBeUndefined()
    expect(await systemProxyMode({ platform: 'win32', run: runner(5, '') })).toBeUndefined()
  })

  it('uses the URL as a best-effort hint when the connection blob is unavailable', async () => {
    expect(await systemProxyMode({ platform: 'win32', run: runner(undefined, 'https://fixture.invalid/script.pac') })).toBe('PAC')
  })

  it('handles unavailable registry and process timeouts without exposing diagnostics', async () => {
    const run: RegistryRunner = async () => { throw new Error('PRIVATE registry output and credentials') }
    expect(await systemProxyMode({ platform: 'win32', run })).toBeUndefined()
  })

  it('accepts a spaced binary value but ignores malformed or truncated blobs', async () => {
    for (const [blob, expected] of [['46 00 00 00 00 00 00 00 09 00 00 00', 'PAC'], ['460000000900', undefined], ['broken', undefined]] as const) {
      const run: RegistryRunner = async (_file, args) => ({ stdout: args.at(-1) === 'AutoConfigURL' ? '' : `    DefaultConnectionSettings    REG_BINARY    ${blob}\r\n` })
      expect(await systemProxyMode({ platform: 'win32', run })).toBe(expected)
    }
  })
})

describe('macOS automatic proxy source summary', () => {
  it('labels the active PAC without exposing its address or credentials', async () => {
    const run = vi.fn<RegistryRunner>(async () => ({ stdout: '<dictionary> {\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : https://user:PRIVATE@fixture.invalid/proxy.pac\n}\n' }))
    const result = await systemProxyMode({ platform: 'darwin', run })
    expect(result).toBe('PAC')
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|fixture|https/)
    expect(run).toHaveBeenCalledExactlyOnceWith('/usr/sbin/scutil', ['--proxy'], { windowsHide: true, timeout: 3_000, maxBuffer: 32 * 1024, encoding: 'utf8' })
  })

  it.each([
    ['  ProxyAutoDiscoveryEnable : 1', 'PAC'],
    ['  ProxyAutoConfigEnable : 1', undefined],
    ['  ProxyAutoConfigEnable : 0\n  ProxyAutoConfigURLString : https://fixture.invalid/stale.pac', undefined],
    ['  __SCOPED__ : <dictionary> {\n    ProxyAutoConfigEnable : 1\n    ProxyAutoConfigURLString : https://fixture.invalid/scoped.pac\n  }', undefined],
  ])('distinguishes enabled, incomplete and scoped macOS proxy settings', async (settings, expected) => {
    const run: RegistryRunner = async () => ({ stdout: `<dictionary> {\n${settings}\n}\n` })
    expect(await systemProxyMode({ platform: 'darwin', run })).toBe(expected)
  })

  it('keeps normal Chromium proxy routing when scutil is unavailable or times out', async () => {
    const run: RegistryRunner = async () => { throw new Error('PRIVATE process error') }
    expect(await systemProxyMode({ platform: 'darwin', run })).toBeUndefined()
  })
})
