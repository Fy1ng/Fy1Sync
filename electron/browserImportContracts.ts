import type { LoginPlatform } from './cookies'

export type ImportBrowser = 'chrome' | 'edge' | 'firefox'
export interface BrowserImportProfile {
  id: string
  browser: ImportBrowser
  browserName: string
  name: string
  isDefault: boolean
}
export interface BrowserImportSources {
  supported: boolean
  profiles: BrowserImportProfile[]
}
export type BrowserAccountState = 'ready' | 'signed-out' | 'unavailable'
export interface BrowserImportAccount {
  id: string
  platform: LoginPlatform
  state: BrowserAccountState
  username?: string
  avatar?: string
  message?: string
  cookieCount: number
}
export interface BrowserImportPreview {
  id: string
  profile: BrowserImportProfile
  expiresAt: number
  accounts: BrowserImportAccount[]
}
export type DouyuImportTarget = { kind: 'auto' } | { kind: 'new' } | { kind: 'existing'; accountId: string }
export interface BrowserImportOutcome {
  platform: LoginPlatform
  imported: boolean
  username?: string
  message: string
  accountId?: string
  signingReady?: boolean
}
export interface BrowserImportCloseResult {
  status: 'closed' | 'not-running'
  browserName: string
}
export interface BrowserImportMethods {
  listBrowserImportProfiles: { args: undefined; result: BrowserImportSources }
  previewBrowserLogins: {
    args: { requestId: string; profileId: string; platforms: LoginPlatform[] }
    result: BrowserImportPreview
  }
  importBrowserLogins: {
    args: { previewId: string; accountIds: string[]; douyuTarget?: DouyuImportTarget }
    result: { outcomes: BrowserImportOutcome[] }
  }
  closeImportBrowser: {
    args: { requestId: string; profileId: string }
    result: BrowserImportCloseResult
  }
  cancelBrowserImport: { args: { id: string }; result: { cancelled: boolean } }
}
export const BROWSER_IMPORT_METHODS = [
  'listBrowserImportProfiles', 'previewBrowserLogins', 'importBrowserLogins', 'closeImportBrowser', 'cancelBrowserImport',
] as const satisfies readonly (keyof BrowserImportMethods)[]

export const IMPORT_PLATFORMS: readonly LoginPlatform[] = ['douyu', 'bilibili', 'huya', 'douyin', 'youtube', 'twitch']
export const IMPORT_PLATFORM_NAMES: Record<LoginPlatform, string> = {
  douyu: '斗鱼', bilibili: '哔哩哔哩', huya: '虎牙', douyin: '抖音', youtube: 'YouTube', twitch: 'Twitch',
}
