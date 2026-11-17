import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { BrowserImportError, importAbort, type BrowserImportErrorCode } from './browserImportError'

declare const __BROWSER_CREDENTIALS_SHA256__: string
export interface BrowserKeyMaterial { content?: Buffer; cng?: Buffer; legacy?: Buffer }
export interface CredentialHelperOptions { executable: string; expectedHash?: string }

function decode(value: unknown, lengths: readonly number[]): Buffer | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 256) throw new BrowserImportError('browser-import-helper-invalid')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || !lengths.includes(bytes.length)) throw new BrowserImportError('browser-import-helper-invalid')
  return bytes
}
/** This subprocess owns the original user's DPAPI context. Electron stays unelevated. */
export async function readBrowserKeys(browser: 'chrome' | 'edge', input: { appBoundKey?: string; legacyKey?: string },
  options: CredentialHelperOptions, signal?: AbortSignal): Promise<BrowserKeyMaterial> {
  importAbort(signal)
  const executable = path.resolve(options.executable)
  const expected = options.expectedHash ?? (typeof __BROWSER_CREDENTIALS_SHA256__ === 'string' ? __BROWSER_CREDENTIALS_SHA256__ : undefined)
  let bytes: Buffer
  try {
    const stat = await fs.lstat(executable)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error()
    bytes = await fs.readFile(executable)
  } catch { throw new BrowserImportError('browser-import-helper-missing') }
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new BrowserImportError('browser-import-helper-invalid')
  }
  importAbort(signal)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--stdin'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: BrowserImportError, result?: BrowserKeyMaterial) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      for (const chunk of chunks) chunk.fill(0)
      if (error) { child.kill(); reject(error) } else resolve(result!)
    }
    const abort = () => finish(new BrowserImportError('browser-import-cancelled'))
    const timer = setTimeout(() => finish(new BrowserImportError('browser-import-timeout')), 125000)
    signal?.addEventListener('abort', abort, { once: true })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 32768) finish(new BrowserImportError('browser-import-helper-invalid'))
      else chunks.push(chunk)
    })
    child.once('error', () => finish(new BrowserImportError('browser-import-helper-missing')))
    child.once('close', () => {
      if (settled) return
      let combined: Buffer | undefined
      try {
        combined = Buffer.concat(chunks)
        const result = JSON.parse(combined.toString('utf8')) as Record<string, unknown>
        if (typeof result.errorCode === 'string') {
          const allowed = new Set<BrowserImportErrorCode>(['browser-import-uac-cancelled', 'browser-import-timeout',
            'browser-import-invalid-request', 'browser-import-decryption-failed', 'browser-import-unsupported'])
          finish(new BrowserImportError(allowed.has(result.errorCode as BrowserImportErrorCode)
            ? result.errorCode as BrowserImportErrorCode : 'browser-import-decryption-failed'))
          return
        }
        if (Object.keys(result).some(key => !['content', 'cngUnwrappedKey', 'legacyKey'].includes(key))) throw new Error()
        const material = { content: decode(result.content, [32, 61, 93]), cng: decode(result.cngUnwrappedKey, [32]),
          legacy: decode(result.legacyKey, [32]) }
        if (input.appBoundKey && !material.content || input.legacyKey && !material.legacy) throw new Error()
        finish(undefined, material)
      } catch { finish(new BrowserImportError('browser-import-helper-invalid')) }
      finally { combined?.fill(0) }
    })
    if (signal?.aborted) { abort(); return }
    const request = Buffer.from(JSON.stringify({ browser, ...input }))
    child.stdin.end(request, () => request.fill(0))
  })
}
