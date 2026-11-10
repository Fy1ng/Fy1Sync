/** Static local document; account inputs never enter the main application renderer. */
export function loginCardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>账号登录</title><link rel="stylesheet" href="./card.css"><script src="./card.js" defer></script></head>
<body><main id="card" aria-label="账号登录" data-stage="loading">
  <section id="basic" class="login-columns">
    <section class="qr-column" data-login-column="qr" aria-label="扫码登录">
      <h2>扫码登录</h2><div class="qr-box"><img id="qr-image" alt="官方登录二维码" hidden><div id="qr-wait" class="qr-wait"><span id="qr-spinner" class="spinner" aria-hidden="true"></span><p id="qr-message" role="status">正在加载二维码</p></div></div>
      <button id="refresh-qr" type="button" class="quiet">刷新二维码</button><p id="qr-instruction" class="muted">使用平台客户端扫码登录</p>
    </section>
    <section class="form-column" data-login-column="form" aria-label="账号登录方式">
      <div class="mode-tabs" role="tablist" aria-label="登录方式"><button id="mode-sms" type="button" role="tab" aria-selected="false" aria-controls="sms-fields">短信登录</button><button id="mode-password" type="button" role="tab" aria-selected="true" aria-controls="password-fields">密码登录</button></div>
      <form id="login-form" novalidate autocomplete="off">
        <div id="password-fields" role="tabpanel" aria-label="密码登录"><label for="username">账号</label><input id="username" name="username" type="text" autocomplete="off" placeholder="手机号 / 用户名 / 邮箱" maxlength="160"><label for="password">密码</label><div class="password-field"><input id="password" name="password" type="password" autocomplete="off" placeholder="请输入密码" maxlength="256" data-secret><button id="toggle-password" type="button" aria-label="显示密码" aria-pressed="false" aria-controls="password">显示</button></div></div>
        <div id="sms-fields" role="tabpanel" aria-label="短信登录" hidden><div class="phone-fields"><div><label for="country-code">国家区号</label><input id="country-code" name="countryCode" type="text" value="+86" inputmode="tel" autocomplete="off" maxlength="6" aria-label="国家区号"></div><div><label for="phone">手机号</label><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="off" placeholder="请输入手机号" maxlength="24"></div></div><label for="sms-code">短信验证码</label><div class="code-field"><input id="sms-code" name="smsCode" type="text" inputmode="numeric" autocomplete="off" placeholder="请输入验证码" maxlength="16" data-secret><button id="send-sms" type="button" class="code-send">发送验证码</button></div></div>
        <label class="agreement"><input id="accepted" type="checkbox"><span>我已阅读并同意<span id="platform-name">平台</span>的服务协议和隐私政策</span></label>
        <button id="submit-login" class="primary" type="submit">登录</button>
      </form>
      <details class="protocol"><summary>平台协议说明</summary><p id="protocol-text">可在官方验证页面查看平台的服务协议和隐私政策.</p></details>
    </section>
  </section>
  <section id="verification" class="verification" aria-label="安全验证" hidden><h2>安全验证</h2><p id="verification-description">请完成账号安全验证</p><p id="masked-target" class="masked"></p><form id="verification-form" novalidate autocomplete="off"><label id="verification-label" for="verification-code">验证码</label><div class="code-field"><input id="verification-code" type="text" inputmode="numeric" autocomplete="off" placeholder="请输入验证码" maxlength="16" data-secret><button id="second-send" type="button" class="code-send">发送验证码</button></div><button id="second-submit" class="primary" type="submit">继续</button></form><button id="verification-back" type="button" class="quiet">返回登录</button></section>
  <section id="official-state" class="official-state" hidden><span class="spinner" aria-hidden="true"></span><p>请在官方页面完成验证</p><button id="official-back" type="button" class="quiet">返回登录</button></section>
  <p id="message" class="message" role="status" aria-live="polite"></p>
  <div class="actions"><button id="official" type="button" class="quiet">使用官方验证页面</button><button id="cancel" type="button" class="quiet">取消登录</button></div>
</main></body></html>`
}

export const LOGIN_CARD_CSS = `
:root { color-scheme: dark; font-family: "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif; color: #f3f0ea; background: #18181b; font-size: 13px; line-height: 1.5; }
* { box-sizing: border-box; } body { margin: 0; min-width: 0; } [hidden] { display: none !important; } h2, p { margin: 0; } h2 { font-size: 17px; font-weight: 500; } button, input { font: inherit; } button { cursor: pointer; } button:disabled { cursor: default; opacity: .48; } button, input { color: inherit; } button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid #f3f0ea; outline-offset: 3px; }
#card { padding: 26px 28px 18px; min-height: 100vh; display: flex; flex-direction: column; }
.login-columns { display: grid; grid-template-columns: minmax(0, 260px) minmax(0, 340px); gap: 34px; justify-content: center; flex: 1; }
.qr-column { display: flex; flex-direction: column; align-items: center; border-right: 1px solid #343437; padding-right: 26px; gap: 16px; padding-top: 5px; }
.qr-box { width: 184px; height: 184px; margin-top: 4px; display: grid; place-items: center; position: relative; border: 1px solid #343437; border-radius: 10px; overflow: hidden; }
.qr-box img { width: 100%; height: 100%; object-fit: contain; background: white; padding: 8px; } .qr-wait { padding: 16px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 16px; color: #9a9893; }
.muted { font-size: 12px; color: #9a9893; text-align: center; } .spinner { display: block; width: 26px; height: 26px; border: 2px solid #343437; border-top-color: #f3f0ea; border-radius: 50%; animation: spin 1s linear infinite; }
.form-column { min-width: 0; } .mode-tabs { display: flex; gap: 24px; margin-bottom: 18px; border-bottom: 1px solid #343437; }
.mode-tabs button { background: none; border: 0; padding: 0 0 10px; color: #9a9893; font-size: 16px; border-bottom: 2px solid transparent; } .mode-tabs button[aria-selected="true"] { color: #f3f0ea; border-bottom-color: #f3f0ea; }
label { display: block; margin-bottom: 6px; color: #c7c5c0; font-size: 12px; } input:not([type="checkbox"]) { width: 100%; height: 42px; padding: 9px 12px; background: #222225; border: 1px solid #454548; border-radius: 7px; outline: none; } input::placeholder { color: #777570; } #password-fields > input:first-of-type, .phone-fields { margin-bottom: 14px; } .phone-fields { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 10px; } .code-field { display: flex; border: 1px solid #454548; border-radius: 7px; background: #222225; overflow: hidden; } .code-field input:not([type="checkbox"]) { border: 0; min-width: 0; border-radius: 0; background: none; } .code-field input:focus-visible { outline-offset: -3px; } .code-send { flex: none; padding: 0 12px; font-size: 12px; background: none; border: 0; border-left: 1px solid #454548; }
.agreement { display: flex; align-items: flex-start; gap: 8px; font-size: 11px; margin: 15px 0; color: #9a9893; } .agreement input { accent-color: #f3f0ea; margin: 2px 0 0; width: 14px; height: 14px; flex: none; } .primary { width: 100%; border: 0; background: #f3f0ea; color: #18181b; border-radius: 7px; padding: 10px 16px; font-weight: 500; } .quiet { border: 0; background: none; color: #9a9893; padding: 4px 0; font-size: 12px; } .quiet:hover { color: #f3f0ea; }
.protocol { color: #777570; font-size: 11px; margin-top: 12px; } .protocol summary { cursor: pointer; } .protocol p { margin-top: 5px; } .message { min-height: 22px; margin-top: 12px; color: #9a9893; font-size: 12px; text-align: center; overflow-wrap: anywhere; } .message[data-error="true"] { color: #ffaaa3; } .actions { display: flex; justify-content: center; gap: 24px; margin-top: 8px; }
.password-field { display: flex; border: 1px solid #454548; border-radius: 7px; overflow: hidden; background: #222225; } .password-field input:not([type="checkbox"]) { border: 0; background: none; border-radius: 0; min-width: 0; } .password-field input:focus-visible { outline-offset: -3px; } .password-field button { flex: none; background: none; border: 0; padding: 0 12px; color: #c7c5c0; font-size: 12px; } .password-field button:focus-visible { outline-offset: -3px; }
.verification { width: min(100%, 340px); margin: auto; flex: 1; padding-top: 24px; text-align: center; } .verification h2 { font-size: 21px; margin-bottom: 12px; } .verification > p { color: #9a9893; } .verification .masked { color: #f3f0ea; font-size: 16px; margin: 8px 0 24px; } .verification form { text-align: left; } .verification .primary { margin: 20px 0 12px; } .official-state { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 18px; color: #9a9893; }
@keyframes spin { to { transform: rotate(360deg); } } @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
@media (max-width: 630px) { #card { padding: 20px 16px 14px; } .login-columns { gap: 18px; grid-template-columns: minmax(170px, 1fr) minmax(220px, 1.4fr); } .qr-column { padding-right: 18px; } .qr-box { width: 150px; height: 150px; } .mode-tabs { gap: 14px; } .mode-tabs button { font-size: 14px; } }
@media (max-width: 430px) { .login-columns { grid-template-columns: 1fr; } .qr-column { border: 0; border-bottom: 1px solid #343437; padding: 0 0 18px; } .form-column { margin-top: 6px; } }
@media (max-height: 440px) and (min-width: 431px) { #card { padding-top: 16px; } .qr-box { width: 160px; height: 160px; } .mode-tabs { margin-bottom: 12px; } .agreement { margin: 12px 0; } .protocol { margin-top: 8px; } }
`

export const LOGIN_CARD_SCRIPT = String.raw`(() => {
  'use strict';
  const bridge = window.loginCard;
  const byId = id => document.getElementById(id);
  const card = byId('card');
  const message = byId('message');
  const names = { douyin: '抖音' };
  const stages = ['loading', 'form', 'submitting', 'verification', 'official', 'checking', 'failed'];
  let state = null;
  let pending = false;
  let disposed = false;
  let revision = 0;
  let operation = 0;
  let release = () => {};
  let localError = '';
  let dismissedMessage = '';
  let contactTimer;
  let preparedContact = '';
  const secretIds = ['password', 'sms-code', 'verification-code'];
  const hidePassword = () => { byId('password').type = 'password'; byId('toggle-password').textContent = '显示'; byId('toggle-password').setAttribute('aria-label', '显示密码'); byId('toggle-password').setAttribute('aria-pressed', 'false'); };
  const clearSecrets = () => { for (const id of secretIds) byId(id).value = ''; hidePassword(); };
  const clearInputs = () => { clearSecrets(); byId('username').value = ''; byId('phone').value = ''; byId('accepted').checked = false; preparedContact = ''; };
  const syncPhone = mode => {
    const source = byId(mode === 'sms' ? 'phone' : 'username');
    const target = byId(mode === 'sms' ? 'username' : 'phone');
    const phone = source.value.trim();
    // Share phone input only within this card; usernames and emails are not SMS numbers.
    if (/^\d{0,20}$/.test(phone) && (phone || /^\d{0,20}$/.test(target.value.trim()))) target.value = phone;
  };
  const say = (text, error = false) => { message.textContent = typeof text === 'string' ? text.slice(0, 500) : ''; message.dataset.error = String(error); message.setAttribute('role', error ? 'alert' : 'status'); message.setAttribute('aria-live', error ? 'assertive' : 'polite'); };
  const busy = () => pending || !state || state.busy || ['loading', 'submitting', 'checking', 'official'].includes(state.stage);
  const canSendSms = () => !!state && state.sms && state.sms.canSend === true && !busy();
  const cooldown = () => {
    const sms = state && state.sms;
    const remaining = sms && Number.isInteger(sms.cooldownSeconds) && sms.cooldownSeconds > 0 ? sms.cooldownSeconds : null;
    for (const id of ['send-sms', 'second-send']) {
      byId(id).textContent = remaining !== null ? remaining + ' 秒后重发' : sms && sms.canSend ? '发送验证码' : '等待平台验证';
      byId(id).disabled = !canSendSms();
    }
  };
  const safeImage = image => typeof image === 'string' && image.length < 2097152
    && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)
    && (image.startsWith('data:image/png;base64,iVBORw0KGgo') || image.startsWith('data:image/jpeg;base64,/9j/') || image.startsWith('data:image/webp;base64,UklGR'));
  const render = () => {
    if (!state || disposed) return;
    card.dataset.stage = state.stage;
    card.dataset.platform = state.platform;
    card.setAttribute('aria-busy', String(busy()));
    byId('basic').hidden = state.stage === 'verification' || state.stage === 'official';
    byId('verification').hidden = state.stage !== 'verification';
    byId('official-state').hidden = state.stage !== 'official';
    byId('password-fields').hidden = state.mode !== 'password';
    byId('sms-fields').hidden = state.mode !== 'sms';
    byId('mode-password').setAttribute('aria-selected', String(state.mode === 'password'));
    byId('mode-sms').setAttribute('aria-selected', String(state.mode === 'sms'));
    byId('mode-password').tabIndex = state.mode === 'password' ? 0 : -1;
    byId('mode-sms').tabIndex = state.mode === 'sms' ? 0 : -1;
    byId('platform-name').textContent = names[state.platform];
    byId('qr-instruction').textContent = '使用' + names[state.platform] + '客户端扫码登录';
    byId('protocol-text').textContent = '请遵守' + names[state.platform] + '的服务协议和隐私政策. 可在官方验证页面查看完整协议.';
    const qr = state.qr || { status: 'unavailable' };
    const image = byId('qr-image');
    const showQr = qr.status === 'ready' && safeImage(qr.image);
    image.hidden = !showQr;
    if (showQr) { if (image.getAttribute('src') !== qr.image) image.src = qr.image; } else image.removeAttribute('src');
    byId('qr-wait').hidden = showQr;
    byId('qr-spinner').hidden = qr.status !== 'loading';
    byId('qr-message').textContent = ({ loading: '正在加载二维码', ready: '二维码暂时不可用', scanned: '已扫码, 请在手机上确认', expired: '二维码已过期', unavailable: '二维码暂时不可用', paused: '扫码登录已暂停' })[qr.status] || '二维码暂时不可用';
    byId('refresh-qr').disabled = busy();
    const verification = state.verification;
    byId('verification-description').textContent = verification && verification.kind === 'email' ? '请输入发送到绑定邮箱的验证码' : '请输入发送到绑定手机的验证码';
    byId('masked-target').textContent = verification && typeof verification.maskedTarget === 'string' ? verification.maskedTarget.slice(0, 120) : '绑定的验证方式';
    byId('verification-label').textContent = verification && verification.kind === 'email' ? '邮箱验证码' : '短信验证码';
    byId('submit-login').textContent = state.stage === 'checking' ? '正在确认登录' : state.stage === 'submitting' || pending ? '正在登录' : '登录';
    for (const id of ['username', 'password', 'toggle-password', 'phone', 'country-code', 'sms-code', 'verification-code', 'accepted', 'mode-password', 'mode-sms', 'submit-login', 'second-submit']) byId(id).disabled = busy();
    byId('official').disabled = pending;
    for (const id of ['verification-back', 'official-back']) byId(id).disabled = pending || !!state.busy;
    byId('cancel').disabled = false;
    byId('official').hidden = state.stage === 'official';
    cooldown();
    const platformMessage = state.message === dismissedMessage ? '' : state.message;
    const platformError = !!platformMessage && !state.busy && ['form', 'verification', 'failed'].includes(state.stage);
    say(localError || platformMessage || (state.stage === 'loading' ? '正在准备登录' : state.stage === 'checking' ? '正在确认登录状态' : ''), Boolean(localError) || platformError);
  };
  const take = next => {
    if (disposed) return;
    if (!next) { state = null; clearInputs(); byId('qr-image').removeAttribute('src'); card.hidden = true; return; }
    if (!Object.hasOwn(names, next.platform) || !stages.includes(next.stage) || !['sms', 'password'].includes(next.mode)) return;
    const prepareAgain = next.stage === 'form' && next.mode === 'sms' && (!state || state.stage === 'loading' || state.mode !== 'sms');
    if (next.stage === 'loading' || state && state.mode !== next.mode) preparedContact = '';
    if (state && state.platform !== next.platform) clearInputs();
    else if (state && state.mode !== next.mode) syncPhone(state.mode);
    if (!state || state.stage !== next.stage || state.mode !== next.mode || state.platform !== next.platform) clearSecrets();
    if (state && state.message !== next.message) dismissedMessage = '';
    state = next;
    card.hidden = false;
    render();
    if (prepareAgain) prepareContact();
  };
  const dispatch = async action => {
    if (!bridge || disposed || (action.kind !== 'cancel' && (pending || (!['back', 'official'].includes(action.kind) && busy())))) { clearSecrets(); return; }
    if (action.kind === 'send-sms' || action.kind === 'sms') {
      clearTimeout(contactTimer);
      preparedContact = action.countryCode + ':' + action.phone;
    }
    const at = ++operation;
    const startedStage = state ? state.stage : null;
    pending = true;
    localError = '';
    dismissedMessage = state ? state.message || '' : '';
    clearSecrets();
    render();
    try {
      let request;
      try { request = bridge.act(action); }
      finally {
        // Electron copies action data synchronously at invoke; retain no local secret copy.
        if ('password' in action) action.password = '';
        if ('code' in action) action.code = '';
      }
      const result = await request;
      if (!disposed && at === operation && state && (state.stage === startedStage || state.stage === 'failed') && !result.ok) localError = result.message || '操作未完成, 请重试.';
    } catch { if (!disposed && at === operation && state && (state.stage === startedStage || state.stage === 'failed')) localError = '登录操作暂时失败, 请重试.'; }
    finally { clearSecrets(); if (at === operation) { pending = false; if (!disposed) render(); } }
  };
  const invalid = text => { localError = text; say(text, true); };
  const accepted = () => {
    if (byId('accepted').checked) return true;
    invalid('请先阅读并同意平台服务协议和隐私政策.');
    return false;
  };
  const phoneFields = () => ({ phone: byId('phone').value.trim(), countryCode: byId('country-code').value.trim() });
  const validPhone = fields => /^\+?[1-9]\d{0,3}$/.test(fields.countryCode) && /^\d{5,20}$/.test(fields.phone);
  const prepareContact = () => {
    clearTimeout(contactTimer);
    contactTimer = setTimeout(() => {
      if (disposed || busy() || state.stage !== 'form' || state.mode !== 'sms' || !byId('accepted').checked) return;
      const fields = phoneFields();
      if (!validPhone(fields)) return;
      const signature = fields.countryCode + ':' + fields.phone;
      if (signature === preparedContact) return;
      preparedContact = signature;
      void dispatch({ kind: 'prepare-sms', ...fields, accepted: true });
    }, 200);
  };
  document.addEventListener('input', event => {
    if (!(event.target instanceof HTMLInputElement)) return;
    localError = ''; dismissedMessage = state ? state.message || '' : ''; render();
    if (['phone', 'country-code', 'accepted'].includes(event.target.id)) prepareContact();
  });
  byId('toggle-password').addEventListener('click', () => {
    const shown = byId('password').type === 'password';
    byId('password').type = shown ? 'text' : 'password';
    byId('toggle-password').textContent = shown ? '隐藏' : '显示';
    byId('toggle-password').setAttribute('aria-label', shown ? '隐藏密码' : '显示密码');
    byId('toggle-password').setAttribute('aria-pressed', String(shown));
  });
  for (const mode of ['sms', 'password']) byId('mode-' + mode).addEventListener('click', () => { clearSecrets(); void dispatch({ kind: 'mode', mode }); });
  document.querySelector('.mode-tabs').addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    if (busy()) return;
    const next = state.mode === 'sms' ? 'password' : 'sms';
    byId('mode-' + next).focus(); byId('mode-' + next).click();
  });
  byId('login-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy() || !accepted()) return;
    if (state.mode === 'password') {
      const payload = { kind: 'password', username: byId('username').value.trim(), password: byId('password').value, accepted: true };
      if (!payload.username || !payload.password) { payload.password = ''; invalid('请输入账号和密码.'); return; }
      void dispatch(payload);
    } else {
      const payload = { kind: 'sms', ...phoneFields(), code: byId('sms-code').value.trim(), accepted: true };
      if (!validPhone(payload) || !payload.code) { payload.code = ''; invalid('请填写正确的国家区号, 手机号和验证码.'); return; }
      void dispatch(payload);
    }
  });
  byId('send-sms').addEventListener('click', () => {
    if (!canSendSms() || !accepted()) return;
    const fields = phoneFields();
    if (!validPhone(fields)) { invalid('请填写正确的国家区号和手机号.'); return; }
    void dispatch({ kind: 'send-sms', ...fields, accepted: true });
  });
  byId('verification-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy()) return;
    const payload = { kind: 'second-submit', code: byId('verification-code').value.trim() };
    if (!payload.code) { invalid('请输入验证码.'); return; }
    void dispatch(payload);
  });
  byId('second-send').addEventListener('click', () => { if (canSendSms()) void dispatch({ kind: 'second-send' }); });
  byId('refresh-qr').addEventListener('click', () => { void dispatch({ kind: 'refresh-qr' }); });
  byId('official').addEventListener('click', () => { clearSecrets(); void dispatch({ kind: 'official' }); });
  for (const id of ['verification-back', 'official-back']) byId(id).addEventListener('click', () => { clearSecrets(); void dispatch({ kind: 'back' }); });
  const cancel = () => { clearInputs(); void dispatch({ kind: 'cancel' }); };
  byId('cancel').addEventListener('click', cancel);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } });
  byId('qr-image').addEventListener('error', () => { byId('qr-image').removeAttribute('src'); byId('qr-image').hidden = true; byId('qr-wait').hidden = false; byId('qr-message').textContent = '二维码暂时不可用'; });
  const dispose = () => { if (disposed) return; disposed = true; clearTimeout(contactTimer); clearInputs(); byId('qr-image').removeAttribute('src'); release(); state = null; };
  window.addEventListener('pagehide', dispose);
  window.addEventListener('beforeunload', dispose);
  if (!bridge) { clearInputs(); localError = '登录接口不可用, 请重新打开登录.'; say(localError, true); for (const button of document.querySelectorAll('button')) button.disabled = true; return; }
  release = bridge.subscribe(next => { revision += 1; take(next); });
  const queriedAt = revision;
  Promise.resolve(bridge.state()).then(next => { if (revision === queriedAt && !disposed) take(next); }).catch(() => { if (!disposed) { localError = '登录状态暂时不可用, 请重新打开登录.'; say(localError, true); } });
})();`
