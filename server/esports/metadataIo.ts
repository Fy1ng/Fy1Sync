import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { metadataConfig } from '../config'
import { diagnosticDetails } from '../errorDetails'
import { httpErrorDetails } from '../httpError'

const MAX_BODY_BYTES = 2_000_000
export const SCHEDULE_UNAVAILABLE = '赛程暂时无法读取，请稍后重试'
export const UPSTREAM_LIMITED = '赛程更新受限，暂时显示上次结果'
export const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)

export function liquipediaConfig() { return { ...metadataConfig(), hosts: ['liquipedia.net'] } }

export function readBounded(file: string, limit = MAX_BODY_BYTES): string {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Invalid metadata cache')
  return readFileSync(file, 'utf8')
}

export function atomicJson(directory: string, name: string, value: unknown): void {
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, join(directory, name))
  } finally { try { unlinkSync(temporary) } catch { /* Already renamed, or never created. */ } }
}

export async function readBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('Missing metadata response body')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > limit) throw new Error('Metadata response too large')
      chunks.push(part.value)
    }
    return Buffer.concat(chunks)
  } catch (error) { void reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
}

export async function readJson(response: Response, limit = MAX_BODY_BYTES): Promise<unknown> {
  if (response.status !== 200 || response.redirected || !response.body) {
    const detail = await httpErrorDetails(response)
    throw Object.assign(new Error('Metadata response unavailable'), detail)
  }
  const payload: unknown = JSON.parse((await readBody(response, limit)).toString('utf8'))
  if (object(payload) && payload.error) throw Object.assign(new Error('Metadata API returned an error'), { upstream: diagnosticDetails(payload.error) })
  return payload
}
