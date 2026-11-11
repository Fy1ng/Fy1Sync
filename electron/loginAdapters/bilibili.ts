import type { LoginCardAction, LoginPageAdapter, LoginPageSnapshot } from '../loginCardContracts'

/** Selectors come from official passport bundles and public Geetest fullpage/click/slide SDKs. */
function pageRuntime() {
  const visible = (element: Element | null): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) return false
    const ownStyle = getComputedStyle(element)
    if (ownStyle.visibility === 'hidden' || ownStyle.visibility === 'collapse') return false
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current)
      if (style.display === 'none'
        || (style.opacity !== '' && Number(style.opacity) === 0) || current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const one = (selector: string, scope: ParentNode = document): HTMLElement | undefined => {
    const matches = [...scope.querySelectorAll(selector)].filter(visible)
    return matches.length === 1 ? matches[0] : undefined
  }
  const active = (element: HTMLElement | undefined) => !!element && visible(element)
    && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true'
    && !element.classList.contains('disabled') && !element.classList.contains('disable')
    && getComputedStyle(element).pointerEvents !== 'none'
  const trustedChallengeFrames = ['api.geetest.com', 'api.geevisit.com', 'static.geetest.com', 'static.geevisit.com', 'gcaptcha4.geetest.com', 'gcaptcha4.geevisit.com', 'gcaptcha4.gsensebot.com']
    .flatMap(host => [`iframe[src^="https://${host}/"]`, `iframe[src^="//${host}/"]`]).join(', ')
  const challengeFrames = `${trustedChallengeFrames}, iframe[title*="验证码"]`
  const some = (selector: string, scope: ParentNode = document) => [...scope.querySelectorAll(selector)].some(visible)
  const imageDialog = (element: Element) => element.matches('.dialog__outline')
    && some('.body__captcha-input', element) && some('.body__captcha-img_wp', element) && some('.dialog__footer', element)
  const modalRoots = '.geetest_panel_box, .geetest_fullpage_click_box, .geetest_popup_box, .geetest_popup_wrap, .geetest_box, .geetest_bind_box, .geetest4_box, .geetest4_popup, .gt_popup'
  const normalInputs = '.login-pwd, .tab-sms, input.risk-input-dom'
  const challengeState = (): { phase?: LoginPageSnapshot['challengePhase']; region?: LoginPageSnapshot['challenge'] } => {
    const roots = [...document.querySelectorAll(`${modalRoots}, .geetest_holder, .gt_holder, .dialog__outline, ${challengeFrames}`)].filter(visible)
      .filter(root => !root.matches('.dialog__outline') || imageDialog(root))
      // The fullpage detector remains mounted before and after a challenge; it is not an open puzzle.
      .filter(root => !root.matches('.geetest_holder') || !root.classList.contains('geetest_wind') || !some('.geetest_radar_btn, .geetest_success_btn', root))
    const candidates: HTMLElement[] = []
    const transitions: HTMLElement[] = []
    let pending: LoginPageSnapshot['challengePhase']
    for (const root of roots) {
      if (root.querySelector(normalInputs)) { pending ||= 'unknown'; continue }
      if (imageDialog(root)) { candidates.push(root); continue }
      if (root.matches(challengeFrames)) {
        if (root.matches(trustedChallengeFrames)) candidates.push(root)
        else pending ||= 'unknown'
        continue
      }
      // V4 bind/popup products share commonTemplate; puzzle types only replace its wrap children.
      // The bind owner may have zero height and the popup owner may be a full-screen mask.
      const owner = root.closest('.geetest_captcha.geetest_bind, .geetest_captcha.geetest_popup, .geetest_popup_wrap')
      const v4Owner = owner && (!owner.matches('.geetest_popup_wrap') || !!owner.querySelector('.geetest_box_wrap > .geetest_box')) ? owner : null
      if (v4Owner) {
        // Never let incomplete v4 fragments fall through to the more permissive legacy SDK path.
        if (!root.matches('.geetest_box, .geetest_bind_box')) continue
        // Hidden success DOM and freeze_wait remain mounted on an interactive puzzle.
        const phase = v4Owner.matches('.geetest_success, .geetest_lock_success') ? 'passed'
          : v4Owner.matches('.geetest_wait, .geetest_compute') ? 'verifying'
          : v4Owner.matches('.geetest_load, .geetest_init, .geetest_refresh') ? 'loading'
          : v4Owner.matches('.geetest_error, .geetest_lock_error, .geetest_fail') ? 'unknown' : undefined
        if (phase) { transitions.push(root); pending ||= phase; continue }
        const header = one(':scope > .geetest_header', root)
        const body = one(':scope > .geetest_container > .geetest_wrap', root)
        const footer = one(':scope > .geetest_footer', root)
        const card = root.matches('.geetest_box') && !!header && some('.geetest_title', header)
          && !!body && !!footer && some('.geetest_close', footer) && some('.geetest_refresh', footer)
        const puzzle = body && one(':scope > .geetest_subitem', body)
        // Inspect rendered surfaces, not answers, resource URLs, pixel contents or puzzle-type names.
        const rendered = puzzle && [puzzle, ...puzzle.querySelectorAll('*')].slice(0, 512).some(surface => {
          if (!visible(surface instanceof HTMLElement ? surface : surface.parentElement)
            || surface.closest('.geetest_result_tips, .geetest_loading, .geetest_success, .geetest_error')) return false
          const style = getComputedStyle(surface)
          const rect = surface.getBoundingClientRect()
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
            || (style.opacity !== '' && Number(style.opacity) === 0) || rect.width <= 0 || rect.height <= 0) return false
          if (surface instanceof HTMLImageElement) return surface.complete && surface.naturalWidth > 0 && surface.naturalHeight > 0
          if (surface.tagName === 'CANVAS') return (surface as HTMLCanvasElement).width > 0 && (surface as HTMLCanvasElement).height > 0
          if (surface.tagName.toLowerCase() === 'svg') return !!surface.querySelector('path, rect, circle, polygon, image, use')
          return /^url\(/.test(style.backgroundImage)
        })
        // A mounted but hidden slider/submit is unfinished. Disabled submit is normal before selection.
        const controls = !!puzzle && getComputedStyle(puzzle).pointerEvents !== 'none'
          && (!puzzle.querySelector('.geetest_slider') || some('.geetest_slider .geetest_btn', puzzle))
          && (!puzzle.querySelector('.geetest_submit') || some('.geetest_submit', puzzle))
        const loading = !!body && some('.geetest_loading, .geetest4_loading, .geetest_panel_loading', body)
        if (loading) { transitions.push(root); pending ||= 'loading'; continue }
        if (card && rendered && controls && v4Owner.matches('.geetest_boxShow, .geetest_nextReady, .geetest_ready')) candidates.push(root)
        else pending ||= 'unknown'
        continue
      }
      // Visible result layers take precedence over still-mounted images and slider buttons.
      if (some('.geetest_panel_success, .geetest_result.geetest_success, .geetest_result_tip.geetest_success, .geetest4_success', root)) { transitions.push(root); pending ||= 'passed'; continue }
      if (some('.geetest_result.geetest_load, .geetest_result_tip.geetest_load, .geetest4_verify', root)) { transitions.push(root); pending ||= 'verifying'; continue }
      // Click SDK keeps its loading icon under an absolutely positioned loaded image.
      // Only an item without a decoded visible image is still loading.
      const itemLoading = [...root.querySelectorAll('.geetest_item_loading')].filter(visible).some(loader => {
        const item = loader.closest('.geetest_item')
        if (!item) return true
        const decodedImage = [...item.querySelectorAll('.geetest_item_wrap .geetest_item_img')].some(image =>
          image instanceof HTMLImageElement && visible(image) && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)
        // Current click SDK sets the wrapper background only after its image-ready callback.
        const decodedBackground = [...item.querySelectorAll('.geetest_item_wrap')].some(wrapper =>
          visible(wrapper) && /^url\(/.test(getComputedStyle(wrapper).backgroundImage))
        return !decodedImage && !decodedBackground
      })
      if (itemLoading || some('.geetest_panel_loading, .geetest_loading, .geetest4_loading', root)) { transitions.push(root); pending ||= 'loading'; continue }
      const clickPuzzle = some('.geetest_item .geetest_item_wrap, .geetest_item .geetest_item_img', root) && some('.geetest_commit', root)
      const sliderPuzzle = some('.geetest_slider_button, .gt_slider', root)
        && some('.geetest_window .geetest_bg, .geetest_window .geetest_canvas_bg, .geetest_window .geetest_div_bg, .geetest_window .geetest_slice, .gt_bg', root)
      const otherPuzzle = some('.geetest_captcha, .geetest_canvas, .geetest4_captcha', root)
        && some('.geetest_close, .geetest_close_icon, .geetest_refresh, .geetest_refresh_icon, .gt_close, .gt_refresh', root)
      const ready = clickPuzzle || sliderPuzzle || otherPuzzle
      // Fullpage's small status box and empty .panel_next never constitute a complete puzzle.
      const bindPanel = root.matches('.geetest_panel_box') && some('.geetest_panel_next', root)
        && root.matches('.geetest_panelshowclick, .geetest_ie6panelshowclick, .geetest_panelshowslide, .geetest_panelshowbeeline')
      const card = bindPanel || root.matches('.geetest_fullpage_click_box, .geetest_popup_box, .geetest_box, .geetest4_box, .gt_popup, .geetest_holder, .gt_holder')
      const bindOwner = root.parentElement?.closest('.geetest_panel_box')
      if (ready && card && (!bindOwner || candidates.includes(bindOwner as HTMLElement))) candidates.push(root)
      else pending ||= root.matches('.geetest_panel_box') && !some('.geetest_panel_next *', root) ? 'loading' : 'unknown'
    }
    // Use the containing complete card, not the smallest image/widget or a full-screen mask.
    const available = candidates.filter(panel => !transitions.some(root => root.contains(panel)))
    const complete = available.filter(panel => !available.some(other => other !== panel && other.contains(panel)))
    const bounded = complete.filter(panel => {
      const rect = panel.getBoundingClientRect()
      return [rect.left, rect.top, rect.width, rect.height, rect.right, rect.bottom].every(Number.isFinite)
        && rect.left >= 0 && rect.top >= 0 && rect.width >= 200 && rect.width <= 1000 && rect.height >= 150 && rect.height <= 900
        && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
        && !(rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9)
    })
    const panel = complete.length === 1 && bounded.length === 1 ? bounded[0] : undefined
    if (panel) {
      const rect = panel.getBoundingClientRect()
      let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom
      // Only a nearby small SDK close control may overflow the actual card border.
      for (const control of [...panel.querySelectorAll('.geetest_close, .geetest_close_icon, .gt_close')].filter(visible).slice(0, 8)) {
        const child = control.getBoundingClientRect()
        if (child.width > 0 && child.width <= 64 && child.height > 0 && child.height <= 64
          && child.left >= rect.left - 48 && child.top >= rect.top - 48 && child.right <= rect.right + 48 && child.bottom <= rect.bottom + 48) {
          left = Math.min(left, child.left); top = Math.min(top, child.top)
          right = Math.max(right, child.right); bottom = Math.max(bottom, child.bottom)
        }
      }
      if (left >= 0 && top >= 0 && right <= window.innerWidth && bottom <= window.innerHeight) {
        return { phase: 'interactive', region: { x: left, y: top, width: right - left, height: bottom - top } }
      }
    }
    return { phase: available.length ? 'unknown' : pending }
  }
  const hasChallenge = () => !!challengeState().phase
  const second = () => {
    if (location.pathname !== '/pc/passport/riskVerify') return undefined
    const phone = one('.risk-check-phone_wp')
    const email = one('.risk-check-email_wp')
    if (!!phone === !!email) return undefined
    const scenes = new URL(location.href).searchParams.getAll('scene')
    if (scenes.length > 1) return undefined
    const scene = scenes[0] || ''
    const supported = phone ? ['', 'loginTelCheck', 'deviceVerify', 'secLogin'] : ['', 'bindPhoneUseMail', 'secLogin']
    if (!supported.includes(scene)) return undefined
    const root = phone || email!
    const input = one('input.risk-input-dom', root)
    if (!(input instanceof HTMLInputElement) || input.type !== 'text') return undefined
    if (!one('.risk-bottom-btn', root)) return undefined
    return { root, input, kind: phone ? 'sms' as const : 'email' as const }
  }
  const errorSelectors = '.toast__content, [role="alert"], .b-toast, .bili-toast, .toast-message, .van-toast, .bili-toast__text'
  type ErrorLatch = { error?: LoginPageSnapshot['error']; completedRoot?: Element; observer?: MutationObserver; timer?: number; ignored: WeakSet<Element> }
  const latchWindow = window as Window & { __fy1syncBiliErrorLatch?: ErrorLatch }
  const latch = latchWindow.__fy1syncBiliErrorLatch ||= { ignored: new WeakSet<Element>() }
  const classify = (text: string): LoginPageSnapshot['error'] => {
    if (/频繁|频次|次数过多|too many|rate limit/i.test(text)) return 'rate-limited'
    if (/验证码.*(错误|失效|过期|不正确)|请先获取.*验证码|code.*(invalid|expired|incorrect)/i.test(text)) return 'invalid-code'
    if (/密码.*(错误|不正确)|账号.*(不存在|错误|未注册)|password.*(incorrect|invalid)|invalid credentials/i.test(text)) return 'invalid-credentials'
    if (/网络|服务器|network|server busy|timeout/i.test(text)) return 'network'
    if (/发送成功|验证码已发送|验证成功|登录成功|请稍候|请稍后|正在|please wait|sent successfully|verification successful/i.test(text)) return undefined
    return text.trim() ? 'unknown' : undefined
  }
  const captureErrors = () => {
    for (const node of [...document.querySelectorAll(errorSelectors)].slice(0, 64).filter(visible)) {
      if (latch.ignored.has(node)) continue
      const toast = node.closest('.toast_wp')
      // Keep the short-lived official success signal only for this recognized code-form DOM.
      if (toast && node.matches('.toast__content') && one('.toast__content', toast) === node && some('.toast__img_loading, .toast__img_success', toast)
        && /^验证成功\s*[,，]?\s*请稍后\s*$/.test(node.textContent?.slice(0, 512).trim() || '')) {
        const step = second()
        if (step) { latch.completedRoot = step.root; latch.error = undefined }
      }
      if (toast?.querySelector('.toast__img_loading, .toast__img_success')) continue
      const classified = classify(node.textContent?.slice(0, 512) || '')
      if (classified) latch.error = classified
    }
  }
  const watchErrors = () => {
    if (latch.observer) return
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement
        const toast = target?.closest('.toast_wp')
        if (toast) for (const node of toast.querySelectorAll(errorSelectors)) latch.ignored.delete(node)
        const direct = target?.closest(errorSelectors)
        if (direct) latch.ignored.delete(direct)
      }
      captureErrors()
    })
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] })
    latch.observer = observer
    latch.timer = window.setTimeout(() => { observer.disconnect(); if (latch.observer === observer) latch.observer = undefined }, 120000)
  }
  const error = (): LoginPageSnapshot['error'] => { watchErrors(); captureErrors(); return latch.error }
  const clearError = () => {
    latch.error = undefined
    latch.completedRoot = undefined
    latch.ignored = new WeakSet([...document.querySelectorAll(errorSelectors)])
    watchErrors()
  }
  const smsState = (scope?: ParentNode): NonNullable<LoginPageSnapshot['sms']> => {
    const send = scope && one('.risk-input-after, .risk-input-after-active, .tab__form .form__item > .clickable', scope)
    if (!send) return { canSend: false, cooldownSeconds: null }
    const text = send.textContent?.trim().slice(0, 80) || ''
    const match = text.match(/\((\d{1,4})\)|(?:^|\D)(\d{1,4})\s*(?:秒|s(?:ec(?:onds?)?)?\b)/i)
    const count = match ? Number(match[1] ?? match[2]) : null
    const cooldownSeconds = count !== null && Number.isInteger(count) && count >= 0 && count <= 3600 ? count : null
    const sendLabel = /获取.*验证码|重新发送|发送.*验证码|get.*(?:code|sms)|resend|send.*(?:code|sms)/i.test(text)
    const canSend = active(send) && !send.classList.contains('risk-input-after') && sendLabel && (cooldownSeconds === null || cooldownSeconds === 0)
    return { canSend, cooldownSeconds }
  }
  const maskedTarget = (root: ParentNode, kind: 'sms' | 'email'): string | undefined => {
    const text = one('.risk-static-text-value', root)?.textContent?.trim()
    if (!text || text.length > 128 || !/\*{3,}/.test(text)) return undefined
    if (kind === 'sms') return /^\+?[\d* -]{5,40}$/.test(text) && !/\d{5}/.test(text) ? text : undefined
    return /^[A-Za-z0-9._+*\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(text) ? text : undefined
  }
  const inspect = (): LoginPageSnapshot => {
    let reportedError = error()
    const verification = second()
    const completed = verification && latch.completedRoot === verification.root
    if (completed) reportedError = undefined
    const challenge = challengeState()
    if (challenge.phase && !completed) {
      return { page: challenge.phase === 'interactive' || challenge.phase === 'unknown' ? 'challenge' : 'loading', challengePhase: challenge.phase, qrStatus: 'paused', ...(challenge.region ? { challenge: challenge.region } : {}), ...(reportedError ? { error: reportedError } : {}) }
    }
    if (verification) {
      const target = maskedTarget(verification.root, verification.kind)
      return {
        page: 'second-factor', qrStatus: 'paused', verification: { kind: verification.kind, ...(target ? { maskedTarget: target } : {}) },
        ...(completed ? { verificationCompleted: true as const } : {}),
        sms: smsState(verification.root), ...(reportedError ? { error: reportedError } : {}),
      }
    }
    if (location.pathname === '/pc/passport/riskVerify') return { page: 'unknown', qrStatus: 'paused', ...(reportedError ? { error: reportedError } : {}) }
    const password = one('.main__right .login-pwd .tab__form')
    const sms = one('.main__right .tab-sms .tab__form')
    if (!!password === !!sms) return { page: document.querySelector('#passport-app, #app') ? 'loading' : 'unknown', qrStatus: 'loading' }
    const mode = sms ? 'sms' : 'password'
    const qrRoot = one('.login-scan__qrcode')
    let qrStatus: LoginPageSnapshot['qrStatus'] = 'unavailable'
    let qr: LoginPageSnapshot['qr']
    if (qrRoot) {
      const tip = one('.qrcode__tip', qrRoot)
      const tipText = tip?.textContent?.slice(0, 160) || ''
      qrStatus = /失效|过期|expired|refresh/i.test(tipText) ? 'expired' : /扫码成功|手机上确认|scan.*success|confirm.*phone/i.test(tipText) ? 'scanned' : 'loading'
      const image = one('img[alt="Scan me!"]', qrRoot)
      if (image instanceof HTMLImageElement && image.src.length <= 1_500_000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.src)) qr = { src: image.src }
      else {
        const canvas = one('canvas', qrRoot)
        if (canvas) {
          const rect = canvas.getBoundingClientRect()
          if (rect.width >= 80 && rect.width <= 320 && rect.height >= 80 && rect.height <= 320 && rect.x >= 0 && rect.y >= 0) qr = { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
        }
      }
      if (qr && qrStatus === 'loading' && !one('.qrcode__loading', qrRoot)) qrStatus = 'ready'
    }
    return { page: 'form', mode, qrStatus, ...(qr ? { qr } : {}), sms: smsState(sms ? one('.main__right .tab-sms') : undefined), ...(reportedError ? { error: reportedError } : {}) }
  }
  return { visible, one, active, hasChallenge, second, inspect, clearError, smsState }
}

function acceptsFrame(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'passport.bilibili.com' && !url.port && !url.username && !url.password
      && ['/login', '/pc/passport/login', '/pc/passport/riskVerify'].includes(url.pathname)
  } catch {
    return false
  }
}

const inspectScript = `(${pageRuntime.toString()})().inspect()`

function actionScript(action: LoginCardAction): string {
  return `(async () => {
    const action = ${JSON.stringify(action)};
    const runtime = (${pageRuntime.toString()})();
    const invalid = () => ({ ok: false, reason: 'invalid-input' });
    const notReady = () => ({ ok: false, reason: 'not-ready' });
    const unsupported = () => ({ ok: false, reason: 'unsupported' });
    if (!action || typeof action !== 'object' || typeof action.kind !== 'string') return invalid();
    runtime.clearError();
    const active = runtime.active;
    const write = (input, value) => {
      if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly) return false;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (!descriptor?.set || !descriptor.get) return false;
      if (descriptor.get.call(input) === value) return true;
      descriptor.set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const waitFor = async find => {
      await new Promise(resolve => setTimeout(resolve, 0));
      const initial = find();
      if (initial) return initial;
      return new Promise(resolve => {
        let finished = false;
        const finish = value => { if (finished) return; finished = true; observer.disconnect(); clearInterval(interval); clearTimeout(deadline); resolve(value); };
        const check = () => { const value = find(); if (value) finish(value); };
        const observer = new MutationObserver(check);
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'disabled', 'aria-disabled', 'readonly'] });
        const interval = setInterval(check, 16);
        const deadline = setTimeout(() => finish(undefined), 1000);
        check();
      });
    };
    const click = async (find, canSend) => {
      const element = await waitFor(() => { const target = find(); return active(target) && (!canSend || canSend()) ? target : undefined; });
      if (!element) return notReady();
      if (runtime.hasChallenge()) return unsupported();
      element.click();
      return { ok: true };
    };
    if (runtime.hasChallenge()) return unsupported();
    if (action.kind === 'second-send' || action.kind === 'second-submit') {
      const step = runtime.second();
      if (!step) return unsupported();
      if (action.kind === 'second-send') return click(() => runtime.one('.risk-input-after-active', step.root), () => runtime.smsState(step.root).canSend);
      if (typeof action.code !== 'string' || !/^\\d{6}$/.test(action.code)) return invalid();
      if (!write(step.input, action.code)) return notReady();
      return click(() => runtime.one('.risk-bottom-btn', step.root));
    }
    const snapshot = runtime.inspect();
    if (snapshot.page !== 'form') return unsupported();
    if (action.kind === 'mode') {
      if (action.mode !== 'password' && action.mode !== 'sms') return invalid();
      if (snapshot.mode === action.mode) return { ok: true };
      return click(() => runtime.one(action.mode === 'password' ? '.main__right .tabs_wp > div:first-child' : '.main__right .tabs_wp > div:last-child'));
    }
    if (action.kind === 'refresh-qr') {
      if (snapshot.qrStatus !== 'expired') return notReady();
      return click(() => runtime.one('.login-scan__qrcode .qrcode__tip'));
    }
    if (action.kind === 'password') {
      if (action.accepted !== true || typeof action.username !== 'string' || !action.username.length || action.username.length > 32 || /[\\x00-\\x20\\x7f]/.test(action.username) || typeof action.password !== 'string' || !action.password.length || action.password.length > 32 || /[\\x00-\\x1f\\x7f]/.test(action.password)) return invalid();
      if (snapshot.mode !== 'password') return notReady();
      const root = runtime.one('.main__right .login-pwd');
      const username = root && runtime.one('.form__item input[type="text"]', root);
      const password = root && runtime.one('.form__item input[type="password"]', root);
      if (!username || !password) return notReady();
      if (!write(username, action.username) || !write(password, action.password)) return notReady();
      return click(() => runtime.one('.btn_wp .btn_primary', root));
    }
    if (action.kind === 'prepare-sms' || action.kind === 'send-sms' || action.kind === 'sms') {
      if (action.accepted !== true || typeof action.phone !== 'string' || !/^\\d{6,15}$/.test(action.phone) || typeof action.countryCode !== 'string' || !/^\\d{1,4}$/.test(action.countryCode) || (action.kind === 'sms' && (typeof action.code !== 'string' || !/^\\d{6}$/.test(action.code)))) return invalid();
      if (snapshot.mode !== 'sms') return notReady();
      const root = runtime.one('.main__right .tab-sms');
      if (!root) return notReady();
      const inputs = [...root.querySelectorAll('.tab__form .form__item input')].filter(runtime.visible);
      if (inputs.length !== 2 || inputs.some(input => !(input instanceof HTMLInputElement))) return notReady();
      const country = runtime.one('.tab-sms__cid', root);
      if (!country) return notReady();
      const current = country.textContent?.trim().match(/^\\+(\\d{1,4})/);
      if (!current || current[1] !== action.countryCode) {
        if (!active(country)) return notReady();
        country.click();
        const option = await waitFor(() => {
          const options = [...root.querySelectorAll('.area-code-select .option')].filter(runtime.visible).filter(option => option.querySelector('span:last-child')?.textContent?.trim() === '+' + action.countryCode);
          return options.length === 1 && active(options[0]) ? options[0] : undefined;
        });
        if (!option) return unsupported();
        option.click();
        if (!await waitFor(() => country.textContent?.trim().match(/^\\+(\\d{1,4})/)?.[1] === action.countryCode)) return notReady();
      }
      if (!write(inputs[0], action.phone)) return notReady();
      if (action.kind === 'sms' && !write(inputs[1], action.code)) return notReady();
      if (action.kind === 'prepare-sms') return { ok: true };
      return action.kind === 'send-sms'
        ? click(() => runtime.one('.tab__form .form__item > .clickable', root), () => runtime.smsState(root).canSend)
        : click(() => runtime.one('.btn_wp .btn_primary', root));
    }
    return unsupported();
  })()`
}

export const bilibiliLoginAdapter: LoginPageAdapter = {
  entryUrl: 'https://passport.bilibili.com/login', acceptsFrame, inspectScript, actionScript,
}

/** Broker polling must be paused immediately after a security-verification navigation. */
export const bilibiliLoginQrPollPath = '/x/passport-login/web/qrcode/poll'
