import type { LoginCardAction, LoginPageActionResult, LoginPageAdapter, LoginPageSnapshot } from '../loginCardContracts'

/** Current official scan SDK paths, for the broker's basic-QR polling boundary. */
export const DOUYU_QR_POLL_PATHS = ['/japi/scan/auth'] as const
export const DOUYU_QR_CREATE_PATHS = ['/scan/generateCode'] as const

function inspectDouyu(): LoginPageSnapshot {
  const url = new URL(location.href)
  if (url.origin !== 'https://passport.douyu.com' || url.pathname !== '/member/login' || url.username || url.password) return { page: 'unknown' }
  const visible = (element: Element | null): boolean => {
    if (!element) return false
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const shown = (selector: string) => Array.from(document.querySelectorAll(selector)).some(visible)
  const region = (element: Element | undefined) => {
    if (!element || !visible(element)) return undefined
    const r = element.getBoundingClientRect()
    return [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.width >= 20 && r.height >= 20
      && r.x <= 4096 && r.y <= 4096 && r.width <= 2048 && r.height <= 2048 ? { x: r.x, y: r.y, width: r.width, height: r.height } : undefined
  }
  const sendCaption = document.querySelector<HTMLInputElement>('.js-login-normal .login-form input[type="button"].phone-send.js-sendvoice')?.value ?? ''
  const sentSms = /\([1-9]\d{0,2}\)|[1-9]\d{0,2}\s*(?:s|秒)\s*后?/i.test(sendCaption)
  const panel = ['.geetest_panel_box', '.geetest_window', '.geetest4_box', '#tcaptcha_transform', '.geetest_holder', '#TencentCaptcha', '[id^="tcaptcha_wrapper_transform_"]', '.geetest_popup_wrap']
    .flatMap(selector => Array.from(document.querySelectorAll(selector)))
    .find(element => visible(element) && !Array.from(element.querySelectorAll('.geetest_panel_success')).some(visible))
    ?? (!sentSms ? Array.from(document.querySelectorAll('.captcha-gt.render')).find(element => visible(element) && Boolean(element.querySelector('.verify-imgCode-input, .verify-imgCode-img'))) : undefined)
  const challenge = region(panel)
  if (panel || (!shown('.geetest_panel_success') && shown('.geetest_panel, .geetest_fullpage_click_wrap, .geetest_holder, .geetest4_popup'))) return { page: 'challenge', qrStatus: 'paused', ...(challenge ? { challenge } : {}) }
  const visibleFrames = Array.from(document.querySelectorAll('iframe')).filter(visible)
  const challengeFrame = visibleFrames.find(frame => {
    try { return /(^|\.)(geetest\.com|geetest\.cn|geevisit\.com|captcha\.qq\.com|captcha\.gtimg\.com|captcha\.qcloud\.com)$/.test(new URL(frame.src, location.href).hostname) } catch { return false }
  })
  if (challengeFrame) { const challenge = region(challengeFrame); return { page: 'challenge', qrStatus: 'paused', ...(challenge ? { challenge } : {}) } }
  // Binding and post-login verification are distinct official workflows without a verified SMS/email sample.
  if (visibleFrames.length || shown('#bindPhone') || shown('.aui_content form:not(.login-form)')) return { page: 'unknown', qrStatus: 'paused' }
  if (document.readyState === 'loading') return { page: 'loading', qrStatus: 'loading' }
  const form = document.querySelector('.js-login-normal .login-form')
  if (!form) return { page: 'loading', qrStatus: 'paused' }
  if (!visible(form)) return { page: 'unknown' }
  const mode = form!.classList.contains('login-by-password') ? 'password' : form!.classList.contains('login-by-sms') ? 'sms' : undefined
  if (!mode) return { page: 'unknown' }
  const fields = mode === 'password' ? ['nicknameOrPhone', 'password'] : ['areaCode', 'phoneNum', 'phoneCaptcha']
  const inputs = Array.from(form!.querySelectorAll<HTMLInputElement>('input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"])')).filter(visible)
  if (inputs.some(input => !fields.includes(input.name) && !(mode === 'sms' && sentSms && input.matches('.verify-imgCode-input[name="captcha_word"]'))) || !visible(form!.querySelector('.loginbox-sbt.btn-sub[type="submit"]'))
    || (mode === 'password' ? !visible(form!.querySelector('input[name="nicknameOrPhone"]')) || !visible(form!.querySelector('input[name="password"][type="password"]'))
      : !visible(form!.querySelector('input[name="phoneNum"]')) || !visible(form!.querySelector('input[name="phoneCaptcha"]')))) return { page: 'unknown' }
  const snapshot: LoginPageSnapshot = { page: 'form', mode, qrStatus: 'loading', sms: { canSend: false, cooldownSeconds: null } }
  const qrBox = document.querySelector('.js-scancode-box')
  if (visible(qrBox)) {
    const image = qrBox!.querySelector<HTMLImageElement>('.js-qrcode-con img')
    const canvas = qrBox!.querySelector<HTMLCanvasElement>('.js-qrcode-con canvas')
    const table = qrBox!.querySelector('.js-qrcode-con table')
    const element = visible(image) ? image : visible(canvas) ? canvas : visible(table) ? table : null
    if (visible(element)) {
      const rect = element!.getBoundingClientRect()
      if ([rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && Math.abs(rect.x) <= 10_000 && Math.abs(rect.y) <= 10_000 && rect.width <= 2000 && rect.height <= 2000) {
        snapshot.qr = { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
        try {
          const src = image?.src || canvas?.toDataURL('image/png')
          if (src && src.length <= 262_144 && (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(src)
            || (new URL(src).protocol === 'https:' && !new URL(src).username && !new URL(src).password))) snapshot.qr.src = src
        } catch { /* Geometry permits main to capture a canvas/table QR without reading its token. */ }
        snapshot.qrStatus = 'ready'
      }
    }
    if (qrBox!.classList.contains('status-scanfail') || shown('.js-scancode-box .qrcode-mask')) snapshot.qrStatus = 'expired'
    else if (qrBox!.classList.contains('status-scansucceed') || shown('.js-scancode-box .loginbox-scanmobile')) snapshot.qrStatus = 'scanned'
  } else snapshot.qrStatus = 'unavailable'
  const send = form!.querySelector<HTMLInputElement>('.phone-send.js-sendvoice')
  // Only this type=button value is a public caption; no account or password input is inspected.
  if (send?.type === 'button' && visible(send)) {
    const caption = send.value.trim()
    const remaining = caption.match(/(?:\((\d{1,3})\)|([0-9]{1,3})\s*(?:s|秒)\s*后?)/i)
    const count = remaining ? Number(remaining[1] ?? remaining[2]) : null
    const available = !send.disabled && send.getAttribute('aria-disabled') !== 'true' && !send.classList.contains('disabled')
    snapshot.sms = { canSend: available && count === null && /^(?:获取验证码|重新获取|发送验证码|获取短信验证码)$/.test(caption),
      cooldownSeconds: count !== null && count <= 300 ? count : available && /^(?:获取验证码|重新获取|发送验证码|获取短信验证码)$/.test(caption) ? 0 : null }
  }
  const errorText = Array.from(form!.querySelectorAll('.login-sbt-resMsg, .login-cheak-sms')).filter(visible).map(node => node.textContent ?? '').join(' ').slice(0, 512).trim()
  if (errorText) snapshot.error = /频繁|过多|稍后/.test(errorText) ? 'rate-limited' : /网络|超时|连接/.test(errorText) ? 'network'
    : /验证码|校验码/.test(errorText) ? 'invalid-code' : /账号|帐号|密码|用户名|昵称/.test(errorText) ? 'invalid-credentials' : 'unknown'
  return snapshot
}

async function actDouyu(action: LoginCardAction, inspect: () => LoginPageSnapshot): Promise<LoginPageActionResult> {
  const unsupported = (): LoginPageActionResult => ({ ok: false, reason: 'unsupported' })
  if (!['mode', 'password', 'prepare-sms', 'send-sms', 'sms', 'refresh-qr'].includes(action.kind)) return unsupported()
  const snapshot = inspect()
  if (snapshot.page !== 'form') return { ok: false, reason: 'not-ready' }
  const visible = (element: Element | null): boolean => {
    if (!element) return false
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const available = (element: Element | null) => visible(element) && !element!.hasAttribute('disabled') && element!.getAttribute('aria-disabled') !== 'true'
  const set = (input: HTMLInputElement, value: string, formattedPhone = false) => {
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    if (!native?.get || !native.set) throw new Error('Unsupported control')
    const previous = String(native.get.call(input))
    if ((formattedPhone ? previous.replace(/\s+/g, '') : previous) === value) return
    native.set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
  try {
    if (action.kind === 'mode') {
      if (action.mode !== 'password' && action.mode !== 'sms') return { ok: false, reason: 'invalid-input' }
      const tab = document.querySelector<HTMLElement>(`.js-l-stype[data-subtype="login-by-${action.mode === 'password' ? 'password' : 'sms'}"]`)
      if (!available(tab)) return { ok: false, reason: 'not-ready' }
      if (snapshot.mode !== action.mode) tab!.click()
      return { ok: true }
    }
    if (action.kind === 'refresh-qr') {
      const button = document.querySelector<HTMLElement>('.js-scancode-box .js-qrcode-refresh')
      if (snapshot.qrStatus !== 'expired' || !available(button)) return { ok: false, reason: 'not-ready' }
      button!.click()
      return { ok: true }
    }
    if (action.kind !== 'password' && action.kind !== 'prepare-sms' && action.kind !== 'send-sms' && action.kind !== 'sms') return unsupported()
    if (action.accepted !== true) return { ok: false, reason: 'invalid-input' }
    const form = document.querySelector('.js-login-normal .login-form')!
    const submit = form.querySelector<HTMLInputElement>('.loginbox-sbt.btn-sub[type="submit"]')
    if (action.kind === 'password') {
      if (snapshot.mode !== 'password') return { ok: false, reason: 'not-ready' }
      if (!text(action.username, 30) || !text(action.password, 25)) return { ok: false, reason: 'invalid-input' }
      const username = form.querySelector<HTMLInputElement>('input[name="nicknameOrPhone"]')
      const password = form.querySelector<HTMLInputElement>('input[name="password"][type="password"]')
      if (!available(username) || !available(password) || !visible(submit)) return { ok: false, reason: 'not-ready' }
      set(username!, action.username)
      set(password!, action.password)
      await new Promise(resolve => setTimeout(resolve, 0))
      if (!form.isConnected || inspect().page !== 'form' || !available(submit)) return { ok: false, reason: 'not-ready' }
      submit!.click()
      return { ok: true }
    }
    if (snapshot.mode !== 'sms') return { ok: false, reason: 'not-ready' }
    if (!/^\+[1-9]\d{0,6}$/.test(action.countryCode) || !/^\d{4,15}$/.test(action.phone)
      || (action.countryCode === '+86' && !/^1\d{10}$/.test(action.phone))
      || (action.kind === 'sms' && !/^\d{6}$/.test(action.code))) return { ok: false, reason: 'invalid-input' }
    const area = form.querySelector<HTMLInputElement>('input[name="areaCode"].js-selectCountry-box-code')
    const country = Array.from(form.querySelectorAll('.js-select-country-list li .selectCountry-value')).find(node => node.textContent?.trim() === action.countryCode)
    if (!country) return unsupported()
    const phone = form.querySelector<HTMLInputElement>('input[name="phoneNum"]')
    const code = form.querySelector<HTMLInputElement>('input[name="phoneCaptcha"]')
    const preparing = action.kind === 'prepare-sms'
    const button = action.kind === 'send-sms' ? form.querySelector<HTMLInputElement>('.phone-send.js-sendvoice') : submit
    if (!available(area) || !available(phone) || (!preparing && !visible(button)) || (action.kind === 'sms' && !available(code))
      || (action.kind === 'send-sms' && snapshot.sms?.canSend !== true)) return { ok: false, reason: 'not-ready' }
    // The official area-code input listener updates its private SDK state and phone maxlength.
    set(area!, action.countryCode)
    const maximum = phone!.maxLength > 0 ? phone!.maxLength : 15
    if (action.phone.length > maximum) return { ok: false, reason: 'unsupported' }
    set(phone!, action.phone, true)
    if (action.kind === 'sms') set(code!, action.code)
    await new Promise(resolve => setTimeout(resolve, 0))
    if (preparing) return form.isConnected ? { ok: true } : { ok: false, reason: 'not-ready' }
    if (!form.isConnected || inspect().page !== 'form' || !available(button)) return { ok: false, reason: 'not-ready' }
    button!.click()
    return { ok: true }
  } catch { return { ok: false, reason: 'not-ready' } }
}

export const douyuLoginAdapter: LoginPageAdapter = {
  entryUrl: 'https://www.douyu.com/member/cp',
  acceptsFrame(raw) {
    try { const url = new URL(raw); return url.origin === 'https://passport.douyu.com' && url.pathname === '/member/login' && !url.username && !url.password } catch { return false }
  },
  inspectScript: `(${inspectDouyu.toString()})()`,
  actionScript(action) {
    const encoded = JSON.stringify(action).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    return `(${actDouyu.toString()})(${encoded}, ${inspectDouyu.toString()})`
  },
}
