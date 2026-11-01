import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isFrontendAssetPath, parseOnlineUpdateSource, secureUpdateUrl, updateBase64, validateFrontendBundle, verifyOnlineUpdateCatalog } from './onlineUpdateManifest'
import { UPDATE_LIMITS, type FrontendBundle, type FrontendUpdateEntry, type OnlineUpdateCatalog, type OnlineUpdateSource } from './onlineUpdateContracts'

const keys = generateKeyPairSync('ed25519')
const source: OnlineUpdateSource = { publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), mirrors: [
  { id: 'github', manifestUrl: 'https://updates.example.org/manifest.json' }, { id: 'gitcode', manifestUrl: 'https://mirror.example.org/manifest.json' },
] }
const bundle: FrontendBundle = { kind: 'fy1sync-frontend-bundle', schemaVersion: 1, revision: 2, version: '0.2.0+ui.2', bridgeVersion: 1, files: [
  { path: 'index.html', content: Buffer.from('<html><script src="/assets/app.js"></script></html>').toString('base64') },
  { path: 'assets/app.js', content: Buffer.from('console.log("update")').toString('base64') },
] }
const bytes = Buffer.from(JSON.stringify(bundle))
const frontend: FrontendUpdateEntry = { revision: bundle.revision, version: bundle.version, bridgeVersion: 1, minAppVersion: '0.2.0', maxAppVersion: '0.2.0',
  sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, notes: '前端更新', path: '' }
frontend.path = `frontends/${frontend.sha256}.json`
const catalog: OnlineUpdateCatalog = { kind: 'fy1sync-update-catalog', schemaVersion: 1, revision: 1, frontend, application: {
  platform: 'win32', arch: 'x64', version: '0.3.0', sha256: 'a'.repeat(64), bytes: 100, notes: '完整更新',
  downloads: { github: { url: 'https://github.com/example/project/releases/download/v0.3.0/setup.exe', redirectOrigins: ['https://release-assets.githubusercontent.com'] } },
} }
const signed = (value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value))
  return { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }
}

describe('signed executable update metadata', () => {
  it('authenticates exact payload bytes and returns normalized independent values', () => {
    expect(parseOnlineUpdateSource(source)).toEqual(source)
    const envelope = signed(catalog)
    expect(verifyOnlineUpdateCatalog(envelope, source)).toEqual(catalog)
    envelope.payload = Buffer.from(JSON.stringify(catalog) + ' ').toString('base64')
    expect(() => verifyOnlineUpdateCatalog(envelope, source)).toThrow()
    expect(() => verifyOnlineUpdateCatalog(signed({ ...catalog, kind: 'fy1sync-stylepack-catalog' }), source)).toThrow()
    expect(() => verifyOnlineUpdateCatalog({ ...signed(catalog), trusted: true }, source)).toThrow()
    expect(() => verifyOnlineUpdateCatalog({ ...signed(catalog), signature: Buffer.alloc(64).toString('base64') }, source)).toThrow()
  })

  it('accepts an explicitly signed withdrawal of both channels', () => {
    expect(verifyOnlineUpdateCatalog(signed({ ...catalog, frontend: null, application: null }), source)).toMatchObject({ frontend: null, application: null })
  })

  it.each([
    'http://updates.example.org/manifest.json', 'https://user:password@updates.example.org/x', 'https://127.0.0.1/x',
    'https://2130706433/x', 'https://[::1]/x', 'https://localhost/x', 'https://a.local/x', 'https://a.internal/x',
    'https://updates.example.org:8443/x', 'https://updates.example.org/x#fragment', 'https://updates.example.org/x?token=secret',
    'https://updates.example.org./x', 'https://updates.example.org\\@evil.example.org/x',
  ])('refuses unsafe embedded source %s', url => {
    expect(() => parseOnlineUpdateSource({ ...source, mirrors: [{ id: 'github', manifestUrl: url }] })).toThrow()
  })

  it('does not accept alternate keys, duplicate sources or private-key fields', () => {
    expect(parseOnlineUpdateSource(null)).toBeNull()
    expect(() => parseOnlineUpdateSource({ ...source, privateKey: 'never accepted' })).toThrow()
    expect(() => parseOnlineUpdateSource({ ...source, mirrors: [source.mirrors[0], source.mirrors[0]] })).toThrow()
    expect(() => parseOnlineUpdateSource({ ...source, publicKey: 'not-base64' })).toThrow()
    const other = generateKeyPairSync('ed25519')
    expect(() => verifyOnlineUpdateCatalog(signed(catalog), { ...source, publicKey: other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') })).toThrow()
  })

  it.each([
    { revision: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { version: '0.2.0-01' }, { minAppVersion: '0.3.0' },
    { bridgeVersion: 0 }, { bytes: UPDATE_LIMITS.frontendBytes + 1 }, { path: '../app.js' }, { sha256: 'A'.repeat(64) },
    { notes: 'bad\u202etext' }, { extra: true },
  ])('refuses invalid frontend identity %j', changes => {
    expect(() => verifyOnlineUpdateCatalog(signed({ ...catalog, frontend: { ...frontend, ...changes } }), source)).toThrow()
  })

  it.each([
    { platform: 'linux' }, { arch: 'arm64' }, { bytes: UPDATE_LIMITS.installerBytes + 1 }, { downloads: {} },
    { downloads: { automatic: { url: 'https://a.example.org/a', redirectOrigins: [] } } },
    { downloads: { github: { url: 'https://a.example.org/a', redirectOrigins: ['https://cdn.example.org/path'] } } },
    { downloads: { github: { url: 'https://a.example.org/a', redirectOrigins: ['https://cdn.example.org/'] } } },
    { downloads: { github: { url: 'https://a.example.org/a', redirectOrigins: ['https://cdn.example.org', 'https://cdn.example.org'] } } },
    { downloads: { github: { url: 'https://a.example.org/a', redirectOrigins: [], headers: { Cookie: 'forbidden' } } } },
  ])('refuses unsafe installer metadata %j', changes => {
    expect(() => verifyOnlineUpdateCatalog(signed({ ...catalog, application: { ...catalog.application, ...changes } }), source)).toThrow()
  })

  it('allows signed CDN query strings, but never URL credentials', () => {
    expect(secureUpdateUrl('https://cdn.example.org/setup.exe?signature=public', true).hostname).toBe('cdn.example.org')
    expect(() => secureUpdateUrl('https://name:password@cdn.example.org/setup.exe', true)).toThrow()
  })
})

describe('bounded frontend asset container', () => {
  it('accepts only the same frontend identity and canonical Base64', () => {
    expect(validateFrontendBundle(bundle, frontend)).toEqual(bundle)
    expect(updateBase64('YQ==', 1).toString()).toBe('a')
    for (const value of ['YR==', 'YQ', 'YQ==\n', '=YQ=', 'YQ===', '!Q==']) expect(() => updateBase64(value, 8)).toThrow()
    for (const changes of [{ revision: 3 }, { version: '0.3.0' }, { bridgeVersion: 2 }, { schemaVersion: 2 }]) expect(() => validateFrontendBundle({ ...bundle, ...changes }, frontend)).toThrow()
  })

  it.each([
    '../index.html', 'assets/../../app.js', 'assets\\app.js', '/assets/app.js', 'assets/CON.js', 'assets/con.foo.js', 'assets/LPT1.svg',
    'assets/app.js:stream', 'assets/.hidden.js', 'assets/app.js.map', 'electron/main.cjs', 'assets/nested/app.js', 'assets/app.mjs', 'assets/app.exe',
  ])('rejects archive path %s', file => {
    expect(isFrontendAssetPath(file)).toBe(false)
    expect(() => validateFrontendBundle({ ...bundle, files: [...bundle.files, { path: file, content: 'YQ==' }] }, frontend)).toThrow()
  })

  it('rejects case-fold duplicates, missing entrypoints and extra archive fields', () => {
    expect(() => validateFrontendBundle({ ...bundle, files: [...bundle.files, { path: 'assets/APP.js', content: 'YQ==' }] }, frontend)).toThrow()
    expect(() => validateFrontendBundle({ ...bundle, files: [{ path: 'assets/a.js', content: 'YQ==' }, { path: 'assets/a.css', content: '' }] }, frontend)).toThrow()
    expect(() => validateFrontendBundle({ ...bundle, files: [{ ...bundle.files[0], content: '' }, bundle.files[1]] }, frontend)).toThrow()
    expect(() => validateFrontendBundle({ ...bundle, files: [bundle.files[0], { path: 'assets/a.css', content: '' }] }, frontend)).toThrow()
    expect(() => validateFrontendBundle({ ...bundle, files: Array.from({ length: 513 }, () => bundle.files[0]) }, frontend)).toThrow()
    expect(() => validateFrontendBundle({ ...bundle, root: 'C:/outside' }, frontend)).toThrow()
    expect(() => validateFrontendBundle({ ...bundle, files: [{ ...bundle.files[0], mode: 0o777 }, bundle.files[1]] }, frontend)).toThrow()
  })

  it('rejects an individual oversized asset before decoding it', () => {
    const oversized = 'A'.repeat(Math.ceil((UPDATE_LIMITS.frontendFileBytes + 3) / 3) * 4)
    expect(() => validateFrontendBundle({ ...bundle, files: [bundle.files[0], { path: 'assets/large.wasm', content: oversized }] }, frontend)).toThrow()
  })
})
