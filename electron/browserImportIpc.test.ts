import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installBrowserImportIpc } from './browserImportIpc'
import { BrowserLoginImport } from './browserLoginImport'
import { BrowserImportFixtures } from './browserImportFixtures'
import type { WebContents } from 'electron'

describe('browser import IPC ownership', () => {
  it('only permits the primary application top frame and sanitizes all errors', async () => {
    const fixture = new BrowserImportFixtures(); fixture.enable('locked')
    const service = new BrowserLoginImport({ supported: true, discover: fixture.discover, read: fixture.read, verify: fixture.verify, write: async () => ({}) })
    const main = Object.assign(new EventEmitter(), { mainFrame: { url: 'app://app/' }, isDestroyed: () => false }) as unknown as WebContents
    const callbacks = new Map<string, (...args: any[]) => Promise<any>>()
    const ipc = { handle: vi.fn((channel, handler) => callbacks.set(channel, handler)), removeHandler: vi.fn() }
    const release = installBrowserImportIpc(ipc, main, service)
    const invoke = callbacks.get('stream-syncer:browser-import-invoke')!
    const event = { sender: main, senderFrame: main.mainFrame }
    expect(await invoke({ ...event, senderFrame: { url: 'app://app/' } }, 'listBrowserImportProfiles', undefined)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await invoke(event, 'listBrowserImportProfiles', undefined)).toMatchObject({ ok: true })
    const failure = await invoke(event, 'previewBrowserLogins', { requestId: 'a'.repeat(32), profileId: 'e'.repeat(32), platforms: ['douyu'] })
    expect(failure).toMatchObject({ ok: false, code: 'browser-import-browser-in-use' })
    expect(JSON.stringify(failure)).not.toContain('synthetic-session')
    expect(await invoke(event, 'importBrowserLogins', { cookies: 'arbitrary' })).toMatchObject({ ok: false, code: 'browser-import-invalid-request' })
    release(); expect(ipc.removeHandler).toHaveBeenCalledWith('stream-syncer:browser-import-invoke'); service.dispose()
  })
})
