import { describe, expect, it, vi } from 'vitest'
import { BrowserLoginImport } from './browserLoginImport'
import { BrowserImportFixtures } from './browserImportFixtures'
import { BrowserImportError } from './browserImportError'

const id = '1'.repeat(32)
function fixture() {
  const data = new BrowserImportFixtures(); data.enable('accounts')
  const write = vi.fn(async () => ({}))
  const service = new BrowserLoginImport({ supported: true, discover: data.discover, closeBrowser: data.closeBrowser, read: data.read, verify: data.verify, write })
  return { data, service, write, scan: () => service.scan({ requestId: id, profileId: 'e'.repeat(32), platforms: ['douyu', 'bilibili', 'huya', 'douyin', 'youtube'] }) }
}
describe('browser login import transactions', () => {
  it('returns one cancelled outcome per selection when cancelled before the first write', async () => {
    const context = fixture()
    const preview = await context.scan()
    const pending = context.service.apply({ previewId: id, accountIds: preview.accounts.map(account => account.id) })
    context.service.cancel(id)
    const result = await pending
    expect(result.outcomes).toHaveLength(5)
    expect(result.outcomes.every(outcome => !outcome.imported && outcome.message === '已取消，未导入')).toBe(true)
    expect(context.write).not.toHaveBeenCalled()
    context.service.dispose()
  })

  it('retains a completed write and stops every remaining item on cancellation', async () => {
    const context = fixture()
    const preview = await context.scan()
    context.write.mockImplementationOnce(async () => { context.service.cancel(id); return { accountId: 'default' } })
    const result = await context.service.apply({ previewId: id, accountIds: preview.accounts.map(account => account.id) })
    expect(result.outcomes[0]).toMatchObject({ platform: 'douyu', imported: true, accountId: 'default' })
    expect(result.outcomes.slice(1)).toHaveLength(4)
    expect(result.outcomes.slice(1).every(outcome => !outcome.imported && outcome.message === '已取消，未导入')).toBe(true)
    expect(context.write).toHaveBeenCalledOnce()
    context.service.dispose()
  })

  it('keeps in-flight cookie values until a write settles and reports its committed result', async () => {
    const context = fixture()
    let finish!: () => void
    let captured: import('./cookies').BrowserCookie[] = []
    const write: import('./browserLoginImport').BrowserLoginImportOptions['write'] = vi.fn(async (_platform, cookies) => {
      captured = cookies
      await new Promise<void>(resolve => { finish = resolve })
      return { accountId: 'default' }
    })
    const service = new BrowserLoginImport({ supported: true, discover: context.data.discover, read: context.data.read, verify: context.data.verify, write })
    const preview = await service.scan({ requestId: id, profileId: 'e'.repeat(32), platforms: ['douyu', 'youtube'] })
    const pending = service.apply({ previewId: id, accountIds: preview.accounts.map(account => account.id) })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    service.cancel(id)
    expect(captured.every(cookie => cookie.value.length > 0)).toBe(true)
    finish()
    const result = await pending
    expect(result.outcomes).toMatchObject([{ platform: 'douyu', imported: true }, { platform: 'youtube', imported: false, message: '已取消，未导入' }])
    expect(captured.every(cookie => cookie.value === '')).toBe(true)
    expect(write).toHaveBeenCalledOnce()
    service.dispose(); context.service.dispose()
  })

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
  it('closes the resolved browser profile, guards concurrent operations, and rejects forged requests', async () => {
    const f = fixture()
    f.data.enable('locked')
    await expect(f.service.closeBrowser({ requestId: id, profileId: '../Edge' }))
      .rejects.toMatchObject({ code: 'browser-import-invalid-request' })
    await expect(f.service.closeBrowser({ requestId: id, profileId: 'a'.repeat(32) }))
      .rejects.toMatchObject({ code: 'browser-import-profile-missing' })
    expect(await f.service.closeBrowser({ requestId: id, profileId: 'e'.repeat(32) }))
      .toEqual({ status: 'closed', browserName: 'Microsoft Edge' })
    expect(f.data.closedBrowsers).toEqual(['Microsoft Edge'])
    const preview = await f.scan()
    expect(preview.accounts).toHaveLength(5)
    f.service.dispose()
  })
  it('cancels an in-flight browser close operation', async () => {
    const f = fixture()
    let finish!: (value: { status: 'closed'; browserName: string }) => void
    const service = new BrowserLoginImport({
      supported: true,
      discover: f.data.discover,
      closeBrowser: (_profile, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new BrowserImportError('browser-import-cancelled')), { once: true })
        finish = resolve
      }),
      read: f.data.read,
      verify: f.data.verify,
      write: f.write,
    })
    const pending = service.closeBrowser({ requestId: id, profileId: 'e'.repeat(32) })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await expect(service.closeBrowser({ requestId: '2'.repeat(32), profileId: 'e'.repeat(32) }))
      .rejects.toMatchObject({ code: 'browser-import-busy' })
    expect(service.cancel(id)).toEqual({ cancelled: true })
    await expect(pending).rejects.toMatchObject({ code: 'browser-import-cancelled' })
    service.dispose(); f.service.dispose()
  })

  it('forwards matched Douyin signing material on import and erases it after apply or cancel', async () => {
    const f = fixture()
    let receivedCrypt = ''
    let snapshotRef: import('../server/douyin/signingMaterial').DouyinSigningSnapshot | null | undefined
    const write: import('./browserLoginImport').BrowserLoginImportOptions['write'] = vi.fn(async (_platform, _cookies, _identity, _target, _signal, options) => {
      snapshotRef = options?.douyinSigning
      receivedCrypt = options?.douyinSigning?.cryptData ?? ''
      return { signingReady: Boolean(options?.douyinSigning) }
    })
    const service = new BrowserLoginImport({
      supported: true, discover: f.data.discover, read: f.data.read, verify: f.data.verify, write,
    })
    const preview = await service.scan({ requestId: id, profileId: 'e'.repeat(32), platforms: ['douyin'] })
    expect(JSON.stringify(preview)).not.toMatch(/PRIVATE KEY|synthetic-ticket/)
    const result = await service.apply({ previewId: id, accountIds: [preview.accounts[0]!.id] })
    expect(receivedCrypt).toContain('PRIVATE KEY')
    expect(result.outcomes).toEqual([
      { platform: 'douyin', imported: true, username: '测试抖音账号', signingReady: true, message: '已导入账号' },
    ])
    expect(snapshotRef?.cryptData).toBe('')
    expect(snapshotRef?.serverData).toBe('')
    service.dispose(); f.service.dispose()
  })
})
