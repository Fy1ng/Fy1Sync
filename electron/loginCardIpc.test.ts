import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { installLoginCardIpc } from './loginCardIpc'
import type { LoginCardAction } from './loginCardContracts'

function setup() {
  let handler!: (event: IpcMainInvokeEvent, method: unknown, value: unknown) => Promise<unknown>
  const ipc = { handle: vi.fn((_channel: string, callback: typeof handler) => { handler = callback }), removeHandler: vi.fn() }
  const card = { mainFrame: { url: 'app://login/current-attempt/' } }
  let current: typeof card | null = card
  const controller = {
    ownsCard: vi.fn((sender: unknown, frame: unknown) => current === sender && frame === current?.mainFrame && current?.mainFrame.url === 'app://login/current-attempt/'),
    cardState: vi.fn(() => ({ platform: 'bilibili' as const, stage: 'form' as const, mode: 'password' as const, qr: { status: 'unavailable' as const }, sms: { canSend: false, cooldownSeconds: null }, busy: false })),
    cardAction: vi.fn(async (_action: LoginCardAction) => ({ ok: true })),
  }
  const release = installLoginCardIpc(ipc as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>, controller)
  const event = { sender: card, senderFrame: card.mainFrame } as unknown as IpcMainInvokeEvent
  return { ipc, controller, card, event, release, invoke: (event: IpcMainInvokeEvent, method: unknown, value?: unknown) => handler(event, method, value), retire: () => { current = null } }
}

describe('local card exact-owner credential IPC', () => {
  it('registers only the private channel and returns state only to the exact local top frame', async () => {
    const f = setup()
    expect(f.ipc.handle).toHaveBeenCalledWith('stream-syncer:login-card', expect.any(Function))
    expect(await f.invoke(f.event, 'state')).toMatchObject({ stage: 'form' })
    expect(await f.invoke(f.event, 'state', {})).toBeNull()
    expect(f.controller.cardState).toHaveBeenCalledOnce()
    f.release()
  })

  it('rejects remote, main, subframe and copied senders before validation or action execution', async () => {
    const f = setup()
    for (const value of [
      { sender: { mainFrame: { url: 'https://passport.bilibili.com/login' } }, senderFrame: { url: 'https://passport.bilibili.com/login' } },
      { sender: { mainFrame: { url: 'app://app/' } }, senderFrame: { url: 'app://app/' } },
      { sender: f.card, senderFrame: { url: f.card.mainFrame.url } },
      { sender: { ...f.card }, senderFrame: f.card.mainFrame },
      { sender: f.card, senderFrame: null },
    ]) expect(await f.invoke(value as unknown as IpcMainInvokeEvent, 'action', { kind: 'cancel' })).toMatchObject({ ok: false })
    expect(f.controller.cardAction).not.toHaveBeenCalled()
    expect(f.controller.cardState).not.toHaveBeenCalled()
    f.release()
  })

  it('dispatches one validated action and never executes unknown methods or URL-bearing payloads', async () => {
    const f = setup()
    expect(await f.invoke(f.event, 'action', { kind: 'mode', mode: 'sms' })).toEqual({ ok: true })
    expect(f.controller.cardAction).toHaveBeenCalledExactlyOnceWith({ kind: 'mode', mode: 'sms' })
    for (const [method, value] of [['fetch', { url: 'https://untrusted.test/' }], ['invoke', { kind: 'cancel' }], ['action', { kind: 'cancel', url: 'https://untrusted.test/' }],
      ['action', { kind: 'password', username: 'fixture', password: 'fixture-private', accepted: false }]]) expect(await f.invoke(f.event, method, value)).toMatchObject({ ok: false })
    expect(f.controller.cardAction).toHaveBeenCalledOnce()
    f.release()
  })

  it('rejects retired senders and handlers after disposal', async () => {
    const f = setup()
    f.retire()
    expect(await f.invoke(f.event, 'action', { kind: 'cancel' })).toMatchObject({ ok: false })
    f.release()
    expect(f.ipc.removeHandler).toHaveBeenCalledExactlyOnceWith('stream-syncer:login-card')
    expect(await f.invoke(f.event, 'state')).toMatchObject({ ok: false })
    expect(f.controller.cardAction).not.toHaveBeenCalled()
  })

  it('returns fixed failure wording when a controller exception echoes a submitted secret', async () => {
    const f = setup()
    f.controller.cardAction.mockRejectedValueOnce(new Error('password=fixture-private-secret'))
    const result = await f.invoke(f.event, 'action', { kind: 'password', username: 'fixture', password: 'fixture-private-secret', accepted: true })
    expect(result).toMatchObject({ ok: false, message: '登录操作未完成, 请重试.' })
    expect(JSON.stringify(result)).not.toContain('fixture-private-secret')
    f.release()
  })
})
