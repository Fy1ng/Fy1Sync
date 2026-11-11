import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOUYU_QR_POLL_PATHS, douyuLoginAdapter } from './douyu'
import type { LoginCardAction, LoginPageActionResult, LoginPageSnapshot } from '../loginCardContracts'

type TestDOM = { window: Window & typeof globalThis }
// Use the installed test runtime without introducing an additional type-package dependency.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => TestDOM }
const windows: TestDOM[] = []
function fixture(mode: 'password' | 'sms' = 'password') {
  // Reduced controls verified against the current anonymous passport DOM and SDK.
  const dom = new JSDOM(`<div class="js-scancode-box status-scan">
    <div class="js-qrcode-con"><canvas></canvas></div><div class="qrcode-mask" style="display:none"><a class="js-qrcode-refresh">刷新</a></div>
    <div class="loginbox-scanmobile" style="display:none">请在手机上确认登录</div></div>
    <div class="js-login-normal"><span class="js-l-stype" data-subtype="login-by-password">密码</span><span class="js-l-stype" data-subtype="login-by-sms">短信</span>
    <form class="login-form login-by-${mode}" data-type="log">
      <div data-mode="password"><input name="nicknameOrPhone" maxlength="30"><input name="password" type="password" maxlength="25"></div>
      <div data-mode="sms"><div class="js-select-country-list"><li><span class="selectCountry-value">+86</span></li><li><span class="selectCountry-value">+65</span></li></div>
        <input name="areaCode" value="+86" class="js-selectCountry-box-code"><input name="phoneNum" maxlength="13"><input name="phoneCaptcha" maxlength="6">
        <input type="button" value="获取验证码" class="phone-send js-sendvoice"></div>
      <div class="login-sbt-resMsg"></div><input type="submit" class="loginbox-sbt btn-sub">
    </form></div><div class="geetest_panel" style="display:none"></div>`, { url: 'https://passport.douyu.com/member/login', runScripts: 'outside-only' })
  windows.push(dom)
  const { document } = dom.window
  Object.defineProperty(document, 'readyState', { get: () => 'complete' })
  vi.spyOn(dom.window.Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, width: 160, height: 160, top: 20, left: 10, bottom: 180, right: 170, toJSON: () => ({}) })
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cXVlcg==')
  const changeMode = (next: 'password' | 'sms') => {
    document.querySelector('form')!.className = `login-form login-by-${next}`
    for (const node of document.querySelectorAll<HTMLElement>('[data-mode]')) node.style.display = node.dataset.mode === next ? '' : 'none'
  }
  changeMode(mode)
  for (const tab of document.querySelectorAll<HTMLElement>('.js-l-stype')) tab.addEventListener('click', () => changeMode(tab.dataset.subtype === 'login-by-sms' ? 'sms' : 'password'))
  const submit = vi.fn((event: Event) => event.preventDefault())
  document.querySelector('form')!.addEventListener('submit', submit)
  const send = vi.fn()
  document.querySelector('.phone-send')!.addEventListener('click', send)
  const area = document.querySelector<HTMLInputElement>('[name="areaCode"]')!
  let sdkArea = '0086'
  area.addEventListener('input', () => {
    sdkArea = area.value.replace('+', '00')
    document.querySelector<HTMLInputElement>('[name="phoneNum"]')!.maxLength = area.value === '+86' ? 13 : 11
  })
  return { dom, document, submit, send, sdkArea: () => sdkArea,
    inspect: () => dom.window.eval(douyuLoginAdapter.inspectScript) as LoginPageSnapshot,
    act: (action: LoginCardAction) => dom.window.eval(douyuLoginAdapter.actionScript(action)) as Promise<LoginPageActionResult> }
}
afterEach(() => { windows.splice(0).forEach(dom => dom.window.close()); vi.restoreAllMocks() })

describe('Douyu official form adapter', () => {
  it('prepares SMS identity with a disabled send button, never sends, and keeps repeated equal input inert', async () => {
    const f = fixture('sms')
    const button = f.document.querySelector<HTMLInputElement>('.phone-send')!
    button.disabled = true
    const phone = f.document.querySelector<HTMLInputElement>('[name="phoneNum"]')!
    const changed = vi.fn()
    phone.addEventListener('input', changed)
    const action: LoginCardAction = { kind: 'prepare-sms', phone: '81234567', countryCode: '+65', accepted: true }
    expect(await f.act(action)).toEqual({ ok: true })
    expect(phone.value).toBe('81234567')
    expect(f.sdkArea()).toBe('0065')
    expect(await f.act(action)).toEqual({ ok: true })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.inspect().sms?.canSend).toBe(false)
  })

  it.each([
    ['获取验证码', false, true, 0], ['重新获取', false, true, 0], ['获取验证码(42)', true, false, 42],
    ['37S后重新获取', true, false, 37], ['请求中', true, false, null], ['获取验证码', true, false, null],
  ] as const)('uses the actual SMS button state %s, disabled=%s', async (caption, disabled, canSend, cooldownSeconds) => {
    const f = fixture('sms')
    const button = f.document.querySelector<HTMLInputElement>('.phone-send')!
    button.value = caption
    button.disabled = disabled
    expect(f.inspect().sms).toEqual({ canSend, cooldownSeconds })
  })

  it('preserves country, formatted phone and captcha result when submitting SMS after a successful send', async () => {
    const f = fixture('sms')
    const phone = f.document.querySelector<HTMLInputElement>('[name="phoneNum"]')!
    const area = f.document.querySelector<HTMLInputElement>('[name="areaCode"]')!
    const changed = vi.fn()
    let captchaPassed = false
    for (const input of [phone, area]) input.addEventListener('input', () => { changed(); captchaPassed = false })
    expect(await f.act({ kind: 'send-sms', countryCode: '+86', phone: '13800000000', accepted: true })).toEqual({ ok: true })
    phone.value = '138 0000 0000'
    captchaPassed = true
    changed.mockClear()
    const button = f.document.querySelector<HTMLInputElement>('.phone-send')!
    button.disabled = true
    button.value = '59S后重新获取'
    f.document.querySelector('form')!.insertAdjacentHTML('beforeend', '<div class="captcha-gt render"><input class="verify-imgCode-input" name="captcha_word"><img class="verify-imgCode-img"></div>')
    expect(f.inspect().page).toBe('form')
    expect(await f.act({ kind: 'sms', countryCode: '+86', phone: '13800000000', code: '123456', accepted: true })).toEqual({ ok: true })
    expect(changed).not.toHaveBeenCalled()
    expect(captchaPassed).toBe(true)
    expect(phone.value).toBe('138 0000 0000')
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('waits one DOM task after filling a password before testing the enabled submit control', async () => {
    const f = fixture()
    const button = f.document.querySelector<HTMLInputElement>('[type="submit"]')!
    button.disabled = true
    f.document.querySelector('[name="password"]')!.addEventListener('input', () => f.dom.window.setTimeout(() => { button.disabled = false }, 0))
    expect(await f.act({ kind: 'password', username: 'fixture', password: 'fixture', accepted: true })).toEqual({ ok: true })
    expect(f.submit).toHaveBeenCalledTimes(1)
  })

  it('reports the inner interactive Geetest box instead of its full-page mask', async () => {
    const f = fixture()
    const panel = f.document.querySelector<HTMLElement>('.geetest_panel')!
    panel.style.display = ''
    panel.innerHTML = '<div class="geetest_panel_box"></div>'
    Object.defineProperty(panel, 'getBoundingClientRect', { value: () => ({ x: 0, y: 0, width: 1000, height: 700 }) })
    expect(f.inspect()).toMatchObject({ page: 'challenge', challenge: { x: 10, y: 20, width: 160, height: 160 } })
  })

  it('reports the original front image-code controls as the interactive challenge region', async () => {
    const f = fixture('sms')
    f.document.querySelector('form')!.insertAdjacentHTML('beforeend', '<div class="captcha-gt render"><input class="verify-imgCode-input" name="captcha_word"><img class="verify-imgCode-img"></div>')
    expect(f.inspect()).toMatchObject({ page: 'challenge', challenge: { width: 160, height: 160 } })
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('does not treat a lingering visible success indicator as another captcha step', async () => {
    const f = fixture('sms')
    const panel = f.document.querySelector<HTMLElement>('.geetest_panel')!
    panel.style.display = ''
    panel.innerHTML = '<div class="geetest_panel_box"><div class="geetest_panel_success">通过验证</div></div>'
    expect(f.inspect().page).toBe('form')
  })

  it('lets the controller check server identity when the completed form leaves the document', async () => {
    const f = fixture()
    f.document.querySelector('.js-login-normal')!.remove()
    expect(f.inspect()).toMatchObject({ page: 'loading' })
  })

  it.each(['password', 'sms'] as const)('classifies the verified %s form and exports only bounded QR metadata', async mode => {
    const f = fixture(mode)
    expect(f.inspect()).toMatchObject({ page: 'form', mode, qrStatus: 'ready', qr: { src: 'data:image/png;base64,cXVlcg==', rect: { width: 160, height: 160 } } })
  })

  it('keeps an empty pending QR container in loading state', async () => {
    const f = fixture()
    f.document.querySelector('canvas')!.remove()
    expect(f.inspect().qrStatus).toBe('loading')
    expect(f.inspect().qr).toBeUndefined()
  })

  it('never reads input values, cookies or private page state during inspection', async () => {
    const f = fixture()
    for (const input of f.document.querySelectorAll('input:not([type="button"])')) Object.defineProperty(input, 'value', { get: () => { throw new Error('Secret read') } })
    Object.defineProperty(f.document, 'cookie', { get: () => { throw new Error('Cookie read') } })
    expect(f.inspect().page).toBe('form')
    expect(JSON.stringify(f.inspect())).not.toMatch(/passwordValue|username|token|cookie/i)
  })

  it('sets username and password through native setters and emits input/change without Enter or duplicate submit', async () => {
    const f = fixture()
    const events: string[] = []
    const input = f.document.querySelector<HTMLInputElement>('[name="password"]')!
    Object.defineProperty(input, 'value', { configurable: true, set: () => { throw new Error('Custom setter') } })
    for (const type of ['input', 'change', 'keyup']) input.addEventListener(type, () => events.push(type))
    expect(await f.act({ kind: 'password', username: 'fixture-user', password: "Pass'<x>123", accepted: true })).toEqual({ ok: true })
    expect(events).toEqual(['input', 'change'])
    expect(Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!.get!.call(input)).toBe("Pass'<x>123")
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
    expect(JSON.stringify(f.inspect())).not.toContain('fixture-user')
  })

  it('changes mode with exactly one official tab click and no submissions', async () => {
    const f = fixture()
    const clicked = vi.fn()
    f.document.querySelector('[data-subtype="login-by-sms"]')!.addEventListener('click', clicked)
    expect(await f.act({ kind: 'mode', mode: 'sms' })).toEqual({ ok: true })
    expect(f.inspect().mode).toBe('sms')
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each(['+86', '+65'])('sends SMS once and synchronizes supported country code %s with the official SDK listener', async countryCode => {
    const f = fixture('sms')
    expect(await f.act({ kind: 'send-sms', countryCode, phone: countryCode === '+86' ? '13800000000' : '81234567', accepted: true })).toEqual({ ok: true })
    expect(f.sdkArea()).toBe(countryCode.replace('+', '00'))
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('submits the supplied SMS code exactly once without requesting another SMS', async () => {
    const f = fixture('sms')
    expect(await f.act({ kind: 'sms', countryCode: '+65', phone: '81234567', code: '123456', accepted: true })).toEqual({ ok: true })
    expect(f.document.querySelector<HTMLInputElement>('[name="phoneCaptcha"]')!.value).toBe('123456')
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('rejects unsupported country codes, invalid input and missing agreement before submission', async () => {
    const f = fixture('sms')
    expect(await f.act({ kind: 'send-sms', countryCode: '+999', phone: '81234567', accepted: true })).toEqual({ ok: false, reason: 'unsupported' })
    expect(await f.act({ kind: 'send-sms', countryCode: '+86', phone: '81234567', accepted: true })).toEqual({ ok: false, reason: 'invalid-input' })
    expect(await f.act({ kind: 'sms', countryCode: '+65', phone: '81234567', code: '12', accepted: true })).toEqual({ ok: false, reason: 'invalid-input' })
    expect(await f.act({ kind: 'send-sms', countryCode: '+65', phone: '81234567', accepted: false } as unknown as LoginCardAction)).toEqual({ ok: false, reason: 'invalid-input' })
    expect(f.send).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('reads only the actual send-button caption for countdown and respects its disabled state', async () => {
    const f = fixture('sms')
    const send = f.document.querySelector<HTMLInputElement>('.phone-send')!
    send.disabled = true
    send.value = '57S后重新获取'
    expect(f.inspect().sms).toEqual({ canSend: false, cooldownSeconds: 57 })
    expect(await f.act({ kind: 'send-sms', phone: '13800000000', countryCode: '+86', accepted: true })).toMatchObject({ ok: false, reason: 'not-ready' })
    expect(f.send).not.toHaveBeenCalled()
  })

  it('prioritizes visible captcha and pauses QR without forwarding credentials', async () => {
    const f = fixture()
    f.document.querySelector<HTMLElement>('.geetest_panel')!.style.display = ''
    expect(f.inspect()).toMatchObject({ page: 'challenge', qrStatus: 'paused' })
    expect(await f.act({ kind: 'password', username: 'fixture', password: 'fixture', accepted: true })).toMatchObject({ ok: false })
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('treats binding, unrecognized inputs and unverified second-factor pages as unknown', async () => {
    const f = fixture()
    f.document.body.insertAdjacentHTML('beforeend', '<div id="bindPhone"><input></div>')
    expect(f.inspect()).toEqual({ page: 'unknown', qrStatus: 'paused' })
    f.document.querySelector('#bindPhone')!.remove()
    f.document.querySelector('form')!.insertAdjacentHTML('beforeend', '<input name="unexpectedOtp">')
    expect(f.inspect().page).toBe('unknown')
    expect(await f.act({ kind: 'second-submit', code: '123456' })).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('keeps an unrecognized visible verification frame on the official page', async () => {
    const f = fixture()
    f.document.body.insertAdjacentHTML('beforeend', '<iframe src="https://passport.douyu.com/new-security-step"></iframe>')
    expect(f.inspect()).toEqual({ page: 'unknown', qrStatus: 'paused' })
    expect(await f.act({ kind: 'password', username: 'fixture', password: 'fixture', accepted: true })).toMatchObject({ ok: false })
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('uses verified scanned and expired DOM state and refreshes only via the official button', async () => {
    const f = fixture()
    const box = f.document.querySelector('.js-scancode-box')!
    box.className = 'js-scancode-box status-scansucceed'
    expect(f.inspect().qrStatus).toBe('scanned')
    box.className = 'js-scancode-box status-scan status-scanfail'
    f.document.querySelector<HTMLElement>('.qrcode-mask')!.style.display = ''
    const refreshed = vi.fn()
    f.document.querySelector('.js-qrcode-refresh')!.addEventListener('click', refreshed)
    expect(await f.act({ kind: 'refresh-qr' })).toEqual({ ok: true })
    expect(refreshed).toHaveBeenCalledTimes(1)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('exports fixed error categories without text and only accepts the exact official login frame', async () => {
    const f = fixture()
    f.document.querySelector('.login-sbt-resMsg')!.textContent = '密码错误 fixture-private-diagnostic'
    expect(f.inspect().error).toBe('invalid-credentials')
    expect(JSON.stringify(f.inspect())).not.toContain('fixture-private-diagnostic')
    expect(douyuLoginAdapter.acceptsFrame('https://passport.douyu.com/member/login?client_id=1')).toBe(true)
    for (const url of ['http://passport.douyu.com/member/login', 'https://user@passport.douyu.com/member/login', 'https://passport.douyu.com:8443/member/login', 'https://passport.douyu.com.evil.test/member/login', 'https://passport.douyu.com/member/register']) expect(douyuLoginAdapter.acceptsFrame(url)).toBe(false)
    expect(DOUYU_QR_POLL_PATHS).toEqual(['/japi/scan/auth'])
  })
})
