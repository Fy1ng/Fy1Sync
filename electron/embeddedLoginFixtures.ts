import { nativeImage, type Session } from 'electron'
import type { EmbeddedLoginPlatform, EmbeddedLoginRequest } from './embeddedLoginContracts'
import { loginIdentityUrl } from './loginIdentity'

type Scenario = 'second-factor' | 'second-factor-stalled' | 'second-factor-render' | 'second-factor-v4' | 'challenge' | 'unknown' | 'sms-captcha' | 'password-error' | 'captcha-phases'
  | 'huya-captcha-child' | 'huya-captcha-parent'
type FixtureContext = {
  platform: EmbeddedLoginPlatform; session: Session; authenticated: boolean; requests: number
  submitted: number; smsSent: number; verified: number; qrPolls: number; phase: 'form' | 'verification' | 'challenge' | 'unknown' | 'complete'
  pendingCaptcha: boolean; phoneChanges: number; navigationCount: number; mediaRequests: number; cooldown: number
}

function sampleImage(): string {
  const pixels = Buffer.alloc(96 * 96 * 4, 255)
  for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) if ((Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0) {
    const offset = (y * 96 + x) * 4
    pixels[offset] = 200; pixels[offset + 1] = 200; pixels[offset + 2] = 200
  }
  return nativeImage.createFromBitmap(pixels, { width: 96, height: 96 }).toDataURL()
}

const shell = (body: string, script = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:14px "Microsoft YaHei",sans-serif;background:#fff;color:#242428;margin:24px}h3{font-weight:500;margin:0 0 24px}
p{margin:22px 0;color:#64646a}input{box-sizing:border-box;width:220px;padding:12px;border:1px solid #ccc;border-radius:6px}
button,.btn_primary,.clickable,.risk-bottom-btn,.risk-input-after-active{display:inline-block;cursor:pointer;padding:10px 16px;background:#ddd;border:0;border-radius:6px}
.column,.main__left,.main__right,.login-left-wrap,.login-right-wrap{display:inline-block;vertical-align:top;min-width:240px;margin:12px}
img{display:block;width:160px;height:160px}.tabs_wp,.head-nav{display:flex;gap:18px;margin:15px 0}.tabs_wp>div,.head-nav>li{display:block;cursor:pointer;padding:8px}
.tab_active,.on{font-weight:bold}.form__item{margin:14px 0}.risk-check-phone_wp,.risk-check-email_wp{margin:40px;width:340px}
.risk-static-text-value{display:block;margin:16px 0}.risk-input-after-active{margin-left:6px}[hidden]{display:none!important}
</style></head><body>${body}<script>${script}</script></body></html>`

function basicPage(platform: EmbeddedLoginPlatform, child: boolean, scenario: Scenario): string {
  const image = sampleImage()
  if (platform === 'bilibili') return shell(`
    <div class="login__main"><div class="main__left"><div class="login-scan__qrcode"><img alt="Scan me!" src="${image}"></div><p>离线测试图案</p></div>
    <div class="main__right"><div class="tabs_wp"><div class="tab_active" data-mode="password">密码登录</div><div></div><div data-mode="sms">短信登录</div></div>
    <div class="login-pwd"><div class="tab__form"><div class="form__item"><input type="text"></div><div class="form__item"><input type="password"></div></div><div class="btn_wp"><div class="btn_primary" data-submit="password">登录</div></div></div>
    <div class="tab-sms" hidden><div class="tab__form"><div class="form__item"><div class="tab-sms__cid">+86</div><input type="text"></div><div class="form__item"><input type="text"><span class="clickable" data-send>发送验证码</span></div></div><div class="btn_wp"><div class="btn_primary" data-submit="sms">登录</div></div></div>
    </div></div>`, `
    const request=(name)=>fetch('/__fy1sync-fixture/'+name,{method:'POST'}).then(r=>r.json());
    document.querySelectorAll('[data-mode]').forEach(tab=>tab.onclick=()=>{const sms=tab.dataset.mode==='sms';document.querySelector('.login-pwd').hidden=sms;document.querySelector('.tab-sms').hidden=!sms;document.querySelectorAll('[data-mode]').forEach(other=>other.classList.toggle('tab_active',other===tab));});
    document.querySelectorAll('[data-submit]').forEach(button=>button.onclick=async()=>{const result=await request(button.dataset.submit==='password'?'password':'verify');if(result.error){const toast=document.createElement('div');toast.className='toast__content';toast.textContent='账号或密码错误';document.body.appendChild(toast);setTimeout(()=>toast.remove(),500);}else if(result.captcha)globalThis.__fixtureSetChallengePhase('loading');else location.href=result.next;});
    document.querySelector('[data-send]').onclick=async(event)=>{await request('send');event.target.textContent='(60)';};
    setInterval(()=>fetch('/x/passport-login/web/qrcode/poll').catch(()=>{}),300);
    ${scenario === 'captcha-phases' ? bilibiliChallengeScript() : ''}
  `)
  if (platform === 'douyu') return shell(`
    <div class="js-scancode-box column"><div class="js-qrcode-con"><img src="${image}"></div><p>离线测试图案</p></div><div class="js-login-normal column">
    <div class="login-form login-by-password"><div class="tabs_wp"><span class="js-l-stype" data-subtype="login-by-password">密码</span><span class="js-l-stype" data-subtype="login-by-sms">短信</span></div>
    <div data-mode-fields="password"><input name="nicknameOrPhone" type="text"><input name="password" type="password"></div><div data-mode-fields="sms" hidden><input class="js-selectCountry-box-code" name="areaCode" value="+86"><div class="js-select-country-list"><li><span class="selectCountry-value">+86</span></li></div><input name="phoneNum"><input name="phoneCaptcha"><input class="phone-send js-sendvoice" type="button" value="发送验证码"></div><input type="submit" class="loginbox-sbt btn-sub" value="登录"></div></div>${fixtureMedia(scenario)}`, `
    document.querySelectorAll('.js-l-stype').forEach(tab=>tab.onclick=()=>{const sms=tab.dataset.subtype==='login-by-sms';document.querySelector('.login-form').className='login-form '+tab.dataset.subtype;document.querySelector('[data-mode-fields=password]').hidden=sms;document.querySelector('[data-mode-fields=sms]').hidden=!sms;});
    ${scenario === 'sms-captcha' ? smsCaptchaScript('douyu') : "document.querySelector('.loginbox-sbt').onclick=()=>fetch('/__fy1sync-fixture/password',{method:'POST'}).then(r=>r.json()).then(r=>location.href=r.next);"}
  `)
  if (child) return shell(`
    <div class="login-left-wrap"><img id="qr-image" src="https://udblgn.huya.com/qrLgn/getQrImg?fixture=1"><p>离线测试图案</p></div><div class="login-right-wrap"><ul id="login-head-nav" class="head-nav"><li udb-eid="40" class="on">密码登录</li><li udb-eid="12">短信登录</li></ul>
    <div id="account-login-form"><input id="username"><input id="password" type="password"><button id="login-btn">登录</button></div>
    <div id="phone-login-form" hidden><span class="sel-areas" areascode="86">+86</span><div class="sel-areas-list"><li areascode="86"><span class="areasNumber" areascode="86">中国 +86</span></li></div><input class="udb-input-tel"><input class="udb-input-code"><button class="get-sms-code" enabled="1">发送验证码</button><button id="phone-login-btn">登录</button></div></div>${fixtureMedia(scenario)}`, `
    document.querySelectorAll('#login-head-nav li').forEach(tab=>tab.onclick=()=>{const sms=tab.getAttribute('udb-eid')==='12';document.querySelector('#account-login-form').hidden=sms;document.querySelector('#phone-login-form').hidden=!sms;document.querySelectorAll('#login-head-nav li').forEach(other=>other.classList.toggle('on',other===tab));});
    ${scenario === 'sms-captcha' || scenario.startsWith('huya-captcha-') ? huyaSmsCaptchaScript(scenario === 'huya-captcha-parent') : "document.querySelectorAll('#login-btn,#phone-login-btn').forEach(button=>button.onclick=()=>fetch('/__fy1sync-fixture/password',{method:'POST'}).then(r=>r.json()).then(r=>location.href=r.next));"}
  `)
  return shell('<div id="HUYA-UDBSdkLgn"><iframe id="UDBSdkLgn_iframe" name="fy1sync-fixture-login" src="https://aq.huya.com/p/udb_login.html" style="border:2px solid #888;width:680px;height:460px"></iframe></div>',
    scenario === 'huya-captcha-parent' ? huyaCaptchaOwnerScript(true) : '')
}

function fixtureMedia(scenario: Scenario): string {
  return scenario === 'sms-captcha' ? '<video autoplay loop src="https://www.huya.com/__fixture-media.mp4" style="width:1px;height:1px"></video><audio autoplay src="https://www.huya.com/__fixture-media.mp3"></audio>' : ''
}

function smsCaptchaScript(platform: 'douyu' | 'huya'): string {
  const phone = platform === 'douyu' ? 'input[name="phoneNum"]' : '.udb-input-tel'
  const country = platform === 'douyu' ? 'input[name="areaCode"]' : '.sel-areas'
  const send = platform === 'douyu' ? '.phone-send' : '.get-sms-code'
  const submit = platform === 'douyu' ? '.loginbox-sbt' : '#phone-login-btn'
  return `
    const phone=document.querySelector(${JSON.stringify(phone)}),country=document.querySelector(${JSON.stringify(country)}),send=document.querySelector(${JSON.stringify(send)}),submit=document.querySelector(${JSON.stringify(submit)});
    let verified=false,waiting=false;
    const request=(name)=>fetch('/__fy1sync-fixture/'+name,{method:'POST'}).then(r=>r.json());
    const update=(seconds)=>{send.disabled=waiting||seconds>0||!phone.value;send.setAttribute('enabled',send.disabled?'0':'1');const label=waiting?'请完成验证':seconds>0?'('+seconds+'s)':${JSON.stringify(platform === 'huya' ? '获取验证码' : '发送验证码')};if(send instanceof HTMLInputElement)send.value=label;else send.textContent=label;};
    phone.addEventListener('input',()=>{verified=false;void request('phone-change');update(0);});
    country.addEventListener('input',()=>{verified=false;});
    send.onclick=async()=>{waiting=true;verified=false;update(0);await request('captcha-start');const panel=document.createElement('section');panel.className=${JSON.stringify(platform === 'douyu' ? 'geetest_panel_box' : 'geetest4_box')};panel.style.cssText='position:fixed;left:100px;top:65px;width:340px;height:280px;z-index:999999;background:#f5f5f5;border:2px solid #555;box-sizing:border-box;padding:24px';panel.innerHTML='<h3>模拟人机验证</h3><p>仅用于离线验证</p><button data-fixture-captcha>完成验证</button>';document.body.appendChild(panel);panel.querySelector('button').onclick=async()=>{const result=await request('captcha-complete');verified=true;waiting=false;panel.remove();update(result.cooldown);};};
    submit.onclick=async()=>{if(!verified){let error=document.createElement('p');error.className=${JSON.stringify(platform === 'douyu' ? 'login-sbt-resMsg' : 'input-error-tips')};error.textContent='请先完成短信验证';submit.parentElement.appendChild(error);return;}const result=await request('verify');location.href=result.next;};
    globalThis.__fixtureSetCooldown=seconds=>update(seconds);
    update(0);
    for(const media of document.querySelectorAll('video,audio'))media.play().catch(()=>{});
  `
}

/** The observed Tencent owner wraps a separate, card-sized cross-origin document. */
function huyaCaptchaOwnerScript(parent: boolean): string {
  return `
    document.body.style.background='#cc1234';
    const ownerIsParent=${parent};
    const account=()=>ownerIsParent?document.querySelector('#UDBSdkLgn_iframe').contentWindow:window;
    const notifyAccount=kind=>account().postMessage({fixtureCaptcha:kind},'https://aq.huya.com');
    globalThis.__fixtureShowCaptcha=()=>{
      if(document.querySelector('#tcaptcha_transform'))return;
      const loading=document.createElement('div');loading.id='t_verify';loading.className='t-verify';loading.style.cssText='position:fixed;left:100px;top:65px;width:340px;height:280px';loading.textContent='正在加载模拟验证';document.body.appendChild(loading);
      const owner=document.createElement('div');owner.id='tcaptcha_transform';owner.className='tcaptcha-transform';owner.style.cssText='position:fixed;left:100px;top:65px;width:340px;height:280px;opacity:0;z-index:999999';
      const frame=document.createElement('iframe');frame.id='tcaptcha_iframe';frame.name='fy1sync-fixture-captcha';frame.className='tcaptcha-iframe';frame.style.cssText='border:0;width:340px;height:280px';frame.src='https://t.captcha.qq.com/cap_union_new_show?fixture=1';owner.appendChild(frame);document.body.appendChild(owner);
    };
    window.addEventListener('message',event=>{
      if(ownerIsParent&&event.origin==='https://aq.huya.com'&&event.source===account()&&event.data?.fixtureCaptcha==='show'){globalThis.__fixtureShowCaptcha();return;}
      const frame=document.querySelector('#tcaptcha_iframe');
      if(event.origin!=='https://t.captcha.qq.com'||!frame||event.source!==frame.contentWindow)return;
      if(event.data?.fixtureCaptcha==='ready'){
        document.querySelector('#t_verify')?.remove();document.querySelector('#tcaptcha_transform').style.opacity='1';notifyAccount('ready');
      }else if(event.data?.fixtureCaptcha==='complete'){
        document.querySelector('#tcaptcha_transform').remove();document.querySelector('#t_verify')?.remove();notifyAccount('complete');
      }
    });
  `
}

function huyaSmsCaptchaScript(parent: boolean): string {
  return `
    ${parent ? '' : huyaCaptchaOwnerScript(false)}
    const activation=globalThis.__fixtureActivation={requests:0,frames:0,ready:0,clicks:0};
    const phone=document.querySelector('.udb-input-tel'),send=document.querySelector('.get-sms-code'),submit=document.querySelector('#phone-login-btn');
    let verified=false,waiting=false;
    const request=name=>fetch('/__fy1sync-fixture/'+name,{method:'POST'}).then(response=>response.json());
    const update=seconds=>{send.disabled=waiting||seconds>0||!phone.value;send.setAttribute('enabled',send.disabled?'0':'1');send.textContent=waiting?'请完成验证':seconds>0?'('+seconds+'s)':'获取验证码';};
    phone.addEventListener('input',()=>{verified=false;void request('phone-change');update(0);});
    send.onclick=async()=>{
      activation.requests++;waiting=true;verified=false;update(0);await request('captcha-start');
      ${parent ? "window.parent.postMessage({fixtureCaptcha:'show'},'https://www.huya.com');" : 'globalThis.__fixtureShowCaptcha();'}
    };
    window.addEventListener('message',async event=>{
      if(event.origin!==${JSON.stringify(parent ? 'https://www.huya.com' : 'https://aq.huya.com')}||event.source!==${parent ? 'window.parent' : 'window'})return;
      if(event.data?.fixtureCaptcha==='ready'){activation.frames+=2;activation.ready++;}
      else if(event.data?.fixtureCaptcha==='complete'){
        activation.clicks++;const result=await request('captcha-complete');verified=true;waiting=false;update(result.cooldown);
      }
    });
    submit.onclick=async()=>{
      if(!verified||document.querySelector('.udb-input-code').value!=='123456')return;
      const result=await request('verify');location.href=result.next;
    };
    globalThis.__fixtureSetCooldown=seconds=>update(seconds);update(0);
    for(const media of document.querySelectorAll('video,audio'))media.play().catch(()=>{});
  `
}

function huyaTencentChallengePage(): string {
  return shell(`<section class="tcaptcha-window" id="tcaptcha_vtt0" data-fixture-panel style="position:absolute;left:0;top:0;width:340px;height:280px;background:#12ccde;box-sizing:border-box">
    <header class="tcaptcha-header" style="height:40px">模拟人机验证</header>
    <main class="tcaptcha-opearea" style="height:190px"><div id="tcaptcha_imgarea"><img id="tcaptcha-img" class="tcaptcha-img" src="${sampleImage()}" style="width:160px;height:120px"></div><button data-fixture-captcha>完成模拟验证</button></main>
    <footer class="tcaptcha-status" style="height:50px"><span class="tcaptcha-action--refresh"><button id="reload" class="tcaptcha-action-icon">刷新</button></span><span class="tcaptcha-action--close"><button id="close" class="tcaptcha-action-icon">关闭</button></span></footer>
    <div id="tcaptcha_refresh" class="tcaptcha-cover" style="position:absolute;inset:0;background:#fff">正在加载</div>
    </section>`, `
    document.body.style.cssText='margin:0;background:#12ccde';
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      document.querySelector('#tcaptcha_refresh').remove();window.parent.postMessage({fixtureCaptcha:'ready'},'*');
    }));
    document.querySelector('[data-fixture-captcha]').onclick=()=>window.parent.postMessage({fixtureCaptcha:'complete'},'*');
    document.querySelector('#reload').onclick=()=>{};document.querySelector('#close').onclick=()=>{};
  `)
}

function verificationPage(kind: Scenario): string {
  if (kind === 'second-factor-render' || kind === 'second-factor-v4') return renderedVerificationPage(kind === 'second-factor-v4')
  if (kind !== 'second-factor' && kind !== 'second-factor-stalled') return shell(`<section class="${kind === 'challenge' ? 'geetest_panel' : 'new-verification'}"><h3>官方模拟验证</h3><p>仅用于离线验证接续.</p><button data-fixture-complete>完成模拟验证</button></section>`, `document.querySelector('[data-fixture-complete]').onclick=()=>fetch('/__fy1sync-fixture/verify',{method:'POST'}).then(r=>r.json()).then(r=>location.href=r.next);`)
  return shell('<div class="risk-check-phone_wp"><h3>安全验证</h3><span class="risk-static-text-value">138****0000</span><input type="text" class="risk-input-dom"><span class="risk-input-after-active">发送验证码</span><div class="risk-bottom-btn">下一步</div></div>', `
    void fetch('/x/safecenter/captcha/pre',{method:'POST'});
    const send=document.querySelector('.risk-input-after-active');send.onclick=async()=>{await fetch('/__fy1sync-fixture/send',{method:'POST'});send.className='risk-input-after';send.textContent='(60)';};
    document.querySelector('.risk-bottom-btn').onclick=async()=>{const code=document.querySelector('input').value;if(code!=='123456'){let notice=document.querySelector('.bili-toast');if(!notice){notice=document.createElement('p');notice.className='bili-toast';document.body.appendChild(notice)}notice.textContent='验证码错误';return}const result=await(await fetch('/__fy1sync-fixture/verify',{method:'POST'})).json();${kind === 'second-factor-stalled'
      ? "const toast=document.createElement('div');toast.className='toast_wp';toast.innerHTML='<span class=toast__img_loading>...</span><span class=toast__content>验证成功,请稍后</span>';document.body.appendChild(toast);"
      : 'location.href=result.next;'}};
  `)
}

/** A paint-dependent second-factor challenge catches hidden-renderer regressions. */
function renderedVerificationPage(v4 = false): string {
  return shell('<div class="risk-check-phone_wp"><h3>安全验证</h3><span class="risk-static-text-value">138****0000</span><input type="text" class="risk-input-dom"><span class="risk-input-after-active">发送验证码</span><div class="risk-bottom-btn">下一步</div></div>', `
    let preReady=false;
    void fetch('/x/safecenter/captcha/pre',{method:'POST'}).then(response=>response.json()).then(()=>{preReady=true;});
    ${v4 ? bilibiliV4ChallengeScript() : bilibiliChallengeScript()}
    const activation=globalThis.__fixtureActivation={requests:0,frames:0,ready:0,clicks:0};
    const send=document.querySelector('.risk-input-after-active');
    const request=name=>fetch('/__fy1sync-fixture/'+name,{method:'POST'}).then(response=>response.json());
    send.onclick=async()=>{
      activation.requests++;
      if(!preReady)return;
      await request('captcha-start');
      globalThis.__fixtureSetChallengePhase('loading');
      requestAnimationFrame(()=>{activation.frames++;requestAnimationFrame(()=>{
        activation.frames++;activation.ready++;
        globalThis.__fixtureSetChallengePhase('interactive');
        document.querySelector('[data-fixture-captcha]').onclick=async()=>{
          activation.clicks++;globalThis.__fixtureChallengeClicks++;
          globalThis.__fixtureSetChallengePhase('verifying');
          await request('second-captcha-complete');
          globalThis.__fixtureSetChallengePhase('passed');
          requestAnimationFrame(()=>{
            globalThis.__fixtureSetChallengePhase('form');
            send.className='risk-input-after';send.textContent='(37)';
          });
        };
      });});
    };
    document.querySelector('.risk-bottom-btn').onclick=async()=>{
      if(document.querySelector('input.risk-input-dom').value!=='123456'||activation.clicks!==1)return;
      await request('verify');
      const toast=document.createElement('div');toast.className='toast_wp';
      toast.innerHTML='<span class="toast__img_loading">...</span><span class="toast__content">验证成功,请稍后</span>';
      document.body.appendChild(toast);
    };
  `)
}

/** Public v4 card structure with a synthetic point-selection body, without a slider. */
function bilibiliV4ChallengeScript(): string {
  const image = sampleImage()
  return `
    document.body.style.background='#cc1234';
    globalThis.__fixtureChallengePhase='form';globalThis.__fixtureChallengeClicks=0;
    globalThis.__fixtureSetChallengePhase=phase=>{
      globalThis.__fixtureChallengePhase=phase;
      document.querySelector('.geetest_captcha')?.remove();
      if(phase==='form')return;
      const owner=document.createElement('div');owner.className='geetest_captcha geetest_bind geetest_nextReady geetest_boxShow geetest_freeze_wait';
      owner.style.cssText='height:0;width:100%;position:fixed;left:0;top:0;z-index:99999';
      const box=document.createElement('div');box.className='geetest_box';box.style.cssText='position:fixed;left:180px;top:55px;width:340px;height:410px;background:#12ccde;color:#111;box-sizing:border-box';
      box.innerHTML='<header class="geetest_header" style="height:50px"><div class="geetest_title"><div class="geetest_text_tips">模拟点选验证</div><div class="geetest_ques_tips"></div></div></header><div class="geetest_container"><div class="geetest_wrap"><div class="geetest_subitem geetest_word"><div class="geetest_window" style="height:265px"><div class="geetest_bg" style="width:100%;height:265px;background-image:url(${image})"></div></div><button class="geetest_submit" data-fixture-captcha><span class="geetest_submit_tips">完成模拟验证</span></button></div><div class="geetest_result_tips" style="display:none"></div></div></div><footer class="geetest_footer" style="height:48px"><div class="geetest_footer_left"><button class="geetest_close">关闭</button><button class="geetest_refresh">刷新</button></div><div class="geetest_footer_right"></div></footer>';
      if(phase!=='interactive'){
        owner.classList.add(phase==='passed'?'geetest_success':phase==='verifying'?'geetest_compute':'geetest_load');
        box.querySelector('.geetest_subitem').style.display='none';
      }
      owner.appendChild(box);document.body.appendChild(owner);
    };
  `
}

/** Mirrors SDK animation states without a live challenge or account credentials. */
function bilibiliChallengeScript(): string {
  return `
    document.body.style.background='#cc1234';
    globalThis.__fixtureChallengePhase='form';globalThis.__fixtureChallengeClicks=0;
    globalThis.__fixtureSetChallengePhase=phase=>{
      globalThis.__fixtureChallengePhase=phase;
      document.querySelector('.geetest_panel')?.remove();
      if(phase==='form')return;
      const outer=document.createElement('div');outer.className='geetest_panel';outer.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.2)';
      const panel=document.createElement('div');panel.className='geetest_panel_box';panel.style.cssText='position:fixed;left:180px;top:55px;width:340px;height:410px;background:#12ccde;color:#111;box-sizing:border-box';
      if(phase==='interactive'){
        panel.classList.add('geetest_panelshowclick');panel.innerHTML='<div class="geetest_panel_next"><div class="geetest_holder"><div class="geetest_widget"><header style="height:48px;padding:12px;box-sizing:border-box">模拟人机验证</header><div class="geetest_item"><div class="geetest_item_wrap" style="height:280px;background:#12ccde">仅用于离线测试</div></div><div class="geetest_panel_footer" style="height:82px"><button class="geetest_commit" data-fixture-captcha>完成模拟验证</button><button class="geetest_close">关闭</button></div></div></div></div>';
        panel.querySelector('[data-fixture-captcha]').onclick=()=>{globalThis.__fixtureChallengeClicks++;globalThis.__fixtureSetChallengePhase('verifying');};
      }else{
        panel.style.width='220px';panel.style.height='150px';
        panel.innerHTML=phase==='passed'?'<div class="geetest_panel_success">通过验证</div>':phase==='verifying'?'<div class="geetest_result geetest_load">加载中</div>':'<div class="geetest_panel_loading">加载中</div>';
      }
      outer.appendChild(panel);document.body.appendChild(outer);
    };
  `
}

/** Instantiated only in unpackaged, explicitly offline Electron tests. No transport exists. */
export class EmbeddedLoginFixtures {
  private enabled = false
  private scenario: Scenario = 'second-factor'
  private current: FixtureContext | null = null
  enable(): void { this.enabled = true }
  setScenario(value: Scenario): void { if (!['second-factor', 'second-factor-stalled', 'second-factor-render', 'second-factor-v4', 'challenge', 'unknown', 'sms-captcha', 'password-error', 'captcha-phases', 'huya-captcha-child', 'huya-captcha-parent'].includes(value)) throw new Error('Unknown fixture scenario'); this.scenario = value }
  setCooldown(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 300 || !this.current) throw new Error('Invalid fixture cooldown')
    this.current.cooldown = value
  }
  configure = async (request: EmbeddedLoginRequest, target: Session): Promise<void> => {
    const context: FixtureContext = { platform: request.platform, session: target, authenticated: false, requests: 0,
      submitted: 0, smsSent: 0, verified: 0, qrPolls: 0, phase: 'form', pendingCaptcha: false, phoneChanges: 0, navigationCount: 0, mediaRequests: 0, cooldown: 0 }
    this.current = context
    await target.protocol.handle('https', async incoming => {
      context.requests++
      if (!this.enabled) return new Response('Offline login fixture is disabled', { status: 503 })
      const url = new URL(incoming.url)
      const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
      if (incoming.method === 'POST' && url.pathname === '/x/safecenter/captcha/pre') {
        if (this.scenario === 'second-factor-render' || this.scenario === 'second-factor-v4') await new Promise(resolve => setTimeout(resolve, 700))
        return json({ code: 0, data: { recaptcha_type: this.scenario === 'second-factor-v4' ? 'geetest4' : 'geetest' } })
      }
      if (url.pathname.startsWith('/__fixture-media')) { context.mediaRequests++; return new Response(null, { status: 404 }) }
      if (incoming.url === loginIdentityUrl(request.platform)) {
        const scoped = await target.cookies.get({ url: incoming.url })
        const uidKey = request.platform === 'bilibili' ? 'DedeUserID' : request.platform === 'huya' ? 'udb_uid' : 'acf_uid'
        const ticketKey = request.platform === 'bilibili' ? 'SESSDATA' : request.platform === 'huya' ? 'udb_biztoken' : 'acf_auth'
        const authenticated = context.authenticated && scoped.some(cookie => cookie.name === uidKey && cookie.value === '1001')
          && scoped.some(cookie => cookie.name === ticketKey && cookie.value === 'synthetic-session')
        return json(request.platform === 'bilibili'
          ? { code: authenticated ? 0 : -101, data: { isLogin: authenticated, mid: authenticated ? 1001 : 0 } }
          : request.platform === 'huya' ? { isLogined: authenticated, uid: authenticated ? 1001 : 0 }
            : { error: authenticated ? 0 : 1, msg: { uid: authenticated ? 1001 : 0, info: authenticated ? { uid: 1001 } : 0 } })
      }
      if (incoming.method === 'POST' && url.pathname.startsWith('/__fy1sync-fixture/')) {
        if (url.pathname.endsWith('/password')) {
          context.submitted++
          if (this.scenario === 'password-error') return json({ error: true })
          if (this.scenario === 'captcha-phases') { context.phase = 'challenge'; return json({ captcha: true }) }
          context.phase = this.scenario === 'unknown' ? 'unknown'
            : this.scenario === 'challenge' || this.scenario === 'sms-captcha' ? 'challenge' : 'verification'
          return json({ next: this.scenario === 'unknown' ? '/pc/passport/unknownFixture' : '/pc/passport/riskVerify?scene=loginTelCheck' })
        }
        if (url.pathname.endsWith('/send')) { context.smsSent++; return json({ ok: true }) }
        if (url.pathname.endsWith('/phone-change')) { context.phoneChanges++; return json({ ok: true }) }
        if (url.pathname.endsWith('/captcha-start')) { context.pendingCaptcha = true; context.phase = 'challenge'; return json({ ok: true }) }
        if (url.pathname.endsWith('/captcha-complete')) { context.pendingCaptcha = false; context.phase = 'form'; context.smsSent++; context.cooldown = 37; return json({ cooldown: 37 }) }
        if (url.pathname.endsWith('/second-captcha-complete')) { context.pendingCaptcha = false; context.phase = 'verification'; context.smsSent++; context.cooldown = 37; return json({ cooldown: 37 }) }
        if (url.pathname.endsWith('/verify')) { context.verified++; context.phase = 'complete'; await this.complete(request.platform); return json({ next: '/login-complete' }) }
      }
      if (incoming.method !== 'GET') return new Response(null, { status: 405 })
      if (url.pathname === '/x/passport-login/web/qrcode/poll') { context.qrPolls++; return json({ code: 0, data: { code: 86101 } }) }
      if (url.pathname === '/qrLgn/getQrImg') return new Response(Buffer.from(sampleImage().split(',')[1]!, 'base64'), { headers: { 'content-type': 'image/png' } })
      if (request.platform === 'huya' && url.origin === 'https://t.captcha.qq.com' && url.pathname === '/cap_union_new_show') {
        return new Response(huyaTencentChallengePage(), { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (request.platform === 'douyu' && url.hostname === 'www.douyu.com' && url.pathname === '/member/cp') return Response.redirect('https://passport.douyu.com/member/login')
      context.navigationCount++
      const body = url.pathname === '/pc/passport/riskVerify' || url.pathname === '/pc/passport/unknownFixture' ? verificationPage(this.scenario)
        : url.pathname === '/login-complete' ? shell('<p>已完成模拟验证</p>') : basicPage(request.platform, url.hostname === 'aq.huya.com', this.scenario)
      return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
  }
  async complete(platform: EmbeddedLoginPlatform, authenticated = true): Promise<void> {
    const current = this.current
    if (!this.enabled || !current || current.platform !== platform) throw new Error('No matching offline login attempt')
    current.authenticated = authenticated
    const base = `${platform}.com`
    const values = platform === 'bilibili' ? { DedeUserID: '1001', SESSDATA: 'synthetic-session' }
      : platform === 'huya' ? { udb_uid: '1001', udb_biztoken: 'synthetic-session' }
        : { acf_uid: '1001', acf_auth: 'synthetic-session', acf_username: 'synthetic-account', dy_did: 'a'.repeat(32) }
    for (const [name, value] of Object.entries(values)) await current.session.cookies.set({ url: `https://www.${base}/`, domain: `.${base}`, path: '/', name, value,
      secure: true, httpOnly: true, sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 3600 })
  }
  state(active: boolean) {
    const value = this.current
    return { platform: active ? value?.platform ?? null : null, active, requests: value?.requests ?? 0,
      phase: value?.phase ?? null, submitted: value?.submitted ?? 0, smsSent: value?.smsSent ?? 0,
      verified: value?.verified ?? 0, qrPolls: value?.qrPolls ?? 0, pendingCaptcha: value?.pendingCaptcha ?? false,
      phoneChanges: value?.phoneChanges ?? 0, navigationCount: value?.navigationCount ?? 0, mediaRequests: value?.mediaRequests ?? 0 }
  }
}
