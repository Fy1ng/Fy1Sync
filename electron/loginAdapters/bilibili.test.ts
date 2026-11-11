// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoginCardAction, LoginPageSnapshot } from '../loginCardContracts'
import { bilibiliLoginAdapter, bilibiliLoginQrPollPath } from './bilibili'

const qr = '<div class="login-scan__qrcode"><canvas></canvas></div>'
const passwordForm = `<div id="app">${qr}<div class="main__right"><div class="tabs_wp"><div class="tab_active">密码登录</div><div></div><div>短信登录</div></div><div class="login-pwd"><div class="tab__form"><div class="form__item"><input type="text"></div><div class="form__item"><input type="password"></div></div><div class="btn_wp"><div class="btn_primary disabled">登录</div></div></div></div></div>`
const smsForm = `<div id="app">${qr}<div class="main__right"><div class="tabs_wp"><div>密码登录</div><div></div><div class="tab_active">短信登录</div></div><div class="tab-sms"><div class="tab__form"><div class="form__item"><div class="tab-sms__cid">+86</div><input placeholder="请输入手机号"><div class="tab-sms__vertical-line"></div><div class="clickable" disabled>获取验证码</div></div><div class="form__item"><div>验证码</div><input placeholder="请输入验证码"></div></div><div class="btn_wp"><div class="btn_primary disabled">登录/注册</div></div><div class="area-code-select" style="display:none"><div class="option"><span>中国大陆</span><span>+86</span></div><div class="option"><span>新加坡</span><span>+65</span></div></div></div></div></div>`

// Public click.3.1.0 and slide.7.9.3 templates, without SDK secrets or network activity.
const clickPuzzle = '<div class="geetest_holder geetest_silver"><div class="geetest_widget"><div class="geetest_head"><div class="geetest_tips"><div class="geetest_tip_content">请依次点击</div></div></div><div class="geetest_table_box"><div class="geetest_window"><div class="geetest_item geetest_big_item"><div class="geetest_item_wrap"><img class="geetest_item_img"></div></div></div><div class="geetest_result_tip" style="display:none"></div></div><div class="geetest_panel"><div class="geetest_small"><a class="geetest_close"></a><a class="geetest_refresh"></a></div><a class="geetest_commit geetest_disable"><div class="geetest_commit_tip">确认</div></a></div></div></div>'
const sliderPuzzle = '<div class="geetest_holder geetest_silver"><div class="geetest_widget"><div class="geetest_window"><a class="geetest_link"><div class="geetest_canvas_img"><div class="geetest_slicebg"><canvas class="geetest_canvas_bg"></canvas><canvas class="geetest_canvas_slice"></canvas></div></div></a><a class="geetest_refresh"></a><div class="geetest_loading" style="display:none"><div class="geetest_loading_icon"></div></div><div class="geetest_result" style="display:none"></div></div></div><div class="geetest_slider"><div class="geetest_slider_track"><div class="geetest_slider_tip">拖动滑块</div></div><div class="geetest_slider_button"></div></div><a class="geetest_close"></a></div>'
function bindPuzzle(kind: 'click' | 'slide') {
  return `<div class="geetest_panel geetest_wind"><div class="geetest_panel_ghost"></div><div class="geetest_panel_box geetest_panelshow${kind}"><div class="geetest_panel_loading" style="display:none"></div><div class="geetest_panel_success" style="display:none"></div><div class="geetest_panel_error" style="display:none"></div><div class="geetest_panel_footer" style="display:none"></div><div class="geetest_panel_next">${kind === 'click' ? clickPuzzle : sliderPuzzle}</div></div></div>`
}
// Official gcaptcha4 v1.9.7 bind DOM, observed with the public slide demo ID and Bilibili module797.
// Its stable classes use geetest_, while per-instance hash classes and puzzle resources are omitted.
const v4BindSlide = `<div class="geetest_captcha geetest_bind geetest_boxShow geetest_freeze_wait"><div class="geetest_box_wrap"><div class="geetest_box"><div class="geetest_header"><div class="geetest_title"><span class="geetest_text_tips">拖动滑块完成拼图</span></div><div class="geetest_status_bar"></div></div><div class="geetest_container"><div class="geetest_wrap"><div class="geetest_subitem geetest_slide"><div class="geetest_window"><div class="geetest_slice"><div class="geetest_slice_bg"></div></div><div class="geetest_bg" style="background-image:url(https://static.geetest.com/synthetic-v4.jpg)"></div></div><div class="geetest_result_tips"></div><div class="geetest_slider"><div class="geetest_track"></div><div class="geetest_btn"></div></div></div></div></div><div class="geetest_footer"><div class="geetest_footer_left"><div class="geetest_close"></div><div class="geetest_close_tips" style="opacity:0"></div><div class="geetest_refresh"></div></div></div></div><div class="geetest_bind_box" style="display:none"><div class="geetest_bind_container"><div class="geetest_bind_success_box"><div class="geetest_success_show"></div></div><div class="geetest_bind_tips"></div></div></div><div class="geetest_box_layer"><div class="geetest_box_btn" style="display:none"></div></div><div class="geetest_popup_ghost"></div></div></div>`
// Decoded v4 commonTemplate and its click/canvas branches; all resources and content are synthetic.
const v4ClickSurface = '<div class="geetest_window"><div class="geetest_bg" style="background-image:url(https://static.geetest.com/synthetic-v4-click.png)"></div></div><div class="geetest_submit geetest_disable"><div class="geetest_submit_tips">确认</div></div>'
function v4Card(content = v4ClickSurface, kind = 'word', product: 'bind' | 'popup' = 'bind') {
  const owner = product === 'bind' ? 'geetest_captcha geetest_bind' : 'geetest_popup_wrap geetest_popup'
  return `<div class="${owner} geetest_boxShow geetest_nextReady geetest_freeze_wait"><div class="geetest_box_wrap"><div class="geetest_box"><div class="geetest_header"><div class="geetest_title"><span class="geetest_text_tips">请完成验证</span><div class="geetest_ques_tips"></div></div><div class="geetest_status_bar"></div></div><div class="geetest_container"><div class="geetest_wrap"><div class="geetest_result_tips"></div><div class="geetest_subitem geetest_${kind}">${content}</div></div></div><div class="geetest_footer"><div class="geetest_footer_left"><button class="geetest_close"></button><button class="geetest_refresh"></button></div><div class="geetest_footer_right"></div></div></div><div class="geetest_bind_box" style="display:none"><div class="geetest_bind_container"><div class="geetest_success_show"></div></div></div></div><div class="geetest_popup_ghost"></div></div>`
}
const makeRect = (x: number, y: number, width: number, height: number): DOMRect => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) })
function layoutCard(selector: string, rect = makeRect(300, 150, 320, 410)) {
  const card = document.querySelector<HTMLElement>(selector)!
  setRect(card, rect)
  for (const element of card.querySelectorAll<HTMLElement>('*')) setRect(element, rect)
  return card
}

function secondForm(kind: 'phone' | 'email', target = kind === 'phone' ? '138****1234' : 'test***@example.com') {
  return `<div id="riskWp" class="risk-verify_wp"><div class="risk-check-${kind}_wp"><div class="risk-static-header_wp"><div class="risk-static-text-value">${target}</div></div><div class="risk-from-content"><div class="risk-input-wp"><input class="risk-input-dom" type="text" maxlength="6"><div class="risk-input-after-active">获取验证码</div></div><div class="risk-bottom-btn disable">下一步</div></div></div></div>`
}

function execute(script: string, url = 'https://passport.bilibili.com/login'): unknown {
  return new Function('document', 'location', 'HTMLElement', 'HTMLInputElement', 'HTMLImageElement', 'Event', 'getComputedStyle', `return ${script}`)(
    document, new URL(url), HTMLElement, HTMLInputElement, HTMLImageElement, Event, getComputedStyle,
  )
}

function inspect(url?: string): LoginPageSnapshot {
  return execute(bilibiliLoginAdapter.inspectScript, url) as LoginPageSnapshot
}

async function act(action: LoginCardAction, url?: string): Promise<unknown> {
  return await execute(bilibiliLoginAdapter.actionScript(action), url)
}

function setRect(element: HTMLElement, rect: DOMRect) {
  Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => rect })
}

beforeEach(() => {
  document.body.replaceChildren()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.tagName === 'CANVAS' ? 140 : 100
    const height = this.tagName === 'CANVAS' ? 140 : 30
    return { x: 10, y: 20, width, height, left: 10, top: 20, right: 10 + width, bottom: 20 + height, toJSON: () => ({}) }
  })
})

function resetLatch() {
  const latchWindow = window as Window & { __fy1syncBiliErrorLatch?: { observer?: MutationObserver; timer?: number } }
  const latch = latchWindow.__fy1syncBiliErrorLatch
  latch?.observer?.disconnect()
  if (latch?.timer !== undefined) window.clearTimeout(latch.timer)
  delete latchWindow.__fy1syncBiliErrorLatch
}

afterEach(() => {
  resetLatch()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('Bilibili official login broker adapter', () => {
  it('allows exact official form documents and publishes the official QR polling path', () => {
    expect(bilibiliLoginAdapter.entryUrl).toBe('https://passport.bilibili.com/login')
    expect(bilibiliLoginQrPollPath).toBe('/x/passport-login/web/qrcode/poll')
    for (const url of ['https://passport.bilibili.com/login', 'https://passport.bilibili.com/pc/passport/login', 'https://passport.bilibili.com/pc/passport/riskVerify?tmp_token=not-read']) expect(bilibiliLoginAdapter.acceptsFrame(url)).toBe(true)
    for (const url of ['http://passport.bilibili.com/login', 'https://passport.bilibili.com:1234/login', 'https://user@passport.bilibili.com/login', 'https://passport.bilibili.com.evil.test/login', 'https://passport.bilibili.com/riskVerify', 'https://passport.bilibili.com/pc/passport/findPassword', 'https://api.geetest.com/captcha', 'https://www.bilibili.com/correspond/0', 'bad']) expect(bilibiliLoginAdapter.acceptsFrame(url)).toBe(false)
  })

  it('inspects forms and QR geometry without reading any input, cookie or storage', () => {
    document.body.innerHTML = passwordForm
    for (const input of document.querySelectorAll('input')) Object.defineProperty(input, 'value', { get() { throw Error('Input read forbidden') }, set() { throw Error('Input write forbidden') } })
    const result = inspect()
    expect(result).toEqual({ page: 'form', mode: 'password', qrStatus: 'ready', qr: { rect: { x: 10, y: 20, width: 140, height: 140 } }, sms: { canSend: false, cooldownSeconds: null } })
    expect(bilibiliLoginAdapter.inspectScript).not.toMatch(/document\.cookie|localStorage|sessionStorage|\.value\b|tmp_token|captcha_key|\.search\b/)
  })

  it('detects visible challenges before forms and security-code components', async () => {
    document.body.innerHTML = passwordForm + secondForm('phone') + '<div class="geetest4_popup">图形验证</div>'
    expect(inspect('https://passport.bilibili.com/pc/passport/riskVerify')).toEqual({ page: 'challenge', challengePhase: 'unknown', qrStatus: 'paused' })
    const click = vi.fn()
    document.querySelector('.btn_primary')!.addEventListener('click', click)
    expect(await act({ kind: 'password', username: 'sentinel', password: 'sentinel', accepted: true })).toEqual({ ok: false, reason: 'unsupported' })
    expect(click).not.toHaveBeenCalled()
    document.querySelector('.geetest4_popup')!.setAttribute('style', 'display:none')
    expect(inspect('https://passport.bilibili.com/pc/passport/riskVerify').page).toBe('second-factor')
  })

  it('detects only visible CAPTCHA frames and does not report their URLs', () => {
    document.body.innerHTML = passwordForm + '<iframe title="验证码" src="https://api.geetest.com/captcha?token=PRIVATE"></iframe>'
    expect(inspect()).toEqual({ page: 'challenge', challengePhase: 'unknown', qrStatus: 'paused' })
    expect(JSON.stringify(inspect())).not.toContain('PRIVATE')
  })

  it('recognizes official single SMS/email steps and returns masked targets only', () => {
    const url = 'https://passport.bilibili.com/pc/passport/riskVerify?tmp_token=PRIVATE'
    for (const kind of ['phone', 'email'] as const) {
      document.body.innerHTML = secondForm(kind)
      Object.defineProperty(document.querySelector('input')!, 'value', { get() { throw Error('OTP read forbidden') } })
      expect(inspect(url)).toEqual({ page: 'second-factor', qrStatus: 'paused', verification: { kind: kind === 'phone' ? 'sms' : 'email', maskedTarget: kind === 'phone' ? '138****1234' : 'test***@example.com' }, sms: { canSend: true, cooldownSeconds: null } })
    }
    document.body.innerHTML = secondForm('phone', '13812345678')
    expect(inspect(url).verification).toEqual({ kind: 'sms' })
    document.body.innerHTML = secondForm('phone', '13812345678***')
    expect(inspect(url).verification).toEqual({ kind: 'sms' })
    document.body.innerHTML = secondForm('email', 'private@example.com')
    expect(inspect(url).verification).toEqual({ kind: 'email' })
    expect(JSON.stringify(inspect(url))).not.toMatch(/private|PRIVATE/)
  })

  it('falls back for an anonymous missing-token page, binding step or ambiguous component', async () => {
    const url = 'https://passport.bilibili.com/pc/passport/riskVerify'
    for (const html of ['<div id="riskWp"></div>', '<div class="risk-bind-phone_wp"><input><input></div>', secondForm('phone') + secondForm('email')]) {
      document.body.innerHTML = html
      expect(inspect(url)).toEqual({ page: 'unknown', qrStatus: 'paused' })
      expect(await act({ kind: 'second-send' }, url)).toEqual({ ok: false, reason: 'unsupported' })
      expect(await act({ kind: 'second-submit', code: '123456' }, url)).toEqual({ ok: false, reason: 'unsupported' })
    }
    document.body.innerHTML = secondForm('phone')
    expect(inspect(`${url}?scene=unverifiedNewFlow`)).toEqual({ page: 'unknown', qrStatus: 'paused' })
    expect(await act({ kind: 'second-send' }, `${url}?scene=unverifiedNewFlow`)).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('fills password once through native setters and delivers official input/change events', async () => {
    document.body.innerHTML = passwordForm
    const inputs = [...document.querySelectorAll('input')]
    const events: string[] = []
    const button = document.querySelector('.btn_primary')!
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    for (const [index, input] of inputs.entries()) {
      Object.defineProperty(input, 'value', { get() { throw Error('Adapter input getter forbidden') }, set() { throw Error('Own input setter forbidden') } })
      input.addEventListener('input', () => { events.push(`${index}:input`); queueMicrotask(() => button.classList.remove('disabled')) })
      input.addEventListener('change', () => events.push(`${index}:change`))
    }
    expect(await act({ kind: 'password', username: 'USER_SENTINEL', password: "PW_SENTINEL';throw 1;//", accepted: true })).toEqual({ ok: true })
    expect(events).toEqual(['0:input', '0:change', '1:input', '1:change'])
    expect(clicked).toHaveBeenCalledTimes(1)
    const getter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!
    expect(getter.call(inputs[0])).toBe('USER_SENTINEL')
    expect(getter.call(inputs[1])).toBe("PW_SENTINEL';throw 1;//")
    expect(JSON.stringify(inspect())).not.toContain('SENTINEL')
  })

  it('rejects invalid payloads or mismatched modes before filling anything', async () => {
    document.body.innerHTML = passwordForm
    const getter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!
    for (const action of [
      { kind: 'password', username: 'sentinel', password: 'sentinel', accepted: false },
      { kind: 'password', username: 'sentinel', password: 'x'.repeat(33), accepted: true },
      { kind: 'password', username: 'bad username', password: 'sentinel', accepted: true },
    ]) expect(await act(action as LoginCardAction)).toEqual({ ok: false, reason: 'invalid-input' })
    expect(await act({ kind: 'send-sms', phone: '12345678', countryCode: '86', accepted: true })).toEqual({ ok: false, reason: 'not-ready' })
    expect(getter.call(document.querySelector('input'))).toBe('')
    expect(await act(null as unknown as LoginCardAction)).toEqual({ ok: false, reason: 'invalid-input' })
  })

  it('changes country through official option clicks and sends SMS exactly once', async () => {
    document.body.innerHTML = smsForm
    const root = document.querySelector('.tab-sms')!
    const send = root.querySelector('.clickable')!
    const clicked = vi.fn()
    send.addEventListener('click', clicked)
    root.querySelector('input')!.addEventListener('input', () => queueMicrotask(() => send.removeAttribute('disabled')))
    root.querySelector('.tab-sms__cid')!.addEventListener('click', () => root.querySelector('.area-code-select')!.setAttribute('style', 'display:block'))
    root.querySelectorAll('.option')[1]!.addEventListener('click', () => { root.querySelector('.tab-sms__cid')!.textContent = '+65'; root.querySelector('.area-code-select')!.setAttribute('style', 'display:none') })
    expect(await act({ kind: 'send-sms', phone: '12345678', countryCode: '65', accepted: true })).toEqual({ ok: true })
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(root.querySelector('.tab-sms__cid')!.textContent).toBe('+65')
    expect(JSON.stringify(inspect())).not.toContain('12345678')
  })

  it('fills SMS phone and code and clicks the official login once', async () => {
    document.body.innerHTML = smsForm
    const button = document.querySelector('.btn_primary')!
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    document.querySelectorAll('input')[1]!.addEventListener('input', () => queueMicrotask(() => button.classList.remove('disabled')))
    expect(await act({ kind: 'sms', phone: '12345678', countryCode: '86', code: '123456', accepted: true })).toEqual({ ok: true })
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(inspect())).not.toMatch(/123456/)
  })

  it('uses official single-code send and submit controls without changing sessions', async () => {
    const url = 'https://passport.bilibili.com/pc/passport/riskVerify'
    for (const kind of ['phone', 'email'] as const) {
      document.body.innerHTML = secondForm(kind)
      const input = document.querySelector('input')!
      const send = document.querySelector('.risk-input-after-active')!
      const submit = document.querySelector('.risk-bottom-btn')!
      const sendClicked = vi.fn(), submitted = vi.fn()
      send.addEventListener('click', sendClicked)
      submit.addEventListener('click', submitted)
      input.addEventListener('input', () => queueMicrotask(() => submit.classList.remove('disable')))
      expect(await act({ kind: 'second-send' }, url)).toEqual({ ok: true })
      expect(sendClicked).toHaveBeenCalledTimes(1)
      expect(await act({ kind: 'second-submit', code: '654321' }, url)).toEqual({ ok: true })
      expect(submitted).toHaveBeenCalledTimes(1)
      expect(document.querySelector('input')).toBe(input)
      expect(JSON.stringify(inspect(url))).not.toContain('654321')
    }
  })

  it('reports cooldown and bounded classified errors without leaking original error text', async () => {
    document.body.innerHTML = secondForm('phone') + '<div role="alert">验证码错误 PRIVATE_OTP=123456</div>'
    const send = document.querySelector('.risk-input-after-active')!
    send.className = 'risk-input-after'
    send.textContent = '重新发送(43)'
    const url = 'https://passport.bilibili.com/pc/passport/riskVerify'
    expect(inspect(url)).toEqual({ page: 'second-factor', qrStatus: 'paused', verification: { kind: 'sms', maskedTarget: '138****1234' }, sms: { canSend: false, cooldownSeconds: 43 }, error: 'invalid-code' })
    expect(JSON.stringify(inspect(url))).not.toMatch(/PRIVATE|123456/)
    expect(await act({ kind: 'second-send' }, url)).toEqual({ ok: false, reason: 'not-ready' })
    expect(await act({ kind: 'second-submit', code: 'abc' }, url)).toEqual({ ok: false, reason: 'invalid-input' })
  })

  it('clicks only the requested official mode or expired QR refresh once', async () => {
    document.body.innerHTML = passwordForm
    const modeClicked = vi.fn(), refreshClicked = vi.fn()
    document.querySelector('.tabs_wp > div:last-child')!.addEventListener('click', modeClicked)
    expect(await act({ kind: 'mode', mode: 'sms' })).toEqual({ ok: true })
    expect(modeClicked).toHaveBeenCalledTimes(1)
    document.querySelector('.login-scan__qrcode')!.insertAdjacentHTML('beforeend', '<div class="qrcode__tip">二维码失效 点击刷新</div>')
    document.querySelector('.qrcode__tip')!.addEventListener('click', refreshClicked)
    expect(inspect().qrStatus).toBe('expired')
    expect(await act({ kind: 'refresh-qr' })).toEqual({ ok: true })
    expect(refreshClicked).toHaveBeenCalledTimes(1)
    document.querySelector('.qrcode__tip')!.textContent = '扫码成功 请在手机上确认'
    expect(inspect().qrStatus).toBe('scanned')
    expect(await act({ kind: 'refresh-qr' })).toEqual({ ok: false, reason: 'not-ready' })
    expect(refreshClicked).toHaveBeenCalledTimes(1)
  })

  it('waits for asynchronous official DOM enablement and clicks once after it is ready', async () => {
    document.body.innerHTML = passwordForm
    const button = document.querySelector('.btn_primary')!
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    document.querySelector('input[type="password"]')!.addEventListener('input', () => setTimeout(() => button.classList.remove('disabled'), 60))
    expect(await act({ kind: 'password', username: 'SENTINEL', password: 'SENTINEL', accepted: true })).toEqual({ ok: true })
    expect(clicked).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('times out a permanently disabled official button without submitting or refilling', async () => {
    document.body.innerHTML = passwordForm
    const events = vi.fn(), clicked = vi.fn()
    document.querySelectorAll('input').forEach(input => input.addEventListener('input', events))
    document.querySelector('.btn_primary')!.addEventListener('click', clicked)
    expect(await act({ kind: 'password', username: 'SENTINEL', password: 'SENTINEL', accepted: true })).toEqual({ ok: false, reason: 'not-ready' })
    expect(events).toHaveBeenCalledTimes(2)
    expect(clicked).not.toHaveBeenCalled()
  })

  it('preserves unchanged phone and country controls and their existing CAPTCHA ticket', async () => {
    document.body.innerHTML = smsForm
    const [phone, code] = [...document.querySelectorAll('input')]
    phone!.value = '13812345678'
    const changed = vi.fn(), countryClicked = vi.fn(), submitted = vi.fn()
    let existingTicket = true
    phone!.addEventListener('input', () => { changed(); existingTicket = false })
    phone!.addEventListener('change', changed)
    document.querySelector('.tab-sms__cid')!.addEventListener('click', countryClicked)
    const button = document.querySelector('.btn_primary')!
    code!.addEventListener('input', () => queueMicrotask(() => button.classList.remove('disabled')))
    button.addEventListener('click', submitted)
    expect(await act({ kind: 'sms', phone: '13812345678', countryCode: '86', code: '123456', accepted: true })).toEqual({ ok: true })
    expect(changed).not.toHaveBeenCalled()
    expect(countryClicked).not.toHaveBeenCalled()
    expect(existingTicket).toBe(true)
    expect(submitted).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(inspect())).not.toMatch(/13812345678|123456/)
  })

  it('does not dispatch input/change again when password fields already equal this payload', async () => {
    document.body.innerHTML = passwordForm
    document.querySelector<HTMLInputElement>('input[type="text"]')!.value = 'SENTINEL'
    document.querySelector<HTMLInputElement>('input[type="password"]')!.value = 'SENTINEL'
    document.querySelector('.btn_primary')!.classList.remove('disabled')
    const changed = vi.fn(), submitted = vi.fn()
    document.querySelectorAll('input').forEach(input => { input.addEventListener('input', changed); input.addEventListener('change', changed) })
    document.querySelector('.btn_primary')!.addEventListener('click', submitted)
    expect(await act({ kind: 'password', username: 'SENTINEL', password: 'SENTINEL', accepted: true })).toEqual({ ok: true })
    expect(changed).not.toHaveBeenCalled()
    expect(submitted).toHaveBeenCalledTimes(1)
  })

  it('reads actual SMS send-control availability and both official countdown label formats', () => {
    document.body.innerHTML = smsForm
    const send = document.querySelector('.tab-sms .form__item > .clickable')!
    expect(inspect().sms).toEqual({ canSend: false, cooldownSeconds: null })
    send.removeAttribute('disabled')
    expect(inspect().sms).toEqual({ canSend: true, cooldownSeconds: null })
    send.textContent = '重新发送(47)'
    expect(inspect().sms).toEqual({ canSend: false, cooldownSeconds: 47 })
    send.textContent = '39秒后重新发送'
    expect(inspect().sms).toEqual({ canSend: false, cooldownSeconds: 39 })
    send.textContent = '重新发送'
    send.setAttribute('aria-disabled', 'true')
    expect(inspect().sms).toEqual({ canSend: false, cooldownSeconds: null })
    send.remove()
    expect(inspect().sms).toEqual({ canSend: false, cooldownSeconds: null })
  })

  it('latches the current official transient toast error after its DOM disappears', async () => {
    document.body.innerHTML = passwordForm
    inspect()
    const toast = document.createElement('div')
    toast.className = 'toast__mask'
    toast.innerHTML = '<div class="toast_wp toast-pos_center"><div class="toast__img toast__img_info"></div><div class="toast__content">用户名或密码错误 PRIVATE_SENTINEL</div></div>'
    document.body.appendChild(toast)
    await Promise.resolve()
    toast.remove()
    await Promise.resolve()
    expect(inspect().error).toBe('invalid-credentials')
    expect(JSON.stringify(inspect())).not.toContain('PRIVATE_SENTINEL')
    await act({ kind: 'mode', mode: 'password' })
    expect(inspect().error).toBeUndefined()
  })

  it('clears previous errors at action start without relatching an unchanged old toast', async () => {
    document.body.innerHTML = passwordForm + '<div class="toast_wp"><div class="toast__img toast__img_info"></div><div class="toast__content">密码错误</div></div>'
    expect(inspect().error).toBe('invalid-credentials')
    await act({ kind: 'mode', mode: 'password' })
    expect(inspect().error).toBeUndefined()
    document.querySelector('.toast__content')!.textContent = '验证码不正确'
    await Promise.resolve()
    expect(inspect().error).toBe('invalid-code')
  })

  it('does not classify normal loading/success toasts as authentication errors', () => {
    document.body.innerHTML = passwordForm + '<div class="toast_wp"><div class="toast__img_loading"></div><div class="toast__content">请稍候</div></div>'
    expect(inspect().error).toBeUndefined()
    document.querySelector('.toast_wp')!.innerHTML = '<div class="toast__img_success"></div><div class="toast__content">发送成功</div>'
    expect(inspect().error).toBeUndefined()
  })

  it('crops the complete v3 click bind card including its border and confirmation controls', () => {
    document.body.innerHTML = passwordForm + bindPuzzle('click')
    setRect(document.querySelector<HTMLElement>('.geetest_panel')!, makeRect(0, 0, 1024, 768))
    const box = layoutCard('.geetest_panel_box', makeRect(300, 150, 322, 412))
    setRect(box.querySelector<HTMLElement>('.geetest_holder')!, makeRect(301, 151, 320, 410))
    setRect(box.querySelector<HTMLElement>('.geetest_window')!, makeRect(311, 200, 300, 300))
    expect(inspect()).toEqual({ page: 'challenge', challengePhase: 'interactive', qrStatus: 'paused', challenge: { x: 300, y: 150, width: 322, height: 412 } })
  })

  it('detects a rendered child challenge even when its outer container masks visibility', () => {
    document.body.innerHTML = passwordForm + bindPuzzle('click')
    document.querySelector('.geetest_panel')!.setAttribute('style', 'visibility:hidden')
    const box = layoutCard('.geetest_panel_box')
    expect(inspect().page).toBe('form')
    box.style.visibility = 'visible'
    expect(inspect().page).toBe('challenge')
    box.style.opacity = '0'
    expect(inspect().page).toBe('form')
  })

  it('leaves crop undefined for incomplete panels or containers that include normal login inputs', () => {
    document.body.innerHTML = passwordForm + '<div class="geetest_panel"><div class="geetest_panel_box">正在加载</div></div>'
    expect(inspect()).toEqual({ page: 'loading', challengePhase: 'loading', qrStatus: 'paused' })
    document.body.innerHTML = '<div class="geetest_box"><div class="geetest_content"></div><button class="geetest_close"></button><div class="tab-sms"><input></div></div>'
    expect(inspect().page).toBe('challenge')
    expect(inspect().challenge).toBeUndefined()
  })

  it('detects a complete v4 box and includes its close control outside the box border', () => {
    document.body.innerHTML = '<div class="geetest_popup_wrap"><div class="geetest_box"><div class="geetest_captcha"></div><div class="geetest_footer"><button class="geetest_close">关闭</button><button class="geetest_refresh">刷新</button></div></div></div>'
    const box = document.querySelector<HTMLElement>('.geetest_box')!
    const rect = { x: 300, y: 150, width: 320, height: 380, left: 300, top: 150, right: 620, bottom: 530, toJSON: () => ({}) }
    setRect(document.querySelector<HTMLElement>('.geetest_popup_wrap')!, { ...rect, x: 0, y: 0, left: 0, top: 0, width: 1024, height: 768, right: 1024, bottom: 768 })
    setRect(box, rect)
    for (const element of box.querySelectorAll<HTMLElement>('*')) setRect(element, rect)
    setRect(box.querySelector<HTMLElement>('.geetest_close')!, { ...rect, x: 630, y: 150, left: 630, top: 150, width: 20, height: 20, right: 650, bottom: 170 })
    expect(inspect().challenge).toEqual({ x: 300, y: 150, width: 350, height: 380 })
  })

  it('does not mistake an ordinary login iframe query for a trusted CAPTCHA frame', () => {
    document.body.innerHTML = passwordForm + '<iframe src="https://passport.bilibili.com/login?return=/captcha&host=api.geetest.com"></iframe>'
    expect(inspect().page).toBe('form')
    expect(inspect().challenge).toBeUndefined()
  })

  it('crops the official image-verification outline instead of its full-screen mask', () => {
    document.body.innerHTML = '<div class="dialog__mask"><div class="dialog__outline"><div class="body__captcha-img_wp"><img></div><input class="body__captcha-input"><div class="dialog__footer"><div>取消</div><div>确定</div></div></div></div>'
    Object.defineProperty(document.querySelector('input')!, 'value', { get() { throw Error('CAPTCHA read forbidden') } })
    const rect = { x: 300, y: 200, width: 280, height: 243, left: 300, top: 200, right: 580, bottom: 443, toJSON: () => ({}) }
    setRect(document.querySelector<HTMLElement>('.dialog__outline')!, rect)
    expect(inspect().challenge).toEqual({ x: 300, y: 200, width: 280, height: 243 })
  })

  it('prepares SMS phone and country without sending a message or submitting login', async () => {
    document.body.innerHTML = smsForm
    const send = document.querySelector('.tab-sms .form__item > .clickable')!
    const submit = document.querySelector('.btn_primary')!
    const sendClicked = vi.fn(), submitted = vi.fn(), inputChanged = vi.fn()
    send.addEventListener('click', sendClicked)
    submit.addEventListener('click', submitted)
    const phone = document.querySelector('input')!
    phone.addEventListener('input', () => { inputChanged(); queueMicrotask(() => send.removeAttribute('disabled')) })
    expect(await act({ kind: 'prepare-sms', phone: '13812345678', countryCode: '86', accepted: true })).toEqual({ ok: true })
    await Promise.resolve()
    expect(inspect().sms).toEqual({ canSend: true, cooldownSeconds: null })
    expect(inputChanged).toHaveBeenCalledTimes(1)
    expect(await act({ kind: 'prepare-sms', phone: '13812345678', countryCode: '86', accepted: true })).toEqual({ ok: true })
    expect(inputChanged).toHaveBeenCalledTimes(1)
    expect(sendClicked).not.toHaveBeenCalled()
    expect(submitted).not.toHaveBeenCalled()
    expect(JSON.stringify(inspect())).not.toContain('13812345678')
  })

  it('does not crop a viewport-sized popup mask even if it contains CAPTCHA descendants', () => {
    document.body.innerHTML = '<div class="geetest_popup_wrap"><div class="geetest_container"></div><button class="geetest_close">关闭</button></div>'
    const root = document.querySelector<HTMLElement>('.geetest_popup_wrap')!
    setRect(root, { x: 0, y: 0, width: 1000, height: 700, left: 0, top: 0, right: 1000, bottom: 700, toJSON: () => ({}) })
    expect(inspect().page).toBe('challenge')
    expect(inspect().challenge).toBeUndefined()
  })

  it('ignores opacity-zero challenges and inherited invisible descendants', () => {
    document.body.innerHTML = passwordForm + `<div id="captcha-host">${bindPuzzle('slide')}</div>`
    layoutCard('.geetest_panel_box', makeRect(250, 140, 280, 287))
    const host = document.querySelector<HTMLElement>('#captcha-host')!
    for (const style of ['opacity:0', 'display:none', 'visibility:hidden']) {
      host.setAttribute('style', style)
      expect(inspect().page).toBe('form')
      expect(inspect().challenge).toBeUndefined()
    }
    host.setAttribute('style', 'opacity:0')
    document.querySelector<HTMLElement>('.geetest_panel_box')!.style.opacity = '1'
    expect(inspect().page).toBe('form')
    host.removeAttribute('style')
    expect(inspect().challengePhase).toBe('interactive')
  })

  it('ignores mounted initial and completed fullpage detectors after their modal has closed', async () => {
    document.body.innerHTML = passwordForm + '<div class="geetest_holder geetest_wind geetest_radar_success"><div class="geetest_radar_btn"></div><div class="geetest_success_btn">验证成功</div></div>' + bindPuzzle('click')
    document.querySelector<HTMLElement>('.geetest_panel.geetest_wind')!.style.opacity = '0'
    expect(inspect().page).toBe('form')
    document.querySelector('.btn_primary')!.classList.remove('disabled')
    const submitted = vi.fn()
    document.querySelector('.btn_primary')!.addEventListener('click', submitted)
    expect(await act({ kind: 'password', username: 'SYNTHETIC', password: 'SYNTHETIC', accepted: true })).toEqual({ ok: true })
    expect(submitted).toHaveBeenCalledTimes(1)
  })

  it('keeps fullpage loading and success remnants out of interactive screenshots', async () => {
    document.body.innerHTML = passwordForm + bindPuzzle('click')
    const box = layoutCard('.geetest_panel_box')
    const submit = vi.fn(), changed = vi.fn()
    document.querySelector('.btn_primary')!.addEventListener('click', submit)
    document.querySelectorAll('input').forEach(input => input.addEventListener('input', changed))
    for (const [selector, phase] of [['.geetest_panel_loading', 'loading'], ['.geetest_panel_success', 'passed']] as const) {
      const status = box.querySelector<HTMLElement>(selector)!
      status.style.display = 'block'
      setRect(box, makeRect(400, 300, 222, 152))
      expect(inspect()).toEqual({ page: 'loading', challengePhase: phase, qrStatus: 'paused' })
      expect(await act({ kind: 'password', username: 'SYNTHETIC', password: 'SYNTHETIC', accepted: true })).toEqual({ ok: false, reason: 'unsupported' })
      status.style.display = 'none'
    }
    expect(submit).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    setRect(box, makeRect(300, 150, 320, 410))
    expect(inspect().challengePhase).toBe('interactive')
  })

  it('classifies click loading and successful result layers before still-mounted items', () => {
    document.body.innerHTML = bindPuzzle('click')
    const box = layoutCard('.geetest_panel_box')
    const item = box.querySelector('.geetest_item')!
    item.insertAdjacentHTML('afterbegin', '<div class="geetest_item_loading"><div class="geetest_item_loading_icon"></div></div>')
    expect(inspect()).toEqual({ page: 'loading', challengePhase: 'loading', qrStatus: 'paused' })
    item.querySelector<HTMLElement>('.geetest_item_loading')!.style.opacity = '0'
    expect(inspect().challengePhase).toBe('interactive')
    const result = box.querySelector<HTMLElement>('.geetest_result_tip')!
    result.classList.add('geetest_success', 'geetest_up')
    result.style.display = 'block'
    expect(inspect()).toEqual({ page: 'loading', challengePhase: 'passed', qrStatus: 'paused' })
    result.style.opacity = '0'
    expect(inspect().challengePhase).toBe('interactive')
  })

  it('shows a decoded click challenge when its normal-flow loader remains behind the image', () => {
    document.body.innerHTML = bindPuzzle('click')
    const box = layoutCard('.geetest_panel_box')
    const item = box.querySelector('.geetest_item')!
    item.insertAdjacentHTML('afterbegin', '<div class="geetest_item_loading"><div class="geetest_item_loading_icon"></div></div>')
    const image = item.querySelector<HTMLImageElement>('.geetest_item_img')!
    Object.defineProperties(image, { complete: { value: true, configurable: true },
      naturalWidth: { value: 344, configurable: true }, naturalHeight: { value: 384, configurable: true } })
    expect(inspect()).toMatchObject({ page: 'challenge', challengePhase: 'interactive' })
    expect(inspect().challenge).toBeDefined()
    Object.defineProperty(image, 'naturalWidth', { value: 0 })
    expect(inspect()).toEqual({ page: 'loading', challengePhase: 'loading', qrStatus: 'paused' })
  })

  it('recognizes the current SDK background-image branch without requiring its unused img to load', () => {
    document.body.innerHTML = bindPuzzle('click')
    const box = layoutCard('.geetest_panel_box')
    const item = box.querySelector('.geetest_item')!
    item.insertAdjacentHTML('afterbegin', '<div class="geetest_item_loading"><div class="geetest_item_loading_icon"></div></div>')
    const wrap = item.querySelector<HTMLElement>('.geetest_item_wrap')!
    wrap.style.backgroundImage = 'url("https://static.geetest.com/synthetic-captcha.jpg")'
    const image = item.querySelector<HTMLImageElement>('.geetest_item_img')!
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 0 }, naturalHeight: { value: 0 } })
    expect(inspect()).toMatchObject({ page: 'challenge', challengePhase: 'interactive' })
    expect(JSON.stringify(inspect())).not.toContain('synthetic-captcha')
    wrap.style.backgroundImage = 'none'
    expect(inspect()).toEqual({ page: 'loading', challengePhase: 'loading', qrStatus: 'paused' })
  })

  it('crops the v3 slider card with its sibling slider and classifies result transitions', () => {
    document.body.innerHTML = passwordForm + bindPuzzle('slide')
    const box = layoutCard('.geetest_panel_box', makeRect(320, 200, 280, 287))
    setRect(box.querySelector<HTMLElement>('.geetest_widget')!, makeRect(321, 201, 278, 230))
    setRect(box.querySelector<HTMLElement>('.geetest_slider')!, makeRect(321, 440, 278, 46))
    expect(inspect().challenge).toEqual({ x: 320, y: 200, width: 280, height: 287 })
    const result = box.querySelector<HTMLElement>('.geetest_result')!
    result.style.display = 'block'
    for (const [state, phase] of [['geetest_load', 'verifying'], ['geetest_success', 'passed']] as const) {
      result.className = `geetest_result ${state}`
      expect(inspect()).toEqual({ page: 'loading', challengePhase: phase, qrStatus: 'paused' })
    }
    result.style.display = 'none'
    const loading = box.querySelector<HTMLElement>('.geetest_loading')!
    loading.style.display = 'block'
    expect(inspect()).toEqual({ page: 'loading', challengePhase: 'loading', qrStatus: 'paused' })
  })

  it('crops the real v4 bind slide box despite its zero-height owner and different slider control', () => {
    document.body.innerHTML = secondForm('phone') + v4BindSlide
    const box = layoutCard('.geetest_box', makeRect(342, 190.25, 340, 387.5))
    setRect(document.querySelector<HTMLElement>('.geetest_captcha')!, makeRect(0, 0, 1024, 0))
    setRect(document.querySelector<HTMLElement>('.geetest_box_wrap')!, makeRect(342, 384, 340, 0))
    setRect(document.querySelector<HTMLElement>('.geetest_popup_ghost')!, makeRect(0, 0, 1024, 768))
    setRect(box.querySelector<HTMLElement>('.geetest_close')!, makeRect(362, 532, 25, 25))
    expect(inspect('https://passport.bilibili.com/pc/passport/riskVerify')).toEqual({ page: 'challenge', challengePhase: 'interactive', qrStatus: 'paused', challenge: { x: 342, y: 190.25, width: 340, height: 387.5 } })
    expect(JSON.stringify(inspect())).not.toContain('synthetic-v4')
    expect(inspect().verificationCompleted).toBeUndefined()
  })

  it.each(['word', 'icon', 'gobang', 'futurePuzzle'])('crops the complete v4 %s card independently of slider classes', kind => {
    const url = 'https://passport.bilibili.com/pc/passport/riskVerify?tmp_token=PRIVATE_URL'
    document.body.innerHTML = secondForm('phone') + v4Card(v4ClickSurface, kind)
    const rect = makeRect(342.125, 170.25, 340, 410.5)
    const box = layoutCard('.geetest_box', rect)
    setRect(document.querySelector<HTMLElement>('.geetest_captcha')!, makeRect(0, 0, 1024, 0))
    setRect(document.querySelector<HTMLElement>('.geetest_popup_ghost')!, makeRect(0, 0, 1024, 768))
    Object.defineProperty(document.querySelector('input')!, 'value', { get() { throw Error('OTP read forbidden') } })
    Object.defineProperty(box.querySelector('.geetest_bg')!, 'textContent', { get() { throw Error('Puzzle content read forbidden') } })
    expect(inspect(url)).toEqual({ page: 'challenge', challengePhase: 'interactive', qrStatus: 'paused', challenge: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
    expect(box.querySelector('.geetest_slider')).toBeNull()
    expect(JSON.stringify(inspect(url))).not.toMatch(/PRIVATE_URL|synthetic-v4|futurePuzzle/)
    expect(inspect(url).verificationCompleted).toBeUndefined()
  })

  it('uses visible decoded image, canvas and SVG surfaces for unknown v4 types without reading their contents', () => {
    document.body.innerHTML = v4Card('<div class="geetest_window"><img class="synthetic_surface"></div>', 'futureImage')
    layoutCard('.geetest_box')
    const image = document.querySelector<HTMLImageElement>('img')!
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 240, configurable: true }, naturalHeight: { value: 180 },
      src: { get() { throw Error('Puzzle resource URL read forbidden') } } })
    expect(inspect().challengePhase).toBe('interactive')
    Object.defineProperty(image, 'naturalWidth', { value: 0 })
    expect(inspect().challenge).toBeUndefined()
    document.body.innerHTML = v4Card('<canvas class="geetest_bg" width="240" height="180"></canvas>', 'futureCanvas')
    layoutCard('.geetest_box')
    const canvas = document.querySelector('canvas')!
    canvas.getContext = () => { throw Error('Puzzle pixels read forbidden') }
    canvas.toDataURL = () => { throw Error('Puzzle pixels read forbidden') }
    expect(inspect().challengePhase).toBe('interactive')
    document.body.innerHTML = v4Card('<div class="geetest_window"><svg viewBox="0 0 240 180"><rect width="240" height="180"></rect></svg></div>', 'futureSvg')
    layoutCard('.geetest_box')
    expect(inspect().challengePhase).toBe('interactive')
    document.querySelector('svg')!.style.opacity = '0'
    expect(inspect().challenge).toBeUndefined()
  })

  it('crops the v4 popup box instead of its full-screen detached owner and ghost', () => {
    document.body.innerHTML = v4Card(v4ClickSurface, 'icon', 'popup')
    const box = layoutCard('.geetest_box', makeRect(340.5, 165.125, 342, 412.75))
    setRect(document.querySelector<HTMLElement>('.geetest_popup_wrap')!, makeRect(0, 0, 1024, 768))
    setRect(document.querySelector<HTMLElement>('.geetest_box_wrap')!, makeRect(340.5, 384, 342, 0))
    setRect(document.querySelector<HTMLElement>('.geetest_popup_ghost')!, makeRect(0, 0, 1024, 768))
    expect(inspect().challenge).toEqual({ x: 340.5, y: 165.125, width: 342, height: 412.75 })
    for (const readyState of ['geetest_nextReady', 'geetest_ready']) {
      document.querySelector('.geetest_popup_wrap')!.className = `geetest_popup_wrap geetest_popup ${readyState}`
      expect(inspect().challengePhase).toBe('interactive')
    }
    setRect(box, makeRect(0, 0, 1024, 768))
    expect(inspect().challenge).toBeUndefined()
  })

  it.each(['.geetest_header', '.geetest_title', '.geetest_container', '.geetest_wrap', '.geetest_subitem', '.geetest_footer', '.geetest_close', '.geetest_refresh'])('requires the complete v4 card when %s is missing', selector => {
    document.body.innerHTML = v4Card()
    layoutCard('.geetest_box')
    document.querySelector(selector)!.remove()
    expect(inspect()).toEqual({ page: 'challenge', challengePhase: 'unknown', qrStatus: 'paused' })
  })

  it('refuses v4 shells with no surface or hidden submit and explicit loading/error result states', () => {
    document.body.innerHTML = v4Card()
    const box = layoutCard('.geetest_box')
    const owner = document.querySelector<HTMLElement>('.geetest_captcha')!
    const bg = box.querySelector<HTMLElement>('.geetest_bg')!
    bg.style.backgroundImage = 'none'
    expect(inspect().challenge).toBeUndefined()
    bg.style.backgroundImage = 'url(https://static.geetest.com/synthetic-v4.png)'
    const submit = box.querySelector<HTMLElement>('.geetest_submit')!
    submit.style.opacity = '0'
    expect(inspect().challenge).toBeUndefined()
    submit.style.opacity = '1'
    for (const [state, phase] of [['geetest_init', 'loading'], ['geetest_refresh', 'loading'], ['geetest_error', 'unknown'], ['geetest_lock_error', 'unknown']] as const) {
      owner.classList.add(state)
      expect(inspect()).toEqual({ page: phase === 'unknown' ? 'challenge' : 'loading', challengePhase: phase, qrStatus: 'paused' })
      owner.classList.remove(state)
    }
    box.querySelector('.geetest_wrap')!.insertAdjacentHTML('afterbegin', '<div class="geetest_loading"></div>')
    expect(inspect()).toEqual({ page: 'loading', challengePhase: 'loading', qrStatus: 'paused' })
    box.querySelector('.geetest_loading')!.remove()
    box.querySelector('.geetest_subitem')!.remove()
    expect(inspect().challenge).toBeUndefined()
  })

  it.each(['display:none', 'opacity:0', 'visibility:hidden'])('ignores old v3 and v4 roots hidden by %s while cropping the active v4 owner', style => {
    document.body.innerHTML = `<div class="retired" style="${style}">${bindPuzzle('click')}${v4BindSlide}</div>${v4Card()}`
    layoutCard('.geetest_panel_box')
    for (const box of document.querySelectorAll<HTMLElement>('.geetest_box')) {
      setRect(box, makeRect(342, 170, 340, 410))
      for (const child of box.querySelectorAll<HTMLElement>('*')) setRect(child, makeRect(350, 180, 300, 300))
    }
    const current = document.querySelector<HTMLElement>('.retired + .geetest_captcha .geetest_box')!
    expect(inspect().challenge).toEqual({ x: 342, y: 170, width: 340, height: 410 })
    current.style.opacity = '0'
    expect(inspect().challenge).toBeUndefined()
  })

  it('ignores semantic hidden v4 remnants and does not let a retired visible v3 status shell block the current card', () => {
    document.body.innerHTML = bindPuzzle('click') + `<div aria-hidden="true">${v4BindSlide}</div>` + v4Card()
    const old = layoutCard('.geetest_panel_box', makeRect(400, 300, 222, 152))
    old.classList.remove('geetest_panelshowclick')
    for (const box of document.querySelectorAll<HTMLElement>('.geetest_box')) {
      setRect(box, makeRect(342, 170, 340, 410))
      for (const child of box.querySelectorAll<HTMLElement>('*')) setRect(child, makeRect(350, 180, 300, 300))
    }
    expect(inspect().challenge).toEqual({ x: 342, y: 170, width: 340, height: 410 })
    old.classList.add('geetest_panelshowclick')
    expect(inspect()).toEqual({ page: 'challenge', challengePhase: 'unknown', qrStatus: 'paused' })
  })

  it('does not confuse the v4 mounted hidden success box or freeze_wait class with verification', () => {
    document.body.innerHTML = v4BindSlide
    layoutCard('.geetest_box', makeRect(342, 190, 340, 388))
    layoutCard('.geetest_bind_box', makeRect(390, 300, 244, 152))
    expect(inspect().challengePhase).toBe('interactive')
    const owner = document.querySelector<HTMLElement>('.geetest_captcha')!
    for (const [state, phase] of [['geetest_load', 'loading'], ['geetest_compute', 'verifying'], ['geetest_wait', 'verifying'], ['geetest_success', 'passed'], ['geetest_lock_success', 'passed']] as const) {
      owner.classList.add(state)
      expect(inspect()).toEqual({ page: 'loading', challengePhase: phase, qrStatus: 'paused' })
      owner.classList.remove(state)
    }
    expect(inspect().challengePhase).toBe('interactive')
    document.querySelector<HTMLElement>('.geetest_box')!.style.display = 'none'
    document.querySelector<HTMLElement>('.geetest_bind_box')!.style.display = 'block'
    owner.classList.add('geetest_success')
    expect(inspect()).toEqual({ page: 'loading', challengePhase: 'passed', qrStatus: 'paused' })
    expect(inspect().verificationCompleted).toBeUndefined()
  })

  it('refuses v4 cards without decoded image, open state or visible controls and ignores closed remnants', async () => {
    document.body.innerHTML = secondForm('phone') + v4BindSlide
    layoutCard('.geetest_box', makeRect(342, 190, 340, 388))
    const owner = document.querySelector<HTMLElement>('.geetest_captcha')!
    const bg = document.querySelector<HTMLElement>('.geetest_bg')!
    bg.style.backgroundImage = 'none'
    expect(inspect().challengePhase).toBe('unknown')
    bg.style.backgroundImage = 'url(https://static.geetest.com/synthetic-v4.jpg)'
    owner.classList.remove('geetest_boxShow')
    expect(inspect().challenge).toBeUndefined()
    owner.classList.add('geetest_boxShow')
    document.querySelector<HTMLElement>('.geetest_btn')!.style.visibility = 'hidden'
    expect(inspect().challenge).toBeUndefined()
    const send = vi.fn()
    document.querySelector('.risk-input-after-active')!.addEventListener('click', send)
    expect(await act({ kind: 'second-send' }, 'https://passport.bilibili.com/pc/passport/riskVerify')).toEqual({ ok: false, reason: 'unsupported' })
    expect(send).not.toHaveBeenCalled()
    owner.style.display = 'none'
    expect(inspect('https://passport.bilibili.com/pc/passport/riskVerify').page).toBe('second-factor')
  })

  it('uses the fullpage popup card rather than its holder, widget or mask', () => {
    document.body.innerHTML = `<div class="geetest_fullpage_click geetest_popup"><div class="geetest_fullpage_ghost"></div><div class="geetest_fullpage_click_wrap"><div class="geetest_fullpage_click_box">${clickPuzzle}</div></div></div>`
    setRect(document.querySelector<HTMLElement>('.geetest_fullpage_click')!, makeRect(0, 0, 1024, 768))
    setRect(document.querySelector<HTMLElement>('.geetest_fullpage_click_wrap')!, makeRect(200, 120, 356, 446))
    const box = layoutCard('.geetest_fullpage_click_box', makeRect(215, 130, 322, 412))
    setRect(box.querySelector<HTMLElement>('.geetest_holder')!, makeRect(216, 131, 320, 410))
    expect(inspect()).toEqual({ page: 'challenge', challengePhase: 'interactive', qrStatus: 'paused', challenge: { x: 215, y: 130, width: 322, height: 412 } })
  })

  it('uses transformed visual CSS pixels and does not union arbitrary inner widgets or buttons', () => {
    document.body.innerHTML = `<div style="transform:translate(140px, 80px)"><div class="geetest_popup_wrap"><div class="geetest_popup_box" style="transform:translate(-50%, -50%) scale(.8)">${clickPuzzle}<button>辅助控件</button></div></div></div>`
    setRect(document.querySelector<HTMLElement>('.geetest_popup_wrap')!, makeRect(0, 0, 1024, 768))
    const box = layoutCard('.geetest_popup_box', makeRect(318.5, 175.25, 257.6, 329.6))
    setRect(box.querySelector<HTMLElement>('.geetest_holder')!, makeRect(319.3, 176.05, 256, 328))
    setRect(box.querySelector<HTMLElement>('.geetest_window')!, makeRect(326.5, 209.25, 240, 240))
    setRect(box.querySelector<HTMLElement>('button')!, makeRect(10, 20, 900, 700))
    Object.defineProperty(box, 'offsetLeft', { get() { throw Error('Layout coordinates must not replace visual coordinates') } })
    expect(inspect().challenge).toEqual({ x: 318.5, y: 175.25, width: 257.6, height: 329.6 })
  })

  it('refuses ambiguous or clipped real cards without capturing page background', () => {
    document.body.innerHTML = `<div class="geetest_popup_box">${clickPuzzle}</div><div class="geetest_box"><div class="geetest_captcha"></div><a class="geetest_close"></a></div>`
    layoutCard('.geetest_popup_box')
    layoutCard('.geetest_box', makeRect(20, 40, 320, 350))
    expect(inspect()).toEqual({ page: 'challenge', challengePhase: 'unknown', qrStatus: 'paused' })
    document.querySelector('.geetest_box')!.remove()
    setRect(document.querySelector<HTMLElement>('.geetest_popup_box')!, makeRect(-1, 40, 320, 350))
    expect(inspect()).toEqual({ page: 'challenge', challengePhase: 'unknown', qrStatus: 'paused' })
  })

  it('does not crop a lingering inner holder after the bind owner leaves its puzzle state', () => {
    document.body.innerHTML = passwordForm + bindPuzzle('click')
    const box = layoutCard('.geetest_panel_box')
    expect(inspect().challengePhase).toBe('interactive')
    box.classList.remove('geetest_panelshowclick')
    setRect(box, makeRect(400, 300, 222, 152))
    expect(inspect()).toEqual({ page: 'challenge', challengePhase: 'unknown', qrStatus: 'paused' })
    expect(inspect().verificationCompleted).toBeUndefined()
  })

  it('does not classify official alert-dialog masks as a human challenge', () => {
    document.body.innerHTML = passwordForm + '<div class="dialog__mask"><div class="dialog__outline"><div role="alert">网络错误</div><div class="dialog__footer">知道了</div></div></div>'
    expect(inspect().page).toBe('form')
    expect(inspect().error).toBe('network')
    expect(inspect().challengePhase).toBeUndefined()
    expect(inspect().challenge).toBeUndefined()
  })

  it('preserves unknown genuine SDK modals without pretending their verification passed', async () => {
    document.body.innerHTML = passwordForm + '<div class="geetest_holder geetest_unknown_theme">新图形验证</div>'
    expect(inspect()).toEqual({ page: 'challenge', challengePhase: 'unknown', qrStatus: 'paused' })
    expect(await act({ kind: 'password', username: 'SYNTHETIC', password: 'SYNTHETIC', accepted: true })).toEqual({ ok: false, reason: 'unsupported' })
    expect(inspect().verificationCompleted).toBeUndefined()
  })

  it('reports exact official second-factor completion from its waiting toast and recognized form', () => {
    const url = 'https://passport.bilibili.com/pc/passport/riskVerify?scene=secLogin'
    document.body.innerHTML = secondForm('phone') + '<div class="toast_wp"><div class="toast__img_success"></div><div class="toast__content"></div></div>'
    Object.defineProperty(document.querySelector('input')!, 'value', { get() { throw Error('OTP read forbidden') } })
    const content = document.querySelector('.toast__content')!
    for (const text of ['验证成功,请稍后', '验证成功，请稍后', '验证成功 请稍后', ' 验证成功 , 请稍后 ']) {
      resetLatch()
      content.textContent = text
      expect(inspect(url)).toEqual({ page: 'second-factor', qrStatus: 'paused', verification: { kind: 'sms', maskedTarget: '138****1234' }, verificationCompleted: true, sms: { canSend: true, cooldownSeconds: null } })
    }
    for (const text of ['通过验证', '发送成功', '验证成功', '请稍后', '登录成功', '验证码错误,验证成功,请稍后']) {
      resetLatch()
      content.textContent = text
      expect(inspect(url).verificationCompleted).toBeUndefined()
    }
    content.textContent = '验证成功,请稍后'
    resetLatch()
    document.querySelector('.toast__img_success')!.className = 'toast__img_loading'
    expect(inspect(url).verificationCompleted).toBe(true)
    resetLatch()
    document.querySelector('.toast__img_loading')!.className = 'toast__img_error'
    expect(inspect(url).verificationCompleted).toBeUndefined()
    document.querySelector('.toast__img_error')!.className = 'toast__img_loading'
    document.querySelector<HTMLElement>('.toast_wp')!.style.opacity = '0'
    expect(inspect(url).verificationCompleted).toBeUndefined()
    document.querySelector<HTMLElement>('.toast_wp')!.style.opacity = '1'
    expect(inspect().verificationCompleted).toBeUndefined()
    expect(inspect(`${url}&scene=unsupported`).verificationCompleted).toBeUndefined()
  })

  it('never treats a generic success alert or CAPTCHA success as second-factor completion', () => {
    const url = 'https://passport.bilibili.com/pc/passport/riskVerify'
    document.body.innerHTML = secondForm('email') + '<div role="alert">验证成功,请稍后</div>'
    expect(inspect(url).verificationCompleted).toBeUndefined()
    document.body.innerHTML = secondForm('email') + bindPuzzle('slide')
    const box = layoutCard('.geetest_panel_box')
    box.querySelector<HTMLElement>('.geetest_panel_success')!.style.display = 'block'
    expect(inspect(url)).toEqual({ page: 'loading', challengePhase: 'passed', qrStatus: 'paused' })
    expect(inspect(url).verificationCompleted).toBeUndefined()
  })

  it('keeps an exchanged-cookie completion visible even while an old captcha success shell remains', () => {
    const url = 'https://passport.bilibili.com/pc/passport/riskVerify'
    document.body.innerHTML = secondForm('phone') + bindPuzzle('slide')
      + '<div class="toast_wp"><div class="toast__img_loading"></div><div class="toast__content">验证成功,请稍后</div></div>'
    const box = layoutCard('.geetest_panel_box')
    box.querySelector<HTMLElement>('.geetest_panel_success')!.style.display = 'block'
    expect(inspect(url)).toMatchObject({ page: 'second-factor', verificationCompleted: true })
    expect(inspect(url).challenge).toBeUndefined()
  })

  it('releases an earlier code error after the user completes verification on the official page', async () => {
    const url = 'https://passport.bilibili.com/pc/passport/riskVerify'
    document.body.innerHTML = secondForm('phone')
      + '<div class="toast_wp"><div class="toast__img_error"></div><div class="toast__content">验证码错误</div></div>'
    expect(inspect(url).error).toBe('invalid-code')
    document.querySelector('.toast__img_error')!.className = 'toast__img_loading'
    document.querySelector('.toast__content')!.textContent = '验证成功,请稍后'
    await Promise.resolve()
    expect(inspect(url)).toMatchObject({ page: 'second-factor', verificationCompleted: true })
    expect(inspect(url).error).toBeUndefined()
  })

  it('latches the exact transient second-factor success toast and clears it before another user action', async () => {
    const url = 'https://passport.bilibili.com/pc/passport/riskVerify'
    document.body.innerHTML = secondForm('phone')
    inspect(url)
    const toast = document.createElement('div')
    toast.className = 'toast_wp'
    toast.innerHTML = '<div class="toast__img_loading"></div><div class="toast__content">验证成功,请稍后</div>'
    document.body.appendChild(toast)
    await Promise.resolve()
    toast.remove()
    await Promise.resolve()
    expect(inspect(url).verificationCompleted).toBe(true)
    document.querySelector('.risk-check-phone_wp')!.replaceWith(document.createElement('div'))
    expect(inspect(url).verificationCompleted).toBeUndefined()
    document.body.innerHTML = secondForm('phone') + '<div class="toast_wp"><div class="toast__img_success"></div><div class="toast__content">验证成功,请稍后</div></div>'
    expect(inspect(url).verificationCompleted).toBe(true)
    expect(await act({ kind: 'second-send' }, url)).toEqual({ ok: true })
    expect(inspect(url).verificationCompleted).toBeUndefined()
    document.querySelector('.toast__content')!.textContent = '验证成功, 请稍后'
    await Promise.resolve()
    expect(inspect(url).verificationCompleted).toBe(true)
  })
})
