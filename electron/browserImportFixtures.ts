/** Disposable offline fixtures. No real browser directory is read in offline E2E. */
import type { BrowserCookie, LoginPlatform } from './cookies'
import type { DiscoveredBrowserProfile } from './browserProfiles'
import type { BrowserCookieReadFunction } from './browserCookieReader'
import type { BrowserIdentityVerifier } from './browserImportIdentity'
import { BrowserImportError } from './browserImportError'

export type BrowserImportFixtureScenario = 'accounts' | 'mixed' | 'locked' | 'uac-cancelled' | 'no-profiles'
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
export class BrowserImportFixtures {
  scenario: BrowserImportFixtureScenario = 'no-profiles'
  verifyCount = 0
  enable(scenario: BrowserImportFixtureScenario = 'accounts'): void { this.scenario = scenario; this.verifyCount = 0 }
  discover = async (): Promise<DiscoveredBrowserProfile[]> => this.scenario === 'no-profiles' ? [] : [
    { id: 'e'.repeat(32), browser: 'edge', browserName: 'Microsoft Edge', name: '个人', isDefault: true, directory: 'synthetic-edge', database: 'synthetic-edge' },
    { id: 'c'.repeat(32), browser: 'chrome', browserName: 'Google Chrome', name: '工作', isDefault: true, directory: 'synthetic-chrome', database: 'synthetic-chrome' },
    { id: 'f'.repeat(32), browser: 'firefox', browserName: 'Mozilla Firefox', name: 'default', isDefault: true, directory: 'synthetic-firefox', database: 'synthetic-firefox' },
  ]
  read: BrowserCookieReadFunction = async (_profile, platforms) => {
    if (this.scenario === 'locked') throw new BrowserImportError('browser-import-browser-in-use')
    if (this.scenario === 'uac-cancelled') throw new BrowserImportError('browser-import-uac-cancelled')
    return { cookies: platforms.flatMap(platform => {
      if (this.scenario === 'mixed' && platform === 'huya') return []
      const fields: Record<LoginPlatform, Record<string, string>> = {
        douyu: { acf_uid: '42', acf_auth: 'synthetic-session', acf_username: 'synthetic-user', dy_did: '1'.repeat(32) },
        bilibili: { DedeUserID: '42', SESSDATA: 'synthetic-session' },
        huya: { udb_uid: '42', udb_biztoken: 'synthetic-session' },
        douyin: { sessionid: 'synthetic-session', sessionid_ss: 'synthetic-session' },
        youtube: { SID: 'synthetic-session', SAPISID: 'synthetic-session' },
      }
      return Object.entries(fields[platform]).map(([name, value]): BrowserCookie => ({ domain: `.${platform}.com`,
        path: '/', secure: true, httpOnly: true, session: true, name, value }))
    }), skipped: 0 }
  }
  verify: BrowserIdentityVerifier = async (platform, _cookies, signal) => {
    if (signal.aborted) throw new BrowserImportError('browser-import-cancelled')
    this.verifyCount++
    if (this.scenario === 'mixed' && platform === 'douyin') throw new BrowserImportError('browser-import-verification-failed')
    return { uid: '42', username: { douyu: '测试斗鱼账号', bilibili: '测试哔哩哔哩账号', huya: '测试虎牙账号',
      douyin: '测试抖音账号', youtube: '测试 YouTube 账号' }[platform], avatar }
  }
}
