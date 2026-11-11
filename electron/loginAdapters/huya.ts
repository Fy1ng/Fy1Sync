import type { LoginCardAction, LoginPageActionResult, LoginPageAdapter, LoginPageSnapshot } from '../loginCardContracts'

/** Current official V2 QR polling stays separate from account and verification operations. */
export const HUYA_QR_POLL_PATHS = ['/qrLgn/tryQrLogin'] as const
export const HUYA_QR_CREATE_PATHS = ['/qrLgn/getQrId'] as const
export const HUYA_QR_IMAGE_PATHS = ['/qrLgn/getQrImg'] as const

function inspectHuya(): LoginPageSnapshot {
  const url = new URL(location.href)
  const parent = url.origin === 'https://www.huya.com' && url.pathname === '/'
  if ((!parent && (url.origin !== 'https://aq.huya.com' || url.pathname !== '/p/udb_login.html')) || url.username || url.password) return { page: 'unknown' }
  const visible = (element: Element | null): boolean => {
    if (!element) return false
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none'
        || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
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
  // SMS and QR strategies mount Huya's own security document instead of TencentCaptcha.
  // Keep the complete original layer, including its close control and its async loading/errors.
  const safeLayers = Array.from(document.querySelectorAll('.layui-layer.layui-layer-iframe[type="iframe"]')).filter(visible)
    .filter(layer => {
      const frames = layer.querySelectorAll(':scope > .layui-layer-content > iframe')
      if (frames.length !== 1) return false
      const frame = frames[0]
      if (!(frame instanceof HTMLIFrameElement)) return false
      if (!frame.id.startsWith('layui-layer-iframe')) return false
      try {
        const target = new URL(frame.src, location.href)
        return target.origin === 'https://aq.huya.com' && !target.username && !target.password
          && ['/p/safe_auth/pt_auth.html', '/p/safe_auth/img_auth.html'].includes(target.pathname)
      } catch { return false }
    })
  if (safeLayers.length) {
    const layer = safeLayers.length === 1 ? safeLayers[0] : undefined
    const challenge = region(layer)
    const frames = layer ? Array.from(layer.querySelectorAll(':scope > .layui-layer-content > iframe')).filter(visible) : []
    const title = layer?.querySelector(':scope > .layui-layer-title')
    const close = layer?.querySelector(':scope > .layui-layer-setwin > .layui-layer-close')
    if (challenge && frames.length === 1 && title && close && visible(title) && visible(close)
      && challenge.width >= 240 && challenge.width <= 1000 && challenge.height >= 140 && challenge.height <= 900
      && challenge.x + challenge.width <= innerWidth + 1 && challenge.y + challenge.height <= innerHeight + 1) {
      const contained = [frames[0]!, title, close].every(element => {
        const rect = element.getBoundingClientRect()
        return rect.x >= challenge.x - 1 && rect.y >= challenge.y - 1
          && rect.right <= challenge.x + challenge.width + 1 && rect.bottom <= challenge.y + challenge.height + 1
      })
      if (contained) return { page: 'challenge', qrStatus: 'paused', challenge }
    }
    return { page: 'unknown', challengePhase: 'unknown', qrStatus: 'paused' }
  }
  const trustedTencentFrame = (frame: Element) => {
    if (!(frame instanceof HTMLIFrameElement)) return false
    try {
      const target = new URL(frame.src, location.href)
      return target.origin === 'https://t.captcha.qq.com' && target.pathname === '/cap_union_new_show' && !target.username && !target.password
    } catch { return false }
  }
  const nativeCards = Array.from(document.querySelectorAll('#tcaptcha_transform.tcaptcha-transform')).filter(visible)
    .filter(panel => {
      const frames = Array.from(panel.querySelectorAll(':scope > iframe#tcaptcha_iframe.tcaptcha-iframe'))
      return frames.length === 1 && trustedTencentFrame(frames[0]!) && visible(frames[0]!)
    })
  const nativeCard = nativeCards.length === 1 ? nativeCards[0] : undefined
  if (nativeCard) {
    const challenge = region(nativeCard)
    const frame = nativeCard.querySelector('iframe')!.getBoundingClientRect()
    // Common SDK keeps the complete puzzle and its close/refresh controls in this bounded iframe.
    if (challenge && challenge.width >= 200 && challenge.width <= 1000 && challenge.height >= 150 && challenge.height <= 900
      && challenge.x + challenge.width <= innerWidth && challenge.y + challenge.height <= innerHeight
      && !(challenge.width >= innerWidth * 0.9 && challenge.height >= innerHeight * 0.9)
      && Math.abs(frame.x - challenge.x) <= 2 && Math.abs(frame.y - challenge.y) <= 2
      && Math.abs(frame.width - challenge.width) <= 4 && Math.abs(frame.height - challenge.height) <= 4) {
      return { page: 'challenge', challengePhase: 'interactive', qrStatus: 'paused', challenge }
    }
    return { page: 'loading', challengePhase: 'unknown', qrStatus: 'paused' }
  }
  const imageChallenge = Array.from(document.querySelectorAll('.udb-imgcode-item')).find(visible)
  if (imageChallenge) {
    const challenge = region(imageChallenge.closest('.layui-layer') ?? imageChallenge)
    return { page: 'challenge', challengePhase: 'interactive', qrStatus: 'paused', ...(challenge ? { challenge } : {}) }
  }
  // The trigger's #TencentCaptcha ID is not a mounted puzzle. Never crop a full-screen wrapper.
  if (shown('#t_verify.t-verify')) return { page: 'loading', challengePhase: 'loading', qrStatus: 'paused' }
  const pendingNative = Array.from(document.querySelectorAll('#tcaptcha_transform.tcaptcha-transform')).some(panel => {
    if (getComputedStyle(panel).display === 'none') return false
    const rect = panel.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && getComputedStyle(panel).opacity === '0'
      && Array.from(panel.querySelectorAll('iframe')).some(trustedTencentFrame)
  })
  if (pendingNative) return { page: 'loading', challengePhase: 'loading', qrStatus: 'paused' }
  const visibleFrames = Array.from(document.querySelectorAll('iframe')).filter(visible)
  if (visibleFrames.some(trustedTencentFrame)) return { page: 'loading', challengePhase: 'unknown', qrStatus: 'paused' }
  if (shown('#tcaptcha_transform, [id^="tcaptcha_wrapper_transform_"], #tcaptcha_iframe, .geetest_panel_box, .geetest4_box, .geetest4_popup')) {
    return { page: 'unknown', challengePhase: 'unknown', qrStatus: 'paused' }
  }
  if (parent) return { page: 'loading' }
  // Dynamic token, safe-auth upgrades and binding frames are not the verified SMS/email form.
  if (visibleFrames.length || shown('.udb-yycode-item, #login-pop, #register-main, .layui-layer-page')) return { page: 'unknown', qrStatus: 'paused' }
  if (document.readyState === 'loading') return { page: 'loading', qrStatus: 'loading' }
  const tab = document.querySelector('#login-head-nav li.on')
  const mode = tab?.getAttribute('udb-eid') === '40' ? 'password' : tab?.getAttribute('udb-eid') === '12' ? 'sms' : undefined
  if (!tab && !document.querySelector('#account-login-form, #phone-login-form')) return { page: 'loading', qrStatus: 'paused' }
  if (!mode || !visible(tab)) return { page: 'unknown' }
  const form = document.querySelector(mode === 'password' ? '#account-login-form' : '#phone-login-form')
  const expected = mode === 'password' ? '#username, #password' : '.udb-input-tel, .udb-input-code'
  const fields = Array.from(form?.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])') ?? []).filter(visible)
  if (!visible(form) || fields.length !== 2 || fields.some(field => !field.matches(expected))
    || !visible(form!.querySelector(mode === 'password' ? '#login-btn' : '#phone-login-btn'))) return { page: 'unknown' }
  const snapshot: LoginPageSnapshot = { page: 'form', mode, qrStatus: 'loading', sms: { canSend: false, cooldownSeconds: null } }
  const image = document.querySelector<HTMLImageElement>('#qr-image')
  if (visible(image)) {
    const rect = image!.getBoundingClientRect()
    if ([rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && Math.abs(rect.x) <= 10_000 && Math.abs(rect.y) <= 10_000 && rect.width <= 2000 && rect.height <= 2000) {
      snapshot.qr = { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
      try {
        const src = image!.src
        const target = new URL(src)
        if (src.length <= 262_144 && target.origin === 'https://udblgn.huya.com' && target.pathname === '/qrLgn/getQrImg'
          && !target.username && !target.password) snapshot.qr.src = src
      } catch { /* A pending/unsupported image is handled through main-owned QR geometry. */ }
      snapshot.qrStatus = 'ready'
    }
  }
  if (shown('#qr-invalid')) snapshot.qrStatus = 'expired'
  else if (shown('#scan-success')) snapshot.qrStatus = 'scanned'
  const send = form!.querySelector('.get-sms-code')
  if (send && visible(send)) {
    const caption = send.textContent?.trim() ?? ''
    const remaining = caption.match(/\((\d{1,3})\s*s\)/i)
    const count = remaining ? Number(remaining[1]) : null
    const enabled = ['1', '2'].includes(send.getAttribute('enabled') ?? '') && !send.hasAttribute('disabled')
      && send.getAttribute('aria-disabled') !== 'true' && !send.classList.contains('disable')
    const readyCaption = /^(?:获取验证码|重新获取)$/.test(caption)
    snapshot.sms = { canSend: enabled && readyCaption && count === null, cooldownSeconds: count !== null && count <= 300 ? count : enabled && readyCaption ? 0 : null }
  }
  const errorText = Array.from(document.querySelectorAll(`${mode === 'password' ? '#account-login-form' : '#phone-login-form'} .input-error-tips, .layui-layer-msg .layui-layer-content`))
    .filter(visible).map(node => node.textContent ?? '').join(' ').slice(0, 512).trim()
  if (errorText && !/已发送|发送成功|登录成功/.test(errorText)) snapshot.error = /频繁|过多|稍后/.test(errorText) ? 'rate-limited'
    : /网络|超时|连接/.test(errorText) ? 'network' : /验证码|校验码/.test(errorText) ? 'invalid-code'
      : /账号|帐号|密码|用户名/.test(errorText) ? 'invalid-credentials' : 'unknown'
  return snapshot
}

/** Read-only inspection of the observed vendor document, never an account-action target. */
function inspectHuyaTencentChallenge(): LoginPageSnapshot {
  const url = new URL(location.href)
  if (url.origin !== 'https://t.captcha.qq.com' || url.pathname !== '/cap_union_new_show' || url.username || url.password) return { page: 'unknown' }
  const visible = (element: Element | null): boolean => {
    if (!element) return false
    const own = getComputedStyle(element)
    if (own.visibility === 'hidden' || own.visibility === 'collapse') return false
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none'
        || (style.opacity !== '' && Number(style.opacity) === 0)) return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const state = (challengePhase: LoginPageSnapshot['challengePhase']): LoginPageSnapshot => ({ page: 'loading', challengePhase, qrStatus: 'paused' })
  const cards = Array.from(document.querySelectorAll('.tcaptcha-window')).filter(visible)
  if (cards.length !== 1) return state(document.readyState === 'loading' ? 'loading' : 'unknown')
  const card = cards[0]!
  const shown = (selector: string) => Array.from(card.querySelectorAll(selector)).some(visible)
  // Result and refresh layers remain mounted together with the old decoded image.
  if (shown('#tcaptcha_success.tcaptcha-cover--success')) return state('passed')
  if (shown('#tcaptcha_refresh.tcaptcha-cover, .tcaptcha-cover--refresh_show, .tcaptcha-initing-dots')) return state('loading')
  if (shown('.tcaptcha-network-error, .tcaptcha-cover')) return state('unknown')
  const one = (selector: string) => {
    const nodes = Array.from(card.querySelectorAll(selector)).filter(visible)
    return nodes.length === 1 ? nodes[0] : undefined
  }
  const header = one(':scope > .tcaptcha-header')
  const body = one(':scope > .tcaptcha-opearea')
  const footer = one(':scope > .tcaptcha-status')
  const close = one('.tcaptcha-action--close > #close.tcaptcha-action-icon')
  const refresh = one('.tcaptcha-action--refresh > #reload.tcaptcha-action-icon')
  const image = one('#tcaptcha_imgarea > img#tcaptcha-img.tcaptcha-img')
  if (!header || !body || !footer || !close || !refresh) return state('unknown')
  if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return state('loading')
  const r = card.getBoundingClientRect()
  if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.x < 0 || r.y < 0
    || r.width < 200 || r.width > 1000 || r.height < 150 || r.height > 900
    || r.x + r.width > innerWidth || r.y + r.height > innerHeight) return state('unknown')
  // Include the whole original card and every official control. The vendor iframe can be card-sized.
  for (const element of [header, body, footer, close, refresh, image]) {
    const child = element.getBoundingClientRect()
    if (![child.x, child.y, child.width, child.height].every(Number.isFinite)
      || child.x < r.x || child.y < r.y || child.x + child.width > r.x + r.width + 1
      || child.y + child.height > r.y + r.height + 1 || getComputedStyle(element).pointerEvents === 'none') return state('unknown')
  }
  return { page: 'challenge', challengePhase: 'interactive', qrStatus: 'paused', challenge: { x: r.x, y: r.y, width: r.width, height: r.height } }
}

async function actHuya(action: LoginCardAction, inspect: () => LoginPageSnapshot): Promise<LoginPageActionResult> {
  if (!['mode', 'password', 'prepare-sms', 'send-sms', 'sms', 'refresh-qr'].includes(action.kind)) return { ok: false, reason: 'unsupported' }
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
    && element!.getAttribute('enabled') !== '0'
  const set = (input: HTMLInputElement, value: string) => {
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    if (!native?.get || !native.set) throw new Error('Unsupported control')
    if (String(native.get.call(input)) === value) return
    native.set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
  try {
    if (action.kind === 'mode') {
      if (action.mode !== 'password' && action.mode !== 'sms') return { ok: false, reason: 'invalid-input' }
      const tab = document.querySelector<HTMLElement>(`#login-head-nav li[udb-eid="${action.mode === 'password' ? '40' : '12'}"]`)
      if (!available(tab)) return { ok: false, reason: 'not-ready' }
      if (snapshot.mode !== action.mode) tab!.click()
      return { ok: true }
    }
    if (action.kind === 'refresh-qr') {
      const button = document.querySelector<HTMLElement>('#qr-invalid .refresh')
      if (snapshot.qrStatus !== 'expired' || !available(button)) return { ok: false, reason: 'not-ready' }
      button!.click()
      return { ok: true }
    }
    if (action.kind !== 'password' && action.kind !== 'prepare-sms' && action.kind !== 'send-sms' && action.kind !== 'sms') return { ok: false, reason: 'unsupported' }
    if (action.accepted !== true) return { ok: false, reason: 'invalid-input' }
    if (action.kind === 'password') {
      if (snapshot.mode !== 'password') return { ok: false, reason: 'not-ready' }
      if (!text(action.username, 35) || !text(action.password, 20)) return { ok: false, reason: 'invalid-input' }
      const username = document.querySelector<HTMLInputElement>('#account-login-form #username')
      const password = document.querySelector<HTMLInputElement>('#account-login-form #password')
      const submit = document.querySelector<HTMLElement>('#account-login-form #login-btn')
      if (!available(username) || !available(password) || !visible(submit)) return { ok: false, reason: 'not-ready' }
      set(username!, action.username)
      set(password!, action.password)
      await new Promise(resolve => setTimeout(resolve, 0))
      if (!submit!.isConnected || inspect().page !== 'form' || !available(submit)) return { ok: false, reason: 'not-ready' }
      submit!.click()
      return { ok: true }
    }
    if (snapshot.mode !== 'sms') return { ok: false, reason: 'not-ready' }
    if (!/^\+[1-9]\d{0,6}$/.test(action.countryCode) || !/^\d{4,15}$/.test(action.phone)
      || (action.countryCode === '+86' && !/^1\d{10}$/.test(action.phone)) || (action.kind === 'sms' && !/^\d{6}$/.test(action.code))) return { ok: false, reason: 'invalid-input' }
    const form = document.querySelector('#phone-login-form')!
    const area = form.querySelector('.sel-areas')
    const country = Array.from(form.querySelectorAll('.sel-areas-list .areasNumber')).find(node => node.getAttribute('areascode') === action.countryCode.slice(1))
    const item = country?.closest<HTMLElement>('li')
    if (!item) return { ok: false, reason: 'unsupported' }
    const phone = form.querySelector<HTMLInputElement>('.udb-input-tel')
    const code = form.querySelector<HTMLInputElement>('.udb-input-code')
    const preparing = action.kind === 'prepare-sms'
    const button = action.kind === 'send-sms' ? form.querySelector<HTMLElement>('.get-sms-code') : form.querySelector<HTMLElement>('#phone-login-btn')
    if (!available(area) || !available(phone) || (!preparing && !visible(button)) || (action.kind === 'sms' && !available(code))
      || (action.kind === 'send-sms' && snapshot.sms?.canSend !== true)) return { ok: false, reason: 'not-ready' }
    // Click the actual official option: its listener updates the SDK's areasCode attribute.
    if (area!.getAttribute('areascode') !== action.countryCode.slice(1)) item.click()
    if (area!.getAttribute('areascode') !== action.countryCode.slice(1)) return { ok: false, reason: 'unsupported' }
    set(phone!, action.phone)
    if (action.kind === 'sms') set(code!, action.code)
    await new Promise(resolve => setTimeout(resolve, 0))
    if (preparing) return form.isConnected ? { ok: true } : { ok: false, reason: 'not-ready' }
    if (!form.isConnected || inspect().page !== 'form' || !available(button)) return { ok: false, reason: 'not-ready' }
    button!.click()
    return { ok: true }
  } catch { return { ok: false, reason: 'not-ready' } }
}

function prepareHuya(): LoginPageActionResult {
  if (location.origin !== 'https://www.huya.com' || location.pathname !== '/') return { ok: false, reason: 'unsupported' }
  if (document.querySelector('#UDBSdkLgn_iframe') || document.documentElement.hasAttribute('data-fy1sync-login-prepared')) return { ok: true }
  const button = document.querySelector<HTMLElement>('a[class*="LoginHd--"]')
  if (!button) return { ok: false, reason: 'not-ready' }
  document.documentElement.setAttribute('data-fy1sync-login-prepared', 'true')
  button.click()
  return { ok: true }
}

/** Keep the login page covered throughout the SDK's fade-out and iframe removal. */
function presentHuyaChallenge(challengeOnly: boolean): LoginPageActionResult {
  if (!(location.origin === 'https://www.huya.com' && location.pathname === '/')
    && !(location.origin === 'https://aq.huya.com' && location.pathname === '/p/udb_login.html')) return { ok: false, reason: 'unsupported' }
  const enabled = 'data-fy1sync-challenge-only'
  const path = 'data-fy1sync-challenge-path'
  const root = 'data-fy1sync-challenge-root'
  const styleId = 'fy1sync-challenge-paint'
  document.documentElement.removeAttribute(enabled)
  for (const element of document.querySelectorAll(`[${path}],[${root}]`)) {
    element.removeAttribute(path)
    element.removeAttribute(root)
  }
  if (!challengeOnly) { document.getElementById(styleId)?.remove(); return { ok: true } }
  if (!document.body) return { ok: false, reason: 'not-ready' }
  let style = document.getElementById(styleId)
  if (!style) {
    style = document.createElement('style')
    style.id = styleId
    // clip-path removes paint without changing geometry, visibility checks or form event handlers.
    // The rules continue to cover newly inserted siblings and survive removal of the selected root.
    style.textContent = `html[${enabled}],html[${enabled}] body{background:#18181b!important;background-image:none!important}
      html[${enabled}] body>:not([${path}]),html[${enabled}] [${path}]:not([${root}])>:not([${path}]){clip-path:inset(50%)!important}
      html[${enabled}] [${path}]:not([${root}]){background:#18181b!important;background-image:none!important;box-shadow:none!important}`
    document.head.appendChild(style)
  }
  const visible = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const value = getComputedStyle(node)
      if (node.hasAttribute('hidden') || value.display === 'none' || value.visibility === 'hidden' || value.opacity === '0') return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const candidates = Array.from(document.querySelectorAll('.layui-layer.layui-layer-iframe[type="iframe"], #tcaptcha_transform.tcaptcha-transform, .udb-imgcode-item')).filter(visible)
  const selected = candidates.length === 1 ? candidates[0]!.closest('.layui-layer') ?? candidates[0]! : undefined
  // The parent document must retain the original account iframe while its child protects its own page.
  const subject = selected ?? (location.origin === 'https://www.huya.com' ? document.getElementById('UDBSdkLgn_iframe') : null)
  if (subject) {
    subject.setAttribute(root, '')
    for (let element: Element | null = subject; element && element !== document.documentElement; element = element.parentElement) element.setAttribute(path, '')
  } else document.body.setAttribute(path, '')
  document.documentElement.setAttribute(enabled, '')
  return { ok: true }
}

export const huyaLoginAdapter: LoginPageAdapter = {
  entryUrl: 'https://www.huya.com/',
  acceptsFrame(raw) {
    try { const url = new URL(raw); return !url.username && !url.password && ((url.origin === 'https://aq.huya.com' && url.pathname === '/p/udb_login.html')
      || (url.origin === 'https://www.huya.com' && url.pathname === '/')) } catch { return false }
  },
  inspectScript: `(${inspectHuya.toString()})()`,
  acceptsChallengeFrame(raw: string) {
    try {
      const url = new URL(raw)
      return url.origin === 'https://t.captcha.qq.com' && url.pathname === '/cap_union_new_show' && !url.username && !url.password
    } catch { return false }
  },
  challengeInspectScript: `(${inspectHuyaTencentChallenge.toString()})()`,
  presentationScript: challengeOnly => `(${presentHuyaChallenge.toString()})(${challengeOnly})`,
  prepareScript: `(${prepareHuya.toString()})()`,
  actionScript(action) {
    const encoded = JSON.stringify(action).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    return `(${actHuya.toString()})(${encoded}, ${inspectHuya.toString()})`
  },
}
