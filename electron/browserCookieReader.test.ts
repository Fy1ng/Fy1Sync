import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { browserCookieReader } from './browserCookieReader'
import type { DiscoveredBrowserProfile } from './browserProfiles'

const roots: string[] = []
const databases: DatabaseSync[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const root of roots.splice(0)) { if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe fixture'); await fs.rm(root, { recursive: true, force: true }) }
})
describe('Firefox browser Cookie reader', () => {
  it('reads live WAL rows, converts millisecond expiry, and excludes expired, isolated and unrelated cookies', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'firefox-reader-')); roots.push(directory)
    const file = path.join(directory, 'cookies.sqlite')
    const database = new DatabaseSync(file); databases.push(database)
    database.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=17; CREATE TABLE moz_cookies(host TEXT,name TEXT,value TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT)')
    const insert = database.prepare('INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?,?)')
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600) * 1000n
    insert.run('.bilibili.com', 'SESSDATA', 'synthetic-session', '/', expiry, 1, 1, 1, '')
    insert.run('.bilibili.com', 'DedeUserID', '42', '/', expiry, 1, 0, 1, '')
    insert.run('.bilibili.com', 'container', 'synthetic', '/', expiry, 1, 0, 0, '^userContextId=1')
    insert.run('.bilibili.com', 'expired', 'synthetic', '/', 1n, 1, 0, 0, '')
    insert.run('.bilibili.com', 'non_ascii', '中文值', '/', expiry, 1, 0, 0, '')
    insert.run('.notbilibili.com', 'SESSDATA', 'unrelated', '/', expiry, 1, 0, 0, '')
    const profile: DiscoveredBrowserProfile = { id: 'f'.repeat(32), browser: 'firefox', browserName: 'Firefox', name: 'test', isDefault: true, directory, database: file }
    const result = await browserCookieReader({ executable: 'not-used' })(profile, ['bilibili'], new AbortController().signal)
    expect(result.cookies).toHaveLength(2)
    expect(result.skipped).toBe(3)
    expect(result.cookies[0]).toMatchObject({ name: 'SESSDATA', httpOnly: true, secure: true,
      expirationDate: Number(expiry / 1000n), sameSite: 'lax', hostOnly: false })
    insert.run('.bilibili.com', 'LIVE', 'new-cookie', '/', expiry, 1, 0, 0, '')
    expect((await browserCookieReader({ executable: 'not-used' })(profile, ['bilibili'], new AbortController().signal)).cookies).toHaveLength(3)
    expect(database.prepare('SELECT COUNT(*) AS n FROM moz_cookies').get()?.n).toBe(7)
  })
  it('rejects cancelled reads before opening a browser database', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(browserCookieReader({ executable: 'unused' })({} as DiscoveredBrowserProfile, ['youtube'], controller.signal))
      .rejects.toMatchObject({ code: 'browser-import-cancelled' })
  })
})
