import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export type DecoderMode = 'auto' | 'software'

export interface DecoderPreferenceState {
  mode: DecoderMode
  effectiveMode: DecoderMode
  restartRequired: boolean
  forcedByCommandLine: boolean
}

export const DECODER_PREFERENCES_FILE = 'decoder-preferences.json'
const MAX_BYTES = 4096

export function isDecoderMode(value: unknown): value is DecoderMode {
  return value === 'auto' || value === 'software'
}

/** Synchronous and bounded because Chromium switches must be set before app ready. */
function readMode(file: string): DecoderMode {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_BYTES) return 'auto'
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      length += count
      if (!count || length > MAX_BYTES) break
    }
    if (length > MAX_BYTES) return 'auto'
    const data: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'auto'
    const entry = data as Record<string, unknown>
    return Object.keys(entry).length === 2 && entry.version === 1 && isDecoderMode(entry.mode) ? entry.mode : 'auto'
  } catch { return 'auto' }
  finally { if (fd !== undefined) closeSync(fd) }
}

/** Same-directory rename publishes only complete settings; failures leave the old file intact. */
async function writeMode(directory: string, file: string, mode: DecoderMode): Promise<void> {
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.decoder-preferences-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify({ version: 1, mode }) + '\n', 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}

export interface DecoderPreferencesService {
  get(): DecoderPreferenceState
  set(mode: DecoderMode): Promise<DecoderPreferenceState>
}

export class DecoderPreferences implements DecoderPreferencesService {
  private mode: DecoderMode
  private readonly effectiveMode: DecoderMode
  private writes: Promise<unknown> = Promise.resolve()
  private readonly file: string

  constructor(private readonly directory: string, private readonly forcedByCommandLine = false,
    private readonly persist = writeMode) {
    this.file = join(directory, DECODER_PREFERENCES_FILE)
    this.mode = readMode(this.file)
    this.effectiveMode = forcedByCommandLine ? 'software' : this.mode
  }

  get(): DecoderPreferenceState {
    return { mode: this.mode, effectiveMode: this.effectiveMode,
      restartRequired: this.mode !== this.effectiveMode, forcedByCommandLine: this.forcedByCommandLine }
  }

  set(mode: DecoderMode): Promise<DecoderPreferenceState> {
    if (!isDecoderMode(mode)) return Promise.reject(new Error('Invalid decoder mode'))
    const operation = this.writes.then(async () => {
      await this.persist(this.directory, this.file, mode)
      // Publish in memory only after the atomic disk write succeeds.
      this.mode = mode
      return this.get()
    })
    this.writes = operation.catch(() => {})
    return operation
  }
}
