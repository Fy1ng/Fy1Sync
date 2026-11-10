import type { LoginCardAction, LoginPageActionResult, LoginPageAdapter, LoginPageSnapshot } from '../loginCardContracts'

/** Observed anonymous SDK requests. Polling never proves an authenticated identity. */
export const DOUYIN_QR_POLL_PATHS = ['/passport/web/check_qrconnect/'] as const
export const DOUYIN_QR_CREATE_PATHS = ['/passport/web/get_qrcode/'] as const
export const DOUYIN_QR_EXPIRE_PATHS = ['/passport/web/expire_qrcode/'] as const

function inspectDouyin(): LoginPageSnapshot {
  const url = new URL(location.href)
  if (url.origin !== 'https://live.douyin.com' || url.pathname !== '/' || url.username || url.password) return { page: 'unknown' }
  const visible = (element: Element | null | undefined): boolean => {
    if (!element || (element instanceof HTMLInputElement && element.type === 'hidden')) return false
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none'
        || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const region = (element: Element | undefined) => {
    if (!visible(element)) return undefined
    const rect = element!.getBoundingClientRect()
    return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0
      && rect.x <= 4096 && rect.y <= 4096 && rect.width >= 20 && rect.height >= 20 && rect.width <= 2048 && rect.height <= 2048
      && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined
  }
  const nativeRoots = Array.from(document.querySelectorAll('#uc-second-verify')).filter(element => {
    // Its fixed-position children can be visible while the portal root itself has zero height.
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none'
        || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
    }
    return true
  })
  const nativeVerification = nativeRoots.length > 0 ? { nativeVerification: true as const } : {}
  // The observed nocaptcha/storage frames are normally hidden and must not steal the card.
  const challenges = Array.from(document.querySelectorAll('#captcha_container, #verify_center_cn, .captcha_verify_container')).filter(visible)
  if (challenges.length) {
    const panel = challenges.find(node => !challenges.some(other => other !== node && node.contains(other)))
    const candidate = panel && (Array.from(panel.querySelectorAll('iframe')).find(visible) ?? panel)
    const challenge = region(candidate)
    if (challenge && !(challenge.width >= innerWidth * .9 && challenge.height >= innerHeight * .9)) return { page: 'challenge', challengePhase: 'interactive', qrStatus: 'paused', challenge, ...nativeVerification }
    return { page: 'loading', challengePhase: 'unknown', qrStatus: 'paused', ...nativeVerification }
  }
  if (nativeRoots.length) {
    const panels = nativeRoots.length === 1 ? Array.from(nativeRoots[0]!.querySelectorAll(
      '.second-verify-panel, [class*="second_verify_panel_new-"], [class*="face_auth_panel_new-"], [class*="face_auth_panel_new_h5-"]',
    )).filter(visible) : []
    const challenge = panels.length === 1 ? region(panels[0]) : undefined
    if (challenge && !(challenge.width >= innerWidth * .9 && challenge.height >= innerHeight * .9)) {
      return { page: 'challenge', challengePhase: 'interactive', qrStatus: 'paused', nativeVerification: true, challenge }
    }
    return { page: 'loading', challengePhase: panels.length ? 'unknown' : 'loading', qrStatus: 'paused', nativeVerification: true }
  }
  const visibleFrames = Array.from(document.querySelectorAll('iframe')).filter(frame => visible(frame) && frame.getBoundingClientRect().width >= 20 && frame.getBoundingClientRect().height >= 20)
  if (visibleFrames.length) return { page: 'unknown', qrStatus: 'paused' }
  const root = document.querySelector('#login-panel-new') ?? document.querySelector('#douyin-login-new-id') ?? document.querySelector('#douyin_login_new')
  if (!root || !visible(root)) return { page: 'loading', qrStatus: 'loading', nativeVerification: false }
  if (document.querySelectorAll(`#${root.id}`).length !== 1) return { page: 'unknown', qrStatus: 'paused' }
  if (Array.from(root.querySelectorAll('#douyin_login_account_select_content_page, #douyin_login_comp_email_code')).some(visible)) return { page: 'unknown', qrStatus: 'paused' }
  const smsPanel = root.querySelector('#douyin_login_comp_mobile_code')
  const passwordPanel = root.querySelector('#douyin_login_comp_account_pwd')
  const mode = visible(smsPanel) && !visible(passwordPanel) ? 'sms' : visible(passwordPanel) && !visible(smsPanel) ? 'password' : undefined
  if (!mode) return { page: 'unknown', qrStatus: 'paused' }
  const panel = mode === 'sms' ? smsPanel! : passwordPanel!
  const inputs = Array.from(panel.querySelectorAll<HTMLInputElement>('input')).filter(visible)
  const phone = panel.querySelector('input[name="normal-input"][type="tel"][placeholder="请输入手机号"]')
  const country = panel.querySelector('input[name="web-login-area-code-input"][role="combobox"]')
  const other = panel.querySelector(mode === 'sms' ? 'input[name="button-input"][type="tel"][placeholder="请输入验证码"]' : 'input[name="normal-input"][type="password"][placeholder="请输入密码"]')
  const submit = panel.querySelector('#douyin_login_comp_btn_id')
  if (!visible(phone) || !visible(country) || !visible(other) || inputs.length !== 3 || !visible(submit)) return { page: 'unknown', qrStatus: 'paused' }
  if (submit!.textContent?.trim() !== '登录') return { page: 'loading', qrStatus: 'paused',
    ...(submit!.classList.contains('qOAoUpHW') ? { submissionPending: true as const } : {}) }
  const snapshot: LoginPageSnapshot = { page: 'form', mode, qrStatus: 'loading', sms: { canSend: false, cooldownSeconds: null } }
  const qrBox = root.querySelector('#douyin_login_comp_scan_code_qrcode')
  if (!qrBox) snapshot.qrStatus = 'unavailable'
  const qr = qrBox && (Array.from(qrBox.querySelectorAll('img,canvas')).find(visible))
  if (qr) {
    const rect = region(qr)
    if (rect) {
      snapshot.qr = { rect }
      try {
        const src = qr instanceof HTMLImageElement ? qr.src : qr instanceof HTMLCanvasElement ? qr.toDataURL('image/png') : ''
        if (src.length <= 262144 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(src)) snapshot.qr.src = src
      } catch { /* Main can capture the original bounded QR without reading its token. */ }
      snapshot.qrStatus = 'ready'
    }
  }
  if (visible(root.querySelector('#douyin_login_comp_scan_code_qrcode_expired'))) snapshot.qrStatus = 'expired'
  else if (visible(root.querySelector('#douyin_login_comp_scan_code_avatar'))) snapshot.qrStatus = 'scanned'
  if (mode === 'sms') {
    const send = panel.querySelector('#douyin_login_comp_button_input_id > span[tabindex="0"][aria-live="off"]')
    if (visible(send)) {
      const caption = send!.textContent?.trim() ?? ''
      const match = /^(\d{1,3})s后重新发送$/i.exec(caption)
      const count = match ? Number(match[1]) : null
      const disabled = send!.hasAttribute('disabled') || send!.getAttribute('aria-disabled') === 'true'
        || ['KX2Mhb6E', 'ObYdUGy4', 'disabled'].some(value => send!.classList.contains(value))
      snapshot.sms = { canSend: !disabled && caption === '获取验证码', cooldownSeconds: count !== null && count <= 300 ? count : !disabled && caption === '获取验证码' ? 0 : null }
    }
  }
  const error = Array.from(panel.querySelectorAll('#error_text_id')).filter(visible).map(node => node.textContent ?? '').join(' ').slice(0, 512)
  if (error) snapshot.error = /频繁|过多|稍后/.test(error) ? 'rate-limited' : /网络|超时|连接/.test(error) ? 'network'
    : /验证码|校验码/.test(error) ? 'invalid-code' : /账号|帐号|密码|手机号/.test(error) ? 'invalid-credentials' : 'unknown'
  return snapshot
}

async function actDouyin(action: LoginCardAction, inspect: () => LoginPageSnapshot): Promise<LoginPageActionResult> {
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
    && !['zcAEoiw0', 'M2ui0yLR', 'KX2Mhb6E', 'ObYdUGy4', 'disabled'].some(value => element!.classList.contains(value))
  const root = document.querySelector('#login-panel-new') ?? document.querySelector('#douyin-login-new-id') ?? document.querySelector('#douyin_login_new')
  if (!root) return { ok: false, reason: 'not-ready' }
  const set = (input: HTMLInputElement, value: string, formattedPhone = false) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    if (!descriptor?.get || !descriptor.set) throw new Error('Unsupported input')
    const previous = String(descriptor.get.call(input))
    if ((formattedPhone ? previous.replace(/\s+/g, '') : previous) === value) return
    descriptor.set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
  try {
    if (action.kind === 'mode') {
      if (!['password', 'sms'].includes(action.mode)) return { ok: false, reason: 'invalid-input' }
      if (snapshot.mode === action.mode) return { ok: true }
      const tab = action.mode === 'sms' ? root.querySelector<HTMLElement>('#douyin_login_comp_mobile_title')
        : Array.from(root.querySelectorAll<HTMLElement>('span')).find(node => visible(node) && node.textContent?.trim() === '密码登录')
      if (!available(tab ?? null)) return { ok: false, reason: 'not-ready' }
      tab!.click()
      return { ok: true }
    }
    if (action.kind === 'refresh-qr') {
      const expired = root.querySelector<HTMLElement>('#douyin_login_comp_scan_code_qrcode_expired')
      if (snapshot.qrStatus !== 'expired' || !available(expired)) return { ok: false, reason: 'not-ready' }
      expired!.click()
      return { ok: true }
    }
    if (action.kind !== 'password' && action.kind !== 'prepare-sms' && action.kind !== 'send-sms' && action.kind !== 'sms') return unsupported()
    if (action.accepted !== true) return { ok: false, reason: 'invalid-input' }
    const panel = root.querySelector(snapshot.mode === 'sms' ? '#douyin_login_comp_mobile_code' : '#douyin_login_comp_account_pwd')!
    const phone = panel.querySelector<HTMLInputElement>('input[name="normal-input"][type="tel"]')
    const country = panel.querySelector<HTMLInputElement>('input[name="web-login-area-code-input"][role="combobox"]')
    const submit = panel.querySelector<HTMLElement>('#douyin_login_comp_btn_id')
    const consent = async (): Promise<boolean> => {
      const agreement = panel.querySelector<HTMLElement>('[role="checkbox"][aria-label="协议勾选框"]')
      if (agreement && agreement.getAttribute('aria-checked') !== 'true') { if (!available(agreement)) return false; agreement.click(); await new Promise(resolve => setTimeout(resolve, 0)); if (agreement.getAttribute('aria-checked') !== 'true') return false }
      return Boolean(panel.querySelector('[aria-label^="登录即代表同意"]'))
    }
    if (!available(phone) || !available(country)) return { ok: false, reason: 'not-ready' }
    if (action.kind === 'password') {
      if (snapshot.mode !== 'password') return { ok: false, reason: 'not-ready' }
      const password = panel.querySelector<HTMLInputElement>('input[name="normal-input"][type="password"]')
      if (!text(action.username, 20) || !/^\d{4,20}$/.test(action.username) || (country!.value === '+86' && !/^1\d{10}$/.test(action.username))
        || !text(action.password, 128)) return { ok: false, reason: 'invalid-input' }
      if (!available(password)) return { ok: false, reason: 'not-ready' }
      if (password!.maxLength > 0 && action.password.length > password!.maxLength) return { ok: false, reason: 'invalid-input' }
      if (!await consent()) return { ok: false, reason: 'not-ready' }
      set(phone!, action.username, true); set(password!, action.password)
      await new Promise(resolve => setTimeout(resolve, 0))
      if (!panel.isConnected || inspect().page !== 'form' || !available(submit)) return { ok: false, reason: 'not-ready' }
      submit!.click(); return { ok: true }
    }
    if (snapshot.mode !== 'sms') return { ok: false, reason: 'not-ready' }
    const code = panel.querySelector<HTMLInputElement>('input[name="button-input"][type="tel"]')
    if (!/^\+[1-9]\d{0,3}$/.test(action.countryCode) || !/^\d{4,20}$/.test(action.phone) || (action.countryCode === '+86' && !/^1\d{10}$/.test(action.phone))
      || (action.kind === 'sms' && (!/^(?:\d{4}|\d{6})$/.test(action.code) || (code?.maxLength === 4 || code?.maxLength === 6) && action.code.length !== code.maxLength))) return { ok: false, reason: 'invalid-input' }
    if (action.kind === 'send-sms' && (snapshot.sms?.cooldownSeconds ?? 0) > 0) return { ok: false, reason: 'not-ready' }
    if (!await consent()) return { ok: false, reason: 'not-ready' }
    if (country!.value !== action.countryCode) {
      country!.focus(); country!.click(); await new Promise(resolve => setTimeout(resolve, 0))
      const option = panel.querySelector<HTMLElement>(`#select-ul li[data-itemvalue="${action.countryCode}"]`)
      if (!available(option)) return { ok: false, reason: 'unsupported' }
      // Both the observed country selector and SMS send control use onMouseDown.
      option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
      await new Promise(resolve => setTimeout(resolve, 0))
      if (country!.value !== action.countryCode) return { ok: false, reason: 'unsupported' }
    }
    set(phone!, action.phone, true)
    if (action.kind === 'sms') { if (!available(code)) return { ok: false, reason: 'not-ready' }; set(code!, action.code) }
    await new Promise(resolve => setTimeout(resolve, 0))
    if (!panel.isConnected || inspect().page !== 'form') return { ok: false, reason: 'not-ready' }
    if (action.kind === 'prepare-sms') return { ok: true }
    if (action.kind === 'send-sms') {
      const send = panel.querySelector<HTMLElement>('#douyin_login_comp_button_input_id > span[tabindex="0"][aria-live="off"]')
      if (inspect().sms?.canSend !== true || !available(send)) return { ok: false, reason: 'not-ready' }
      send!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); return { ok: true }
    }
    if (!available(submit)) return { ok: false, reason: 'not-ready' }
    submit!.click(); return { ok: true }
  } catch { return { ok: false, reason: 'not-ready' } }
}

async function prepareDouyin(): Promise<LoginPageActionResult> {
  if (location.origin !== 'https://live.douyin.com' || location.pathname !== '/') return { ok: false, reason: 'unsupported' }
  if (document.querySelector('#login-panel-new, #douyin-login-new-id, #douyin_login_new')) return { ok: true }
  const visible = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) { const style = getComputedStyle(node)
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false }
    const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0
  }
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button.semi-button.semi-button-primary')).filter(node => node.textContent?.trim() === '登录' && visible(node))
  if (buttons.length !== 1 || buttons[0]!.disabled) return { ok: false, reason: 'not-ready' }
  const key = 'data-fy1sync-douyin-login-open-ms'
  const previous = document.documentElement.getAttribute(key)
  if (previous && Date.now() - Number(previous) < 2000) return { ok: false, reason: 'not-ready' }
  document.documentElement.setAttribute(key, String(Date.now()))
  const button = buttons[0]!
  // Live uses lazy hydration. Prepare its normal hover/focus path before clicking once.
  button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  button.dispatchEvent(new Event('pointerover', { bubbles: true }))
  button.focus(); await new Promise(resolve => setTimeout(resolve, 300))
  if (!button.isConnected || location.origin !== 'https://live.douyin.com' || location.pathname !== '/') return { ok: false, reason: 'not-ready' }
  button.click(); await new Promise(resolve => setTimeout(resolve, 100))
  return document.querySelector('#login-panel-new, #douyin-login-new-id, #douyin_login_new') ? { ok: true } : { ok: false, reason: 'not-ready' }
}

function presentDouyinChallenge(enabled: boolean): LoginPageActionResult {
  if (location.origin !== 'https://live.douyin.com' || location.pathname !== '/') return { ok: false, reason: 'unsupported' }
  const marker = 'data-fy1sync-douyin-challenge-only', path = 'data-fy1sync-douyin-challenge-path', root = 'data-fy1sync-douyin-challenge-root', styleId = 'fy1sync-douyin-challenge-paint'
  document.documentElement.removeAttribute(marker)
  for (const element of document.querySelectorAll(`[${path}],[${root}]`)) { element.removeAttribute(path); element.removeAttribute(root) }
  if (!enabled) { document.getElementById(styleId)?.remove(); return { ok: true } }
  if (!document.body) return { ok: false, reason: 'not-ready' }
  let style = document.getElementById(styleId)
  if (!style) { style = document.createElement('style'); style.id = styleId; style.textContent = `html[${marker}],html[${marker}] body{background:#18181b!important;background-image:none!important}
    html[${marker}] body>:not([${path}]),html[${marker}] [${path}]:not([${root}])>:not([${path}]){clip-path:inset(50%)!important}
    html[${marker}] [${path}]:not([${root}]){background:#18181b!important;background-image:none!important;box-shadow:none!important}`; document.head.appendChild(style) }
  const candidates = Array.from(document.querySelectorAll('#captcha_container, #verify_center_cn, .captcha_verify_container, '
    + '#uc-second-verify .second-verify-panel, #uc-second-verify [class*="second_verify_panel_new-"], '
    + '#uc-second-verify [class*="face_auth_panel_new-"], #uc-second-verify [class*="face_auth_panel_new_h5-"]')).filter(element => {
    for (let node: Element | null = element; node; node = node.parentElement) { const value = getComputedStyle(node); if (value.display === 'none' || value.visibility === 'hidden' || value.opacity === '0') return false }
    const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0
  })
  const selected = candidates.find(element => !candidates.some(other => other !== element && element.contains(other)))
  if (selected) { selected.setAttribute(root, ''); for (let element: Element | null = selected; element && element !== document.documentElement; element = element.parentElement) element.setAttribute(path, '') }
  else document.body.setAttribute(path, '')
  document.documentElement.setAttribute(marker, '')
  return { ok: true }
}

export const douyinLoginAdapter: LoginPageAdapter = {
  entryUrl: 'https://live.douyin.com/',
  acceptsFrame(raw) { try { const url = new URL(raw); return url.origin === 'https://live.douyin.com' && url.pathname === '/' && !url.username && !url.password } catch { return false } },
  // Observed hidden no-captcha and storage documents receive no account actions.
  acceptsChallengeFrame: () => false,
  inspectScript: `(${inspectDouyin.toString()})()`,
  prepareScript: `(${prepareDouyin.toString()})()`,
  presentationScript: enabled => `(${presentDouyinChallenge.toString()})(${enabled})`,
  actionScript(action) {
    const encoded = JSON.stringify(action).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    return `(${actDouyin.toString()})(${encoded}, ${inspectDouyin.toString()})`
  },
}
