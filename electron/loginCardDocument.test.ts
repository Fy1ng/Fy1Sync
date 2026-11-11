// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoginCardAction, LoginCardBridge, LoginCardState } from './loginCardContracts'
import { loginCardHtml, LOGIN_CARD_CSS, LOGIN_CARD_SCRIPT } from './loginCardDocument'

const BASE: LoginCardState = { platform: 'douyu', stage: 'form', mode: 'password', busy: false,
  qr: { status: 'loading' }, sms: { canSend: true, cooldownSeconds: 0 } }
let listener: (state: LoginCardState) => void
let bridge: LoginCardBridge
let release: ReturnType<typeof vi.fn<() => void>>
const sent: LoginCardAction[] = []
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement
const button = (id: string): HTMLButtonElement => document.getElementById(id) as HTMLButtonElement
const emit = (next: Partial<LoginCardState>): void => listener({ ...BASE, ...next })
const submit = (id = 'login-form'): void => { document.getElementById(id)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }
function start(): void {
  const parsed = new DOMParser().parseFromString(loginCardHtml(), 'text/html')
  document.body.replaceChildren(...[...parsed.body.childNodes].map(node => node.cloneNode(true)))
  window.loginCard = bridge
  window.eval(LOGIN_CARD_SCRIPT)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-06T12:00:00Z'))
  sent.length = 0
  release = vi.fn<() => void>()
  bridge = {
    state: vi.fn(async () => BASE),
    subscribe: vi.fn(callback => { listener = callback; return release }),
    act: vi.fn(async action => { sent.push(structuredClone(action)); return { ok: true } }),
  }
})
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  delete window.loginCard
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the dedicated local login document', () => {
  it('allows an explicit official-page handoff while waiting without resubmitting credentials', async () => {
    start()
    await flush()
    emit({ stage: 'verification', busy: true, verification: { kind: 'sms' }, message: '正在等待平台验证结果' })
    expect(button('second-submit').disabled).toBe(true)
    expect(button('official').disabled).toBe(false)
    button('official').click()
    await flush()
    expect(sent).toEqual([{ kind: 'official' }])
  })
  it('uses the same isolated form structure for all platforms without network or inline resources', async () => {
    const html = loginCardHtml()
    expect(html).toContain('href="./card.css"')
    expect(html).toContain('src="./card.js"')
    expect(html).not.toMatch(/https?:|<style|<script[^>]*>[^<]+|\son\w+=/)
    expect(LOGIN_CARD_SCRIPT).not.toMatch(/\bfetch\s*\(|localStorage|sessionStorage|console\.|innerHTML|streamSyncer/)
    expect(LOGIN_CARD_CSS).toContain('#f3f0ea')
    expect(LOGIN_CARD_CSS).not.toContain('url(')
    start()
    await flush()
    const structure = document.querySelector('#basic')!.querySelectorAll('*').length
    for (const platform of ['douyu', 'bilibili', 'huya'] as const) {
      emit({ platform })
      expect(document.querySelector('#basic')!.querySelectorAll('*')).toHaveLength(structure)
      expect(document.querySelectorAll('[data-login-column]')).toHaveLength(2)
      expect(input('accepted').checked).toBe(false)
    }
  })

  it('requires consent and clears password immediately after its owner-scoped action', async () => {
    start()
    await flush()
    input('username').value = 'synthetic-user'
    input('password').value = 'synthetic-password'
    submit()
    expect(sent).toEqual([])
    expect(document.getElementById('message')!.textContent).toContain('请先阅读并同意')
    input('accepted').checked = true
    let finish!: (value: { ok: boolean }) => void
    vi.mocked(bridge.act).mockImplementation(action => {
      sent.push(structuredClone(action))
      return new Promise(resolve => { finish = resolve })
    })
    submit()
    expect(sent).toEqual([{ kind: 'password', username: 'synthetic-user', password: 'synthetic-password', accepted: true }])
    expect(input('password').value).toBe('')
    expect(button('submit-login').disabled).toBe(true)
    finish({ ok: true })
    await flush()
    expect(input('password').value).toBe('')
    expect(vi.mocked(bridge.act).mock.calls[0]![0]).toMatchObject({ password: '' })
  })

  it('switches to SMS and uses only the official control snapshot for its cooldown', async () => {
    start()
    await flush()
    input('password').value = 'discard-on-mode-change'
    button('mode-sms').click()
    expect(sent[0]).toEqual({ kind: 'mode', mode: 'sms' })
    expect(input('password').value).toBe('')
    emit({ mode: 'sms' })
    await flush()
    expect(document.getElementById('password-fields')!.hidden).toBe(true)
    expect(document.getElementById('sms-fields')!.hidden).toBe(false)
    input('phone').value = '15500000000'
    input('accepted').checked = true
    button('send-sms').click()
    await flush()
    expect(sent[1]).toEqual({ kind: 'send-sms', phone: '15500000000', countryCode: '+86', accepted: true })
    emit({ mode: 'sms', sms: { canSend: false, cooldownSeconds: 37 } })
    expect(button('send-sms').textContent).toBe('37 秒后重发')
    expect(button('send-sms').disabled).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(button('send-sms').textContent).toBe('37 秒后重发')
    expect(button('send-sms').disabled).toBe(true)
    emit({ mode: 'sms', sms: { canSend: false, cooldownSeconds: 12 } })
    expect(button('send-sms').textContent).toBe('12 秒后重发')
    emit({ mode: 'sms', sms: { canSend: true, cooldownSeconds: 0 } })
    expect(button('send-sms').textContent).toBe('发送验证码')
    expect(button('send-sms').disabled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(sent.map(action => action.kind)).toEqual(['mode', 'send-sms'])
    input('sms-code').value = '123456'
    submit()
    expect(sent[2]).toEqual({ kind: 'sms', phone: '15500000000', countryCode: '+86', code: '123456', accepted: true })
    expect(input('sms-code').value).toBe('')
  })

  it('prepares a consented phone without sending SMS so the official button can become enabled', async () => {
    start()
    await flush()
    emit({ mode: 'sms', sms: { canSend: false, cooldownSeconds: null } })
    input('phone').value = '15500000000'
    input('phone').dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(220)
    expect(sent).toEqual([])
    input('accepted').checked = true
    input('accepted').dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(220)
    expect(sent).toEqual([{ kind: 'prepare-sms', phone: '15500000000', countryCode: '+86', accepted: true }])
    expect(button('send-sms').disabled).toBe(true)
    emit({ mode: 'sms', sms: { canSend: true, cooldownSeconds: 0 } })
    expect(button('send-sms').disabled).toBe(false)
    emit({ stage: 'loading', mode: 'sms', sms: { canSend: false, cooldownSeconds: null } })
    emit({ stage: 'form', mode: 'sms', sms: { canSend: false, cooldownSeconds: null } })
    await vi.advanceTimersByTimeAsync(220)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ kind: 'prepare-sms' })
  })

  it('does not announce SMS success before the official send control confirms it', async () => {
    start()
    await flush()
    emit({ mode: 'sms', sms: { canSend: false, cooldownSeconds: null } })
    expect(button('send-sms').textContent).toBe('等待平台验证')
    button('send-sms').click()
    expect(sent).toEqual([])
    emit({ mode: 'sms', busy: true, message: '请完成人机验证', sms: { canSend: false, cooldownSeconds: null } })
    expect(document.getElementById('message')!.textContent).toBe('请完成人机验证')
    expect(button('send-sms').textContent).toBe('等待平台验证')
    emit({ mode: 'sms', busy: true, message: '正在等待平台发送结果', sms: { canSend: true, cooldownSeconds: 0 } })
    expect(button('send-sms').disabled).toBe(true)
    expect(document.getElementById('message')!.textContent).toBe('正在等待平台发送结果')
    emit({ stage: 'verification', verification: { kind: 'sms' }, sms: { canSend: false, cooldownSeconds: null } })
    expect(button('second-send').textContent).toBe('等待平台验证')
    button('second-send').click()
    expect(sent).toEqual([])
    emit({ stage: 'verification', verification: { kind: 'sms' }, sms: { canSend: false, cooldownSeconds: 37 } })
    expect(button('second-send').textContent).toBe('37 秒后重发')
    vi.advanceTimersByTime(60_000)
    expect(button('second-send').textContent).toBe('37 秒后重发')
    expect(LOGIN_CARD_SCRIPT).not.toMatch(/Date\.now|setInterval|smsRetryAt/)
  })

  it('toggles password visibility and resets it whenever sensitive inputs are cleared', async () => {
    start()
    await flush()
    input('password').value = 'synthetic-password'
    expect(input('password').type).toBe('password')
    expect(button('toggle-password').getAttribute('aria-label')).toBe('显示密码')
    button('toggle-password').click()
    expect(input('password').type).toBe('text')
    expect(button('toggle-password').getAttribute('aria-label')).toBe('隐藏密码')
    expect(button('toggle-password').getAttribute('aria-pressed')).toBe('true')
    button('toggle-password').click()
    expect(input('password').type).toBe('password')
    for (const action of ['submit', 'mode', 'stage', 'cancel'] as const) {
      emit({})
      await flush()
      input('username').value = 'synthetic-user'
      input('password').value = 'synthetic-password'
      input('accepted').checked = true
      button('toggle-password').click()
      if (action === 'submit') submit()
      if (action === 'mode') button('mode-sms').click()
      if (action === 'stage') emit({ stage: 'verification', verification: { kind: 'sms' } })
      if (action === 'cancel') button('cancel').click()
      expect(input('password').value).toBe('')
      expect(input('password').type).toBe('password')
      expect(button('toggle-password').getAttribute('aria-label')).toBe('显示密码')
      expect(button('toggle-password').getAttribute('aria-pressed')).toBe('false')
      await flush()
    }
  })

  it('keeps action errors readable through routine state pushes until a new input or action', async () => {
    start()
    await flush()
    let finish!: (result: { ok: boolean; message: string }) => void
    vi.mocked(bridge.act).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    input('username').value = 'synthetic-user'
    input('password').value = 'synthetic-password'
    input('accepted').checked = true
    submit()
    emit({ qr: { status: 'expired' }, message: '平台密码错误' })
    const message = document.getElementById('message')!
    expect(message.textContent).toBe('平台密码错误')
    expect(message.getAttribute('role')).toBe('alert')
    finish({ ok: false, message: '合成密码错误' })
    await flush()
    expect(message.textContent).toBe('合成密码错误')
    expect(message.getAttribute('role')).toBe('alert')
    emit({ qr: { status: 'expired' } })
    expect(message.textContent).toBe('合成密码错误')
    input('username').dispatchEvent(new Event('input', { bubbles: true }))
    expect(message.textContent).toBe('')
    emit({ message: '平台密码错误' })
    expect(message.textContent).toBe('平台密码错误')
    expect(message.getAttribute('role')).toBe('alert')
    emit({ message: '平台密码错误', qr: { status: 'unavailable' } })
    expect(message.textContent).toBe('平台密码错误')
    button('refresh-qr').click()
    await flush()
    expect(message.textContent).toBe('')
  })

  it('replaces the base form with masked email verification and sends no earlier credentials', async () => {
    start()
    await flush()
    input('password').value = 'clear-on-verification'
    emit({ stage: 'verification', verification: { kind: 'email', maskedTarget: 's***@example.invalid' } })
    expect(input('password').value).toBe('')
    expect(document.getElementById('basic')!.hidden).toBe(true)
    expect(document.getElementById('verification')!.hidden).toBe(false)
    expect(document.getElementById('verification-label')!.textContent).toBe('邮箱验证码')
    expect(document.getElementById('masked-target')!.textContent).toBe('s***@example.invalid')
    button('second-send').click()
    await flush()
    expect(sent[0]).toEqual({ kind: 'second-send' })
    input('verification-code').value = '654321'
    submit('verification-form')
    expect(sent[1]).toEqual({ kind: 'second-submit', code: '654321' })
    expect(input('verification-code').value).toBe('')
    await flush()
    button('verification-back').click()
    expect(sent[2]).toEqual({ kind: 'back' })
    expect(input('username').value).toBe('')
  })

  it('only renders raster data images and displays messages as inert text', async () => {
    start()
    await flush()
    const image = document.getElementById('qr-image') as HTMLImageElement
    for (const value of ['https://example.invalid/qr.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,malformed']) {
      emit({ qr: { status: 'ready', image: value }, message: '<img src=x onerror=alert(1)>' })
      expect(image.hasAttribute('src')).toBe(false)
      expect(image.hidden).toBe(true)
    }
    expect(document.getElementById('message')!.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(document.getElementById('message')!.childElementCount).toBe(0)
    const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    emit({ qr: { status: 'ready', image: data } })
    expect(image.src).toBe(data)
    expect(image.hidden).toBe(false)
    emit({ qr: { status: 'expired' } })
    expect(image.hasAttribute('src')).toBe(false)
    button('refresh-qr').click()
    expect(sent[0]).toEqual({ kind: 'refresh-qr' })
  })

  it('keeps a newer subscribed state when the initial query arrives late', async () => {
    let finish!: (value: LoginCardState) => void
    vi.mocked(bridge.state).mockReturnValue(new Promise(resolve => { finish = resolve }))
    start()
    emit({ stage: 'verification', verification: { kind: 'sms', maskedTarget: '155****0000' } })
    finish(BASE)
    await flush()
    expect(document.getElementById('card')!.dataset.stage).toBe('verification')
    expect(document.getElementById('verification')!.hidden).toBe(false)
  })

  it('allows cancellation during submission and clears all inputs on unload', async () => {
    start()
    await flush()
    vi.mocked(bridge.act).mockImplementation(action => { sent.push(structuredClone(action)); return new Promise(() => {}) })
    input('username').value = 'synthetic-user'
    input('password').value = 'synthetic-password'
    input('accepted').checked = true
    submit()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(sent.at(-1)).toEqual({ kind: 'cancel' })
    expect(input('password').value).toBe('')
    expect(input('username').value).toBe('')
    input('verification-code').value = 'unload-secret'
    window.dispatchEvent(new Event('pagehide'))
    expect(input('verification-code').value).toBe('')
    expect(release).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('offers official verification after a failed action and returns via back', async () => {
    start()
    await flush()
    vi.mocked(bridge.act).mockResolvedValueOnce({ ok: false, message: '合成认证失败' })
    button('refresh-qr').click()
    await flush()
    expect(document.getElementById('message')!.textContent).toBe('合成认证失败')
    button('official').click()
    await flush()
    expect(sent.at(-1)).toEqual({ kind: 'official' })
    emit({ stage: 'official' })
    expect(document.getElementById('basic')!.hidden).toBe(true)
    button('official-back').click()
    expect(sent.at(-1)).toEqual({ kind: 'back' })
  })
})
