import { describe, expect, it, vi } from 'vitest'
import { BrowserLoginImport } from './browserLoginImport'
import { BrowserImportFixtures } from './browserImportFixtures'
import { BrowserImportError } from './browserImportError'

const id = '1'.repeat(32)
function fixture() {
  const data = new BrowserImportFixtures(); data.enable('accounts')
  const write = vi.fn(async () => ({}))
  const service = new BrowserLoginImport({ supported: true, discover: data.discover, read: data.read, verify: data.verify, write })
  return { data, service, write, scan: () => service.scan({ requestId: id, profileId: 'e'.repeat(32), platforms: ['douyu', 'bilibili', 'huya', 'douyin', 'youtube'] }) }
}
describe('browser login import transactions', () => {
  it('returns only account previews and writes only selected, reverified accounts once', async () => {
    const f = fixture()
    const preview = await f.scan()
    expect(preview.accounts).toHaveLength(5)
    expect(JSON.stringify(preview)).not.toContain('synthetic-session')
    expect(JSON.stringify(preview)).not.toContain('synthetic-edge')
    const selected = preview.accounts.filter(account => ['douyu', 'youtube'].includes(account.platform)).map(account => account.id)
    const result = await f.service.apply({ previewId: preview.id, accountIds: selected })
    expect(result.outcomes).toMatchObject([{ platform: 'douyu', imported: true }, { platform: 'youtube', imported: true }])
    expect(f.write).toHaveBeenCalledTimes(2)
    expect(f.data.verifyCount).toBe(7)
    await expect(f.service.apply({ previewId: preview.id, accountIds: selected })).rejects.toMatchObject({ code: 'browser-import-preview-expired' })
    f.service.dispose()
  })
  it('retains successful platforms when another platform is unavailable or fails saving', async () => {
    const f = fixture(); f.data.enable('mixed')
    f.write.mockImplementationOnce(async () => { throw new BrowserImportError('browser-import-storage-failed') })
    const preview = await f.scan()
    expect(preview.accounts.find(account => account.platform === 'huya')?.state).toBe('signed-out')
    expect(preview.accounts.find(account => account.platform === 'douyin')?.state).toBe('unavailable')
    const result = await f.service.apply({ previewId: id, accountIds: preview.accounts.filter(account => account.state === 'ready').map(account => account.id) })
    expect(result.outcomes.map(item => item.imported)).toEqual([false, true, true])
    f.service.dispose()
  })
  it('erases preview cookies on cancellation and rejects forged targets, paths, accounts and expired previews', async () => {
    const f = fixture()
    const preview = await f.scan()
    await expect(f.service.apply({ previewId: id, accountIds: [preview.accounts[0]!.id], douyuTarget: { kind: 'existing', accountId: '../other' } }))
      .rejects.toMatchObject({ code: 'browser-import-invalid-request' })
    await expect(f.service.apply({ previewId: id, accountIds: ['f'.repeat(32)] })).rejects.toMatchObject({ code: 'browser-import-invalid-request' })
    expect(f.service.cancel(id)).toEqual({ cancelled: true })
    await expect(f.service.apply({ previewId: id, accountIds: [preview.accounts[0]!.id] })).rejects.toMatchObject({ code: 'browser-import-preview-expired' })
    expect(f.write).not.toHaveBeenCalled()
    await expect(f.service.scan({ requestId: id, profileId: '../Default', platforms: ['douyu'] })).rejects.toMatchObject({ code: 'browser-import-invalid-request' })
    f.service.dispose()
  })
  it('does not save a session if its verified identity changes after preview', async () => {
    const f = fixture()
    const preview = await f.scan()
    f.data.verify = vi.fn(async () => ({ uid: '84', username: 'another-account' }))
    // The supplied verifier delegates to the fixture method so identity can change at runtime.
    const verify = vi.fn().mockResolvedValueOnce({ uid: '42', username: 'original' }).mockResolvedValueOnce({ uid: '84', username: 'other' })
    const service = new BrowserLoginImport({ supported: true, discover: f.data.discover, read: f.data.read, verify, write: f.write })
    const fresh = await service.scan({ requestId: id, profileId: 'e'.repeat(32), platforms: ['douyu'] })
    const result = await service.apply({ previewId: id, accountIds: [fresh.accounts[0]!.id] })
    expect(result.outcomes[0]?.imported).toBe(false)
    expect(f.write).not.toHaveBeenCalled()
    expect(preview.accounts[0]?.state).toBe('ready')
    service.dispose(); f.service.dispose()
  })
  it('cancels a pending read and prevents any subsequent write', async () => {
    const f = fixture()
    let finish!: (result: { cookies: []; skipped: number }) => void
    const service = new BrowserLoginImport({ supported: true, discover: f.data.discover,
      read: () => new Promise(resolve => { finish = resolve }), verify: f.data.verify, write: f.write })
    const promise = service.scan({ requestId: id, profileId: 'e'.repeat(32), platforms: ['douyu'] })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    service.cancel(id); finish({ cookies: [], skipped: 0 })
    await expect(promise).rejects.toMatchObject({ code: 'browser-import-cancelled' })
    expect(f.write).not.toHaveBeenCalled()
    service.dispose(); f.service.dispose()
  })
  it('distinguishes failed authentication-cookie decryption from a signed-out Profile', async () => {
    const f = fixture()
    const service = new BrowserLoginImport({ supported: true, discover: f.data.discover,
      read: async () => ({ cookies: [], skipped: 2, decryptionFailedPlatforms: ['douyu'] }), verify: f.data.verify, write: f.write })
    const preview = await service.scan({ requestId: id, profileId: 'e'.repeat(32), platforms: ['douyu', 'huya'] })
    expect(preview.accounts[0]).toMatchObject({ platform: 'douyu', state: 'unavailable' })
    expect(preview.accounts[1]).toMatchObject({ platform: 'huya', state: 'signed-out' })
    expect(f.write).not.toHaveBeenCalled()
    service.dispose(); f.service.dispose()
  })
  it('expires unconsumed previews after five minutes without touching saved accounts', async () => {
    const f = fixture()
    let now = 1000
    const service = new BrowserLoginImport({ supported: true, discover: f.data.discover, read: f.data.read,
      verify: f.data.verify, write: f.write, now: () => now })
    const preview = await service.scan({ requestId: id, profileId: 'e'.repeat(32), platforms: ['douyu'] })
    now = preview.expiresAt + 1
    await expect(service.apply({ previewId: id, accountIds: [preview.accounts[0]!.id] }))
      .rejects.toMatchObject({ code: 'browser-import-preview-expired' })
    expect(f.write).not.toHaveBeenCalled()
    service.dispose(); f.service.dispose()
  })
})
