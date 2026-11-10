import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { installEmbeddedLoginIpc } from './embeddedLoginIpc'

describe('login-card IPC ownership', () => {
  it('rejects remote frames and other app windows, then checks exact argument shapes', async () => {
    let handler!: (event: IpcMainInvokeEvent, method: unknown, args: unknown) => Promise<unknown>
    const ipc = { handle: vi.fn((_channel, value) => { handler = value }), removeHandler: vi.fn() }
    const owner = { mainFrame: { url: 'app://app/' }, isDestroyed: () => false, send: vi.fn() }
    const controller = { state: vi.fn(() => null), subscribe: vi.fn(() => vi.fn()), setViewport: vi.fn(), cancel: vi.fn(async () => {}), retry: vi.fn(async () => {}), back: vi.fn(async () => {}) }
    const release = installEmbeddedLoginIpc(ipc as unknown as IpcMain, owner as unknown as WebContents, controller)
    const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent
    expect(await handler({ ...event, senderFrame: { url: 'https://passport.bilibili.com/login' } } as IpcMainInvokeEvent, 'getEmbeddedLogin', undefined))
      .toMatchObject({ ok: false, code: 'forbidden' })
    expect(await handler({ ...event, sender: { ...owner } } as unknown as IpcMainInvokeEvent, 'getEmbeddedLogin', undefined)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await handler(event, 'getEmbeddedLogin', {})).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(await handler(event, 'getEmbeddedLogin', undefined)).toEqual({ ok: true, value: null })
    expect(await handler(event, 'setEmbeddedLoginViewport', { url: 'https://evil.test' })).toMatchObject({ ok: false, code: 'invalid-arguments' })
    const id = 'bba6003a-b1d2-4fe4-a712-5dd84a358c1f'
    expect(await handler(event, 'cancelEmbeddedLogin', { id })).toEqual({ ok: true, value: { ok: true } })
    expect(controller.cancel).toHaveBeenCalledWith(id)
    release()
    expect(await handler(event, 'getEmbeddedLogin', undefined)).toMatchObject({ ok: false, code: 'forbidden' })
  })
})
