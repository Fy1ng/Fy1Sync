import { randomUUID } from 'node:crypto'
import { cookieDomainAllowed, hasAuthenticationCookies, type BrowserCookie, type LoginPlatform } from './cookies'
import type { BrowserCookieReadFunction } from './browserCookieReader'
import { browserCloser, type BrowserCloseFunction } from './browserCloser'
import { discoverBrowserProfiles, publicBrowserProfile, type DiscoveredBrowserProfile } from './browserProfiles'
import { BrowserImportError, importAbort } from './browserImportError'
import type { BrowserIdentityVerifier, ImportedIdentity } from './browserImportIdentity'
import { IMPORT_PLATFORMS, IMPORT_PLATFORM_NAMES, type BrowserImportCloseResult, type BrowserImportPreview,
  type BrowserImportOutcome, type BrowserImportSources, type DouyuImportTarget } from './browserImportContracts'

interface Candidate { id: string; platform: LoginPlatform; cookies: BrowserCookie[]; identity: ImportedIdentity }
interface Preview { public: BrowserImportPreview; candidates: Candidate[]; controller: AbortController; timer: ReturnType<typeof setTimeout> }
export interface BrowserLoginImportOptions {
  supported?: boolean
  discover?: () => Promise<DiscoveredBrowserProfile[]>
  closeBrowser?: BrowserCloseFunction
  read: BrowserCookieReadFunction
  verify: BrowserIdentityVerifier
  write: (platform: LoginPlatform, cookies: BrowserCookie[], identity: ImportedIdentity,
    target: DouyuImportTarget | undefined, signal: AbortSignal) => Promise<Pick<BrowserImportOutcome, 'accountId' | 'signingReady'>>
  now?: () => number
}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{32,36}$/.test(value)
const invalid = () => new BrowserImportError('browser-import-invalid-request')
function exact(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && required.every(field => Object.hasOwn(value, field)) && Object.keys(value).every(field => [...required, ...optional].includes(field))
}
function target(value: unknown): DouyuImportTarget | undefined {
  if (value === undefined) return undefined
  if (!exact(value, ['kind'], ['accountId'])) throw invalid()
  if ((value.kind === 'auto' || value.kind === 'new') && !Object.hasOwn(value, 'accountId')) return { kind: value.kind }
  if (value.kind === 'existing' && typeof value.accountId === 'string' && (value.accountId === 'default' || validId(value.accountId))) {
    return { kind: 'existing', accountId: value.accountId }
  }
  throw invalid()
}
function erase(candidates: Candidate[]): void { for (const candidate of candidates) for (const cookie of candidate.cookies) cookie.value = '' }

/** Preview secrets are bounded, short-lived, and owned solely by the trusted main window. */
export class BrowserLoginImport {
  private operation: { id: string; controller: AbortController } | null = null
  private preview: Preview | null = null
  private disposed = false
  constructor(private readonly options: BrowserLoginImportOptions) {}
  private now(): number { return (this.options.now ?? Date.now)() }
  private available(): void {
    if (this.disposed) throw new BrowserImportError('browser-import-cancelled')
    if (!(this.options.supported ?? process.platform === 'win32')) throw new BrowserImportError('browser-import-unsupported')
  }
  private async profiles(): Promise<DiscoveredBrowserProfile[]> { return (this.options.discover ?? discoverBrowserProfiles)() }
  async sources(): Promise<BrowserImportSources> {
    if (this.disposed) throw new BrowserImportError('browser-import-cancelled')
    const supported = this.options.supported ?? process.platform === 'win32'
    return { supported, profiles: supported ? (await this.profiles()).map(publicBrowserProfile) : [] }
  }
  async scan(value: unknown): Promise<BrowserImportPreview> {
    this.available()
    if (!exact(value, ['requestId', 'profileId', 'platforms']) || !validId(value.requestId) || !validId(value.profileId)
      || !Array.isArray(value.platforms) || !value.platforms.length || value.platforms.length > 5
      || value.platforms.some(platform => !IMPORT_PLATFORMS.includes(platform))
      || new Set(value.platforms).size !== value.platforms.length) throw invalid()
    if (this.operation) throw new BrowserImportError('browser-import-busy')
    if (this.preview) this.cancel(this.preview.public.id)
    const controller = new AbortController()
    const operation = { id: value.requestId, controller }
    this.operation = operation
    let read: Awaited<ReturnType<BrowserCookieReadFunction>> | undefined
    const candidates: Candidate[] = []
    try {
      const profile = (await this.profiles()).find(profile => profile.id === value.profileId)
      importAbort(controller.signal)
      if (!profile) throw new BrowserImportError('browser-import-profile-missing')
      const platforms = value.platforms as LoginPlatform[]
      read = await this.options.read(profile, platforms, controller.signal)
      importAbort(controller.signal)
      const accounts = await Promise.all(platforms.map(async platform => {
        const id = randomUUID()
        const cookies = read!.cookies.filter(cookie => cookieDomainAllowed(cookie.domain, platform)).map(cookie => ({ ...cookie }))
        const unavailable = (message: string) => ({ id, platform, state: 'unavailable' as const, cookieCount: cookies.length, message })
        if (!hasAuthenticationCookies(cookies, platform)) {
          for (const cookie of cookies) cookie.value = ''
          if (read!.decryptionFailedPlatforms?.includes(platform)) return unavailable('平台凭据无法解密，请检查 Windows 授权或使用官方登录')
          return { id, platform, state: 'signed-out' as const, cookieCount: cookies.length, message: '请先在此浏览器用户中登录平台' }
        }
        try {
          const identity = await this.options.verify(platform, cookies, controller.signal)
          importAbort(controller.signal)
          if (!identity) {
            for (const cookie of cookies) cookie.value = ''
            return { id, platform, state: 'signed-out' as const, cookieCount: cookies.length, message: '登录已失效，请先在浏览器重新登录' }
          }
          candidates.push({ id, platform, cookies, identity })
          return { id, platform, state: 'ready' as const, cookieCount: cookies.length,
            username: identity.username, ...(identity.avatar ? { avatar: identity.avatar } : {}) }
        } catch (error) {
          for (const cookie of cookies) cookie.value = ''
          importAbort(controller.signal)
          return unavailable(error instanceof BrowserImportError ? error.message : '暂时无法确认平台登录状态，请重试')
        }
      }))
      importAbort(controller.signal)
      const result = { id: operation.id, profile: publicBrowserProfile(profile), expiresAt: this.now() + 5 * 60 * 1000, accounts }
      const timer = setTimeout(() => this.cancel(result.id), 5 * 60 * 1000)
      timer.unref?.()
      this.preview = { public: result, candidates, controller, timer }
      return structuredClone(result)
    } catch (error) { erase(candidates); throw error }
    finally {
      if (read) for (const cookie of read.cookies) cookie.value = ''
      if (this.operation === operation) this.operation = null
    }
  }
  async apply(value: unknown): Promise<{ outcomes: BrowserImportOutcome[] }> {
    this.available()
    if (!exact(value, ['previewId', 'accountIds'], ['douyuTarget']) || !validId(value.previewId)
      || !Array.isArray(value.accountIds) || !value.accountIds.length || value.accountIds.length > 5
      || value.accountIds.some(id => !validId(id)) || new Set(value.accountIds).size !== value.accountIds.length) throw invalid()
    const douyuTarget = target(value.douyuTarget)
    if (this.operation) throw new BrowserImportError('browser-import-busy')
    const preview = this.preview
    if (!preview || preview.public.id !== value.previewId || preview.public.expiresAt <= this.now()) {
      if (preview?.public.id === value.previewId) this.cancel(preview.public.id)
      throw new BrowserImportError('browser-import-preview-expired')
    }
    const candidates = value.accountIds.map(id => preview.candidates.find(candidate => candidate.id === id))
    if (candidates.some(candidate => !candidate)) throw invalid()
    clearTimeout(preview.timer)
    const operation = { id: preview.public.id, controller: preview.controller }
    this.operation = operation
    const outcomes: BrowserImportOutcome[] = []
    try {
      for (const candidate of candidates as Candidate[]) {
        try {
          importAbort(operation.controller.signal)
          const identity = await this.options.verify(candidate.platform, candidate.cookies, operation.controller.signal)
          importAbort(operation.controller.signal)
          if (!identity || identity.uid !== candidate.identity.uid
            || identity.uid === undefined && identity.username !== candidate.identity.username) {
            throw new BrowserImportError('browser-import-verification-failed')
          }
          const saved = await this.options.write(candidate.platform, candidate.cookies, identity, douyuTarget, operation.controller.signal)
          outcomes.push({ platform: candidate.platform, imported: true, username: identity.username, ...saved,
            message: candidate.platform === 'douyin' && saved.signingReady === false ? '已导入账号，但暂时不能发送弹幕，请重新登录' : '已导入账号' })
        } catch (error) {
          outcomes.push({ platform: candidate.platform, imported: false, username: candidate.identity.username,
            message: operation.controller.signal.aborted ? '已取消，未导入'
              : error instanceof BrowserImportError ? error.message : `${IMPORT_PLATFORM_NAMES[candidate.platform]}账号保存失败，原有账号已保留` })
        }
      }
      return { outcomes }
    } finally {
      erase(preview.candidates)
      if (this.preview === preview) this.preview = null
      if (this.operation === operation) this.operation = null
    }
  }
  async closeBrowser(value: unknown): Promise<BrowserImportCloseResult> {
    this.available()
    if (!exact(value, ['requestId', 'profileId']) || !validId(value.requestId) || !validId(value.profileId)) throw invalid()
    if (this.operation) throw new BrowserImportError('browser-import-busy')
    const controller = new AbortController()
    const operation = { id: value.requestId, controller }
    this.operation = operation
    try {
      const profile = (await this.profiles()).find(entry => entry.id === value.profileId)
      importAbort(controller.signal)
      if (!profile) throw new BrowserImportError('browser-import-profile-missing')
      const close = this.options.closeBrowser ?? browserCloser()
      const result = await close(profile, controller.signal)
      importAbort(controller.signal)
      return { status: result.status, browserName: profile.browserName }
    } finally {
      if (this.operation === operation) this.operation = null
    }
  }
  cancel(id: unknown): { cancelled: boolean } {
    if (!validId(id)) throw invalid()
    let cancelled = false
    if (this.operation?.id === id) { this.operation.controller.abort(); cancelled = true }
    if (this.preview?.public.id === id) {
      this.preview.controller.abort()
      clearTimeout(this.preview.timer)
      if (!this.operation || this.operation.id !== id) erase(this.preview.candidates)
      this.preview = null
      cancelled = true
    }
    return { cancelled }
  }
  release(): void {
    if (this.operation) this.cancel(this.operation.id)
    if (this.preview) this.cancel(this.preview.public.id)
  }
  dispose(): void { this.disposed = true; this.release() }
}
