/** Main-only signing material, encrypted with the operating system credential protection. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateDouyinSigningMaterial, type DouyinSigningLookup, type DouyinSigningMaterial } from '../server/douyin/signingMaterial'
import { assertRegularPath, containedPath, privateDirectory } from './privateStorage'

export interface DouyinSigningProtection {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

export type DouyinSigningStoreErrorCode = 'douyin-signing-store-failed' | 'douyin-signing-store-cancelled' | 'douyin-signing-protection-unavailable'
export class DouyinSigningStoreError extends Error {
  constructor(readonly code: DouyinSigningStoreErrorCode = 'douyin-signing-store-failed') {
    super(code === 'douyin-signing-store-cancelled' ? '抖音签名材料操作已取消'
      : code === 'douyin-signing-protection-unavailable' ? '系统加密保护不可用，未保存或返回抖音签名材料'
      : '抖音签名材料读写失败，未返回私密数据')
    this.name = 'DouyinSigningStoreError'
  }
}

const MAX_PLAINTEXT_BYTES = 128 * 1024
const MAX_FILE_BYTES = 256 * 1024
const RETRY_DELAYS = [40, 80, 160, 320, 400] as const
const failure = () => new DouyinSigningStoreError()
const cancelled = () => new DouyinSigningStoreError('douyin-signing-store-cancelled')
const sameFile = (before: fs.Stats, after: fs.Stats) => after.isFile() && !after.isSymbolicLink() && after.nlink === 1
  && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs
interface Operation { revision: number; signal?: AbortSignal; current: () => boolean }
interface PendingMaterial { value: DouyinSigningMaterial | null }

/** A newer save/clear invalidates older work immediately, before it enters the serialized queue. */
export class DouyinSigningStore {
  private readonly root: string
  private readonly file: string
  private protection: DouyinSigningProtection | null
  private queue: Promise<unknown> = Promise.resolve()
  private revision = 0
  private disposed = false
  private readonly pendingMaterials = new Set<PendingMaterial>()

  constructor(root: string, options: { protection: DouyinSigningProtection; now?: () => number }) {
    try {
      this.root = path.resolve(root)
      this.file = containedPath(this.root, path.join(this.root, 'cookies', 'douyin-signing.json'))
      this.protection = options.protection
    } catch { throw failure() }
  }

  save(material: DouyinSigningMaterial, signal?: AbortSignal, current: () => boolean = () => true): Promise<void> {
    const operation = { revision: ++this.revision, signal, current }
    let pending: PendingMaterial
    try {
      this.check(operation)
      pending = { value: validateDouyinSigningMaterial(material) }
    } catch (error) { return Promise.reject(this.sanitize(error)) }
    this.pendingMaterials.add(pending)
    return this.serialize(async () => {
      let temporary: string | undefined
      let descriptor: number | undefined
      try {
        this.check(operation)
        if (!pending.value) throw cancelled()
        const envelope = this.encrypt(pending.value)
        pending.value = null
        this.check(operation)
        const directory = privateDirectory(this.root, path.dirname(this.file))
        this.validateTarget()
        temporary = containedPath(this.root, path.join(directory, `.douyin-signing-${randomUUID()}.tmp`))
        descriptor = fs.openSync(temporary, 'wx', 0o600)
        assertRegularPath(temporary, false)
        fs.writeFileSync(descriptor, envelope, 'utf8')
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = undefined
        await this.retry(operation, () => {
          this.validateTarget()
          assertRegularPath(containedPath(this.root, temporary!), false)
          this.check(operation)
          // An atomic rename retains the old record until the replacement succeeds.
          fs.renameSync(temporary!, this.file)
        })
        temporary = undefined
        this.validateTarget()
      } finally {
        pending.value = null
        this.pendingMaterials.delete(pending)
        if (descriptor !== undefined) { try { fs.closeSync(descriptor) } catch { /* Preserve only a fixed public error. */ } }
        if (temporary !== undefined) this.removeTemporary(temporary)
      }
    })
  }

  load(context: DouyinSigningLookup, signal?: AbortSignal, current: () => boolean = () => true): Promise<DouyinSigningMaterial | null> {
    const operation = { revision: this.revision, signal, current }
    let lookup: DouyinSigningLookup
    try { lookup = { cookieFingerprint: context?.cookieFingerprint, accountUid: context?.accountUid } }
    catch { return Promise.reject(failure()) }
    return this.serialize(async () => {
      this.check(operation)
      if (typeof lookup.cookieFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(lookup.cookieFingerprint)
        || lookup.accountUid !== undefined && (typeof lookup.accountUid !== 'string' || !/^[1-9]\d{0,19}$/.test(lookup.accountUid) || BigInt(lookup.accountUid) > 0xffff_ffff_ffff_ffffn)) throw failure()
      const before = this.validateTarget()
      if (!before) return null
      const protection = this.requireProtection()
      const handle = await fs.promises.open(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      let envelope: unknown
      try {
        this.check(operation)
        const stat = await handle.stat()
        if (!sameFile(before, stat)) throw failure()
        const bytes = Buffer.alloc(stat.size + 1)
        let length = 0
        while (length < bytes.length) {
          this.check(operation)
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length !== stat.size || !sameFile(before, await handle.stat())) throw failure()
        envelope = JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown
      } finally { await handle.close() }
      const after = this.validateTarget()
      if (!after || !sameFile(before, after)) throw failure()
      this.check(operation)
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw failure()
      const fields = envelope as Record<string, unknown>
      if (Object.keys(fields).length !== 2 || fields.schemaVersion !== 1 || typeof fields.ciphertext !== 'string'
        || !fields.ciphertext || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(fields.ciphertext)) throw failure()
      const encrypted = Buffer.from(fields.ciphertext, 'base64')
      if (!encrypted.length || encrypted.toString('base64') !== fields.ciphertext) throw failure()
      const plaintext = protection.decryptString(encrypted)
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) throw failure()
      const material = validateDouyinSigningMaterial(JSON.parse(plaintext) as unknown)
      this.check(operation)
      return material.cookieFingerprint === lookup.cookieFingerprint && (lookup.accountUid === undefined || material.accountUid === lookup.accountUid)
        ? material : null
    })
  }

  clear(signal?: AbortSignal, current: () => boolean = () => true): Promise<void> {
    const operation = { revision: ++this.revision, signal, current }
    return this.serialize(async () => {
      await this.retry(operation, () => {
        if (!this.validateTarget()) return
        this.check(operation)
        fs.unlinkSync(this.file)
      })
    })
  }

  /** Drop this module's references. Immutable strings cannot be reliably zeroed in JavaScript. */
  dispose(): void {
    this.disposed = true
    this.revision++
    this.protection = null
    for (const pending of this.pendingMaterials) pending.value = null
    this.pendingMaterials.clear()
  }

  private check(operation: Operation): void {
    let current = false
    try { current = operation.current() } catch { throw cancelled() }
    if (this.disposed || operation.signal?.aborted || !current || operation.revision !== this.revision) throw cancelled()
  }

  private requireProtection(): DouyinSigningProtection {
    try {
      const protection = this.protection
      if (!protection?.isEncryptionAvailable()) throw new Error()
      const backend = protection.getSelectedStorageBackend?.()
      if (backend === 'basic_text' || process.platform === 'linux' && (!backend || backend === 'unknown')) throw new Error()
      return protection
    } catch { throw new DouyinSigningStoreError('douyin-signing-protection-unavailable') }
  }

  private encrypt(material: DouyinSigningMaterial): string {
    const plaintext = JSON.stringify(material)
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) throw failure()
    const encrypted = this.requireProtection().encryptString(plaintext)
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw failure()
    const envelope = JSON.stringify({ schemaVersion: 1, ciphertext: encrypted.toString('base64') })
    if (Buffer.byteLength(envelope, 'utf8') > MAX_FILE_BYTES) throw failure()
    return envelope
  }

  private validateTarget(): fs.Stats | null {
    containedPath(this.root, this.file)
    let stat: fs.Stats
    try { stat = fs.lstatSync(this.file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    assertRegularPath(this.file, false)
    if (stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw failure()
    return stat
  }

  private removeTemporary(temporary: string): void {
    try {
      const safe = containedPath(this.root, temporary)
      assertRegularPath(safe, false)
      fs.unlinkSync(safe)
    } catch { throw failure() }
  }

  private async retry(operation: Operation, action: () => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      this.check(operation)
      try { action(); return }
      catch (error) {
        const delay = RETRY_DELAYS[attempt]
        if (delay === undefined || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); operation.signal?.removeEventListener('abort', abort); reject(cancelled()) }
          const timer = setTimeout(() => { operation.signal?.removeEventListener('abort', abort); resolve() }, delay)
          operation.signal?.addEventListener('abort', abort, { once: true })
          if (operation.signal?.aborted) abort()
        })
      }
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work).catch(error => { throw this.sanitize(error) })
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private sanitize(error: unknown): DouyinSigningStoreError {
    return error instanceof DouyinSigningStoreError ? error : failure()
  }
}
