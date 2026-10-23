import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { containedPath, NativePrivatePermissions, privateDirectory, type PrivatePermissions } from './privateStorage'

const MAX_BYTES = 1024 * 1024

/** Small main-process settings, atomically replaced inside a private app subtree. */
export class PrivateJsonStore<T> {
  private readonly permissions: PrivatePermissions
  private readonly file: string

  constructor(private readonly root: string, relativeFile: string, permissions?: PrivatePermissions) {
    this.permissions = permissions ?? new NativePrivatePermissions()
    this.file = containedPath(root, path.join(root, relativeFile))
  }

  load(): unknown {
    try {
      containedPath(this.root, this.file)
      if (!fs.existsSync(this.file)) return undefined
      const stat = fs.lstatSync(this.file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error()
      this.permissions.verify(path.dirname(this.file), true)
      this.permissions.verify(this.file, false)
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown
    } catch { throw new Error('本地配置读取失败, 原文件已保留.') }
  }

  save(value: T): void {
    let temporary: string | undefined
    let descriptor: number | undefined
    try {
      const text = JSON.stringify(value)
      if (!text || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error()
      const directory = privateDirectory(this.root, path.dirname(this.file), this.permissions)
      containedPath(this.root, this.file)
      if (fs.existsSync(this.file)) this.permissions.verify(this.file, false)
      temporary = containedPath(this.root, path.join(directory, `.${path.basename(this.file)}-${randomUUID()}.tmp`))
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      this.permissions.protect(temporary, false)
      fs.writeFileSync(descriptor, text, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      this.permissions.verify(temporary, false)
      fs.renameSync(temporary, this.file)
      temporary = undefined
    } catch { throw new Error('本地配置保存失败, 请重试.') }
    finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      if (temporary !== undefined) {
        containedPath(this.root, temporary)
        fs.rmSync(temporary, { force: true })
      }
    }
  }
}
