import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertRegularPath, containedPath, privateDirectory } from './privateStorage'

const MAX_BYTES = 1024 * 1024
const MAX_CORRUPT_BACKUPS = 3

/** Small main-process settings, atomically replaced inside a private app subtree. */
export class PrivateJsonStore<T> {
  private readonly file: string

  constructor(private readonly root: string, relativeFile: string) {
    this.file = containedPath(root, path.join(root, relativeFile))
  }

  load(): unknown {
    try {
      containedPath(this.root, this.file)
      if (!fs.existsSync(this.file)) return undefined
      const stat = fs.lstatSync(this.file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error()
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown
    } catch { throw new Error('本地配置读取失败，原文件已保留') }
  }

  /**
   * Move a damaged regular JSON file aside as `<name>.corrupt-<timestamp>-<id>.bak`
   * so startup can recover cleanly with defaults while preserving forensic evidence.
   */
  quarantineCorrupt(now = Date.now()): string | null {
    try {
      containedPath(this.root, this.file)
      if (!fs.existsSync(this.file)) return null
      assertRegularPath(this.file, false)
      const directory = path.dirname(this.file)
      const base = path.basename(this.file)
      const stamp = Number.isSafeInteger(now) && now >= 0 ? now : Date.now()
      const backupName = `${base}.corrupt-${stamp}-${randomUUID().slice(0, 8)}.bak`
      const backupPath = containedPath(this.root, path.join(directory, backupName))
      fs.renameSync(this.file, backupPath)
      this.pruneCorruptBackups(directory, base)
      return backupName
    } catch {
      return null
    }
  }

  private pruneCorruptBackups(directory: string, base: string): void {
    try {
      const prefix = `${base}.corrupt-`
      const entries = fs.readdirSync(directory, { withFileTypes: true })
        .filter(item => item.isFile() && !item.isSymbolicLink() && item.name.startsWith(prefix) && item.name.endsWith('.bak'))
        .map(item => {
          const full = containedPath(this.root, path.join(directory, item.name))
          const mtimeMs = fs.lstatSync(full).mtimeMs
          return { name: item.name, full, mtimeMs }
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name))
      for (const stale of entries.slice(MAX_CORRUPT_BACKUPS)) {
        try { fs.rmSync(stale.full, { force: true }) } catch { /* Best-effort backup retention cleanup. */ }
      }
    } catch {
      // Never fail startup recovery if backup pruning encounters an error.
    }
  }

  save(value: T): void {
    let temporary: string | undefined
    let descriptor: number | undefined
    try {
      const text = JSON.stringify(value)
      if (!text || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error()
      const directory = privateDirectory(this.root, path.dirname(this.file))
      containedPath(this.root, this.file)
      if (fs.existsSync(this.file)) assertRegularPath(this.file, false)
      temporary = containedPath(this.root, path.join(directory, `.${path.basename(this.file)}-${randomUUID()}.tmp`))
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      assertRegularPath(temporary, false)
      fs.writeFileSync(descriptor, text, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      assertRegularPath(temporary, false)
      fs.renameSync(temporary, this.file)
      temporary = undefined
    } catch { throw new Error('本地配置保存失败，请重试') }
    finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      if (temporary !== undefined) {
        containedPath(this.root, temporary)
        fs.rmSync(temporary, { force: true })
      }
    }
  }
}
