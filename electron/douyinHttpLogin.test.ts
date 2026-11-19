import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import type { BrowserCookie } from './cookies'
import type { EmbeddedLoginRequest } from './embeddedLoginContracts'
import type { LoginCardAction, LoginCardState } from './loginCardContracts'
import type { LocalLoginCard, LoginCardViewOptions } from './loginCardView'
import type { DouyinHttpLoginSession, DouyinHttpLoginStep, DouyinHttpQr } from '../server/douyin/httpLoginContracts'

vi.mock('electron', () => ({ session: {}, WebContentsView: class {} }))
import { DouyinHttpLoginController } from './douyinHttpLogin'

const controllers: DouyinHttpLoginController[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-12T01:00:00Z')) })
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.dispose()))
  vi.useRealTimers()
  vi.restoreAllMocks()
})
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve() }
const cookies: BrowserCookie[] = [{ name: 'sessionid', value: 'synthetic-session', domain: '.douyin.com', path: '/', secure: true, httpOnly: true, session: true }]
function setup(options: { pollMs?: number; timeoutMs?: number } = {}) {
  const ownerContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: 'app://app/' }, isDestroyed: vi.fn(() => false), getZoomFactor: () => 1.25,
  })
  const owner = Object.assign(new EventEmitter(), { webContents: ownerContents, isDestroyed: vi.fn(() => false), getContentSize: () => [1000, 700] })
  const cardContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, isDestroyed: vi.fn(() => false) })
  const card = { url: '', contents: cardContents, open: vi.fn(async () => {}), publish: vi.fn<(value: LoginCardState) => void>(),
    setBounds: vi.fn(), hide: vi.fn(), close: vi.fn(async () => {}) }
  const session = {
    initialize: vi.fn(async () => ({ image: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: Date.now() + 60_000 })),
    refreshQr: vi.fn(async () => ({ image: 'data:image/png;base64,iVBORw0KGgoAAA==', expiresAt: Date.now() + 60_000 })),
    poll: vi.fn(async (): Promise<DouyinHttpLoginStep> => ({ status: 'waiting' })),
    sendSms: vi.fn(async (): Promise<DouyinHttpLoginStep> => ({ status: 'sms-sent', cooldownSeconds: 60 })),
    loginSms: vi.fn(async (): Promise<DouyinHttpLoginStep> => ({ status: 'waiting' })),
    loginPassword: vi.fn(async (): Promise<DouyinHttpLoginStep> => ({ status: 'waiting' })), dispose: vi.fn(),
  }
  const signals: AbortSignal[] = []
  const createSession = vi.fn((signal: AbortSignal): DouyinHttpLoginSession => { signals.push(signal); return session })
  const createCard = vi.fn((value: LoginCardViewOptions) => {
    card.url = `app://login/${value.id}/`
    cardContents.mainFrame.url = card.url
    return card as unknown as LocalLoginCard
  })
  const controller = new DouyinHttpLoginController({ owner: () => owner as unknown as BrowserWindow, cardPreload: '/synthetic/card.cjs',
    createCard, createSession, pollMs: options.pollMs ?? 20, timeoutMs: options.timeoutMs ?? 20_000 })
  controllers.push(controller)
  const begin = (patch: Partial<EmbeddedLoginRequest> = {}) => {
    const result = controller.login({ platform: 'douyin', signal: new AbortController().signal, ...patch })
    void result.catch(() => {})
    return result
  }
  return { controller, card, cardContents, owner, ownerContents, session, signals, createCard, createSession, begin }
}

describe('local HTTP Douyin login controller', () => {
  it('starts a fresh session when manually refreshing after initialization failed, and removes stale diagnostics', async () => {
    const f = setup()
    f.session.initialize.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BOOTSTRAP'), {
      code: 'douyin-http-login-network-unavailable', networkCode: 'dns-failed', requestStage: 'bootstrap',
    }))
    f.begin(); await flush()
    expect(f.controller.cardState()).toMatchObject({ stage: 'failed', errorDetail: { requestStage: 'bootstrap', networkCode: 'dns-failed' } })
    expect(f.controller.cardState()?.message).toContain('域名解析失败')
    expect(await f.controller.cardAction({ kind: 'refresh-qr' })).toEqual({ ok: true })
    expect(f.signals[0]!.aborted).toBe(true)
    expect(f.createSession).toHaveBeenCalledTimes(2)
    expect(f.session.initialize).toHaveBeenCalledTimes(2)
    expect(f.session.refreshQr).not.toHaveBeenCalled()
    expect(f.controller.cardState()).toMatchObject({ stage: 'form', errorDetail: undefined, message: undefined })
    expect(f.session.sendSms).not.toHaveBeenCalled()
    expect(f.session.loginPassword).not.toHaveBeenCalled()
  })

  it.each([
    { fields: { code: 'douyin-http-login-rejected', platformCode: 1101 }, text: '抖音未接受此次登录' },
    { fields: { code: 'douyin-http-login-rejected', httpStatus: 403 }, text: '抖音暂时无法完成登录' },
    { fields: { code: 'douyin-http-login-receipt-invalid' }, text: '结果不完整' },
  ])('shows $text consistently in the card and action result without suggesting a network failure', async ({ fields, text }) => {
    const f = setup({ pollMs: 5200 })
    f.begin(); await flush()
    f.session.loginPassword.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_PASSWORD'), { ...fields, requestStage: 'password-login' }))
    const result = await f.controller.cardAction({ kind: 'password', username: 'synthetic-user', password: 'PRIVATE_PASSWORD', accepted: true })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(text)
    expect(result.message).not.toContain('检查网络')
    expect(f.controller.cardState()?.message).toBe(result.message)
    expect(result.detail).toMatchObject({ ...fields, requestStage: 'password-login' })
    await vi.advanceTimersByTimeAsync(10_400)
    expect(f.session.loginPassword).toHaveBeenCalledOnce()
    expect(JSON.stringify([result, f.controller.state(), f.card.publish.mock.calls])).not.toContain('PRIVATE_PASSWORD')
  })

  it('keeps the original QR across transient read failures but stops retrying rejected HTTP requests', async () => {
    const f = setup({ pollMs: 5200 })
    f.session.poll.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_NETWORK'), { code: 'douyin-http-login-timeout', requestStage: 'poll' }))
    f.begin(); await flush(); await vi.advanceTimersByTimeAsync(5200)
    expect(f.controller.cardState()?.stage).toBe('form')
    expect(f.controller.cardState()?.message).toContain('扫码状态超时')
    expect(f.session.refreshQr).not.toHaveBeenCalled()
    f.session.poll.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_HTTP'), { code: 'douyin-http-login-rejected', httpStatus: 403, requestStage: 'poll' }))
    await vi.advanceTimersByTimeAsync(5200)
    expect(f.controller.cardState()?.stage).toBe('failed')
    expect(f.controller.cardState()?.message).toContain('抖音暂时无法完成登录')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.session.poll).toHaveBeenCalledTimes(2)
  })

  it('preserves an uncertain SMS cooldown while rebuilding a failed QR session', async () => {
    const f = setup({ pollMs: 5200 })
    f.begin(); await flush()
    f.session.sendSms.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_SMS'), { code: 'douyin-http-login-receipt-invalid', nextAllowedAt: Date.now() + 60_000 }))
    await f.controller.cardAction({ kind: 'prepare-sms', countryCode: '+86', phone: '13800000000', accepted: true })
    await f.controller.cardAction({ kind: 'send-sms', countryCode: '+86', phone: '13800000000', accepted: true })
    f.session.poll.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_POLL'), { code: 'douyin-http-login-rejected', httpStatus: 403 }))
    await vi.advanceTimersByTimeAsync(5200)
    expect(f.controller.cardState()?.stage).toBe('failed')
    await f.controller.cardAction({ kind: 'refresh-qr' })
    await f.controller.cardAction({ kind: 'prepare-sms', countryCode: '+86', phone: '13800000000', accepted: true })
    expect(f.controller.cardState()?.sms.cooldownSeconds).toBe(55)
    expect(f.controller.cardState()?.sms.canSend).toBe(false)
    expect((await f.controller.cardAction({ kind: 'send-sms', countryCode: '+86', phone: '13800000000', accepted: true })).ok).toBe(false)
    expect(f.session.sendSms).toHaveBeenCalledOnce()
  })

  it('stops rejected QR polling without regenerating tokens or leaking an upstream error', async () => {
    const f = setup()
    f.session.poll.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_TEST_SECRET'), { code: 'douyin-http-login-rejected', platformCode: 4031 }))
    f.begin(); await flush(); await vi.advanceTimersByTimeAsync(20)
    expect(f.controller.state()).toMatchObject({ phase: 'failed', errorDetail: { platformCode: 4031 } })
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.session.poll).toHaveBeenCalledOnce()
    expect(f.session.refreshQr).not.toHaveBeenCalled()
    expect(JSON.stringify(f.card.publish.mock.calls)).not.toContain('PRIVATE_TEST_SECRET')
  })

  it('keeps a reported SMS uncertainty cooldown without automatically repeating the write', async () => {
    const f = setup({ pollMs: 5200 })
    f.session.sendSms.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_TEST_SECRET'), { code: 'douyin-http-login-receipt-invalid', nextAllowedAt: Date.now() + 60000 }))
    f.begin(); await flush()
    await f.controller.cardAction({ kind: 'prepare-sms', countryCode: '+86', phone: '13800000000', accepted: true })
    await f.controller.cardAction({ kind: 'send-sms', countryCode: '+86', phone: '13800000000', accepted: true })
    expect(f.controller.cardState()?.sms).toMatchObject({ canSend: false, cooldownSeconds: 60 })
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.session.sendSms).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.card.publish.mock.calls)).not.toContain('PRIVATE_TEST_SECRET')
  })

  it('opens only the local card immediately and keeps it loading until session initialization', async () => {
    const f = setup(), ready = deferred<Awaited<ReturnType<DouyinHttpLoginSession['initialize']>>>()
    f.session.initialize.mockReturnValue(ready.promise)
    f.begin()
    expect(f.card.open).toHaveBeenCalledOnce()
    expect(f.controller.state()).toMatchObject({ phase: 'loading', presentation: 'form' })
    expect(f.controller.cardState()).toMatchObject({ transport: 'http', stage: 'loading' })
    await flush()
    expect(f.session.initialize).toHaveBeenCalledOnce()
    expect(f.session.poll).not.toHaveBeenCalled()
    ready.resolve({ image: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: Date.now() + 60_000 })
    await flush()
    expect(f.controller.cardState()).toMatchObject({ stage: 'form', qr: { status: 'ready' } })
    expect(f.card.url).toMatch(/^app:\/\/login\//)
    expect(f.card.publish).toHaveBeenCalled()
  })

  it('polls at 5.2 seconds by default and never overlaps reads', async () => {
    const f = setup({ pollMs: 5200 }), pending = deferred<DouyinHttpLoginStep>()
    f.session.poll.mockReturnValueOnce(pending.promise)
    f.begin(); await flush()
    await vi.advanceTimersByTimeAsync(5199)
    expect(f.session.poll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.session.poll).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5200)
    expect(f.session.poll).toHaveBeenCalledOnce()
    pending.resolve({ status: 'scanned' }); await flush()
    expect(f.controller.cardState()?.qr.status).toBe('scanned')
    await vi.advanceTimersByTimeAsync(5200)
    expect(f.session.poll).toHaveBeenCalledTimes(2)
  })

  it('serializes manual QR refresh behind a pending read and discards its old authentication result', async () => {
    const f = setup(), old = deferred<DouyinHttpLoginStep>()
    f.session.poll.mockReturnValueOnce(old.promise)
    const capture = vi.fn(async () => {}), result = f.begin({ captureDouyinSigning: capture })
    await flush(); await vi.advanceTimersByTimeAsync(20)
    const refreshed = f.controller.cardAction({ kind: 'refresh-qr' })
    expect(f.controller.cardState()?.qr.status).toBe('loading')
    await flush()
    expect(f.session.refreshQr).not.toHaveBeenCalled()
    old.resolve({ status: 'authenticated', uid: '1001', cookies, snapshot: null }); await flush()
    await expect(refreshed).resolves.toEqual({ ok: true })
    expect(f.session.refreshQr).toHaveBeenCalledOnce()
    expect(capture).not.toHaveBeenCalled()
    expect(f.controller.cardState()?.qr.image).toBe('data:image/png;base64,iVBORw0KGgoAAA==')
    const settled = vi.fn(); void result.then(settled, () => {})
    await flush(); expect(settled).not.toHaveBeenCalled()
  })

  it('keeps App verification on the same QR and never sends SMS automatically', async () => {
    const f = setup()
    f.session.poll.mockResolvedValueOnce({ status: 'verification-required', message: 'synthetic unsafe token' })
    f.begin(); await flush(); await vi.advanceTimersByTimeAsync(20)
    expect(f.controller.cardState()).toMatchObject({ stage: 'form', qr: { status: 'scanned' }, busy: false })
    expect(f.controller.state()?.message).toContain('抖音 App')
    await vi.advanceTimersByTimeAsync(80)
    expect(f.session.sendSms).not.toHaveBeenCalled()
    expect(f.session.refreshQr).not.toHaveBeenCalled()
    expect(f.session.initialize).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.card.publish.mock.calls)).not.toContain('synthetic unsafe token')
  })

  it('changes modes and prepares SMS locally, then sends only once per explicit click with a server cooldown', async () => {
    const f = setup(); f.begin(); await flush()
    await expect(f.controller.cardAction({ kind: 'mode', mode: 'sms' })).resolves.toEqual({ ok: true })
    expect(f.session.sendSms).not.toHaveBeenCalled()
    const prepare: LoginCardAction = { kind: 'prepare-sms', phone: '13800000000', countryCode: '+86', accepted: true }
    await expect(f.controller.cardAction(prepare)).resolves.toEqual({ ok: true })
    expect(prepare).toMatchObject({ phone: '', countryCode: '' })
    expect(f.controller.cardState()?.sms.canSend).toBe(true)
    const action: LoginCardAction = { kind: 'send-sms', phone: '13800000000', countryCode: '+86', accepted: true }
    await expect(f.controller.cardAction(action)).resolves.toEqual({ ok: true })
    expect(f.session.sendSms).toHaveBeenCalledExactlyOnceWith({ phone: '13800000000', countryCode: '+86' })
    expect(action).toMatchObject({ phone: '', countryCode: '' })
    await expect(f.controller.cardAction({ kind: 'send-sms', phone: '13800000000', countryCode: '+86', accepted: true })).resolves.toMatchObject({ ok: false })
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.controller.cardState()?.sms.cooldownSeconds).toBe(58)
    expect(f.session.sendSms).toHaveBeenCalledOnce()
    expect(JSON.stringify([f.controller.state(), f.card.publish.mock.calls])).not.toContain('13800000000')
  })

  it('calls password and SMS login once and removes secrets after errors without echoing error contents', async () => {
    const f = setup(); f.begin(); await flush()
    f.session.loginPassword.mockRejectedValue(new Error('secret-password 13800000000 123456'))
    const password: LoginCardAction = { kind: 'password', username: 'synthetic-user', password: 'secret-password', accepted: true }
    expect((await f.controller.cardAction(password)).ok).toBe(false)
    expect(f.session.loginPassword).toHaveBeenCalledExactlyOnceWith({ username: 'synthetic-user', password: 'secret-password' })
    expect(password).toMatchObject({ username: '', password: '' })
    f.session.loginSms.mockRejectedValue(new Error('123456'))
    const sms: LoginCardAction = { kind: 'sms', phone: '13800000000', countryCode: '+86', code: '123456', accepted: true }
    expect((await f.controller.cardAction(sms)).ok).toBe(false)
    expect(f.session.loginSms).toHaveBeenCalledExactlyOnceWith({ phone: '13800000000', countryCode: '+86', code: '123456' })
    expect(sms).toMatchObject({ phone: '', code: '', countryCode: '' })
    const output = JSON.stringify([f.controller.state(), f.card.publish.mock.calls])
    for (const secret of ['secret-password', 'synthetic-user', '13800000000', '123456']) expect(output).not.toContain(secret)
  })

  it('rejects duplicate submissions while serializing a user action behind an in-flight poll', async () => {
    const f = setup(), old = deferred<DouyinHttpLoginStep>(), submitted = deferred<DouyinHttpLoginStep>()
    f.session.poll.mockReturnValueOnce(old.promise)
    f.session.loginPassword.mockReturnValueOnce(submitted.promise)
    f.begin(); await flush(); await vi.advanceTimersByTimeAsync(20)
    const first: LoginCardAction = { kind: 'password', username: 'user', password: 'secret', accepted: true }
    const work = f.controller.cardAction(first)
    const duplicate: LoginCardAction = { kind: 'password', username: 'user', password: 'secret', accepted: true }
    expect((await f.controller.cardAction(duplicate)).ok).toBe(false)
    expect(duplicate.password).toBe('')
    expect(f.session.loginPassword).not.toHaveBeenCalled()
    old.resolve({ status: 'expired' }); await flush()
    expect(f.session.loginPassword).toHaveBeenCalledOnce()
    submitted.resolve({ status: 'waiting' }); await work
    expect(first.password).toBe('')
    expect(f.controller.cardState()?.qr.status).toBe('ready')
  })

  it('accepts only a session-authenticated identity and awaits signing capture before returning cookies', async () => {
    const f = setup(), captured = deferred<void>()
    const snapshot = { synthetic: true } as unknown as NonNullable<Extract<DouyinHttpLoginStep, { status: 'authenticated' }>['snapshot']>
    f.session.poll.mockResolvedValue({ status: 'authenticated', uid: '1001', cookies, snapshot })
    const capture = vi.fn(() => captured.promise), result = f.begin({ captureDouyinSigning: capture })
    const finished = vi.fn(); void result.then(finished)
    await flush(); await vi.advanceTimersByTimeAsync(20)
    expect(capture).toHaveBeenCalledExactlyOnceWith(snapshot)
    expect(finished).not.toHaveBeenCalled()
    expect(f.controller.cardState()?.stage).toBe('checking')
    captured.resolve(); await flush()
    await expect(result).resolves.toEqual(cookies)
    expect(f.session.dispose).toHaveBeenCalledOnce()
    expect(f.card.close).toHaveBeenCalledOnce()
    expect(f.controller.state()).toBeNull()
  })

  it('rejects authenticated responses without live-usable cookies and never treats an unknown HTTP-shaped step as success', async () => {
    const f = setup()
    f.session.poll.mockResolvedValueOnce({ status: 'authenticated', uid: '1001', cookies: [], snapshot: null })
    const result = f.begin(), finished = vi.fn(); void result.then(finished, () => {})
    await flush(); await vi.advanceTimersByTimeAsync(20)
    expect(f.controller.state()?.phase).toBe('failed')
    expect(finished).not.toHaveBeenCalled()
    await f.controller.retry(f.controller.state()!.id)
    f.session.poll.mockResolvedValueOnce({ status: 200 } as unknown as DouyinHttpLoginStep)
    await vi.advanceTimersByTimeAsync(20)
    expect(f.controller.state()?.phase).toBe('failed')
    expect(finished).not.toHaveBeenCalled()
  })

  it('fails signing capture safely without resolving or repeatedly retrying it in the background', async () => {
    const f = setup()
    const snapshot = { synthetic: true } as unknown as NonNullable<Extract<DouyinHttpLoginStep, { status: 'authenticated' }>['snapshot']>
    f.session.poll.mockResolvedValue({ status: 'authenticated', uid: '1001', cookies, snapshot })
    const capture = vi.fn(async () => { throw new Error('synthetic-private-signing-secret') })
    const result = f.begin({ captureDouyinSigning: capture }), settled = vi.fn(); void result.then(settled, () => {})
    await flush(); await vi.advanceTimersByTimeAsync(20)
    expect(f.controller.state()?.phase).toBe('failed')
    expect(f.controller.cardState()?.busy).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(capture).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()
    expect(JSON.stringify(f.card.publish.mock.calls)).not.toContain('synthetic-private-signing-secret')
  })

  it('discards authentication when cancelled while signing capture is pending', async () => {
    const f = setup(), captured = deferred<void>()
    const snapshot = { synthetic: true } as unknown as NonNullable<Extract<DouyinHttpLoginStep, { status: 'authenticated' }>['snapshot']>
    f.session.poll.mockResolvedValue({ status: 'authenticated', uid: '1001', cookies, snapshot })
    const result = f.begin({ captureDouyinSigning: () => captured.promise })
    await flush(); await vi.advanceTimersByTimeAsync(20)
    await f.controller.cancel(f.controller.state()!.id)
    await expect(result).rejects.toMatchObject({ code: 'login-cancelled' })
    captured.resolve(); await flush()
    expect(f.controller.state()).toBeNull()
    expect(f.card.close).toHaveBeenCalledOnce()
  })

  it('keeps owner navigation cancellation active until successful card cleanup finishes', async () => {
    const f = setup(), closed = deferred<void>()
    f.card.close.mockReturnValue(closed.promise)
    f.session.poll.mockResolvedValue({ status: 'authenticated', uid: '1001', cookies, snapshot: null })
    const result = f.begin()
    await flush(); await vi.advanceTimersByTimeAsync(20)
    expect(f.card.close).toHaveBeenCalledOnce()
    expect(f.controller.state()).toBeNull()
    f.ownerContents.emit('will-navigate')
    closed.resolve(); await flush()
    await expect(result).rejects.toMatchObject({ code: 'login-cancelled' })
    expect(f.ownerContents.listenerCount('will-navigate')).toBe(0)
  })

  it('retains a token through read errors and automatically replaces an expired QR without reopening the form', async () => {
    const f = setup()
    f.session.poll.mockRejectedValueOnce(Object.assign(new Error('synthetic credential-bearing detail'), { code: 'douyin-http-login-network-unavailable' }))
    f.session.poll.mockResolvedValueOnce({ status: 'expired' })
    f.begin(); await flush(); await vi.advanceTimersByTimeAsync(40)
    expect(f.controller.cardState()?.qr.status).toBe('ready')
    expect(f.controller.cardState()?.stage).toBe('form')
    expect(f.session.poll).toHaveBeenCalledTimes(2)
    expect(f.session.refreshQr).toHaveBeenCalledOnce()
    expect(f.session.initialize).toHaveBeenCalledOnce()
    expect(f.createCard).toHaveBeenCalledOnce()
    expect(f.card.close).not.toHaveBeenCalled()
    expect(f.card.publish.mock.calls.slice(1).some(([state])=>state.message?.includes('二维码已过期'))).toBe(false)
    expect((await f.controller.cardAction({ kind: 'refresh-qr' })).ok).toBe(true)
    expect(f.controller.cardState()?.qr.status).toBe('ready')
  })

  it('keeps local modes and SMS preparation usable while an automatic QR read is pending', async () => {
    const f=setup(), refreshed=deferred<DouyinHttpQr>()
    f.session.poll.mockResolvedValueOnce({status:'expired'})
    f.session.refreshQr.mockReturnValueOnce(refreshed.promise)
    f.begin(); await flush()
    await f.controller.cardAction({kind:'mode',mode:'sms'})
    await vi.advanceTimersByTimeAsync(20)
    expect(f.controller.cardState()).toMatchObject({stage:'form',mode:'sms',busy:false,qr:{status:'loading'}})
    expect((await f.controller.cardAction({kind:'prepare-sms',phone:'13800000000',countryCode:'+86',accepted:true})).ok).toBe(true)
    expect((await f.controller.cardAction({kind:'mode',mode:'password'})).ok).toBe(true)
    refreshed.resolve({image:'data:image/png;base64,iVBORw0KGgoAAA==',expiresAt:Date.now()+60_000})
    await flush()
    expect(f.controller.cardState()).toMatchObject({stage:'form',mode:'password',qr:{status:'ready'}})
    expect(f.session.sendSms).not.toHaveBeenCalled()
    expect(f.session.loginPassword).not.toHaveBeenCalled()
  })

  it('retries a failed automatic QR read locally while retaining the last account error', async () => {
    const f=setup()
    f.begin(); await flush()
    f.session.loginPassword.mockRejectedValueOnce(Object.assign(new Error('PRIVATE'),{code:'douyin-http-login-rejected',platformCode:2156}))
    await f.controller.cardAction({kind:'password',username:'synthetic',password:'synthetic',accepted:true})
    const originalMessage=f.controller.cardState()?.message
    f.session.poll.mockResolvedValueOnce({status:'expired'})
    f.session.refreshQr.mockRejectedValueOnce(Object.assign(new Error('PRIVATE'),{code:'douyin-http-login-network-unavailable'}))
    await vi.advanceTimersByTimeAsync(20)
    expect(f.controller.cardState()).toMatchObject({stage:'form',message:originalMessage,qr:{status:'unavailable'}})
    await vi.advanceTimersByTimeAsync(20)
    expect(f.controller.cardState()).toMatchObject({stage:'form',message:originalMessage,qr:{status:'ready'}})
    expect(f.session.refreshQr).toHaveBeenCalledTimes(2)
    expect(f.session.initialize).toHaveBeenCalledOnce()
    expect(f.session.loginPassword).toHaveBeenCalledOnce()
  })

  it('does not replace a scanned QR just because its local expiry time passed', async () => {
    const f=setup({pollMs:5200,timeoutMs:300_000})
    f.session.poll.mockResolvedValueOnce({status:'scanned'})
    f.begin(); await flush(); await vi.advanceTimersByTimeAsync(62_400)
    expect(f.session.refreshQr).not.toHaveBeenCalled()
    expect(f.controller.cardState()?.qr.status).toBe('scanned')
  })

  it('discards a late automatic replacement when the login is cancelled', async () => {
    const f=setup(), refreshed=deferred<DouyinHttpQr>()
    f.session.poll.mockResolvedValueOnce({status:'expired'})
    f.session.refreshQr.mockReturnValueOnce(refreshed.promise)
    const result=f.begin(); await flush(); await vi.advanceTimersByTimeAsync(20)
    const id=f.controller.state()!.id
    await f.controller.cancel(id)
    await expect(result).rejects.toMatchObject({code:'login-cancelled'})
    const count=f.card.publish.mock.calls.length
    refreshed.resolve({image:'data:image/png;base64,iVBORw0KGgoAAA==',expiresAt:Date.now()+60_000})
    await flush()
    expect(f.card.publish.mock.calls).toHaveLength(count)
    expect(f.card.close).toHaveBeenCalledOnce()
    expect(f.controller.state()).toBeNull()
  })

  it.each(['request-abort', 'owner-navigation', 'owner-destroyed', 'card-destroyed', 'timeout'] as const)(
    'cancels %s, aborts the session and discards its late authenticated result', async reason => {
      const f = setup({ timeoutMs: 100 }), late = deferred<DouyinHttpLoginStep>(), abort = new AbortController()
      f.session.poll.mockReturnValueOnce(late.promise)
      const capture = vi.fn(async () => {}), result = f.begin({ signal: abort.signal, captureDouyinSigning: capture })
      await flush(); await vi.advanceTimersByTimeAsync(20)
      if (reason === 'request-abort') abort.abort()
      else if (reason === 'owner-navigation') f.ownerContents.emit('will-navigate')
      else if (reason === 'owner-destroyed') f.ownerContents.emit('destroyed')
      else if (reason === 'card-destroyed') f.cardContents.emit('destroyed')
      else await vi.advanceTimersByTimeAsync(80)
      await expect(result).rejects.toMatchObject({ code: 'login-cancelled' })
      expect(f.signals[0]?.aborted).toBe(true)
      expect(f.session.dispose).toHaveBeenCalledOnce()
      late.resolve({ status: 'authenticated', uid: '1001', cookies, snapshot: null }); await flush()
      expect(capture).not.toHaveBeenCalled()
      expect(f.controller.state()).toBeNull()
      expect(f.card.close).toHaveBeenCalledOnce()
    },
  )

  it('retries with a fresh aborted session and ignores old initialization', async () => {
    const f = setup()
    f.session.initialize.mockRejectedValueOnce(new Error('synthetic failure'))
    f.begin(); await flush()
    expect(f.controller.state()?.phase).toBe('failed')
    await f.controller.retry(f.controller.state()!.id)
    expect(f.createSession).toHaveBeenCalledTimes(2)
    expect(f.signals[0]?.aborted).toBe(true)
    expect(f.signals[1]?.aborted).toBe(false)
    expect(f.controller.cardState()?.stage).toBe('form')
  })

  it('requires the exact local card sender and top frame and clamps bounds using owner zoom', async () => {
    const f = setup(); f.begin(); await flush()
    const sender = f.cardContents as unknown as WebContents, frame = f.cardContents.mainFrame as unknown as WebFrameMain
    expect(f.controller.ownsCard(sender, frame)).toBe(true)
    expect(f.controller.ownsCard(sender, { url: f.card.url } as WebFrameMain)).toBe(false)
    expect(f.controller.ownsCard(f.ownerContents as unknown as WebContents, frame)).toBe(false)
    f.cardContents.mainFrame.url = 'https://login.douyin.com/'
    expect(f.controller.ownsCard(sender, frame)).toBe(false)
    f.cardContents.mainFrame.url = f.card.url
    f.controller.setViewport({ id: f.controller.state()!.id, visible: true, rect: { x: -10, y: 5, width: 1000, height: 1000 } })
    expect(f.card.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 6, width: 1000, height: 694 }, true)
    f.controller.setViewport({ id: f.controller.state()!.id, visible: true, rect: { x: NaN, y: 0, width: 1, height: 1 } })
    expect(f.card.hide).toHaveBeenCalled()
  })

  it('validates authorization and returns immutable state without retaining rejected input secrets', async () => {
    const f = setup()
    await expect(f.begin({ platform: 'bilibili' })).rejects.toMatchObject({ code: 'login-failed' })
    expect(f.createCard).not.toHaveBeenCalled()
    f.begin(); await flush()
    await expect(f.begin()).rejects.toMatchObject({ code: 'login-busy' })
    const invalid: LoginCardAction = { kind: 'sms', phone: 'secret-phone', countryCode: '+86', code: 'secret-code', accepted: true }
    expect((await f.controller.cardAction(invalid)).ok).toBe(false)
    expect(invalid).toMatchObject({ phone: '', countryCode: '', code: '' })
    expect(f.session.loginSms).not.toHaveBeenCalled()
    const state = f.controller.cardState()!; state.qr.status = 'expired'
    expect(f.controller.cardState()?.qr.status).toBe('ready')
    expect((await f.controller.cardAction({ kind: 'official' })).ok).toBe(false)
  })
})
