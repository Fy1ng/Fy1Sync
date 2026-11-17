import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, createDecipheriv, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOUYIN_SIGNING_AID, DOUYIN_SIGNING_ORIGIN, DOUYIN_SIGNING_SCENE, validateDouyinSigningMaterial, type DouyinSigningMaterial } from '../server/douyin/signingMaterial'
import { douyinBrowserUserAgent } from '../server/douyin/httpContext'
import { DouyinSigningStore, type DouyinSigningProtection } from './douyinSigningStore'

let root: string
const stores: DouyinSigningStore[] = []
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const publicJwk = createPublicKey(keys.privateKey).export({ format: 'jwk' })
const rawPublicKey = Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x!, 'base64url'), Buffer.from(publicJwk.y!, 'base64url')]).toString('base64')
const material = (overrides: Partial<DouyinSigningMaterial> = {}): DouyinSigningMaterial => ({
  schemaVersion: 1, origin: DOUYIN_SIGNING_ORIGIN, aid: DOUYIN_SIGNING_AID, scene: DOUYIN_SIGNING_SCENE,
  accountUid: '123456789', cookieFingerprint: 'a'.repeat(64), userAgent: douyinBrowserUserAgent(),
  privateKeyPem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  publicKeyPem: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  ticket: 'synthetic-private-ticket', tsSign: 'ts.1.synthetic-time-signature', clientCertificate: `pub.${rawPublicKey}`,
  certificatePem: 'synthetic-certificate', aesSignSafari: 'synthetic-safari-signature', capturedAt: 1234567890000,
  ...overrides,
})
const lookup = { cookieFingerprint: 'a'.repeat(64), accountUid: '123456789' }
const filename = () => path.join(root, 'cookies', 'douyin-signing.json')
const busy = (code = 'EPERM') => Object.assign(new Error('synthetic-private-filesystem-detail'), { code })

/** A real authenticated cipher stands in for safeStorage; no user or OS credentials are used. */
function mockProtection(): DouyinSigningProtection {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptString: vi.fn(value => {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted])
    }),
    decryptString: vi.fn(value => {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8')
    }),
  }
}
function store(protection = mockProtection()) {
  const instance = new DouyinSigningStore(root, { protection, now: () => 1234567890000 })
  stores.push(instance)
  return { instance, protection }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'fy1sync-signing-store-')) })
afterEach(() => {
  for (const instance of stores.splice(0)) instance.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('fy1sync-signing-store-')) throw new Error('Invalid test cleanup path')
  fs.rmSync(root, { recursive: true, force: true })
})

describe('main-only encrypted Douyin signing store', () => {
  it('encrypts every private field and preserves the Netscape cookie file and saved record across disposal', async () => {
    const { instance, protection } = store()
    const selected = material()
    fs.mkdirSync(path.join(root, 'cookies'), { mode: 0o700 })
    const cookieFile = path.join(root, 'cookies', 'douyin.txt')
    const cookieText = '# Netscape HTTP Cookie File\n# synthetic cookie fixture\n'
    fs.writeFileSync(cookieFile, cookieText)
    await instance.save(selected)
    const text = fs.readFileSync(filename(), 'utf8'), envelope = JSON.parse(text) as { schemaVersion: number; ciphertext: string }
    expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'schemaVersion'])
    expect(envelope.schemaVersion).toBe(1)
    const encrypted = Buffer.from(envelope.ciphertext, 'base64')
    for (const value of [selected.privateKeyPem, selected.publicKeyPem, selected.ticket, selected.accountUid, selected.cookieFingerprint, selected.userAgent, selected.clientCertificate]) {
      expect(text).not.toContain(value)
      expect(encrypted.toString('utf8')).not.toContain(value)
    }
    expect(JSON.parse(protection.decryptString(encrypted))).toEqual(validateDouyinSigningMaterial(selected))
    expect(await instance.load(lookup)).toEqual(validateDouyinSigningMaterial(selected))
    expect(fs.readFileSync(cookieFile, 'utf8')).toBe(cookieText)
    if (process.platform !== 'win32') {
      expect(fs.statSync(filename()).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.join(root, 'cookies')).mode & 0o077).toBe(0)
    }
    instance.dispose()
    await expect(instance.load(lookup)).rejects.toMatchObject({ code: 'douyin-signing-store-cancelled' })
    expect(await store(protection).instance.load(lookup)).toEqual(validateDouyinSigningMaterial(selected))
  })

  it('returns null for a missing record or an exact account/fingerprint mismatch', async () => {
    const { instance } = store()
    expect(await instance.load(lookup)).toBeNull()
    await instance.save(material())
    expect(await instance.load({ ...lookup, accountUid: '987654321' })).toBeNull()
    expect(await instance.load({ ...lookup, cookieFingerprint: 'b'.repeat(64) })).toBeNull()
    expect(await instance.load({ cookieFingerprint: lookup.cookieFingerprint })).toEqual(validateDouyinSigningMaterial(material()))
    await expect(instance.load({ cookieFingerprint: 'invalid' })).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    await expect(instance.load({ ...lookup, accountUid: '18446744073709551616' })).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
  })

  it('snapshots and validates a supplied key before queued work, and never substitutes an old key for invalid input', async () => {
    const { instance } = store()
    const supplied = material()
    const saved = instance.save(supplied)
    supplied.ticket = 'mutated-by-caller'
    supplied.accountUid = '999'
    await saved
    expect((await instance.load(lookup))?.ticket).toBe('synthetic-private-ticket')
    const before = fs.readFileSync(filename())
    const unrelated = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    await expect(instance.save(material({ publicKeyPem: unrelated.publicKey.export({ format: 'pem', type: 'spki' }).toString() })))
      .rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    await expect(instance.save(material({ clientCertificate: 'pub.not-the-paired-key' }))).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    expect(fs.readFileSync(filename())).toEqual(before)
  })

  it.each(['unavailable', 'basic_text', 'encrypt-error'])('refuses insecure protection without plaintext fallback: %s', async mode => {
    const protection = mockProtection()
    if (mode === 'unavailable') vi.mocked(protection.isEncryptionAvailable).mockReturnValue(false)
    if (mode === 'basic_text') vi.mocked(protection.getSelectedStorageBackend!).mockReturnValue('basic_text')
    if (mode === 'encrypt-error') vi.mocked(protection.encryptString).mockImplementation(() => { throw new Error('synthetic-private-ticket') })
    const { instance } = store(protection)
    await expect(instance.save(material())).rejects.toMatchObject({ code: mode === 'encrypt-error' ? 'douyin-signing-store-failed' : 'douyin-signing-protection-unavailable' })
    expect(fs.existsSync(filename())).toBe(false)
    expect(fs.existsSync(path.join(root, 'cookies'))).toBe(false)
  })

  it('requires protection for loading an existing record and sanitizes decryption errors', async () => {
    const { instance, protection } = store()
    await instance.save(material())
    vi.mocked(protection.isEncryptionAvailable).mockReturnValue(false)
    await expect(instance.load(lookup)).rejects.toMatchObject({ code: 'douyin-signing-protection-unavailable' })
    vi.mocked(protection.isEncryptionAvailable).mockReturnValue(true)
    vi.mocked(protection.decryptString).mockImplementation(() => { throw new Error('synthetic-private-ticket ' + filename()) })
    const error = await instance.load(lookup).catch(error => error as Error)
    expect(error).toMatchObject({ code: 'douyin-signing-store-failed' })
    expect(String(error)).not.toContain('synthetic-private-ticket')
    expect(String(error)).not.toContain(root)
  })

  it('rejects broken envelopes, tampered ciphertext, invalid decrypted records and oversized files', async () => {
    const { instance, protection } = store()
    await instance.save(material())
    const original = JSON.parse(fs.readFileSync(filename(), 'utf8')) as { schemaVersion: number; ciphertext: string }
    for (const broken of ['not-json', JSON.stringify([]), JSON.stringify({ ...original, schemaVersion: 2 }),
      JSON.stringify({ ...original, accountUid: lookup.accountUid }), JSON.stringify({ schemaVersion: 1, ciphertext: '!invalid!' }),
      JSON.stringify({ schemaVersion: 1, ciphertext: Buffer.from('tampered').toString('base64') })]) {
      fs.writeFileSync(filename(), broken)
      await expect(instance.load(lookup)).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    }
    for (const plaintext of [JSON.stringify({ ...material(), ticket: '' }), 'invalid-json', 'x'.repeat(128 * 1024 + 1)]) {
      fs.writeFileSync(filename(), JSON.stringify({ schemaVersion: 1, ciphertext: protection.encryptString(plaintext).toString('base64') }))
      await expect(instance.load(lookup)).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    }
    fs.writeFileSync(filename(), 'x'.repeat(256 * 1024 + 1))
    vi.mocked(protection.decryptString).mockClear()
    await expect(instance.load(lookup)).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    expect(protection.decryptString).not.toHaveBeenCalled()
  })

  it('keeps the old file through bounded Windows replacement retries and cleans its temporary record', async () => {
    const { instance } = store()
    await instance.save(material())
    const before = fs.readFileSync(filename()), rename = fs.renameSync
    const replace = vi.spyOn(fs, 'renameSync')
      .mockImplementationOnce(() => { expect(fs.readFileSync(filename())).toEqual(before); throw busy('EPERM') })
      .mockImplementationOnce(() => { expect(fs.readFileSync(filename())).toEqual(before); throw busy('EACCES') })
      .mockImplementationOnce(() => { expect(fs.readFileSync(filename())).toEqual(before); throw busy('EBUSY') })
      .mockImplementation(rename)
    await instance.save(material({ ticket: 'replacement-ticket' }))
    expect(replace).toHaveBeenCalledTimes(4)
    expect((await instance.load(lookup))?.ticket).toBe('replacement-ticket')
    expect(fs.readdirSync(path.dirname(filename()))).toEqual(['douyin-signing.json'])
  })

  it('bounds persistent replacement errors without unlinking the old record, and does not retry fsync failures', async () => {
    const { instance } = store()
    await instance.save(material())
    const before = fs.readFileSync(filename())
    const replace = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw busy() })
    await expect(instance.save(material({ ticket: 'replacement' }))).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    expect(replace).toHaveBeenCalledTimes(6)
    expect(fs.readFileSync(filename())).toEqual(before)
    expect(fs.readdirSync(path.dirname(filename()))).toEqual(['douyin-signing.json'])
    replace.mockClear()
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw busy() })
    await expect(instance.save(material())).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    expect(replace).not.toHaveBeenCalled()
    expect(fs.readFileSync(filename())).toEqual(before)
  })

  it('stops save on signal/current changes before commit, including during Windows retry', async () => {
    const { instance, protection } = store()
    await instance.save(material())
    const before = fs.readFileSync(filename())
    const already = new AbortController(); already.abort()
    await expect(instance.save(material(), already.signal)).rejects.toMatchObject({ code: 'douyin-signing-store-cancelled' })
    const controller = new AbortController()
    const replace = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { controller.abort(); throw busy() })
    await expect(instance.save(material({ ticket: 'late-ticket' }), controller.signal)).rejects.toMatchObject({ code: 'douyin-signing-store-cancelled' })
    expect(replace).toHaveBeenCalledOnce()
    let current = true
    const encrypt = protection.encryptString
    vi.mocked(protection.encryptString).mockImplementationOnce(value => { const result = encrypt(value); current = false; return result })
    await expect(instance.save(material(), undefined, () => current)).rejects.toMatchObject({ code: 'douyin-signing-store-cancelled' })
    current = true
    replace.mockImplementationOnce(() => { current = false; throw busy() })
    await expect(instance.save(material(), undefined, () => current)).rejects.toMatchObject({ code: 'douyin-signing-store-cancelled' })
    expect(fs.readFileSync(filename())).toEqual(before)
    expect(fs.readdirSync(path.dirname(filename()))).toEqual(['douyin-signing.json'])
  })

  it('disposal cancels a pending replacement and leaves the last committed encrypted record intact', async () => {
    const { instance, protection } = store()
    await instance.save(material())
    const before = fs.readFileSync(filename()), entered = deferred()
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { entered.resolve(); throw busy() })
    const pending = instance.save(material({ ticket: 'must-not-commit-after-disposal' }))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'douyin-signing-store-cancelled' })
    await entered.promise
    instance.dispose()
    await rejected
    expect(fs.readFileSync(filename())).toEqual(before)
    expect(fs.readdirSync(path.dirname(filename()))).toEqual(['douyin-signing.json'])
    expect((await store(protection).instance.load(lookup))?.ticket).toBe('synthetic-private-ticket')
  })

  it('does not let an older pending save overwrite a new save or recreate a record after clear', async () => {
    const { instance } = store()
    await instance.save(material())
    const rename = fs.renameSync, entered = deferred()
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { entered.resolve(); throw busy() }).mockImplementation(rename)
    const pending = instance.save(material({ ticket: 'stale-ticket' }))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'douyin-signing-store-cancelled' })
    await entered.promise
    const replacement = instance.save(material({ ticket: 'newest-ticket' }))
    await rejected; await replacement
    expect((await instance.load(lookup))?.ticket).toBe('newest-ticket')
    const queued = instance.save(material({ ticket: 'logout-race' }))
    const stale = expect(queued).rejects.toMatchObject({ code: 'douyin-signing-store-cancelled' })
    const clear = instance.clear()
    await stale; await clear
    expect(await instance.load(lookup)).toBeNull()
  })

  it.each(['clear', 'save', 'abort', 'current', 'dispose'])('invalidates an in-progress read when %s takes over', async mode => {
    const { instance } = store()
    await instance.save(material())
    const open = fs.promises.open, entered = deferred(), release = deferred()
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (file, flags, permissions) => {
      entered.resolve(); await release.promise
      return open(file, flags, permissions)
    })
    const signal = new AbortController(); let current = true
    const loading = instance.load(lookup, signal.signal, () => current)
    const rejected = expect(loading).rejects.toMatchObject({ code: 'douyin-signing-store-cancelled' })
    await entered.promise
    let mutation: Promise<void> | undefined
    if (mode === 'clear') mutation = instance.clear()
    if (mode === 'save') mutation = instance.save(material({ ticket: 'new-session' }))
    if (mode === 'abort') signal.abort()
    if (mode === 'current') current = false
    if (mode === 'dispose') instance.dispose()
    release.resolve()
    await rejected; await mutation
    if (mode === 'clear') expect(await instance.load(lookup)).toBeNull()
    if (mode === 'save') expect((await instance.load(lookup))?.ticket).toBe('new-session')
  })

  it('clears only the validated signing file, supports missing clear and protects cancellation', async () => {
    const { instance } = store()
    await instance.clear()
    await instance.save(material())
    const other = path.join(root, 'cookies', 'douyin.txt')
    fs.writeFileSync(other, 'synthetic-cookies')
    const controller = new AbortController(); controller.abort()
    await expect(instance.clear(controller.signal)).rejects.toMatchObject({ code: 'douyin-signing-store-cancelled' })
    expect(fs.existsSync(filename())).toBe(true)
    await instance.clear()
    expect(fs.existsSync(filename())).toBe(false)
    expect(fs.readFileSync(other, 'utf8')).toBe('synthetic-cookies')
  })

  it('rejects a linked directory before accessing or clearing its signing file', async () => {
    const { instance } = store()
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    const privateFile = path.join(outside, 'douyin-signing.json')
    fs.writeFileSync(privateFile, 'untouched-synthetic-target')
    fs.symlinkSync(outside, path.join(root, 'cookies'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(instance.load(lookup)).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    await expect(instance.save(material())).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    await expect(instance.clear()).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    expect(fs.readFileSync(privateFile, 'utf8')).toBe('untouched-synthetic-target')
    expect(() => new DouyinSigningStore(path.join(root, 'cookies'), { protection: mockProtection() })).toThrow('抖音签名材料读写失败')
  })

  it('rejects hard-linked or non-regular targets without deleting their aliases', async () => {
    const { instance } = store()
    await instance.save(material())
    const alias = path.join(root, 'alias.json')
    fs.linkSync(filename(), alias)
    await expect(instance.load(lookup)).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    await expect(instance.clear()).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    expect(fs.existsSync(alias)).toBe(true)
    fs.unlinkSync(filename())
    fs.mkdirSync(filename())
    await expect(instance.load(lookup)).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    await expect(instance.save(material())).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    await expect(instance.clear()).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
  })

  it('rejects a link at the target filename and never follows it while reading or clearing', async () => {
    const { instance } = store()
    fs.mkdirSync(path.join(root, 'cookies'))
    const directory = path.join(root, 'target-directory')
    fs.mkdirSync(directory)
    const sentinel = path.join(directory, 'untouched.txt')
    fs.writeFileSync(sentinel, 'synthetic-private-target')
    fs.symlinkSync(directory, filename(), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(instance.load(lookup)).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    await expect(instance.save(material())).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    await expect(instance.clear()).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('synthetic-private-target')
    expect(fs.lstatSync(filename()).isSymbolicLink()).toBe(true)
  })

  it('detects an atomic file replacement during a bounded read instead of returning the old material', async () => {
    const { instance } = store()
    await instance.save(material())
    const open = fs.promises.open
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (file, flags, permissions) => {
      const handle = await open(file, flags, permissions)
      fs.renameSync(filename(), path.join(root, 'old.json'))
      fs.writeFileSync(filename(), 'replacement-must-not-be-read-through-old-handle')
      return handle
    })
    await expect(instance.load(lookup)).rejects.toMatchObject({ code: 'douyin-signing-store-failed' })
  })
})
