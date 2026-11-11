import { describe, expect, it } from 'vitest'
import { loginAttemptId, loginRequestAllowed, loginViewport } from './embeddedLoginPolicy'

describe('Douyin embedded login network boundary', () => {
  it.each(['https://live.douyin.com/', 'https://www.douyin.com/', 'https://sso.douyin.com/'])('allows only explicit primary navigation %s', url => {
    expect(loginRequestAllowed('douyin', url, 'mainFrame')).toBe(true)
  })
  it.each(['http://live.douyin.com/', 'https://live.douyin.com:8443/', 'https://user@live.douyin.com/',
    'https://live.douyin.com.evil.invalid/', 'https://v.douyin.com/abc', 'https://yuba.douyu.com/',
    'app://app/', 'file:///tmp/example', 'https://127.0.0.1/', 'https://localhost/',
    'https://lf-ucenter-web.yhgfb-cn-static.com/obj/passport-fe/example.js'])('rejects unrelated top-level navigation %s', url => {
    expect(loginRequestAllowed('douyin', url, 'mainFrame')).toBe(false)
  })
  it('allows the observed official SDK host without admitting sibling domains or media', () => {
    expect(loginRequestAllowed('douyin', 'https://lf-ucenter-web.yhgfb-cn-static.com/obj/passport-fe/example.js', 'script')).toBe(true)
    expect(loginRequestAllowed('douyin', 'https://lf-webcast-platform.bytetos.com/client-entry.js', 'script')).toBe(true)
    expect(loginRequestAllowed('douyin', 'https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/rmc-nocaptcha/example.html', 'subFrame')).toBe(true)
    expect(loginRequestAllowed('douyin', 'https://lf-cdn-tos.bytescm.com/obj/rc-verifycenter/example.js', 'script')).toBe(true)
    expect(loginRequestAllowed('douyin', 'https://evil.yhgfb-cn-static.com/example.js', 'script')).toBe(false)
    expect(loginRequestAllowed('douyin', 'https://child.lf-ucenter-web.yhgfb-cn-static.com/example.js', 'script')).toBe(false)
    expect(loginRequestAllowed('douyin', 'https://lf-ucenter-web.yhgfb-cn-static.com/example.mp4', 'xhr')).toBe(false)
    expect(loginRequestAllowed('douyin', 'https://live.douyin.com/stream', 'media')).toBe(false)
    expect(loginRequestAllowed('douyin', 'https://v.douyin.com/api', 'xhr')).toBe(false)
  })
  it('loads observed desktop authentication SDKs without allowing parent-domain wildcards', () => {
    for (const url of [
      'https://lf-c-flwb.bytetos.com/obj/rc-client-security/web/glue/sdk-glue.js',
      'https://lf-security.bytegoofy.com/obj/security-secsdk/runtime.js',
      'https://lf3-config.bytetcc.com/obj/tcc-config-web/config',
    ]) {
      expect(loginRequestAllowed('douyin', url, 'script')).toBe(true)
      expect(loginRequestAllowed('douyin', url, 'mainFrame')).toBe(false)
    }
    for (const host of ['other.bytetos.com', 'other.bytegoofy.com', 'other.bytetcc.com']) {
      expect(loginRequestAllowed('douyin', `https://${host}/sdk.js`, 'script')).toBe(false)
    }
  })
  it('permits only the observed QR frontier WebSocket and never treats it as a page', () => {
    expect(loginRequestAllowed('douyin', 'wss://frontier100-normal.zijieapi.com/ws', 'webSocket')).toBe(true)
    expect(loginRequestAllowed('douyin', 'wss://frontier100-normal.zijieapi.com/ws', 'mainFrame')).toBe(false)
    expect(loginRequestAllowed('douyin', 'wss://evil.zijieapi.com/ws', 'webSocket')).toBe(false)
    expect(loginRequestAllowed('douyin', 'wss://live.douyin.com/ws', 'webSocket')).toBe(false)
  })
  it('permits the verified challenge configuration and fallback asset without widening other origins', () => {
    expect(loginRequestAllowed('douyin', 'https://vcs.zijieapi.com/vc/setting?repoId=synthetic&aid=6383', 'xhr')).toBe(true)
    expect(loginRequestAllowed('douyin', 'https://vcs.zijieapi.com/vc/setting', 'other')).toBe(true)
    for (const type of ['mainFrame', 'subFrame', 'script', 'webSocket']) {
      expect(loginRequestAllowed('douyin', 'https://vcs.zijieapi.com/vc/setting', type)).toBe(false)
    }
    for (const url of ['https://vcs.zijieapi.com/vc/other', 'https://vcs.zijieapi.com/vc/setting/extra',
      'https://child.vcs.zijieapi.com/vc/setting', 'https://vcs.zijieapi.com.evil.invalid/vc/setting',
      'https://mssdk.bytedance.com/example', 'https://tnc0-aliec2.zijieapi.com/get_domains/v5/']) {
      expect(loginRequestAllowed('douyin', url, 'xhr')).toBe(false)
    }
    const resource = 'https://lf-rc2.yhgfb-cn-static.com/obj/rc-verifycenter/verifycenter/@latest/index.js'
    expect(loginRequestAllowed('douyin', resource, 'script')).toBe(true)
    expect(loginRequestAllowed('douyin', resource, 'mainFrame')).toBe(false)
    expect(loginRequestAllowed('douyin', resource.replace('lf-rc2.', 'lf-rc3.'), 'script')).toBe(false)
  })
  it('loads the exact account verification SDK while restricting verification API paths and document types', () => {
    const script = 'https://auth.zijieapi.com/ucenter_web/app/second_verification_web/dist/index.umd.production.js'
    expect(loginRequestAllowed('douyin', script + '?aid=6383&verify_scene=synthetic', 'script')).toBe(true)
    for (const type of ['mainFrame', 'subFrame', 'xhr', 'webSocket']) expect(loginRequestAllowed('douyin', script, type)).toBe(false)
    for (const url of [script + '/extra', script.replace('/dist/', '/other/'), script.replace('auth.', 'child.auth.'),
      script.replace('auth.zijieapi.com', 'auth.zijieapi.com.evil.invalid')]) expect(loginRequestAllowed('douyin', url, 'script')).toBe(false)
    for (const pathname of ['/passport/safe/get_verify_ways/', '/passport/safe/pack_verify_ways_data/', '/passport/safe/query_decision/',
      '/passport/web/send_code/', '/passport/web/mobile/check_code/', '/passport/web/validate_code/', '/passport/web/email/check_code/']) {
      const url = 'https://verify.zijieapi.com' + pathname
      expect(loginRequestAllowed('douyin', url, 'xhr')).toBe(true)
      expect(loginRequestAllowed('douyin', url, 'mainFrame')).toBe(false)
      expect(loginRequestAllowed('douyin', url, 'subFrame')).toBe(false)
      expect(loginRequestAllowed('douyin', url, 'script')).toBe(false)
    }
    for (const url of ['https://verify.zijieapi.com/passport/web/logout/', 'https://verify.zijieapi.com/other',
      'https://verify.zijieapi.com/passport/web/send_code/extra', 'https://other.zijieapi.com/passport/web/send_code/']) {
      expect(loginRequestAllowed('douyin', url, 'xhr')).toBe(false)
    }
  })
  it('permits inert subframes and bounded raster sources but denies general data documents', () => {
    expect(loginRequestAllowed('douyin', 'about:blank', 'subFrame')).toBe(true)
    expect(loginRequestAllowed('douyin', 'about:blank', 'mainFrame')).toBe(false)
    expect(loginRequestAllowed('douyin', 'data:image/png;base64,c3ludGhldGlj', 'image')).toBe(true)
    expect(loginRequestAllowed('douyin', 'data:image/svg+xml,<svg/>', 'image')).toBe(false)
    expect(loginRequestAllowed('douyin', 'data:text/html,<script/>', 'subFrame')).toBe(false)
    expect(loginRequestAllowed('unknown' as never, 'https://www.douyu.com/')).toBe(false)
  })
})

describe('embedded login presentation-only arguments', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  it('accepts the current viewport shape without adding arbitrary payload fields', () => {
    const value = { id, rect: { x: 10, y: 20, width: 700, height: 480 }, visible: true }
    expect(loginViewport(value)).toEqual(value)
    expect(loginViewport({ ...value, password: 'synthetic-secret' })).toBeNull()
    expect(loginViewport({ ...value, rect: { ...value.rect, width: -1 } })).toBeNull()
    expect(loginViewport({ ...value, rect: { ...value.rect, x: Number.POSITIVE_INFINITY } })).toBeNull()
    expect(loginAttemptId({ id })).toBe(id)
    expect(loginAttemptId({ id, url: 'https://outside.invalid/' })).toBeNull()
  })
})
