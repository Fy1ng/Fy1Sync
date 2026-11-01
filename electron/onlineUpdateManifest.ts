import { createPublicKey, verify } from 'node:crypto'
import { isIP } from 'node:net'
import { TextDecoder } from 'node:util'
import { compareAppVersions } from './appUpdateService'
import { UPDATE_LIMITS, type ApplicationUpdateDownload, type ApplicationUpdateEntry, type FrontendBundle, type FrontendUpdateEntry, type OnlineUpdateCatalog, type OnlineUpdateSource, type OnlineUpdateSourceId } from './onlineUpdateContracts'

const invalid = () => new Error('在线更新来源, 签名或内容无效.')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sourceId = (value: unknown): value is OnlineUpdateSourceId => value === 'github' || value === 'gitcode'

export function updateBase64(raw: unknown, maximum: number): Buffer {
  if (typeof raw !== 'string' || raw.length > Math.ceil(maximum / 3) * 4 || raw.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(raw)) throw invalid()
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length > maximum || bytes.toString('base64') !== raw) throw invalid()
  return bytes
}

export function isUpdateVersion(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128 || !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) return false
  try { compareAppVersions(value, value); return true } catch { return false }
}

/** URL syntax is checked here; the downloader also rejects non-public DNS answers. */
export function secureUpdateUrl(raw: unknown, query = false): URL {
  if (typeof raw !== 'string' || raw.length > (query ? 8192 : 2048) || /[\x00-\x20\x7f\\]/.test(raw)) throw invalid()
  let url: URL
  try { url = new URL(raw) } catch { throw invalid() }
  const host = url.hostname
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || (!query && url.search)
    || !host.includes('.') || host.endsWith('.') || host.length > 253 || isIP(host.replace(/^\[|\]$/g, '')) !== 0
    || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(host)) throw invalid()
  return url
}

export function parseOnlineUpdateSource(raw: unknown): OnlineUpdateSource | null {
  if (raw === null || raw === undefined) return null
  if (!object(raw) || !exact(raw, ['mirrors', 'publicKey']) || !Array.isArray(raw.mirrors) || raw.mirrors.length < 1 || raw.mirrors.length > 2) throw invalid()
  const seen = new Set<OnlineUpdateSourceId>()
  const mirrors = raw.mirrors.map(value => {
    if (!object(value) || !exact(value, ['id', 'manifestUrl']) || !sourceId(value.id) || seen.has(value.id)) throw invalid()
    seen.add(value.id)
    return { id: value.id, manifestUrl: secureUpdateUrl(value.manifestUrl).href }
  })
  const key = updateBase64(raw.publicKey, 44)
  if (key.length !== 44) throw invalid()
  try {
    const parsed = createPublicKey({ key, type: 'spki', format: 'der' })
    if (parsed.asymmetricKeyType !== 'ed25519' || !Buffer.from(parsed.export({ type: 'spki', format: 'der' })).equals(key)) throw invalid()
  } catch { throw invalid() }
  return { mirrors, publicKey: key.toString('base64') }
}

function notes(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw invalid()
  return value
}

function frontend(raw: unknown): FrontendUpdateEntry {
  if (!object(raw) || !exact(raw, ['revision', 'version', 'minAppVersion', 'maxAppVersion', 'bridgeVersion', 'sha256', 'bytes', 'path', 'notes'])
    || !positive(raw.revision) || !positive(raw.bridgeVersion) || !isUpdateVersion(raw.version) || !isUpdateVersion(raw.minAppVersion) || !isUpdateVersion(raw.maxAppVersion)
    || compareAppVersions(raw.minAppVersion, raw.maxAppVersion) > 0 || !hash(raw.sha256) || !positive(raw.bytes) || raw.bytes > UPDATE_LIMITS.frontendBytes
    || raw.path !== `frontends/${raw.sha256}.json`) throw invalid()
  return { revision: raw.revision, version: raw.version, minAppVersion: raw.minAppVersion, maxAppVersion: raw.maxAppVersion, bridgeVersion: raw.bridgeVersion,
    sha256: raw.sha256, bytes: raw.bytes, path: raw.path as string, notes: notes(raw.notes) }
}

function application(raw: unknown): ApplicationUpdateEntry {
  if (!object(raw) || !exact(raw, ['version', 'platform', 'arch', 'sha256', 'bytes', 'notes', 'downloads']) || !isUpdateVersion(raw.version)
    || raw.platform !== 'win32' || raw.arch !== 'x64' || !hash(raw.sha256) || !positive(raw.bytes) || raw.bytes > UPDATE_LIMITS.installerBytes
    || !object(raw.downloads) || Object.keys(raw.downloads).length < 1 || Object.keys(raw.downloads).length > 2 || !Object.keys(raw.downloads).every(sourceId)) throw invalid()
  const downloads: Partial<Record<OnlineUpdateSourceId, ApplicationUpdateDownload>> = {}
  for (const [id, value] of Object.entries(raw.downloads)) {
    if (!object(value) || !exact(value, ['url', 'redirectOrigins']) || !Array.isArray(value.redirectOrigins) || value.redirectOrigins.length > 4) throw invalid()
    const url = secureUpdateUrl(value.url, true)
    const origins = value.redirectOrigins.map(origin => {
      const parsed = secureUpdateUrl(origin)
      if (parsed.pathname !== '/' || parsed.origin !== origin) throw invalid()
      return parsed.origin
    })
    if (new Set(origins).size !== origins.length) throw invalid()
    downloads[id as OnlineUpdateSourceId] = { url: url.href, redirectOrigins: origins }
  }
  return { version: raw.version, platform: 'win32', arch: 'x64', sha256: raw.sha256, bytes: raw.bytes, notes: notes(raw.notes), downloads }
}

/** Verify the original payload, not JSON that was parsed and serialized again. */
export function verifyOnlineUpdateCatalog(raw: unknown, source: OnlineUpdateSource): OnlineUpdateCatalog {
  const configured = parseOnlineUpdateSource(source)!
  if (!object(raw) || !exact(raw, ['payload', 'signature'])) throw invalid()
  if (Buffer.byteLength(JSON.stringify(raw)) > UPDATE_LIMITS.catalogBytes) throw invalid()
  const payload = updateBase64(raw.payload, UPDATE_LIMITS.catalogBytes), signature = updateBase64(raw.signature, 64)
  if (signature.length !== 64 || !verify(null, payload, createPublicKey({ key: Buffer.from(configured.publicKey, 'base64'), type: 'spki', format: 'der' }), signature)) throw invalid()
  let catalog: unknown
  try { catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) as unknown } catch { throw invalid() }
  if (!object(catalog) || !exact(catalog, ['kind', 'schemaVersion', 'revision', 'frontend', 'application'])
    || catalog.kind !== 'fy1sync-update-catalog' || catalog.schemaVersion !== 1 || !positive(catalog.revision)) throw invalid()
  return { kind: 'fy1sync-update-catalog', schemaVersion: 1, revision: catalog.revision,
    frontend: catalog.frontend === null ? null : frontend(catalog.frontend), application: catalog.application === null ? null : application(catalog.application) }
}

export function isFrontendAssetPath(raw: unknown): raw is string {
  if (raw === 'index.html') return true
  if (typeof raw !== 'string' || raw.length > 180 || !/^assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css|wasm|woff2|png|jpg|jpeg|webp|svg|ico)$/.test(raw)) return false
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(raw.slice(7))
}

export function validateFrontendBundle(raw: unknown, entry: FrontendUpdateEntry): FrontendBundle {
  if (!object(raw) || !exact(raw, ['kind', 'schemaVersion', 'revision', 'version', 'bridgeVersion', 'files'])
    || raw.kind !== 'fy1sync-frontend-bundle' || raw.schemaVersion !== 1 || raw.revision !== entry.revision || raw.version !== entry.version || raw.bridgeVersion !== entry.bridgeVersion
    || !Array.isArray(raw.files) || raw.files.length < 2 || raw.files.length > UPDATE_LIMITS.frontendFiles) throw invalid()
  const paths = new Set<string>()
  let decoded = 0, encoded = 0, script = false
  const files = raw.files.map(file => {
    if (!object(file) || !exact(file, ['path', 'content']) || !isFrontendAssetPath(file.path) || paths.has(file.path.toLowerCase())) throw invalid()
    paths.add(file.path.toLowerCase())
    const bytes = updateBase64(file.content, UPDATE_LIMITS.frontendFileBytes)
    decoded += bytes.length
    encoded += (file.content as string).length + file.path.length + 32
    if (decoded > UPDATE_LIMITS.frontendDecodedBytes || encoded > UPDATE_LIMITS.frontendBytes || (file.path === 'index.html' && !bytes.length)) throw invalid()
    if (file.path.endsWith('.js')) script = true
    return { path: file.path, content: file.content as string }
  })
  if (!paths.has('index.html') || !script) throw invalid()
  return { kind: 'fy1sync-frontend-bundle', schemaVersion: 1, revision: entry.revision, version: entry.version, bridgeVersion: entry.bridgeVersion, files }
}
