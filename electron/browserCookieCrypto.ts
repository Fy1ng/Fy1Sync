import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto'
import { BrowserImportError } from './browserImportError'

// Public browser key-wrapping parameters, also used by Bitwarden's Chromium importer.
const AES = Buffer.from('b31c6e241ac846728da9c1fac4936651cffb944d143ab816276bcdd6da284787', 'hex')
const CHACHA = Buffer.from('e98f37d7f4e1fa433d19303dd2c58042090e2d1d7eea7670d41f738d08729660', 'hex')
const XOR: Record<number, Buffer> = {
  3: Buffer.from('ccf8a1cec56605b8517552ba1a2d061c03a29e90274fb2fcf59ba4b75c392390', 'hex'),
  4: Buffer.from('208a6da7114a44e6b463114bd9da397e939adefedbf4588117926b0f2c503158', 'hex'),
}
function decrypt(algorithm: 'aes-256-gcm' | 'chacha20-poly1305', key: Buffer, ciphertext: Buffer): Buffer {
  if (key.length !== 32 || ciphertext.length < 28) throw new Error('Invalid encrypted data')
  const decipher = algorithm === 'aes-256-gcm'
    ? createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12), { authTagLength: 16 })
    : createDecipheriv('chacha20-poly1305', key, ciphertext.subarray(0, 12), { authTagLength: 16 })
  decipher.setAuthTag(ciphertext.subarray(-16))
  return Buffer.concat([decipher.update(ciphertext.subarray(12, -16)), decipher.final()])
}
export function chromiumMasterKey(content: Buffer, cng?: Buffer): Buffer {
  try {
    if (content.length === 32) return Buffer.from(content)
    const version = content[0]!
    if ((version === 1 || version === 2) && content.length === 61) {
      return decrypt(version === 1 ? 'aes-256-gcm' : 'chacha20-poly1305', version === 1 ? AES : CHACHA, content.subarray(1))
    }
    if ((version === 3 || version === 4) && content.length === 93 && cng?.length === 32) {
      const intermediate = Buffer.from(cng)
      try {
        for (let index = 0; index < 32; index++) intermediate[index] = intermediate[index]! ^ XOR[version]![index]!
        return decrypt('aes-256-gcm', intermediate, content.subarray(33))
      } finally { intermediate.fill(0) }
    }
    throw new Error('Unsupported encrypted data')
  } catch { throw new BrowserImportError('browser-import-decryption-failed') }
}
export function chromiumCookieValue(blob: Buffer, host: string, schema: number, keys: { master?: Buffer; legacy?: Buffer }): string {
  let clear: Buffer | undefined
  try {
    const version = blob.subarray(0, 3).toString('ascii')
    const key = version === 'v20' ? keys.master : version === 'v10' || version === 'v11' ? keys.legacy : undefined
    if (!key) throw new Error('Unsupported encrypted data')
    clear = decrypt('aes-256-gcm', key, blob.subarray(3))
    let payload = clear
    if (schema >= 24) {
      const hash = createHash('sha256').update(host).digest()
      if (clear.length < 32 || !timingSafeEqual(clear.subarray(0, 32), hash)) throw new Error('Invalid encrypted data')
      payload = clear.subarray(32)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(payload)
  } catch { throw new BrowserImportError('browser-import-decryption-failed') }
  finally { clear?.fill(0) }
}
