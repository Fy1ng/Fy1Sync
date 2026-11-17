import { describe, expect, it } from 'vitest'
import { DOUYIN_USER_AGENT } from '../platforms/douyinDanmaku'
import { douyinBrowserUserAgent, douyinBrowserVersion, douyinGuardDiagnostics } from './httpContext'

describe('Douyin shared HTTP browser context', () => {
  it('keeps the actual Chromium version while removing desktop app brands consistently', () => {
    const browser = DOUYIN_USER_AGENT.replace('131.0.0.0','152.0.0.0')
    const raw = browser.replace('Chrome/', 'HeadlessChrome/').replace(' Safari/', ' Fy1Sync/0.4.1 Electron/44.9.3 Safari/')
    expect(douyinBrowserUserAgent(raw)).toBe(browser)
    expect(douyinBrowserVersion(douyinBrowserUserAgent(raw))).toBe('152.0.0.0')
  })
  it.each([undefined,'','Unknown browser','Chrome/152.0.0.0\r\nCookie:private','a'.repeat(513)])('rejects an unsafe or incomplete browser context', raw => {
    expect(douyinBrowserUserAgent(raw)).toBe(DOUYIN_USER_AGENT)
  })
  it('only emits presence and bounded numeric codes for protection headers', () => {
    expect(douyinGuardDiagnostics(new Headers())).toEqual({})
    expect(douyinGuardDiagnostics(new Headers({ 'bd-ticket-guard-result':'-3', 'bd-ticket-guard-sec-result':'0' })))
      .toEqual({ guardResultPresent:true,guardResult:-3,guardSecurityResultPresent:true,guardSecurityResult:0 })
    for (const raw of ['private-header','123456789','2.5','+1','']) {
      expect(douyinGuardDiagnostics(new Headers({ 'bd-ticket-guard-result':raw }))).toEqual({ guardResultPresent:true })
    }
  })
})
