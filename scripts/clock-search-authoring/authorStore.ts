import { constants } from 'node:fs'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { parseBasicClockSearchConfig, type BasicClockSearchConfig } from '../../src/core/basicClockSearch'
import type { RoiRect } from '../../src/core/profileSchema'

export interface ClockSearchAuthorState {
  config: BasicClockSearchConfig
  writable: boolean
  configPath: string
}

/** The renderer can choose coordinates, never a filesystem target. */
export class ClockSearchAuthorStore {
  readonly configPath: string
  private saved = false
  private writes: Promise<unknown> = Promise.resolve()

  constructor(configPath: string, private readonly reset = false) { this.configPath = resolve(configPath) }

  private async checkTarget(): Promise<void> {
    const parent = await lstat(dirname(this.configPath))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('生产配置目录不能是链接或普通文件')
    const stat = await lstat(this.configPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('生产配置文件不是有效的普通配置文件')
  }

  private async readConfig(): Promise<BasicClockSearchConfig> {
    await this.checkTarget()
    // O_NOFOLLOW also protects the final component on platforms which support it.
    const handle = await open(this.configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 16_384) throw new Error('生产配置文件过大或不可读取')
      const text = await handle.readFile('utf8')
      let raw: unknown
      try { raw = JSON.parse(text) } catch { throw new Error('生产配置文件不是有效的 JSON') }
      return parseBasicClockSearchConfig(raw)
    } finally { await handle.close() }
  }

  async getState(): Promise<ClockSearchAuthorState> {
    const config = await this.readConfig()
    return { config, writable: !this.saved && (!config.configured || this.reset), configPath: this.configPath }
  }

  async save(roi: unknown): Promise<ClockSearchAuthorState> {
    const config = parseBasicClockSearchConfig({ schemaVersion: 1, configured: true, roi })
    const operation = this.writes.then(() => this.writeOnce(config))
    this.writes = operation.catch(() => undefined)
    return operation
  }

  private async acquireLock() {
    const lockPath = this.configPath + '.author-lock'
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const lock = await open(lockPath, 'wx', 0o600)
        try { await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync() }
        catch (error) { await lock.close(); await rm(lockPath, { force: true }); throw error }
        return { lock, lockPath }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt !== 0) throw error
        const stat = await lstat(lockPath)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error('另一个制作工具正在写入配置, 请关闭后重试')
        let pid: unknown
        try { pid = (JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown }).pid } catch { /* Do not remove an unknown lock. */ }
        if (!Number.isSafeInteger(pid) || Number(pid) < 1) throw new Error('另一个制作工具正在写入配置, 请关闭后重试')
        let alive = true
        try { process.kill(Number(pid), 0) } catch (checkError) {
          alive = (checkError as NodeJS.ErrnoException).code !== 'ESRCH'
        }
        if (alive) throw new Error('另一个制作工具正在写入配置, 请关闭后重试')
        await rm(lockPath)
      }
    }
    throw new Error('无法取得生产配置写入权限')
  }

  private async writeOnce(config: BasicClockSearchConfig): Promise<ClockSearchAuthorState> {
    if (this.saved) throw new Error('本次制作已保存并锁定, 如需重新制作请使用 --reset')
    await this.checkTarget()
    const { lock, lockPath } = await this.acquireLock()
    const temporary = join(dirname(this.configPath), '.' + basename(this.configPath) + '.' + randomUUID() + '.tmp')
    try {
      const previous = await this.readConfig()
      if (previous.configured && !this.reset) throw new Error('寻找区间已经设定并锁定, 如需重新制作请使用 --reset')
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(config, null, 2) + '\n', 'utf8'); await file.sync() }
      finally { await file.close() }
      await this.checkTarget()
      await rename(temporary, this.configPath)
      this.saved = true
      return { config: parseBasicClockSearchConfig(config), writable: false, configPath: this.configPath }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
      await lock.close()
      await rm(lockPath, { force: true })
    }
  }
}

/** Narrow type for the isolated authoring preload. */
export interface ClockSearchAuthorApi {
  getState(): Promise<ClockSearchAuthorState>
  save(roi: RoiRect): Promise<ClockSearchAuthorState>
}
