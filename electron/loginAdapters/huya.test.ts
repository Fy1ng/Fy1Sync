import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HUYA_QR_POLL_PATHS, huyaLoginAdapter } from './huya'
import type { LoginCardAction, LoginPageActionResult, LoginPageSnapshot } from '../loginCardContracts'

type TestDOM = { window: Window & typeof globalThis }
// Use the installed test runtime without introducing an additional type-package dependency.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => TestDOM }
const windows: TestDOM[] = []
function fixture(mode: 'password' | 'sms' = 'password') {
  // Reduced controls verified against the current anonymous iframe DOM and official SDK.
  const dom = new JSDOM(`<div id="qr-list"><img id="qr-image" src="https://udblgn.huya.com/qrLgn/getQrImg?k=fixture&appId=5002">
    <div id="qr-invalid" style="display:none"><p></p><div class="refresh">刷新</div></div></div><div id="scan-success" style="display:none">扫码成功</div>
    <div id="login-head-nav"><li udb-eid="40">密码</li><li udb-eid="12">短信</li></div>
    <div id="account-login-form"><input id="username" maxlength="35"><input id="password" type="password" maxlength="20">
      <div class="udb-imgcode-item" style="display:none"><input class="udb-input-code"></div>
      <div class="udb-yycode-item" style="display:none"><input class="udb-input-code"></div>
      <div class="input-error-tips"></div><div id="login-btn">登录</div></div>
    <div id="phone-login-form"><div class="sel-areas" areascode="86"><span>+86</span></div>
      <div class="sel-areas-list" style="display:none"><ul><li><span class="areasNumber" areascode="86">+86</span></li><li><span class="areasNumber" areascode="65">+65</span></li></ul></div>
      <input class="udb-input-tel" type="number"><input class="udb-input-code"><span class="get-sms-code" enabled="1">获取验证码</span>
      <div class="input-error-tips"></div><div id="phone-login-btn">登录</div></div>
    <div id="login-pop" style="display:none"></div><div id="register-main" style="display:none"></div>`, { url: 'https://aq.huya.com/p/udb_login.html', runScripts: 'outside-only' })
  windows.push(dom)
  const { document } = dom.window
  Object.defineProperty(document, 'readyState', { get: () => 'complete' })
  vi.spyOn(dom.window.Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, width: 160, height: 160, top: 20, left: 10, bottom: 180, right: 170, toJSON: () => ({}) })
  const changeMode = (next: 'password' | 'sms') => {
    document.querySelector<HTMLElement>('#account-login-form')!.style.display = next === 'password' ? '' : 'none'
    document.querySelector<HTMLElement>('#phone-login-form')!.style.display = next === 'sms' ? '' : 'none'
    for (const tab of document.querySelectorAll('#login-head-nav li')) tab.classList.toggle('on', tab.getAttribute('udb-eid') === (next === 'password' ? '40' : '12'))
  }
  changeMode(mode)
  for (const tab of document.querySelectorAll('#login-head-nav li')) tab.addEventListener('click', () => changeMode(tab.getAttribute('udb-eid') === '40' ? 'password' : 'sms'))
  for (const item of document.querySelectorAll('.sel-areas-list li')) item.addEventListener('click', () => document.querySelector('.sel-areas')!.setAttribute('areascode', item.querySelector('.areasNumber')!.getAttribute('areascode')!))
  const passwordSubmit = vi.fn(), smsSubmit = vi.fn(), send = vi.fn()
  document.querySelector('#login-btn')!.addEventListener('click', passwordSubmit)
  document.querySelector('#phone-login-btn')!.addEventListener('click', smsSubmit)
  document.querySelector('.get-sms-code')!.addEventListener('click', send)
  return { dom, document, passwordSubmit, smsSubmit, send,
    inspect: () => dom.window.eval(huyaLoginAdapter.inspectScript) as LoginPageSnapshot,
    act: (action: LoginCardAction) => dom.window.eval(huyaLoginAdapter.actionScript(action)) as Promise<LoginPageActionResult> }
}
afterEach(() => { windows.splice(0).forEach(dom => dom.window.close()); vi.restoreAllMocks() })

function mountTencentCard(document: Document) {
  document.body.insertAdjacentHTML('beforeend', '<div id="tcaptcha_transform" class="tcaptcha-transform"><iframe id="tcaptcha_iframe" class="tcaptcha-iframe" src="https://t.captcha.qq.com/cap_union_new_show?aid=2027709410"></iframe></div>')
  const panel = document.querySelector('#tcaptcha_transform')!
  Object.defineProperty(panel, 'getBoundingClientRect', { value: () => ({ x: 100, y: 80, width: 361.333, height: 361.333 }) })
  Object.defineProperty(panel.querySelector('iframe')!, 'getBoundingClientRect', { value: () => ({ x: 100.667, y: 80.667, width: 360, height: 360 }) })
  return panel as HTMLElement
}

function tencentFixture(url = 'https://t.captcha.qq.com/cap_union_new_show?aid=2027709410') {
  const dom = new JSDOM(`<div class="tcaptcha-window tcaptcha--newtype tcaptcha--vtt" id="tcaptcha_vtt0">
    <div class="tcaptcha-header"><p class="tcaptcha-title"></p></div>
    <div class="tcaptcha-opearea"><div class="tcaptcha-network-error" style="display:none"></div>
      <div id="tcaptcha_chabie" class="tcaptcha-cover tcaptcha-cover--error" style="display:none"></div>
      <div id="tcaptcha_refresh" class="tcaptcha-cover tcaptcha-cover--error" style="display:none"><div class="tcaptcha-initing-dots"></div></div>
      <div id="tcaptcha_success" class="tcaptcha-cover tcaptcha-cover--success" style="display:none"></div>
      <div id="tcaptcha_imgarea"><img id="tcaptcha-img" class="tcaptcha-img"></div></div>
    <div class="tcaptcha-status"><div class="tcaptcha-action tcaptcha-action--refresh"><a id="reload" class="tcaptcha-action-icon"></a></div>
      <div class="tcaptcha-action tcaptcha-action--close"><a id="close" class="tcaptcha-action-icon"></a></div></div></div>`, { url, runScripts: 'outside-only' })
  windows.push(dom)
  Object.defineProperty(dom.window.document, 'readyState', { get: () => 'complete' })
  Object.defineProperties(dom.window, { innerWidth: { value: 360 }, innerHeight: { value: 360 } })
  vi.spyOn(dom.window.Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const rect = this.matches('.tcaptcha-window') ? [0, 0, 360, 360]
      : this.matches('.tcaptcha-header') ? [10, 0, 340, 64]
        : this.matches('.tcaptcha-status') ? [10, 318, 340, 22]
          : this.matches('#close') ? [320, 318, 22, 22]
            : this.matches('#reload') ? [282, 318, 21, 21] : [10, 64, 340, 230]
    return { x: rect[0], y: rect[1], width: rect[2], height: rect[3] } as DOMRect
  })
  const image = dom.window.document.querySelector('img')!
  Object.defineProperties(image, { complete: { value: true, configurable: true }, naturalWidth: { value: 680, configurable: true }, naturalHeight: { value: 460, configurable: true } })
  return { dom, document: dom.window.document, image, inspect: () => dom.window.eval(huyaLoginAdapter.challengeInspectScript!) as LoginPageSnapshot }
}

describe('Huya official iframe adapter', () => {
  it('prepares SMS country and phone without send availability or clicks, and keeps equal preparation inert', async () => {
    const f = fixture('sms')
    f.document.querySelector('.get-sms-code')!.setAttribute('enabled', '0')
    const phone = f.document.querySelector<HTMLInputElement>('.udb-input-tel')!
    const changed = vi.fn()
    phone.addEventListener('input', changed)
    const country = vi.fn()
    f.document.querySelector('.sel-areas-list li:last-child')!.addEventListener('click', country)
    const action: LoginCardAction = { kind: 'prepare-sms', countryCode: '+65', phone: '81234567', accepted: true }
    expect(await f.act(action)).toEqual({ ok: true })
    expect(await f.act(action)).toEqual({ ok: true })
    expect(phone.value).toBe('81234567')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(country).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.smsSubmit).not.toHaveBeenCalled()
    expect(f.passwordSubmit).not.toHaveBeenCalled()
    expect(f.inspect().sms?.canSend).toBe(false)
  })

  it.each([
    ['获取验证码', '1', true, 0], ['重新获取', '2', true, 0], ['重新获取(42s)', '0', false, 42],
    ['获取验证码', '0', false, null], ['请求中', '0', false, null], ['获取验证码', '', false, null],
  ] as const)('uses the official SMS caption %s and enabled attribute %s', async (caption, enabled, canSend, cooldownSeconds) => {
    const f = fixture('sms')
    const button = f.document.querySelector('.get-sms-code')!
    button.textContent = caption
    button.setAttribute('enabled', enabled)
    expect(f.inspect().sms).toEqual({ canSend, cooldownSeconds })
  })

  it('does not reselect country or redispatch phone events when submitting the same SMS identity after captcha', async () => {
    const f = fixture('sms')
    const phone = f.document.querySelector<HTMLInputElement>('.udb-input-tel')!
    const changed = vi.fn()
    const country = vi.fn()
    let captchaPassed = false
    phone.addEventListener('input', () => { changed(); captchaPassed = false })
    f.document.querySelector('.sel-areas-list li')!.addEventListener('click', () => { country(); captchaPassed = false })
    expect(await f.act({ kind: 'send-sms', countryCode: '+86', phone: '13800000000', accepted: true })).toEqual({ ok: true })
    captchaPassed = true
    changed.mockClear()
    country.mockClear()
    f.document.querySelector('.get-sms-code')!.setAttribute('enabled', '0')
    f.document.querySelector('.get-sms-code')!.textContent = '重新获取(59s)'
    expect(await f.act({ kind: 'sms', countryCode: '+86', phone: '13800000000', code: '123456', accepted: true })).toEqual({ ok: true })
    expect(changed).not.toHaveBeenCalled()
    expect(country).not.toHaveBeenCalled()
    expect(captchaPassed).toBe(true)
    expect(f.smsSubmit).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('waits for the next DOM task to enable password submit and clicks only once', async () => {
    const f = fixture()
    const submit = f.document.querySelector('#login-btn')!
    submit.setAttribute('disabled', '')
    f.document.querySelector('#password')!.addEventListener('input', () => f.dom.window.setTimeout(() => submit.removeAttribute('disabled'), 0))
    expect(await f.act({ kind: 'password', username: 'fixture', password: 'fixture', accepted: true })).toEqual({ ok: true })
    expect(f.passwordSubmit).toHaveBeenCalledTimes(1)
  })

  it('reports the complete trusted Tencent card including its close/refresh row instead of the enclosing mask', async () => {
    const f = fixture()
    const panel = mountTencentCard(f.document)
    f.document.body.insertAdjacentHTML('beforeend', '<div id="tcaptcha_wrapper_transform_drag"></div>')
    f.document.querySelector('#tcaptcha_wrapper_transform_drag')!.appendChild(panel)
    Object.defineProperty(f.document.querySelector('#tcaptcha_wrapper_transform_drag')!, 'getBoundingClientRect', { value: () => ({ x: 0, y: 0, width: 1000, height: 700 }) })
    expect(f.inspect()).toMatchObject({ page: 'challenge', challengePhase: 'interactive', challenge: { x: 100, y: 80, width: 361.333, height: 361.333 } })
  })

  it('reports the full image-code modal including its official confirm controls', async () => {
    const f = fixture('sms')
    f.document.body.insertAdjacentHTML('beforeend', '<div class="layui-layer"><div class="udb-imgcode-item"><input class="udb-input-code"><img></div><a class="layui-layer-btn0">确定</a></div>')
    expect(f.inspect()).toMatchObject({ page: 'challenge', challenge: { width: 160, height: 160 } })
  })

  it('does not crop unverified CDN template documents from their entire iframe viewport', async () => {
    const f = fixture('sms')
    f.document.body.insertAdjacentHTML('beforeend', '<iframe src="https://captcha.gtimg.com/template/drag_ele.html"></iframe>')
    expect(f.inspect()).toEqual({ page: 'unknown', qrStatus: 'paused' })
  })

  it('observes a Tencent challenge attached to the official parent and never opens login again', async () => {
    const dom = new JSDOM('<a class="LoginHd--fixture">登录</a>', { url: 'https://www.huya.com/', runScripts: 'outside-only' })
    windows.push(dom)
    mountTencentCard(dom.window.document)
    expect(dom.window.eval(huyaLoginAdapter.inspectScript)).toMatchObject({ page: 'challenge', challenge: { x: 100, y: 80, width: 361.333, height: 361.333 } })
    expect(huyaLoginAdapter.acceptsFrame('https://www.huya.com/')).toBe(true)
    expect(dom.window.document.querySelector('a')!.hasAttribute('data-fy1sync-login-prepared')).toBe(false)
  })

  it('does not mistake the Tencent auto-bind trigger for a mounted challenge', () => {
    const f = fixture()
    f.document.body.insertAdjacentHTML('beforeend', '<button id="TencentCaptcha">验证</button>')
    expect(f.inspect().page).toBe('form')
  })

  it('keeps initialization and an opacity-zero trusted native card in loading without a crop', () => {
    const f = fixture()
    f.document.body.insertAdjacentHTML('beforeend', '<div id="t_verify" class="t-verify"><div id="verify_icon"></div></div>')
    expect(f.inspect()).toEqual({ page: 'loading', challengePhase: 'loading', qrStatus: 'paused' })
    f.document.querySelector('#t_verify')!.remove()
    const panel = mountTencentCard(f.document)
    panel.style.opacity = '0'
    expect(f.inspect()).toEqual({ page: 'loading', challengePhase: 'loading', qrStatus: 'paused' })
    panel.style.opacity = '1'
    expect(f.inspect()).toMatchObject({ page: 'challenge', challengePhase: 'interactive' })
  })

  it.each(['https://evil.test/cap_union_new_show', 'http://t.captcha.qq.com/cap_union_new_show', 'https://t.captcha.qq.com/other', 'https://user@t.captcha.qq.com/cap_union_new_show'])('does not trust a Tencent ID with iframe URL %s', url => {
    const f = fixture()
    mountTencentCard(f.document).querySelector('iframe')!.src = url
    expect(f.inspect()).toEqual({ page: 'unknown', challengePhase: 'unknown', qrStatus: 'paused' })
  })

  it('keeps a full-screen wrapper and bare trusted iframe out of the cropped challenge', () => {
    const f = fixture()
    f.document.body.insertAdjacentHTML('beforeend', '<div id="tcaptcha_wrapper_transform_drag"><iframe src="https://t.captcha.qq.com/cap_union_new_show"></iframe></div>')
    expect(f.inspect()).toEqual({ page: 'loading', challengePhase: 'unknown', qrStatus: 'paused' })
    expect(f.inspect().challenge).toBeUndefined()
  })

  it('returns loading after the official form disappears so main can verify server identity', async () => {
    const f = fixture()
    for (const selector of ['#login-head-nav', '#account-login-form', '#phone-login-form']) f.document.querySelector(selector)!.remove()
    expect(f.inspect()).toMatchObject({ page: 'loading' })
  })

  it.each(['password', 'sms'] as const)('recognizes the verified %s form and exact official QR image', async mode => {
    expect(fixture(mode).inspect()).toMatchObject({ page: 'form', mode, qrStatus: 'ready', qr: { src: 'https://udblgn.huya.com/qrLgn/getQrImg?k=fixture&appId=5002' } })
  })

  it('never reads inputs or cookies while producing its secret-free snapshot', async () => {
    const f = fixture()
    for (const input of f.document.querySelectorAll('input')) Object.defineProperty(input, 'value', { get: () => { throw new Error('Secret read') } })
    Object.defineProperty(f.document, 'cookie', { get: () => { throw new Error('Cookie read') } })
    expect(f.inspect().page).toBe('form')
    expect(JSON.stringify(f.inspect())).not.toMatch(/username|passwordValue|token|cookie/i)
  })

  it('sets account and password through native setters then performs exactly one official login click', async () => {
    const f = fixture()
    const input = f.document.querySelector<HTMLInputElement>('#password')!
    const events: string[] = []
    Object.defineProperty(input, 'value', { set: () => { throw new Error('Custom setter') } })
    for (const type of ['input', 'change', 'keyup']) input.addEventListener(type, () => events.push(type))
    expect(await f.act({ kind: 'password', username: '13800000000', password: "Pass'<x>123", accepted: true })).toEqual({ ok: true })
    expect(Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!.get!.call(input)).toBe("Pass'<x>123")
    expect(events).toEqual(['input', 'change'])
    expect(f.passwordSubmit).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.smsSubmit).not.toHaveBeenCalled()
  })

  it('switches modes with a single official navigation click and no network action', async () => {
    const f = fixture()
    const click = vi.fn()
    f.document.querySelector('[udb-eid="12"]')!.addEventListener('click', click)
    expect(await f.act({ kind: 'mode', mode: 'sms' })).toEqual({ ok: true })
    expect(f.inspect().mode).toBe('sms')
    expect(click).toHaveBeenCalledTimes(1)
    expect(f.passwordSubmit).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each(['+86', '+65'])('selects supported %s with the actual official option and sends SMS once', async countryCode => {
    const f = fixture('sms')
    expect(await f.act({ kind: 'send-sms', countryCode, phone: countryCode === '+86' ? '13800000000' : '81234567', accepted: true })).toEqual({ ok: true })
    expect(f.document.querySelector('.sel-areas')!.getAttribute('areascode')).toBe(countryCode.slice(1))
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.smsSubmit).not.toHaveBeenCalled()
  })

  it('fills the supplied SMS code and clicks submit once without another SMS request', async () => {
    const f = fixture('sms')
    expect(await f.act({ kind: 'sms', countryCode: '+65', phone: '81234567', code: '123456', accepted: true })).toEqual({ ok: true })
    expect(f.document.querySelector<HTMLInputElement>('#phone-login-form .udb-input-code')!.value).toBe('123456')
    expect(f.smsSubmit).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('rejects missing country options or unsynchronized official selection before filling the phone', async () => {
    const f = fixture('sms')
    expect(await f.act({ kind: 'send-sms', countryCode: '+999', phone: '81234567', accepted: true })).toEqual({ ok: false, reason: 'unsupported' })
    f.document.querySelector('.sel-areas-list')!.innerHTML = '<li><span class="areasNumber" areascode="44">+44</span></li>'
    expect(await f.act({ kind: 'send-sms', countryCode: '+44', phone: '81234567', accepted: true })).toEqual({ ok: false, reason: 'unsupported' })
    expect(f.document.querySelector<HTMLInputElement>('.udb-input-tel')!.value).toBe('')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('respects SMS cooldown and rejects bad inputs or missing agreement without sending', async () => {
    const f = fixture('sms')
    expect(await f.act({ kind: 'sms', phone: '13800000000', countryCode: '+86', code: '123', accepted: true })).toMatchObject({ ok: false, reason: 'invalid-input' })
    expect(await f.act({ kind: 'send-sms', phone: '81234567', countryCode: '+86', accepted: true })).toMatchObject({ ok: false, reason: 'invalid-input' })
    expect(await f.act({ kind: 'send-sms', phone: '81234567', countryCode: '+65', accepted: false } as unknown as LoginCardAction)).toMatchObject({ ok: false, reason: 'invalid-input' })
    const send = f.document.querySelector('.get-sms-code')!
    send.setAttribute('enabled', '0')
    send.textContent = '重新获取(37s)'
    expect(f.inspect().sms).toEqual({ canSend: false, cooldownSeconds: 37 })
    expect(await f.act({ kind: 'send-sms', phone: '13800000000', countryCode: '+86', accepted: true })).toMatchObject({ ok: false, reason: 'not-ready' })
    expect(f.send).not.toHaveBeenCalled()
  })

  it('prioritizes visible image captcha or Tencent challenge over the basic form', async () => {
    const f = fixture()
    f.document.querySelector<HTMLElement>('.udb-imgcode-item')!.style.display = ''
    expect(f.inspect()).toMatchObject({ page: 'challenge', qrStatus: 'paused' })
    expect(await f.act({ kind: 'password', username: 'fixture', password: 'fixture', accepted: true })).toMatchObject({ ok: false })
    expect(f.passwordSubmit).not.toHaveBeenCalled()
  })

  it.each(['.udb-yycode-item', '#login-pop', '#register-main'])('keeps unverified subsequent workflow %s on the official page', async selector => {
    const f = fixture()
    f.document.querySelector<HTMLElement>(selector)!.style.display = ''
    expect(f.inspect()).toEqual({ page: 'unknown', qrStatus: 'paused' })
    expect(await f.act({ kind: 'second-submit', code: '123456' })).toEqual({ ok: false, reason: 'unsupported' })
    expect(f.passwordSubmit).not.toHaveBeenCalled()
  })

  it('does not mistake unexpected visible inputs for a basic form', async () => {
    const f = fixture()
    f.document.querySelector('#account-login-form')!.insertAdjacentHTML('beforeend', '<input id="new-second-factor">')
    expect(f.inspect().page).toBe('unknown')
  })

  it('keeps an unrecognized visible security iframe on the official page', async () => {
    const f = fixture()
    f.document.body.insertAdjacentHTML('beforeend', '<iframe src="https://aq.huya.com/p/new-auth-step"></iframe>')
    expect(f.inspect()).toEqual({ page: 'unknown', qrStatus: 'paused' })
    expect(await f.act({ kind: 'password', username: 'fixture', password: 'fixture', accepted: true })).toMatchObject({ ok: false })
    expect(f.passwordSubmit).not.toHaveBeenCalled()
  })

  it('uses scanned/expired official DOM state and only clicks the official refresh control', async () => {
    const f = fixture()
    f.document.querySelector<HTMLElement>('#scan-success')!.style.display = ''
    expect(f.inspect().qrStatus).toBe('scanned')
    f.document.querySelector<HTMLElement>('#qr-invalid')!.style.display = ''
    const click = vi.fn()
    f.document.querySelector('#qr-invalid .refresh')!.addEventListener('click', click)
    expect(await f.act({ kind: 'refresh-qr' })).toEqual({ ok: true })
    expect(click).toHaveBeenCalledTimes(1)
    expect(f.passwordSubmit).not.toHaveBeenCalled()
  })

  it('initializes the parent official login component at most once without touching any form', async () => {
    const dom = new JSDOM('<a class="LoginHd--fixture">登录</a>', { url: 'https://www.huya.com/', runScripts: 'outside-only' })
    windows.push(dom)
    const click = vi.fn()
    dom.window.document.querySelector('a')!.addEventListener('click', click)
    expect(dom.window.eval(huyaLoginAdapter.prepareScript!)).toEqual({ ok: true })
    expect(dom.window.eval(huyaLoginAdapter.prepareScript!)).toEqual({ ok: true })
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('only accepts the fixed official iframe and returns error categories instead of diagnostic text', async () => {
    const f = fixture()
    f.document.querySelector('.input-error-tips')!.textContent = '密码错误 fixture-private-diagnostic'
    expect(f.inspect().error).toBe('invalid-credentials')
    expect(JSON.stringify(f.inspect())).not.toContain('fixture-private-diagnostic')
    expect(huyaLoginAdapter.acceptsFrame('https://aq.huya.com/p/udb_login.html?v=fixture')).toBe(true)
    for (const url of ['http://aq.huya.com/p/udb_login.html', 'https://user@aq.huya.com/p/udb_login.html', 'https://aq.huya.com:8443/p/udb_login.html', 'https://aq.huya.com.evil.test/p/udb_login.html', 'https://aq.huya.com/p/find.html']) expect(huyaLoginAdapter.acceptsFrame(url)).toBe(false)
    expect(HUYA_QR_POLL_PATHS).toEqual(['/qrLgn/tryQrLogin'])
  })
})

describe('Huya Tencent read-only challenge inspection', () => {
  it('accepts only the observed HTTPS vendor document while keeping it outside account actions', async () => {
    expect(huyaLoginAdapter.acceptsChallengeFrame!('https://t.captcha.qq.com/cap_union_new_show?aid=2027709410')).toBe(true)
    expect(huyaLoginAdapter.acceptsFrame('https://t.captcha.qq.com/cap_union_new_show?aid=2027709410')).toBe(false)
    for (const url of [
      'http://t.captcha.qq.com/cap_union_new_show', 'https://t.captcha.qq.com:8443/cap_union_new_show',
      'https://user@t.captcha.qq.com/cap_union_new_show', 'https://t.captcha.qq.com.evil.test/cap_union_new_show',
      'https://captcha.qq.com/cap_union_new_show', 'https://t.captcha.qq.com/template/drag_ele.html',
      'https://captcha.gtimg.com/template/drag_ele.922e8e90.html',
    ]) {
      expect(huyaLoginAdapter.acceptsChallengeFrame!(url)).toBe(false)
      expect(tencentFixture(url).inspect()).toEqual({ page: 'unknown' })
    }
    const f = tencentFixture()
    f.document.body.insertAdjacentHTML('beforeend', '<input id="username"><input id="password"><button id="login-btn"></button>')
    const click = vi.fn()
    f.document.querySelector('button')!.addEventListener('click', click)
    expect(await f.dom.window.eval(huyaLoginAdapter.actionScript({ kind: 'password', username: 'fixture', password: 'fixture', accepted: true }))).toEqual({ ok: false, reason: 'not-ready' })
    expect(click).not.toHaveBeenCalled()
  })

  it('reports the original 360px complete card with close and refresh controls, including a card-sized vendor viewport', () => {
    const f = tencentFixture()
    expect(f.inspect()).toEqual({ page: 'challenge', challengePhase: 'interactive', qrStatus: 'paused', challenge: { x: 0, y: 0, width: 360, height: 360 } })
  })

  it.each(['#close', '#reload', '.tcaptcha-header', '.tcaptcha-status'])('does not expose an incomplete challenge missing %s', selector => {
    const f = tencentFixture()
    f.document.querySelector(selector)!.remove()
    expect(f.inspect()).toEqual({ page: 'loading', challengePhase: 'unknown', qrStatus: 'paused' })
  })

  it('waits for a decoded image and honors visible refresh/result layers over a still-mounted decoded image', () => {
    const f = tencentFixture()
    Object.defineProperty(f.image, 'complete', { value: false, configurable: true })
    expect(f.inspect()).toEqual({ page: 'loading', challengePhase: 'loading', qrStatus: 'paused' })
    Object.defineProperty(f.image, 'complete', { value: true, configurable: true })
    f.document.querySelector<HTMLElement>('#tcaptcha_refresh')!.style.display = ''
    expect(f.inspect()).toEqual({ page: 'loading', challengePhase: 'loading', qrStatus: 'paused' })
    f.document.querySelector<HTMLElement>('#tcaptcha_refresh')!.style.display = 'none'
    f.document.querySelector<HTMLElement>('#tcaptcha_success')!.style.display = ''
    expect(f.inspect()).toEqual({ page: 'loading', challengePhase: 'passed', qrStatus: 'paused' })
    f.document.querySelector<HTMLElement>('#tcaptcha_success')!.style.display = 'none'
    expect(f.inspect().challengePhase).toBe('interactive')
  })

  it('rejects hidden controls and controls outside the complete card instead of cropping them away', () => {
    const f = tencentFixture()
    const close = f.document.querySelector<HTMLElement>('#close')!
    close.style.display = 'none'
    expect(f.inspect().challengePhase).toBe('unknown')
    close.style.display = ''
    Object.defineProperty(close, 'getBoundingClientRect', { value: () => ({ x: 359, y: 318, width: 22, height: 22 }) })
    expect(f.inspect().challengePhase).toBe('unknown')
    expect(f.inspect().challenge).toBeUndefined()
  })

  it('does not use a full-screen mask, ambiguous duplicate cards or unsupported image-less content as interactive geometry', () => {
    const f = tencentFixture()
    f.document.body.insertAdjacentHTML('beforeend', '<div id="tcaptcha_wrapper_transform_drag"></div>')
    expect(f.inspect().challenge).toEqual({ x: 0, y: 0, width: 360, height: 360 })
    const second = f.document.querySelector('.tcaptcha-window')!.cloneNode(true)
    f.document.body.appendChild(second)
    expect(f.inspect()).toEqual({ page: 'loading', challengePhase: 'unknown', qrStatus: 'paused' })
  })

  it('returns only geometry and phase without reading input values, cookies, image URLs, puzzle text or URL query values', () => {
    const f = tencentFixture()
    f.document.body.insertAdjacentHTML('beforeend', '<input value="private-value">')
    Object.defineProperty(f.document.querySelector('input')!, 'value', { get: () => { throw new Error('Secret read') } })
    Object.defineProperty(f.document, 'cookie', { get: () => { throw new Error('Cookie read') } })
    Object.defineProperty(f.image, 'src', { get: () => { throw new Error('Image URL read') } })
    Object.defineProperty(f.document.querySelector('.tcaptcha-title')!, 'textContent', { get: () => { throw new Error('Puzzle text read') } })
    Object.defineProperty(f.dom.window.URL.prototype, 'searchParams', { get: () => { throw new Error('Query values read') } })
    expect(f.inspect()).toEqual({ page: 'challenge', challengePhase: 'interactive', qrStatus: 'paused', challenge: { x: 0, y: 0, width: 360, height: 360 } })
  })
})
