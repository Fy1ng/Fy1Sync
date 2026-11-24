import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOUYIN_LOGIN_ENTRY_URL, DOUYIN_QR_CREATE_PATHS, DOUYIN_QR_POLL_PATHS, douyinLoginAdapter } from './douyin'
import type { LoginCardAction, LoginPageActionResult, LoginPageSnapshot } from '../loginCardContracts'

type TestDOM = { window: Window & typeof globalThis }
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => TestDOM }
const windows: TestDOM[] = []
function fixture(mode: 'sms' | 'password' = 'sms', checkbox = false) {
  const fields = (password: boolean) => `<input type="text" name="web-login-area-code-input" role="combobox" value="+86">
    <ul id="select-ul" style="display:none"><li data-itemvalue="+86">中国大陆+86</li><li data-itemvalue="+65">新加坡+65</li></ul>
    <input id="normal-input" name="normal-input" type="tel" placeholder="请输入手机号" value="" maxlength="50">
    ${password ? '<input id="normal-input" name="normal-input" type="password" placeholder="请输入密码" maxlength="128">'
      : '<div id="douyin_login_comp_button_input_id"><input id="button-input" name="button-input" type="tel" placeholder="请输入验证码" maxlength="6"><span class="gKXDWaPG KX2Mhb6E" tabindex="0" aria-live="off">获取验证码</span></div>'}
    <div id="douyin_login_comp_btn_id" class="r7j70rK2 zcAEoiw0">登录</div><div id="error_text_id" style="display:none"></div>
    <div aria-label="登录即代表同意用户协议和隐私政策">${checkbox ? '<span role="checkbox" aria-label="协议勾选框" aria-checked="false">同意</span>' : ''}<span>登录即代表同意</span><a>用户协议</a><a>隐私政策</a></div>`
  const dom = new JSDOM(`<div id="login-panel-new"><div id="douyin_login_comp_scan_code_qrcode"><img src="data:image/png;base64,c3ludGhldGlj"></div>
    <div id="douyin_login_comp_scan_code_qrcode_expired" style="display:none">点击刷新</div><div id="douyin_login_comp_scan_code_avatar" style="display:none"></div>
    <span id="douyin_login_comp_mobile_title">验证码登录</span><span id="password-tab">密码登录</span>
    <div id="douyin_login_comp_mobile_code">${fields(false)}</div><div id="douyin_login_comp_account_pwd">${fields(true)}</div></div>`,
  { url: 'https://live.douyin.com/', runScripts: 'outside-only' })
  windows.push(dom)
  const document = dom.window.document
  Object.defineProperty(document, 'readyState', { get: () => 'complete' })
  vi.spyOn(dom.window.Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 20, y: 30, width: 178, height: 178, top: 30, left: 20, bottom: 208, right: 198, toJSON: () => ({}) })
  const smsPanel = document.querySelector<HTMLElement>('#douyin_login_comp_mobile_code')!
  const passwordPanel = document.querySelector<HTMLElement>('#douyin_login_comp_account_pwd')!
  const changeMode = (next: 'sms' | 'password') => {
    smsPanel.remove(); passwordPanel.remove()
    document.querySelector('#login-panel-new')!.appendChild(next === 'sms' ? smsPanel : passwordPanel)
  }
  document.querySelector('#douyin_login_comp_mobile_title')!.addEventListener('click', () => changeMode('sms'))
  document.querySelector('#password-tab')!.addEventListener('click', () => changeMode('password'))
  const sent = vi.fn(), submitted = vi.fn(), refreshed = vi.fn(), changed = vi.fn()
  const sms = document.querySelector('#douyin_login_comp_mobile_code')!
  const phone = sms.querySelector<HTMLInputElement>('input[type="tel"][name="normal-input"]')!
  const code = sms.querySelector<HTMLInputElement>('input[name="button-input"]')!
  const area = sms.querySelector<HTMLInputElement>('[role="combobox"]')!
  const send = sms.querySelector('span[aria-live="off"]')!
  const update = () => { if (!/\d+s后/.test(send.textContent ?? '')) send.classList.toggle('KX2Mhb6E', phone.value.replace(/\s/g, '').length < 4)
    sms.querySelector('#douyin_login_comp_btn_id')!.classList.toggle('zcAEoiw0', code.value.length !== 6) }
  phone.addEventListener('input', () => { changed(); update() }); code.addEventListener('input', update)
  area.addEventListener('click', () => { sms.querySelector<HTMLElement>('#select-ul')!.style.display = '' })
  for (const option of sms.querySelectorAll<HTMLElement>('li[data-itemvalue]')) option.addEventListener('mousedown', () => { area.value = option.dataset.itemvalue!; sms.querySelector<HTMLElement>('#select-ul')!.style.display = 'none' })
  send.addEventListener('mousedown', sent)
  for (const panel of document.querySelectorAll('#douyin_login_comp_mobile_code, #douyin_login_comp_account_pwd')) {
    panel.querySelector('[id="douyin_login_comp_btn_id"]')!.addEventListener('click', submitted)
    panel.querySelector('[role="checkbox"]')?.addEventListener('click', event => (event.currentTarget as HTMLElement).setAttribute('aria-checked', 'true'))
    if (panel.id.includes('account_pwd')) for (const input of panel.querySelectorAll('input[type="tel"],input[type="password"]')) input.addEventListener('input', () => {
      const values = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="tel"],input[type="password"]')).map(node => node.value)
      panel.querySelector('#douyin_login_comp_btn_id')!.classList.toggle('zcAEoiw0', values.some(value => !value))
    })
  }
  document.querySelector('#douyin_login_comp_scan_code_qrcode_expired')!.addEventListener('click', refreshed)
  changeMode(mode)
  return { dom, document, sent, submitted, refreshed, changed, phone, code, area, send,
    inspect: () => dom.window.eval(douyinLoginAdapter.inspectScript) as LoginPageSnapshot,
    act: (action: LoginCardAction) => dom.window.eval(douyinLoginAdapter.actionScript(action)) as Promise<LoginPageActionResult> }
}
/** Markup of the dedicated official login page as observed on 2026-11-23: no ids on the tabs or the QR image. */
function loginPageFixture(url = DOUYIN_LOGIN_ENTRY_URL) {
  const agreement = '<div aria-label="登录即代表同意用户协议和隐私政策"><span>登录即代表同意</span><a>用户协议</a><a>隐私政策</a></div>'
  const phone = '<div id="douyin_login_comp_normal_input_id"><input type="text" name="web-login-area-code-input" role="combobox" value="+86"><input id="normal-input" name="normal-input" type="tel" placeholder="请输入手机号"></div>'
  const dom = new JSDOM(`<div id="douyin-login-new-id"><article id="douyin_login_comp_flat_panel"><div id="douyin_login_landing_flat_container">
    <div><span class="C6OZQwMA">扫码登录</span><div id="douyin_login_comp_scan_code"><div id="animate_qrcode_container"><div>如何扫码</div><div id="qr-slot"></div><div id="default_scan_code_guide"></div></div></div></div>
    <div><div id="tabs"><span>验证码登录</span><span>密码登录</span></div><div id="panel-slot"></div></div></div></article></div>
    <template id="sms"><div id="douyin_login_comp_mobile_code">${phone}<div id="douyin_login_comp_button_input_id"><div><input id="button-input" name="button-input" type="tel" placeholder="请输入验证码"></div><span class="gKXDWaPG KX2Mhb6E" tabindex="0" aria-live="off">获取验证码</span></div>
      <div id="douyin_login_comp_btn_id" class="r7j70rK2 zcAEoiw0">登录</div>${agreement}</div></template>
    <template id="password"><div id="douyin_login_comp_account_pwd">${phone}<div class="password_input"><div id="douyin_login_comp_normal_input_id"><input id="normal-input" name="normal-input" type="password" placeholder="请输入密码"></div></div>
      <div id="douyin_login_comp_btn_id" class="r7j70rK2 zcAEoiw0">登录</div>${agreement}</div></template>`, { url, runScripts: 'outside-only' })
  windows.push(dom)
  const document = dom.window.document
  vi.spyOn(dom.window.Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 370, y: 345, width: 179, height: 179, top: 345, left: 370, bottom: 524, right: 549, toJSON: () => ({}) })
  // The official page renders one panel at a time and replaces it when a tab is clicked.
  const show = (mode: 'sms' | 'password') => document.querySelector('#panel-slot')!.replaceChildren(document.querySelector<HTMLTemplateElement>(`#${mode}`)!.content.cloneNode(true))
  const [smsTab, passwordTab] = Array.from(document.querySelectorAll<HTMLElement>('#tabs span'))
  smsTab!.addEventListener('click', () => show('sms')); passwordTab!.addEventListener('click', () => show('password'))
  show('sms')
  return { dom, document,
    showQr: () => { document.querySelector('#qr-slot')!.innerHTML = '<img alt="" aria-label="二维码" tabindex="0" src="data:image/png;base64,c3ludGhldGlj">' },
    inspect: () => dom.window.eval(douyinLoginAdapter.inspectScript) as LoginPageSnapshot,
    act: (action: LoginCardAction) => dom.window.eval(douyinLoginAdapter.actionScript(action)) as Promise<LoginPageActionResult> }
}
afterEach(() => { windows.splice(0).forEach(dom => dom.window.close()); vi.restoreAllMocks(); vi.useRealTimers() })

describe('Douyin official DOM adapter', () => {
  describe('native second verification portal', () => {
    function portal(f: ReturnType<typeof fixture>, className = 'second-verify-panel', width = 178, height = 178) {
      f.document.body.insertAdjacentHTML('beforeend', `<div id="uc-second-verify"><div class="${className}" style="position:relative;width:${width}px;height:${height}px"><input type="password" value="synthetic-native-secret"><button type="button">继续验证</button></div></div>`)
      const panel = f.document.querySelector<HTMLElement>('#uc-second-verify > div')!
      vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ x: 20, y: 30, width, height, top: 30, left: 20, bottom: 30 + height, right: 20 + width, toJSON: () => ({}) })
      return panel
    }

    it.each([
      ['second-verify-panel', 178, 178],
      ['second_verify_panel_new-container_fixture', 726, 483],
      ['face_auth_panel_new-container_fixture', 400, 619],
      ['face_auth_panel_new_h5-container_fixture', 400, 619],
    ] as const)('prioritizes the visible %s portal over the basic form without reading private fields', (className, width, height) => {
      const f = fixture()
      portal(f, className, width, height)
      vi.spyOn(f.dom.window.HTMLInputElement.prototype, 'value', 'get').mockImplementation(() => { throw new Error('Native inspection read a sensitive input') })
      expect(f.inspect()).toEqual({ page: 'challenge', challengePhase: 'interactive', nativeVerification: true, qrStatus: 'paused', challenge: { x: 20, y: 30, width, height } })
      expect(JSON.stringify(f.inspect())).not.toContain('synthetic-native-secret')
      expect(f.inspect().verification).toBeUndefined()
      expect(f.inspect().verificationCompleted).toBeUndefined()
    })

    it.each(['empty', 'hidden-panel', 'unrecognized-panel', 'oversized-panel'] as const)('keeps the native gate while a %s portal has no usable panel', state => {
      const f = fixture()
      const panel = portal(f, state === 'unrecognized-panel' ? 'unrecognized-native-panel' : 'second-verify-panel', state === 'oversized-panel' ? 2000 : 178)
      if (state === 'empty') panel.remove()
      if (state === 'hidden-panel') panel.style.display = 'none'
      const snapshot = f.inspect()
      expect(snapshot).toMatchObject({ page: 'loading', nativeVerification: true, qrStatus: 'paused' })
      expect(['loading', 'unknown']).toContain(snapshot.challengePhase)
      expect(snapshot.challenge).toBeUndefined()
    })

    it('keeps native panel painting, layout and event handlers while shielding the ordinary form', () => {
      const f = fixture()
      const panel = portal(f, 'second_verify_panel_new-container_fixture', 726, 483)
      const originalStyle = panel.getAttribute('style')
      const clicked = vi.fn()
      panel.querySelector('button')!.addEventListener('click', clicked)
      expect(f.dom.window.eval(douyinLoginAdapter.presentationScript!(true))).toEqual({ ok: true })
      expect(panel.hasAttribute('data-fy1sync-douyin-challenge-root')).toBe(true)
      expect(f.document.querySelector('#login-panel-new')!.hasAttribute('data-fy1sync-douyin-challenge-path')).toBe(false)
      expect(f.dom.window.getComputedStyle(f.document.querySelector('#login-panel-new')!).clipPath).toBe('inset(50%)')
      expect(f.dom.window.getComputedStyle(panel).clipPath).not.toBe('inset(50%)')
      expect(panel.getAttribute('style')).toBe(originalStyle)
      expect(f.inspect().challenge).toEqual({ x: 20, y: 30, width: 726, height: 483 })
      panel.querySelector<HTMLButtonElement>('button')!.click()
      expect(clicked).toHaveBeenCalledOnce()

      expect(f.dom.window.eval(douyinLoginAdapter.presentationScript!(false))).toEqual({ ok: true })
      expect(panel.hasAttribute('data-fy1sync-douyin-challenge-root')).toBe(false)
      expect(f.document.querySelector('#fy1sync-douyin-challenge-paint')).toBeNull()
      expect(panel.getAttribute('style')).toBe(originalStyle)
    })

    it.each([
      { kind: 'mode', mode: 'password' },
      { kind: 'prepare-sms', countryCode: '+86', phone: '13800000000', accepted: true },
      { kind: 'send-sms', countryCode: '+86', phone: '13800000000', accepted: true },
      { kind: 'sms', countryCode: '+86', phone: '13800000000', code: '123456', accepted: true },
      { kind: 'password', username: '13800000000', password: 'synthetic-password', accepted: true },
      { kind: 'refresh-qr' },
    ] satisfies LoginCardAction[])('rejects $kind while native verification owns the step', async action => {
      const f = fixture(action.kind === 'password' ? 'password' : 'sms')
      portal(f)
      const read = vi.spyOn(f.dom.window.HTMLInputElement.prototype, 'value', 'get').mockImplementation(() => { throw new Error('Native gate read a sensitive input') })
      expect(await f.act(action)).toEqual({ ok: false, reason: 'not-ready' })
      expect(read).not.toHaveBeenCalled()
      expect(f.changed).not.toHaveBeenCalled()
      expect(f.sent).not.toHaveBeenCalled()
      expect(f.submitted).not.toHaveBeenCalled()
      expect(f.refreshed).not.toHaveBeenCalled()
    })

    it('returns to the basic form only after the native portal leaves the document', () => {
      const f = fixture()
      portal(f)
      expect(f.inspect()).toMatchObject({ page: 'challenge', nativeVerification: true })
      f.document.querySelector('#uc-second-verify')!.remove()
      expect(f.inspect()).toMatchObject({ page: 'form', mode: 'sms' })
      expect(f.inspect()).not.toHaveProperty('nativeVerification')
    })
  })

  it('reads current inline QR geometry and SMS/password modes without returning input values', async () => {
    const f = fixture()
    f.phone.value = 'synthetic-private-phone'; f.code.value = 'synthetic-code'
    vi.spyOn(f.dom.window.HTMLInputElement.prototype, 'value', 'get').mockImplementation(() => { throw new Error('Inspection read a sensitive input') })
    const snapshot = f.inspect()
    expect(snapshot).toMatchObject({ page: 'form', mode: 'sms', qrStatus: 'ready', qr: { src: 'data:image/png;base64,c3ludGhldGlj', rect: { x: 20, y: 30, width: 178, height: 178 } } })
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-private')
    expect(await f.act({ kind: 'mode', mode: 'password' })).toEqual({ ok: true })
    expect(f.inspect()).toMatchObject({ page: 'form', mode: 'password', qrStatus: 'ready' })
  })
  it.each([['获取验证码', false, true, 0], ['获取验证码', true, false, null], ['37s后重新发送', true, false, 37], ['发送中', true, false, null]] as const)
  ('uses official caption %s and disable state', (caption, disabled, canSend, seconds) => {
    const f = fixture(); f.send.textContent = caption; f.send.classList.toggle('KX2Mhb6E', disabled)
    expect(f.inspect().sms).toEqual({ canSend, cooldownSeconds: seconds })
  })
  it('identifies the official submit spinner without reading credentials or resubmitting it', async () => {
    const f = fixture()
    const submit = f.document.querySelector('#douyin_login_comp_btn_id')!
    submit.classList.add('qOAoUpHW')
    submit.innerHTML = '<div><svg><g><path d="M0,0"></path></g></svg></div>'
    vi.spyOn(f.dom.window.HTMLInputElement.prototype, 'value', 'get').mockImplementation(() => { throw new Error('Inspection read a sensitive input') })
    expect(f.inspect()).toEqual({ page: 'loading', qrStatus: 'paused', submissionPending: true })
    expect(await f.act({ kind: 'sms', countryCode: '+86', phone: '13800000000', code: '123456', accepted: true }))
      .toEqual({ ok: false, reason: 'not-ready' })
    expect(f.submitted).not.toHaveBeenCalled()
    expect(f.sent).not.toHaveBeenCalled()
    submit.classList.remove('qOAoUpHW')
    expect(f.inspect()).toEqual({ page: 'loading', qrStatus: 'paused' })
  })
  it('prepares country and phone through the official controls without sending SMS and avoids equal-input events', async () => {
    const f = fixture()
    const action: LoginCardAction = { kind: 'prepare-sms', countryCode: '+65', phone: '81234567', accepted: true }
    expect(await f.act(action)).toEqual({ ok: true })
    expect(f.area.value).toBe('+65'); expect(f.phone.value).toBe('81234567')
    expect(await f.act(action)).toEqual({ ok: true })
    expect(f.changed).toHaveBeenCalledTimes(1)
    expect(f.sent).not.toHaveBeenCalled(); expect(f.submitted).not.toHaveBeenCalled()
  })
  it('uses the SDK mousedown send path only for explicit accepted send, and respects official cooldown', async () => {
    const f = fixture('sms', true)
    expect(await f.act({ kind: 'send-sms', countryCode: '+86', phone: '13800000000', accepted: true })).toEqual({ ok: true })
    expect(f.sent).toHaveBeenCalledTimes(1)
    expect(f.document.querySelector('[role="checkbox"]')!.getAttribute('aria-checked')).toBe('true')
    f.send.textContent = '58s后重新发送'; f.send.classList.add('KX2Mhb6E')
    expect(await f.act({ kind: 'send-sms', countryCode: '+86', phone: '13900000000', accepted: true })).toEqual({ ok: false, reason: 'not-ready' })
    expect(f.sent).toHaveBeenCalledTimes(1)
    expect(f.phone.value).toBe('13800000000')
  })
  it('submits only the requested SMS code and preserves equal formatted-phone state', async () => {
    const f = fixture(); f.phone.value = '138 0000 0000'; f.send.textContent = '42s后重新发送'; f.send.classList.add('KX2Mhb6E')
    expect(await f.act({ kind: 'sms', countryCode: '+86', phone: '13800000000', code: '123456', accepted: true })).toEqual({ ok: true })
    expect(f.changed).not.toHaveBeenCalled(); expect(f.sent).not.toHaveBeenCalled(); expect(f.submitted).toHaveBeenCalledTimes(1)
    expect(f.code.value).toBe('123456')
  })
  it('fills only the phone/password controls with safe JSON escaping and never evaluates submitted text', async () => {
    const f = fixture('password')
    const password = 'safe</script>${globalThis.unsafe=true}\u2028"\\'
    expect(await f.act({ kind: 'password', username: '13800000000', password, accepted: true })).toEqual({ ok: true })
    expect(f.document.querySelector<HTMLInputElement>('#douyin_login_comp_account_pwd input[type="password"]')!.value).toBe(password)
    expect(Reflect.get(f.dom.window, 'unsafe')).toBeUndefined()
    expect(f.submitted).toHaveBeenCalledTimes(1); expect(f.sent).not.toHaveBeenCalled()
    f.document.querySelector<HTMLInputElement>('#douyin_login_comp_account_pwd input[type="password"]')!.maxLength = 8
    expect(await f.act({ kind: 'password', username: '13800000000', password: 'too-long-password', accepted: true })).toEqual({ ok: false, reason: 'invalid-input' })
    expect(f.submitted).toHaveBeenCalledTimes(1)
  })
  it('rejects unsupported account forms, untrusted frames, missing consent and invalid input before account actions', async () => {
    const f = fixture()
    expect(await f.act({ kind: 'send-sms', countryCode: '+86', phone: 'bad', accepted: true })).toEqual({ ok: false, reason: 'invalid-input' })
    expect(await f.act({ kind: 'second-submit', code: '123456' })).toEqual({ ok: false, reason: 'unsupported' })
    f.document.querySelector('[aria-label^="登录即代表同意"]')!.remove()
    expect(await f.act({ kind: 'send-sms', countryCode: '+86', phone: '13800000000', accepted: true })).toEqual({ ok: false, reason: 'not-ready' })
    f.document.body.insertAdjacentHTML('beforeend', '<iframe src="https://untrusted.invalid/"></iframe>')
    expect(f.inspect()).toMatchObject({ page: 'unknown', qrStatus: 'paused' })
    expect(f.sent).not.toHaveBeenCalled(); expect(f.submitted).not.toHaveBeenCalled()
  })
  it('keeps the original challenge and paint-only shielding separate from authentication', async () => {
    const f = fixture()
    f.document.body.insertAdjacentHTML('beforeend', '<div id="captcha_container"><img src="data:image/png;base64,c3ludGhldGlj"></div>')
    expect(f.inspect()).toMatchObject({ page: 'challenge', qrStatus: 'paused', challenge: { x: 20, y: 30, width: 178, height: 178 } })
    expect(f.inspect().verificationCompleted).toBeUndefined()
    expect(await f.act({ kind: 'send-sms', countryCode: '+86', phone: '13800000000', accepted: true })).toEqual({ ok: false, reason: 'not-ready' })
    expect(f.dom.window.eval(douyinLoginAdapter.presentationScript!(true))).toEqual({ ok: true })
    expect(f.document.querySelector('#captcha_container')!.hasAttribute('data-fy1sync-douyin-challenge-root')).toBe(true)
    expect(f.document.querySelector('#captcha_container')!.getAttribute('style')).toBeNull()
    expect(f.dom.window.eval(douyinLoginAdapter.presentationScript!(false))).toEqual({ ok: true })
    expect(f.document.querySelector('#fy1sync-douyin-challenge-paint')).toBeNull()
  })
  it('refreshes only an expired official QR and accepts only the exact official action document', async () => {
    const f = fixture()
    expect(await f.act({ kind: 'refresh-qr' })).toEqual({ ok: false, reason: 'not-ready' })
    f.document.querySelector<HTMLElement>('#douyin_login_comp_scan_code_qrcode_expired')!.style.display = ''
    expect(await f.act({ kind: 'refresh-qr' })).toEqual({ ok: true }); expect(f.refreshed).toHaveBeenCalledTimes(1)
    expect(DOUYIN_QR_POLL_PATHS).toEqual(['/passport/web/check_qrconnect/'])
    expect(DOUYIN_QR_CREATE_PATHS).toEqual(['/passport/web/get_qrcode/'])
    expect(douyinLoginAdapter.entryUrl).toBe('https://www.douyin.com/login_page?service=https%3A%2F%2Flive.douyin.com%2F')
    for (const raw of [DOUYIN_LOGIN_ENTRY_URL, 'https://www.douyin.com/login_page', 'https://live.douyin.com/']) expect(douyinLoginAdapter.acceptsFrame(raw)).toBe(true)
    for (const raw of ['https://www.douyin.com/', 'https://www.douyin.com/login_page/next', 'https://user@www.douyin.com/login_page', 'https://www.douyin.com:8443/login_page',
      'https://login.douyin.com/', 'https://sso.douyin.com/', 'http://live.douyin.com/', 'https://user@live.douyin.com/', 'https://live.douyin.com:8443/', 'https://live.douyin.com.evil.invalid/', 'https://live.douyin.com/100', 'https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/rmc-nocaptcha/1.0.0.52/index.html']) expect(douyinLoginAdapter.acceptsFrame(raw)).toBe(false)
  })
  describe('dedicated login page', () => {
    it('recognizes the form before its QR code exists, then reads the code without a prepare step', () => {
      const f = loginPageFixture()
      expect(douyinLoginAdapter.prepareScript).toBeUndefined()
      expect(f.inspect()).toMatchObject({ page: 'form', mode: 'sms', qrStatus: 'loading', sms: { canSend: false, cooldownSeconds: null } })
      expect(f.inspect().qr).toBeUndefined()
      f.showQr()
      expect(f.inspect()).toMatchObject({ page: 'form', mode: 'sms', qrStatus: 'ready',
        qr: { src: 'data:image/png;base64,c3ludGhldGlj', rect: { x: 370, y: 345, width: 179, height: 179 } } })
    })
    it('switches between its unlabeled SMS and password tabs by caption', async () => {
      const f = loginPageFixture(); f.showQr()
      expect(await f.act({ kind: 'mode', mode: 'password' })).toEqual({ ok: true })
      expect(f.inspect()).toMatchObject({ page: 'form', mode: 'password', qrStatus: 'ready' })
      expect(await f.act({ kind: 'mode', mode: 'sms' })).toEqual({ ok: true })
      expect(f.inspect()).toMatchObject({ page: 'form', mode: 'sms' })
    })
    it('fills its phone field and shields a challenge the same way as the live panel', async () => {
      const f = loginPageFixture()
      expect(await f.act({ kind: 'prepare-sms', countryCode: '+86', phone: '13800000000', accepted: true })).toEqual({ ok: true })
      expect(f.document.querySelector<HTMLInputElement>('#douyin_login_comp_mobile_code input[type="tel"][name="normal-input"]')!.value).toBe('13800000000')
      f.document.body.insertAdjacentHTML('beforeend', '<div id="captcha_container"><img src="data:image/png;base64,c3ludGhldGlj"></div>')
      expect(f.inspect()).toMatchObject({ page: 'challenge', qrStatus: 'paused' })
      expect(f.dom.window.eval(douyinLoginAdapter.presentationScript!(true))).toEqual({ ok: true })
      expect(f.document.querySelector('#captcha_container')!.hasAttribute('data-fy1sync-douyin-challenge-root')).toBe(true)
    })
    it.each(['https://www.douyin.com/', 'https://www.douyin.com/login_page/next', 'https://login.douyin.com/login_page'])('ignores the same markup on %s', async url => {
      const f = loginPageFixture(url); f.showQr()
      expect(f.inspect()).toEqual({ page: 'unknown' })
      expect(await f.act({ kind: 'mode', mode: 'password' })).toEqual({ ok: false, reason: 'not-ready' })
      expect(f.dom.window.eval(douyinLoginAdapter.presentationScript!(true))).toEqual({ ok: false, reason: 'unsupported' })
    })
  })
})
