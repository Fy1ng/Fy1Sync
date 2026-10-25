import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppUpdateService, compareAppVersions, parseAppUpdateSource, type AppUpdateSource } from './appUpdateService'

const source: AppUpdateSource = { kind: 'manifest', manifestUrl: 'https://releases.example.org/latest.json' }
const release = { version: '0.2.0', releaseUrl: 'https://releases.example.org/releases/0.2.0', notes: 'New features' }
const services: AppUpdateService[] = []
afterEach(() => { services.splice(0).forEach(service => service.dispose()); vi.useRealTimers() })
function setup(payload: unknown = release, config: AppUpdateSource | null = source) {
  const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => payload instanceof Response ? payload : Response.json(payload))
  const service = new AppUpdateService({ currentVersion: '0.1.3', source: config, request, resolve: async () => ['8.8.8.8'], now: () => 1_793_000_000_000 })
  services.push(service)
  return { service, request }
}

describe('application version precedence', () => {
  it.each([
    ['0.1.3', '0.2.0', -1], ['v1.0.0', '1.0.0', 0], ['1.0.0+build.9', '1.0.0+build.10', 0],
    ['1.0.0-rc.2', '1.0.0-rc.10', -1], ['1.0.0-rc', '1.0.0', -1], ['1.0.0-2', '1.0.0-beta', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1], ['2.0.0', '1.9.99', 1],
  ])('%s compared with %s', (left, right, result) => { expect(compareAppVersions(String(left), String(right))).toBe(result) })
  it.each(['1.0', '01.0.0', '1.0.0-01', '1.0.0<script>', '1.0.0\n', 'Infinity.0.0'])('rejects invalid version %s', value => {
    expect(() => compareAppVersions(value, '1.0.0')).toThrow()
  })
})

describe('read-only application updates', () => {
  it('makes no startup request, reports a validated update and retains text-only notes', async () => {
    const f = setup()
    expect(f.service.state().phase).toBe('idle'); expect(f.request).not.toHaveBeenCalled()
    expect(await f.service.check()).toMatchObject({ phase: 'available', currentVersion: '0.1.3', latestVersion: '0.2.0', releaseUrl: release.releaseUrl, releaseNotes: release.notes })
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.request.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Cookie')
  })
  it('returns unconfigured without inventing a repository', async () => {
    const f = setup(release, null)
    expect((await f.service.check()).phase).toBe('unconfigured'); expect(f.request).not.toHaveBeenCalled()
  })
  it('deduplicates concurrent checks and never treats an older version as an update', async () => {
    const f = setup({ ...release, version: '0.1.0' })
    const first = f.service.check(), second = f.service.check()
    expect(first).toBe(second)
    expect((await first).phase).toBe('current'); expect(f.request).toHaveBeenCalledTimes(1)
  })
  it.each([
    { ...release, releaseUrl: 'https://evil.example/' }, { ...release, releaseUrl: 'http://releases.example.org/x' },
    { ...release, releaseUrl: 'https://user:password@releases.example.org/x' }, { ...release, releaseUrl: 'https://releases.example.org/x?token=secret' },
    { ...release, releaseUrl: 'javascript:alert(1)' }, { ...release, version: 'malformed' },
  ])('refuses unsafe release metadata without exposing it', async payload => {
    const value = await setup(payload).service.check()
    expect(value).toMatchObject({ phase: 'error', releaseUrl: null, latestVersion: null })
    expect(JSON.stringify(value)).not.toMatch(/password|token=secret|alert\(/)
  })
  it('permits a separately pinned release origin and rejects private addresses', async () => {
    const f = setup({ ...release, releaseUrl: 'https://downloads.example.org/app/0.2.0' }, { ...source, releaseOrigin: 'https://downloads.example.org' })
    expect((await f.service.check()).phase).toBe('available')
    const request = vi.fn()
    const service = new AppUpdateService({ currentVersion: '1.0.0', source, request, resolve: async () => ['127.0.0.1'] })
    services.push(service)
    expect((await service.check()).phase).toBe('error'); expect(request).not.toHaveBeenCalled()
  })
  it('validates the exact selected GitHub repository and stable release', async () => {
    const github: AppUpdateSource = { kind: 'github', owner: 'example', repository: 'syncer' }
    const metadata = { tag_name: 'v0.2.0', draft: false, prerelease: false, html_url: 'https://github.com/example/syncer/releases/tag/v0.2.0', body: 'release' }
    const f = setup(metadata, github)
    expect((await f.service.check()).phase).toBe('available')
    expect(String(f.request.mock.calls[0]?.[0])).toBe('https://api.github.com/repos/example/syncer/releases/latest')
    expect((await setup({ ...metadata, html_url: 'https://github.com/other/repo/releases/tag/v0.2.0' }, github).service.check()).phase).toBe('error')
    expect((await setup({ ...metadata, prerelease: true }, github).service.check()).phase).toBe('error')
  })
  it('rejects redirects, oversized metadata and interrupted requests', async () => {
    expect((await setup(new Response('', { status: 302, headers: { location: 'https://evil.example/' } })).service.check()).phase).toBe('error')
    expect((await setup(new Response('x'.repeat(262_145))).service.check()).phase).toBe('error')
    vi.useFakeTimers()
    const f = setup()
    f.request.mockImplementation(() => new Promise<Response>(() => {}))
    const promise = f.service.check()
    await vi.advanceTimersByTimeAsync(15_001)
    expect((await promise).phase).toBe('error')
  })
  it('validates local configuration without contacting arbitrary URLs', () => {
    expect(parseAppUpdateSource(null)).toBeNull()
    for (const raw of [{ kind: 'github', owner: '../bad', repository: 'x' }, { kind: 'manifest', manifestUrl: 'file:///secret' },
      { kind: 'manifest', manifestUrl: source.manifestUrl, releaseOrigin: 'https://allowed.example/path' }, { ...source, headers: { Cookie: 'secret' } }]) {
      expect(() => parseAppUpdateSource(raw)).toThrow()
    }
  })
})
