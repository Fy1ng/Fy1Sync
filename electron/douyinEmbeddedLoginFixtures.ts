/** Offline-only official transport for the isolated embedded-login E2E profile. */
import { nativeImage, type Session } from 'electron'
import type { EmbeddedLoginRequest } from './embeddedLoginContracts'
import { loginIdentityUrl } from './loginIdentity'

type Scenario = 'form' | 'challenge' | 'password-error' | 'account-verification'
interface FixtureContext {
  session: Session
  authenticated: boolean
  requests: number
  submitted: number
  smsSent: number
}

function sampleImage(): string {
  const size = 96
  const pixels = Buffer.alloc(size * size * 4, 255)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if ((Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0) {
      const offset = (y * size + x) * 4
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 32
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size }).toDataURL()
}

function fixturePage(image: string, scenario: Scenario): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:24px;font:14px sans-serif;background:#fff;color:#222} img{width:160px;height:160px}
    button,input{padding:12px;margin:8px;border:1px solid #aaa} [hidden]{display:none!important}
    .fixture-form{display:flex;gap:32px}.fixture-fields{display:flex;flex-direction:column}
    </style></head><body><div id="login-panel-new"><div id="douyin_login_landing_flat_container" class="fixture-form">
    <div><span id="douyin_login_comp_scan_title">扫码登录</span><div id="douyin_login_comp_scan_code_qrcode"><img alt="二维码" src="${image}"></div><p>离线测试图案</p></div>
    <div class="fixture-fields"><span id="douyin_login_comp_mobile_title" data-mode="sms">验证码登录</span><span data-mode="password">密码登录</span>
    <div id="douyin_login_comp_mobile_code_login_content"><div id="douyin_login_comp_mobile_code">
    <input name="web-login-area-code-input" role="combobox" value="+86"><input id="normal-input" name="normal-input" type="tel" placeholder="请输入手机号">
    <div id="douyin_login_comp_button_input_id"><input id="button-input" name="button-input" type="tel" placeholder="请输入验证码"><span tabindex="0" aria-live="off" class="gKXDWaPG" data-send>获取验证码</span></div>
    <div id="douyin_login_comp_btn_id" role="button" data-submit>登录</div><span aria-label="登录即代表同意服务协议和隐私政策">登录即代表同意</span>
    </div></div><div id="douyin_login_comp_mobile_password_login_content" hidden><div id="douyin_login_comp_account_pwd"><input name="web-login-area-code-input" role="combobox" value="+86">
    <input id="normal-input" name="normal-input" type="tel" placeholder="请输入手机号"><input id="normal-input" name="normal-input" type="password" placeholder="请输入密码">
    <div id="douyin_login_comp_btn_id" role="button" data-submit>登录</div><span aria-label="登录即代表同意服务协议和隐私政策">登录即代表同意</span></div></div><a>用户协议</a><a>隐私政策</a>
    </div></div></div><script>
    const scenario=${JSON.stringify(scenario)};
    const request=path=>fetch('/__fy1sync-fixture/'+path,{method:'POST'}).then(value=>value.json());
    document.querySelectorAll('[data-mode]').forEach(tab=>tab.onclick=()=>{
      const password=tab.dataset.mode==='password';
      document.getElementById('douyin_login_comp_mobile_code_login_content').hidden=password;
      document.getElementById('douyin_login_comp_mobile_password_login_content').hidden=!password;
    });
    document.querySelector('[data-send]').onmousedown=async event=>{await request('send');event.target.textContent='60s后重新发送';};
    document.querySelectorAll('[data-submit]').forEach(button=>button.onclick=async()=>{
      const result=await request('submit');
      if(!result.ok){const error=document.createElement('p');error.id='error_text_id';error.textContent='账号或密码错误';button.parentElement.appendChild(error);}
      if(result.challenge){const root=document.createElement('div');root.id='captcha_container';root.style.cssText='position:fixed;left:80px;top:80px;width:300px;height:220px;background:#ddd;z-index:1000';
        root.innerHTML='<div class="captcha_verify_container" style="width:300px;height:220px;background:#eee;color:#222;display:grid;place-items:center">隔离测试验证码</div>';document.body.appendChild(root);}
      if(result.accountVerification){
        button.classList.add('qOAoUpHW');button.textContent='';
        const script=document.createElement('script');script.crossOrigin='anonymous';
        script.src='https://auth.zijieapi.com/ucenter_web/app/second_verification_web/dist/index.umd.production.js?aid=6383';
        script.onload=()=>window.ucWebSecondVerify(()=>{button.classList.remove('qOAoUpHW');button.textContent='登录';});
        document.head.appendChild(script);
      }
    });
    </script></body></html>`
}

export class DouyinEmbeddedLoginFixtures {
  private enabled = false
  private scenario: Scenario = 'form'
  private current: FixtureContext | null = null

  enable(scenario: Scenario = 'form'): void {
    if (!['form', 'challenge', 'password-error', 'account-verification'].includes(scenario)) throw new Error('Unknown login fixture')
    this.enabled = true
    this.scenario = scenario
  }

  configure = async (request: EmbeddedLoginRequest, target: Session): Promise<void> => {
    const context: FixtureContext = { session: target, authenticated: false, requests: 0, submitted: 0, smsSent: 0 }
    this.current = context
    const image = sampleImage()
    await target.protocol.handle('https', async incoming => {
      context.requests++
      if (!this.enabled || request.platform !== 'douyin') return new Response('Offline login fixture is disabled', { status: 503 })
      const url = new URL(incoming.url)
      const json = (value: unknown) => Response.json(value)
      if (url.hostname === 'auth.zijieapi.com' && url.pathname === '/ucenter_web/app/second_verification_web/dist/index.umd.production.js') {
        return new Response(`window.ucWebSecondVerify=finish=>{
          const root=document.createElement('div');root.id='uc-second-verify';
          root.innerHTML='<div class="second_verify_mask-synthetic" style="position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:10000"><div class="second_verify_panel_new-synthetic" style="position:fixed;left:277px;top:208px;width:726px;height:483px;background:#eee;color:#222;display:grid;place-content:center;gap:24px"><h2>离线身份验证</h2><button id="complete-native-verification">完成离线验证</button></div></div>';
          root.querySelector('button').onclick=()=>{root.remove();finish();};document.body.appendChild(root);
        };`, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'access-control-allow-origin': 'https://live.douyin.com' } })
      }
      if (incoming.url === loginIdentityUrl('douyin')) {
        const cookies = await target.cookies.get({ url: 'https://live.douyin.com/' })
        const authenticated = context.authenticated && cookies.some(cookie => cookie.name === 'sessionid' && cookie.value === 'synthetic-embedded-session')
        return json(authenticated ? { status_code: 0, data: { id_str: '1001', nickname: '测试账号' } }
          : { status_code: 20003, data: { message: 'synthetic-not-logged-in' } })
      }
      if (url.pathname === '/__fy1sync-fixture/submit' && incoming.method === 'POST') {
        context.submitted++
        return json({ ok: this.scenario !== 'password-error', challenge: this.scenario === 'challenge', accountVerification: this.scenario === 'account-verification' })
      }
      if (url.pathname === '/__fy1sync-fixture/send' && incoming.method === 'POST') { context.smsSent++; return json({ ok: true }) }
      return new Response(fixturePage(image, this.scenario), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
  }

  async complete(authenticated: boolean): Promise<void> {
    const current = this.current
    if (!this.enabled || !current) throw new Error('No active offline login')
    current.authenticated = authenticated
    await current.session.cookies.set({ url: 'https://live.douyin.com/', domain: '.douyin.com', path: '/',
      name: authenticated ? 'sessionid' : 'ttwid', value: authenticated ? 'synthetic-embedded-session' : 'synthetic-anonymous',
      secure: true, httpOnly: true, expirationDate: Math.floor(Date.now() / 1000) + 3600 })
  }

  state(active: boolean) {
    return { active, requests: this.current?.requests ?? 0, submitted: this.current?.submitted ?? 0,
      smsSent: this.current?.smsSent ?? 0, scenario: this.scenario }
  }
}
