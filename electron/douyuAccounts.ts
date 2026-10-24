import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { LoginManager, LoginError, type PlatformLoginStatus } from './login'
import { NativePrivatePermissions, privateDirectory, type PrivatePermissions } from './privateStorage'
import { PrivateJsonStore } from './privateJsonStore'
import type { DouyuAccountsSnapshot } from '../server/douyu/types'

type AccountRecord = { id: string; label: string; createdAt: number }
interface AccountStorage { version: 1; accounts: AccountRecord[]; activeAccountId: string | null }
type AccountLogin = Pick<LoginManager, 'login' | 'loginStatus' | 'logout' | 'cookieHeader' | 'dispose'>
type AccountEvent = { type: 'changed' } | { type: 'invalidated'; accountId: string }

export type DouyuAccountErrorCode = 'invalid-arguments' | 'account-not-found' | 'account-limit' | 'account-busy' | 'no-active-account' | 'storage-failed' | 'disposed'
export class DouyuAccountError extends Error {
  constructor(readonly code: DouyuAccountErrorCode) {
    super({
      'invalid-arguments': '账号参数无效, 名称需为1至40个字符.',
      'account-not-found': '斗鱼账号不存在.',
      'account-limit': '最多保存16个斗鱼账号.',
      'account-busy': '账号正在登录或退出, 请稍后重试.',
      'no-active-account': '请先选择当前斗鱼账号.',
      'storage-failed': '斗鱼账号配置读写失败, 请重试.',
      disposed: '斗鱼账号管理已关闭.',
    }[code])
  }
}

export function isDouyuAccountId(value: unknown): value is string {
  return typeof value === 'string' && (value === 'default' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
}

function labelOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40 || /[\x00-\x1f\x7f]/.test(value)) throw new DouyuAccountError('invalid-arguments')
  return value.trim()
}

function initialStorage(now: number): AccountStorage {
  // Keep the original profile and cookies in place, including its existing login session.
  return { version: 1, activeAccountId: 'default', accounts: [{ id: 'default', label: '默认账号', createdAt: now }] }
}

function readStorage(raw: unknown, now: number): AccountStorage {
  if (raw === undefined) return initialStorage(now)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DouyuAccountError('storage-failed')
  const value = raw as AccountStorage
  if (Object.keys(value).some(key => !['version', 'accounts', 'activeAccountId'].includes(key)) || value.version !== 1
    || !Array.isArray(value.accounts) || value.accounts.length > 16) throw new DouyuAccountError('storage-failed')
  const ids = new Set<string>()
  for (const record of value.accounts) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).some(key => !['id', 'label', 'createdAt'].includes(key))
      || !isDouyuAccountId(record.id) || ids.has(record.id) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) throw new DouyuAccountError('storage-failed')
    try { if (labelOf(record.label) !== record.label) throw new Error() } catch { throw new DouyuAccountError('storage-failed') }
    ids.add(record.id)
  }
  if (value.activeAccountId !== null && !ids.has(value.activeAccountId)) throw new DouyuAccountError('storage-failed')
  return structuredClone(value)
}

const emptyLogin = (): PlatformLoginStatus => ({ loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false })

export interface DouyuAccountManagerOptions {
  defaultLogin: AccountLogin
  createLogin?: (accountRoot: string) => AccountLogin
  permissions?: PrivatePermissions
  store?: { load(): unknown; save(value: AccountStorage): void }
  now?: () => number
  id?: () => string
}

export class DouyuAccountManager {
  private registry: AccountStorage
  private readonly store: { load(): unknown; save(value: AccountStorage): void }
  private readonly permissions: PrivatePermissions
  private readonly managers = new Map<string, AccountLogin>()
  private readonly busy = new Set<string>()
  private readonly revisions = new Map<string, number>()
  private readonly listeners = new Set<(event: AccountEvent) => void>()
  private disposed = false

  constructor(private readonly root: string, private readonly options: DouyuAccountManagerOptions) {
    this.permissions = options.permissions ?? new NativePrivatePermissions()
    this.store = options.store ?? new PrivateJsonStore<AccountStorage>(root, 'douyu/accounts.json', this.permissions)
    try { this.registry = readStorage(this.store.load(), (options.now ?? Date.now)()) }
    catch { throw new DouyuAccountError('storage-failed') }
  }

  get activeAccountId(): string | null { return this.registry.activeAccountId }
  hasAccount(id: string): boolean { return this.registry.accounts.some(account => account.id === id) }
  isBusy(id: string): boolean { return this.busy.has(id) }

  subscribe(listener: (event: AccountEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: AccountEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* A closed view cannot interrupt credential invalidation. */ }
    }
  }

  private invalidate(id: string): void {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
    this.emit({ type: 'invalidated', accountId: id })
  }

  private check(id?: string): AccountRecord | undefined {
    if (this.disposed) throw new DouyuAccountError('disposed')
    if (id === undefined) return undefined
    const record = this.registry.accounts.find(account => account.id === id)
    if (!record || !isDouyuAccountId(id)) throw new DouyuAccountError('account-not-found')
    return record
  }

  private save(next: AccountStorage): void {
    try { this.store.save(structuredClone(next)) } catch { throw new DouyuAccountError('storage-failed') }
    this.registry = next
    this.emit({ type: 'changed' })
  }

  private manager(id: string): AccountLogin {
    this.check(id)
    if (id === 'default') return this.options.defaultLogin
    let manager = this.managers.get(id)
    if (!manager) {
      try {
        const accountRoot = privateDirectory(this.root, path.join(this.root, 'douyu', 'account-data', id), this.permissions)
        manager = this.options.createLogin?.(accountRoot) ?? new LoginManager(accountRoot)
        this.managers.set(id, manager)
      } catch { throw new DouyuAccountError('storage-failed') }
    }
    return manager
  }

  async snapshot(): Promise<DouyuAccountsSnapshot> {
    this.check()
    const current = this.registry
    const accounts = await Promise.all(current.accounts.map(async account => ({
      id: account.id, label: account.label, active: account.id === current.activeAccountId,
      busy: this.busy.has(account.id), login: (await this.manager(account.id).loginStatus()).douyu,
    })))
    return { activeAccountId: current.activeAccountId, accounts }
  }

  async add(label: string): Promise<DouyuAccountsSnapshot> {
    this.check()
    const normalized = labelOf(label)
    if (this.registry.accounts.length >= 16) throw new DouyuAccountError('account-limit')
    const id = (this.options.id ?? randomUUID)()
    if (!isDouyuAccountId(id) || id === 'default' || this.hasAccount(id)) throw new DouyuAccountError('invalid-arguments')
    this.save({ ...this.registry, accounts: [...this.registry.accounts, { id, label: normalized, createdAt: (this.options.now ?? Date.now)() }] })
    return this.snapshot()
  }

  async rename(id: string, label: string): Promise<DouyuAccountsSnapshot> {
    this.check(id)
    const normalized = labelOf(label)
    this.save({ ...this.registry, accounts: this.registry.accounts.map(account => account.id === id ? { ...account, label: normalized } : account) })
    return this.snapshot()
  }

  async activate(id: string): Promise<DouyuAccountsSnapshot> {
    this.check(id)
    if (this.busy.has(id)) throw new DouyuAccountError('account-busy')
    const old = this.activeAccountId
    if (old !== id) {
      this.save({ ...this.registry, activeAccountId: id })
      if (old) this.invalidate(old)
    }
    return this.snapshot()
  }

  private async credentialOperation(id: string, operation: (manager: AccountLogin) => Promise<unknown>): Promise<void> {
    this.check(id)
    if (this.busy.has(id)) throw new DouyuAccountError('account-busy')
    this.busy.add(id)
    this.invalidate(id)
    try { await operation(this.manager(id)) }
    catch (error) {
      if (error instanceof LoginError || error instanceof DouyuAccountError) throw error
      throw new LoginError('login-failed')
    } finally { this.busy.delete(id); this.invalidate(id); this.emit({ type: 'changed' }) }
  }

  async login(id: string): Promise<DouyuAccountsSnapshot> {
    await this.credentialOperation(id, manager => manager.login('douyu'))
    return this.snapshot()
  }

  async loginYuba(id: string): Promise<DouyuAccountsSnapshot> {
    await this.credentialOperation(id, manager => manager.login('douyu', 'yuba'))
    return this.snapshot()
  }

  async openRoom(id: string, room: string, page: 'room' | 'fish-act' = 'room'): Promise<DouyuAccountsSnapshot> {
    if (typeof room !== 'string' || !/^[1-9][0-9]{0,11}$/.test(room)) throw new DouyuAccountError('invalid-arguments')
    if (page !== 'room' && page !== 'fish-act') throw new DouyuAccountError('invalid-arguments')
    if (this.activeAccountId !== id) throw new DouyuAccountError('no-active-account')
    await this.credentialOperation(id, manager => manager.login('douyu', `${page}:${room}`))
    return this.snapshot()
  }

  async logout(id: string): Promise<DouyuAccountsSnapshot> {
    await this.credentialOperation(id, manager => manager.logout('douyu'))
    return this.snapshot()
  }

  async remove(id: string): Promise<DouyuAccountsSnapshot> {
    await this.credentialOperation(id, async manager => {
      await manager.logout('douyu')
      this.check(id)
      this.save({ ...this.registry, activeAccountId: this.activeAccountId === id ? null : this.activeAccountId,
        accounts: this.registry.accounts.filter(account => account.id !== id) })
      const owned = this.managers.get(id)
      this.managers.delete(id)
      await owned?.dispose()
    })
    return this.snapshot()
  }

  async activeLoginStatus(): Promise<PlatformLoginStatus> {
    this.check()
    return this.activeAccountId ? (await this.manager(this.activeAccountId).loginStatus()).douyu : emptyLogin()
  }

  async loginActive(): Promise<import('./login').LoginResult> {
    const id = this.activeAccountId
    if (!id) throw new DouyuAccountError('no-active-account')
    await this.login(id)
    if (this.activeAccountId !== id) throw new DouyuAccountError('no-active-account')
    const { cookieCount, authKeysPresent } = await this.activeLoginStatus()
    return { cookieCount, authKeysPresent }
  }

  async logoutActive(): Promise<void> {
    if (this.activeAccountId) await this.logout(this.activeAccountId)
  }

  /** This capability is main-process-only and bound to the active account revision. */
  async cookieHeader(id: string, requestUrl?: string): Promise<string> {
    this.check(id)
    if (this.activeAccountId !== id || this.busy.has(id)) throw new DouyuAccountError('no-active-account')
    const revision = this.revisions.get(id) ?? 0
    const header = await this.manager(id).cookieHeader('douyu', requestUrl)
    if (this.disposed || this.activeAccountId !== id || this.busy.has(id) || (this.revisions.get(id) ?? 0) !== revision) throw new DouyuAccountError('no-active-account')
    return header
  }

  async activeCookieHeader(requestUrl?: string): Promise<string> {
    const id = this.activeAccountId
    if (!id) return ''
    return this.cookieHeader(id, requestUrl)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const account of this.registry.accounts) this.invalidate(account.id)
    this.listeners.clear()
    await Promise.allSettled([...this.managers.values()].map(manager => manager.dispose()))
    this.managers.clear()
  }
}
